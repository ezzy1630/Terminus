/**
 * @terminus/task-runtime — Transactional Outbox & Inbox Relay.
 *
 * Per SPEC §10, §29:
 * Ensures atomic state transition + event publication without dual-write hazards,
 * plus exactly-once / idempotent command consumption via inbox deduplication.
 */
import type { OutboxMessage, InboxMessage, Rfc3339Timestamp } from "@terminus/domain";
import { nowTimestamp } from "@terminus/domain";
import type { DurableTaskRepository } from "./types.js";

export function sha256Hex(ascii: string): string {
  function rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = "";

  const words: number[] = [];
  const asciiBitLength = ascii.length * 8;

  const hash: number[] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const k: number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f, 0xc67178f2,
  ];

  let padded = ascii + "\x80";
  while ((padded.length % 64) !== 56) {
    padded += "\x00";
  }

  for (let i = 0; i < padded.length; i++) {
    const j = padded.charCodeAt(i);
    const wordIdx = i >> 2;
    words[wordIdx] = (words[wordIdx] ?? 0) | (j << (((3 - i) % 4) * 8));
  }
  words.push((asciiBitLength / maxWord) | 0);
  words.push(asciiBitLength);

  for (let j = 0; j < words.length; j += 16) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) {
      w.push(words[j + i] ?? 0);
    }
    const oldHash = [...hash];

    for (let i = 0; i < 64; i++) {
      let wVal: number;
      if (i < 16) {
        wVal = w[i] ?? 0;
      } else {
        const w15 = w[i - 15] ?? 0;
        const w2 = w[i - 2] ?? 0;
        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        wVal = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
      }
      w[i] = wVal;

      const a = hash[0] ?? 0;
      const b = hash[1] ?? 0;
      const c = hash[2] ?? 0;
      const d = hash[3] ?? 0;
      const e = hash[4] ?? 0;
      const f = hash[5] ?? 0;
      const g = hash[6] ?? 0;
      const h = hash[7] ?? 0;

      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (k[i] ?? 0) + wVal) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      hash[7] = g;
      hash[6] = f;
      hash[5] = e;
      hash[4] = (d + temp1) | 0;
      hash[3] = c;
      hash[2] = b;
      hash[1] = a;
      hash[0] = (temp1 + temp2) | 0;
    }

    for (let i = 0; i < 8; i++) {
      hash[i] = ((hash[i] ?? 0) + (oldHash[i] ?? 0)) | 0;
    }
  }

  for (let i = 0; i < 8; i++) {
    const val = hash[i] ?? 0;
    for (let j = 3; j >= 0; j--) {
      const byte = (val >> (j * 8)) & 255;
      result += (byte < 16 ? "0" : "") + byte.toString(16);
    }
  }
  return result;
}

export class TransactionalOutbox {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly idSource: () => string = () => `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {}

  createMessage(
    aggregateType: string,
    aggregateId: string,
    sequence: number,
    eventType: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string | null,
  ): OutboxMessage {
    return {
      id: this.idSource(),
      aggregateType,
      aggregateId,
      sequence,
      eventType,
      payload,
      idempotencyKey: idempotencyKey ?? null,
      createdAt: this.clock(),
      publishedAt: null,
      delivered: false,
    };
  }

  async dispatchPending(
    publisher: (message: OutboxMessage) => Promise<void>,
  ): Promise<number> {
    const pending = await this.repo.listPendingOutboxMessages();
    let count = 0;
    for (const msg of pending) {
      await publisher(msg);
      await this.repo.markOutboxDelivered(msg.id, this.clock());
      count++;
    }
    return count;
  }
}

export class TransactionalInbox {
  constructor(
    private readonly repo: DurableTaskRepository,
    private readonly idSource: () => string = () => `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly clock: () => Rfc3339Timestamp = () => nowTimestamp(),
  ) {}

  hashPayload(payload: unknown): string {
    return sha256Hex(JSON.stringify(payload));
  }

  async process<TResult>(
    idempotencyKey: string,
    source: string,
    messageType: string,
    payload: unknown,
    handler: () => Promise<TResult>,
  ): Promise<{ duplicate: boolean; result?: TResult; error?: string }> {
    const payloadHash = this.hashPayload(payload);
    const existing = await this.repo.getInboxMessage(idempotencyKey);

    if (existing) {
      if (existing.status === "PROCESSED") {
        return { duplicate: true };
      }
      if (existing.status === "PENDING") {
        throw new Error(`Concurrent execution in progress for idempotency key: ${idempotencyKey}`);
      }
      if (existing.status === "FAILED") {
        throw new Error(`Previous execution failed for idempotency key: ${idempotencyKey}`);
      }
    }

    const now = this.clock();
    const entry: InboxMessage = {
      id: this.idSource(),
      idempotencyKey,
      source,
      messageType,
      payloadHash,
      receivedAt: now,
      processedAt: null,
      status: "PENDING",
    };
    await this.repo.saveInboxMessage(entry);

    try {
      const result = await handler();
      await this.repo.updateInboxMessage({
        ...entry,
        status: "PROCESSED",
        processedAt: this.clock(),
      });
      return { duplicate: false, result };
    } catch (err) {
      await this.repo.updateInboxMessage({
        ...entry,
        status: "FAILED",
        processedAt: this.clock(),
      });
      throw err;
    }
  }
}
