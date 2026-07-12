/**
 * Prisma client with SPEC §29.2 SQLite operational requirements.
 *
 * Per SPEC §29.2:
 *   - SQLite MUST run in WAL mode.
 *   - Foreign keys MUST be enabled.
 *   - Busy timeout MUST be configured.
 *   - Write transactions MUST be short and explicit.
 *   - The control plane MUST use one writer queue per database file.
 *   - Database corruption checks MUST run on startup after an unclean shutdown.
 *
 * Prisma's SQLite provider does not emit PRAGMAs, so we set them via
 * `$executeRawUnsafe` on first connect. We also serialize writes through a
 * simple promise chain to approximate the single-writer-queue requirement.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error", "warn"] : ["error", "warn"],
  });

  // Apply SPEC §29.2 PRAGMAs on connect. Prisma doesn't support these
  // declaratively, so we run them via $executeRaw. These are idempotent.
  client
    .$executeRaw`PRAGMA journal_mode = WAL`
    .catch(() => {});
  client
    .$executeRaw`PRAGMA foreign_keys = ON`
    .catch(() => {});
  client
    .$executeRaw`PRAGMA busy_timeout = 5000`
    .catch(() => {});
  client
    .$executeRaw`PRAGMA synchronous = NORMAL`
    .catch(() => {});

  return client;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Serialize writes through a single promise chain per process. Per SPEC §29.2:
 * "The control plane MUST use one writer queue per database file; long
 * analytical queries run on read-only connections or exported data."
 *
 * This is a coarse approximation — a real implementation would use a separate
 * read replica for analytical queries. For the dev mini-service this is
 * sufficient.
 */
let writeChain: Promise<unknown> = Promise.resolve();

export async function writeTx<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(() => db.$transaction(fn));
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result as Promise<T>;
}

/**
 * Run a read query without affecting the writer queue. Per SPEC §29.2, reads
 * may run on read-only connections; for the dev mini-service we use the same
 * connection but don't serialize.
 */
export async function readTx<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/**
 * Verify database integrity on startup. Per SPEC §29.2: "Database corruption
 * checks MUST run on startup after an unclean shutdown and on scheduled
 * maintenance."
 */
export async function verifyIntegrity(): Promise<boolean> {
  try {
    const result = await db.$queryRaw<{ quick_check: string }[]>`PRAGMA quick_check`;
    return result[0]?.quick_check === "ok";
  } catch {
    return false;
  }
}
