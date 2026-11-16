# ADR-0055: Guest storefront writes act as a Storefront principal and are proved by a cart token

- **Status:** Proposed (B07 continued 2; registered checkout and customer carts arrive with B09a, which may extend it)
- **Date:** 2026-11-15
- **Session:** B07 continued 2
- **Deciders:** backend track; owner reviews with A-177

## Context

The storefront's carts and checkout are used by guests with no account (FR-SHP-003, FR-SHP-010). Yet every write in this system names an actor: idempotency keys are scoped to a principal, audit rows and outbox events need one, and INV's reservations and the document registry record who acted. The guard (ADR-0016, ADR-0017) binds an actor only for a session, and the planned contract listed `customerSession` on the cart operations, while no customer account is linked to a customer record yet.

## Options considered

1. **Run each guest write inside `runAsSystem`.** It starts a new context with a new correlation id, so the request's trace and its audit rows would disagree.
2. **A public route declares the SYSTEM principal it acts as; the guard binds it; the handler proves the cart is the caller's by a token.**
3. **Make guests create a throwaway account.** Friction at checkout on a slow phone, and personal data the shop does not need.

## Decision

Option 2.

- `OperationSpec.publicActor` names a SYSTEM principal for a public route. The guard binds it as the request's actor after the rate limit and the Origin check. It grants nothing: such a route has no permission (`@Operation` refuses one), and the handler decides who may reach what.
- The Storefront principal (`01900000-0000-7000-8000-000000000006`, migration 0115) has no credentials and no grants.
- A guest cart is proved by a random 32-byte token in the host-only cookie `__Host-hk_guest` (httpOnly, Secure, SameSite=Strict), stored only as an HMAC under a key derived from the lookup key. A missing or wrong token answers 404, the same as no cart (no enumeration). Every cart and checkout write binds its idempotency request to the token's hash, so a key replayed without the cookie is refused.
- Cart writes require an allowed `Origin` and an Idempotency-Key; checkout writes are in the `checkout` rate-limit group (30 per address per 10 minutes, fail closed).
- The cart operations publish `security: [{}]` until B09a links customer accounts; they no longer list `customerSession` or the optional CSRF header, which a guest never has.

## Consequences

- Audit rows of guest actions name the Storefront principal and carry no personal data (the guest has no subject key, ADR-0022); the contact and address live only in the checkout row.
- A guest who loses the cookie loses the cart; a replayed `createCart` answers the cart without a new cookie.
- B09a adds customer sessions to these operations (an additive contract change) and adopts a guest cart at sign-in.
- Binds: `src/platform/http/operation.ts`, `src/modules/iam/interface/authentication.guard.ts`, `src/modules/shp`, `docs/security/THREAT_MODEL.md` (TB1).

## Verification

- `test/integration/shp/storefront-checkout.integration.spec.ts`: another guest's token and no token are 404; a forged Origin is 403; a replayed checkout answers the same checkout.
