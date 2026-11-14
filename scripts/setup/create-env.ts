import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Creates .env from .env.example, replacing every marker with a value generated on this machine. One value per
 * marker name, so a password and the URLs that carry it agree:
 *
 * - `__SECRET_<NAME>__`: 24 random bytes as hex (passwords).
 * - `__KEY32_<NAME>__`: 32 random bytes as base64 (encryption and hashing keys, ADR-0022).
 * - `__ED25519_<NAME>__`: a new Ed25519 private key, base64 of PKCS#8 DER (token and anchor signing keys).
 *
 * An existing .env is never overwritten: keys it lacks are appended with fresh values, and nothing else changes.
 */
const MARKER = /__(SECRET|KEY32|ED25519)_([A-Z0-9_]+?)__/g;
const SECRET_BYTES = 24;
const KEY_BYTES = 32;

const values = new Map<string, string>();
function generate(kind: string, name: string): string {
  const id = `${kind}:${name}`;
  let value = values.get(id);
  if (value === undefined) {
    if (kind === 'SECRET') {
      value = randomBytes(SECRET_BYTES).toString('hex');
    } else if (kind === 'KEY32') {
      value = randomBytes(KEY_BYTES).toString('base64');
    } else {
      value = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    }
    values.set(id, value);
  }
  return value;
}

/** Secrets already in .env, by marker, so an appended line reuses them: `S3_ANCHOR_*` and `S3_*` agree. */
function learnExisting(template: string, existing: string): void {
  const current = new Map(existing.split('\n').map((line) => [line.split('=')[0]!, line.slice(line.indexOf('=') + 1)] as const));
  for (const line of template.split('\n')) {
    const key = line.split('=')[0]!;
    const value = current.get(key);
    const markers = [...line.matchAll(MARKER)];
    if (value === undefined || markers.length !== 1) {
      continue;
    }
    const [marker] = markers;
    const prefix = line.slice(key.length + 1, marker!.index);
    const suffix = line.slice(marker!.index! + marker![0].length);
    if (value.startsWith(prefix) && value.endsWith(suffix)) {
      values.set(`${marker![1]}:${marker![2]}`, value.slice(prefix.length, value.length - suffix.length));
    }
  }
}

const target = resolve(process.cwd(), '.env');
const template = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
const fill = (text: string) => text.replace(MARKER, (_, kind: string, name: string) => generate(kind, name));

if (!existsSync(target)) {
  writeFileSync(target, fill(template), { mode: 0o600 });
  process.stdout.write(`create-env: wrote .env with ${values.size} generated development secrets\n`);
} else {
  const existing = readFileSync(target, 'utf8');
  learnExisting(template, existing);
  const present = new Set(existing.split('\n').map((line) => line.split('=')[0]));
  const missing = template.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line) && !present.has(line.split('=')[0]));
  if (missing.length === 0) {
    process.stdout.write('create-env: .env already has every key; left unchanged\n');
  } else {
    appendFileSync(target, `${existing.endsWith('\n') ? '' : '\n'}# Added by pnpm run setup\n${missing.map(fill).join('\n')}\n`);
    process.stdout.write(`create-env: added ${missing.length} new keys to .env (${missing.map((line) => line.split('=')[0]).join(', ')}); existing values unchanged\n`);
  }
}
