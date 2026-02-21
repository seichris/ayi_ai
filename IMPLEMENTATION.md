# SaaS Renewal AI Chat App - Implementation Plan

Last updated: 2026-02-21

## Goals

- Ship an MVP web app that takes a user’s SaaS renewal details and returns:
  - fair market range
  - estimated savings percentage
  - negotiation leverage
  - copy-ready counter-email
- Keep the assistant on-topic for SaaS pricing and renewals using prompt and model-based gating, not hardcoded keyword rules.
- Set a clear path to a later automation agent that can contact vendors and report outcomes.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- AI provider: Gemini via Google AI Studio API key
- Default model target: Gemini Flash 3 (configurable through env)
- Persistence: Prisma + Postgres (optional; enabled when `DATABASE_URL` is set)

## MVP Scope

- Single landing page with a minimal chat UI:
  - message list
  - input field
  - send button
- Assistant starts by asking which SaaS services the user uses.
- User can submit one or more tools in free-form text.
- Assistant response includes structured sections:
  - market price range
  - estimated savings percentage
  - negotiation leverage
  - ready-to-copy counter-email
  - clarifying questions when details are missing

## Current State (Implemented)

- Chat UI returns structured pricing + negotiation output (market range, savings estimate, leverage points, counter email).
- Backend uses a two-step LLM flow (on-topic classifier then advisor) and validates JSON with Zod.
- Seeded benchmark dataset is used as directional context.
- Rate limiting is in place (IP-based in-memory).
- Optional persistence stores chat sessions/messages when `DATABASE_URL` is set.
- Google Sign-In endpoints are in place (`/api/auth/google/*`) and Gmail connect/send plumbing exists (`/api/auth/gmail/*`, `/api/gmail/send`).

## Data, Privacy, and Abuse Control (MVP)

- Default to least data: only store what’s needed to provide the service.
- Persistence is optional and gated by `DATABASE_URL`.
- Log only minimal operational telemetry (latency, parse success, classification result).
- Keep secrets in environment variables.

## Phase 2 - Credibility and Quality (Next)

1. Expand benchmark coverage and add a lightweight update workflow.
2. Improve clarifying-question loops (ask until enough pricing inputs exist).
3. Add export/share once persistence is enabled for a user.

## "Auto-Negotiation Agent" (Later)

### Capabilities

- Draft, send, and manage vendor negotiation email threads.
- Track lifecycle states from draft to resolution.
- Propose and execute next best response with user oversight.

### Product UX: Manual vs Connected Email

- Default: user copies the drafted email and sends it themselves (no Gmail access required).
- Optional: user connects Gmail so the product can create drafts and/or send emails on their behalf.
- Suggested journey:
  - Start unauthenticated (fastest time-to-value).
  - Prompt for Google Sign-In when the user wants to save/export a renewal bundle.
  - Prompt for "Connect Gmail" only when the user chooses “draft/send for me”.

### Architecture: Two OAuth Flows (Recommended)

We will separate identity from Gmail access.

- Flow 1: Google Sign-In (identity only)
  - Purpose: map subscription data + sessions to the user account.
  - Scopes: `openid email profile`.
  - Store: Google stable user id (`sub`) and the email used to sign in.
- Flow 2: "Connect Gmail" (incremental authorization)
  - Purpose: draft/send emails in the user’s name (and later: read replies, if we add it).
  - Request only the scopes needed for the feature.
  - Prefer incremental auth so users who only want “copy/paste” never see Gmail scopes.
  - Request offline access (refresh token) so the agent can work across days.
- Authorization records to persist: who authorized (user id / admin id), when, which scopes, and disconnect/revocation status.

### Gmail Scope Strategy (Least Privilege)

- Start with send-only or draft-first.
  - For “send for me”: use `gmail.send`.
  - For “create draft for me”: use a compose/draft-capable scope (avoid read scopes at first).
- Defer “monitor inbox / receive replies” until later.
  - Reply handling typically requires read scopes (`gmail.readonly`) and/or modify scopes (`gmail.modify`).
  - There is no fine-grained “only these recipients/threads” enforcement built into Gmail OAuth; scopes are the boundary.

### What OAuth Does and Does Not Guarantee

- OAuth scopes limit which Google APIs/features the token can call.
- If we have a token with a Gmail read scope, our backend can technically read whatever that scope allows.
- So the guarantee is primarily: least-privilege scopes + strong internal controls (policy checks, approvals, and audit logs).

### Safety and Controls

- Require human approval before the first send, and optionally before every send.
- Restrict destinations with per-customer allowlists (domains and/or specific vendor addresses).
- Enforce “agent can only send what it shows the user” (exact message hash in approval screen).
- Pause/cancel/manual-takeover controls for any thread.
- Maintain audit logs for all agent actions (draft created, message sent, thread read, labels applied).

### Enterprise Option (Future): Google Workspace Admin Delegation

- For Workspace customers, optionally support service accounts with domain-wide delegation so an admin can approve once per domain.
- Treat this as an enterprise feature with stricter security/compliance posture.

### Compliance Notes (Plan For It Early)

- Gmail scopes may trigger Google OAuth verification and “sensitive/restricted scope” requirements (privacy policy, justification, potential security assessment).
- Design the UI to clearly disclose what access is requested and why, with a one-click disconnect/revoke.

### Implementation Notes (Agent)

- Add user accounts via Google Sign-In (OpenID Connect).
- Store Gmail refresh tokens encrypted at rest; rotate/revoke on disconnect.
- Use background jobs/queue for async workflows (follow-ups, reminders, polling).
- Ingest replies via Gmail API (polling initially; evaluate push notifications later).
- Keep an internal state machine per vendor thread (drafted, approved, sent, replied, escalated, closed).

### Rollout Order

1. Manual send (copy-to-clipboard) plus optional Google Sign-In.
2. Connect Gmail for “draft creation” and/or “send” with per-send approval.
3. Add reply monitoring + suggested replies (read scopes), still with human approval.
4. Gradually allow constrained automation after reliability checks.

## Environment Variables

- `GOOGLE_AI_STUDIO_API_KEY`
- `GEMINI_MODEL` (default to Gemini Flash variant)
- `DATABASE_URL` (enables persistence)
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_ENABLED` (set to `false` to disable)
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URL` (Google Sign-In callback URL)
- `GOOGLE_GMAIL_OAUTH_REDIRECT_URL` (Gmail connect callback URL)
- `TOPIC_GUARDRAILS_ENABLED` (set to `false` to disable on-topic classifier)
- `DEMO_MODE_ENABLED` (set to `true` to return a prefilled demo brief after the first message)

## Acceptance Criteria (MVP)

- User can submit SaaS renewal text from landing page.
- Assistant returns all four required output sections in structured format.
- Off-topic prompt is rejected with stay-on-topic response.
- Endpoint validates output and does not render unstructured model text directly.
- Basic rate limiting is active.
