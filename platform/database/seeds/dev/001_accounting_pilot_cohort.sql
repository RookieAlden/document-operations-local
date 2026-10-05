BEGIN;

-- DEV-only synthetic cohort generated from PILOT_INPUT_SAMPLES_GENERATED.md.
-- Never run this file in UAT or PROD. All identities and contact details are fictitious.

INSERT INTO organizations (
    id, organization_key, display_name, status, default_timezone, settings
) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'dev-accounting-firm',
    'DEV Accounting Firm (Synthetic)',
    'active',
    'Pacific/Auckland',
    '{"environment":"DEV","data_classification":"synthetic_only","external_messages":"approval_and_allowlist_only","pilot_status":"draft"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    settings = EXCLUDED.settings,
    updated_at = now();

INSERT INTO actors (
    id, organization_id, external_subject_id, actor_type, display_name, email, status, attributes
) VALUES
    ('00000000-0000-4000-8100-000000000101','00000000-0000-4000-8000-000000000001','contact-dev-client-001','customer','Mia Thompson','mia.thompson@example.com','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8100-000000000102','00000000-0000-4000-8000-000000000001','contact-dev-client-002','customer','Noah Williams','noah.williams@example.com','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8100-000000000103','00000000-0000-4000-8000-000000000001','contact-dev-client-003','customer','Aroha King','aroha.king@example.com','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8100-000000000104','00000000-0000-4000-8000-000000000001','contact-dev-client-004','customer','Oliver Brown','oliver.brown@example.com','inactive','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8100-000000000105','00000000-0000-4000-8000-000000000001','contact-dev-client-005','customer','Liam Anderson','liam.anderson@example.com','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8200-000000000201','00000000-0000-4000-8000-000000000001','staff-emma-chen','staff','Emma Chen','emma.chen@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8200-000000000202','00000000-0000-4000-8000-000000000001','staff-sophie-patel','staff','Sophie Patel','sophie.patel@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8200-000000000203','00000000-0000-4000-8000-000000000001','staff-lucas-martin','staff','Lucas Martin','lucas.martin@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8200-000000000204','00000000-0000-4000-8000-000000000001','staff-isla-zhang','staff','Isla Zhang','isla.zhang@example.invalid','inactive','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8200-000000000205','00000000-0000-4000-8000-000000000001','staff-amelia-jones','staff','Amelia Jones','amelia.jones@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8300-000000000301','00000000-0000-4000-8000-000000000001','manager-daniel-wu','manager','Daniel Wu','daniel.wu@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8300-000000000302','00000000-0000-4000-8000-000000000001','manager-grace-liu','manager','Grace Liu','grace.liu@example.invalid','active','{"synthetic":true}'::jsonb),
    ('00000000-0000-4000-8400-000000000401','00000000-0000-4000-8000-000000000001','service-dev-system-admin','service','DEV System Administrator',NULL,'active','{"synthetic":true,"environment":"DEV"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    email = EXCLUDED.email,
    status = EXCLUDED.status,
    attributes = EXCLUDED.attributes,
    updated_at = now();

INSERT INTO subjects (
    id, organization_id, subject_key, subject_type, display_name, status, primary_contact_actor_id, attributes
) VALUES
    ('00000000-0000-4000-9000-000000001001','00000000-0000-4000-8000-000000000001','dev-client-001','accounting_client','Kauri Coast Café Limited','active','00000000-0000-4000-8100-000000000101','{"synthetic":true,"frequency":"monthly","assigned_staff":"staff-emma-chen","manager":"manager-daniel-wu","holiday_region":"Auckland","source":"PILOT_INPUT_SAMPLES_GENERATED.md"}'::jsonb),
    ('00000000-0000-4000-9000-000000001002','00000000-0000-4000-8000-000000000001','dev-client-002','accounting_client','Harbourlight Electrical Services Limited','active','00000000-0000-4000-8100-000000000102','{"synthetic":true,"frequency":"monthly","assigned_staff":"staff-sophie-patel","manager":"manager-daniel-wu","holiday_region":"New Zealand","source":"PILOT_INPUT_SAMPLES_GENERATED.md"}'::jsonb),
    ('00000000-0000-4000-9000-000000001003','00000000-0000-4000-8000-000000000001','dev-client-003','accounting_client','Tui Creative Studio Limited','active','00000000-0000-4000-8100-000000000103','{"synthetic":true,"frequency":"quarterly","assigned_staff":"staff-lucas-martin","manager":"manager-grace-liu","holiday_region":"Wellington","source":"PILOT_INPUT_SAMPLES_GENERATED.md"}'::jsonb),
    ('00000000-0000-4000-9000-000000001004','00000000-0000-4000-8000-000000000001','dev-client-004','accounting_client','Southern Fern Property Care Limited','paused','00000000-0000-4000-8100-000000000104','{"synthetic":true,"frequency":"monthly","assigned_staff":"staff-isla-zhang","manager":"manager-grace-liu","holiday_region":"Canterbury","source":"PILOT_INPUT_SAMPLES_GENERATED.md","case_generation_enabled":false}'::jsonb),
    ('00000000-0000-4000-9000-000000001005','00000000-0000-4000-8000-000000000001','dev-client-005','accounting_client','Blue Peak Consulting Limited','active','00000000-0000-4000-8100-000000000105','{"synthetic":true,"frequency":"quarterly","assigned_staff":"staff-amelia-jones","manager":"manager-daniel-wu","holiday_region":"Otago","source":"PILOT_INPUT_SAMPLES_GENERATED.md"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    primary_contact_actor_id = EXCLUDED.primary_contact_actor_id,
    attributes = EXCLUDED.attributes,
    updated_at = now();

INSERT INTO workflow_templates (
    id, organization_id, template_key, display_name, industry_package, status
) VALUES
    ('00000000-0000-4000-a000-000000002001','00000000-0000-4000-8000-000000000001','accounting.monthly.document_collection','Monthly Accounting Document Collection','accounting','active'),
    ('00000000-0000-4000-a000-000000002002','00000000-0000-4000-8000-000000000001','accounting.quarterly.document_collection','Quarterly Accounting Document Collection','accounting','active')
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO workflow_template_versions (
    id, organization_id, workflow_template_id, version, status, definition, definition_hash, published_at
) VALUES
    ('00000000-0000-4000-a100-000000002101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-a000-000000002001',1,'published','{"frequency":"monthly","environment":"DEV","external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb,encode(digest('accounting-monthly-dev-v1','sha256'),'hex'),'2026-08-06T09:00:00Z'),
    ('00000000-0000-4000-a100-000000002102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-a000-000000002002',1,'published','{"frequency":"quarterly","environment":"DEV","external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb,encode(digest('accounting-quarterly-dev-v1','sha256'),'hex'),'2026-08-06T09:00:00Z')
ON CONFLICT (id) DO UPDATE SET
    definition = EXCLUDED.definition,
    definition_hash = EXCLUDED.definition_hash,
    status = EXCLUDED.status,
    published_at = EXCLUDED.published_at;

INSERT INTO document_types (
    id, organization_id, code, display_name, allowed_mime_types, extraction_schema, classification_rules, status
) VALUES
    ('00000000-0000-4000-b000-000000003001','00000000-0000-4000-8000-000000000001','bank_statement','Bank Statement',ARRAY['application/pdf'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003002','00000000-0000-4000-8000-000000000001','invoice','Invoice',ARRAY['application/pdf','image/jpeg','image/png'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003003','00000000-0000-4000-8000-000000000001','payroll_report','Payroll Report',ARRAY['application/pdf','image/jpeg','image/png'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003004','00000000-0000-4000-8000-000000000001','pos_summary','POS Summary',ARRAY['application/pdf','text/csv'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003005','00000000-0000-4000-8000-000000000001','expense_receipt','Expense Receipt',ARRAY['application/pdf','image/jpeg','image/png'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003006','00000000-0000-4000-8000-000000000001','gst_workpaper','GST Workpaper',ARRAY['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],'{}','{"minimum_confidence":0.8,"always_human_confirm":true,"reject_macro_enabled_workbook":true}','active'),
    ('00000000-0000-4000-b000-000000003007','00000000-0000-4000-8000-000000000001','rental_summary','Rental Summary',ARRAY['application/pdf','text/csv'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active'),
    ('00000000-0000-4000-b000-000000003008','00000000-0000-4000-8000-000000000001','contractor_statement','Contractor Statement',ARRAY['application/pdf','text/csv'],'{}','{"minimum_confidence":0.8,"manual_on_conflict":true}','active')
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    classification_rules = EXCLUDED.classification_rules,
    status = EXCLUDED.status,
    updated_at = now();

INSERT INTO requirement_sets (id, organization_id, set_key, display_name) VALUES
    ('00000000-0000-4000-c000-000000004001','00000000-0000-4000-8000-000000000001','accounting.dev-client-001','Kauri Coast Café monthly requirements'),
    ('00000000-0000-4000-c000-000000004002','00000000-0000-4000-8000-000000000001','accounting.dev-client-002','Harbourlight Electrical monthly requirements'),
    ('00000000-0000-4000-c000-000000004003','00000000-0000-4000-8000-000000000001','accounting.dev-client-003','Tui Creative quarterly requirements'),
    ('00000000-0000-4000-c000-000000004004','00000000-0000-4000-8000-000000000001','accounting.dev-client-004','Southern Fern Property Care monthly requirements'),
    ('00000000-0000-4000-c000-000000004005','00000000-0000-4000-8000-000000000001','accounting.dev-client-005','Blue Peak Consulting quarterly requirements')
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now();

INSERT INTO requirement_set_versions (
    id, organization_id, requirement_set_id, version, status, effective_from, definition_hash
) VALUES
    ('00000000-0000-4000-c100-000000004101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c000-000000004001',1,'published','2026-07-01T00:00:00Z',encode(digest('dev-client-001-requirements-v1','sha256'),'hex')),
    ('00000000-0000-4000-c100-000000004102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c000-000000004002',1,'published','2026-07-01T00:00:00Z',encode(digest('dev-client-002-requirements-v1','sha256'),'hex')),
    ('00000000-0000-4000-c100-000000004103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c000-000000004003',1,'published','2026-04-01T00:00:00Z',encode(digest('dev-client-003-requirements-v1','sha256'),'hex')),
    ('00000000-0000-4000-c100-000000004104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c000-000000004004',1,'published','2026-07-01T00:00:00Z',encode(digest('dev-client-004-requirements-v1','sha256'),'hex')),
    ('00000000-0000-4000-c100-000000004105','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c000-000000004005',1,'published','2026-04-01T00:00:00Z',encode(digest('dev-client-005-requirements-v1','sha256'),'hex'))
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, effective_from = EXCLUDED.effective_from, definition_hash = EXCLUDED.definition_hash;

INSERT INTO requirements (
    id, organization_id, requirement_set_version_id, requirement_code, document_type_id, minimum_count, acceptance_rule
) VALUES
    ('00000000-0000-4000-c200-000000004201','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004101','bank_statement.minimum','00000000-0000-4000-b000-000000003001',2,'{"notes":"operating and savings account; complete period; no password"}'),
    ('00000000-0000-4000-c200-000000004202','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004101','invoice.minimum','00000000-0000-4000-b000-000000003002',8,'{"notes":"minimum four purchase and four sales invoices"}'),
    ('00000000-0000-4000-c200-000000004203','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004101','payroll.minimum','00000000-0000-4000-b000-000000003003',1,'{"notes":"zero-payroll declaration accepted after review"}'),
    ('00000000-0000-4000-c200-000000004204','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004101','pos_summary.minimum','00000000-0000-4000-b000-000000003004',1,'{"notes":"must not contain full card numbers"}'),
    ('00000000-0000-4000-c200-000000004211','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004102','bank_statement.minimum','00000000-0000-4000-b000-000000003001',1,'{"notes":"full month; web screenshots rejected"}'),
    ('00000000-0000-4000-c200-000000004212','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004102','invoice.minimum','00000000-0000-4000-b000-000000003002',12,'{"notes":"duplicates count once"}'),
    ('00000000-0000-4000-c200-000000004213','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004102','payroll.minimum','00000000-0000-4000-b000-000000003003',1,'{"notes":"all pay runs and employee total"}'),
    ('00000000-0000-4000-c200-000000004214','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004102','expense_receipt.minimum','00000000-0000-4000-b000-000000003005',10,'{"notes":"one receipt per image"}'),
    ('00000000-0000-4000-c200-000000004221','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004103','bank_statement.minimum','00000000-0000-4000-b000-000000003001',3,'{"notes":"one complete statement per quarter month"}'),
    ('00000000-0000-4000-c200-000000004222','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004103','invoice.minimum','00000000-0000-4000-b000-000000003002',6,'{"notes":"currency retained for foreign invoices"}'),
    ('00000000-0000-4000-c200-000000004223','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004103','expense_receipt.minimum','00000000-0000-4000-b000-000000003005',6,'{"notes":"merchant date and total required"}'),
    ('00000000-0000-4000-c200-000000004224','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004103','gst_workpaper.minimum','00000000-0000-4000-b000-000000003006',1,'{"notes":"human confirmation required; macro-enabled workbook rejected"}'),
    ('00000000-0000-4000-c200-000000004231','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004104','bank_statement.minimum','00000000-0000-4000-b000-000000003001',2,'{"notes":"rent and operating accounts; screenshots rejected"}'),
    ('00000000-0000-4000-c200-000000004232','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004104','invoice.minimum','00000000-0000-4000-b000-000000003002',10,'{"notes":"property code required"}'),
    ('00000000-0000-4000-c200-000000004233','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004104','rental_summary.minimum','00000000-0000-4000-b000-000000003007',1,'{"notes":"UTF-8 CSV; full month and property codes"}'),
    ('00000000-0000-4000-c200-000000004234','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004104','expense_receipt.minimum','00000000-0000-4000-b000-000000003005',5,'{"notes":"missing property code routes to review"}'),
    ('00000000-0000-4000-c200-000000004241','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004105','bank_statement.minimum','00000000-0000-4000-b000-000000003001',3,'{"notes":"one statement per quarter month"}'),
    ('00000000-0000-4000-c200-000000004242','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004105','invoice.minimum','00000000-0000-4000-b000-000000003002',4,'{"notes":"invoice number date currency and amount required"}'),
    ('00000000-0000-4000-c200-000000004243','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004105','contractor_statement.minimum','00000000-0000-4000-b000-000000003008',1,'{"notes":"zero-contractor declaration accepted after review"}'),
    ('00000000-0000-4000-c200-000000004244','00000000-0000-4000-8000-000000000001','00000000-0000-4000-c100-000000004105','expense_receipt.minimum','00000000-0000-4000-b000-000000003005',5,'{"notes":"foreign currency amount required"}')
ON CONFLICT (id) DO UPDATE SET minimum_count = EXCLUDED.minimum_count, acceptance_rule = EXCLUDED.acceptance_rule;

-- The published prompt record pins the exact local instruction file evaluated
-- against six synthetic DEV fixtures. Cases reference this version explicitly;
-- the worker refuses to call a provider when the runtime hash or model differs.
INSERT INTO prompt_versions (
    id, organization_id, prompt_key, version, provider, model, schema_version,
    instruction_hash, status, metadata
) VALUES (
    '00000000-0000-4000-b100-000000003101',
    '00000000-0000-4000-8000-000000000001',
    'document-classifier',
    1,
    'openai',
    'gpt-5.6',
    '1.0',
    '6534794b66f29e64282db287d6c6e0b453bbb009e8133dab0d06c8398f57451d',
    'published',
    '{"environment":"DEV","evaluation_date":"2026-08-06","strict_fixture_passed":6,"strict_fixture_total":6,"actual_model":"gpt-5.6-sol"}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    model = EXCLUDED.model,
    schema_version = EXCLUDED.schema_version,
    instruction_hash = EXCLUDED.instruction_hash,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata;

-- Four active clients receive synthetic historical DEV cases. The paused client
-- deliberately receives no case; verification below enforces that invariant.
INSERT INTO cases (
    id, organization_id, case_key, subject_id, workflow_template_version_id,
    requirement_set_version_id, prompt_version_id, external_reference, period_start, period_end,
    timezone, status, risk_status, due_at, config_snapshot
) VALUES
    ('00000000-0000-4000-d000-000000005001','00000000-0000-4000-8000-000000000001','dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07','00000000-0000-4000-9000-000000001001','00000000-0000-4000-a100-000000002101','00000000-0000-4000-c100-000000004101','00000000-0000-4000-b100-000000003101','DEV-001-2026-07','2026-07-01','2026-07-31','Pacific/Auckland','waiting_for_documents','overdue','2026-08-07T05:00:00Z','{"environment":"DEV","pilot_status":"draft","frequency":"monthly","client_due":"2026-08-07T17:00:00+12:00","internal_due":"2026-08-12T17:00:00+12:00","reminder":{"lead_business_days":2,"interval_business_days":2,"maximum":2},"retention":{"original_days":30,"ai_result_days":90,"logs_days":90,"approval_months":12},"handoff":{"task_type":"accounting.bookkeeping.start","after_ready_business_days":3},"external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb),
    ('00000000-0000-4000-d000-000000005002','00000000-0000-4000-8000-000000000001','dev-accounting-firm|accounting.monthly.document_collection|dev-client-002|2026-07','00000000-0000-4000-9000-000000001002','00000000-0000-4000-a100-000000002101','00000000-0000-4000-c100-000000004102','00000000-0000-4000-b100-000000003101','DEV-002-2026-07','2026-07-01','2026-07-31','Pacific/Auckland','waiting_for_documents','overdue','2026-08-05T05:00:00Z','{"environment":"DEV","pilot_status":"draft","frequency":"monthly","client_due":"2026-08-05T17:00:00+12:00","internal_due":"2026-08-10T17:00:00+12:00","reminder":{"first_at":"2026-08-03T09:30:00+12:00","interval_business_days":1,"maximum":3},"retention":{"original_days":30,"ai_result_days":90,"logs_days":180,"approval_months":12},"handoff":{"task_type":"accounting.bookkeeping.start","after_ready_business_days":2},"external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb),
    ('00000000-0000-4000-d000-000000005003','00000000-0000-4000-8000-000000000001','dev-accounting-firm|accounting.quarterly.document_collection|dev-client-003|2026-Q2','00000000-0000-4000-9000-000000001003','00000000-0000-4000-a100-000000002102','00000000-0000-4000-c100-000000004103','00000000-0000-4000-b100-000000003101','DEV-003-2026-Q2','2026-04-01','2026-06-30','Pacific/Auckland','waiting_for_documents','overdue','2026-07-14T05:00:00Z','{"environment":"DEV","pilot_status":"draft","frequency":"quarterly","client_due":"2026-07-14T17:00:00+12:00","internal_due":"2026-07-24T17:00:00+12:00","reminder":{"lead_business_days":3,"interval_business_days":3,"maximum":2},"retention":{"original_days":45,"ai_result_days":120,"logs_days":180,"approval_months":18},"handoff":{"task_type":"accounting.gst_return.prepare","after_ready_business_days":4,"human_confirmation_required":["gst_workpaper"]},"external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb),
    ('00000000-0000-4000-d000-000000005005','00000000-0000-4000-8000-000000000001','dev-accounting-firm|accounting.quarterly.document_collection|dev-client-005|2026-Q2','00000000-0000-4000-9000-000000001005','00000000-0000-4000-a100-000000002102','00000000-0000-4000-c100-000000004105','00000000-0000-4000-b100-000000003101','DEV-005-2026-Q2','2026-04-01','2026-06-30','Pacific/Auckland','waiting_for_documents','overdue','2026-07-10T05:00:00Z','{"environment":"DEV","pilot_status":"draft","frequency":"quarterly","client_due":"2026-07-10T17:00:00+12:00","internal_due":"2026-07-21T17:00:00+12:00","reminder":{"lead_business_days":2,"interval_business_days":2,"maximum":3},"retention":{"original_days":45,"ai_result_days":120,"logs_days":180,"approval_months":18},"handoff":{"task_type":"accounting.quarterly_accounts.prepare","after_ready_business_days":5},"external_messages_require_approval":true,"dev_recipient_policy":"allowlist_only"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    risk_status = EXCLUDED.risk_status,
    due_at = EXCLUDED.due_at,
    prompt_version_id = EXCLUDED.prompt_version_id,
    config_snapshot = EXCLUDED.config_snapshot,
    updated_at = now();

DO $$
DECLARE
    paused_case_count integer;
BEGIN
    SELECT count(*) INTO paused_case_count
    FROM cases c
    JOIN subjects s ON s.id = c.subject_id
    WHERE c.organization_id = '00000000-0000-4000-8000-000000000001'
      AND s.subject_key = 'dev-client-004';

    IF paused_case_count <> 0 THEN
        RAISE EXCEPTION 'DEV seed invariant failed: paused client has % cases', paused_case_count;
    END IF;
END $$;

COMMIT;
