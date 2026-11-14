---
name: hakorem-tests
description: "Use when writing, fixing, renaming, running, reviewing or deleting any test or test helper: Vitest `*.spec.ts`, Supertest, Testcontainers Postgres or Redis, test factories and fixtures, test data builders, coverage thresholds and gates, a failing, skipped, flaky or slow test, a contract test against `contract/openapi.yaml`, an end-to-end or smoke test, k6 load runs, or the scripts `pnpm test:unit`, `test:integration`, `test:contract`, `test:e2e`, `test:smoke`. Also when deciding which test layer a new rule belongs in. The specific assertions for money, ledger, stock, pricing, security or offline come from the matching hakorem skill; this one governs how tests are built."
---

# Tests: five layers, real Postgres, exact values

Authoritative: `docs/TEST_STRATEGY.md` (layers, locations, naming, coverage gates, test data policy). Definition of done and the layer table: `docs/SHARED_BRIEF.md`, "Definition of done" and "The test layers". If this skill and `docs/TEST_STRATEGY.md` ever differ, the strategy document wins and this skill is fixed.

## The layers

| Layer | Scope | Runs against | Command | When |
| --- | --- | --- | --- | --- |
| Unit | One domain rule, pure, no input or output | Nothing external | `pnpm test:unit` | Every commit |
| Integration | A module through its public interface | Real Postgres and Redis in Testcontainers | `pnpm test:integration` | Every pull request |
| Contract | Every response shape against `contract/openapi.yaml` | The running API | `pnpm test:contract` | Every pull request; any drift fails the build |
| End to end | A whole business flow across modules | The full stack in Docker Compose | `pnpm test:e2e` | Every pull request to main; full nightly |
| Smoke | A short list of critical paths, read-only plus one safe write | The deployed environment, test branch only | `pnpm test:smoke` | Straight after every deploy, under 60 seconds; exit code drives rollback |

Also: a k6 load run against the non-functional targets before each release, and a nightly OWASP ZAP baseline against staging. A module is not finished without every layer that applies to it. The pnpm commands arrive in B2.

## Checklist

1. **Test first for money, stock, weight and permissions**, and write the test in the same commit as the code it covers.
2. **Exact values.** Assert integers of pesewas and decimal strings of kilograms, never a tolerance, never `toBeCloseTo`. Every money, stock or weight calculation has at least one rounding edge case (exactly half, one below, one above, zero, maximum).
3. **No mocked database, ever.** If it touches a table, trigger, constraint or lock, it is an integration test on the real engine. Mock only true outside-world ports (payment provider, SMS, object storage) and only at the port, with the adapter contract tested separately.
4. **One container per test run, one isolated schema state per test.** Start Postgres and Redis once through Testcontainers, apply the real migrations (not a hand-built schema), and reset between tests by transaction rollback or truncation through the migrator role. Tests run as `hk_app`, not as a superuser, so privilege and trigger rules are exercised; a separate helper uses `hk_migrator` for setup and tamper tests.
5. **Factories over fixtures.** Build data with factory functions that return valid objects with overridable fields and generate UUIDv7 ids through the kernel. No shared mutable fixture files, no SQL dumps, no production data. Anything seeded is marked as seed (hakorem-seed).
6. **Time and ids are injected.** Use the kernel `Clock` and the UUIDv7 generator; never `Date.now()` or `new Date()` in code under test. Business dates are Africa/Accra, timestamps UTC.
7. **Name tests as sentences** that state the rule and the outcome: `refuses to sell a serial animal that is already in the CUSTOMER location`, `rounds an exact half pesewa up once at the line total`. Group by module and rule with `describe`. File names end `.spec.ts`; the layer is clear from its directory (`test/integration/<module>/`, `test/contract/`, `test/e2e/`, `test/smoke/`; unit specs sit beside the source); see `docs/TEST_STRATEGY.md` for the exact scheme.
8. **Authorisation is tested every time.** At least one test proves the wrong role is refused and, where ownership or branch applies, the wrong owner or branch is refused.
9. **Database invariants are tested by violating them.** Unbalanced journal, negative stock, double sale of a serial unit, update or delete on a ledger table, overlapping price list versions, maker equal to checker: each has a test that attempts it, including by direct SQL, and expects the database to refuse.
10. **Concurrency is tested concurrently.** Two identical requests with one idempotency key produce one effect; 50 concurrent issuers on one series produce a dense sequence; serialization failures are retried up to five times.
11. **Payment edge cases before the happy path:** provider times out after the customer was charged, webhook before the API response, webhook twice, webhook for a missing order, refund fails after stock released.
12. **Coverage gates.** 80 percent overall; 100 percent branch coverage on pricing, ledger, stock valuation, distribution, and the kernel `Money`, `Weight`, `Quantity`, `allocate`. The gate fails the build; do not lower a threshold to pass.
13. **Never commit a failing or skipped test.** A skip needs an issue referenced in the commit message. A flaky test is a failing test: quarantine it with an issue, never add a retry loop. No `.only`. No empty `catch` in a test to swallow an error.
14. **Contract tests read the committed contract** and fail on any drift in status, headers or body shape, including error envelopes with a `correlationId`.
15. **Offline tests run with the network disabled** (hakorem-offline). Smoke tests use the test branch (`is_test`) and its own number series so they never consume a real receipt number.

## Correct and incorrect

```ts
// RIGHT: real engine, real migrations, factory data, an exact value, a sentence name
describe("stock ledger", () => {
  it("refuses a second sale of a serial animal that already sits in the CUSTOMER location", async () => {
    const goat = await factories.serialAnimal(db, { species: "GOAT", tag: "GH-0142" });
    await inventory.post(tx(), saleOf(goat, { orderId: factories.id() }));
    await expect(inventory.post(tx(), saleOf(goat, { orderId: factories.id() })))
      .rejects.toMatchObject({ code: "SERIAL_NOT_AT_SOURCE" });
    expect(await balances.onHand(goat.productId, shopFloor)).toBe("0.000");
  });
});
```

```ts
// WRONG: mocked database, shared fixture, float tolerance, vague name, retry to hide flakiness
vi.mock("../infrastructure/stock.repo");
import fixture from "./fixtures/stock.json";
it("works", async () => {
  repo.balance.mockResolvedValue(1);
  expect(await service.sell(fixture.item)).toBeCloseTo(127.5, 1);
}, { retry: 3 });
```

## Where each thing is proved

The control-to-test map is `docs/security/SECURITY_ARCHITECTURE.md` section 14; the per-session gates are in `docs/BUILD_PROMPT.md` and `docs/adr/0026-session-schedule-amendment.md`; the UAT scenarios the owner runs are `docs/UAT.md`. When a test is the only evidence for a control, name the control in the test's `describe`.
