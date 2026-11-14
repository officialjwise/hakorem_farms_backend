import { z } from 'zod';

/** Request schemas for the contract's auth and iam operations. Strict: an unknown field is refused (SC-01). */

const challengeToken = z.string().min(10).max(200);

/** The contract's `LoginRequest`. Lengths are bounded so a request cannot make the server hash megabytes. */
export const LoginRequest = z.strictObject({
  identifier: z.string().min(3).max(254),
  password: z.string().min(1).max(512),
  deviceLabel: z.string().trim().min(1).max(80).optional(),
});

/** `TotpVerifyRequest`. */
export const TotpVerifyRequest = z.strictObject({
  challengeToken,
  code: z.string().min(6).max(20),
});

/** `TotpCodeRequest`, with the challenge for enrolment during login (contract 1.2.0). */
export const TotpCodeRequest = z.strictObject({
  code: z.string().min(6).max(20),
  challengeToken: challengeToken.optional(),
});

/** Step-up takes the code only. */
export const StepUpRequest = z.strictObject({ code: z.string().min(6).max(20) });

/** `TotpEnrolmentStart` (contract 1.2.0): empty with a session, the challenge during login. */
export const TotpEnrolmentStart = z.strictObject({ challengeToken: challengeToken.optional() }).optional();

/** `PasswordChangeRequest`, with the challenge for a temporary password during login (contract 1.2.0). */
export const PasswordChangeRequest = z.strictObject({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
  challengeToken: challengeToken.optional(),
});

/** `ReasonRequest`. */
export const ReasonRequest = z.strictObject({ reason: z.string().trim().min(1).max(500) });

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/** listSessions query. An unknown query parameter is ignored (docs/API.md section 6), so this is not strict. */
export const ListSessionsQuery = z.object({
  principalId: z.uuid().optional(),
  active: booleanQuery.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const SessionIdParam = z.uuid();
