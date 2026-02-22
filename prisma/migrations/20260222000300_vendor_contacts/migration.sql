-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "lowerTool" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "contactEmail" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_contacts_lowerTool_key" ON "vendor_contacts"("lowerTool");

-- CreateIndex
CREATE INDEX "vendor_contacts_tool_idx" ON "vendor_contacts"("tool");
