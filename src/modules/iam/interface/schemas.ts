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

const page = { cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) };
const displayName = z.string().trim().min(1).max(120);
const email = z.email().max(254);
const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

/** The contract's `GrantInput`. */
export const GrantInput = z.strictObject({
  roleId: z.uuid(),
  branchId: z.uuid(),
  locationId: z.uuid().optional(),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  validTo: z.iso.datetime({ offset: true }).optional(),
});

/** `UserCreate`. */
export const UserCreate = z.strictObject({
  displayName,
  email: email.optional(),
  phone: phone.optional(),
  realm: z.enum(['STAFF', 'INVESTOR']),
  grants: z.array(GrantInput).max(20),
});

/** `UserUpdate`. */
export const UserUpdate = z.strictObject({ version: z.number().int().min(1), displayName: displayName.optional(), email: email.optional(), phone: phone.optional() });

/** `GrantCreate`. */
export const GrantCreate = GrantInput.extend({ principalId: z.uuid() });

export const ListUsersQuery = z.object({
  realm: z.enum(['STAFF', 'CUSTOMER', 'INVESTOR']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'LOCKED']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  ...page,
});

export const ListRolesQuery = z.object(page);
export const ListPermissionsQuery = z.object({ module: z.string().regex(/^[a-z]{2,4}$/).optional(), ...page });
export const ListGrantsQuery = z.object({ principalId: z.uuid().optional(), roleId: z.uuid().optional(), branchId: z.uuid().optional(), ...page });
export const IdParam = z.uuid();

const roleCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);
const roleName = z.string().trim().min(1).max(80);
const permissionCode = z.string().regex(/^[a-z]+\.[a-z_]+\.[a-z_.]+$/).max(80);

/** The contract's `RoleLimit`. */
export const RoleLimit = z.strictObject({
  limitKind: z.enum(['PRICE_OVERRIDE_PER_LINE', 'PRICE_OVERRIDE_PER_SHIFT', 'REFUND_WITHOUT_APPROVAL', 'PURCHASE_ORDER_APPROVAL', 'STOCK_ADJUSTMENT_WITHOUT_APPROVAL']),
  amountPesewas: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** `RoleCreate`. */
export const RoleCreate = z.strictObject({
  code: roleCode,
  name: roleName,
  requiresTotp: z.boolean(),
  permissions: z.array(permissionCode).max(500),
  limits: z.array(RoleLimit).max(5).optional(),
});

/** `RoleUpdate`. */
export const RoleUpdate = z.strictObject({
  version: z.number().int().min(1),
  name: roleName.optional(),
  requiresTotp: z.boolean().optional(),
  permissions: z.array(permissionCode).max(500).optional(),
  limits: z.array(RoleLimit).max(5).optional(),
});

const APPROVAL_KINDS = [
  'STOCK_WRITE_OFF', 'STOCK_REVERSAL', 'SALE_VOID', 'PRICE_OVERRIDE', 'QUOTE_BELOW_MARGIN', 'CREDIT_OVERRIDE', 'REFUND', 'RETURN',
  'PRICE_LIST_ACTIVATION', 'PROMOTION_ACTIVATION', 'TAX_SCHEME_ACTIVATION', 'PURCHASE_ORDER', 'SUPPLIER_PAYMENT', 'SUPPLIER_PAYOUT_CHANGE',
  'MANUAL_JOURNAL', 'POSTING_RULE_CHANGE', 'CAPITAL_WITHDRAWAL', 'INVESTOR_DISTRIBUTION', 'DATA_DELETION', 'BAD_DEBT_WRITE_OFF', 'CREDIT_NOTE',
  'PAYMENT_REVERSAL', 'PERIOD_REOPEN', 'MORTALITY_WRITE_OFF',
] as const;

/** listApprovals query. */
export const ListApprovalsQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']).optional(),
  kind: z.enum(APPROVAL_KINDS).optional(),
  decidableByMe: booleanQuery.optional(),
  requestedByMe: booleanQuery.optional(),
  ...page,
});

/** `ApprovalDecision`: the reason is optional on an approval, required on a rejection (`ReasonRequest`). */
export const ApprovalDecision = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() });

/** `CustomerRegistration` (FR-IAM-019). The phone must be a Ghana number; the handler says so with its own code. */
export const CustomerRegistration = z.strictObject({
  name: z.string().trim().min(1).max(120),
  phone,
  email: email.optional(),
  password: z.string().min(1).max(512),
  marketingConsent: z.boolean(),
});

/** `PhoneVerification`. */
export const PhoneVerification = z.strictObject({ challengeToken, code: z.string().regex(/^\d{6}$/) });

/** `PasswordResetRequest` (FR-IAM-020). Any identifier is accepted: a malformed one matches no account, silently. */
export const PasswordResetRequest = z.strictObject({ identifier: z.string().min(3).max(254), realm: z.enum(['STAFF', 'CUSTOMER', 'INVESTOR']) });

/** `PasswordResetConfirm`. */
export const PasswordResetConfirm = z.strictObject({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(512) });
