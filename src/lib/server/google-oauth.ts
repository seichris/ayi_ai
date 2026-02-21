type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

export function googleClientId(): string {
  return requireEnv("GOOGLE_OAUTH_CLIENT_ID");
}

export function googleClientSecret(): string {
  return requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  idToken?: string;
}> {
  const body = new URLSearchParams();
  body.set("code", params.code);
  body.set("client_id", googleClientId());
  body.set("client_secret", googleClientSecret());
  body.set("redirect_uri", params.redirectUri);
  body.set("grant_type", "authorization_code");
  body.set("code_verifier", params.codeVerifier);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await response.json()) as TokenResponse;

  if (!response.ok || json.error) {
    const message = json.error_description ?? json.error ?? "Unknown token exchange error";
    throw new Error(`Google token exchange failed: ${message}`);
  }

  const accessToken = json.access_token;
  if (!accessToken) {
    throw new Error("Google token exchange did not return an access token.");
  }

  const expiresAt =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000)
      : undefined;

  return {
    accessToken,
    refreshToken: json.refresh_token,
    expiresAt,
    scope: json.scope,
    idToken: json.id_token,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt?: Date;
  scope?: string;
}> {
  const body = new URLSearchParams();
  body.set("client_id", googleClientId());
  body.set("client_secret", googleClientSecret());
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await response.json()) as TokenResponse;

  if (!response.ok || json.error) {
    const message = json.error_description ?? json.error ?? "Unknown refresh error";
    throw new Error(`Google token refresh failed: ${message}`);
  }

  const accessToken = json.access_token;
  if (!accessToken) {
    throw new Error("Google token refresh did not return an access token.");
  }

  const expiresAt =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000)
      : undefined;

  return { accessToken, expiresAt, scope: json.scope };
}

