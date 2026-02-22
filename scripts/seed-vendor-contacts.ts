import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type VendorContactSeed = {
  tool: string;
  aliases: string[];
  contactEmail: string;
  sourceUrl?: string;
  notes?: string;
};

const CONTACTS: VendorContactSeed[] = [
  {
    tool: "Slack",
    aliases: ["slack", "slack business+", "slack business plus"],
    contactEmail: "sales@slack.com",
    sourceUrl: "https://slack.com/contact-sales",
    notes: "Sales contact for commercial and plan inquiries.",
  },
  {
    tool: "Notion",
    aliases: ["notion"],
    contactEmail: "sales@makenotion.com",
    sourceUrl: "https://www.notion.com/contact-sales",
    notes: "Sales contact for workspace and plan inquiries.",
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function main() {
  let upserted = 0;

  for (const item of CONTACTS) {
    const lowerTool = normalize(item.tool);
    const aliases = Array.from(
      new Set(
        [item.tool, ...item.aliases]
          .map(normalize)
          .filter((alias) => alias.length > 0)
      )
    );

    await prisma.vendorContact.upsert({
      where: { lowerTool },
      create: {
        tool: item.tool.trim(),
        lowerTool,
        aliases,
        contactEmail: item.contactEmail.trim().toLowerCase(),
        sourceUrl: item.sourceUrl,
        notes: item.notes,
      },
      update: {
        tool: item.tool.trim(),
        aliases,
        contactEmail: item.contactEmail.trim().toLowerCase(),
        sourceUrl: item.sourceUrl,
        notes: item.notes,
      },
    });

    upserted += 1;
    console.log(`Upserted vendor contact for ${item.tool}`);
  }

  const total = await prisma.vendorContact.count();
  console.log(
    JSON.stringify(
      {
        upserted,
        total,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
