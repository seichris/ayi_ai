import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedUser } from "@/lib/server/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!prisma) {
    return NextResponse.json({ user: null, gmailConnected: false });
  }

  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ user: null, gmailConnected: false });
  }

  const connection = await prisma.googleConnection.findUnique({
    where: { userId: user.id },
    select: { refreshToken: true },
  });

  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl },
    gmailConnected: Boolean(connection?.refreshToken),
  });
}

