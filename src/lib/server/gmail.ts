import { prisma } from "@/lib/db";
import { refreshAccessToken } from "@/lib/server/google-oauth";

function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function buildRawEmail(params: {
  to: string;
  subject: string;
  body: string;
  fromName?: string;
}): string {
  const headers = [
    params.fromName ? `From: ${params.fromName}` : null,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
  ].filter(Boolean);

  return `${headers.join("\r\n")}\r\n\r\n${params.body}\r\n`;
}

export async function getGmailAccessToken(userId: string): Promise<string> {
  if (!prisma) {
    throw new Error("Persistence is not enabled.");
  }

  const connection = await prisma.googleConnection.findUnique({
    where: { userId },
    select: { accessToken: true, refreshToken: true, expiresAt: true },
  });

  if (!connection?.refreshToken) {
    throw new Error("Gmail is not connected for this account.");
  }

  const expiresAtMs = connection.expiresAt?.getTime() ?? 0;
  const hasValidAccessToken =
    typeof connection.accessToken === "string" &&
    connection.accessToken.length > 0 &&
    expiresAtMs > Date.now() + 30_000;

  if (hasValidAccessToken) {
    return connection.accessToken!;
  }

  const refreshed = await refreshAccessToken(connection.refreshToken);

  await prisma.googleConnection.update({
    where: { userId },
    data: {
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      scopes: refreshed.scope ?? undefined,
    },
  });

  return refreshed.accessToken;
}

export async function gmailSend(params: {
  userId: string;
  to: string;
  subject: string;
  body: string;
  fromName?: string;
}): Promise<{ id: string; threadId?: string }> {
  const accessToken = await getGmailAccessToken(params.userId);
  const raw = buildRawEmail({
    to: params.to,
    subject: params.subject,
    body: params.body,
    fromName: params.fromName,
  });
  const encoded = base64UrlEncode(raw);

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });

  const json = (await response.json()) as { id?: string; threadId?: string; error?: unknown };

  if (!response.ok || !json.id) {
    throw new Error("Gmail send failed.");
  }

  return { id: json.id, threadId: json.threadId };
}

