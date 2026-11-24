-- 0357_doc_distribution_schedule_template
-- B12 (FR-CAP-010, FR-DOC-004, ADR-0028, ADR-0061): the built-in A4 template of the distribution schedule, version 1,
-- written and activated by the SYSTEM principal like the statement's of 0241, with sample data so an administrator can
-- preview it. It shows the working a second person repeats with a calculator: the period and its days, net profit,
-- what is kept and shared, the convention, and per investor the unit-days, the share and whether a leftover pesewa
-- landed there. Every figure arrives formatted; the template never computes.
-- Data category: none (a lookup row; the sample data is invented and marked SAMPLE).
-- Rollback: tested (`pnpm db:rollback`). Once a schedule has been rendered the template stays (the archive names the
-- version), so the down step keeps it and says so, and applying again finds it (ON CONFLICT DO NOTHING).

-- migrate:up
INSERT INTO doc.template (id, doc_type, output, name, created_by, updated_by) VALUES
  ('01900000-0000-7000-8000-000000000531', 'DISTRIBUTION_RUN', 'PDF_A4', 'Distribution schedule', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by) VALUES (
  '01900000-0000-7000-8000-000000000541', '01900000-0000-7000-8000-000000000531', 1,
  '<header><h1>HaKorem Farms</h1><p>{{branch.name}}</p></header>'
  || '<h2>{{title}}</h2>'
  || '<row><cell>Run</cell><cell>{{runNo}}</cell></row>'
  || '<row><cell>Period</cell><cell>{{periodStart}} to {{periodEnd}} ({{daysInPeriod}} days)</cell></row>'
  || '<row><cell>Submitted on</cell><cell>{{submittedOn}}</cell></row>'
  || '<hr/><section><row><cell>Net profit</cell><cell>{{netProfit}}</cell></row>'
  || '<row><cell>Kept by the farm ({{retentionRate}} percent)</cell><cell>{{retained}}</cell></row>'
  || '<row><cell>To share</cell><cell>{{distributable}}</cell></row>'
  || '<row><cell>Total unit-days</cell><cell>{{totalUnitDays}}</cell></row>'
  || '<row><cell>Tax withheld rate</cell><cell>{{withholdingRate}} percent</cell></row></section>'
  || '<p>{{convention}}</p>'
  || '<hr/><row><cell>No</cell><cell>Investor</cell><cell>Unit-days</cell><cell>Allocated</cell><cell>Extra pesewa</cell><cell>Withheld</cell><cell>Payable</cell></row><hr/>'
  || '{{#each lines}}<row><cell>{{investorNo}}</cell><cell>{{name}}</cell><cell>{{unitDays}}</cell><cell>{{allocated}}</cell><cell>{{extra}}</cell><cell>{{withheld}}</cell><cell>{{netPayable}}</cell></row>{{/each}}'
  || '<hr/><h2>Total allocated {{allocatedTotal}}</h2>'
  || '<p>Amounts in Ghana cedis. Confidential: for the farm''s owners and its investors.</p>'
  || '<footer>HaKorem Farms. The allocation is by unit-days with largest-remainder rounding (ADR-0028).</footer>',
  '{"title": "Distribution schedule", "runNo": "DST-2026-DDW-000001", "branch": {"code": "DDW", "name": "Dodowa Farm"}, "periodStart": "2026-07-01", "periodEnd": "2026-09-30", "daysInPeriod": 92, "submittedOn": "2026-10-15", "netProfit": "GHS 100.00", "retentionRate": "40", "retained": "GHS 40.00", "distributable": "GHS 60.00", "totalUnitDays": "3000.0000", "withholdingRate": "0", "convention": "Actual calendar days (SAMPLE).", "allocatedTotal": "GHS 60.00", "lines": [{"investorNo": "INV-001", "name": "Sample Investor (SAMPLE)", "unitDays": "2000.0000", "allocated": "GHS 40.00", "extra": "", "withheld": "GHS 0.00", "netPayable": "GHS 40.00"}, {"investorNo": "INV-002", "name": "Sample Fund (SAMPLE)", "unitDays": "1000.0000", "allocated": "GHS 20.00", "extra": "", "withheld": "GHS 0.00", "netPayable": "GHS 20.00"}]}'::jsonb,
  'DRAFT', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000541' AND status = 'DRAFT';
UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000541', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000531' AND active_version_id IS NULL;

-- migrate:down
DO $$
BEGIN
  UPDATE doc.template SET active_version_id = NULL, version = version + 1 WHERE id = '01900000-0000-7000-8000-000000000531';
  DELETE FROM doc.template_version WHERE template_id = '01900000-0000-7000-8000-000000000531';
  DELETE FROM doc.template WHERE id = '01900000-0000-7000-8000-000000000531';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'doc.template DISTRIBUTION_RUN is kept: a schedule was rendered or archived with its version';
END
$$;
