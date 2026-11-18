-- 0266_doc_statement_template_ageing
-- B10 continued 2 (FR-WHL-009, FR-DOC-004, ADR-0089, A-317 (d)): version 2 of the built-in customer statement template,
-- version 1 of 0241 with FR-WHL-009's ageing summary added before the closing note: what is owed as at the period end by
-- days past due (Current, 1 to 30, 31 to 60, 61 to 90, over 90), and, only when there is any, what the balance holds that
-- no open invoice explains. Every amount arrives formatted; the template never computes. It is activated, and version 1
-- retired, only while version 1 is still the active one: a replacement an administrator activated is left alone.
-- Data category: none (a lookup row; the sample data is invented and marked SAMPLE).
-- Rollback: tested (`pnpm db:rollback`) before a statement is rendered with version 2: version 1 is active again.
-- Afterwards the archive and its render job name version 2, so the down step keeps it and says so.

-- migrate:up
INSERT INTO doc.template_version (id, template_id, version_no, body, sample_data, status, created_by, updated_by)
SELECT '01900000-0000-7000-8000-000000000528', v.template_id, 2,
       replace(v.body, '<p>Amounts in Ghana cedis.</p>',
         '<hr/><section><p>Ageing as at {{ageing.asOf}}</p>'
         || '<row><cell>Current</cell><cell>1 to 30 days</cell><cell>31 to 60 days</cell><cell>61 to 90 days</cell><cell>Over 90 days</cell><cell>Total</cell></row>'
         || '<row><cell>{{ageing.current}}</cell><cell>{{ageing.days1To30}}</cell><cell>{{ageing.days31To60}}</cell><cell>{{ageing.days61To90}}</cell><cell>{{ageing.daysOver90}}</cell><cell>{{ageing.total}}</cell></row>'
         || '</section>{{#if ageing.hasNotAged}}<p>Not on any open invoice: {{ageing.notAged}}</p>{{/if}}'
         || '<p>Amounts in Ghana cedis.</p>'),
       v.sample_data || '{"ageing": {"asOf": "2026-10-31", "current": "GHS 1,250.00", "days1To30": "GHS 800.00", "days31To60": "GHS 0.00", "days61To90": "GHS 0.00", "daysOver90": "GHS 0.00", "total": "GHS 2,050.00", "hasNotAged": false, "notAged": "GHS 0.00"}}'::jsonb,
       'DRAFT', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM doc.template_version v
 WHERE v.id = '01900000-0000-7000-8000-000000000518'
ON CONFLICT (id) DO NOTHING;
UPDATE doc.template_version SET status = 'RETIRED', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000518' AND status = 'ACTIVE'
   AND EXISTS (SELECT 1 FROM doc.template t WHERE t.id = '01900000-0000-7000-8000-000000000508' AND t.active_version_id = '01900000-0000-7000-8000-000000000518')
   AND EXISTS (SELECT 1 FROM doc.template_version n WHERE n.id = '01900000-0000-7000-8000-000000000528' AND n.status = 'DRAFT');
UPDATE doc.template_version SET status = 'ACTIVE', activated_at = now(), activated_by = '01900000-0000-7000-8000-000000000001', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000528' AND status = 'DRAFT'
   AND NOT EXISTS (SELECT 1 FROM doc.template_version a WHERE a.template_id = '01900000-0000-7000-8000-000000000508' AND a.status = 'ACTIVE');
UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000528', version = version + 1
 WHERE id = '01900000-0000-7000-8000-000000000508' AND active_version_id = '01900000-0000-7000-8000-000000000518'
   AND EXISTS (SELECT 1 FROM doc.template_version n WHERE n.id = '01900000-0000-7000-8000-000000000528' AND n.status = 'ACTIVE');

-- migrate:down
DO $$
BEGIN
  UPDATE doc.template SET active_version_id = '01900000-0000-7000-8000-000000000518', version = version + 1
   WHERE id = '01900000-0000-7000-8000-000000000508' AND active_version_id = '01900000-0000-7000-8000-000000000528';
  DELETE FROM doc.template_version WHERE id = '01900000-0000-7000-8000-000000000528';
  UPDATE doc.template_version SET status = 'ACTIVE', version = version + 1
   WHERE id = '01900000-0000-7000-8000-000000000518' AND status = 'RETIRED'
     AND EXISTS (SELECT 1 FROM doc.template t WHERE t.id = '01900000-0000-7000-8000-000000000508' AND t.active_version_id = '01900000-0000-7000-8000-000000000518');
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'doc.template_version 2 of STATEMENT is kept: a statement was rendered or archived with it';
END
$$;
