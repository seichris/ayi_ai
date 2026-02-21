import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { renewalAdviceSchema, intakeStateSchema } from "@/lib/contracts";
import { benchmarkContext } from "@/lib/benchmarks";
import { prisma } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/server/auth";
import { generateJson } from "@/lib/gemini";

export const runtime = "nodejs";

const generateRequestSchema = z.object({
  sessionId: z.string().min(1),
});

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

export async function POST(request: NextRequest) {
  if (!prisma) {
    return NextResponse.json({ error: "Persistence is not enabled." }, { status: 503 });
  }

  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = generateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: parsed.data.sessionId },
    select: { id: true, userId: true, intake: true },
  });

  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  const intake = intakeStateSchema.safeParse(session.intake ?? {});
  const state = intake.success ? intake.data : intakeStateSchema.parse({});

  if (state.lineItems.length === 0) {
    return NextResponse.json({ error: "No subscriptions collected yet." }, { status: 400 });
  }

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

  const benchmarkText = benchmarkContext(state.lineItems.map((item) => item.tool).join(", "));

  const guidance = await generateJson(renewalAdviceSchema, {
    systemInstruction: ADVISOR_SYSTEM_PROMPT,
    userPrompt: `Use this benchmark context as directional input (not exact pricing):\n${benchmarkText}\n\nSubscriptions:\n${itemsText}\n\nReturn only JSON matching the required schema.\n\nOutput requirements:\n- Keep leverage points under 18 words each.\n- Counter email should be concise and negotiation-ready.\n- If data is missing, include clarifying questions and lower confidence.`,
    temperature: 0,
    maxOutputTokens: 4096,
    retries: 1,
  });

  const assistantReply = "Here is your SaaS renewal negotiation brief.";

  await prisma.chatMessage.create({
    data: {
      sessionId: session.id,
      role: "assistant",
      content: assistantReply,
      analysis: guidance,
    },
  });

  await prisma.chatSession.update({
    where: { id: session.id },
    data: { stage: "briefed", intake: { ...state, stage: "briefed" } },
  });

  return NextResponse.json({
    sessionId: session.id,
    onTopic: true,
    replyText: assistantReply,
    analysis: guidance,
    actions: [{ type: "google_connect_gmail" }],
  });
}
