import { isIP } from 'node:net';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { StaffSessionSeen, StaffSessionsSeen } from '../application/staff-sessions-seen';

export class PgStaffSessionsSeen implements StaffSessionsSeen {
  async fromAddressIn(tx: Transaction, ip: string, window: { readonly from: Date; readonly until: Date }): Promise<readonly StaffSessionSeen[]> {
    // An address that is not one cannot match a recorded inet, and is never cast.
    if (isIP(ip) === 0) return [];
    const { rows } = await tx.query<{ principal_id: string; id: string; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
      `SELECT s.principal_id, s.id, s.user_agent, s.created_at, s.last_seen_at
         FROM iam.session s
        WHERE s.realm = 'STAFF' AND s.ip_created = $1::inet AND s.last_seen_at >= $2 AND s.created_at <= $3
        ORDER BY s.principal_id, s.id`,
      [ip, window.from, window.until],
    );
    return rows.map((r) => ({ principalId: r.principal_id, sessionId: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }
}
