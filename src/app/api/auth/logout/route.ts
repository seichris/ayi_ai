import { NextRequest, NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken } from "@/lib/server/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = getSessionToken(request);

  if (prisma && token) {
    await prisma.authSession.deleteMany({ where: { token } });
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

