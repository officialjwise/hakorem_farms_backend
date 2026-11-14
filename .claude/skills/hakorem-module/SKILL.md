---
name: hakorem-module
description: "Use when creating, restructuring, renaming, splitting or merging a module under `src/modules/<code>/` (iam, mdm, liv, inv, prc, pur, pos, whl, quo, shp, ord, del, bil, pay, fin, cap, cst, rpt, ntf, doc, aud, api), adding `index.ts`, `events.ts`, `<code>.module.ts` or a `domain/`, `application/`, `infrastructure/` or `interface/` folder, adding an import from one module to another, calling another module, registering a domain event or event subscriber, adding a port, adding code under `src/platform` or `packages/kernel`, or when `eslint-plugin-boundaries`, `import/no-cycle` or the cross-schema foreign key check fails. Not for the SQL of a table (use hakorem-migration) and not for HTTP request and response shapes (use hakorem-endpoint)."
---

# Module structure and boundaries

Decisions: `docs/adr/0008-module-structure-and-boundary-enforcement.md`, `docs/adr/0009-platform-mechanisms-and-the-22-modules.md`, `docs/adr/0010-commands-down-events-up-and-the-outbox.md`, `docs/adr/0011-cross-module-foreign-keys-and-document-registry.md`. The rules, layer table, published-key allow-list and port list are in `docs/MODULE_BOUNDARIES.md`; read the card for the module in hand, not the whole file. Reference shape: the Product slice built in B3.

## Layout

```text
src/modules/<code>/
  index.ts          the only file other modules import at runtime
  events.ts         published event contracts, types only
  domain/           aggregates, value objects, domain services; imports kernel and itself only
  application/      commands, queries, ports; imports domain/
  infrastructure/   Drizzle tables, repositories, adapters
  interface/        controllers, request schemas, event subscribers
  <code>.module.ts  NestJS module
```

`<code>` is the lower-case module code. `packages/kernel` imports nothing; `src/platform` imports only the kernel and holds mechanisms, no business rules.

## Checklist

1. **Code and layer.** The folder name is one of the 22 codes. Its layer is a constant in the lint configuration copied from `docs/MODULE_BOUNDARIES.md` section 2; a new module is one line there.
2. **One door.** Other modules import this module only through `index.ts`, and only from a higher layer. Never the same layer, never a higher one. `index.ts` exports services, ports and public types, not repositories, tables or domain internals.
3. **Events are public language.** `events.ts` holds types only. Another module imports it with `import type`. Name events `<code>.<AggregatePastTense>`; version them; payloads carry what subscribers need (recipient references, rendering data, named amounts), never secrets, and personal data only where needed.
4. **Commands down, events up.** To get a lower module to do something inside your operation, call its `index.ts`; the call joins your transaction through the ambient context. To react to something, subscribe. Lower modules never call upward; they publish.
5. **Transactional versus asynchronous subscribers.** Only three kinds may run inside the publisher's transaction: ledger posting, a module keeping its own aggregate consistent with a lower module's fact, and exact trigger-style projections. Everything else (notifications, webhooks, reporting, costing, search) is asynchronous through the outbox and records `platform.inbox_message` in the same transaction as its effect.
6. **Ports are the exception.** The complete list is `docs/MODULE_BOUNDARIES.md` section 6. A new port needs an ADR (use hakorem-adr).
7. **No cross-schema SQL.** A module reads and writes only its own schema. Cross-schema foreign keys exist only to published keys, upward-to-downward, `ON DELETE RESTRICT`, declared in SQL and never as Drizzle relations. Only RPT and CST may select from another schema's `pub_*` views.
8. **Document registry.** A document a module creates gets a `platform.business_document` row in the same transaction with the same id. "Caused by this document" is `source_document_id`.
9. **domain/ is pure.** No `@nestjs/*`, `drizzle-orm`, I/O, clock reads (use the kernel `Clock`) or random ids (use the kernel UUIDv7). A rule that needs an HTTP call to test is in the wrong layer.
10. **Wire the three cross-cutting things.** A module is not finished without authorisation through the IAM policy engine in each handler (`authorise(actor, permission, { branch_id, location_id, owner })`), audit, and the outbox. Permissions are rows seeded by a migration (hakorem-migration).
11. **No external call inside a transaction.** Provider, SMS, email and object-storage writes go through the outbox to the worker.
12. **Platform has no business rules.** No permission codes, thresholds, account codes, templates or preferences under `src/platform`.
13. **Run `pnpm lint` and the data checks** before committing; both run in CI and block the merge.

## Correct and incorrect

```ts
// src/modules/ord/application/complete-sale.ts   (ORD is layer 9)
import { InventoryService } from "../../inv";                 // RIGHT: public door, lower layer
import { BillingService } from "../../bil";                   // RIGHT
import type { StockMovementPosted } from "../../inv/events";  // RIGHT: type-only events import
```

```ts
import { stockBalance } from "../../inv/infrastructure/tables";   // WRONG: reaches inside another module
import { PosService } from "../../pos";                           // WRONG: ORD (9) importing POS (10), a higher layer
import { sql } from "drizzle-orm";
await db.execute(sql`SELECT * FROM inv.stock_balance b JOIN mdm.product p ON p.id = b.product_id`); // WRONG: cross-schema join
import { Injectable } from "@nestjs/common";                  // WRONG inside src/modules/ord/domain/
import { PaymentCleared } from "../../pay/events";            // WRONG: must be `import type`
```

Correct foreign key declaration (in the SQL migration, not in Drizzle):

```sql
ALTER TABLE ord.sales_order_line
  ADD CONSTRAINT fk_sales_order_line_product
  FOREIGN KEY (product_id) REFERENCES mdm.product (id) ON DELETE RESTRICT;  -- mdm.product is on the allow-list
```

Incorrect: a foreign key to `pos.shift` from a lower-layer table, or to any table not on the allow-list. Use `source_document_id` to `platform.business_document` instead.

## When the lint fails

Read the failing rule before changing anything. The fix is almost always one of: go through `index.ts`; move the shared type into `events.ts` or the kernel; publish an event instead of calling up; add a port with an ADR. Do not add an `eslint-disable`, do not widen the allow-list to make a build pass, and do not move code into `platform` to dodge a layer; each of those is a boundary decision and needs an ADR.

## Verification

B2 delivered the rule and a fixture with one illegal import of each kind. If you change the lint configuration, the fixture must still fail it.
