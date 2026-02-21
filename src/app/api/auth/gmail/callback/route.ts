import { NextRequest, NextResponse } from "next/server";

import { clearGmailOauthCookies, getGmailOauthCookies } from "@/lib/server/auth";
import { exchangeCodeForTokens } from "@/lib/server/google-oauth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

const GOOGLE_GMAIL_OAUTH_REDIRECT_URL = process.env.GOOGLE_GMAIL_OAUTH_REDIRECT_URL ?? "";

function parseState(raw: string): { nonce: string; returnTo: string; userId: string } {
  const [nonce, returnToEncoded, userId] = raw.split(":");
  const returnTo = returnToEncoded ? decodeURIComponent(returnToEncoded) : "/";
  return { nonce: nonce ?? "", returnTo, userId: userId ?? "" };
}

export async function GET(request: NextRequest) {
  if (!prisma) {
    return NextResponse.json({ error: "Persistence is not enabled." }, { status: 503 });
  }

  if (!GOOGLE_GMAIL_OAUTH_REDIRECT_URL) {
    return NextResponse.json(
      { error: "GOOGLE_GMAIL_OAUTH_REDIRECT_URL is not set." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");

  if (!code || !rawState) {
    return NextResponse.json({ error: "Missing OAuth parameters." }, { status: 400 });
  }

  const cookies = getGmailOauthCookies(request);
  const parsed = parseState(rawState);

  if (!cookies.state || cookies.state !== parsed.nonce || !cookies.verifier) {
    return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
  }

  const tokens = await exchangeCodeForTokens({
    code,
    redirectUri: GOOGLE_GMAIL_OAUTH_REDIRECT_URL,
    codeVerifier: cookies.verifier,
  });

  const existing = await prisma.googleConnection.findUnique({
    where: { userId: parsed.userId },
    select: { id: true, refreshToken: true },
  });

  await prisma.googleConnection.upsert({
    where: { userId: parsed.userId },
    create: {
      userId: parsed.userId,
      scopes: tokens.scope ?? "https://www.googleapis.com/auth/gmail.send",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
    update: {
      scopes: tokens.scope ?? undefined,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? existing?.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  });

  const response = NextResponse.redirect(parsed.returnTo || "/");
  clearGmailOauthCookies(response);
  return response;
}
