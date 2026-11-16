# ADR-0062: The template preview returned inline, the remittance advice rendered from PUR's transaction, and document sends left to NTF

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B08 continued 2c
- **Deciders:** backend track; the owner reviews the preview shape and the deferral of sends (A-204)

## Context

ADR-0061 built rendering after commit, the immutable archive and reprints, and left three things to B08 continued 2c (A-203). First, `previewTemplateVersion` was planned to answer a `SignedUrl` to a rendered PDF, but every stored file is served only once the malware scan has passed it (ADR-0044, unchanged by ADR-0061), so a link to a just-rendered preview would point at a `PENDING` file for one scan round and could not be served when the administrator asks. Second, FR-PUR-013 and A-174 say the remittance advice is rendered and archived from the data PUR fixes, once, when a payment is marked paid and `pur.SupplierRemittanceReady` is published; DOC (layer 3) cannot read PUR's (layer 7) tables, and the event carries only ids and amounts, not the invoice lines, the supplier's name or the branch. Third, `sendBillingDocument` and `sendStatement` answer 202 `QUEUED`, but delivering a document by SMS, WhatsApp or email belongs to NTF (B11: templates, preferences, opt-outs, quiet hours, the delivery log), and only an SMS adapter exists behind the notification port.

## Options considered

**The preview.**
1. Store the preview as a file and answer the planned `SignedUrl`. The link would name an unscanned file: either it is refused for a scan round, or ADR-0044's rule is broken for generated files.
2. Render and return the bytes inline, storing nothing, as a reprint already does (`ReprintResult.pdfBase64`, ADR-0061).

**The remittance advice.**
1. DOC subscribes to `pur.SupplierRemittanceReady` and renders it. The event would have to carry the lines, the supplier's name and the branch's (personal and commercial data in every outbox row), and a lower module would react to a higher module's event.
2. PUR asks DOC to render, in the transaction that writes the remittance row and publishes the event, through `Documents.requestRenderIn`, exactly as BIL does for its documents. Commands down (ADR-0010); the render data travels in the render job, not in the event.

**Sends.**
1. Publish a send event now and answer 202. No consumer exists to deliver it, and the outbox writes delivery rows only for the consumers registered when an event is published (`DomainEvents.publish`), so a message queued now would never reach the NTF built in B11: the 202 would be untrue.
2. Leave `sendBillingDocument` and `sendStatement` planned until NTF exists, with the reason.

## Decision

Option 2 in each case.

- **Preview.** `previewTemplateVersion` renders any version, a draft included, with the request's `data` or the version's saved sample data, and answers `TemplatePreviewResult`: `pdfBase64` for an A4 template, `escPosBase64` for a thermal one, `url` and `expiresAt` always null. The specimen carries `SPECIMEN PREVIEW - NOT A VALID DOCUMENT` first and last, so it cannot pass for an issued document whatever data is given. It writes nothing: no render job, no archive row, no stored file, no number, no audit event and no idempotency row; it is a read under `doc.template.read`. With no data given and no sample data saved it is 422 `PREVIEW_DATA_REQUIRED`. The response schema changes from the planned `SignedUrl` (a LOUD line in the changelog; no client has read a real answer).
- **Remittance advice.** The advice is a business document of its own (`REMITTANCE_ADVICE`, owned by PUR, unnumbered; migration 0156), whose id is its `pur.supplier_remittance` row's. In the transaction that marks the payment paid, PUR registers it, publishes `pur.SupplierRemittanceReady` (unchanged, v1) and calls `Documents.requestRenderIn` with the render data from `remittanceRenderData` (every amount formatted from its integer pesewas by the kernel's `formatCedis`), naming the event as the render request's cause. DOC's worker renders it with the built-in template (migration 0157) and archives it once; PUR's consumer `pur.remittance-link` sets `supplier_payment.remittance_document_id` once (migration 0158: only a PAID payment names an advice, and once named it never changes). PUR now imports DOC, a lower layer.
- **Sends.** `sendBillingDocument` and `sendStatement` stay planned and move to B11, where NTF consumes a send event and delivers it. Reprint copies on paper and PDF are unchanged (`reprintBillingDocument`).

## Consequences

- An administrator sees a preview at once, and no unscanned file is ever served.
- A replayed or repeated `markSupplierPaymentPaid` writes no second remittance row (A-174), so no second render job or archive row; a redelivered message is a no-op through the inbox.
- `formatCedis` moves from BIL's domain to the kernel, so BIL, PUR and later WHL print amounts identically.
- Supplier payments carry no number yet (`payment_no` is never allocated): the advice quotes the payment's id until one is (A-205).
- Customer statements are not built here: B08 continued 2c split before them (A-206). B11 builds both sends on NTF and must test that a send reaches only the document's own customer.
- Binds: `docs/data-model/doc.md`, `pur.md`, `platform.md`; the DOC and PUR cards in `docs/MODULE_BOUNDARIES.md`; the B11 opener.

## Verification

- `test/integration/doc/preview-remittance.integration.spec.ts`: a preview of an A4 version, a draft with its sample data, a thermal version and the seeded remittance template, each marked twice and writing nothing (eight row counts unchanged); 422 `PREVIEW_DATA_REQUIRED`; the wrong roles refused. A seeded supplier invoice paid in cash: the advice registered, its render job queued in the paying transaction and caused by `pur.SupplierRemittanceReady`, archived once with the SHA-256 of its stored bytes after commit, linked from the payment once; a replay, a repeat and a redelivery of every message add nothing; the link refused to change or clear (HK004) and refused on an unpaid payment; the archive refused to the roles without `doc.document.read`.
- `src/modules/pur/domain/remittance.spec.ts`: the render data's exact amounts and its Accra business date. `packages/kernel/src/cedis.spec.ts`: `formatCedis`.
- `test/contract/b8/documents-archive.contract.spec.ts`: `TemplatePreviewResult` and the refusal's `Error`.
