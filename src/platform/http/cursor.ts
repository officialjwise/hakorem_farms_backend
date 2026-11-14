import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@hakorem/kernel';
import { canonicalJson } from '../crypto/canonical-json';
import { ValidationFailedError } from '../errors/api-error';
import { translate } from '../i18n/messages';

/** A cursor is valid this long (docs/API.md section 5). */
const CURSOR_LIFETIME_MS = 24 * 3_600_000;

interface CursorBody {
  /** The operation and caller it was issued to, and a hash of the filters: a cursor cannot be reused elsewhere. */
  readonly b: string;
  /** Where the next page starts, opaque to the client. */
  readonly p: Record<string, string>;
  /** Expiry, milliseconds since the epoch. */
  readonly e: number;
}

function invalid(): ValidationFailedError {
  return new ValidationFailedError('cursor is invalid', [{ field: '/cursor', code: 'INVALID_CURSOR', message: translate('error.field_invalid') }]);
}

/**
 * Opaque cursors for cursor pagination (docs/API.md section 5): signed so a client cannot forge a position, bound to
 * the operation, the caller and the filters, and expired after 24 hours. A bad cursor is 400 VALIDATION_FAILED.
 */
export class Cursors {
  private readonly key: Buffer;

  constructor(
    lookupKey: Buffer,
    private readonly clock: Clock,
  ) {
    this.key = createHmac('sha256', lookupKey).update('hk-cursor-v1').digest();
  }

  encode(binding: { operationId: string; principalId: string; filters: unknown }, position: Record<string, string>): string {
    const body: CursorBody = { b: this.bindingOf(binding), p: position, e: this.clock.now().getTime() + CURSOR_LIFETIME_MS };
    const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(cursor: string, binding: { operationId: string; principalId: string; filters: unknown }): Record<string, string> {
    const [payload, signature, extra] = cursor.split('.');
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw invalid();
    }
    const expected = Buffer.from(this.sign(payload), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw invalid();
    }
    let body: CursorBody;
    try {
      body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CursorBody;
    } catch {
      throw invalid();
    }
    if (body.b !== this.bindingOf(binding) || body.e <= this.clock.now().getTime()) {
      throw invalid();
    }
    return body.p;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  private bindingOf(binding: { operationId: string; principalId: string; filters: unknown }): string {
    return createHmac('sha256', this.key).update(canonicalJson(binding)).digest('base64url').slice(0, 22);
  }
}
