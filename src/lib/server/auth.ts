import crypto from "node:crypto";

import { jwtVerify, createRemoteJWKSet } from "jose";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  imageUrl?: string | null;
  googleSub: string;
};

const SESSION_COOKIE_NAME = "ayi_session";
const OAUTH_STATE_COOKIE = "ayi_oauth_state";
const OAUTH_VERIFIER_COOKIE = "ayi_oauth_verifier";
const GMAIL_STATE_COOKIE = "ayi_gmail_oauth_state";
const GMAIL_VERIFIER_COOKIE = "ayi_gmail_oauth_verifier";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.randomBytes(bytes));
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = crypto.createHash("sha256").update(input).digest();
  return base64Url(digest);
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function setCookie(response: NextResponse, name: string, value: string, maxAgeSeconds?: number) {
  response.cookies.set({
    name,
    value,
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearCookie(response: NextResponse, name: string) {
  response.cookies.set({
    name,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 0,
  });
}

export function getSessionToken(request: NextRequest): string | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  return token && token.length > 0 ? token : null;
}

export async function getAuthenticatedUser(request: NextRequest): Promise<AuthenticatedUser | null> {
  if (!prisma) {
    return null;
  }

  const token = getSessionToken(request);
  if (!token) {
    return null;
  }

  const session = await prisma.authSession.findUnique({
    where: { token },
    select: {
      expiresAt: true,
      user: { select: { id: true, email: true, name: true, imageUrl: true, googleSub: true } },
    },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return session.user;
}

export function getOauthCookies(request: NextRequest): { state: string | null; verifier: string | null } {
  return {
    state: request.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null,
    verifier: request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value ?? null,
  };
}

export function getGmailOauthCookies(request: NextRequest): { state: string | null; verifier: string | null } {
  return {
    state: request.cookies.get(GMAIL_STATE_COOKIE)?.value ?? null,
    verifier: request.cookies.get(GMAIL_VERIFIER_COOKIE)?.value ?? null,
  };
}

export function setOauthCookies(response: NextResponse, state: string, verifier: string) {
  setCookie(response, OAUTH_STATE_COOKIE, state, 10 * 60);
  setCookie(response, OAUTH_VERIFIER_COOKIE, verifier, 10 * 60);
}

export function setGmailOauthCookies(response: NextResponse, state: string, verifier: string) {
  setCookie(response, GMAIL_STATE_COOKIE, state, 10 * 60);
  setCookie(response, GMAIL_VERIFIER_COOKIE, verifier, 10 * 60);
}

export function clearOauthCookies(response: NextResponse) {
  clearCookie(response, OAUTH_STATE_COOKIE);
  clearCookie(response, OAUTH_VERIFIER_COOKIE);
}

export function clearGmailOauthCookies(response: NextResponse) {
  clearCookie(response, GMAIL_STATE_COOKIE);
  clearCookie(response, GMAIL_VERIFIER_COOKIE);
}

export function setSessionCookie(response: NextResponse, token: string) {
  // 14 days
  setCookie(response, SESSION_COOKIE_NAME, token, 14 * 24 * 60 * 60);
}

export function clearSessionCookie(response: NextResponse) {
  clearCookie(response, SESSION_COOKIE_NAME);
}

export async function verifyGoogleIdToken(idToken: string): Promise<{
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID is not set.");
  }

  const result = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });

  const payload = result.payload as Record<string, unknown>;
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : null;

  if (!sub || !email) {
    throw new Error("Google ID token missing required claims.");
  }

  const name = typeof payload.name === "string" ? payload.name : undefined;
  const picture = typeof payload.picture === "string" ? payload.picture : undefined;

  return { sub, email, name, picture };
}

