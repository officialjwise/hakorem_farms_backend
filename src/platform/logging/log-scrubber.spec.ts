import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED, scrub, scrubString } from './log-scrubber';
import { createLogger } from './logger';

describe('log scrubbing (SC-08, ENGINEERING_STANDARDS section 4)', () => {
  it('keeps only the last three digits of a phone number in E.164 or national form', () => {
    expect(scrubString('sms sent to +233244123456')).toBe('sms sent to ***456');
    expect(scrubString('called 024 412 3456 twice')).toBe('called ***456 twice');
    expect(scrubString('callback 0244-123-456')).toBe('callback ***456');
  });

  it('leaves amounts, tags and ids alone', () => {
    expect(scrubString('goat G-0142 at 25000 pesewas, order 019a7b1d-3b44-79c8-8f00-a553bc391e31')).toBe(
      'goat G-0142 at 25000 pesewas, order 019a7b1d-3b44-79c8-8f00-a553bc391e31',
    );
  });

  it('redacts secrets by key name at any depth', () => {
    expect(
      scrub({
        password: 'hunter2',
        headers: { authorization: 'Bearer abc', cookie: '__Host-hk_s_at=xyz' },
        apiKey: 'k',
        refreshToken: 't',
        otp: '123456',
        nested: [{ webhookSecret: 's', amountPesewas: 25000 }],
      }),
    ).toEqual({
      password: REDACTED,
      headers: { authorization: REDACTED, cookie: REDACTED },
      apiKey: REDACTED,
      refreshToken: REDACTED,
      otp: REDACTED,
      nested: [{ webhookSecret: REDACTED, amountPesewas: 25000 }],
    });
  });

  it('scrubs the message and stack of an error object', () => {
    const scrubbed = scrub(new Error('could not reach +233244123456')) as { type: string; message: string; stack: string };
    expect(scrubbed.type).toBe('Error');
    expect(scrubbed.message).toBe('could not reach ***456');
    expect(scrubbed.stack).not.toContain('244123456');
  });

  it('stops descending at a fixed depth instead of looping on a deep object', () => {
    let deep: Record<string, unknown> = { password: 'bottom' };
    for (let i = 0; i < 20; i += 1) {
      deep = { child: deep };
    }
    expect(() => scrub(deep)).not.toThrow();
  });

  it('passes numbers, booleans and null through', () => {
    expect(scrub(25000)).toBe(25000);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBeNull();
  });

  it('applies to every line the shared logger writes, fields and message alike', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = createLogger({ level: 'info', service: 'test', version: '0.0.0' }, sink);
    logger.info({ phone: '+233244123456', token: 'abc.def.ghi', orderId: 'O-1' }, 'receipt sent to +233201234567');
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ phone: '***456', token: REDACTED, orderId: 'O-1', msg: 'receipt sent to ***567', level: 'info' });
    expect(lines[0]).not.toMatch(/244123456|201234567|abc\.def/);
  });
});
