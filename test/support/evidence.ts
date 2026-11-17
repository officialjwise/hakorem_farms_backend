import type { Server } from 'node:http';
import { expect } from 'vitest';
import { consolePost, type TestSession } from './iam';
import type { TestDatabase } from './test-database';

/**
 * A death or cull photograph as a phone's camera takes it (a JPEG, its bytes distinct per `seed`), uploaded as EVIDENCE
 * by `session` and passed by the scanner, as the worker records it: the Farm hand's report always carries one (owner,
 * 2026-11-16), and a write-off posts only once it is CLEAN. Returns the file's id.
 */
export async function cleanEvidence(server: Server, session: TestSession, database: TestDatabase, seed: number): Promise<string> {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`evidence-${seed}`), Buffer.alloc(1_000, seed % 256)]);
  const uploaded = await consolePost(server, session, '/v1/files').field('purpose', 'EVIDENCE').attach('file', bytes, 'carcass.jpg');
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const fileId = uploaded.body.id as string;
  await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [fileId]);
  return fileId;
}
