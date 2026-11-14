import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type * as JoseModule from 'jose' with { 'resolution-mode': 'import' };
import type { Realm } from '../../../platform/context/request-context';
import type { AccessTokenClaims, AccessTokens } from '../application/ports';

const ISSUER = 'hakorem-api';
const AUDIENCE = 'hakorem';
const REALMS: ReadonlySet<string> = new Set(['STAFF', 'CUSTOMER', 'INVESTOR']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MILLISECONDS_PER_SECOND = 1_000;

/** jose is an ES module; this build is CommonJS, so it is loaded once with a dynamic import (Node16 keeps it). */
type Jose = typeof JoseModule;
let josePromise: Promise<Jose> | undefined;
function jose(): Promise<Jose> {
  josePromise ??= import('jose');
  return josePromise;
}

/** A key in JWT_SIGNING_KEYS or JWT_PUBLIC_KEYS: PEM, or the base64 of DER (PKCS#8 private, SPKI public). */
function readKey(value: string, kind: 'private' | 'public'): KeyObject {
  const pem = value.includes('-----BEGIN');
  if (kind === 'private') {
    return pem ? createPrivateKey(value) : createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  }
  return pem ? createPublicKey(value) : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
}

export interface JwtKeySettings {
  readonly activeKeyId: string;
  /** JSON map of key id to Ed25519 private key. */
  readonly signingKeys: string;
  /** JSON map of key id to public key, so a new key is published before it signs (docs/OPERATIONS.md section 4). */
  readonly publicKeys: string | undefined;
  readonly ttlSeconds: number;
}

/**
 * Access tokens as EdDSA JWTs (ADR-0016): principal, session and realm, ten minutes by default, signed with the
 * active key id and verified against every published public key, so keys rotate without logging anyone out.
 * Roles and grants are never in the token; the guard reads the session on every request.
 */
export class JwtAccessTokens implements AccessTokens {
  private readonly signingKey: KeyObject;
  private readonly verifyKeys = new Map<string, KeyObject>();

  constructor(private readonly settings: JwtKeySettings) {
    const signing = JSON.parse(settings.signingKeys) as Record<string, string>;
    const active = signing[settings.activeKeyId];
    if (active === undefined) {
      throw new Error(`JWT_SIGNING_KEYS has no key for JWT_ACTIVE_KEY_ID ${settings.activeKeyId}`);
    }
    this.signingKey = readKey(active, 'private');
    if (this.signingKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('the access token signing key must be Ed25519');
    }
    for (const [id, key] of Object.entries(signing)) {
      this.verifyKeys.set(id, createPublicKey(readKey(key, 'private')));
    }
    for (const [id, key] of Object.entries(settings.publicKeys === undefined ? {} : (JSON.parse(settings.publicKeys) as Record<string, string>))) {
      this.verifyKeys.set(id, readKey(key, 'public'));
    }
  }

  async issue(claims: AccessTokenClaims, now: Date): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now.getTime() / MILLISECONDS_PER_SECOND);
    const expiresAt = issuedAt + this.settings.ttlSeconds;
    const { SignJWT } = await jose();
    const token = await new SignJWT({ sid: claims.sessionId, realm: claims.realm })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: this.settings.activeKeyId })
      .setSubject(claims.principalId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.signingKey);
    return { token, expiresAt: new Date(expiresAt * MILLISECONDS_PER_SECOND) };
  }

  async verify(token: string, now: Date): Promise<(AccessTokenClaims & { expiresAt: Date }) | null> {
    const { jwtVerify } = await jose();
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid === undefined ? undefined : this.verifyKeys.get(header.kid);
          if (key === undefined) {
            throw new Error('unknown key id');
          }
          return key;
        },
        { algorithms: ['EdDSA'], issuer: ISSUER, audience: AUDIENCE, currentDate: now },
      );
      const { sub, sid, realm, exp } = payload as { sub?: unknown; sid?: unknown; realm?: unknown; exp?: unknown };
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof realm !== 'string' || typeof exp !== 'number') {
        return null;
      }
      if (!UUID.test(sub) || !UUID.test(sid) || !REALMS.has(realm)) {
        return null;
      }
      return { principalId: sub, sessionId: sid, realm: realm as Realm, expiresAt: new Date(exp * MILLISECONDS_PER_SECOND) };
    } catch {
      return null;
    }
  }
}
