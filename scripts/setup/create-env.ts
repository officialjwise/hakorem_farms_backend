import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Creates .env from .env.example with a fresh random value for every __SECRET_<NAME>__ marker; one value per
 * name, so a password and the URLs that carry it agree. Never overwrites an existing .env.
 */
const SECRET_BYTES = 24;
const MARKER = /__SECRET_([A-Z0-9_]+?)__/g;

const target = resolve(process.cwd(), '.env');
if (existsSync(target)) {
  process.stdout.write('create-env: .env already exists; left unchanged\n');
  process.exit(0);
}
const template = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
const secrets = new Map<string, string>();
const filled = template.replace(MARKER, (_, name: string) => {
  let value = secrets.get(name);
  if (value === undefined) {
    value = randomBytes(SECRET_BYTES).toString('hex');
    secrets.set(name, value);
  }
  return value;
});
writeFileSync(target, filled, { mode: 0o600 });
process.stdout.write(`create-env: wrote .env with ${secrets.size} generated development secrets\n`);
