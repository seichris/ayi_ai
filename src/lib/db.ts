import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

export const isPersistenceEnabled = Boolean(process.env.DATABASE_URL);

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = isPersistenceEnabled
  ? global.prisma ?? createPrismaClient()
  : null;

if (isPersistenceEnabled && process.env.NODE_ENV !== "production") {
  global.prisma = prisma ?? undefined;
}
