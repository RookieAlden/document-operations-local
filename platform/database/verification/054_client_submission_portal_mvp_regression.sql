BEGIN;

DO $$
DECLARE
  org_id uuid; admin_id uuid; staff_id uuid; base_case public.cases%ROWTYPE; portal_case public.cases%ROWTYPE;
  connector_result jsonb; entry_result jsonb; invitation_result jsonb; result jsonb;
  entry_id uuid; invitation_id uuid; issue_id uuid:=gen_random_uuid(); question_id uuid;
  connector_key_value text:='m45-2.synthetic-client-portal-regression'; form_id text:='m45-2-regression-form';
  token_hash text:='907a883110693af6985b80858e9c3a422b9f172dc560ec9fc46ded64620be751'; mutation_grants integer;
BEGIN
  org_id:=public.dop_set_organization_context('uat-accounting-firm');
  SELECT id INTO admin_id FROM public.actors WHERE organization_id=org_id
    AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO staff_id FROM public.actors WHERE organization_id=org_id
    AND actor_type='staff' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT c.* INTO base_case FROM public.cases c JOIN public.subjects s
    ON s.organization_id=c.organization_id AND s.id=c.subject_id
   WHERE c.organization_id=org_id AND s.status='active' AND s.attributes @> '{"synthetic":true}'::jsonb
   ORDER BY c.created_at LIMIT 1;
  IF org_id IS NULL OR admin_id IS NULL OR base_case.id IS NULL THEN
    RAISE EXCEPTION 'M45.2 regression prerequisites unavailable'; END IF;

  portal_case:=base_case; portal_case.id:=gen_random_uuid();
  portal_case.case_key:=regexp_replace(base_case.case_key,'[^|]+$','2099-Q2');
  IF portal_case.case_key=base_case.case_key THEN portal_case.case_key:=base_case.case_key||'|2099-Q2'; END IF;
  portal_case.external_reference:='M45-2-ROLLBACK-ONLY-'||portal_case.id;
  portal_case.period_start:='2099-04-01'; portal_case.period_end:='2099-06-30';
  portal_case.status:='waiting_for_documents'; portal_case.risk_status:='normal';
  portal_case.config_snapshot:=jsonb_set(base_case.config_snapshot,'{synthetic_only}','true'::jsonb,true);
  portal_case.version:=base_case.version+1; portal_case.created_at:='2026-08-20T01:00:00Z';
  portal_case.updated_at:='2026-08-20T01:00:00Z'; portal_case.completed_at:=NULL;
  INSERT INTO public.cases SELECT (portal_case).*;

  connector_result:=public.dop_create_uat_synthetic_demo_form_connector(admin_id,connector_key_value,
    'M45.2 rollback client portal','Rollback-only UAT client portal connector regression fixture.',
    'railway://uat/intake/DOP_FORM_CONNECTOR_TOKEN',ARRAY['application/pdf','image/jpeg','image/png'],20,20971520,
    'Create a rollback-only connector for M45.2 regression.',
    'm45-2-regression-connector','45200000-0000-4000-8000-000000000001','2026-08-20T01:01:00Z');
  IF connector_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'connector failed: %',connector_result; END IF;
  entry_result:=public.dop_create_demo_form_entry(admin_id,'m45-2.client-portal-regression',connector_key_value,form_id,
    ARRAY['application/pdf','image/jpeg','image/png'],5,52428800,false,
    'Activate the rollback-only M45.2 client portal entry.',
    '45200000-0000-4000-8000-000000000002','45200000-0000-4000-8000-000000000003','2026-08-20T01:02:00Z');
  IF entry_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'entry failed: %',entry_result; END IF;
  entry_id:=(entry_result->>'entryVersionId')::uuid;
  invitation_result:=public.dop_issue_demo_case_invitation(admin_id,entry_id,portal_case.id,token_hash,'2099-Q2',
    true,true,2,'2026-08-20T01:00:00Z','2026-08-27T01:00:00Z','Issue a bounded rollback-only M45.2 portal link.',
    '45200000-0000-4000-8000-000000000004','45200000-0000-4000-8000-000000000005','2026-08-20T01:03:00Z');
  IF invitation_result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'invitation failed: %',invitation_result; END IF;
  invitation_id:=(invitation_result->>'invitationId')::uuid;

  INSERT INTO public.issues(id,organization_id,case_id,issue_key,issue_type,severity,status,routing_reason,details,opened_at)
  VALUES(issue_id,org_id,portal_case.id,'m45-2-regression-missing-invoice-'||issue_id,'missing','medium','waiting_external',
    'internal-routing-secret-must-not-leak','{"internal_note":"never expose this client-side","confidence":0.42}',
    '2026-08-20T01:04:00Z');
  result:=public.dop_publish_client_portal_question(admin_id,portal_case.id,issue_id,'请补交销售发票',
    '请补交一份完全虚构的本期销售发票PDF文件。','Publish only the minimum synthetic client-visible request.',
    '45200000-0000-4000-8000-000000000006','45200000-0000-4000-8000-000000000007','2026-08-20T01:05:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'published' THEN RAISE EXCEPTION 'publish failed: %',result; END IF;
  question_id:=(result->>'questionId')::uuid;

  result:=public.dop_read_client_portal_snapshot(token_hash,'45200000-0000-4000-8000-000000000008','2026-08-20T01:06:00Z');
  IF result->>'outcome'<>'authorized' OR result#>>'{snapshot,portalStatus}'<>'needs_action'
     OR result#>>'{snapshot,questions,0,title}'<>'请补交销售发票'
     OR result#>>'{snapshot,uploadAllowed}'<>'true' THEN RAISE EXCEPTION 'safe snapshot failed: %',result; END IF;
  IF result::text LIKE '%internal-routing-secret%' OR result::text LIKE '%never expose%' OR result::text LIKE '%confidence%' THEN
    RAISE EXCEPTION 'internal issue or classifier content leaked into portal snapshot'; END IF;

  result:=public.dop_read_client_portal_snapshot(repeat('f',64),'45200000-0000-4000-8000-000000000009','2026-08-20T01:06:10Z');
  IF result<>jsonb_build_object('outcome','blocked','reason','link_unavailable') THEN RAISE EXCEPTION 'unknown link did not fail generically: %',result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.client_portal_access_attempts WHERE correlation_id='45200000-0000-4000-8000-000000000009'
      AND decision='blocked' AND reason_code='link_not_found') THEN RAISE EXCEPTION 'blocked link audit missing'; END IF;

  UPDATE public.demo_case_invitations SET used_submissions=maximum_submissions,status='exhausted' WHERE id=invitation_id;
  result:=public.dop_read_client_portal_snapshot(token_hash,'45200000-0000-4000-8000-000000000010','2026-08-20T01:07:00Z');
  IF result->>'outcome'<>'authorized' OR result#>>'{snapshot,uploadAllowed}'<>'false'
     OR result#>>'{snapshot,remainingSubmissions}'<>'0' THEN RAISE EXCEPTION 'exhausted link was not read-only: %',result; END IF;

  result:=public.dop_transition_client_portal_question(admin_id,question_id,'resolve',
    'Synthetic supplement reviewed and accepted by the operator.',
    '45200000-0000-4000-8000-000000000011','45200000-0000-4000-8000-000000000012','2026-08-20T01:08:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'resolved' THEN RAISE EXCEPTION 'question transition failed: %',result; END IF;
  result:=public.dop_read_client_portal_snapshot(token_hash,'45200000-0000-4000-8000-000000000013','2026-08-20T01:09:00Z');
  IF jsonb_array_length(result#>'{snapshot,questions}')<>0 THEN RAISE EXCEPTION 'resolved question remained client-visible'; END IF;

  UPDATE public.cases SET config_snapshot=jsonb_set(config_snapshot,'{synthetic_only}','false'::jsonb,true) WHERE id=portal_case.id;
  INSERT INTO public.issues(id,organization_id,case_id,issue_key,issue_type,status,opened_at)
  VALUES(gen_random_uuid(),org_id,portal_case.id,'m45-2-regression-non-synthetic-'||gen_random_uuid(),'missing','open','2026-08-20T01:10:00Z')
  RETURNING id INTO issue_id;
  result:=public.dop_publish_client_portal_question(admin_id,portal_case.id,issue_id,'不得发布的问题',
    '此问题不得进入非虚构Case的客户入口。','Verify the synthetic Case boundary fails closed.',
    '45200000-0000-4000-8000-000000000014','45200000-0000-4000-8000-000000000015','2026-08-20T01:11:00Z');
  IF result->>'reason'<>'synthetic_scope_required' THEN RAISE EXCEPTION 'non-synthetic publication was not blocked: %',result; END IF;

  IF staff_id IS NOT NULL THEN
    BEGIN
      PERFORM public.dop_publish_client_portal_question(staff_id,portal_case.id,issue_id,'无权发布的问题',
        '普通员工无权绕过主管边界直接发布。','Verify manager permission boundary for client questions.',
        '45200000-0000-4000-8000-000000000016','45200000-0000-4000-8000-000000000017','2026-08-20T01:12:00Z');
      RAISE EXCEPTION 'staff unexpectedly published a client question';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END IF;

  SELECT count(*) INTO mutation_grants FROM information_schema.role_table_grants
   WHERE grantee IN ('dop_app','dop_app_uat') AND table_schema='public'
     AND table_name IN ('client_portal_question_versions','client_portal_access_attempts')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF mutation_grants<>0 THEN RAISE EXCEPTION 'runtime role received direct client portal mutation grants'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='ClientPortal.QuestionPublished' AND aggregate_id=question_id) THEN
    RAISE EXCEPTION 'client question publication audit event missing'; END IF;
END $$;

ROLLBACK;
