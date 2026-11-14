import type { Clock } from './clock';
import { InvalidUuidV7Error } from './kernel-error';
import { err, ok, type Result } from './result';

/** A version 7 UUID in canonical lower-case form (RFC 9562). */
export type UuidV7 = string & { readonly __brand: 'UuidV7' };

/** Fills a fresh array of `length` random bytes. */
export type RandomBytes = (length: number) => Uint8Array;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** rand_a (12 bits) and rand_b (62 bits) together, used as one counter for ordering within a millisecond. */
const COUNTER_MAX = (1n << 74n) - 1n;
const RAND_B_BITS = 62n;
const RAND_B_MASK = (1n << RAND_B_BITS) - 1n;
const VERSION_7 = 7n;
const VARIANT_RFC = 2n;
const RANDOM_BYTES = 10;
const HEX_DIGITS = 32;

const platformRandomBytes: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

function randomCounter(random: RandomBytes): bigint {
  let value = 0n;
  for (const byte of random(RANDOM_BYTES)) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & COUNTER_MAX;
}

function format(milliseconds: bigint, counter: bigint): UuidV7 {
  const value =
    (milliseconds << 80n) |
    (VERSION_7 << 76n) |
    ((counter >> RAND_B_BITS) << 64n) |
    (VARIANT_RFC << RAND_B_BITS) |
    (counter & RAND_B_MASK);
  const hex = value.toString(16).padStart(HEX_DIGITS, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UuidV7;
}

/**
 * Creates a UUIDv7 generator (ADR-0013). Ids from one generator are strictly increasing: within one
 * millisecond the 74 random bits count upwards; when they are exhausted, or the clock steps backwards,
 * the generator keeps to its last millisecond and moves forward from there rather than going back.
 */
export function createUuidV7Generator(clock: Clock, random: RandomBytes = platformRandomBytes): () => UuidV7 {
  let lastMilliseconds = -1n;
  let counter = 0n;
  return () => {
    const now = BigInt(clock.now().getTime());
    if (now > lastMilliseconds) {
      lastMilliseconds = now;
      counter = randomCounter(random);
    } else if (counter < COUNTER_MAX) {
      counter += 1n;
    } else {
      lastMilliseconds += 1n;
      counter = randomCounter(random);
    }
    return format(lastMilliseconds, counter);
  };
}

/** Checks that text is a version 7 UUID with the RFC variant, and returns it in lower case. */
export function parseUuidV7(text: string): Result<UuidV7, InvalidUuidV7Error> {
  return UUID_V7_PATTERN.test(text) ? ok(text.toLowerCase() as UuidV7) : err(new InvalidUuidV7Error());
}

/** The creation time embedded in a UUIDv7. Never business time: that is `occurred_at` (ADR-0013). */
export function uuidV7Timestamp(id: UuidV7): Date {
  return new Date(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16));
}
