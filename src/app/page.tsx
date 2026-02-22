"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ChatApiResponse,
  ChatSessionHistoryResponse,
  RenewalAdvice,
  chatApiResponseSchema,
  chatSessionHistoryResponseSchema,
} from "@/lib/contracts";

type ChatAction = { type: "google_signin" | "google_connect_gmail" };

type AuthMeResponse = {
  user: { id: string; email: string; name?: string | null; imageUrl?: string | null } | null;
  gmailConnected: boolean;
};

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  analysis?: RenewalAdvice;
  actions?: ChatAction[];
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

function normalizeToolKey(tool: string): string {
  return tool.trim().toLowerCase();
}

function toolsFromAnalysis(analysis: RenewalAdvice): string[] {
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const item of analysis.lineItems) {
    const tool = item.tool.trim();
    if (!tool) {
      continue;
    }

    const key = normalizeToolKey(tool);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tools.push(tool);
  }

  return tools;
}

function toolSendKey(messageId: string, tool: string): string {
  return `${messageId}:${normalizeToolKey(tool)}`;
}

function lineItemSummary(
  item: RenewalAdvice["lineItems"][number],
  currency: string
): string[] {
  const lines: string[] = [];

  if (item.plan) {
    lines.push(`Plan: ${item.plan}`);
  }
  if (typeof item.seats === "number") {
    lines.push(`Seats: ${item.seats}`);
  }
  if (typeof item.annualCost === "number") {
    lines.push(`Current annual spend: ${formatCurrency(item.annualCost, currency)}`);
  } else if (typeof item.annualCostPerSeat === "number") {
    lines.push(
      `Current annual per-seat price: ${formatCurrency(item.annualCostPerSeat, currency)}`
    );
  }

  return lines;
}

function toolEmailFromAnalysis(
  analysis: RenewalAdvice,
  tool: string
): { subject: string; body: string } {
  if (toolsFromAnalysis(analysis).length <= 1) {
    return {
      subject: analysis.counterEmail.subject,
      body: analysis.counterEmail.body,
    };
  }

  const match = analysis.lineItems.find(
    (item) => normalizeToolKey(item.tool) === normalizeToolKey(tool)
  );

  const currency = match?.currency ?? analysis.marketRange.currency ?? "USD";
  const summaryLines = match ? lineItemSummary(match, currency) : [];
  const summaryBlock =
    summaryLines.length > 0
      ? `\nCurrent account context:\n${summaryLines
          .map((line) => `- ${line}`)
          .join("\n")}\n`
      : "";

  const body = `Hi team,

We are reviewing our ${tool} renewal and need to align pricing with current market benchmarks.${summaryBlock}
Please send an updated proposal with:
- improved unit pricing for our current scope
- available annual and multi-year options
- written renewal protections (price caps and clear terms)

Thanks,`;

  return {
    subject: `${tool} renewal pricing adjustment request`,
    body,
  };
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
  const formRef = useRef<HTMLFormElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([INITIAL_ASSISTANT_MESSAGE]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [authMe, setAuthMe] = useState<AuthMeResponse>({ user: null, gmailConnected: false });
  const [authLoading, setAuthLoading] = useState(true);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [isAccountPanelOpen, setIsAccountPanelOpen] = useState(false);
  const [vendorEmails, setVendorEmails] = useState<Record<string, string>>({});
  const [sendingVendorEmails, setSendingVendorEmails] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    async function loadAuth() {
      setAuthLoading(true);
      try {
        const response = await fetch("/api/auth/me");
        const raw = (await response.json()) as AuthMeResponse;
        setAuthMe(raw);
      } catch {
        setAuthMe({ user: null, gmailConnected: false });
      } finally {
        setAuthLoading(false);
      }
    }

    loadAuth();
  }, []);

  useEffect(() => {
    async function maybeGenerateAfterSignin() {
      const url = new URL(window.location.href);
      const shouldAutoBrief = url.searchParams.get("autobrief") === "1";

      if (!shouldAutoBrief) {
        return;
      }

      url.searchParams.delete("autobrief");
      window.history.replaceState({}, "", url.toString());

      if (isHydrating || !sessionId) {
        return;
      }

      setIsSubmitting(true);
      try {
        const response = await fetch("/api/chat/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });

        const raw = await response.json();
        const parsed = chatApiResponseSchema.safeParse(raw);

        if (!parsed.success) {
          throw new Error("Invalid API response");
        }

        const data = parsed.data;

        const assistantMessage: UiMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.replyText,
          analysis: data.onTopic ? data.analysis : undefined,
          actions: (data.actions as ChatAction[] | undefined) ?? undefined,
          createdAt: new Date().toISOString(),
        };

        setMessages((current) => [...current, assistantMessage]);
        setAuthMe((current) => current);
      } catch {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "I couldn’t generate the full brief yet. Please try again.",
          },
        ]);
      } finally {
        setIsSubmitting(false);
      }
    }

    maybeGenerateAfterSignin();
  }, [isHydrating, sessionId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = inputValue.trim();

    if (!trimmed || isSubmitting) {
      return;
    }

    setPinnedToBottom(true);

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
        actions: (data.actions as ChatAction[] | undefined) ?? undefined,
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

  useEffect(() => {
    const element = messageListRef.current;
    if (!element || !pinnedToBottom) {
      return;
    }

    window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [messages.length, isSubmitting, isHydrating, pinnedToBottom]);

  function handleGoogleSignin() {
    const returnTo = window.location.href;
    const params = new URLSearchParams({
      returnTo,
      chatSessionId: sessionId ?? "",
    });
    window.location.href = `/api/auth/google/start?${params.toString()}`;
  }

  function handleConnectGmail() {
    const returnTo = window.location.href;
    const params = new URLSearchParams({ returnTo });
    window.location.href = `/api/auth/gmail/start?${params.toString()}`;
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setAuthMe({ user: null, gmailConnected: false });
      setIsAccountPanelOpen(false);
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

  async function sendViaGmail(params: {
    to: string;
    subject: string;
    body: string;
  }): Promise<void> {
    const response = await fetch("/api/gmail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: params.to,
        subject: params.subject,
        body: params.body,
      }),
    });

    const json = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !json.ok) {
      throw new Error(json.error ?? "Send failed");
    }
  }

  async function handleSendSingleToolEmail(params: {
    messageId: string;
    analysis: RenewalAdvice;
    tool: string;
  }) {
    if (!authMe.gmailConnected) {
      handleConnectGmail();
      return;
    }

    const key = toolSendKey(params.messageId, params.tool);
    const to = vendorEmails[key]?.trim();
    if (!to) {
      window.alert(`Please enter a contact email for ${params.tool}.`);
      return;
    }

    const { subject, body } = toolEmailFromAnalysis(params.analysis, params.tool);
    setSendingVendorEmails((current) => ({ ...current, [key]: true }));

    try {
      await sendViaGmail({ to, subject, body });
      window.alert(`Sent ${params.tool} email to ${to}.`);
    } catch {
      window.alert(`I couldn’t send the ${params.tool} email. Please try again.`);
    } finally {
      setSendingVendorEmails((current) => ({ ...current, [key]: false }));
    }
  }

  async function handleSendAllToolEmails(messageId: string, analysis: RenewalAdvice) {
    if (!authMe.gmailConnected) {
      handleConnectGmail();
      return;
    }

    const tools = toolsFromAnalysis(analysis);
    if (tools.length === 0) {
      window.alert("No tools found for this brief.");
      return;
    }

    const missingTools = tools.filter((tool) => {
      const key = toolSendKey(messageId, tool);
      return !vendorEmails[key]?.trim();
    });
    if (missingTools.length > 0) {
      window.alert(`Please enter contact emails for: ${missingTools.join(", ")}.`);
      return;
    }

    const keys = tools.map((tool) => toolSendKey(messageId, tool));
    setSendingVendorEmails((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      return next;
    });

    const sentTools: string[] = [];
    const failedTools: string[] = [];

    for (const tool of tools) {
      const key = toolSendKey(messageId, tool);
      const to = vendorEmails[key]!.trim();
      const { subject, body } = toolEmailFromAnalysis(analysis, tool);

      try {
        await sendViaGmail({ to, subject, body });
        sentTools.push(tool);
      } catch {
        failedTools.push(tool);
      }
    }

    setSendingVendorEmails((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = false;
      }
      return next;
    });

    if (failedTools.length === 0) {
      window.alert(`Sent ${sentTools.length} vendor email(s).`);
      return;
    }

    if (sentTools.length === 0) {
      window.alert("I couldn’t send those emails. Please try again.");
      return;
    }

    window.alert(`Sent: ${sentTools.join(", ")}. Failed: ${failedTools.join(", ")}.`);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_16%_22%,#d5f4f6_0%,transparent_38%),radial-gradient(circle_at_86%_16%,#fae9bf_0%,transparent_34%),linear-gradient(160deg,#f9fcff_0%,#fefaf2_100%)] px-4 py-8 text-zinc-900 md:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {!authLoading && authMe.user && (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIsAccountPanelOpen((current) => !current)}
            >
              {isAccountPanelOpen ? "Hide account" : "Account"}
            </Button>
          </div>
        )}

        {!authLoading && authMe.user && isAccountPanelOpen && (
          <div className="flex items-center justify-between rounded-3xl border border-zinc-200/70 bg-white/70 px-5 py-3 text-sm shadow-sm backdrop-blur">
            <div className="flex items-center gap-2 text-zinc-600">
              <span className="font-medium text-zinc-800">Account</span>
              <span>
                {authMe.user.name ? `${authMe.user.name} · ` : ""}
	                {authMe.user.email}
	              </span>
	            </div>
	            <div className="flex items-center gap-2">
	              <Button
	                variant="outline"
	                size="sm"
	                type="button"
	                onClick={handleConnectGmail}
	                disabled={authLoading}
	              >
	                {authMe.gmailConnected ? "Gmail Connected" : "Connect Gmail"}
	              </Button>
	              <Button variant="outline" size="sm" type="button" onClick={handleLogout}>
	                Log out
	              </Button>
	            </div>
	          </div>
	        )}

	        <header className="px-1">
	          <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
	            Stop overpaying on your SaaS subscriptions
	          </h1>
        </header>

        <Card className="border-zinc-200/80 bg-white/80 shadow-xl backdrop-blur">
          <CardHeader>
            <CardTitle className="text-lg">Chat</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="max-h-[58vh] space-y-4 overflow-y-auto pr-1"
              ref={messageListRef}
              onScroll={() => {
                const element = messageListRef.current;
                if (!element) {
                  return;
                }

                const distanceFromBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight;
                setPinnedToBottom(distanceFromBottom < 48);
              }}
            >
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
                  const analysisTools = analysis ? toolsFromAnalysis(analysis) : [];
                  const isSendingAnyVendorEmail =
                    analysis &&
                    analysisTools.some(
                      (tool) => sendingVendorEmails[toolSendKey(message.id, tool)] === true
                    );

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
                                <div className="flex items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleCopyEmail(message.id, analysis)}
                                    type="button"
                                  >
                                    {copiedMessageId === message.id ? "Copied" : "Copy Email"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="default"
                                    onClick={() => handleSendAllToolEmails(message.id, analysis)}
                                    type="button"
                                    disabled={isSendingAnyVendorEmail}
                                  >
                                    {authMe.gmailConnected
                                      ? analysisTools.length > 1
                                        ? "Send All via Gmail"
                                        : "Send via Gmail"
                                      : "Connect Gmail"}
                                  </Button>
                                </div>
                              </CardHeader>
                              <CardContent className="space-y-2 text-sm text-zinc-700">
                                <p className="font-medium">
                                  Subject: {analysis.counterEmail.subject}
                                </p>
                                <p className="whitespace-pre-wrap leading-6">
                                  {analysis.counterEmail.body}
                                </p>
                                <div className="mt-4 space-y-3 rounded-xl border border-zinc-200 bg-white p-3">
                                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                                    Vendor Contacts
                                  </p>
                                  {analysisTools.map((tool) => {
                                    const key = toolSendKey(message.id, tool);
                                    const sending = sendingVendorEmails[key] === true;

                                    return (
                                      <div key={key} className="grid gap-2 md:grid-cols-[1fr_auto]">
                                        <Input
                                          type="email"
                                          value={vendorEmails[key] ?? ""}
                                          onChange={(event) =>
                                            setVendorEmails((current) => ({
                                              ...current,
                                              [key]: event.target.value,
                                            }))
                                          }
                                          placeholder={`${tool} billing contact email`}
                                          className="bg-white"
                                        />
                                        <Button
                                          size="sm"
                                          type="button"
                                          onClick={() =>
                                            handleSendSingleToolEmail({
                                              messageId: message.id,
                                              analysis,
                                              tool,
                                            })
                                          }
                                          disabled={sending}
                                        >
                                          {sending ? `Sending ${tool}...` : `Send ${tool}`}
                                        </Button>
                                      </div>
                                    );
                                  })}
                                  <p className="text-xs text-zinc-500">
                                    Each tool sends as a separate email from your connected Gmail account.
                                  </p>
                                </div>
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

              {!authMe.user &&
                messages.some((message) =>
                  message.actions?.some((action) => action.type === "google_signin")
                ) && (
                <div className="flex justify-start">
                  <Card className="w-full max-w-xl border-zinc-200 bg-white">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Save and Generate Brief</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3 text-sm text-zinc-700">
                      <p>Sign in with Google to save your subscriptions and generate the full brief.</p>
                      <div className="flex items-center gap-2">
                        <Button type="button" onClick={handleGoogleSignin}>
                          Sign in with Google
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setInputValue("Skip sign-in for now")}
                        >
                          Skip for now
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {isSubmitting && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500">
                    Researching SaaS pricing...
                  </div>
                </div>
              )}
            </div>

            <form className="space-y-3" onSubmit={handleSubmit} ref={formRef}>
              <Textarea
                placeholder="Example: Slack Business+ 45 seats $19k/yr. You can also list multiple tools."
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    (event.nativeEvent as KeyboardEvent).isComposing
                  ) {
                    return;
                  }

                  if (!canSubmit || isHydrating) {
                    return;
                  }

                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }}
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
