# ADR-0017: Authorisation in the application layer, and one maker-checker mechanism

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

Amended in B3 (2026-11-14), before acceptance: the shared brief's "domain layer" was a wording error; the check is in the application layer, because `domain/` may import only the kernel (ADR-0035). The decision is unchanged.

## Context

The shared brief requires deny-by-default authorisation checked in the application layer and never only in the controller, object-level ownership checks on every record a user can reach, branch and location scoping, and separation of duties enforced in code: maker and checker cannot be the same user on stock write-offs, refunds, price list activation, manual journals, supplier payments and investor distributions. The threat model's primary adversary is an insider with a valid login.

## Options considered

1. **Role checks on controllers.** Easy, but any second entry point (a job, another module's call, an offline sync) skips the check.
2. **Each module builds its own approval tables.** Works, but ten slightly different maker-checker implementations is ten places to get the "not the same user" rule wrong.
3. **One policy engine called from every application-layer handler, and one approval mechanism shared by all modules.**

## Decision

Option 3. Both live in the IAM module.

**Permissions and roles**

- A permission is a code `<module>.<resource>.<action>`, for example `inv.adjustment.approve`. Permissions are seeded by migration and are a `LOOKUP` table.
- A role is a named set of permissions. The ten roles in the brief are seeded: Owner, Manager, Accountant, Storekeeper, Cashier, Sales, Vet or Farm Hand, Driver, Investor, Customer. Roles are editable; every change is audited and needs step-up authentication.
- `iam.role_grant` gives a principal a role at a branch and optionally one location, with a validity range.

**The check**

Every command and query handler calls the policy engine before doing work:

`authorise(actor, permission, { branch_id, location_id, owner })`

It passes only if all of these hold:

1. the actor has a current grant of a role containing the permission;
2. the grant covers the branch, and the location if the grant names one;
3. the ownership rule for the resource is satisfied.

Ownership rules are declared per resource. Examples: a customer may read only their own orders, addresses and documents; an investor may read only their own capital, share and distributions; a driver may act only on deliveries assigned to them; a cashier may act only within their own open shift.

There is no "allow" default. A handler that does not call the policy engine fails a test: B3 delivers a test that walks every registered handler and route and asserts a declared permission.

Limits that depend on amount (price override, purchase order approval, refund) are role attributes read by the owning module and enforced in its domain code.

**Maker-checker**

- `iam.approval_request` holds: `kind`, `subject_document_id`, `payload_hash`, `amount_pesewas`, `requested_by`, `decided_by`, `decision`, `reason`, and evidence such as a photograph.
- The table has `CHECK (decided_by IS NULL OR decided_by <> requested_by)`. The rule that maker and checker differ is therefore a database constraint.
- `payload_hash` binds the approval to the exact thing approved. If the subject changes after the request, the hash no longer matches and the approval is void.
- `iam.approval_policy` sets, per kind and branch, the threshold above which approval is needed and the permission the approver must hold.
- The owning module registers a handler for its kind. When a request is approved, the mechanism calls the handler in the same transaction, so approval and effect commit together.

Approval kinds in version one: stock write-off (mortality, cull, adjustment, stock-take variance), sale void, price override beyond limit, quote below margin floor, credit limit override, refund, price list activation, promotion activation, purchase order, supplier payment, manual journal, posting rule change, capital withdrawal, investor distribution, data deletion request.

## Consequences

- A permission check cannot be bypassed by reaching a use case another way, because the use case itself makes the check.
- Every approval in the system has the same shape, the same audit trail and the same database-enforced separation of duties.
- Small farms have few staff. If only one person holds an approving role at a branch, approvals queue for them and nobody else can self-approve. The owner must ensure two approvers exist; this is noted in `docs/ASSUMPTIONS.md`.
- Binds: `docs/security/SECURITY_ARCHITECTURE.md`, `docs/data-model/iam.md`, the `hakorem-endpoint` and `hakorem-security-review` skills.

## Verification

- B3: the handler-walk test; a test per seeded role that a forbidden action is refused; a test that an approval by the requester is rejected by the database.
- Every module session: the definition of done requires a test proving the wrong role is refused.
- B13: every abuse case in the threat model as a test.
