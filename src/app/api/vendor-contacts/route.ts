import { NextRequest, NextResponse } from "next/server";

import { findBenchmarkForTool } from "@/lib/benchmarks";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function parseRequestedTools(request: NextRequest): string[] {
  const url = new URL(request.url);
  const direct = url.searchParams.getAll("tool");
  const csv = url.searchParams.get("tools");
  const parts = [
    ...direct,
    ...(csv ? csv.split(",") : []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return Array.from(new Set(parts)).slice(0, 50);
}

function canonicalTool(tool: string): string {
  const benchmark = findBenchmarkForTool(tool);
  return benchmark?.tool ?? tool.trim();
}

export async function GET(request: NextRequest) {
  const tools = parseRequestedTools(request);
  if (tools.length === 0) {
    return NextResponse.json({ contacts: {} });
  }

  if (!prisma) {
    return NextResponse.json({ contacts: {} });
  }

  const requestedLower = Array.from(
    new Set(tools.map((tool) => normalize(canonicalTool(tool))).filter((tool) => tool.length > 0))
  );

  const rows = await prisma.vendorContact.findMany({
    where: {
      OR: [
        { lowerTool: { in: requestedLower } },
        { aliases: { hasSome: requestedLower } },
      ],
    },
    select: {
      tool: true,
      lowerTool: true,
      aliases: true,
      contactEmail: true,
      sourceUrl: true,
    },
  });

  const contacts: Record<
    string,
    { tool: string; email: string; sourceUrl?: string | null }
  > = {};

  for (const requested of requestedLower) {
    const row =
      rows.find((candidate) => candidate.lowerTool === requested) ??
      rows.find((candidate) => candidate.aliases.includes(requested));
    if (!row) {
      continue;
    }
    contacts[requested] = {
      tool: row.tool,
      email: row.contactEmail,
      sourceUrl: row.sourceUrl,
    };
  }

  return NextResponse.json({ contacts });
}
