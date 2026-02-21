import { NextRequest, NextResponse } from "next/server";

import { createPkce, randomToken, setOauthCookies } from "@/lib/server/auth";
import { googleClientId } from "@/lib/server/google-oauth";

export const runtime = "nodejs";

const GOOGLE_OAUTH_REDIRECT_URL = process.env.GOOGLE_OAUTH_REDIRECT_URL ?? "";

export async function GET(request: NextRequest) {
  if (!GOOGLE_OAUTH_REDIRECT_URL) {
    return NextResponse.json(
      { error: "GOOGLE_OAUTH_REDIRECT_URL is not set." },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/";
  const chatSessionId = url.searchParams.get("chatSessionId") ?? "";

  const state = randomToken(18);
  const pkce = await createPkce();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId());
  authUrl.searchParams.set("redirect_uri", GOOGLE_OAUTH_REDIRECT_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", `${state}:${encodeURIComponent(returnTo)}:${chatSessionId}`);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authUrl.toString());
  setOauthCookies(response, state, pkce.verifier);
  return response;
}

