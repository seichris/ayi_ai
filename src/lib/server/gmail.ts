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
}): string {
  const sanitizedTo = params.to.replace(/[\r\n]+/g, " ").trim();
  const sanitizedSubject = params.subject.replace(/[\r\n]+/g, " ").trim();
  const headers = [
    // Do not set From manually; Gmail will use the authenticated sender.
    `To: ${sanitizedTo}`,
    `Subject: ${sanitizedSubject}`,
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
}): Promise<{ id: string; threadId?: string }> {
  const accessToken = await getGmailAccessToken(params.userId);
  const raw = buildRawEmail({
    to: params.to,
    subject: params.subject,
    body: params.body,
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

  const rawText = await response.text();
  let json: {
    id?: string;
    threadId?: string;
    error?: {
      code?: number;
      message?: string;
      status?: string;
      errors?: Array<{ message?: string; reason?: string }>;
    };
  } = {};
  try {
    json = JSON.parse(rawText) as typeof json;
  } catch {
    json = {};
  }

  if (!response.ok || !json.id) {
    const apiMessage = json.error?.message;
    const apiReason = json.error?.errors?.[0]?.reason;
    const details =
      apiMessage || apiReason
        ? `: ${[apiMessage, apiReason].filter(Boolean).join(" | ")}`
        : rawText
          ? `: ${rawText.slice(0, 500)}`
          : "";
    throw new Error(`Gmail send failed (HTTP ${response.status})${details}`);
  }

  return { id: json.id, threadId: json.threadId };
}
