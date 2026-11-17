// The dependency audit gate (SEC-034, SECURE_CODING_STANDARDS "Pipeline"): a high or critical advisory blocks the
// merge unless a dated waiver in docs/security/dependency-waivers.json names it, has not expired, and every path the
// advisory reaches us by starts with one of the waiver's allowed paths. A waiver that is expired, malformed or no
// longer matches anything also fails, so it is removed rather than left behind.
//
// Runs in the CI security job with plain Node (no install there), so it imports only node: builtins and uses only
// syntax that type stripping accepts.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface Waiver {
  readonly advisory: string;
  readonly package: string;
  readonly reason: string;
  readonly owner: string;
  readonly approvedBy: string;
  readonly approvedOn: string;
  readonly expires: string;
  readonly allowedPaths: readonly string[];
}

export interface Finding {
  readonly advisory: string;
  readonly package: string;
  readonly severity: string;
  readonly paths: readonly string[];
}

const BLOCKING = new Set(['high', 'critical']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADVISORY = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** Problems with the waiver file itself, whatever the audit says. `today` is YYYY-MM-DD in UTC. */
export function waiverProblems(waivers: readonly Waiver[], today: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const w of waivers) {
    const name = w.advisory || '(no advisory)';
    if (!ADVISORY.test(w.advisory ?? '')) problems.push(`${name}: the advisory is not a GHSA id`);
    if (seen.has(w.advisory)) problems.push(`${name}: waived twice`);
    seen.add(w.advisory);
    for (const field of ['package', 'reason', 'owner', 'approvedBy'] as const) {
      if (typeof w[field] !== 'string' || w[field].trim() === '') problems.push(`${name}: ${field} is missing`);
    }
    if (!DATE.test(w.approvedOn ?? '')) problems.push(`${name}: approvedOn is not a date`);
    if (!DATE.test(w.expires ?? '')) problems.push(`${name}: expires is not a date`);
    else if (w.expires < today) problems.push(`${name}: the waiver expired on ${w.expires}; fix the dependency or renew it with the owner`);
    if (DATE.test(w.approvedOn ?? '') && DATE.test(w.expires ?? '') && w.expires <= w.approvedOn) {
      problems.push(`${name}: expires on or before it was approved`);
    }
    if (!Array.isArray(w.allowedPaths) || w.allowedPaths.length === 0) {
      problems.push(`${name}: no allowed paths; a waiver never covers every path`);
    } else {
      for (const p of w.allowedPaths) {
        if (typeof p !== 'string' || !p.startsWith('.>') || !p.endsWith('>')) {
          problems.push(`${name}: allowed path ${JSON.stringify(p)} must start at the root (".>") and end at a package boundary (">")`);
        }
      }
    }
  }
  return problems;
}

/** Blocking findings no live waiver covers, and waivers that cover nothing. */
export function auditProblems(findings: readonly Finding[], waivers: readonly Waiver[], today: string): string[] {
  const problems: string[] = [];
  const live = new Map(waivers.filter((w) => DATE.test(w.expires ?? '') && w.expires >= today).map((w) => [w.advisory, w]));
  const used = new Set<string>();
  for (const f of findings) {
    if (!BLOCKING.has(f.severity)) continue;
    const w = live.get(f.advisory);
    used.add(f.advisory);
    if (!w) {
      problems.push(`${f.advisory} (${f.package}, ${f.severity}): not waived`);
      continue;
    }
    if (w.package !== f.package) {
      problems.push(`${f.advisory}: the waiver names ${w.package}, the advisory is in ${f.package}`);
      continue;
    }
    const uncovered = f.paths.filter((p) => !w.allowedPaths.some((a) => p.startsWith(a)));
    if (uncovered.length > 0) {
      problems.push(`${f.advisory} (${f.package}): reached by a path the waiver does not allow: ${uncovered.join(', ')}`);
      continue;
    }
  }
  for (const w of live.values()) {
    if (!used.has(w.advisory)) problems.push(`${w.advisory}: waived but no longer found; remove the waiver`);
  }
  return problems;
}

interface PnpmAudit {
  readonly advisories?: Record<
    string,
    { github_advisory_id: string; module_name: string; severity: string; findings: { paths: string[] }[] }
  >;
}

/** The findings in `pnpm audit --json` output. */
export function findingsOf(audit: PnpmAudit): Finding[] {
  return Object.values(audit.advisories ?? {}).map((a) => ({
    advisory: a.github_advisory_id,
    package: a.module_name,
    severity: a.severity,
    paths: a.findings.flatMap((x) => x.paths),
  }));
}

function runAudit(): PnpmAudit {
  try {
    return JSON.parse(execFileSync('pnpm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as PnpmAudit;
  } catch (error) {
    // pnpm audit exits non-zero when it finds anything; its JSON is still on stdout.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) return JSON.parse(stdout) as PnpmAudit;
    throw error;
  }
}

function main(): void {
  // AUDIT_WAIVERS_FILE lets CI's self-test feed an expired copy and prove the gate then fails.
  const file = process.env.AUDIT_WAIVERS_FILE ?? 'docs/security/dependency-waivers.json';
  const waivers = JSON.parse(readFileSync(file, 'utf8')).waivers as Waiver[];
  const today = new Date().toISOString().slice(0, 10);
  const findings = findingsOf(runAudit());
  const problems = [...waiverProblems(waivers, today), ...auditProblems(findings, waivers, today)];
  for (const f of findings.filter((x) => BLOCKING.has(x.severity) && waivers.some((w) => w.advisory === x.advisory && w.expires >= today))) {
    const w = waivers.find((x) => x.advisory === f.advisory);
    process.stdout.write(`waived until ${w?.expires}: ${f.advisory} (${f.package}, ${f.severity}) via ${f.paths.join(', ')}\n`);
  }
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.exit(1);
  }
  process.stdout.write('dependency audit: no high or critical advisory outside a live waiver\n');
}

if (process.argv[1]?.endsWith('audit-waivers.ts')) main();
