# SaaS Renewal AI Chat App - Implementation Plan

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

## Architecture

### Frontend

- `app/page.tsx` renders a one-page chat experience.
- Use shadcn/ui primitives for input, button, card, and textarea.
- Render assistant output in structured cards rather than raw long-form text.

### Backend

- `POST /api/chat` endpoint accepts chat history and latest user message.
- Server calls Gemini with strict system/developer instructions.
- Server enforces a JSON schema response with Zod before returning data.
- UI only renders validated structured data.

### On-topic guardrails

- Two-step LLM flow:
  1. Classifier prompt returns `allowed` or `disallowed` with a short reason.
  2. If disallowed, return a fixed response: stay focused on SaaS pricing/renewals.
  3. If allowed, run the main pricing and negotiation prompt.
- Prevent instruction override by keeping behavior in system prompt and never executing user-provided directives.

## Prompt and Output Contract

- Require JSON-only response for both classifier and main responder.
- Main response shape:
  - `line_items`
  - `market_range`
  - `savings_estimate`
  - `leverage_points`
  - `counter_email`
  - `clarifying_questions`
  - `assumptions`
  - `confidence`
- Retry once on parse failure, then return a safe fallback error.

## Pricing Intelligence Approach (MVP)

- Extract normalized line items from free-form user text.
- Combine:
  - seeded benchmark dataset for top SaaS tools
  - model reasoning for interpolation when data is incomplete
- Always return assumptions and confidence level.
- Compute savings range from current price when available; otherwise return typical discount band.

## Data, Privacy, and Abuse Control

- MVP is stateless by default.
- Add lightweight rate limiting per IP.
- Log only minimal operational telemetry (latency, parse success, classification result).
- Keep secrets in environment variables.

## Delivery Phases

### Phase 1 - MVP build (implement now)

1. Initialize Next.js + TypeScript + Tailwind + shadcn/ui.
2. Build single-page chat UI.
3. Add `/api/chat` Gemini integration with two-step classification and structured response.
4. Add a seeded benchmark JSON dataset for common tools.
5. Add response cards + copy-to-clipboard for email draft.
6. Add basic rate limiting and operational logs.

### Phase 2 - credibility and quality (next)

1. Expand benchmark coverage and update workflow.
2. Add better clarifying-question loops.
3. Add export/share features once persistence is introduced.

## "Auto-Negotiation Agent" (Later)

### Capabilities

- Draft, send, and manage vendor negotiation email threads.
- Track lifecycle states from draft to resolution.
- Propose and execute next best response with user oversight.

### Architecture

- Add authentication and user identity.
- Connect outbound channels (Gmail/Microsoft or managed email service).
- Use background jobs/queue for async workflows.
- Ingest replies via webhook or polling.
- Maintain audit logs for all agent actions.

### Safety and controls

- Require human approval before initial send (and optionally every send).
- Restrict destinations with per-customer allowlists.
- Escalate to user when legal/procurement/security terms appear.
- Add clear pause/cancel/manual-takeover controls.

### Rollout order

1. Start with human-in-the-loop draft and send.
2. Add monitoring and suggested replies.
3. Gradually allow constrained automation after reliability checks.

## Environment Variables

- `GOOGLE_AI_STUDIO_API_KEY`
- `GEMINI_MODEL` (default to Gemini Flash variant)
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX_REQUESTS`

## Acceptance Criteria (MVP)

- User can submit SaaS renewal text from landing page.
- Assistant returns all four required output sections in structured format.
- Off-topic prompt is rejected with stay-on-topic response.
- Endpoint validates output and does not render unstructured model text directly.
- Basic rate limiting is active.
