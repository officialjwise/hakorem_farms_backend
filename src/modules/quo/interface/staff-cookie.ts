import type { Request } from 'express';

/**
 * The staff realm's access cookie as the contract's `staffSession` scheme names it (`__Host-hk_s_at`, ADR-0016), read
 * from a public call through the quote link only to record whose staff session the browser also held (abuse case 40).
 * It authenticates nothing here: IAM checks it, and a missing, malformed or dead one is simply no staff session.
 */
export const STAFF_ACCESS_COOKIE = '__Host-hk_s_at';

export function staffAccessTokenOf(req: Request): string | undefined {
  for (const part of (req.header('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== STAFF_ACCESS_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    try {
      const decoded = decodeURIComponent(value);
      return decoded.length > 0 && decoded.length <= 4096 ? decoded : undefined;
    } catch {
      // A value the browser mangled is no session: nothing to record.
      return undefined;
    }
  }
  return undefined;
}
