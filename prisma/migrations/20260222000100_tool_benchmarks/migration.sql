-- CreateTable
CREATE TABLE "tool_benchmarks" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "lowerTool" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "plans" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "marketAnnualPerSeatMinUsd" INTEGER NOT NULL,
    "marketAnnualPerSeatMaxUsd" INTEGER NOT NULL,
    "typicalDiscountMinPct" INTEGER NOT NULL,
    "typicalDiscountMaxPct" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto_discovered',
    "confidence" TEXT,
    "assumptions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_benchmarks_lowerTool_key" ON "tool_benchmarks"("lowerTool");

-- CreateIndex
CREATE INDEX "tool_benchmarks_tool_idx" ON "tool_benchmarks"("tool");
