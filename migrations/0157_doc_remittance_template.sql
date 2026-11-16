-- 0157_doc_remittance_template
-- B08 continued 2c (FR-PUR-013, FR-DOC-004, ADR-0061, ADR-0062): the built-in A4 template of the supplier remittance
-- advice, version 1, written and activated by the SYSTEM principal like the billing templates of 0152, with sample data
-- so an administrator can preview it before drafting a replacement. Every amount arrives formatted; the template never
-- computes.
-- Data category: none (a lookup row; the sample data is invented and marked SAMPLE).
-- Rollback: tested (`pnpm db:rollback`), safe before the first remittance advice is archived (the archive names the
-- version); afterwards forward fix only.

-- migrate:up
INSERT INTO doc.template (id, doc_type, output, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000507', 'REMITTANCE_ADVICE', 'PDF_A4', 'Supplier remittance advice', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');
INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by) VALUES (
  '01900000-0000-7000-8000-000000000517', '01900000-0000-7000-8000-000000000507', 1,
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<h2>{{title}}</h2>'
  || '<row><cell>Payment</cell><cell>{{paymentNo}}</cell></row>'
  || '<row><cell>Paid on</cell><cell>{{paidDate}}</cell></row>'
  || '<row><cell>Method</cell><cell>{{method}}</cell></row>'
  || '{{#if payee}}<row><cell>Paid to</cell><cell>{{payee}}</cell></row>{{/if}}'
  || '<row><cell>Reference</cell><cell>{{externalReference}}</cell></row>'
  || '<p>To: {{supplier.name}}</p>'
  || '<hr/><row><cell>Your invoice</cell><cell>Dated</cell><cell>Invoice total</cell><cell>Credited</cell><cell>Paid now</cell><cell>Still owed</cell></row><hr/>'
  || '{{#each lines}}<row><cell>{{supplierInvoiceNo}}</cell><cell>{{invoiceDate}}</cell><cell>{{gross}}</cell><cell>{{credited}}</cell><cell>{{amount}}</cell><cell>{{outstandingAfter}}</cell></row>{{/each}}'
  || '<hr/><h2>Total paid {{amount}}</h2><p>Amounts in Ghana cedis.</p>'
  || '<footer>HaKorem Farms. Please quote the payment number in any query.</footer>',
  '{"title": "Remittance advice", "paymentNo": "SPY-2026-DDW-000001", "paidDate": "2026-11-16", "method": "BANK", "payee": "GCB ****4321", "externalReference": "SAMPLE-TRF-0001", "supplier": {"name": "Sample Supplier Ltd (SAMPLE)"}, "branch": {"code": "DDW", "name": "Dodowa Farm"}, "amount": "GHS 1,500.00", "lines": [{"supplierInvoiceNo": "SAMPLE-INV-01", "invoiceDate": "2026-11-02", "gross": "GHS 1,500.00", "credited": "GHS 0.00", "amount": "GHS 1,500.00", "outstandingAfter": "GHS 0.00"}]}'::jsonb,
  'DRAFT', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');
UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000517';
UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000517', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000507';

-- migrate:down
UPDATE doc.template SET active_version_id = NULL, version = version + 1 WHERE id = '01900000-0000-7000-8000-000000000507';
DELETE FROM doc.template_version WHERE template_id = '01900000-0000-7000-8000-000000000507';
DELETE FROM doc.template WHERE id = '01900000-0000-7000-8000-000000000507';
