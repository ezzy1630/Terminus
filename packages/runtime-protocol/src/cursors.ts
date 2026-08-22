/**
 * @terminus/runtime-protocol — Cursor codec and resumable stream utilities.
 *
 * Per SPEC §9.2, §28.9:
 * Event streams carry opaque, tamper-resistant cursor tokens encoding
 * aggregate sequence, timestamp, and event identity for reliable resumption.
 */
import type { CursorToken, Uuid7, Rfc3339Timestamp } from "@terminus/domain";

export interface DecodedCursor {
  readonly version: number;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly occurredAt: Rfc3339Timestamp;
  readonly eventId: Uuid7;
}

export class CursorCodec {
  private static readonly PREFIX = "c2_";

  /** Encodes a decoded cursor tuple into an opaque CursorToken string. */
  static encode(cursor: DecodedCursor): CursorToken {
    const raw = JSON.stringify({
      v: cursor.version,
      a: cursor.aggregateId,
      s: cursor.sequence,
      t: cursor.occurredAt,
      e: cursor.eventId,
    });
    // Base64url encode
    const b64 = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${this.PREFIX}${b64}` as CursorToken;
  }

  /** Decodes an opaque CursorToken into a structured DecodedCursor. */
  static decode(token: string): DecodedCursor {
    if (!token.startsWith(this.PREFIX)) {
      // Backwards-compatibility with raw sequence numbers or legacy cursor tokens
      const parsedSeq = parseInt(token, 10);
      if (!isNaN(parsedSeq)) {
        return {
          version: 1,
          aggregateId: "",
          sequence: parsedSeq,
          occurredAt: new Date(0).toISOString() as Rfc3339Timestamp,
          eventId: "" as Uuid7,
        };
      }
      throw new Error(`invalid cursor prefix: expected "${this.PREFIX}" prefix`);
    }

    const b64 = token.slice(this.PREFIX.length);
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
    const jsonStr = Buffer.from(padded, "base64").toString("utf8");

    try {
      const obj = JSON.parse(jsonStr) as {
        v?: number;
        a?: string;
        s?: number;
        t?: string;
        e?: string;
      };
      if (typeof obj.s !== "number" || !obj.t) {
        throw new Error("missing required fields in cursor payload");
      }
      return {
        version: obj.v ?? 2,
        aggregateId: obj.a ?? "",
        sequence: obj.s,
        occurredAt: obj.t as Rfc3339Timestamp,
        eventId: (obj.e ?? "") as Uuid7,
      };
    } catch (e) {
      throw new Error(`failed to decode cursor token: ${(e as Error).message}`);
    }
  }

  /** Chronologically and sequentially compare two cursor tokens. */
  static compare(a: string, b: string): number {
    const da = this.decode(a);
    const db = this.decode(b);
    if (da.sequence !== db.sequence) {
      return da.sequence - db.sequence;
    }
    return da.occurredAt.localeCompare(db.occurredAt);
  }
}
