import type { CookieOptions, Request, Response } from 'express';
import type { Realm } from '../../../platform/context/request-context';
import type { IssuedSession } from '../application/session-view';

const REALM_LETTER: Readonly<Record<Realm, string>> = { STAFF: 's', CUSTOMER: 'c', INVESTOR: 'i' };
export const REALMS: readonly Realm[] = ['STAFF', 'CUSTOMER', 'INVESTOR'];

/** `__Host-hk_s_at` and so on (ADR-0016, contract securitySchemes): the realm is in the name. */
export function accessCookieName(realm: Realm): string {
  return `__Host-hk_${REALM_LETTER[realm]}_at`;
}

export function refreshCookieName(realm: Realm): string {
  return `__Host-hk_${REALM_LETTER[realm]}_rt`;
}

/**
 * HttpOnly, Secure, SameSite=Strict, Path=/, no Domain: with the `__Host-` prefix the browser binds the cookie to the
 * API host and never sends it to another one (docs/API.md section 3). Browsers accept Secure cookies from
 * http://localhost, so local development works unchanged.
 */
function attributes(expiresAt: Date, now: Date): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: Math.max(0, expiresAt.getTime() - now.getTime()) };
}

export function setSessionCookies(res: Response, issued: IssuedSession, now: Date): void {
  res.cookie(accessCookieName(issued.realm), issued.accessToken, attributes(issued.accessExpiresAt, now));
  res.cookie(refreshCookieName(issued.realm), issued.refreshToken, attributes(issued.refreshExpiresAt, now));
}

export function clearSessionCookies(res: Response, realm: Realm): void {
  const cleared: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
  res.clearCookie(accessCookieName(realm), cleared);
  res.clearCookie(refreshCookieName(realm), cleared);
}

/** The request's cookies by name. Values the browser percent-encoded are decoded; a malformed one is skipped. */
export function readCookies(req: Request): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (req.header('Cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      continue;
    }
  }
  return cookies;
}
