import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Clock } from '@hakorem/kernel';
import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Authoriser } from '../modules/iam';
import { type Actor, runWithRequestContext } from '../platform/context/request-context';
import { CLOCK, PG_POOL } from '../platform/platform.module';

/** The user agent every audit event written by the seed carries, so the trail says the seed wrote it. */
export const SEED_USER_AGENT = 'hakorem-seed';

/** The seeded staff the service units act as (src/seed/farm-b3.ts creates them). */
export const SEED_STAFF = {
  owner: 'kwabena.owusu@seed.hakoremfarms.invalid',
  manager: 'akosua.boateng@seed.hakoremfarms.invalid',
  accountant: 'yaw.agyeman@seed.hakoremfarms.invalid',
} as const;

export type SeedStaffMember = keyof typeof SEED_STAFF;

/** The second-factor refusals the Authoriser raises only after it has found a grant that allows the permission. */
const SECOND_FACTOR_CODES: ReadonlySet<string> = new Set(['STEP_UP_REQUIRED', 'TOTP_ENROLMENT_REQUIRED']);

const seedScope = new AsyncLocalStorage<true>();

/**
 * Acting as the seeded staff through the real services (A-085, A-104). Every check runs as in production (the
 * grant, its branch scope, maker and checker kept apart, the idempotency key, the audit trail) except one: the
 * seeded Owner, Manager and Accountant enrol their authenticator at first login, so nobody can type a code while
 * the seed runs, and the step-up that tax, price list and promotion permissions demand is accepted for the seed's
 * own calls. The waiver lives only inside `run` below, only for a call made from inside it, and only after the
 * Authoriser has found the grant; `pnpm db:seed` refuses production three ways before any of this exists.
 */
export class SeedStaff {
  private constructor(
    private readonly app: INestApplicationContext,
    private readonly actors: ReadonlyMap<SeedStaffMember, Actor>,
  ) {}

  static async load(app: INestApplicationContext): Promise<SeedStaff> {
    const pool = app.get<pg.Pool>(PG_POOL);
    const clock = app.get<Clock>(CLOCK);
    const { rows } = await pool.query<{ email: string; principal_id: string; display_name: string }>(
      `SELECT u.email, u.principal_id, p.display_name FROM iam.user_account u JOIN iam.principal p ON p.id = u.principal_id WHERE u.email = ANY($1)`,
      [Object.values(SEED_STAFF)],
    );
    const actors = new Map<SeedStaffMember, Actor>();
    for (const [member, email] of Object.entries(SEED_STAFF) as Array<[SeedStaffMember, string]>) {
      const row = rows.find((candidate) => candidate.email === email);
      if (row === undefined) {
        throw new Error(`the seed needs the seeded ${member} ${email}, which the B3 seed unit creates; run the seed units in order`);
      }
      actors.set(member, { principalId: row.principal_id, kind: 'USER', displayName: row.display_name, realm: 'STAFF', sessionId: null, steppedUpAt: clock.now() });
    }
    return new SeedStaff(app, actors);
  }

  actor(member: SeedStaffMember): Actor {
    return this.actors.get(member)!;
  }

  /** Runs `work` as `member`, in a request context of its own, with the seed's step-up waiver in force. */
  async as<T>(member: SeedStaffMember, work: (actor: Actor) => Promise<T>): Promise<T> {
    const actor = this.actor(member);
    const authoriser = this.app.get(Authoriser);
    const original = authoriser.authorise;
    const seeded = new Set([...this.actors.values()].map((candidate) => candidate.principalId));
    authoriser.authorise = async function seedAuthorise(this: Authoriser, ...args: Parameters<Authoriser['authorise']>) {
      try {
        await original.apply(this, args);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const caller = args[1];
        if (seedScope.getStore() === true && caller !== undefined && seeded.has(caller.principalId) && typeof code === 'string' && SECOND_FACTOR_CODES.has(code)) {
          return;
        }
        throw error;
      }
    };
    try {
      return await seedScope.run(true, () =>
        runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: SEED_USER_AGENT, actor }, () => work(actor)),
      );
    } finally {
      authoriser.authorise = original;
    }
  }
}
