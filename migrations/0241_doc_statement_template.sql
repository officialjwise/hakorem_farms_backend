-- 0241_doc_statement_template
-- B08 continued 2d (FR-WHL-009, FR-DOC-004, ADR-0061, ADR-0062, ADR-0085): the built-in A4 template of the customer
-- statement, version 1, written and activated by the SYSTEM principal like the remittance advice's of 0157, with
-- sample data so an administrator can preview it before drafting a replacement. Every amount arrives formatted, a
-- balance in the customer's favour marked CR; the template never computes.
-- Data category: none (a lookup row; the sample data is invented and marked SAMPLE).
-- Rollback: tested (`pnpm db:rollback`). Once a statement has been rendered the template stays: the archive and its
-- render job name the version, and both are kept, so the down step keeps it and says so, and applying again finds it
-- (ON CONFLICT DO NOTHING). Walked over an archived statement by `bil/archive-link-rollback`.

-- migrate:up
INSERT INTO doc.template (id, doc_type, output, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000508', 'STATEMENT', 'PDF_A4', 'Customer statement', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by) VALUES (
  '01900000-0000-7000-8000-000000000518', '01900000-0000-7000-8000-000000000508', 1,
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<h2>{{title}}</h2>'
  || '<row><cell>Statement</cell><cell>{{statementNo}}</cell></row>'
  || '<row><cell>Issued on</cell><cell>{{issuedOn}}</cell></row>'
  || '<row><cell>Period</cell><cell>{{periodStart}} to {{periodEnd}}</cell></row>'
  || '<p>To: {{customer.name}} ({{customer.publicId}})</p>'
  || '<hr/><row><cell>Date</cell><cell>Item</cell><cell>Reference</cell><cell>Charged</cell><cell>Credited</cell><cell>Balance</cell></row><hr/>'
  || '{{#each lines}}<row><cell>{{date}}</cell><cell>{{kind}}</cell><cell>{{reference}}</cell><cell>{{debit}}</cell><cell>{{credit}}</cell><cell>{{balance}}</cell></row>{{/each}}'
  || '<hr/><section><row><cell>Opening balance</cell><cell>{{opening}}</cell></row>'
  || '<row><cell>Invoices and debit notes</cell><cell>{{invoiced}}</cell></row>'
  || '<row><cell>Other charges</cell><cell>{{otherCharges}}</cell></row>'
  || '<row><cell>Credit notes</cell><cell>{{credited}}</cell></row>'
  || '<row><cell>Payments</cell><cell>{{paid}}</cell></row>'
  || '<row><cell>Other credits</cell><cell>{{otherCredits}}</cell></row></section>'
  || '<hr/><h2>Closing balance {{closing}}</h2>'
  || '{{#if inCredit}}<p>The balance is in your favour (CR): nothing is owed, and the credit is held for you.</p>{{/if}}'
  || '<p>Amounts in Ghana cedis.</p>'
  || '<footer>HaKorem Farms. Please quote the statement number in any query.</footer>',
  '{"title": "Customer statement", "statementNo": "STM-2026-DDW-000001", "issuedOn": "2026-11-01", "customer": {"name": "Sample Customer Ltd (SAMPLE)", "publicId": "cus_SAMPLE0000000000"}, "branch": {"code": "DDW", "name": "Dodowa Farm"}, "periodStart": "2026-10-01", "periodEnd": "2026-10-31", "opening": "GHS 1,000.00", "invoiced": "GHS 2,500.00", "otherCharges": "GHS 0.00", "credited": "GHS 200.00", "paid": "GHS 1,500.00", "otherCredits": "GHS 0.00", "closing": "GHS 1,800.00", "inCredit": false, "lines": [{"date": "2026-10-01", "kind": "Brought forward", "reference": "Balance brought forward", "debit": "", "credit": "", "balance": "GHS 1,000.00"}, {"date": "2026-10-06", "kind": "Invoice", "reference": "SAMPLE-INV-01", "debit": "GHS 2,500.00", "credit": "", "balance": "GHS 3,500.00"}, {"date": "2026-10-10", "kind": "Credit note", "reference": "SAMPLE-CRN-01", "debit": "", "credit": "GHS 200.00", "balance": "GHS 3,300.00"}, {"date": "2026-10-14", "kind": "Payment", "reference": "SAMPLE-PAY-01", "debit": "", "credit": "GHS 1,500.00", "balance": "GHS 1,800.00"}]}'::jsonb,
  'DRAFT', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000518' AND status = 'DRAFT';
UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000518', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000508' AND active_version_id IS NULL;

-- migrate:down
DO $$
BEGIN
  UPDATE doc.template SET active_version_id = NULL, version = version + 1 WHERE id = '01900000-0000-7000-8000-000000000508';
  DELETE FROM doc.template_version WHERE template_id = '01900000-0000-7000-8000-000000000508';
  DELETE FROM doc.template WHERE id = '01900000-0000-7000-8000-000000000508';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'doc.template STATEMENT is kept: a statement was rendered or archived with its version';
END
$$;
