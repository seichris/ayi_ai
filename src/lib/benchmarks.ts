export type SaaSBenchmark = {
  tool: string;
  aliases: string[];
  plans?: string[];
  marketAnnualPerSeatUsd: {
    min: number;
    max: number;
  };
  typicalDiscountPct: {
    min: number;
    max: number;
  };
  notes: string;
};

export const SAAS_BENCHMARKS: SaaSBenchmark[] = [
  {
    tool: "Slack",
    aliases: ["slack", "slack business+", "slack business plus"],
    plans: ["Free", "Pro", "Business+", "Enterprise Grid"],
    marketAnnualPerSeatUsd: { min: 120, max: 210 },
    typicalDiscountPct: { min: 8, max: 24 },
    notes: "Volume and multi-year deals usually unlock better rates than list pricing.",
  },
  {
    tool: "Figma",
    aliases: ["figma"],
    plans: ["Starter", "Professional", "Organization", "Enterprise"],
    marketAnnualPerSeatUsd: { min: 150, max: 650 },
    typicalDiscountPct: { min: 8, max: 25 },
    notes: "Plan mix (design/dev) and seat commitments drive discounting more than list price.",
  },
  {
    tool: "Google Workspace",
    aliases: ["google workspace", "workspace", "g suite"],
    plans: ["Business Starter", "Business Standard", "Business Plus", "Enterprise"],
    marketAnnualPerSeatUsd: { min: 70, max: 260 },
    typicalDiscountPct: { min: 5, max: 20 },
    notes: "Flexible vs annual terms and security add-ons materially change effective cost.",
  },
  {
    tool: "Microsoft 365",
    aliases: ["microsoft 365", "office 365", "m365"],
    plans: [
      "Business Basic",
      "Business Standard",
      "Business Premium",
      "Apps for business",
      "E3",
      "E5",
    ],
    marketAnnualPerSeatUsd: { min: 75, max: 360 },
    typicalDiscountPct: { min: 6, max: 22 },
    notes: "CSP channel and bundle mix can shift renewal economics significantly.",
  },
  {
    tool: "Notion",
    aliases: ["notion"],
    plans: ["Free", "Plus", "Business", "Enterprise"],
    marketAnnualPerSeatUsd: { min: 90, max: 220 },
    typicalDiscountPct: { min: 10, max: 28 },
    notes: "Consolidated workspace counts and committed seat floors drive concessions.",
  },
  {
    tool: "Zoom",
    aliases: ["zoom", "zoom workplace"],
    plans: ["Basic", "Pro", "Business", "Business Plus", "Enterprise"],
    marketAnnualPerSeatUsd: { min: 120, max: 300 },
    typicalDiscountPct: { min: 8, max: 25 },
    notes: "Room licenses, webinar add-ons, and payment timing strongly affect final pricing.",
  },
  {
    tool: "Atlassian Jira",
    aliases: ["jira", "jira software", "atlassian"],
    plans: ["Free", "Standard", "Premium", "Enterprise"],
    marketAnnualPerSeatUsd: { min: 95, max: 260 },
    typicalDiscountPct: { min: 7, max: 23 },
    notes: "Data residency and enterprise support tiers can increase baseline cost.",
  },
  {
    tool: "Salesforce",
    aliases: ["salesforce", "sfdc"],
    plans: ["Starter", "Professional", "Enterprise", "Unlimited"],
    marketAnnualPerSeatUsd: { min: 700, max: 2400 },
    typicalDiscountPct: { min: 10, max: 30 },
    notes: "Edition mix and co-term alignment matter more than nominal list prices.",
  },
];

export function findRelevantBenchmarks(input: string): SaaSBenchmark[] {
  const normalized = input.toLowerCase();
  const matches = SAAS_BENCHMARKS.filter((benchmark) =>
    benchmark.aliases.some((alias) => normalized.includes(alias))
  );

  if (matches.length > 0) {
    return matches.slice(0, 6);
  }

  return SAAS_BENCHMARKS.slice(0, 5);
}

export function benchmarkContext(input: string): string {
  const rows = findRelevantBenchmarks(input)
    .map(
      (item) =>
        `- ${item.tool}: ${item.marketAnnualPerSeatUsd.min}-${item.marketAnnualPerSeatUsd.max} USD/seat/year, typical discount ${item.typicalDiscountPct.min}-${item.typicalDiscountPct.max}% (${item.notes})`
    )
    .join("\n");

  return rows;
}

export function findBenchmarkForTool(tool: string): SaaSBenchmark | null {
  const normalized = tool.toLowerCase().trim();
  const match = SAAS_BENCHMARKS.find(
    (benchmark) =>
      benchmark.tool.toLowerCase() === normalized ||
      benchmark.aliases.some((alias) => normalized.includes(alias))
  );
  return match ?? null;
}

export function planOptionsForTool(tool: string): string[] {
  const match = findBenchmarkForTool(tool);
  return match?.plans?.slice() ?? [];
}
