import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditProblems, findingsOf, type Finding, type Waiver, waiverProblems } from './audit-waivers';

const waiver: Waiver = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  reason: 'no patched release; lint tooling only',
  owner: 'Owner',
  approvedBy: 'Owner',
  approvedOn: '2026-11-17',
  expires: '2026-12-17',
  allowedPaths: ['.>eslint-plugin-boundaries>', '.>eslint-import-resolver-typescript>'],
};

const devFinding: Finding = {
  advisory: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  severity: 'high',
  paths: ['.>eslint-plugin-boundaries>micromatch>picomatch', '.>eslint-import-resolver-typescript>tinyglobby>picomatch'],
};

describe('the dependency audit gate (SEC-034) and its waivers', () => {
  it('passes a high advisory a live waiver covers on every path', () => {
    expect(waiverProblems([waiver], '2026-11-17')).toEqual([]);
    expect(auditProblems([devFinding], [waiver], '2026-11-17')).toEqual([]);
    expect(auditProblems([devFinding], [waiver], '2026-12-17')).toEqual([]);
  });

  it('blocks a high or critical advisory with no waiver, and lets moderate and low through', () => {
    const other: Finding = { advisory: 'GHSA-2222-3333-4444', package: 'lodash', severity: 'critical', paths: ['.>lodash'] };
    const moderate: Finding = { ...other, advisory: 'GHSA-5555-6666-7777', severity: 'moderate' };
    expect(auditProblems([other, moderate], [], '2026-11-17')).toEqual(['GHSA-2222-3333-4444 (lodash, critical): not waived']);
  });

  it('blocks the waived advisory once it reaches us through a path the waiver does not allow (a production dependency)', () => {
    const viaProduction: Finding = { ...devFinding, paths: [...devFinding.paths, '.>@nestjs/core>picomatch'] };
    expect(auditProblems([viaProduction], [waiver], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf (picomatch): reached by a path the waiver does not allow: .>@nestjs/core>picomatch',
    ]);
  });

  it('does not let an allowed path match a package whose name merely starts the same', () => {
    const lookalike: Finding = { ...devFinding, paths: ['.>eslint-plugin-boundaries-evil>picomatch'] };
    expect(auditProblems([lookalike], [waiver], '2026-11-17')).toHaveLength(1);
  });

  it('blocks once the waiver has expired, and reports the expiry itself', () => {
    expect(auditProblems([devFinding], [waiver], '2026-12-18')).toEqual([
      'GHSA-fc5q-39xc-vjpf (picomatch, high): not waived',
    ]);
    expect(waiverProblems([waiver], '2026-12-18')).toEqual([
      'GHSA-fc5q-39xc-vjpf: the waiver expired on 2026-12-17; fix the dependency or renew it with the owner',
    ]);
  });

  it('fails a waiver that no longer matches anything, so it is removed', () => {
    expect(auditProblems([], [waiver], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf: waived but no longer found; remove the waiver',
    ]);
  });

  it('refuses a waiver for another package than the advisory', () => {
    expect(auditProblems([devFinding], [{ ...waiver, package: 'micromatch' }], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf: the waiver names micromatch, the advisory is in picomatch',
    ]);
  });

  it('refuses a malformed waiver: no paths, an open-ended path, no owner, a bad id, no expiry, waived twice', () => {
    expect(waiverProblems([{ ...waiver, allowedPaths: [] }], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf: no allowed paths; a waiver never covers every path',
    ]);
    expect(waiverProblems([{ ...waiver, allowedPaths: ['.>eslint'] }], '2026-11-17')).toHaveLength(1);
    expect(waiverProblems([{ ...waiver, owner: ' ' }], '2026-11-17')).toEqual(['GHSA-fc5q-39xc-vjpf: owner is missing']);
    expect(waiverProblems([{ ...waiver, advisory: 'CVE-2026-1' }], '2026-11-17')).toEqual([
      'CVE-2026-1: the advisory is not a GHSA id',
    ]);
    expect(waiverProblems([{ ...waiver, expires: 'never' }], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf: expires is not a date',
    ]);
    expect(waiverProblems([{ ...waiver, expires: '2026-11-17' }], '2026-11-17')).toEqual([
      'GHSA-fc5q-39xc-vjpf: expires on or before it was approved',
    ]);
    expect(waiverProblems([waiver, waiver], '2026-11-17')).toEqual(['GHSA-fc5q-39xc-vjpf: waived twice']);
  });

  it('reads pnpm audit --json output', () => {
    const audit = {
      advisories: {
        '1': {
          github_advisory_id: 'GHSA-fc5q-39xc-vjpf',
          module_name: 'picomatch',
          severity: 'high',
          findings: [{ paths: ['.>a>picomatch'] }, { paths: ['.>b>picomatch'] }],
        },
      },
    };
    expect(findingsOf(audit)).toEqual([
      { advisory: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', severity: 'high', paths: ['.>a>picomatch', '.>b>picomatch'] },
    ]);
    expect(findingsOf({})).toEqual([]);
  });

  it('keeps every committed waiver well formed on the day it was approved', () => {
    const file = JSON.parse(readFileSync('docs/security/dependency-waivers.json', 'utf8')) as { waivers: Waiver[] };
    for (const w of file.waivers) expect(waiverProblems([w], w.approvedOn)).toEqual([]);
  });
});
