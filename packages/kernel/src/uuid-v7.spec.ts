import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { InvalidUuidV7Error } from './kernel-error';
import { createUuidV7Generator, parseUuidV7, uuidV7Timestamp, type RandomBytes } from './uuid-v7';

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = new Date('2027-01-15T08:30:00.123Z');

/** A deterministic source: every call returns the same bytes. */
function constantBytes(value: number): RandomBytes {
  return (length) => new Uint8Array(length).fill(value);
}

describe('UUIDv7 (ADR-0013)', () => {
  describe('generation', () => {
    it('generates a version 7, variant 10 UUID in canonical lower-case form', () => {
      const next = createUuidV7Generator(new ManualClock(START), constantBytes(0x5a));
      expect(next()).toMatch(CANONICAL);
    });

    it('embeds the clock time in milliseconds', () => {
      const next = createUuidV7Generator(new ManualClock(START), constantBytes(0x00));
      expect(uuidV7Timestamp(next()).toISOString()).toBe('2027-01-15T08:30:00.123Z');
    });

    it('orders ids monotonically within one millisecond', () => {
      const next = createUuidV7Generator(new ManualClock(START), constantBytes(0x10));
      const ids = Array.from({ length: 1_000 }, () => next());
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(1_000);
      expect(ids.every((id) => uuidV7Timestamp(id).getTime() === START.getTime())).toBe(true);
    });

    it('orders ids across milliseconds', () => {
      const clock = new ManualClock(START);
      const next = createUuidV7Generator(clock, constantBytes(0xff));
      const first = next();
      clock.advanceBy(1);
      const second = next();
      expect(second > first).toBe(true);
    });

    it('stays monotonic when the clock steps backwards', () => {
      const clock = new ManualClock(START);
      const next = createUuidV7Generator(clock, constantBytes(0x20));
      const first = next();
      clock.advanceBy(-5_000);
      const second = next();
      expect(second > first).toBe(true);
      expect(uuidV7Timestamp(second).getTime()).toBe(START.getTime());
    });

    it('carries into the next millisecond when the counter is exhausted', () => {
      // All-ones random bits leave no room to count; the next id in the same millisecond moves to the next one.
      const next = createUuidV7Generator(new ManualClock(START), constantBytes(0xff));
      const first = next();
      const second = next();
      expect(second > first).toBe(true);
      expect(uuidV7Timestamp(second).getTime()).toBe(START.getTime() + 1);
    });

    it('uses the platform random source by default', () => {
      const next = createUuidV7Generator(new ManualClock(START));
      const a = next();
      const b = next();
      expect(a).toMatch(CANONICAL);
      expect(b > a).toBe(true);
    });
  });

  describe('parsing and the version check', () => {
    it('accepts a version 7 UUID and returns it in lower case', () => {
      const result = parseUuidV7('01945A3B-7C2D-7E8F-9A0B-1C2D3E4F5A6B');
      expect(result).toEqual({ ok: true, value: '01945a3b-7c2d-7e8f-9a0b-1c2d3e4f5a6b' });
    });

    it('refuses a version 4 UUID', () => {
      const result = parseUuidV7('9b2f0c4e-1d3a-4f5b-8c6d-7e8f9a0b1c2d');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidUuidV7Error);
        expect(result.error.code).toBe('INVALID_UUID_V7');
      }
    });

    it('refuses a UUID with the wrong variant', () => {
      expect(parseUuidV7('01945a3b-7c2d-7e8f-ca0b-1c2d3e4f5a6b').ok).toBe(false);
    });

    it('refuses text that is not a UUID', () => {
      for (const bad of ['', 'not-a-uuid', '01945a3b7c2d7e8f9a0b1c2d3e4f5a6b', '01945a3b-7c2d-7e8f-9a0b-1c2d3e4f5a6']) {
        expect(parseUuidV7(bad).ok, bad).toBe(false);
      }
    });

    it('reads the embedded timestamp of a parsed id', () => {
      // 0x01945a3b7c2d = 1,736,680,635,437 ms = 2025-01-12T11:17:15.437Z
      const result = parseUuidV7('01945a3b-7c2d-7e8f-9a0b-1c2d3e4f5a6b');
      expect(result.ok && uuidV7Timestamp(result.value).toISOString()).toBe('2025-01-12T11:17:15.437Z');
    });
  });
});
