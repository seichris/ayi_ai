import { readFile } from "node:fs/promises";
import path from "node:path";

import { renewalAdviceSchema } from "../src/lib/contracts";
import { z } from "zod";

const fixtureCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expectedOnTopic: z.boolean(),
  minLeveragePoints: z.number().int().nonnegative().optional(),
  expectClarifyingQuestions: z.boolean().optional(),
});

const fixtureSchema = z.array(fixtureCaseSchema).min(1);

const chatResponseSchema = z.object({
  sessionId: z.string().optional(),
  onTopic: z.boolean(),
  replyText: z.string(),
  analysis: renewalAdviceSchema.optional(),
});

type PromptCase = z.infer<typeof fixtureCaseSchema>;

type EvalResult = {
  id: string;
  passed: boolean;
  notes: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

async function loadCases(filePath: string): Promise<PromptCase[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return fixtureSchema.parse(parsed);
}

async function evaluateCase(baseUrl: string, testCase: PromptCase): Promise<EvalResult> {
  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: testCase.input }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: testCase.id,
      passed: false,
      notes: `Request failed: ${message}`,
    };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      id: testCase.id,
      passed: false,
      notes: `HTTP ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`,
    };
  }

  const parsedResponse = chatResponseSchema.safeParse(payload);

  if (!parsedResponse.success) {
    return {
      id: testCase.id,
      passed: false,
      notes: `Invalid response schema: ${parsedResponse.error.issues
        .map((issue) => `${issue.path.join(".") || "root"} ${issue.message}`)
        .join("; ")}`,
    };
  }

  const data = parsedResponse.data;

  if (testCase.expectedOnTopic !== data.onTopic) {
    return {
      id: testCase.id,
      passed: false,
      notes: `Expected onTopic=${testCase.expectedOnTopic} but received ${data.onTopic}`,
    };
  }

  if (testCase.expectedOnTopic) {
    if (!data.analysis) {
      return {
        id: testCase.id,
        passed: false,
        notes: "Expected analysis payload for on-topic case.",
      };
    }

    if (
      typeof testCase.minLeveragePoints === "number" &&
      data.analysis.leveragePoints.length < testCase.minLeveragePoints
    ) {
      return {
        id: testCase.id,
        passed: false,
        notes: `Expected at least ${testCase.minLeveragePoints} leverage points but got ${data.analysis.leveragePoints.length}`,
      };
    }

    if (testCase.expectClarifyingQuestions && data.analysis.clarifyingQuestions.length === 0) {
      return {
        id: testCase.id,
        passed: false,
        notes: "Expected clarifying questions for incomplete case.",
      };
    }

    return {
      id: testCase.id,
      passed: true,
      notes: `On-topic response valid with confidence=${data.analysis.confidence}`,
    };
  }

  const normalizedReply = data.replyText.toLowerCase();
  const seemsOnTopicWarning =
    normalizedReply.includes("stay on topic") ||
    normalizedReply.includes("saas pricing") ||
    normalizedReply.includes("renewal");

  if (!seemsOnTopicWarning) {
    return {
      id: testCase.id,
      passed: false,
      notes: "Off-topic case did not return a clear scope warning.",
    };
  }

  return {
    id: testCase.id,
    passed: true,
    notes: "Off-topic correctly rejected.",
  };
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    process.env.PROMPT_EVAL_BASE_URL ?? "http://localhost:3000"
  );
  const fixturePath = path.resolve(
    process.cwd(),
    process.env.PROMPT_EVAL_FIXTURES ?? "fixtures/prompt-cases.json"
  );

  const promptCases = await loadCases(fixturePath);
  const startedAt = Date.now();

  console.log(`Running prompt eval against ${baseUrl}`);
  console.log(`Loaded ${promptCases.length} cases from ${fixturePath}`);

  const results: EvalResult[] = [];

  for (const testCase of promptCases) {
    const result = await evaluateCase(baseUrl, testCase);
    results.push(result);

    const marker = result.passed ? "PASS" : "FAIL";
    console.log(`[${marker}] ${result.id} - ${result.notes}`);
  }

  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const durationMs = Date.now() - startedAt;

  console.log(
    `Summary: ${passedCount}/${results.length} passed, ${failedCount} failed in ${durationMs}ms`
  );

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prompt eval failed: ${message}`);
  process.exitCode = 1;
});
