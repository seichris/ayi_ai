import { ChatRole, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  chatTurnRequestSchema,
  classifierResultSchema,
  intakeStateSchema,
  renewalAdviceSchema,
  type RenewalAdvice,
  type IntakeState,
  lineItemSchema,
} from "@/lib/contracts";
import { benchmarkContext, findBenchmarkForTool, planOptionsForTool } from "@/lib/benchmarks";
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

const INTAKE_SYSTEM_PROMPT = `You extract SaaS subscription line items from a user's message.

Rules:
- Only extract what the user explicitly provided. Do not guess missing fields.
- If the plan/tier is unknown, omit it.
- If annual cost is unknown, omit it.
- If seats are unknown, omit it.
- If the user mentions multiple tools, return multiple line items.
- Keep tool names short and recognizable (e.g. "Slack", "Notion", "Google Workspace").

Return JSON only with this schema:
{
  "lineItems": [
    {
      "tool": "string",
      "plan": "string (optional)",
      "seats": number (optional),
      "annualCost": number (optional),
      "currency": "string (optional, default USD)",
      "term": "string (optional)",
      "notes": "string (optional)"
    }
  ]
}`;

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

async function loadIntakeState(
  sessionId: string
): Promise<{ state: IntakeState; userId?: string | null }> {
  const session = await prisma!.chatSession.findUnique({
    where: { id: sessionId },
    select: { intake: true, stage: true, userId: true },
  });

  const rawState = {
    ...(typeof session?.intake === "object" && session?.intake ? session.intake : {}),
    ...(typeof session?.stage === "string" && session.stage ? { stage: session.stage } : {}),
  };

  const parsed = intakeStateSchema.safeParse(rawState);

  return {
    state: parsed.success ? parsed.data : intakeStateSchema.parse({}),
    userId: session?.userId,
  };
}

async function persistIntakeState(sessionId: string, state: IntakeState): Promise<void> {
  await prisma!.chatSession.update({
    where: { id: sessionId },
    data: {
      intake: state,
      stage: state.stage,
    },
  });
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

function normalizeToolName(tool: string): string {
  return tool.trim().toLowerCase();
}

function canonicalToolName(tool: string): string {
  const match = findBenchmarkForTool(tool);
  return match?.tool ?? tool.trim();
}

function mergeLineItems(existing: IntakeState["lineItems"], incoming: IntakeState["lineItems"]) {
  const merged: IntakeState["lineItems"] = existing.map((item) => ({
    ...item,
    tool: canonicalToolName(item.tool),
  }));
  const indexByTool = new Map<string, number>();

  for (let i = 0; i < merged.length; i += 1) {
    indexByTool.set(normalizeToolName(merged[i].tool), i);
  }

  for (const candidate of incoming) {
    const canonicalTool = canonicalToolName(candidate.tool);
    const normalized = normalizeToolName(canonicalTool);
    const existingIndex = indexByTool.get(normalized);

    if (existingIndex === undefined) {
      merged.push({ ...candidate, tool: canonicalTool });
      indexByTool.set(normalized, merged.length - 1);
      continue;
    }

    const current = merged[existingIndex];
    merged[existingIndex] = {
      ...current,
      ...candidate,
      tool: current.tool || candidate.tool,
      currency: candidate.currency ?? current.currency ?? "USD",
    };
  }

  return merged;
}

function missingPlanTools(items: IntakeState["lineItems"]): string[] {
  return items.filter((item) => !item.plan || item.plan.trim().length === 0).map((item) => item.tool);
}

function missingPriceTools(items: IntakeState["lineItems"]): string[] {
  return items
    .filter((item) => typeof item.annualCost !== "number" || Number.isNaN(item.annualCost))
    .map((item) => item.tool);
}

function isAffirmative(text: string): boolean {
  return /^(y|yes|yeah|yep|sure|ok|okay|add|more)\b/i.test(text.trim());
}

function isNegative(text: string): boolean {
  return /^(n|no|nope|nah|done|finished|that's all|thats all|all set|nothing else)\b/i.test(
    text.trim()
  );
}

function parseApproxAnnualCost(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/(\$?\s*)(\d[\d,]*)(\.\d+)?\s*([km])?/i);

  if (!match) {
    return null;
  }

  const integerPart = match[2]?.replace(/,/g, "") ?? "";
  const decimalPart = match[3] ?? "";
  const suffix = match[4]?.toLowerCase();
  const base = Number(`${integerPart}${decimalPart}`);

  if (!Number.isFinite(base)) {
    return null;
  }

  if (suffix === "k") {
    return Math.round(base * 1_000);
  }

  if (suffix === "m") {
    return Math.round(base * 1_000_000);
  }

  return Math.round(base);
}

const intakeExtractionSchema = z.object({
  lineItems: z.array(lineItemSchema).min(1).max(12),
});

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
      maxOutputTokens: 512,
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

    if (prisma && sessionId) {
      const { state, userId } = await loadIntakeState(sessionId);

      if (state.stage === "confirm_more") {
        if (isAffirmative(userMessage)) {
          const nextState: IntakeState = { ...state, stage: "collect" };
          await persistIntakeState(sessionId, nextState);
          const replyText = "Got it. Add the next subscription(s) you want to include.";
          await persistMessage({ sessionId, role: "assistant", content: replyText });
          return NextResponse.json({ sessionId, onTopic: true, replyText });
        }

        if (isNegative(userMessage)) {
          const nextState: IntakeState = { ...state, stage: "ready" };
          await persistIntakeState(sessionId, nextState);

          const itemsText = nextState.lineItems
            .map((item) => {
              const parts = [
                `tool=${item.tool}`,
                item.plan ? `plan=${item.plan}` : null,
                typeof item.seats === "number" ? `seats=${item.seats}` : null,
                typeof item.annualCost === "number" ? `annualCost=${item.annualCost}` : null,
                item.term ? `term=${item.term}` : null,
              ].filter(Boolean);
              return `- ${parts.join(", ")}`;
            })
            .join("\n");

          const benchmarkText = benchmarkContext(
            nextState.lineItems.map((item) => item.tool).join(", ")
          );

          let guidance: RenewalAdvice;

          try {
            guidance = await generateJson(renewalAdviceSchema, {
              systemInstruction: ADVISOR_SYSTEM_PROMPT,
              userPrompt: `Use this benchmark context as directional input (not exact pricing):\n${benchmarkText}\n\nSubscriptions:\n${itemsText}\n\nReturn only JSON matching the required schema.\n\nOutput requirements:\n- Keep leverage points under 18 words each.\n- Counter email should be concise and negotiation-ready.\n- If data is missing, include clarifying questions and lower confidence.`,
              temperature: 0,
              maxOutputTokens: 4096,
              retries: 0,
            });
          } catch (advisorError) {
            const message =
              advisorError instanceof Error ? advisorError.message : String(advisorError);
            const fallbackReply =
              "I can help with this renewal. I’m missing a couple details to put together the full brief. For each tool, share the plan/tier and what you pay per year (and the contract term if you have it).";

            console.error("chat.advisor_error", {
              ip,
              sessionId,
              message,
            });

            await persistMessage({
              sessionId,
              role: "assistant",
              content: fallbackReply,
            });

            return NextResponse.json({
              sessionId,
              onTopic: true,
              replyText: fallbackReply,
            });
          }

          const assistantReply = "Here is your SaaS renewal negotiation brief.";

          await persistMessage({
            sessionId,
            role: "assistant",
            content: assistantReply,
            analysis: guidance,
          });

          await persistIntakeState(sessionId, { ...nextState, stage: "briefed" });

          return NextResponse.json({
            sessionId,
            onTopic: true,
            replyText: assistantReply,
            analysis: guidance,
            actions: userId ? [{ type: "google_connect_gmail" }] : [{ type: "google_signin" }],
          });
        } else if (!isAffirmative(userMessage)) {
          const replyText =
            "Quick check: do you want to add another subscription? Reply “yes” to add more, or “no” if that’s all.";
          await persistMessage({ sessionId, role: "assistant", content: replyText });
          return NextResponse.json({ sessionId, onTopic: true, replyText });
        }
      }

      if (state.stage === "prompt_signin" && !userId) {
        const replyText =
          "To save these subscriptions and generate the full renewal brief, please sign in with Google.";
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({
          sessionId,
          onTopic: true,
          replyText,
          actions: [{ type: "google_signin" }],
        });
      }

      if (state.stage === "ready") {
        const itemsText = state.lineItems
          .map((item) => {
            const parts = [
              `tool=${item.tool}`,
              item.plan ? `plan=${item.plan}` : null,
              typeof item.seats === "number" ? `seats=${item.seats}` : null,
              typeof item.annualCost === "number" ? `annualCost=${item.annualCost}` : null,
              item.term ? `term=${item.term}` : null,
            ].filter(Boolean);
            return `- ${parts.join(", ")}`;
          })
          .join("\n");

        const benchmarkText = benchmarkContext(
          state.lineItems.map((item) => item.tool).join(", ")
        );

        let guidance: RenewalAdvice;

        try {
          guidance = await generateJson(renewalAdviceSchema, {
            systemInstruction: ADVISOR_SYSTEM_PROMPT,
            userPrompt: `Use this benchmark context as directional input (not exact pricing):\n${benchmarkText}\n\nSubscriptions:\n${itemsText}\n\nReturn only JSON matching the required schema.\n\nOutput requirements:\n- Keep leverage points under 18 words each.\n- Counter email should be concise and negotiation-ready.\n- If data is missing, include clarifying questions and lower confidence.`,
            temperature: 0,
            maxOutputTokens: 4096,
            retries: 0,
          });
        } catch (advisorError) {
          const message =
            advisorError instanceof Error ? advisorError.message : String(advisorError);
          const fallbackReply =
            "I can help with this renewal. I’m missing a couple details to put together the full brief. For each tool, share the plan/tier and what you pay per year (and the contract term if you have it).";

          console.error("chat.advisor_error", {
            ip,
            sessionId,
            message,
          });

          await persistMessage({
            sessionId,
            role: "assistant",
            content: fallbackReply,
          });

          return NextResponse.json({
            sessionId,
            onTopic: true,
            replyText: fallbackReply,
          });
        }

        const assistantReply = "Here is your SaaS renewal negotiation brief.";

        await persistMessage({
          sessionId,
          role: "assistant",
          content: assistantReply,
          analysis: guidance,
        });

        await persistIntakeState(sessionId, { ...state, stage: "briefed" });

        return NextResponse.json({
          sessionId,
          onTopic: true,
          replyText: assistantReply,
          analysis: guidance,
          actions: userId ? [{ type: "google_connect_gmail" }] : [{ type: "google_signin" }],
        });
      }

      if (state.stage !== "briefed") {
      let extracted;
      try {
        extracted = await generateJson(intakeExtractionSchema, {
          systemInstruction: INTAKE_SYSTEM_PROMPT,
          userPrompt: `Extract subscription line items from:\n${userMessage}`,
          temperature: 0,
          maxOutputTokens: 1400,
          retries: 1,
        });
      } catch {
        extracted = { lineItems: [] as IntakeState["lineItems"] };
      }

      let mergedItems = mergeLineItems(state.lineItems, extracted.lineItems ?? []);
      const nextState: IntakeState = { ...state, lineItems: mergedItems };

      if (mergedItems.length === 0) {
        nextState.stage = "collect";
        await persistIntakeState(sessionId, nextState);
        const replyText =
          "Tell me the subscriptions you’re renewing (tool + plan + what you pay per year). You can list multiple in one message.";
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

      const missingPlansBefore = missingPlanTools(mergedItems);
      if (missingPlansBefore.length === 1 && extracted.lineItems.length === 0) {
        const targetTool = missingPlansBefore[0];
        mergedItems = mergedItems.map((item) =>
          item.tool === targetTool ? { ...item, plan: userMessage } : item
        );
        nextState.lineItems = mergedItems;
      }

      const missingPlans = missingPlanTools(mergedItems);
      if (missingPlans.length > 0) {
        nextState.stage = "collect";
        await persistIntakeState(sessionId, nextState);

        const lines = missingPlans.map((tool) => {
          const plans = planOptionsForTool(tool);
          if (plans.length === 0) {
            return `- ${tool}: which plan/tier are you on? (Example: “${tool}: Pro”)`;
          }
          return `- ${tool}: which plan are you on? Common options: ${plans.join(", ")}.`;
        });

        const replyText = `One quick detail so I don’t guess your pricing:\n${lines.join(
          "\n"
        )}\n\nReply with the plan for each tool (e.g. “Slack: Business+”).`;
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

      const missingPricesBefore = missingPriceTools(mergedItems);
      if (missingPricesBefore.length === 1 && extracted.lineItems.length === 0) {
        const parsedCost = parseApproxAnnualCost(userMessage);
        if (parsedCost !== null) {
          const targetTool = missingPricesBefore[0];
          mergedItems = mergedItems.map((item) =>
            item.tool === targetTool ? { ...item, annualCost: parsedCost } : item
          );
          nextState.lineItems = mergedItems;
        }
      }

      const missingPrices = missingPriceTools(mergedItems);
      if (missingPrices.length > 0) {
        nextState.stage = "collect";
        await persistIntakeState(sessionId, nextState);

        const replyText = `Thanks. What do you pay per year for each of these?\n${missingPrices
          .map((tool) => `- ${tool}`)
          .join("\n")}\n\nYou can reply like: “Slack: $19k/yr, Notion: $4,200/yr”.`;
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

      nextState.stage = "confirm_more";
      await persistIntakeState(sessionId, nextState);

      const replyText =
        "Got it. Is that all the subscriptions you want to include, or do you want to add another? Reply “yes” to add more, or “no” if that’s all.";
      await persistMessage({ sessionId, role: "assistant", content: replyText });
      return NextResponse.json({ sessionId, onTopic: true, replyText });
      }
    }

    const conversationText = [...history, { role: "user", content: userMessage }]
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const benchmarkText = benchmarkContext(userMessage);

    let guidance: RenewalAdvice;

    try {
      guidance = await generateJson(renewalAdviceSchema, {
        systemInstruction: ADVISOR_SYSTEM_PROMPT,
        userPrompt: `Use this benchmark context as directional input (not exact pricing):\n${benchmarkText}\n\nConversation:\n${conversationText}\n\nReturn only JSON matching the required schema.\n\nOutput requirements:\n- Keep leverage points under 18 words each.\n- Counter email should be concise and negotiation-ready.\n- If data is missing, include clarifying questions and lower confidence.`,
        temperature: 0,
        maxOutputTokens: 4096,
        retries: 0,
      });
    } catch (advisorError) {
      const message =
        advisorError instanceof Error
          ? advisorError.message
          : String(advisorError);
      const fallbackReply =
        "I can help with this renewal. I’m missing a couple details to put together the full brief. For each tool, share the plan/tier and what you pay per year (and the contract term if you have it).";

      console.error("chat.advisor_error", {
        ip,
        sessionId,
        message,
      });

      await persistMessage({
        sessionId,
        role: "assistant",
        content: fallbackReply,
      });

      return NextResponse.json({
        sessionId,
        onTopic: true,
        replyText: fallbackReply,
      });
    }

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
