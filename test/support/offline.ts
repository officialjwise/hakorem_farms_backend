import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import type { TestSession } from './iam';
import { TEST_ORIGIN } from './test-app';

/** A queued sale's line as the till writes it. */
export interface TillLine {
  readonly productId: string;
  readonly stockUnitId?: string;
  readonly quantity: string;
  readonly uom?: string;
  readonly weightKg?: string;
  readonly weightSource?: 'SCALE' | 'MANUAL' | 'ESTIMATE';
  readonly agreedUnitPricePesewas: number;
  readonly varianceReasonCode?: string;
  readonly overrideApproval?: { readonly approvedById: string; readonly approvedByPinVersion: number };
}

export interface TillTender {
  readonly paymentMethodId: string;
  readonly amountPesewas: number;
  readonly tenderedPesewas?: number;
}

/** A queued sale exactly as the till sends it, with its hash. */
export interface TillSale {
  readonly id: string;
  readonly deviceCounter: number;
  readonly provisionalRef: string;
  readonly occurredAt: string;
  readonly lines: readonly TillLine[];
  readonly tenders: readonly TillTender[];
  /** The receipt link's token the till made for the sale (CR-033, ADR-0083), when it has the pack's template. */
  readonly receiptToken?: string;
  /** A business buyer named for the receipt (A-285 (c)). */
  readonly buyer?: { readonly name: string; readonly tin: string };
  /** The number the buyer gave at the till, for the receipt SMS (CR-033 point 3). */
  readonly customerPhone?: string;
  readonly payloadHash: string;
}

/**
 * RFC 8785 canonical JSON as the till computes it (OFFLINE_SYNC 4.4), written here on its own so the test never
 * borrows the server's code: keys sorted by UTF-16 code unit at every level, no whitespace; every value in a sale is a
 * string, an integer or an array, which JSON.stringify writes as the scheme does.
 */
export function canonicalForTest(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** SHA-256 of the canonical sale less its hash, 64 lowercase hex characters. */
export function tillHash(sale: Omit<TillSale, 'payloadHash'>): string {
  return createHash('sha256').update(canonicalForTest(sale), 'utf8').digest('hex');
}

/**
 * A sale the till makes with no network: its id a UUIDv7 stamped at the till's time, its provisional reference
 * `P-<till>-<shift seq>-<counter>`, its hash over everything else. Nothing is sent.
 */
export function tillSale(f: { readonly till: string; readonly shiftSeq: number; readonly counter: number; readonly at: Date; readonly lines: readonly TillLine[]; readonly tenders: readonly TillTender[]; readonly id?: string; readonly provisionalRef?: string; readonly receiptToken?: string; readonly buyer?: { readonly name: string; readonly tin: string }; readonly customerPhone?: string }): TillSale {
  const id = f.id ?? createUuidV7Generator(new ManualClock(f.at))();
  const content = {
    id,
    deviceCounter: f.counter,
    provisionalRef: f.provisionalRef ?? `P-${f.till}-${f.shiftSeq}-${String(f.counter).padStart(4, '0')}`,
    occurredAt: f.at.toISOString(),
    lines: f.lines,
    tenders: f.tenders,
    ...(f.receiptToken === undefined ? {} : { receiptToken: f.receiptToken }),
    ...(f.buyer === undefined ? {} : { buyer: f.buyer }),
    ...(f.customerPhone === undefined ? {} : { customerPhone: f.customerPhone }),
  };
  return { ...content, payloadHash: tillHash(content) };
}

/** `POST /v1/pos/sync` as the till sends it when the network returns: the session, its CSRF token and the device credential, no idempotency key. */
export function syncBatch(server: Server, session: TestSession | null, credential: string | null, body: object) {
  const call = request(server).post('/v1/pos/sync').set('Origin', TEST_ORIGIN);
  if (session !== null) call.set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken);
  if (credential !== null) call.set('X-Device-Credential', credential);
  return call.send(body);
}
