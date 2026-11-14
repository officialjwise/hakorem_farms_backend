# HaKorem Farms Platform: Secure Coding Standards

The rules a pull request is checked against. Each rule has an id, the document or ADR it comes from, a short correct example and a short incorrect one. A reviewer cites the id in a blocking comment (`SC-14: external call inside the transaction`), and the author fixes the code, not the rule. A rule changes only by an ADR or by an update to the document it cites.

Examples are TypeScript (strict, Node 22, NestJS 11, Drizzle) or SQL (PostgreSQL 17). They show the shape, not the full file. Schema examples use Zod; the rule is "a schema at the boundary", whichever schema library the codebase standardises on. Money examples use the kernel `Money` and `allocate` from `packages/kernel` (ADR-0001).

How the rules are enforced: lint and type check for the ones a tool can see, the handler-walk and boundary tests for authorisation and imports, the scrubbing test for logs, secret and dependency scanning in the pipeline, and review for the rest. `docs/ENGINEERING_STANDARDS.md` section 13 turns them into a review checklist.

| Group | Rules |
| --- | --- |
| Input and access | SC-01 to SC-04 |
| Money and consistency | SC-05 to SC-06, SC-14, SC-22 to SC-24 |
| Secrets, logs and errors | SC-07, SC-08, SC-15, SC-16, SC-18 |
| Web surface | SC-09 to SC-12, SC-19 |
| Payments | SC-13 |
| Approvals | SC-17 |
| Supply chain | SC-20, SC-21 |

---

## SC-01. Validate every inbound payload with a schema at the boundary and carry the typed command inward

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5; `docs/ARCHITECTURE.md` section 5 (request flow); shared brief, security rules.

**Rule.** Every controller, webhook endpoint, job consumer and sync endpoint parses its input once with a strict schema (unknown fields rejected). The parsed, typed command is the only thing a handler receives. A handler never reads `req.body`, `req.query` or `req.headers` itself. Branded types (`Pesewas`, `Uuid`) are produced by the parser, so a string cannot be passed where an amount is expected.

Correct:

```ts
const AdjustStockBody = z.object({
  stockUnitId: z.string().uuid(),
  reasonCode: z.enum(['SHRINKAGE', 'WASTAGE', 'COUNT_CORRECTION']),
  quantity: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/),   // decimal string, ADR-0029
  note: z.string().max(500).optional(),
}).strict();

@Post('stock-adjustments')
create(@Body(new SchemaPipe(AdjustStockBody)) cmd: AdjustStockCommand) {
  return this.handler.execute(cmd);
}
```

Incorrect:

```ts
@Post('stock-adjustments')
create(@Body() body: any) {                 // unvalidated, extra fields pass through
  return this.service.adjust(body.stockUnitId, Number(body.quantity));
}
```

---

## SC-02. Authorise in the handler, deny by default, and check ownership

**Source:** ADR-0017; `docs/security/SECURITY_ARCHITECTURE.md` section 4; `docs/ARCHITECTURE.md` section 5.

**Rule.** Every command and query handler calls the policy engine before it does work, with the permission code `<module>.<resource>.<action>`, the branch, the location where the resource has one, and the owner for resources with an ownership rule. A controller decorator declares the same permission so the handler-walk test can find it, but the decorator never replaces the handler check, because jobs, other modules and offline sync reach the same use case. A handler that does not call the engine fails the handler-walk test. A repository takes the scope as a parameter so a query cannot forget it. An ownership failure is answered as "not found" for customers and investors, and raised as an `AUTHORISATION_FAILURE` exception item.

Correct:

```ts
async execute(cmd: GetOrderQuery, actor: Actor): Promise<CustomerOrder> {
  const order = await this.orders.findById(cmd.orderId, { branchId: actor.branchId });
  if (!order) throw new NotFoundError('ORDER_NOT_FOUND');
  await this.policy.authorise(actor, 'ord.order.read', {
    branchId: order.branchId,
    owner: { kind: 'customer', id: order.customerId },   // customer sees only their own
  });
  return toCustomerShape(order);                         // no cost, floor or variance
}
```

Incorrect:

```ts
@UseGuards(AuthGuard)                         // proves the caller is logged in, nothing else
@Get('orders/:id')
get(@Param('id') id: string) {
  return this.orders.findById(id);            // any logged-in customer can read any order
}
```

---

## SC-03. Parameterised SQL only

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5; shared brief, security rules.

**Rule.** Every value reaches PostgreSQL as a bound parameter, through the Drizzle query builder or the `sql` template tag (which binds interpolated values). No query is assembled by concatenating or interpolating a value into a string.

Correct:

```ts
const rows = await tx.execute(sql`
  SELECT id, status FROM ord.sales_order
  WHERE customer_id = ${customerId} AND branch_id = ${branchId}
  ORDER BY recorded_at DESC LIMIT ${limit}`);

// or the builder
await tx.select().from(salesOrder).where(and(eq(salesOrder.customerId, customerId), eq(salesOrder.branchId, branchId)));
```

Incorrect:

```ts
const rows = await tx.execute(sql.raw(
  `SELECT id FROM ord.sales_order WHERE customer_id = '${customerId}'`));   // injection
```

```sql
-- incorrect, in a function: building the statement from text
EXECUTE 'SELECT * FROM ord.sales_order WHERE customer_id = ''' || p_customer || '''';
-- correct
EXECUTE 'SELECT * FROM ord.sales_order WHERE customer_id = $1' USING p_customer;
```

---

## SC-04. No dynamic SQL

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5 ("Dynamic SQL is a review blocker"); shared brief, security rules; ADR-0024.

**Rule.** A table name, column name, sort direction or operator never comes from a request. Where a caller chooses a sort or a filter, the code maps a closed enumeration to a fixed expression. `sql.raw` and `EXECUTE format(...)` need a named exception in the pull request, approved by the reviewer, and are never fed request data. The application role cannot run DDL in any environment, so a dynamic statement could not create objects, but it can still read what it should not.

Correct:

```ts
const SORTS = {
  created: sql`recorded_at`,
  total: sql`gross_pesewas`,
} as const;
type SortKey = keyof typeof SORTS;                 // validated by SC-01 as z.enum(['created','total'])

const order = SORTS[query.sort];
const rows = await tx.execute(sql`SELECT id FROM ord.sales_order WHERE branch_id = ${branchId} ORDER BY ${order} DESC`);
```

Incorrect:

```ts
const rows = await tx.execute(sql.raw(`SELECT id FROM ord.sales_order ORDER BY ${query.sort}`));
```

---

## SC-05. Money is never a float: integer pesewas, kernel types, decimal library for factors

**Source:** ADR-0001; ADR-0029; `docs/data-model` conventions (`pesewas` domain); shared brief rule 4.

**Rule.** Amounts are integer pesewas held in the kernel `Money` type (a `bigint`). The TypeScript `number` type is not used for money, quantity or weight in any file that imports `Money` (a lint rule fails the build). Percentages and rates are exact decimals parsed from strings with the decimal library, never from `number`. Rounding is half-up, once, at the line anchor. A split of an amount uses `allocate`. JSON money fields end in `Pesewas` and are integers; decimals travel as strings (ADR-0029). Tests assert exact integers.

Correct:

```ts
const net = Money.ofPesewas(127_500n);
const rate = Decimal.parse('2.5');                          // from a string
const nhil = net.mulRateHalfUp(rate);                       // half-up once, returns Money
const [a, b, c] = allocate(Money.ofPesewas(1_000_001n), [90_000n, 22_500n, 30_250n]);
expect(a.pesewas + b.pesewas + c.pesewas).toBe(1_000_001n); // no pesewa created or lost
```

Incorrect:

```ts
const nhil = Math.round(net * 0.025);                       // float, rounds each line independently
const share = total / 3;                                    // 3333.333..., a pesewa vanishes or appears
const price = parseFloat(body.price);                       // floats from the wire
```

```sql
-- incorrect: a float column
ALTER TABLE ord.sales_order_line ADD COLUMN unit_price double precision;
-- correct: the domain, which also enforces sign and size
ALTER TABLE ord.sales_order_line ADD COLUMN unit_price_pesewas platform.pesewas NOT NULL;
```

---

## SC-06. Every state-changing request carries an idempotency key, and the database enforces it

**Source:** ADR-0014; ADR-0013; `docs/ARCHITECTURE.md` section 5; ADR-0029.

**Rule.** A state-changing endpoint requires `Idempotency-Key`. The key is inserted into `platform.idempotency_key` as the first write of the business transaction, unique on (`scope`, `key`), with a hash of the request. The four outcomes are: proceed, return the stored response, reject a different body under the same key with 409, and let a concurrent duplicate wait on the unique key. Records created offline use their client UUIDv7 as the key. Outbound provider calls carry a key derived from the outbox message id. External references (`provider_reference`, webhook `event_id`) are unique columns. A unique violation on one of these is a replay, not a 500.

Correct:

```ts
return this.uow.run({ isolation: 'serializable', seriesLocks: [series] }, async (tx) => {
  const prior = await this.idempotency.begin(tx, { scope: actor.id + ':sale.complete', key, requestHash });
  if (prior.status === 'COMPLETED') return prior.response;       // same request, same answer
  if (prior.status === 'MISMATCH') throw new ConflictError('IDEMPOTENCY_KEY_REUSED');
  const result = await this.completeSale(tx, cmd);
  await this.idempotency.complete(tx, prior.id, result);
  return result;
});
```

Incorrect:

```ts
async completeSale(cmd) {                      // a retry on a weak connection posts the sale twice
  const sale = await this.sales.insert(cmd);
  return sale;
}
```

```sql
-- the constraint that makes the replay collide
ALTER TABLE pay.payment ADD CONSTRAINT uq_payment_provider_reference UNIQUE (provider_reference);
```

---

## SC-07. Secrets are never logged, stored in settings, put in events or committed

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 6 ("Keys and secrets"); ADR-0022; ADR-0010 ("Events never carry secrets"); `docs/security/DATA_CLASSIFICATION.md` section 3.

**Rule.** A secret (password, token, one-time code, API key, cookie, key material, webhook secret, provider key, database password) is read from the environment at start through the typed configuration, held in memory, and never written to a log, span, error message, audit payload, outbox payload, job payload, `platform.setting` row, test fixture or example environment file (key names only). A configuration object that holds secrets overrides `toJSON` and `inspect` so it cannot be serialised by accident. Missing configuration fails boot with the name of the missing key, not its value.

Correct:

```ts
const config = loadConfig(process.env);               // throws "Missing CONFIG key: PAYSTACK_SECRET_KEY"
this.log.info({ provider: 'PAYSTACK', reference: ref, outcome }, 'charge initiated');
```

Incorrect:

```ts
this.log.info({ headers: req.headers, body: req.body }, 'incoming');     // cookie, token, password
throw new Error(`Provider rejected key ${config.paystackSecretKey}`);     // secret in an error
await settings.set('paystack.secret', secret);                              // secrets are never in platform.setting
```

---

## SC-08. Scrub every log line and span before it leaves the process, and prove it with a test

**Source:** ADR-0022; `docs/security/SECURITY_ARCHITECTURE.md` section 6 ("Logs and traces"); `docs/security/THREAT_MODEL.md` TB5 and TB7; `docs/security/DATA_CLASSIFICATION.md` section 2.

**Rule.** Logging goes through the shared Pino instance, whose redaction and scrubber remove passwords, tokens, cookies, one-time codes, key material, payment identifiers and all but the last three digits of phone numbers, before the line is written or a span or Sentry event is sent. Request and response bodies are not logged. Log identifiers and outcomes, not objects. Adding a new sensitive field means adding it to the scrubber and to the test that feeds each category through the logger and asserts none appears (delivered in B3).

Correct:

```ts
const logger = pino({
  redact: { paths: ['*.password', '*.token', 'req.headers.cookie', 'req.headers.authorization', '*.phone'], censor: '[redacted]' },
  formatters: { log: scrubPersonalData },     // masks phones to last three digits, drops payment identifiers
});
log.info({ customerId, orderId, outcome: 'CONFIRMED' }, 'order confirmed');
```

Incorrect:

```ts
console.log('login', email, password);                          // console.log is banned by lint
log.info({ customer }, 'customer saved');                        // whole object: name, phone, address
log.debug({ responseBody }, 'provider response');                // payment identifiers
```

---

## SC-09. Cookies are host-bound, `HttpOnly`, `Secure`, `SameSite=Strict`; state changes carry a CSRF token and an allowed origin

**Source:** ADR-0016; `docs/security/SECURITY_ARCHITECTURE.md` section 3; `contract/openapi.yaml` `securitySchemes`; shared brief, security rules.

**Rule.** Session and refresh cookies use the realm-specific `__Host-` names fixed in the contract (`__Host-hk_s_at`, `__Host-hk_c_at`, `__Host-hk_i_at` for access; the `_rt` forms for refresh), with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` and no `Domain`. Tokens are never put in `localStorage`, a query string or a response body. Every cookie-authenticated state-changing request must carry `X-CSRF-Token` matching the session-bound token, and an `Origin` on the allow-list (SC-10). Comparison of tokens and signatures is constant time. A refresh token is rotated on use, and presenting a rotated token revokes the session and raises an alert.

Correct:

```ts
res.cookie('__Host-hk_s_at', accessToken, {
  httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 10 * 60 * 1000,
});

// guard on every POST, PUT, PATCH, DELETE with a cookie session
if (!allowedOrigins.has(req.headers.origin ?? '')) throw new ForbiddenError('ORIGIN_NOT_ALLOWED');
if (!timingSafeEqualStr(req.header('x-csrf-token'), session.csrfToken)) throw new ForbiddenError('CSRF_INVALID');
```

Incorrect:

```ts
res.cookie('hk_session', accessToken, { domain: '.hakoremfarms.com' });   // readable by script, sent to every subdomain, no SameSite
return { accessToken };                                                      // token in the body, ends up in localStorage
```

---

## SC-10. CORS is an allow-list with credentials, never a wildcard

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5; shared brief, security rules; ADR-0016.

**Rule.** The API answers cross-origin requests only for the storefront and console origins from configuration. `Access-Control-Allow-Origin` echoes a matching origin from the list; it is never `*`, never reflects an arbitrary `Origin`, and never combines with credentials for an origin not on the list. Public webhook and provider callbacks are not CORS endpoints at all.

Correct:

```ts
app.enableCors({
  origin: (origin, cb) => cb(null, origin !== undefined && config.allowedOrigins.includes(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
});
```

Incorrect:

```ts
app.enableCors({ origin: true, credentials: true });     // reflects any origin with cookies
app.enableCors({ origin: '*' });
```

---

## SC-11. Rate limit by address, account and key, and fail closed where the table says so

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5 (rate limits table); ADR-0016; `docs/ARCHITECTURE.md` section 8 (Redis down).

**Rule.** Every new endpoint declares its rate-limit group. Login, TOTP, password reset, verification codes, the public quote form, checkout and payment initiation, and integration keys fail closed when Redis is unavailable; authenticated console reads, public catalogue reads and the webhook endpoint (where the signature is still required) fail open. Counters are keyed by a hash of the address or account id, not by a raw phone number or email. Limit values are settings recorded in `docs/OPERATIONS.md`, not constants in code, apart from the named defaults.

Correct:

```ts
@RateLimit({ group: 'AUTH', by: ['ip', 'account'], onStoreFailure: 'CLOSED' })
@Post('auth/staff/login')
login(@Body(new SchemaPipe(LoginBody)) cmd: LoginCommand) { ... }
```

Incorrect:

```ts
@Post('rfqs')                                           // public form, no limit: free spam and enumeration
submit(@Body() body: RfqBody) { ... }

try { await limiter.hit(key); } catch { /* Redis down, let it through */ }   // login fails open; also SC-15
```

---

## SC-12. File uploads: cap the size, sniff the content, store under a random key, scan, serve only when clean

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5 (file uploads); `docs/data-model/platform.md` (`platform.stored_file`); shared brief, security rules.

**Rule.** The size cap per upload type is enforced before the body is read in full. The type is determined by content sniffing against an allow-list for that use; the extension and the declared content type are ignored. The object is stored under a random key in a private bucket (not the web root) with `scan_status = 'PENDING'`, scanned by the worker, and served only when `CLEAN`. Images are re-encoded into variants; the original is not served publicly. Public media come from a separate origin; private files come only by signed, expiring URL, each issue logged in `platform.file_access_log`. The original file name is kept for download only and is never used in a path.

Correct:

```ts
const sniffed = await sniffType(stream.head(4096));
if (!ALLOWED[useCase].has(sniffed.mime)) throw new ValidationError('FILE_TYPE_NOT_ALLOWED');
const key = `${useCase}/${uuidv7()}`;                           // random, no user input
await files.register(tx, { key, contentType: sniffed.mime, sizeBytes, classification, scanStatus: 'PENDING' });
```

Incorrect:

```ts
if (!file.originalname.endsWith('.pdf')) throw new Error('pdf only');   // extension is attacker-controlled
await fs.writeFile(`public/uploads/${file.originalname}`, file.buffer);  // web root, user-chosen path, no scan
```

---

## SC-13. Verify a payment webhook in this order, before any business work

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 8; ADR-0014; `docs/security/THREAT_MODEL.md` TB5 and abuse cases 4 and 5; `docs/data-model/pay.md` (`pay.webhook_event`).

**Rule.** A webhook is untrusted until all seven steps pass, in order: (1) record it in `pay.webhook_event` whatever happens next; (2) verify the signature over the raw body against the provider secret in constant time; (3) check the timestamp is inside the accepted window; (4) check the event id is unseen (`UNIQUE (provider, event_id)` where the signature is valid); (5) match the reference to a payment this system initiated; (6) confirm amount and status with a server-to-server lookup, never trusting the payload's own amount; (7) only then clear the payment, in a transaction with its ledger posting. Failures at steps 2 to 4 are answered without detail and counted for the alert. No endpoint anywhere accepts a "paid" status from a browser or device. The controller must receive the raw body (disable body parsing for that route).

Correct:

```ts
async handle(raw: Buffer, headers: Headers): Promise<void> {
  const evt = await this.events.record(raw, headers);                              // 1
  if (!this.sig.verify(raw, headers['x-signature'], secret)) return this.reject(evt, 'REJECTED_SIGNATURE'); // 2
  if (!this.clock.within(evt.timestamp, WINDOW)) return this.reject(evt, 'REJECTED_STALE');                  // 3
  if (await this.events.seen(evt.provider, evt.eventId)) return;                                              // 4
  const payment = await this.payments.findInitiated(evt.reference);                                           // 5
  if (!payment) return this.reject(evt, 'IGNORED_UNKNOWN_REFERENCE');
  const truth = await this.provider.lookup(evt.reference);                                                    // 6
  if (truth.amountPesewas !== payment.amountPesewas) return this.reject(evt, 'REJECTED_AMOUNT');
  await this.uow.run(serializable, (tx) => this.clearAndPost(tx, payment, truth));                            // 7
}
```

Incorrect:

```ts
@Post('webhooks/paystack')
async hook(@Body() body: any) {                  // parsed body, no signature, trusts the payload's amount
  await this.orders.markPaid(body.data.reference, body.data.amount);
}
```

---

## SC-14. No external call inside a transaction: write to the outbox, let the worker call out

**Source:** ADR-0010; ADR-0005; `docs/ARCHITECTURE.md` section 8 (external calls); `docs/security/THREAT_MODEL.md` TB8.

**Rule.** Inside a `uow.run` callback, code touches PostgreSQL and in-process modules only. A payment provider, SMS, WhatsApp, email, object-storage write of a rendered document or any HTTP call is requested by inserting an outbox message in the same transaction and performed by a worker with a timeout, bounded retry with jitter and a circuit breaker. The command handler is re-run on serialization failure, so it must be safe to repeat; an external call inside it is not. The one allowed outbound call outside a transaction on the request path is initiating a charge, which happens before any transaction opens.

Correct:

```ts
await this.uow.run(serializable, async (tx) => {
  const sale = await this.sales.complete(tx, cmd);
  await this.outbox.publish(tx, new SaleCompleted(sale.id, sale.customerId, sale.grossPesewas));  // receipt is sent later
});
```

Incorrect:

```ts
await this.uow.run(serializable, async (tx) => {
  const sale = await this.sales.complete(tx, cmd);
  await this.sms.send(sale.contactPhone, 'Thank you');     // retried up to 5 times with the transaction; holds locks on the network
});
```

---

## SC-15. No empty catch blocks: handle the error or rethrow it with context

**Source:** shared brief, "Failure handling"; `docs/ARCHITECTURE.md` section 5.

**Rule.** A `catch` either handles the error meaningfully (a typed recovery, a defined fallback with a log at the right level) or rethrows with context added (`cause`). It never swallows. A catch that returns a default hides an outage. Lint rule `no-empty` and a ban on `catch (_)` that does nothing are on; a log line alone is not handling when the caller needs to know.

Correct:

```ts
try {
  await this.provider.lookup(reference);
} catch (err) {
  throw new ProviderUnavailableError('payment lookup failed', { cause: err, reference });
}
```

Incorrect:

```ts
try {
  await this.audit.write(event);
} catch (e) {}                                   // the action happened with no record
```

---

## SC-16. Errors carry the correlation id and stable code, and no internal detail

**Source:** ADR-0029 (one error envelope); `docs/ARCHITECTURE.md` section 5; `docs/security/SECURITY_ARCHITECTURE.md` section 5.

**Rule.** Every non-2xx response is `{ "error": { "code", "message", "correlationId", "details" } }`. A business refusal is a typed result mapped to 422 with a stable code; a version mismatch or reused idempotency key is 409; an unexpected error is logged with context and answered as 500 with the correlation id and a generic message. No stack trace, SQL text, constraint name, table name or internal path leaves the process. Messages go through the translation layer. The correlation id is assigned in the first middleware and appears in the response header, every log line, every span, the audit event and every outbox message the request causes.

Correct:

```ts
catch (err) {
  if (err instanceof BusinessRuleError) return res.status(422).json(envelope(err.code, err.userMessage, correlationId));
  this.log.error({ err, correlationId }, 'unhandled error');                  // full detail stays server-side
  return res.status(500).json(envelope('INTERNAL_ERROR', 'Something went wrong. Quote this reference.', correlationId));
}
```

Incorrect:

```ts
catch (err) {
  return res.status(500).json({ message: err.message, stack: err.stack, query: err.query });   // internals to the client
}
```

---

## SC-17. Maker and checker are different people, and the database enforces it

**Source:** ADR-0017; `docs/security/SECURITY_ARCHITECTURE.md` section 4 (separation of duties); `docs/data-model/iam.md` (`iam.approval_request`); ADR-0029 (202 `ApprovalPending`).

**Rule.** An action in the separation-of-duties table does not take effect when requested. The request returns 202 with `ApprovalPending`, an `iam.approval_request` row binds the approval to the exact content with `payload_hash`, and a user other than the requester decides. The effect is applied in the same transaction as the approval by the owning module's registered handler. The domain code does not check "requester is not approver" alone: `CHECK (decided_by IS NULL OR decided_by <> requested_by)` is the rule. Thresholds come from `iam.approval_policy`, not from constants. Step-up (a TOTP within five minutes) is required for distributions, bulk exports, role and grant changes and posting-rule changes.

Correct:

```ts
if (adjustment.valuePesewas >= policy.thresholdPesewas) {
  const req = await this.approvals.request(tx, { kind: 'STOCK_WRITE_OFF', subject: adjustment.id,
    payloadHash: hash(adjustment), amountPesewas: adjustment.valuePesewas, requestedBy: actor.id, evidenceFileId });
  return ApprovalPending.of(req.id);                      // 202; stock unchanged until a different user approves
}
```

```sql
ALTER TABLE iam.approval_request
  ADD CONSTRAINT ck_approval_request_maker_checker CHECK (decided_by IS NULL OR decided_by <> requested_by);
```

Incorrect:

```ts
if (adjustment.valuePesewas > 50_000n) {                 // magic number, and the same user can approve their own request
  await this.stock.writeOff(tx, adjustment);
}
```

---

## SC-18. Encrypt restricted fields in the application; never decrypt outside the owning module

**Source:** ADR-0022; `docs/security/DATA_CLASSIFICATION.md` (Restricted categories); `docs/security/SECURITY_ARCHITECTURE.md` section 6.

**Rule.** Bank and mobile money details, identity numbers, tax identification numbers of individuals, TOTP secrets and webhook secrets are written to `*_enc` `BYTEA` columns through the platform crypto service (AES-256-GCM, random nonce, key id, wrapped data key). Equality lookups use a keyed hash in a `*_hash` column. Decryption happens only in the owning module, only in the use case that needs the value, under the permission that guards that use case, and writes an audit event with action `DECRYPT`. The API returns a mask (`payoutDetailsMasked`, `idNumberMasked`). A new column that holds a Restricted value without `_enc` is a review blocker. Personal fields written to an immutable store (audit `before` and `after`) are encrypted under the subject's key first.

Correct:

```ts
const enc = await this.crypto.encrypt(subjectKeyId, JSON.stringify(details));
await this.suppliers.setPayout(tx, supplierId, { payoutDetailsEnc: enc, payoutLast4: last4(details) });
// pay time, in the pur module only
const details = await this.crypto.decrypt(row.payoutDetailsEnc, { audit: { action: 'DECRYPT', entity: 'supplier', id: row.id } });
```

Incorrect:

```ts
await tx.insert(supplierProfile).values({ supplierId, payoutDetails: JSON.stringify(details) });   // plaintext column
return { ...supplier, payoutDetails: decrypt(supplier.payoutDetailsEnc) };                         // plaintext in a response
```

---

## SC-19. Outbound URLs supplied by users are HTTPS, resolved and checked at save and at send (SSRF)

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 5 (server-side requests); `docs/data-model/api.md` (`api.webhook_endpoint.url`).

**Rule.** A URL a user or integrator supplies (outbound webhook endpoints) must be `https://`, must not carry credentials, and must resolve to public addresses only. Private (RFC 1918), loopback, link-local (including the cloud metadata address 169.254.169.254), unique-local IPv6 and unspecified addresses are refused. The check runs when the URL is saved and again when it is called, using the address resolved for that call (the connection is made to that address, so a DNS answer that changes between check and use cannot redirect it). Redirects are not followed, or each hop is checked. A timeout and a response-size cap apply. The payment provider and messaging URLs come from configuration, not from users.

Correct:

```ts
async deliver(url: string, body: Buffer, sig: string) {
  const target = await resolvePublic(url);                       // throws on non-https, credentials, private or link-local address
  return this.http.post(target.url, body, {
    lookup: () => target.address,                                // connect to the address that was checked
    maxRedirects: 0, timeout: 5_000, maxContentLength: 64 * 1024,
    headers: { 'X-Hakorem-Signature': sig },
  });
}
```

Incorrect:

```ts
await axios.post(endpoint.url, payload);                         // http://169.254.169.254/latest/meta-data/ is "a webhook"
```

```sql
-- the database cannot resolve names, but it can enforce the scheme
ALTER TABLE api.webhook_endpoint ADD CONSTRAINT ck_webhook_endpoint_https CHECK (url LIKE 'https://%');
```

---

## SC-20. Dependencies, images and code are scanned on every pull request, and a high finding blocks the merge

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` section 12; shared brief, "Supply chain and pipeline"; `docs/security/THREAT_MODEL.md` TB7.

**Rule.** CI runs a dependency audit, static analysis, container image scanning and a software bill of materials on every pull request and release. A high or critical finding blocks the merge; a waiver is a dated entry in `docs/security/` naming the finding, the reason, the owner and an expiry, approved by the reviewer. The lockfile is committed and CI installs with a frozen lockfile. Dependency updates arrive as reviewed pull requests, one concern each. Base images are pinned by digest, run as a non-root user, and are tagged by commit SHA. A new dependency is justified in the pull request description (what it does, who maintains it, why the standard library or an existing dependency does not).

Correct:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm audit --audit-level=high
- uses: aquasecurity/trivy-action@<pinned commit sha>
  with: { image-ref: ghcr.io/…/api:${{ github.sha }}, severity: HIGH,CRITICAL, exit-code: '1' }
```

Incorrect:

```yaml
- run: pnpm install                       # resolves new versions in CI
- run: pnpm audit || true                 # findings ignored
```

---

## SC-21. Secret scanning runs on every pull request; secrets live only in the server's file and in GitHub Actions secrets

**Source:** `docs/security/SECURITY_ARCHITECTURE.md` sections 6 and 12; shared brief, "Data and secrets".

**Rule.** A secret scanner runs over the diff and the history on every pull request and fails the build on a finding. No secret is in either repository, an image, a workflow file or `platform.setting`; example environment files hold key names only; nothing under `infra/secrets/` is committed. A leaked secret is treated as compromised: it is rotated first, then removed from the code. Seeds and fixtures contain synthetic data and no real keys. Pre-commit hooks are a convenience, not the control.

Correct:

```yaml
- uses: gitleaks/gitleaks-action@<pinned commit sha>   # fails the pull request on any finding
```

```dotenv
# .env.example
PAYSTACK_SECRET_KEY=
DATABASE_URL=
```

Incorrect:

```dotenv
PAYSTACK_SECRET_KEY=<the real secret key>    # committed, even "just for staging"
```

---

## SC-22. Stock and ledger tables are insert-only; correct with a reversing row

**Source:** ADR-0002; ADR-0003; ADR-0012; ADR-0024; `docs/security/SECURITY_ARCHITECTURE.md` section 7.

**Rule.** Code never issues `UPDATE` or `DELETE` against a `LEDGER` table, and never edits a posted `DOCUMENT` outside its listed columns. A correction is a new row that references the original (a reversing movement, a reversing journal, a credit note, a payment reversal). The database rejects the others for every role, so an attempt is a bug that the integration test for that table must prove fails.

Correct:

```ts
await this.movements.insert(tx, { type: 'REVERSAL', reversesMovementId: original.id, quantity: original.quantity, locationId: original.locationId });
```

Incorrect:

```ts
await tx.update(stockMovement).set({ quantity: newQty }).where(eq(stockMovement.id, id));   // trigger rejects; history must never change
```

---

## SC-23. Run stock and ledger writes at the declared isolation, retry the whole command, keep to point reads

**Source:** ADR-0005; `docs/ARCHITECTURE.md` section 5; shared brief, "Transactions and concurrency".

**Rule.** The outermost command handler declares the isolation level, because it cannot be raised after the first query. Any command that writes a stock movement or reservation, or publishes an event the ledger posts from, runs at `serializable`; the stock and ledger entry points assert `current_setting('transaction_isolation') = 'serializable'`. The unit of work retries SQLSTATE 40001 and 40P01 up to five times with jittered backoff and re-runs the whole command, so the handler has no side effect outside the transaction (SC-14). Document-number series locks are taken as session-level advisory locks before `BEGIN`, in sorted order, never as `pg_advisory_xact_lock` inside the transaction. Posting transactions use primary-key and index point reads, because a sequential scan takes a relation-level predicate lock. No invariant relies on isolation alone: each also has a constraint, trigger or row lock.

Correct:

```ts
return this.uow.run({ isolation: 'serializable', seriesLocks: [receiptSeries] }, async (tx) => {
  await this.stock.issue(tx, cmd);          // asserts serializable; takes FOR UPDATE on a serialised animal
});
```

Incorrect:

```ts
return this.db.transaction(async (tx) => {         // default read committed: write skew on stock
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${seriesId})`);   // snapshot already taken: still aborts under load
  await this.stock.issue(tx, cmd);
});
```

---

## SC-24. The audit event is written in the business transaction, with actor, address and before and after values

**Source:** ADR-0006; `docs/security/SECURITY_ARCHITECTURE.md` section 7; `docs/data-model/platform.md` (`platform.audit_event`).

**Rule.** Every create, update, delete, login, permission change, price override, approval, export and decryption writes an audit event in the same transaction as the change, so both commit or both roll back. The event carries actor, session, address, correlation id, branch, module, action, entity and before and after values with personal fields encrypted under the subject key and secrets as `[redacted]`. The application never touches `platform.audit_chain`; only the sealer does. An audit write that fails fails the business operation.

Correct:

```ts
await this.audit.record(tx, { action: 'PRICE_OVERRIDE', entityType: 'order_line', entityId: line.id,
  before: { unitPricePesewas: line.unitPricePesewas }, after: { unitPricePesewas: newPrice }, reasonCode });
```

Incorrect:

```ts
await this.orders.overridePrice(tx, line.id, newPrice);
this.auditQueue.add({ ... });            // best effort after commit: a crash loses the evidence
```

---

## Reviewer's quick map

| Question in the diff | Rule |
| --- | --- |
| Is there a schema on the new endpoint, and does the handler receive a typed command? | SC-01 |
| Does the handler call the policy engine, with branch and owner? | SC-02 |
| Is any SQL built from a string, or a sort or table name from a request? | SC-03, SC-04 |
| Any `number` near an amount, a rate, a quantity or a weight? | SC-05 |
| Does a state-changing path have an idempotency key and a unique reference? | SC-06 |
| Could a secret or personal field reach a log, error, event or setting? | SC-07, SC-08, SC-18 |
| Does the endpoint set cookies, accept cross-origin calls, or lack a rate-limit group? | SC-09, SC-10, SC-11 |
| Does it accept a file, a webhook or a user-supplied URL? | SC-12, SC-13, SC-19 |
| Is there an HTTP, SMS, email or storage call inside `uow.run`? | SC-14 |
| Is there an empty `catch`, or an error response with internals? | SC-15, SC-16 |
| Does the action move value quietly without a second person? | SC-17 |
| Is a ledger or posted document updated in place? | SC-22 |
| Is the isolation level declared, and is the audit event in the transaction? | SC-23, SC-24 |
| New dependency, image or secret? | SC-20, SC-21 |
