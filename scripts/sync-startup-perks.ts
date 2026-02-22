import { PrismaClient } from "@prisma/client";

type ParsedPerk = {
  slug: string;
  programName: string;
  providerName: string;
  amount: string;
  category: string;
  description: string;
  eligibility: string;
  additionalNotes: string;
  applyUrl: string;
  sourceUrl: string;
};

const SITE_ROOT = "https://www.startupperks.xyz";
const INDEX_URL = `${SITE_ROOT}/perks`;
const USER_AGENT = "ayi-ai-perks-sync/1.0 (+https://ayi.8o.vc)";
const DRY_RUN = process.env.PERKS_SYNC_DRY_RUN === "true";

const prisma = new PrismaClient();

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function compact(text: string): string {
  return decodeHtml(text).replace(/\s+/g, " ").trim();
}

function pick(html: string, regex: RegExp, label: string, slug: string): string {
  const match = html.match(regex);
  if (!match?.[1]) {
    throw new Error(`Missing ${label} for slug "${slug}".`);
  }
  return compact(match[1]);
}

function parseTitleParts(title: string): { programName: string; providerName: string } {
  const cleanTitle = compact(title);
  const parts = cleanTitle.split(" | ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { programName: parts[0], providerName: parts[1] };
  }
  return { programName: cleanTitle, providerName: "Unknown" };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function extractSlugs(indexHtml: string): string[] {
  const matches = [...indexHtml.matchAll(/href=\"\/perks\/([^\"?#]+)\"/g)];
  const unique = new Set<string>();

  for (const match of matches) {
    const slug = match[1]?.trim();
    if (!slug) {
      continue;
    }
    unique.add(slug);
  }

  return Array.from(unique.values());
}

function parsePerkDetail(slug: string, html: string): ParsedPerk {
  const sourceUrl = `${SITE_ROOT}/perks/${slug}`;

  const title = pick(html, /<title>([^<]+)<\/title>/i, "title", slug);
  const { programName, providerName } = parseTitleParts(title);

  const amount = pick(
    html,
    /<span class=\"text-3xl[^"]*\">([^<]+)<\/span>/i,
    "amount",
    slug
  );
  const description = pick(
    html,
    /<h2 class=\"text-xl font-black uppercase mb-4\">Description<\/h2><p class=\"text-lg leading-relaxed\">([^<]+)<\/p>/i,
    "description",
    slug
  );
  const category = pick(
    html,
    /<div class=\"mb-8\"><div class=\"inline-flex[^"]*text-sm\">([^<]+)<\/div><\/div><a href=\"https?:[^"]+\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"block\"><button[^>]*>Apply Now/i,
    "category",
    slug
  );
  const applyUrl = pick(
    html,
    /<a href=\"(https?:[^"]+)\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"block\"><button[^>]*>Apply Now/i,
    "applyUrl",
    slug
  );
  const eligibility = pick(
    html,
    />Eligibility<\/h3><\/div><div class=\"p-6 pt-0\"><p class=\"text-muted-foreground\">([^<]+)<\/p>/i,
    "eligibility",
    slug
  );
  const additionalNotes = pick(
    html,
    />Additional Notes<\/h3><\/div><div class=\"p-6 pt-0\"><p class=\"text-muted-foreground\">([^<]+)<\/p>/i,
    "additionalNotes",
    slug
  );

  return {
    slug,
    programName,
    providerName,
    amount,
    category,
    description,
    eligibility,
    additionalNotes,
    applyUrl,
    sourceUrl,
  };
}

async function upsertPerk(perk: ParsedPerk): Promise<void> {
  if (DRY_RUN) {
    return;
  }

  await prisma.startupPerk.upsert({
    where: { slug: perk.slug },
    create: {
      ...perk,
      scrapedAt: new Date(),
    },
    update: {
      ...perk,
      scrapedAt: new Date(),
    },
  });
}

async function main() {
  const indexHtml = await fetchText(INDEX_URL);
  const slugs = extractSlugs(indexHtml);

  if (slugs.length === 0) {
    throw new Error("No perk slugs found on index page.");
  }

  console.log(`Found ${slugs.length} perk slugs.`);

  let successCount = 0;
  const failures: Array<{ slug: string; error: string }> = [];

  for (const slug of slugs) {
    const sourceUrl = `${SITE_ROOT}/perks/${slug}`;
    try {
      const html = await fetchText(sourceUrl);
      const parsed = parsePerkDetail(slug, html);
      await upsertPerk(parsed);
      successCount += 1;
      console.log(`Upserted ${slug}`);
    } catch (error) {
      failures.push({
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`Failed ${slug}: ${failures[failures.length - 1].error}`);
    }
  }

  const totalInDb = DRY_RUN ? null : await prisma.startupPerk.count();
  console.log(
    JSON.stringify(
      {
        found: slugs.length,
        upserted: successCount,
        failed: failures.length,
        dryRun: DRY_RUN,
        totalInDb,
      },
      null,
      2
    )
  );

  if (failures.length > 0) {
    throw new Error(
      `Failed to sync ${failures.length} perks: ${failures
        .map((item) => `${item.slug} (${item.error})`)
        .join(", ")}`
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
