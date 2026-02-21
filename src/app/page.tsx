"use client";

import { FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  ChatApiResponse,
  ChatSessionHistoryResponse,
  RenewalAdvice,
  chatApiResponseSchema,
  chatSessionHistoryResponseSchema,
} from "@/lib/contracts";

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  analysis?: RenewalAdvice;
  createdAt?: string;
};

const SESSION_STORAGE_KEY = "ayi_ai_session_id";

const INITIAL_ASSISTANT_MESSAGE: UiMessage = {
  id: "assistant-intro",
  role: "assistant",
  content:
    "Which SaaS services are you renewing? Share tool, plan, seat count, and annual price if you have it.",
};

function formatCurrency(value: number | undefined, currency: string): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function analysisEmailText(analysis: RenewalAdvice): string {
  return `Subject: ${analysis.counterEmail.subject}\n\n${analysis.counterEmail.body}`;
}

function mapHistoryToUiMessages(history: ChatSessionHistoryResponse): UiMessage[] {
  return history.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    analysis: message.analysis,
    createdAt: message.createdAt,
  }));
}

export default function Home() {
  const [messages, setMessages] = useState<UiMessage[]>([INITIAL_ASSISTANT_MESSAGE]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const canSubmit = inputValue.trim().length > 0 && !isSubmitting;

  useEffect(() => {
    async function hydrateSession() {
      try {
        const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);

        if (!storedSessionId) {
          setIsHydrating(false);
          return;
        }

        const response = await fetch(`/api/chat/session/${storedSessionId}`);

        if (!response.ok) {
          if (response.status === 404) {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
            setSessionId(null);
          }

          setIsHydrating(false);
          return;
        }

        const raw = await response.json();
        const parsed = chatSessionHistoryResponseSchema.safeParse(raw);

        if (!parsed.success) {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
          setSessionId(null);
          setIsHydrating(false);
          return;
        }

        setSessionId(parsed.data.sessionId);
        const historyMessages = mapHistoryToUiMessages(parsed.data);
        setMessages(
          historyMessages.length > 0 ? historyMessages : [INITIAL_ASSISTANT_MESSAGE]
        );
      } catch {
        setSessionId(null);
      } finally {
        setIsHydrating(false);
      }
    }

    hydrateSession();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = inputValue.trim();

    if (!trimmed || isSubmitting) {
      return;
    }

    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setInputValue("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: sessionId ?? undefined,
          message: trimmed,
        }),
      });

      const raw = await response.json();
      const parsed = chatApiResponseSchema.safeParse(raw);

      if (!parsed.success) {
        throw new Error("Invalid API response");
      }

      const data: ChatApiResponse = parsed.data;

      if (data.sessionId) {
        setSessionId(data.sessionId);
        window.localStorage.setItem(SESSION_STORAGE_KEY, data.sessionId);
      }

      const assistantMessage: UiMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          typeof data.replyText === "string" && data.replyText.length > 0
            ? data.replyText
            : "I could not generate a response.",
        analysis: data.onTopic ? data.analysis : undefined,
        createdAt: new Date().toISOString(),
      };

      setMessages((current) => [...current, assistantMessage]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "I could not reach the pricing assistant. Please try again in a moment.",
        },
      ]);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCopyEmail(messageId: string, analysis: RenewalAdvice) {
    try {
      await navigator.clipboard.writeText(analysisEmailText(analysis));
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId(null), 1800);
    } catch {
      setCopiedMessageId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_16%_22%,#d5f4f6_0%,transparent_38%),radial-gradient(circle_at_86%_16%,#fae9bf_0%,transparent_34%),linear-gradient(160deg,#f9fcff_0%,#fefaf2_100%)] px-4 py-8 text-zinc-900 md:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="rounded-3xl border border-zinc-200/70 bg-white/70 p-6 shadow-sm backdrop-blur md:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">
            Renewal Negotiation Copilot
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-5xl">
            Turn raw SaaS pricing into negotiation leverage
          </h1>
          <p className="mt-4 max-w-3xl text-sm text-zinc-600 md:text-base">
            Paste your current renewal details. The assistant returns market range,
            savings estimate, leverage points, and a counter-email draft.
          </p>
        </header>

        <Card className="border-zinc-200/80 bg-white/80 shadow-xl backdrop-blur">
          <CardHeader>
            <CardTitle className="text-lg">Chat</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-[58vh] space-y-4 overflow-y-auto pr-1">
              {isHydrating && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
                    Loading previous chat...
                  </div>
                </div>
              )}

              {!isHydrating &&
                messages.map((message) => {
                  const isAssistant = message.role === "assistant";
                  const analysis = message.analysis;

                  return (
                    <div
                      key={message.id}
                      className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}
                    >
                      <div
                        className={`w-full max-w-3xl rounded-2xl border p-4 shadow-sm ${
                          isAssistant
                            ? "border-zinc-200 bg-white"
                            : "border-blue-200 bg-blue-50"
                        }`}
                      >
                        <p className="text-sm leading-6 whitespace-pre-wrap">
                          {message.content}
                        </p>

                        {analysis && (
                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            <Card className="border-zinc-200 bg-zinc-50">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-base">Market Range</CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-2 text-sm text-zinc-700">
                                <p>
                                  {formatCurrency(
                                    analysis.marketRange.min,
                                    analysis.marketRange.currency
                                  )}
                                  {" - "}
                                  {formatCurrency(
                                    analysis.marketRange.max,
                                    analysis.marketRange.currency
                                  )}
                                </p>
                                <p className="text-xs text-zinc-500">
                                  {analysis.marketRange.basis}
                                </p>
                              </CardContent>
                            </Card>

                            <Card className="border-zinc-200 bg-zinc-50">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-base">Savings Estimate</CardTitle>
                              </CardHeader>
                              <CardContent className="space-y-2 text-sm text-zinc-700">
                                <p>
                                  {analysis.savingsEstimate.percentMin}% to{" "}
                                  {analysis.savingsEstimate.percentMax}%
                                </p>
                                <p className="text-xs text-zinc-500">
                                  {analysis.savingsEstimate.explanation}
                                </p>
                              </CardContent>
                            </Card>

                            <Card className="border-zinc-200 bg-zinc-50 md:col-span-2">
                              <CardHeader className="pb-2">
                                <CardTitle className="text-base">
                                  Negotiation Leverage
                                </CardTitle>
                              </CardHeader>
                              <CardContent>
                                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
                                  {analysis.leveragePoints.map((point) => (
                                    <li key={point}>{point}</li>
                                  ))}
                                </ul>
                              </CardContent>
                            </Card>

                            <Card className="border-zinc-200 bg-zinc-50 md:col-span-2">
                              <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
                                <CardTitle className="text-base">
                                  Ready-to-Copy Counter Email
                                </CardTitle>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleCopyEmail(message.id, analysis)}
                                  type="button"
                                >
                                  {copiedMessageId === message.id
                                    ? "Copied"
                                    : "Copy Email"}
                                </Button>
                              </CardHeader>
                              <CardContent className="space-y-2 text-sm text-zinc-700">
                                <p className="font-medium">
                                  Subject: {analysis.counterEmail.subject}
                                </p>
                                <p className="whitespace-pre-wrap leading-6">
                                  {analysis.counterEmail.body}
                                </p>
                              </CardContent>
                            </Card>

                            {analysis.clarifyingQuestions.length > 0 && (
                              <Card className="border-amber-200 bg-amber-50 md:col-span-2">
                                <CardHeader className="pb-2">
                                  <CardTitle className="text-base">
                                    Clarifying Questions
                                  </CardTitle>
                                </CardHeader>
                                <CardContent>
                                  <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
                                    {analysis.clarifyingQuestions.map((question) => (
                                      <li key={question}>{question}</li>
                                    ))}
                                  </ul>
                                </CardContent>
                              </Card>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

              {isSubmitting && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
                    Generating negotiation brief...
                  </div>
                </div>
              )}
            </div>

            <form className="space-y-3" onSubmit={handleSubmit}>
              <Textarea
                placeholder="Example: Slack Business+ 45 seats $19k/yr. You can also list multiple tools."
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                rows={4}
                className="bg-white"
              />
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-zinc-500">
                  Scope: SaaS pricing and renewal negotiation only.
                </p>
                <Button type="submit" disabled={!canSubmit || isHydrating}>
                  {isSubmitting ? "Sending..." : "Send"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
