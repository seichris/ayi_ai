# AYI AI

AI chat app for startup and SMB SaaS renewal negotiation.

## Tech stack

- Next.js App Router + TypeScript
- Tailwind CSS + shadcn/ui
- Gemini via Google AI Studio API

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create env file:
   ```bash
   cp .env.example .env.local
   ```
3. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```
4. Apply migrations to your Postgres database:
   ```bash
   npm run prisma:migrate:dev
   ```
5. Run the app:
   ```bash
   npm run dev
   ```
6. Open `http://localhost:3000`.

## Environment variables

- `GOOGLE_AI_STUDIO_API_KEY`: required API key.
- `GEMINI_MODEL`: Gemini model name (`gemini-3-flash-preview` by default, with automatic fallback to this model on 404).
- `RATE_LIMIT_WINDOW_MS`: rate-limit window in milliseconds.
- `RATE_LIMIT_MAX_REQUESTS`: max requests per IP in window.
- `DATABASE_URL`: Postgres connection string for chat session persistence.

## Prompt eval

Run prompt regression checks against a running local server:

```bash
npm run prompt:eval
```

Optional env vars:
- `PROMPT_EVAL_BASE_URL` (default `http://localhost:3000`)
- `PROMPT_EVAL_FIXTURES` (default `fixtures/prompt-cases.json`)

## Current MVP behavior

- Landing-page chat asks which SaaS tools are in use.
- User submits one or more SaaS renewal details.
- Server performs LLM-based on-topic classification.
- If on-topic, assistant returns structured output:
  - fair market range
  - savings estimate
  - negotiation leverage
  - ready-to-copy counter-email
- If off-topic, assistant replies with a stay-on-topic message.
- Chat sessions and message history are persisted in Postgres via Prisma.
