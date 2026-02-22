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
import { ensureBenchmarksForTools } from "@/lib/server/benchmark-discovery";

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
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== "false";
const TOPIC_GUARDRAILS_ENABLED = process.env.TOPIC_GUARDRAILS_ENABLED !== "false";
const DEMO_MODE_ENABLED = process.env.DEMO_MODE_ENABLED === "true";
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
- If they give a price per seat per year, set annualCostPerSeat (not annualCost).
- Never treat seat counts or people counts as pricing.
- Do not infer pricing from bare numbers unless the user clearly indicates money/cost context.
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
      "annualCostPerSeat": number (optional),
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
    .filter((item) => {
      const hasAnnual =
        typeof item.annualCost === "number" && !Number.isNaN(item.annualCost);
      const hasPerSeat =
        typeof item.annualCostPerSeat === "number" &&
        !Number.isNaN(item.annualCostPerSeat);
      return !hasAnnual && !hasPerSeat;
    })
    .map((item) => item.tool);
}

function buildAdvisorFailureReply(items: IntakeState["lineItems"]): string {
  const missingPlans = missingPlanTools(items);
  const missingPrices = missingPriceTools(items);

  if (missingPlans.length > 0 || missingPrices.length > 0) {
    const needed: string[] = [];
    if (missingPlans.length > 0) needed.push("plan/tier");
    if (missingPrices.length > 0) needed.push("annual price");
    needed.push("contract term (if you have it)");

    const lines = items.map((item) => {
      const parts = [
        item.tool,
        item.plan ? `plan: ${item.plan}` : "plan: ?",
        typeof item.seats === "number" ? `seats: ${item.seats}` : null,
        typeof item.annualCost === "number"
          ? `annual: ${formatUsd(item.annualCost)}`
          : typeof item.annualCostPerSeat === "number"
            ? `price/seat/yr: ${formatUsd(item.annualCostPerSeat)}`
            : "annual: ?",
      ].filter(Boolean);
      return `- ${parts.join(" · ")}`;
    });

    return `I can help with this renewal, but I’m still missing a couple details (${needed.join(
      ", "
    )}).\n\nHere’s what I have so far:\n${lines.join(
      "\n"
    )}\n\nReply with the missing bits like: “Figma: $5,000/yr, annual term”.`;
  }

  return "I’ve got your subscription details, but I couldn’t generate the full brief right now. Reply “try again” and I’ll re-run it.";
}

function isAffirmative(text: string): boolean {
  return /^(y|yes|yeah|yep|sure|ok|okay|add|more)\b/i.test(text.trim());
}

function isNegative(text: string): boolean {
  return /^(n|no|nope|nah|done|finished|that's all|thats all|all set|nothing else|no more|no further)\b/i.test(
    text.trim()
  );
}

function isMidTierAllTools(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /\b(mid|middle)\b/.test(normalized) &&
    /\btier\b/.test(normalized) &&
    /\b(each|all|both|those|them)\b/.test(normalized) &&
    !normalized.includes(":")
  );
}

function looksLikeSinglePlanForAll(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.includes(":")) {
    return false;
  }
  // Keep this conservative to avoid accidentally treating sentences as plan names.
  return normalized.length > 0 && normalized.length <= 32 && /\b(each|all|both|those|them)\b/.test(normalized);
}

function looksLikePlanName(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > 48) return false;
  if (/[<>]/.test(normalized)) return false;
  if (/\b(list|show|already shared|repeat|what did i|what do you have)\b/i.test(normalized)) {
    return false;
  }
  // Plan names are usually short noun phrases, not full sentences.
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount <= 6;
}

function looksLikeListRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /\b(list|show|repeat)\b/.test(normalized) &&
    (/\balready\b/.test(normalized) || /\bshared\b/.test(normalized) || /\bhave\b/.test(normalized))
  );
}

function summarizeIntake(items: IntakeState["lineItems"]): string {
  if (items.length === 0) return "I don’t have any subscriptions saved in this session yet.";
  const lines = items.map((item) => {
    const parts = [
      item.tool,
      item.plan ? `plan: ${item.plan}` : null,
      typeof item.seats === "number" ? `seats: ${item.seats}` : null,
      typeof item.annualCost === "number" ? `annual: ${formatUsd(item.annualCost)}` : null,
    ].filter(Boolean);
    return `- ${parts.join(" · ")}`;
  });
  return `Here’s what I have so far:\n${lines.join("\n")}`;
}

function middlePlanCandidates(plans: string[]): string[] {
  if (plans.length === 0) {
    return [];
  }

  if (plans.length <= 2) {
    return plans.slice();
  }

  if (plans.length % 2 === 1) {
    return [plans[Math.floor(plans.length / 2)]];
  }

  const upperMid = plans.length / 2;
  return [plans[upperMid - 1], plans[upperMid]];
}

function buildAdvisorErrorReply(items: IntakeState["lineItems"], errorMessage: string): string {
  const normalized = errorMessage.toLowerCase();

  if (normalized.includes("timeout") || normalized.includes("aborted")) {
    return "I hit a timeout while generating the brief. Reply “try again” to rerun, or try again in a minute. (If you’re self-hosting, increase `GEMINI_TIMEOUT_MS`.)";
  }

  if (normalized.includes("google_ai_studio_api_key is not set")) {
    return "I can’t reach the pricing model right now because `GOOGLE_AI_STUDIO_API_KEY` isn’t set on the server.";
  }

  if (
    normalized.includes("invalid input: expected") ||
    normalized.includes("invalid option: expected one of")
  ) {
    return "I hit a formatting issue while generating the brief. Reply “try again” and I’ll regenerate it.";
  }

  return buildAdvisorFailureReply(items);
}

type TierIntent = "low" | "mid" | "top";

function parseTierStatements(text: string): { toolIntents: Map<string, TierIntent>; restIntent?: TierIntent } {
  const toolIntents = new Map<string, TierIntent>();
  const normalized = text.toLowerCase();

  const tierRegex =
    /\b(low|entry|starter|bottom|lowest|mid|middle|top|highest|enterprise)\b\s*(?:-|\s*)tier\b\s*for\s+([^.;\n]+)/gi;

  const toIntent = (keyword: string): TierIntent => {
    if (keyword === "mid" || keyword === "middle") return "mid";
    if (keyword === "top" || keyword === "highest" || keyword === "enterprise") return "top";
    return "low";
  };

  let match: RegExpExecArray | null;
  while ((match = tierRegex.exec(normalized))) {
    const keyword = match[1] ?? "";
    const target = (match[2] ?? "").trim();
    const intent = toIntent(keyword);

    if (
      /\b(the\s+)?(other|others|rest|remaining|everything\s+else)\b/.test(target) ||
      /\bother\s+\d+\b/.test(target)
    ) {
      // Best-effort: apply to tools not explicitly mentioned elsewhere.
      // (We'll decide which tools are "rest" at call-site.)
      return { toolIntents, restIntent: intent };
    }

    const parts = target
      .split(/,|&| and /i)
      .map((piece) => piece.trim())
      .filter(Boolean);

    for (const part of parts) {
      toolIntents.set(part, intent);
    }
  }

  return { toolIntents };
}

function suggestionForIntent(plans: string[], intent: TierIntent): string[] {
  if (intent === "top") {
    return plans.length > 0 ? [plans[plans.length - 1]] : [];
  }
  if (intent === "low") {
    return plans.length > 0 ? [plans[0]] : [];
  }
  return middlePlanCandidates(plans);
}

function mapTierSuggestions(params: {
  message: string;
  missingTools: string[];
}): Record<string, string[]> | null {
  const parsed = parseTierStatements(params.message);
  const normalizedMessage = params.message.toLowerCase();

  const suggestions: Record<string, string[]> = {};

  const explicitMentions = new Set<string>();

  for (const tool of params.missingTools) {
    const toolLower = tool.toLowerCase();
    // Direct mention by tool name covers most cases (figma/notion/slack).
    if (normalizedMessage.includes(toolLower)) {
      explicitMentions.add(toolLower);
    }
  }

  const resolveIntentForTool = (tool: string): TierIntent | null => {
    const toolLower = tool.toLowerCase();

    // Try exact tool name phrases in the tier statements first.
    for (const [targetText, intent] of parsed.toolIntents.entries()) {
      const targetLower = targetText.toLowerCase();
      if (targetLower.includes(toolLower) || toolLower.includes(targetLower)) {
        return intent;
      }
    }

    // Heuristic: "top tier" without a "for ..." clause but tool mentioned.
    if (explicitMentions.has(toolLower)) {
      if (/\b(top|highest|enterprise)\b/.test(normalizedMessage)) return "top";
      if (/\b(mid|middle)\b/.test(normalizedMessage)) return "mid";
      if (/\b(low|entry|starter|bottom|lowest)\b/.test(normalizedMessage)) return "low";
    }

    return null;
  };

  const explicitTools = new Set<string>();
  for (const tool of params.missingTools) {
    const intent = resolveIntentForTool(tool);
    if (!intent) continue;
    const options = planOptionsForTool(tool);
    const candidate = suggestionForIntent(options, intent);
    if (candidate.length > 0) {
      suggestions[tool] = candidate;
      explicitTools.add(tool);
    }
  }

  if (parsed.restIntent) {
    for (const tool of params.missingTools) {
      if (explicitTools.has(tool)) continue;
      const options = planOptionsForTool(tool);
      const candidate = suggestionForIntent(options, parsed.restIntent);
      if (candidate.length > 0) {
        suggestions[tool] = candidate;
      }
    }
  }

  return Object.keys(suggestions).length > 0 ? suggestions : null;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function pricingHintForTool(
  items: IntakeState["lineItems"],
  tool: string
): string | null {
  const benchmark = findBenchmarkForTool(tool);

  if (!benchmark) {
    return null;
  }

  const item = items.find((row) => row.tool === tool);
  const perSeatMin = benchmark.marketAnnualPerSeatUsd.min;
  const perSeatMax = benchmark.marketAnnualPerSeatUsd.max;

  if (typeof item?.seats === "number" && Number.isFinite(item.seats) && item.seats > 0) {
    const minTotal = Math.round(perSeatMin * item.seats);
    const maxTotal = Math.round(perSeatMax * item.seats);
    return `directional benchmark: ${formatUsd(minTotal)}–${formatUsd(maxTotal)}/yr for ${item.seats} seats (${perSeatMin}-${perSeatMax} USD/seat/yr).`;
  }

  return `directional benchmark: ${perSeatMin}-${perSeatMax} USD/seat/yr.`;
}

function buildMissingPricePrompt(items: IntakeState["lineItems"], missingTools: string[]): string {
  const lines = missingTools.map((tool) => {
    const hint = pricingHintForTool(items, tool);
    return hint ? `- ${tool} (${hint})` : `- ${tool}`;
  });

  return `Thanks. What do you pay per year for each of these?\n${lines.join(
    "\n"
  )}\n\nReply like: “Slack: $19k/yr, Notion: $4,200/yr”. If you only know per-seat pricing, reply like “$300/seat/yr”.`;
}

const intakeExtractionSchema = z.object({
  lineItems: z.array(lineItemSchema).max(12),
});

function demoLineItems(): IntakeState["lineItems"] {
  return [
    {
      tool: "Figma",
      plan: "Professional",
      seats: 20,
      annualCost: 14_000,
      currency: "USD",
      term: "annual",
      notes: "Demo: assume current spend slightly above fair market.",
    },
    {
      tool: "Notion",
      plan: "Business",
      seats: 20,
      annualCost: 5_200,
      currency: "USD",
      term: "annual",
      notes: "Demo: assume current spend slightly above fair market.",
    },
    {
      tool: "Slack",
      plan: "Business+",
      seats: 20,
      annualCost: 6_200,
      currency: "USD",
      term: "annual",
      notes: "Demo: assume current spend slightly above fair market.",
    },
    {
      tool: "GitHub",
      plan: "Team",
      seats: 20,
      annualCost: 5_800,
      currency: "USD",
      term: "annual",
      notes: "Demo: assume current spend slightly above fair market.",
    },
  ];
}

function demoGuidance(items: IntakeState["lineItems"]): RenewalAdvice {
  const priced = items.filter((item) => typeof item.annualCost === "number");
  const currentTotal = priced.reduce((sum, item) => sum + (item.annualCost ?? 0), 0);

  const marketTotals = items.map((item) => {
    const benchmark = findBenchmarkForTool(item.tool);
    const seats = typeof item.seats === "number" ? item.seats : 0;
    if (!benchmark || seats <= 0) return { min: 0, max: 0 };
    return {
      min: Math.round(benchmark.marketAnnualPerSeatUsd.min * seats),
      max: Math.round(benchmark.marketAnnualPerSeatUsd.max * seats),
    };
  });

  const marketMin = marketTotals.reduce((sum, row) => sum + row.min, 0);
  const marketMax = marketTotals.reduce((sum, row) => sum + row.max, 0);

  const savingsMinPct = 12;
  const savingsMaxPct = 26;
  const amountMin = currentTotal > 0 ? Math.round((currentTotal * savingsMinPct) / 100) : undefined;
  const amountMax = currentTotal > 0 ? Math.round((currentTotal * savingsMaxPct) / 100) : undefined;

  return {
    onTopic: true,
    lineItems: items,
    marketRange: {
      min: marketMin || Math.max(0, Math.round(currentTotal * 0.7)),
      max: marketMax || Math.max(0, Math.round(currentTotal * 0.95)),
      currency: "USD",
      basis: "Demo mode: directional benchmarks aggregated across your listed tools and seats.",
      confidence: "medium",
    },
    savingsEstimate: {
      percentMin: savingsMinPct,
      percentMax: savingsMaxPct,
      amountMin,
      amountMax,
      currency: "USD",
      explanation:
        "Demo mode: assumes you’re paying above market and can negotiate down via term/seat commitments.",
    },
    leveragePoints: [
      "Ask for a renewal discount tied to multi-year term and co-term alignment.",
      "Use competitive alternatives and budget constraints as leverage.",
      "Request price protection and cap uplifts in writing.",
      "Trade flexible seat floors for better unit pricing.",
    ],
    counterEmail: {
      subject: "Renewal pricing adjustment request",
      body:
        "Hi team,\n\nWe’re reviewing renewal options internally. Based on comparable market pricing and our current seat count, the current renewal quote is above where we need to land.\n\nIf you can align pricing closer to market and include price protection (cap uplifts, clear renewal terms), we’re prepared to move forward on an annual renewal and commit to our planned seat level.\n\nCan you send an updated proposal with:\n- improved unit pricing for the current seat count\n- any multi-year / prepay options\n- written price protection for the next term\n\nThanks,\n",
    },
    clarifyingQuestions: [],
    assumptions: [
      "Demo mode: mid-tier plans for Figma, Notion, Slack, and GitHub.",
      "Demo mode: annual term and 20 seats per tool.",
      "Demo mode: current spend is slightly above fair market.",
    ],
    confidence: "medium",
  };
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (RATE_LIMIT_ENABLED) {
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

	    if (DEMO_MODE_ENABLED) {
	      const demoItems = demoLineItems();
	      const guidance = demoGuidance(demoItems);
	      const assistantReply = "Here is your SaaS renewal negotiation brief.";

	      // Demo mode must not depend on DB or Gemini. Persist only if available.
	      const sessionId = prisma ? await ensureSessionId(parsedBody.data.sessionId) : undefined;
	      await persistMessage({
	        sessionId,
	        role: "user",
	        content: userMessage,
	      });
	      await persistMessage({
	        sessionId,
	        role: "assistant",
	        content: assistantReply,
	        analysis: guidance,
	      });

	      if (prisma && sessionId) {
	        const intakeState: IntakeState = {
	          lineItems: demoItems,
	          planSuggestions: {},
	          stage: "briefed",
	        };
	        await persistIntakeState(sessionId, intakeState);
	      }

	      return NextResponse.json({
	        sessionId,
	        onTopic: true,
	        replyText: assistantReply,
	        analysis: guidance,
	        actions: [{ type: "google_signin" }],
	      });
	    }

	    const sessionId = await ensureSessionId(parsedBody.data.sessionId);
	    const history = await loadPromptMessages(sessionId);

	    await persistMessage({
	      sessionId,
      role: "user",
      content: userMessage,
    });

	    const intake = prisma && sessionId ? await loadIntakeState(sessionId) : null;
	    const intakeState = intake?.state;

    const shouldBypassClassifier = Boolean(
      intakeState &&
        (intakeState.stage === "confirm_more" ||
          intakeState.stage === "confirm_plans" ||
          intakeState.stage === "ready" ||
          intakeState.stage === "prompt_signin" ||
          (intakeState.lineItems.length > 0 &&
            (isAffirmative(userMessage) ||
              isNegative(userMessage) ||
              looksLikeListRequest(userMessage) ||
              userMessage.trim().toLowerCase() === "correct")))
    );

    let isAllowed = true;

    if (!TOPIC_GUARDRAILS_ENABLED) {
      isAllowed = true;
      console.info("chat.classification_disabled", { ip, sessionId });
    } else if (shouldBypassClassifier) {
      isAllowed = true;
      console.info("chat.classification_bypass", {
        ip,
        sessionId,
        stage: intakeState?.stage,
        message: userMessage,
      });
    } else {
      const classification = await generateJson(classifierResultSchema, {
        systemInstruction: CLASSIFIER_SYSTEM_PROMPT,
        userPrompt: `Classify this user message:\n${userMessage}`,
        temperature: 0,
        maxOutputTokens: 512,
        retries: 1,
      });

      isAllowed = classification.decision === "allowed";
      console.info("chat.classification", {
        ip,
        sessionId,
        decision: classification.decision,
        reason: classification.reason,
      });
    }

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
      const resolvedIntake = intake ?? (await loadIntakeState(sessionId));
      const { state, userId } = resolvedIntake;

      if (looksLikeListRequest(userMessage)) {
        const replyText = summarizeIntake(state.lineItems);
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

      if (state.stage === "confirm_plans") {
        const normalized = userMessage.trim().toLowerCase();
        const suggestions = state.planSuggestions ?? {};
        const suggestionEntries = Object.entries(suggestions);

        if (normalized === "correct" || normalized === "looks good" || normalized === "yes") {
          const ambiguous = suggestionEntries.filter(([, options]) => options.length !== 1);
          if (ambiguous.length > 0) {
            const replyText = `Almost. I still need you to pick the exact plan for:\n${ambiguous
              .map(([tool, options]) => `- ${tool}: ${options.join(" or ")}`)
              .join("\n")}\n\nReply like: “Tool: Plan”.`;
            await persistMessage({ sessionId, role: "assistant", content: replyText });
            return NextResponse.json({ sessionId, onTopic: true, replyText });
          }

          const filled = state.lineItems.map((item) => {
            const options = suggestions[item.tool];
            if (!item.plan && options && options.length === 1) {
              return { ...item, plan: options[0] };
            }
            return item;
          });

          const nextState: IntakeState = {
            ...state,
            lineItems: filled,
            planSuggestions: {},
            stage: "collect",
          };
          await persistIntakeState(sessionId, nextState);

          await ensureBenchmarksForTools(filled.map((item) => item.tool));

          const missingPrices = missingPriceTools(filled);
          if (missingPrices.length > 0) {
            const replyText = buildMissingPricePrompt(filled, missingPrices);
            await persistMessage({ sessionId, role: "assistant", content: replyText });
            return NextResponse.json({ sessionId, onTopic: true, replyText });
          }

          const replyText =
            "Got it. Is that all the subscriptions you want to include, or do you want to add another? Reply “yes” to add more, or “no” if that’s all.";
          await persistMessage({ sessionId, role: "assistant", content: replyText });
          return NextResponse.json({ sessionId, onTopic: true, replyText });
        }

        // Try to match a single plan name to a single ambiguous tool.
        const ambiguousTools = suggestionEntries.filter(([, options]) => options.length === 2);
        if (ambiguousTools.length === 1) {
          const [tool, options] = ambiguousTools[0];
          const chosen = options.find((option) => option.toLowerCase() === normalized);
          if (chosen) {
            const filled = state.lineItems.map((item) =>
              item.tool === tool ? { ...item, plan: chosen } : item
            );
            const nextState: IntakeState = {
              ...state,
              lineItems: filled,
              planSuggestions: {},
              stage: "collect",
            };
            await persistIntakeState(sessionId, nextState);

            await ensureBenchmarksForTools(filled.map((item) => item.tool));

            const missingPrices = missingPriceTools(filled);
            const replyText =
              missingPrices.length > 0
                ? buildMissingPricePrompt(filled, missingPrices)
                : "Got it. Do you want to add another subscription, or is that all?";
            await persistMessage({ sessionId, role: "assistant", content: replyText });
            return NextResponse.json({ sessionId, onTopic: true, replyText });
          }
        }

        const replyText =
          "Reply “correct” to accept my plan guesses, or specify exact plans like: “Figma: Professional, Notion: Enterprise, Slack: Enterprise Grid”.";
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

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

          await ensureBenchmarksForTools(nextState.lineItems.map((item) => item.tool));

          const itemsText = nextState.lineItems
            .map((item) => {
              const parts = [
                `tool=${item.tool}`,
                item.plan ? `plan=${item.plan}` : null,
                typeof item.seats === "number" ? `seats=${item.seats}` : null,
                typeof item.annualCost === "number" ? `annualCost=${item.annualCost}` : null,
                typeof item.annualCostPerSeat === "number"
                  ? `annualCostPerSeat=${item.annualCostPerSeat}`
                  : null,
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
	              retries: 1,
	            });
		          } catch (advisorError) {
		            const message =
		              advisorError instanceof Error ? advisorError.message : String(advisorError);
		            const fallbackReply = buildAdvisorErrorReply(nextState.lineItems, message);

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
        await ensureBenchmarksForTools(state.lineItems.map((item) => item.tool));

        const itemsText = state.lineItems
          .map((item) => {
            const parts = [
              `tool=${item.tool}`,
              item.plan ? `plan=${item.plan}` : null,
              typeof item.seats === "number" ? `seats=${item.seats}` : null,
              typeof item.annualCost === "number" ? `annualCost=${item.annualCost}` : null,
              typeof item.annualCostPerSeat === "number"
                ? `annualCostPerSeat=${item.annualCostPerSeat}`
                : null,
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
            retries: 1,
          });
        } catch (advisorError) {
          const message =
            advisorError instanceof Error ? advisorError.message : String(advisorError);
          const fallbackReply = buildAdvisorErrorReply(state.lineItems, message);

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
      if (isNegative(userMessage) && state.lineItems.length > 0) {
        // User said "no more" while we were asking to add another subscription.
        const nextState: IntakeState = { ...state, stage: "confirm_more" };
        await persistIntakeState(sessionId, nextState);
        const replyText =
          "Got it. Is that all the subscriptions you want to include, or do you want to add another? Reply “yes” to add more, or “no” if that’s all.";
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

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

      const extractedItems = (extracted.lineItems ?? [])
        .map((item) => ({ ...item }))
        .filter((item) => {
          const tool = item.tool.trim().toLowerCase();
          if (tool.length === 0) return false;
          if (tool === "unknown" || tool === "n/a" || tool === "na" || tool === "none")
            return false;
          return true;
        });

      let mergedItems = mergeLineItems(state.lineItems, extractedItems);
      const nextState: IntakeState = { ...state, lineItems: mergedItems };

      if (mergedItems.length === 0) {
        nextState.stage = "collect";
        await persistIntakeState(sessionId, nextState);
        const replyText =
          "Tell me the subscriptions you’re renewing (tool + plan + what you pay per year). You can list multiple in one message.";
        await persistMessage({ sessionId, role: "assistant", content: replyText });
        return NextResponse.json({ sessionId, onTopic: true, replyText });
      }

      await ensureBenchmarksForTools(mergedItems.map((item) => item.tool));

      const missingPlansBefore = missingPlanTools(mergedItems);
      if (
        missingPlansBefore.length === 1 &&
        extractedItems.length === 0 &&
        looksLikePlanName(userMessage)
      ) {
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

        if (extractedItems.length === 0) {
          const tierSuggestions = mapTierSuggestions({
            message: userMessage,
            missingTools: missingPlans,
          });

          if (tierSuggestions) {
            const replyLines = Object.entries(tierSuggestions).map(([tool, options]) => {
              if (options.length === 1) return `- ${tool}: ${options[0]}`;
              return `- ${tool}: ${options[0]} or ${options[1]}`;
            });

            const replyText = `Based on what you said, here’s my best guess on plans. Reply “correct” to accept, or change any with “Tool: Plan”.\n${replyLines.join(
              "\n"
            )}`;

            const nextConfirm: IntakeState = {
              ...nextState,
              planSuggestions: tierSuggestions,
              stage: "confirm_plans",
            };
            await persistIntakeState(sessionId, nextConfirm);
            await persistMessage({ sessionId, role: "assistant", content: replyText });
            return NextResponse.json({ sessionId, onTopic: true, replyText });
          }
        }

        if (extractedItems.length === 0 && isMidTierAllTools(userMessage)) {
          const lines = missingPlans.map((tool) => {
            const plans = planOptionsForTool(tool);
            const candidates = middlePlanCandidates(plans);
            if (candidates.length === 0) {
              return `- ${tool}: reply with the exact plan name (Example: “${tool}: Professional”)`;
            }
            if (candidates.length === 1) {
              return `- ${tool}: did you mean “${candidates[0]}”?`;
            }
            return `- ${tool}: did you mean “${candidates[0]}” or “${candidates[1]}”?`;
          });

          const replyText = `When you say “mid-tier”, which exact plan do you mean for each tool?\n${lines.join(
            "\n"
          )}\n\nReply like: “Figma: Professional, Notion: Business, Slack: Business+”.`;
          await persistMessage({ sessionId, role: "assistant", content: replyText });
          return NextResponse.json({ sessionId, onTopic: true, replyText });
        }

        if (extractedItems.length === 0 && looksLikeSinglePlanForAll(userMessage)) {
          const plan = userMessage.trim();
          mergedItems = mergedItems.map((item) =>
            missingPlans.includes(item.tool) ? { ...item, plan } : item
          );
          nextState.lineItems = mergedItems;
          await persistIntakeState(sessionId, nextState);
        }

        const missingPlansAfterAutofill = missingPlanTools(mergedItems);
        if (missingPlansAfterAutofill.length === 0) {
          const missingPrices = missingPriceTools(mergedItems);

          if (missingPrices.length > 0) {
            const replyText = buildMissingPricePrompt(mergedItems, missingPrices);
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

      const missingPrices = missingPriceTools(mergedItems);
      if (missingPrices.length > 0) {
        nextState.stage = "collect";
        await persistIntakeState(sessionId, nextState);

        const replyText = buildMissingPricePrompt(mergedItems, missingPrices);
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
	        retries: 1,
	      });
	    } catch (advisorError) {
	      const message =
	        advisorError instanceof Error
	          ? advisorError.message
	          : String(advisorError);
	      const fallbackReply = buildAdvisorErrorReply([], message);

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
