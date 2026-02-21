import { NextResponse } from "next/server";

import { renewalAdviceSchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext) {
  if (!prisma) {
    return NextResponse.json(
      { error: "Persistence is not enabled." },
      { status: 503 }
    );
  }

  const { sessionId } = await context.params;

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          analysis: true,
          createdAt: true,
        },
      },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  const messages = session.messages.map((message) => {
    const parsedAnalysis = renewalAdviceSchema.safeParse(message.analysis);

    return {
      id: message.id,
      role: message.role,
      content: message.content,
      analysis: parsedAnalysis.success ? parsedAnalysis.data : undefined,
      createdAt: message.createdAt.toISOString(),
    };
  });

  return NextResponse.json({
    sessionId: session.id,
    messages,
  });
}
