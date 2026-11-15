# ADR-0052: The Farm hand works through cost-free care operations, and a full answer needs its read permission

- **Status:** Proposed (B06 continued 3; the owner approves by merging the B06 continued 3 pull request)
- **Date:** 2026-11-15
- **Session:** B06 continued 3
- **Deciders:** backend track; owner (the decision it builds is the owner's, 2026-11-15)

## Context

The owner decided on 2026-11-15 (A-158, replacing its Farm hand line) that the Vet or Farm hand reads what animal work and food safety need, the animal register, the feed rations and above all the health events with their withdrawal holds, so that a treated animal is never sent to slaughter or sale, and never a cost. Death records and anything only about money stay refused. The opener asked for the codebase's pattern for cost visibility if there is one, and otherwise for cost-free shapes of their own, never nullable cost fields.

Two leaks existed on `main`:

- The reads the Farm hand needs (`listAnimals`, `getAnimal`, `listHealthEvents`, `getHealthEvent`, `listRations`, `listBatches`, `getBatch`) answer shapes with cost or price fields, or sit under a permission (`liv.feed.read`) that also opens reads with cost.
- The writes the role holds answer with the full resource: `updateAnimal` and `moveAnimal` (`Animal.accumulatedCostPesewas`, `priceBand`), the batch writes (`Batch.accumulatedCostPesewas`), and also `recordHealthEvent` (`HealthEvent.costPesewas`), `recordFeedConsumption` (`valuePesewas` and each share) and `reportMortality` and `submitMortalityRecord` (`valuePesewas`), which A-158 granted. A write's answer is a read.

ADR-0029 already holds the pattern: customers and investors get their own shapes (`CustomerOrder`, everything under `/investor/`), never a staff shape with fields emptied.

## Options considered

1. **Nullable or omitted cost fields, filled by permission.** One operation per resource; but every client generated from the contract types the cost as present, a screen can show it by mistake, and the owner ruled it out.
2. **One response schema per operation that is `oneOf` the full and the care shape.** The contract would say the role may receive a cost.
3. **Separate care operations for the role, under `/care/`, with their own cost-free schemas, and a rule that a full answer needs its read permission.** More operations, but every shape the role can receive is cost-free by construction, and the rules run once, in the same handlers.
4. **Refuse the role every write whose answer carries cost.** No new operations, but the requirements' own actor could no longer record a treatment, a feed issue or a death.

## Decision

Option 3.

- **Care shapes:** `CareAnimal`, `CareHealthEvent`, `CareBatch`, `CareFeedConsumption` (with `CareFeedAllocation`) and `CareMortalityRecord` are the full shapes with every cost and price field removed (`accumulatedCostPesewas`, `priceBand`, `costPesewas`, `valuePesewas`, `amountPesewas`, and `currency` with them). `CareHealthEvent` keeps the withdrawal days, its end and the holds placed; `CareAnimal` keeps `withdrawalUntil` and `sellable`.
- **Care reads** under one new permission, `liv.care.read`: `listCareAnimals`, `getCareAnimal`, `listCareHealthEvents`, `getCareHealthEvent`, `listCareRations`, `listCareBatches`, `getCareBatch`. Same filters, scopes and cursors rules as the full reads, through the same handlers.
- **Care writes** under the full write's own permission: `updateCareAnimal`, `moveCareAnimal`, `recordCareHealthEvent`, `recordCareFeedConsumption`, `reportCareMortality`, `submitCareMortalityRecord`, `createCareBatch`, `updateCareBatch`, `closeCareBatch`. Same handler, same transaction and effects; the answer is projected, and so is a replay, since the stored response is the full one. Each has its own idempotency scope.
- **The answer's read permission:** a full write whose answer carries cost declares `answerPermission` on its `@Operation` and `x-answer-permission` in the contract (`liv.animal.read`, `liv.batch.read`, `liv.health.read`, `liv.feed.read`, `liv.mortality.read`). The handler checks it with the write's permission, at the same scopes. Only the Farm hand holds a write without its read, so only it is refused there.
- **Grants (migration 0084):** `liv.care.read` to the Owner, the Manager and the Farm hand; the Farm hand gives up `liv.batch.read`. Its write permissions stay. It holds no PRC permission (A-153 as decided in A-160).
- **The proof:** one test walks every LIV and PRC operation of the published contract that the role's grants reach and asserts that no response schema, example or live answer carries a cost or pesewa field, and that each full write whose answer carries cost refuses the role.

## Consequences

- A screen built for the Farm hand from the generated client cannot show a cost: its types have none.
- Sixteen more operations, each a door onto an existing handler; a rule changed in the handler changes both.
- A new full write that answers cost must declare `answerPermission` and get a care twin if the role needs it; the walk fails otherwise.
- Binds: `docs/API.md` (livestock section), the `hakorem-endpoint` skill's permission check, `docs/security/DATA_CLASSIFICATION.md` DC-11.

## Verification

- `test/integration/liv/farm-hand-care.integration.spec.ts`: the walk, and a Farm hand reading a treated goat's withdrawal hold and its end.
- `test/integration/iam/authorisation.integration.spec.ts`: every care operation refuses a user with no grant.
- `scripts/contract/code-document.ts`: a fragment's `x-answer-permission` must equal the route's.
