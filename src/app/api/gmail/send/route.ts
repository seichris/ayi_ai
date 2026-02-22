import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedUser } from "@/lib/server/auth";
import { gmailSend } from "@/lib/server/gmail";

export const runtime = "nodejs";

const sendSchema = z.object({
  to: z.string().trim().email().max(320),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(12_000),
});

export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  try {
    const sent = await gmailSend({
      userId: user.id,
      to: parsed.data.to,
      subject: parsed.data.subject,
      body: parsed.data.body,
    });

    return NextResponse.json({ ok: true, id: sent.id, threadId: sent.threadId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
