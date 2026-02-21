import { ChatRole, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import {
  chatTurnRequestSchema,
  classifierResultSchema,
  renewalAdviceSchema,
} from "@/lib/contracts";
import { benchmarkContext } from "@/lib/benchmarks";
import { prisma } from "@/lib/db";
import { generateJson } from "@/lib/gemini";

export const runtime = "nodejs";

type RateLimitState = {
  count: number;
  resetAt: number;
};

type PromptMessage = {
  role: "user" | "assistant";
  content: string;
};

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 20);
const OFF_TOPIC_MESSAGE =
  "Please stay on topic: share your SaaS tools, plans, seats, and annual pricing so I can help with renewal negotiation.";

const rateLimitStore = new Map<string, RateLimitState>();

const CLASSIFIER_SYSTEM_PROMPT = `You are a strict classifier for a SaaS renewal negotiation assistant.

Allowed topics:
- SaaS pricing benchmarks
- SaaS renewal negotiations
- contract term trade-offs for SaaS subscriptions
- email drafting for vendor price negotiation

Disallowed topics:
- anything unrelated to SaaS procurement, pricing, renewals, or negotiation

Return JSON only with this schema:
{
  "decision": "allowed" | "disallowed",
  "reason": "short reason"
}`;

const ADVISOR_SYSTEM_PROMPT = `You are an enterprise SaaS renewal advisor for startups and SMBs.

Task:
- Analyze the user input on SaaS tools and pricing.
- Estimate fair market range and savings potential.
- Provide actionable negotiation leverage.
- Draft a professional counter-email.

Rules:
- Stay in SaaS pricing and renewals context.
- Do not claim certainty if data is incomplete.
- Make assumptions explicit.
- Keep leverage points concise and practical.
- Return JSON only and follow the requested schema exactly.`;

function now(): number {
  return Date.now();
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (!forwarded) {
    return "unknown";
  }

  const [first] = forwarded.split(",");
  return first?.trim() || "unknown";
}

function checkRateLimit(ip: string): { limited: boolean; retryAfterSeconds?: number } {
  const currentTime = now();
  const current = rateLimitStore.get(ip);

  if (!current || current.resetAt <= currentTime) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: currentTime + RATE_LIMIT_WINDOW_MS,
    });
    return { limited: false };
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.resetAt - currentTime) / 1000)
    );
    return { limited: true, retryAfterSeconds };
  }

  current.count += 1;
  rateLimitStore.set(ip, current);
  return { limited: false };
}

async function ensureSessionId(inputSessionId?: string): Promise<string | undefined> {
  if (!prisma) {
    return undefined;
  }

  if (inputSessionId) {
    const existing = await prisma.chatSession.findUnique({
      where: { id: inputSessionId },
      select: { id: true },
    });

    if (existing) {
      return existing.id;
    }
  }

  const created = await prisma.chatSession.create({ data: {} });
  return created.id;
}

async function loadPromptMessages(sessionId?: string): Promise<PromptMessage[]> {
  if (!prisma || !sessionId) {
    return [];
  }

  const rows = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    take: 40,
    select: {
      role: true,
      content: true,
    },
  });

  return rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

async function persistMessage(params: {
  sessionId?: string;
  role: ChatRole;
  content: string;
  analysis?: Prisma.InputJsonValue;
}): Promise<void> {
  if (!prisma || !params.sessionId) {
    return;
  }

  await prisma.chatMessage.create({
    data: {
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      analysis: params.analysis,
    },
  });
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rateLimit = checkRateLimit(ip);

  if (rateLimit.limited) {
    return NextResponse.json(
      {
        onTopic: false,
        replyText: "Rate limit reached. Please try again shortly.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds ?? 60),
        },
      }
    );
  }

  try {
    const body = await request.json();
    const parsedBody = chatTurnRequestSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request payload." },
        { status: 400 }
      );
    }

    const userMessage = parsedBody.data.message.trim();
    const sessionId = await ensureSessionId(parsedBody.data.sessionId);
    const history = await loadPromptMessages(sessionId);

    await persistMessage({
      sessionId,
      role: "user",
      content: userMessage,
    });

    const classification = await generateJson(classifierResultSchema, {
      systemInstruction: CLASSIFIER_SYSTEM_PROMPT,
      userPrompt: `Classify this user message:\n${userMessage}`,
      temperature: 0,
      maxOutputTokens: 120,
      retries: 1,
    });

    const isAllowed = classification.decision === "allowed";
    console.info("chat.classification", {
      ip,
      sessionId,
      decision: classification.decision,
      reason: classification.reason,
    });

    if (!isAllowed) {
      await persistMessage({
        sessionId,
        role: "assistant",
        content: OFF_TOPIC_MESSAGE,
      });

      return NextResponse.json({
        sessionId,
        onTopic: false,
        replyText: OFF_TOPIC_MESSAGE,
      });
    }

    const conversationText = [...history, { role: "user", content: userMessage }]
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const benchmarkText = benchmarkContext(userMessage);

    const guidance = await generateJson(renewalAdviceSchema, {
      systemInstruction: ADVISOR_SYSTEM_PROMPT,
      userPrompt: `Use this benchmark context as directional input (not exact pricing):\n${benchmarkText}\n\nConversation:\n${conversationText}\n\nReturn JSON with this schema and field names exactly:\n{
  "onTopic": true,
  "lineItems": [
    {
      "tool": "string",
      "plan": "string (optional)",
      "seats": "number (optional)",
      "annualCost": "number (optional)",
      "currency": "string",
      "term": "string (optional)",
      "notes": "string (optional)"
    }
  ],
  "marketRange": {
    "min": "number",
    "max": "number",
    "currency": "string",
    "basis": "string",
    "confidence": "low|medium|high"
  },
  "savingsEstimate": {
    "percentMin": "number",
    "percentMax": "number",
    "amountMin": "number (optional)",
    "amountMax": "number (optional)",
    "currency": "string",
    "explanation": "string"
  },
  "leveragePoints": ["string"],
  "counterEmail": {
    "subject": "string",
    "body": "string"
  },
  "clarifyingQuestions": ["string"],
  "assumptions": ["string"],
  "confidence": "low|medium|high"
}\n\nOutput requirements:\n- Keep leverage points under 18 words each.\n- Counter email should be concise and negotiation-ready.\n- If missing data, include clarifying questions and keep confidence lower.`,
      temperature: 0,
      maxOutputTokens: 2200,
      retries: 1,
    });

    const assistantReply = "Here is your SaaS renewal negotiation brief.";

    await persistMessage({
      sessionId,
      role: "assistant",
      content: assistantReply,
      analysis: guidance,
    });

    console.info("chat.response", {
      ip,
      sessionId,
      lineItems: guidance.lineItems.length,
      confidence: guidance.confidence,
    });

    return NextResponse.json({
      sessionId,
      onTopic: true,
      replyText: assistantReply,
      analysis: guidance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("chat.error", { message });

    return NextResponse.json(
      {
        onTopic: false,
        replyText:
          "I could not generate a pricing brief right now. Please retry in a moment.",
      },
      { status: 500 }
    );
  }
}
