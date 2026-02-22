import { z } from "zod";

import { type SaaSBenchmark, findBenchmarkForTool, registerBenchmark } from "@/lib/benchmarks";
import { prisma } from "@/lib/db";
import { generateJson } from "@/lib/gemini";

const BENCHMARK_AUTO_DISCOVERY_ENABLED =
  process.env.BENCHMARK_AUTO_DISCOVERY_ENABLED !== "false";

const BENCHMARK_RESEARCH_SYSTEM_PROMPT = `You are a SaaS pricing benchmark researcher.

Task:
- Provide directional annual per-seat USD pricing benchmarks for a SaaS tool.
- Provide typical enterprise/SMB renewal discount ranges.
- Provide common plan names and canonical aliases.

Rules:
- Return realistic directional ranges, not list-price absolutes.
- If uncertain, be conservative and lower confidence.
- Keep notes short and practical.
- Return JSON only.`;

const benchmarkDiscoverySchema = z
  .object({
    tool: z.string().min(1),
    aliases: z.array(z.string().min(1)).min(1).max(10),
    plans: z.array(z.string().min(1)).max(12).default([]),
    marketAnnualPerSeatUsd: z.object({
      min: z.coerce.number().positive(),
      max: z.coerce.number().positive(),
    }),
    typicalDiscountPct: z.object({
      min: z.coerce.number().min(0).max(80),
      max: z.coerce.number().min(0).max(80),
    }),
    notes: z.string().min(1).max(260),
    confidence: z.enum(["low", "medium", "high"]),
    assumptions: z.array(z.string().min(1)).max(6).default([]),
  })
  .transform((value) => {
    const annualMin = Math.round(
      Math.min(value.marketAnnualPerSeatUsd.min, value.marketAnnualPerSeatUsd.max)
    );
    const annualMax = Math.round(
      Math.max(value.marketAnnualPerSeatUsd.min, value.marketAnnualPerSeatUsd.max)
    );
    const discountMin = Math.round(
      Math.min(value.typicalDiscountPct.min, value.typicalDiscountPct.max)
    );
    const discountMax = Math.round(
      Math.max(value.typicalDiscountPct.min, value.typicalDiscountPct.max)
    );

    return {
      ...value,
      marketAnnualPerSeatUsd: {
        min: annualMin,
        max: annualMax,
      },
      typicalDiscountPct: {
        min: discountMin,
        max: discountMax,
      },
    };
  });

type DiscoveredBenchmark = z.infer<typeof benchmarkDiscoverySchema>;

const attemptedTools = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

function normalizeTool(value: string): string {
  return value.trim().toLowerCase();
}

function toSaaSBenchmark(record: {
  tool: string;
  aliases: string[];
  plans?: string[];
  marketAnnualPerSeatMinUsd: number;
  marketAnnualPerSeatMaxUsd: number;
  typicalDiscountMinPct: number;
  typicalDiscountMaxPct: number;
  notes: string;
}): SaaSBenchmark {
  return {
    tool: record.tool,
    aliases: record.aliases,
    plans: record.plans ?? [],
    marketAnnualPerSeatUsd: {
      min: record.marketAnnualPerSeatMinUsd,
      max: record.marketAnnualPerSeatMaxUsd,
    },
    typicalDiscountPct: {
      min: record.typicalDiscountMinPct,
      max: record.typicalDiscountMaxPct,
    },
    notes: record.notes,
  };
}

function discoveredToBenchmark(discovered: DiscoveredBenchmark): SaaSBenchmark {
  return {
    tool: discovered.tool.trim(),
    aliases: Array.from(
      new Set(
        [discovered.tool, ...discovered.aliases]
          .map((alias) => normalizeTool(alias))
          .filter((alias) => alias.length > 0)
      )
    ),
    plans: discovered.plans.map((plan) => plan.trim()).filter((plan) => plan.length > 0),
    marketAnnualPerSeatUsd: {
      min: discovered.marketAnnualPerSeatUsd.min,
      max: discovered.marketAnnualPerSeatUsd.max,
    },
    typicalDiscountPct: {
      min: discovered.typicalDiscountPct.min,
      max: discovered.typicalDiscountPct.max,
    },
    notes: discovered.notes.trim(),
  };
}

async function loadBenchmarkFromDb(tool: string): Promise<SaaSBenchmark | null> {
  if (!prisma) {
    return null;
  }

  const normalized = normalizeTool(tool);
  const row = await prisma.toolBenchmark.findFirst({
    where: {
      OR: [
        { lowerTool: normalized },
        { aliases: { has: normalized } },
      ],
    },
  });

  if (!row) {
    return null;
  }

  return toSaaSBenchmark(row);
}

async function persistBenchmarkToDb(
  benchmark: SaaSBenchmark,
  meta?: { confidence?: "low" | "medium" | "high"; assumptions?: string[] }
): Promise<void> {
  if (!prisma) {
    return;
  }

  const lowerTool = normalizeTool(benchmark.tool);
  const aliases = Array.from(
    new Set(
      benchmark.aliases
        .map((alias) => normalizeTool(alias))
        .concat(lowerTool)
        .filter((alias) => alias.length > 0)
    )
  );

  await prisma.toolBenchmark.upsert({
    where: { lowerTool },
    create: {
      tool: benchmark.tool.trim(),
      lowerTool,
      aliases,
      plans: benchmark.plans ?? [],
      marketAnnualPerSeatMinUsd: benchmark.marketAnnualPerSeatUsd.min,
      marketAnnualPerSeatMaxUsd: benchmark.marketAnnualPerSeatUsd.max,
      typicalDiscountMinPct: benchmark.typicalDiscountPct.min,
      typicalDiscountMaxPct: benchmark.typicalDiscountPct.max,
      notes: benchmark.notes,
      source: "auto_discovered",
      confidence: meta?.confidence,
      assumptions: meta?.assumptions ?? [],
    },
    update: {
      tool: benchmark.tool.trim(),
      aliases,
      plans: benchmark.plans ?? [],
      marketAnnualPerSeatMinUsd: benchmark.marketAnnualPerSeatUsd.min,
      marketAnnualPerSeatMaxUsd: benchmark.marketAnnualPerSeatUsd.max,
      typicalDiscountMinPct: benchmark.typicalDiscountPct.min,
      typicalDiscountMaxPct: benchmark.typicalDiscountPct.max,
      notes: benchmark.notes,
      source: "auto_discovered",
      confidence: meta?.confidence,
      assumptions: meta?.assumptions ?? [],
    },
  });
}

async function discoverBenchmark(tool: string): Promise<{
  benchmark: SaaSBenchmark;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
} | null> {
  const normalizedTool = tool.trim();
  if (!normalizedTool) {
    return null;
  }

  try {
    const discovered = await generateJson(benchmarkDiscoverySchema, {
      systemInstruction: BENCHMARK_RESEARCH_SYSTEM_PROMPT,
      userPrompt: `Research this SaaS tool and return a directional benchmark profile:
tool="${normalizedTool}"

Requirements:
- Use canonical vendor/product naming in "tool".
- Include alias variants people might type.
- Keep annual per-seat USD benchmark realistic for SMB/startup renewals.
- Include typical discount range for negotiated annual renewals.
- If the tool is unusual/niche, use wider ranges and lower confidence.
- Return JSON only.`,
      temperature: 0,
      maxOutputTokens: 1500,
      retries: 1,
    });

    const benchmark = discoveredToBenchmark(discovered);
    return {
      benchmark,
      confidence: discovered.confidence,
      assumptions: discovered.assumptions,
    };
  } catch (error) {
    console.warn("benchmark.discovery_failed", {
      tool: normalizedTool,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function discoverAndPersistTool(tool: string): Promise<void> {
  const normalized = normalizeTool(tool);
  if (!normalized || findBenchmarkForTool(tool)) {
    return;
  }

  const fromDb = await loadBenchmarkFromDb(tool);
  if (fromDb) {
    registerBenchmark(fromDb);
    return;
  }

  if (!BENCHMARK_AUTO_DISCOVERY_ENABLED || attemptedTools.has(normalized)) {
    return;
  }

  attemptedTools.add(normalized);
  const discovered = await discoverBenchmark(tool);
  if (!discovered) {
    return;
  }

  registerBenchmark(discovered.benchmark);
  await persistBenchmarkToDb(discovered.benchmark, {
    confidence: discovered.confidence,
    assumptions: discovered.assumptions,
  });
}

function ensureTool(tool: string): Promise<void> {
  const normalized = normalizeTool(tool);
  if (!normalized) {
    return Promise.resolve();
  }

  const existing = inFlight.get(normalized);
  if (existing) {
    return existing;
  }

  const promise = discoverAndPersistTool(tool).finally(() => {
    inFlight.delete(normalized);
  });
  inFlight.set(normalized, promise);
  return promise;
}

export async function ensureBenchmarksForTools(tools: string[]): Promise<void> {
  const toolMap = new Map<string, string>();
  for (const tool of tools) {
    const normalized = normalizeTool(tool);
    if (!normalized || toolMap.has(normalized)) {
      continue;
    }
    toolMap.set(normalized, tool.trim());
  }

  for (const tool of toolMap.values()) {
    await ensureTool(tool);
  }
}
