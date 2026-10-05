BEGIN;

DO $$
DECLARE
  org_id uuid; admin_id uuid; base_case public.cases%ROWTYPE; demo_case public.cases%ROWTYPE;
  connector_result jsonb; entry_result jsonb; invitation_result jsonb; result jsonb;
  entry_id uuid; invitation_id uuid; decision_id uuid; mutation_grants integer;
  connector_key_value text:='m45-1.synthetic-fillout-regression'; form_id text:='m45-1-regression-form';
  token_hash text:=encode(digest('m45-1-regression-invitation-token','sha256'),'hex');
  second_token_hash text:=encode(digest('m45-1-regression-second-invitation','sha256'),'hex');
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE status='active' ORDER BY created_at LIMIT 1;
  PERFORM public.dop_set_organization_context_by_id(org_id);
  SELECT id INTO admin_id FROM public.actors WHERE organization_id=org_id
    AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT c.* INTO base_case FROM public.cases c JOIN public.subjects s
    ON s.organization_id=c.organization_id AND s.id=c.subject_id
   WHERE c.organization_id=org_id AND s.status='active' AND s.attributes @> '{"synthetic":true}'::jsonb
   ORDER BY c.created_at LIMIT 1;
  IF org_id IS NULL OR admin_id IS NULL OR base_case.id IS NULL THEN
    RAISE EXCEPTION 'M45.1 regression prerequisites unavailable'; END IF;

  demo_case:=base_case;
  demo_case.id:=gen_random_uuid();
  demo_case.case_key:=regexp_replace(base_case.case_key,'[^|]+$','2099-12');
  IF demo_case.case_key=base_case.case_key THEN demo_case.case_key:=base_case.case_key||'|2099-12'; END IF;
  demo_case.external_reference:='M45-1-ROLLBACK-ONLY-'||demo_case.id;
  demo_case.period_start:='2099-12-01'; demo_case.period_end:='2099-12-31';
  demo_case.status:='waiting_for_documents'; demo_case.risk_status:='normal';
  demo_case.config_snapshot:=jsonb_set(base_case.config_snapshot,'{synthetic_only}','true'::jsonb,true);
  demo_case.version:=base_case.version+1; demo_case.created_at:='2026-08-18T01:00:00Z';
  demo_case.updated_at:='2026-08-18T01:00:00Z'; demo_case.completed_at:=NULL;
  INSERT INTO public.cases SELECT (demo_case).*;

  connector_result:=public.dop_create_uat_synthetic_demo_form_connector(admin_id,connector_key_value,
    'M45.1 rollback synthetic Fillout','Rollback-only UAT form connector regression fixture.',
    'railway://uat/intake/DOP_FORM_CONNECTOR_TOKEN',
    ARRAY['application/pdf','image/jpeg','image/png'],20,20971520,
    'Create a rollback-only synthetic connector for M45.1 regression.',
    'm45-1-regression-connector','45100000-0000-4000-8000-000000000001','2026-08-18T01:01:00Z');
  IF connector_result->>'outcome'<>'completed' OR connector_result->>'status'<>'active'
     OR (connector_result->>'externalCallCount')::integer<>0 THEN
    RAISE EXCEPTION 'UAT demo connector creation failed: %',connector_result; END IF;

  entry_result:=public.dop_create_demo_form_entry(admin_id,'m45-1.sales-demo-regression',connector_key_value,form_id,
    ARRAY['application/pdf','image/jpeg','image/png'],10,52428800,false,
    'Activate a rollback-only UAT synthetic demo entry.',
    '45100000-0000-4000-8000-000000000002','45100000-0000-4000-8000-000000000003','2026-08-18T01:02:00Z');
  IF entry_result->>'outcome'<>'completed' OR entry_result->>'status'<>'active' THEN
    RAISE EXCEPTION 'demo entry creation failed: %',entry_result; END IF;
  entry_id:=(entry_result->>'entryVersionId')::uuid;

  invitation_result:=public.dop_issue_demo_case_invitation(admin_id,entry_id,demo_case.id,token_hash,'2099-12',
    true,true,2,'2026-08-18T01:00:00Z','2026-08-25T01:00:00Z',
    'Issue a bounded rollback-only synthetic demo invitation.',
    '45100000-0000-4000-8000-000000000004','45100000-0000-4000-8000-000000000005','2026-08-18T01:03:00Z');
  IF invitation_result->>'outcome'<>'completed' OR invitation_result->>'status'<>'active' THEN
    RAISE EXCEPTION 'demo invitation creation failed: %',invitation_result; END IF;
  invitation_id:=(invitation_result->>'invitationId')::uuid;

  IF NOT EXISTS(SELECT 1 FROM public.cases c JOIN public.source_connector_versions version
      ON version.organization_id=c.organization_id AND version.id=c.source_connector_version_id
      JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
      WHERE c.id=demo_case.id AND connector.connector_key=connector_key_value
        AND c.config_snapshot#>>'{sourceBinding,mode}'='governed_synthetic_demo') THEN
    RAISE EXCEPTION 'empty synthetic Case was not bound to the governed demo connector'; END IF;

  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-001',token_hash,
    '2099-12',2,4096,true,ARRAY['application/pdf','image/png'],
    '45100000-0000-4000-8000-000000000006','2026-08-18T01:04:00Z');
  IF result->>'outcome'<>'authorized' OR result->>'caseKey'<>demo_case.case_key
     OR result->>'period'<>'2099-12' THEN RAISE EXCEPTION 'exact invitation was not authorized: %',result; END IF;
  decision_id:=(result->>'authorizationId')::uuid;

  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-001',token_hash,
    '2099-12',2,4096,true,ARRAY['application/pdf','image/png'],
    '45100000-0000-4000-8000-000000000007','2026-08-18T01:04:10Z');
  IF result->>'outcome'<>'duplicate' OR (result->>'authorizationId')::uuid<>decision_id THEN
    RAISE EXCEPTION 'provider submission replay was not idempotent: %',result; END IF;
  IF (SELECT used_submissions FROM public.demo_case_invitations WHERE id=invitation_id)<>1 THEN
    RAISE EXCEPTION 'duplicate consumed an additional invitation use'; END IF;

  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-001',token_hash,
    '2099-12',1,2048,true,ARRAY['application/pdf'],
    '45100000-0000-4000-8000-000000000017','2026-08-18T01:04:20Z');
  IF result->>'outcome'<>'rejected' OR result->>'reason'<>'idempotency_payload_mismatch' THEN
    RAISE EXCEPTION 'provider replay payload drift was not blocked: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.demo_form_access_decisions WHERE organization_id=org_id
      AND provider_submission_id_hash=encode(digest('fillout-regression-001','sha256'),'hex')
      AND decision='blocked' AND reason_code='idempotency_payload_mismatch') THEN
    RAISE EXCEPTION 'provider replay mismatch did not append an audit decision'; END IF;

  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-period',token_hash,
    '2099-11',1,1024,true,ARRAY['application/pdf'],
    '45100000-0000-4000-8000-000000000008','2026-08-18T01:05:00Z');
  IF result->>'outcome'<>'rejected' OR result->>'reason'<>'period_mismatch' THEN
    RAISE EXCEPTION 'period tampering was not blocked: %',result; END IF;
  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-mime',token_hash,
    '2099-12',1,1024,true,ARRAY['text/plain'],
    '45100000-0000-4000-8000-000000000009','2026-08-18T01:05:10Z');
  IF result->>'outcome'<>'rejected' OR result->>'reason'<>'mime_type_not_allowed' THEN
    RAISE EXCEPTION 'unsupported MIME was not blocked: %',result; END IF;
  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-unknown',repeat('f',64),
    '2099-12',1,1024,true,ARRAY['application/pdf'],
    '45100000-0000-4000-8000-000000000010','2026-08-18T01:05:20Z');
  IF result->>'outcome'<>'rejected' OR result->>'reason'<>'invitation_not_found' THEN
    RAISE EXCEPTION 'unknown invitation was not blocked: %',result; END IF;
  IF (SELECT used_submissions FROM public.demo_case_invitations WHERE id=invitation_id)<>1 THEN
    RAISE EXCEPTION 'blocked requests consumed invitation uses'; END IF;

  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-002',token_hash,
    '2099-12',1,1024,true,ARRAY['application/pdf'],
    '45100000-0000-4000-8000-000000000011','2026-08-18T01:06:00Z');
  IF result->>'outcome'<>'authorized' THEN RAISE EXCEPTION 'supplement was not authorized: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.demo_case_invitations WHERE id=invitation_id
      AND used_submissions=2 AND status='exhausted') THEN RAISE EXCEPTION 'invitation limit was not enforced'; END IF;

  invitation_result:=public.dop_issue_demo_case_invitation(admin_id,entry_id,demo_case.id,second_token_hash,'2099-12',
    true,true,5,'2026-08-18T01:00:00Z','2026-08-25T01:00:00Z',
    'Issue a second rollback-only invitation to test explicit revocation.',
    '45100000-0000-4000-8000-000000000012','45100000-0000-4000-8000-000000000013','2026-08-18T01:07:00Z');
  IF invitation_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'second invitation failed: %',invitation_result; END IF;
  result:=public.dop_revoke_demo_case_invitation(admin_id,(invitation_result->>'invitationId')::uuid,
    'Revoke the rollback-only invitation before any document intake.',
    '45100000-0000-4000-8000-000000000014','45100000-0000-4000-8000-000000000015','2026-08-18T01:08:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'revoked' THEN RAISE EXCEPTION 'revocation failed: %',result; END IF;
  result:=public.dop_authorize_demo_form_submission(connector_key_value,form_id,'fillout-regression-revoked',second_token_hash,
    '2099-12',1,1024,true,ARRAY['application/pdf'],
    '45100000-0000-4000-8000-000000000016','2026-08-18T01:09:00Z');
  IF result->>'outcome'<>'rejected' OR result->>'reason'<>'invitation_not_active' THEN
    RAISE EXCEPTION 'revoked invitation still authorized: %',result; END IF;

  BEGIN
    UPDATE public.demo_form_access_decisions SET reason_code='tampered' WHERE id=decision_id;
    RAISE EXCEPTION 'immutable demo access decision unexpectedly updated';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  SELECT count(*) INTO mutation_grants FROM information_schema.role_table_grants
   WHERE grantee='dop_app' AND table_schema='public'
     AND table_name IN ('demo_form_entry_versions','demo_case_invitations','demo_form_access_decisions')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF mutation_grants<>0 THEN RAISE EXCEPTION 'dop_app received direct demo governance mutation grants'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='DemoForm.SubmissionBlocked' AND payload->>'reasonCode'='period_mismatch') THEN
    RAISE EXCEPTION 'blocked demo access audit event missing'; END IF;
END $$;

ROLLBACK;
