---
name: hakorem-seed
description: "Use when generating, extending or reviewing demo, development, staging, test, UAT or load-test data: `pnpm db:seed`, seed scripts, test factories that produce customers, suppliers, animals, products, prices, weights, stock, orders, investors or opening balances, a seeded performance dataset, the seeded farm that each module session must extend, sample data in an example, a fixture, an OpenAPI example, or anything that invents a Ghanaian name, phone number, tag number, weight or price. Also when asked to copy, anonymise or load production data into any environment (the answer is no). Test structure and factories as a test technique are hakorem-tests; this skill governs what the data contains."
---

# Seed data: a believable farm, never a real one

Rules: `docs/SHARED_BRIEF.md` (no production data in any seed or fixture; seed data comes from a factory and is clearly marked; Ghana first; reference catalogue and price bands) and "Each session extends the seed script" in `docs/BUILD_PROMPT.md`. Security: `docs/security/SECURITY_ARCHITECTURE.md` section 11 (no production data copied to staging, seeds or fixtures). Settings seeds: `docs/SRS.md` (seed values are illustrative until the owner confirms, A-043 in `docs/ASSUMPTIONS.md`). Test branch: `docs/adr/0007-multi-location-from-day-one.md`.

## Checklist

1. **Never production data.** No real customer, supplier, investor, staff, phone number, bank or mobile money detail, tax identification number or invoice, in any form, anonymised or not. Do not import, sample or "scrub" a dump of production to seed another environment. A seed run refuses to start against a production configuration (check the environment name and the database host before any write).
2. **Clearly marked as seed.** Every seeded entity is recognisable as seed: emails use the reserved `.invalid` top-level domain (`kofi.mensah@seed.hakoremfarms.invalid`), phone numbers come from one block the seed script owns, notes and descriptions carry `SEED`, and a `seed.loaded` setting records version and date. A person looking at a screen can tell at a glance. Non-production environments use sandbox credentials and test doubles for every provider, so a seeded number is never messaged and a seeded payment never reaches a real processor.
3. **Realistic Ghanaian content.** Akan day-name first names and common surnames (Kofi, Ama, Kwame, Abena, Yaw, Esi, Kwabena, Efua, Kojo, Akosua with Mensah, Boateng, Owusu, Asante, Appiah, Addo, Darko, Ofori, Agyeman), a few Dagomba and Ewe names, business customers such as funeral caterers, chop bars, hotels and schools, and places across Accra, Kumasi, Tamale, Takoradi and Tema. Phone numbers in Ghana format (`+233` then nine digits). Addresses in Ghanaian style (area, town, digital address pattern). Never a famous person or an existing company.
4. **Catalogue and prices from the reference catalogue.** Products, units and indicative bands as in `docs/SHARED_BRIEF.md` (broilers 120 to 220 GHS per head, goats 120 to 1,950, sheep 150 to 3,000, eggs per crate 35/45/60, 15 kg meat packs 110 to 650 by cut, produce by unit or crate). Prices are integer pesewas within the band, entered as price list data with floor and ceiling, never as constants in code. Produce prices are seasonal: vary them.
5. **Plausible weights, always with a source.** Goats 18 to 45 kg, sheep 20 to 60 kg, baby pigs 8 to 30 kg, broilers 1.2 to 3.0 kg live, local chickens 1.0 to 2.2 kg, meat packs close to 15.000 kg. Weights are three-decimal strings with `SCALE`, `MANUAL` or `ESTIMATE`; mix the sources. Animal tags follow one pattern (`G-0142` for goats, `S-` for sheep, `P-` for pigs) and are unique.
6. **Go through the public interfaces.** Seed by calling each module's `index.ts` services (receive stock, create animals, post a sale), not by raw `INSERT`s, so every invariant, trigger, audit row, outbox message and number series is exercised and every seeded movement has its journal once the ledger exists (the seed is regenerated in B8). Raw SQL is allowed only for lookup data owned by migrations.
7. **Coherent history.** Dates in Africa/Accra business time, spread over recent weeks; receipts precede sales; animals have weight history, health events and one withdrawal hold; at least one processed goat with lots whose costs sum exactly; a supplier with a three-way match difference; a customer with ageing at 30, 60 and 90 days; two investors contributing on different dates; an offline sale conflict; a quote in each state. The trial balance of the seeded farm sums to zero.
8. **Deterministic.** The same seed produces the same data: a fixed random seed, the injected kernel `Clock`, UUIDv7 ids from the kernel generator seeded per run. Re-running on a seeded database is either a no-op or refuses with a clear message; it never duplicates.
9. **Extend, do not fork.** Each module session adds its slice to the one seed script, so later sessions inherit a realistic farm with stock, history and customers instead of an empty database. Keep a short note of what each slice adds at the top of its file.
10. **Seed values for settings are marked illustrative** (approval thresholds, retention rate default 40 percent, override limits) until the owner confirms them.
11. **One branch for the farm and one `is_test` branch** for the smoke suite, with its own number series, excluded from statutory reports. Seeds for the test branch never consume a real series.
12. **Examples count.** Contract examples, documentation snippets and test names follow the same rules: realistic Ghanaian names and catalogue products, at least five rows on a list example.
13. **Performance dataset.** The load-test dataset (10,000 products, 150,000 orders, 2 million stock movements, 5 years of ledger) is generated by a separate, clearly named command that is never run in production.

## Correct and incorrect

```ts
// RIGHT: factory with overridable fields, band-respecting price, public interface, marked, deterministic
export async function seedGoatLot(ctx: SeedContext) {
  const rng = ctx.rng("goat-lot");                                          // fixed seed
  for (const n of range(1, 12)) {
    const weightKg = decimal3(rng.between(18, 45));                         // "27.350"
    await ctx.livestock.registerAnimal(ctx.asStorekeeper, {
      tag: `G-${String(140 + n).padStart(4, "0")}`, species: "GOAT", sex: rng.pick(["F", "M"]),
      acquisitionCostPesewas: priceInBand(rng, 12_000n, 195_000n),           // GHS 120 to 1,950
      weight: { kg: weightKg, source: rng.pick(["SCALE", "MANUAL"]) },
      pen: ctx.locations.pen("PEN-GOATS-1"), source: ctx.suppliers.byName("Kwabena Asante (SEED)"),
    });
  }
}
```

```ts
// WRONG: real-looking contact, production data, constants in code, raw insert bypassing invariants
await db.insert(customers).values({ name: "Nana Akufo", phone: "+233244123456", email: "real@gmail.com" });
await restoreFrom("prod-dump-2026-11-01.sql");                              // never
const GOAT_PRICE = 1200;                                                    // price as a constant, as a float
await db.execute(sql`INSERT INTO inv.stock_balance (...) VALUES (...)`);    // bypasses the ledger
```

## Test expectations

A CI job runs `pnpm db:seed` on a fresh database and asserts: no seeded email outside `.invalid`, no seeded phone outside the seed block, every price within its band, trial balance zero, stock balances equal to the sum of their movements, and a second run changes nothing. The B5 gate (on-hand equals a hand count) is performed against the seeded farm. Use hakorem-tests for structure.
