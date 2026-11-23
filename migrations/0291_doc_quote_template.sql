-- 0291_doc_quote_template
-- B10 continued 5 (FR-QUO-007, FR-DOC-001, ADR-0061, A-330): the built-in A4 template of the quotation, version 1,
-- written and activated by the SYSTEM principal like the statement's of 0241, with sample data so an administrator can
-- preview it before drafting a replacement. Each issued quote version is rendered once with it, as its own revision of
-- the quote's archived document (ck_archived_document_revision allows a QUOTE more than one). Every amount and
-- quantity arrives formatted, the tax as the estimate the version holds; the template never computes. A line not wholly
-- on hand when the version was issued is printed "subject to stock" (the owner, 2026-11-18, A-328).
-- Data category: none (a lookup row; the sample data is invented and marked SAMPLE).
-- Rollback: tested (`pnpm db:rollback`). Once a quote has been rendered the template stays: the archive and its render
-- job name the version, so the down step keeps it and says so, and applying again finds it (ON CONFLICT DO NOTHING).

-- migrate:up
INSERT INTO doc.template (id, doc_type, output, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000509', 'QUOTE', 'PDF_A4', 'Quotation', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by) VALUES (
  '01900000-0000-7000-8000-000000000519', '01900000-0000-7000-8000-000000000509', 1,
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<h2>{{title}} {{quoteNo}}, version {{versionNo}}</h2>'
  || '<row><cell>Issued on</cell><cell>{{issuedOn}}</cell></row>'
  || '<row><cell>Valid until</cell><cell>{{validUntil}}</cell></row>'
  || '<p>For: {{customerName}}</p>'
  || '<hr/><row><cell>Item</cell><cell>Quantity</cell><cell>Unit price</cell><cell>Amount</cell></row><hr/>'
  || '{{#each lines}}<row><cell>{{description}}</cell><cell>{{quantity}} {{uom}}</cell><cell>{{unitPrice}}</cell><cell>{{amount}}</cell></row>'
  || '{{#if subjectToStock}}<small>Subject to stock: not all of it is on hand today.</small>{{/if}}{{/each}}'
  || '<hr/><row><cell>Delivery</cell><cell>{{deliveryFee}}</cell></row>'
  || '<row><cell>Net</cell><cell>{{net}}</cell></row>'
  || '<row><cell>Tax (estimate)</cell><cell>{{tax}}</cell></row>'
  || '<h2>Total {{gross}}</h2><p>Prices {{pricing}}. Amounts in Ghana cedis.</p>'
  || '{{#if subjectToStock}}<p>This quotation is subject to stock: we hold what is on hand for you and confirm the rest before delivery.</p>{{/if}}'
  || '{{#if terms}}<p>Terms: {{terms}}</p>{{/if}}'
  || '{{#if deliveryEstimate}}<p>Delivery: {{deliveryEstimate}}</p>{{/if}}'
  || '<footer>HaKorem Farms. Accept or decline this quotation through the link we sent you.</footer>',
  '{"title": "Quotation", "quoteNo": "QUO-2026-DDW-000001", "versionNo": 1, "issuedOn": "2026-11-23", "validUntil": "2026-11-30", "customerName": "Sample Buyer (SAMPLE)", "branch": {"code": "DDW", "name": "Dodowa Farm"}, "lines": [{"description": "Goats, about 25 kg (SAMPLE)", "quantity": "2", "uom": "HEAD", "unitPrice": "GHS 950.00", "amount": "GHS 1,900.00", "subjectToStock": true}], "deliveryFee": "GHS 60.00", "net": "GHS 1,960.00", "tax": "GHS 12.00", "gross": "GHS 1,972.00", "pricing": "exclude tax", "subjectToStock": true, "terms": "Half the price as deposit (SAMPLE)", "deliveryEstimate": "Within three days (SAMPLE)"}',
  'DRAFT', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000519' AND status = 'DRAFT';
UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000519', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000509' AND active_version_id IS NULL;

-- migrate:down
DO $$
BEGIN
  UPDATE doc.template SET active_version_id = NULL, version = version + 1 WHERE id = '01900000-0000-7000-8000-000000000509';
  DELETE FROM doc.template_version WHERE template_id = '01900000-0000-7000-8000-000000000509';
  DELETE FROM doc.template WHERE id = '01900000-0000-7000-8000-000000000509';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'doc.template QUOTE is kept: a quote was rendered or archived with its version';
END
$$;
