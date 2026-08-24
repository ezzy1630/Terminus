import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const TAR_TRAILER_BLOCKS = 2;

export interface ArchiveInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface ArchiveEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`tar field is too long (${bytes.length} > ${length}): ${value}`);
  }
  bytes.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid tar numeric field: ${value}`);
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error(`tar numeric field is too large: ${value}`);
  }
  writeText(buffer, offset, length, `${octal.padStart(length - 1, "0")}\0`);
}

function tarHeader(entry: ArchiveInput, sourceDateEpoch: number): Buffer {
  if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
    throw new Error(`unsafe archive path: ${entry.path}`);
  }
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeText(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function paddedLength(length: number): number {
  return Math.ceil(length / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

export function createDeterministicArchive(
  entries: readonly ArchiveInput[],
  sourceDateEpoch: number,
): Uint8Array {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error(`invalid SOURCE_DATE_EPOCH: ${sourceDateEpoch}`);
  }
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    if (paths.has(entry.path)) throw new Error(`duplicate archive path: ${entry.path}`);
    paths.add(entry.path);
    chunks.push(tarHeader(entry, sourceDateEpoch));
    const body = Buffer.alloc(paddedLength(entry.bytes.byteLength));
    Buffer.from(entry.bytes).copy(body);
    chunks.push(body);
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * TAR_TRAILER_BLOCKS));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  // Normalize gzip metadata that otherwise varies by host implementation.
  compressed.fill(0, 4, 8);
  compressed[9] = 0xff;
  return compressed;
}

function readNullTerminatedText(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number, label: string): number {
  const text = readNullTerminatedText(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar ${label}: ${JSON.stringify(text)}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`tar ${label} exceeds safe integer range`);
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function verifyHeaderChecksum(header: Buffer): void {
  const recorded = readOctal(header, 148, 8, "checksum");
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const computed = copy.reduce((sum, byte) => sum + byte, 0);
  if (recorded !== computed) {
    throw new Error(`tar header checksum mismatch: expected ${recorded}, computed ${computed}`);
  }
}

export function readDeterministicArchive(archive: Uint8Array): readonly ArchiveEntry[] {
  const tar = gunzipSync(archive);
  const entries: ArchiveEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) break;
    verifyHeaderChecksum(header);
    const path = readNullTerminatedText(header, 0, 100);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "\0") throw new Error(`unsupported tar entry type ${type} for ${path}`);
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`unsafe archive path: ${path}`);
    }
    if (paths.has(path)) throw new Error(`duplicate archive path: ${path}`);
    paths.add(path);
    const mode = readOctal(header, 100, 8, "mode");
    const size = readOctal(header, 124, 12, "size");
    const bodyOffset = offset + TAR_BLOCK_BYTES;
    const nextOffset = bodyOffset + paddedLength(size);
    if (nextOffset > tar.length) throw new Error(`truncated tar entry: ${path}`);
    entries.push({ path, mode, bytes: tar.subarray(bodyOffset, bodyOffset + size) });
    offset = nextOffset;
  }
  return entries;
}

export async function writeDeterministicArchive(
  path: string,
  entries: readonly ArchiveInput[],
  sourceDateEpoch: number,
): Promise<string> {
  const bytes = createDeterministicArchive(entries, sourceDateEpoch);
  await writeFile(path, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readArchiveFile(path: string): Promise<readonly ArchiveEntry[]> {
  return readDeterministicArchive(await readFile(path));
}
