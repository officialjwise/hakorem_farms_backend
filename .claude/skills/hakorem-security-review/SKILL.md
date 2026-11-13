---
name: hakorem-security-review
description: "Use when a change touches authentication, login, passwords, sessions, tokens, cookies, CSRF, CORS, TOTP or step-up, authorisation, permissions, roles, grants, approvals and maker-checker, payments, refunds, payment provider calls or webhooks, exports and reports that leave the system, file uploads, downloads or signed URLs, encryption keys or encrypted columns, secrets, logging or audit of personal data, rate limits, database roles, or any new way an insider or outsider could take money, stock or data; and before opening a pull request on any of these or when asked for a security review or threat check. Runs the secure coding checklist item by item, writes the finding into the pull request, and makes sure a new abuse path also reaches the daily exception report. For ordinary endpoint shape use hakorem-endpoint; this skill is added on top of it for sensitive endpoints."
---

# Security review: run the checklist, write the finding, close the loop

Authoritative: `docs/security/SECURE_CODING_STANDARDS.md` (the rules a pull request is checked against, each with a correct and an incorrect example). Design: `docs/security/SECURITY_ARCHITECTURE.md`. Threats and abuse cases: `docs/security/THREAT_MODEL.md`. Data handling: `docs/security/DATA_CLASSIFICATION.md`. Decisions: `docs/adr/0016-authentication.md`, `docs/adr/0017-authorisation-and-maker-checker.md`, `docs/adr/0022-encryption-keys-and-erasure.md`, `docs/adr/0024-database-roles-and-privileges.md`, `docs/adr/0014-idempotency-and-external-references.md`. The realistic adversary is an insider with a valid login; design the review around that first, then the perimeter.

## Procedure

1. **Name the change and its boundary.** Which trust boundary does it cross (public storefront, back office, POS device, driver device, payment webhooks, investor portal, system administration, the database)? Open that boundary's STRIDE table in the threat model.
2. **Open `docs/security/SECURE_CODING_STANDARDS.md` and go through it item by item, in its order.** Do not skim and do not skip an item as "not applicable" without saying why in one line. The groups below are the minimum the review must cover and are a prompt, not a replacement; if the standards document has an item this list lacks, the document wins.
3. **Write the finding into the pull request** (template below), even when nothing is found. A review that exists only in a session is lost.
4. **Close the loop on abuse paths** (below). A change that adds, removes or alters a way to misuse the system is not reviewed until the threat model and the exception report reflect it.
5. **Fix, then re-run the failed items.** Do not mark an item passed on the promise of a later session.

## Minimum checklist groups

- **Identity.** Argon2id and breached-password check; lockout with exponential backoff; identical response and timing for known and unknown accounts (dummy hash); password reset always answers "if the account exists, a message was sent"; TOTP for Owner, Accountant and Manager; step-up within five minutes for distributions, bulk export, role and grant changes, posting rule changes, tax scheme changes; refresh rotation with reuse detection revoking the session.
- **Sessions and browser.** Cookies `__Host-` prefixed, httpOnly, secure, `SameSite=Strict`, realm-specific (`hk_s_*` staff, `hk_c_*` customer, `hk_i_*` investor); `X-CSRF-Token` and an allow-listed `Origin` on cookie-authenticated state changes; CORS allow-list, never a wildcard; CSP without `unsafe-inline`; HSTS with preload.
- **Authorisation.** Deny by default; the handler calls the policy engine (not only the controller); every route and handler declares a permission; object-level ownership on every record reachable; branch and location scope; investor endpoints under `/investor/` only, own data only; maker never equals checker (database constraint) and the approval `payload_hash` still matches.
- **Input.** Schema on every inbound payload; unknown fields rejected; parsed type carried inward; parameterised queries only; any dynamic SQL is a blocker; outbound URLs supplied by users are HTTPS and refused if they resolve to private, loopback or link-local addresses, at save and at send.
- **Money paths.** Payment recorded only from a verified provider callback or confirmed lookup; no endpoint or screen accepts "paid" from a browser or device; amounts re-verified server-side; idempotency key and unique external references; no external call inside a business transaction; reconciliation differences reported, never auto-corrected.
- **Webhooks, in order.** Recorded in `pay.webhook_event` first; signature over the raw body in constant time; timestamp window; unique `(provider, event_id)`; reference matches a payment this system initiated; amount and status confirmed by server-to-server lookup; only then cleared in a transaction with its ledger posting. Failures answer without detail and are logged.
- **Uploads and files.** Size cap before reading the body; type by content sniffing against an allow-list; random storage key outside the web root; scan status `PENDING` until `CLEAN`; images re-encoded; private files only by signed expiring URL, every issue logged to `platform.file_access_log`; public media on a separate origin.
- **Exports.** Export is a permission; bulk export needs step-up; every export recorded in `rpt.report_run` and the audit log with user, parameters and row count; no restricted columns in an export without a permission.
- **Data protection.** Restricted fields in `*_enc` columns with AES-256-GCM, decrypted only in the owning module for a permission and audited; personal data in audit `before`/`after` encrypted with the subject's key; keyed `*_hash` for equality lookup; no card data touches the server; erasure by destroying the subject key, not by editing the audit log.
- **Logging and errors.** No secrets, tokens, one-time codes, key material or payment identifiers in logs, audit, outbox or traces; phone numbers masked to the last three digits; errors carry a correlation id and no stack, query or internal name; no empty catch.
- **Rate limiting.** The endpoint has a named group; login, TOTP, reset, quote form, checkout, payment initiation and integrations fail closed when Redis is down.
- **Database and pipeline.** New table declares its class and grants follow it; `hk_app` gets no DDL; ledger and audit tables reject update, delete, truncate; no secrets in repository, image or workflow; dependency, static analysis, secret and image scans pass with no high-severity finding.
- **Secure defaults.** New permission granted to no role; unpriced product unsellable; unconfirmed payment not recorded as paid; unscanned upload not served; offline tender cash only.

## Pull request finding (paste into the description)

```markdown
### Security review (hakorem-security-review)
Boundary crossed: TB2 back office, TB5 payment webhooks
Standards: SECURE_CODING_STANDARDS.md run item by item. Passed: all except the items below.
Findings:
- [fixed] Refund endpoint checked the permission in the controller only; moved the check into RefundHandler (test: cashier refused).
- [accepted risk, owner informed] Provider lookup timeout leaves payment PENDING, which is the intended safe state.
Abuse cases affected: #12 false return; exception kind REFUND.
Threat model updated: yes, section 4 row 12 (detection column). Daily exception report: REFUND item carries abuse case 12; test added.
Not applicable, with reason: file upload group (no upload in this change).
```

## Abuse paths must reach the daily exception report

Owner instruction, 2026-11-13: every abuse case is covered by two tests, that the control blocks it or makes it visible, and that the attempt, blocked or not, appears on the daily exception report (`GET /exceptions/daily-report`) under an exception kind with enough detail to act on. For any change that creates or alters an abuse path:

1. Find or add the abuse case in `docs/security/THREAT_MODEL.md` section 4 with its control, detection and exception kind (existing kinds include `SALE_VOID`, `PRICE_OVERRIDE`, `UNMATCHED_PAYMENT`, `WEBHOOK_REJECTED`, `STOCK_ADJUSTMENT`, `STOCK_EXCEPTION`, `REFUND`, `BULK_EXPORT`, `AUTHORISATION_FAILURE`, `PERMISSION_CHANGE`).
2. Make the code emit the exception item (projected to `rpt` by event) carrying the abuse case number, the actor, the document and the two conflicting facts.
3. Add a test that performs the abuse attempt and asserts the item appears on the report, plus the test that the control holds. Without both, the case is not covered.
4. Update the residual risk register in the same pull request, and add a runbook if there is a new failure mode (hakorem-runbook).
5. Exception reports go to the owner, not to the approvers (residual risk R1: collusion between maker and checker).

## Correct and incorrect

```ts
// WRONG: trusts the browser, checks only at the controller, leaks account existence, logs a secret
@Post("payments/:id/mark-paid") @Roles("cashier")
async markPaid(@Body() b: { status: string }) {
  logger.info(`mark paid token=${b.token}`);
  return b.status === "paid" ? this.pay.clear(id) : { error: "no such phone number" };
}
```

```ts
// RIGHT: only a verified webhook (or confirmed lookup) clears a payment, inside one transaction
async handleWebhook(raw: Buffer, headers: Headers) {
  const evt = await this.events.record(raw, headers);                  // step 1: always recorded
  this.verifier.signature(raw, headers);                               // constant time, raw body
  this.verifier.timestampWithinWindow(evt);                            // replay window
  await this.events.claimUnique(evt.provider, evt.eventId);            // UNIQUE (provider, event_id)
  const payment = await this.payments.byInitiatedReference(evt.reference);
  const truth = await this.provider.lookup(evt.reference);             // payload amount never trusted
  return this.uow.run({ isolation: "serializable" }, tx => this.payments.clear(tx, payment, truth));
}
```
