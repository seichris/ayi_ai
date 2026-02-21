import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import {
  clearOauthCookies,
  getOauthCookies,
  randomToken,
  setSessionCookie,
  verifyGoogleIdToken,
} from "@/lib/server/auth";
import { exchangeCodeForTokens } from "@/lib/server/google-oauth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const GOOGLE_OAUTH_REDIRECT_URL = process.env.GOOGLE_OAUTH_REDIRECT_URL ?? "";

function parseState(raw: string): { nonce: string; returnTo: string; chatSessionId?: string } {
  const [nonce, returnToEncoded, chatSessionId] = raw.split(":");
  const returnTo = returnToEncoded ? decodeURIComponent(returnToEncoded) : "/";
  return { nonce: nonce ?? "", returnTo, chatSessionId };
}

export async function GET(request: NextRequest) {
  if (!prisma) {
    return NextResponse.json({ error: "Persistence is not enabled." }, { status: 503 });
  }

  if (!GOOGLE_OAUTH_REDIRECT_URL) {
    return NextResponse.json(
      { error: "GOOGLE_OAUTH_REDIRECT_URL is not set." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");

  if (!code || !rawState) {
    return NextResponse.json({ error: "Missing OAuth parameters." }, { status: 400 });
  }

  const cookies = getOauthCookies(request);
  const parsed = parseState(rawState);

  if (!cookies.state || cookies.state !== parsed.nonce || !cookies.verifier) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  const tokens = await exchangeCodeForTokens({
    code,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URL,
    codeVerifier: cookies.verifier,
  });

  if (!tokens.idToken) {
    return NextResponse.json({ error: "Missing ID token." }, { status: 400 });
  }

  const claims = await verifyGoogleIdToken(tokens.idToken);

  const user = await prisma.user.upsert({
    where: { googleSub: claims.sub },
    create: {
      googleSub: claims.sub,
      email: claims.email,
      name: claims.name,
      imageUrl: claims.picture,
    },
    update: {
      email: claims.email,
      name: claims.name,
      imageUrl: claims.picture,
    },
    select: { id: true },
  });

  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  await prisma.authSession.create({
    data: {
      token: sessionToken,
      userId: user.id,
      expiresAt,
    },
  });

  if (parsed.chatSessionId) {
    const existing = await prisma.chatSession.findUnique({
      where: { id: parsed.chatSessionId },
      select: { intake: true, stage: true },
    });

    const intake: Prisma.JsonObject =
      typeof existing?.intake === "object" && existing.intake
        ? (existing.intake as Prisma.JsonObject)
        : {};
    const nextStage = existing?.stage === "prompt_signin" ? "ready" : existing?.stage;
    const intakeJson = (nextStage ? { ...intake, stage: nextStage } : intake) as Prisma.InputJsonValue;

    await prisma.chatSession.update({
      where: { id: parsed.chatSessionId },
      data: {
        userId: user.id,
        stage: nextStage,
        intake: intakeJson,
      },
    });
  }

  const redirectUrl = new URL(parsed.returnTo || "/", request.nextUrl.origin);
  const response = NextResponse.redirect(redirectUrl.toString());
  clearOauthCookies(response);
  setSessionCookie(response, sessionToken);
  return response;
}
