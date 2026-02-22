-- CreateTable
CREATE TABLE "startup_perks" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "programName" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "additionalNotes" TEXT NOT NULL,
    "applyUrl" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "scrapedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "startup_perks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "startup_perks_slug_key" ON "startup_perks"("slug");

-- CreateIndex
CREATE INDEX "startup_perks_providerName_idx" ON "startup_perks"("providerName");

-- CreateIndex
CREATE INDEX "startup_perks_category_idx" ON "startup_perks"("category");
