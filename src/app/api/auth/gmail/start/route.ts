import { NextRequest, NextResponse } from "next/server";

import { createPkce, getAuthenticatedUser, randomToken, setGmailOauthCookies } from "@/lib/server/auth";
import { googleClientId } from "@/lib/server/google-oauth";

export const runtime = "nodejs";

const GOOGLE_GMAIL_OAUTH_REDIRECT_URL = process.env.GOOGLE_GMAIL_OAUTH_REDIRECT_URL ?? "";

export async function GET(request: NextRequest) {
  if (!GOOGLE_GMAIL_OAUTH_REDIRECT_URL) {
    return NextResponse.json(
      { error: "GOOGLE_GMAIL_OAUTH_REDIRECT_URL is not set." },
      { status: 500 }
    );
  }

  const user = await getAuthenticatedUser(request);
  if (!user) {
    const url = new URL(request.url);
    const returnTo = url.searchParams.get("returnTo") ?? "/";
    return NextResponse.redirect(
      `/api/auth/google/start?${new URLSearchParams({ returnTo }).toString()}`
    );
  }

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/";

  const state = randomToken(18);
  const pkce = await createPkce();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId());
  authUrl.searchParams.set("redirect_uri", GOOGLE_GMAIL_OAUTH_REDIRECT_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/gmail.send");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", `${state}:${encodeURIComponent(returnTo)}:${user.id}`);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authUrl.toString());
  setGmailOauthCookies(response, state, pkce.verifier);
  return response;
}
