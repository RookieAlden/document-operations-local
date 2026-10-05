BEGIN;

DO $$
DECLARE
  org_id uuid; admin_id uuid; manager_id uuid; case_id uuid; subject_id uuid;
  period_start_value date; period_end_value date; result jsonb; policy_id uuid;
  scope_value jsonb; consent_value jsonb; privacy_value jsonb;
  residency_value jsonb; resources_value jsonb; decision_id uuid;
  mutation_grants integer;
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE status='active' ORDER BY created_at LIMIT 1;
  PERFORM public.dop_set_organization_context_by_id(org_id);
  SELECT id INTO admin_id FROM public.actors
   WHERE organization_id=org_id AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO manager_id FROM public.actors
   WHERE organization_id=org_id AND actor_type='manager' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT c.id,s.id,c.period_start,c.period_end
    INTO case_id,subject_id,period_start_value,period_end_value
    FROM public.cases c JOIN public.subjects s
      ON s.organization_id=c.organization_id AND s.id=c.subject_id
   WHERE c.organization_id=org_id AND c.status<>'cancelled' AND s.status='active'
     AND s.attributes @> '{"synthetic":true}'::jsonb
     AND c.period_start IS NOT NULL AND c.period_end IS NOT NULL
   ORDER BY c.created_at LIMIT 1;
  IF org_id IS NULL OR admin_id IS NULL OR manager_id IS NULL OR case_id IS NULL THEN
    RAISE EXCEPTION 'M45 regression prerequisites unavailable';
  END IF;

  result:=public.dop_evaluate_submission_data_admission(case_id,'UAT','synthetic_only',NULL,
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('1',64),
    'm45-regression-uat-synthetic-allowed','14500000-0000-4000-8000-000000000001',
    '2026-08-17T04:00:00Z');
  IF coalesce((result->>'allowed')::boolean,false) IS NOT TRUE
     OR result->>'reason'<>'synthetic_subject_allowed' THEN
    RAISE EXCEPTION 'synthetic UAT admission unexpectedly blocked: %',result;
  END IF;

  result:=public.dop_evaluate_submission_data_admission(case_id,'UAT','real_data','prod.fixture.policy',
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('2',64),
    'm45-regression-uat-real-data-blocked','14500000-0000-4000-8000-000000000002',
    '2026-08-17T04:01:00Z');
  IF coalesce((result->>'allowed')::boolean,true) IS NOT FALSE
     OR result->>'reason'<>'nonproduction_real_data_blocked' THEN
    RAISE EXCEPTION 'real data was not blocked in UAT: %',result;
  END IF;

  scope_value:=jsonb_build_object(
    'allowedSourceTypes',jsonb_build_array('internal_upload'),
    'allowedMimeTypes',jsonb_build_array('application/pdf'),
    'purposes',jsonb_build_array('accounting.quarterly_accounts'),
    'documentTypeCodes',jsonb_build_array('bank_statement'),
    'maximumFilesPerSubmission',5,'maximumFileBytes',10485760,
    'periodStart',period_start_value,'periodEnd',period_end_value);
  consent_value:=jsonb_build_object('reference','evidence://m45/rollback-only/customer-consent',
    'sha256',repeat('a',64),'realDataApproved',true,'signedAt','2026-08-17T03:00:00Z');
  privacy_value:=jsonb_build_object('reference','evidence://m45/rollback-only/privacy-review',
    'sha256',repeat('b',64),'approved',true);
  residency_value:=jsonb_build_object('persistentRegion','Sydney','computeRegion','Sydney',
    'crossBorderRequired',false,'crossBorderApproved',false,
    'processors',jsonb_build_array(jsonb_build_object('id','synthetic-provider','purpose','regression','region','Sydney')));
  resources_value:=jsonb_build_object('environment','PROD','isolatedFromDevAndUat',true,
    'backupVerified',true,'secretRotationVerified',true,
    'resourceReference','evidence://m45/rollback-only/isolated-prod');

  result:=public.dop_create_production_data_admission_draft(admin_id,'prod.fixture.policy',
    subject_id,case_id,scope_value,consent_value,privacy_value,residency_value,resources_value,
    '2026-08-17T03:00:00Z','2026-09-17T03:00:00Z',
    'A synthetic Subject and Case must never receive real-data admission.',
    '14500000-0000-4000-8000-000000000013','14500000-0000-4000-8000-000000000014',
    '2026-08-17T04:01:10Z');
  IF result->>'reason'<>'real_subject_and_case_required' THEN
    RAISE EXCEPTION 'synthetic fixture received a real-data draft: %',result;
  END IF;

  UPDATE public.subjects SET attributes=attributes-'synthetic'
   WHERE organization_id=org_id AND id=subject_id;
  UPDATE public.cases SET config_snapshot=config_snapshot-'synthetic_only'
   WHERE organization_id=org_id AND id=case_id;
  result:=public.dop_create_production_data_admission_draft(admin_id,'prod.fixture.policy',
    subject_id,case_id,scope_value,consent_value,privacy_value,residency_value,resources_value,
    '2026-08-17T03:00:00Z','2026-09-17T03:00:00Z',
    'Missing real-data classification labels must fail closed.',
    '14500000-0000-4000-8000-000000000015','14500000-0000-4000-8000-000000000016',
    '2026-08-17T04:01:20Z');
  IF result->>'reason'<>'real_subject_and_case_required' THEN
    RAISE EXCEPTION 'unmarked fixture received a real-data draft: %',result;
  END IF;

  -- This transaction-only fixture remains fictional. The flags are changed only
  -- to exercise the future real-data branch and are rolled back at the end.
  UPDATE public.subjects SET attributes=attributes||'{"synthetic":false,"simulated_real_data":true}'::jsonb
   WHERE organization_id=org_id AND id=subject_id;
  UPDATE public.cases SET config_snapshot=config_snapshot||'{"synthetic_only":false,"simulated_real_data":true}'::jsonb
   WHERE organization_id=org_id AND id=case_id;

  BEGIN
    result:=public.dop_create_production_data_admission_draft(manager_id,'prod.fixture.policy',
      subject_id,case_id,scope_value,consent_value,privacy_value,residency_value,resources_value,
      '2026-08-17T03:00:00Z','2026-09-17T03:00:00Z',
      'Manager must not create a production real-data admission policy.',
      gen_random_uuid(),gen_random_uuid(),'2026-08-17T04:02:00Z');
    RAISE EXCEPTION 'manager unexpectedly created production admission: %',result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  result:=public.dop_create_production_data_admission_draft(admin_id,'prod.fixture.policy',
    subject_id,case_id,scope_value,consent_value,privacy_value,residency_value,resources_value,
    '2026-08-17T03:00:00Z','2026-09-17T03:00:00Z',
    'Record a rollback-only fictional production admission fixture.',
    '14500000-0000-4000-8000-000000000003','14500000-0000-4000-8000-000000000004',
    '2026-08-17T04:03:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'draft'
     OR coalesce((result->>'runtimeEnabled')::boolean,true) IS NOT FALSE THEN
    RAISE EXCEPTION 'draft did not fail closed: %',result;
  END IF;
  policy_id:=(result->>'policyId')::uuid;

  result:=public.dop_evaluate_submission_data_admission(case_id,'PROD','real_data','prod.fixture.policy',
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('3',64),
    'm45-regression-prod-draft-blocked','14500000-0000-4000-8000-000000000005',
    '2026-08-17T04:04:00Z');
  IF coalesce((result->>'allowed')::boolean,true) IS NOT FALSE
     OR result->>'reason'<>'active_production_policy_required' THEN
    RAISE EXCEPTION 'draft policy enabled runtime: %',result;
  END IF;

  result:=public.dop_activate_production_data_admission(admin_id,policy_id,
    'approval://m45/rollback-only/not-a-real-authorization',
    'Activate only inside a rollback-only fictional regression transaction.',
    '14500000-0000-4000-8000-000000000006','14500000-0000-4000-8000-000000000007',
    '2026-08-17T04:05:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'active' THEN
    RAISE EXCEPTION 'activation regression failed: %',result;
  END IF;

  result:=public.dop_evaluate_submission_data_admission(case_id,'PROD','real_data','prod.fixture.policy',
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('4',64),
    'm45-regression-prod-active-allowed','14500000-0000-4000-8000-000000000008',
    '2026-08-17T04:06:00Z');
  IF coalesce((result->>'allowed')::boolean,false) IS NOT TRUE
     OR result->>'reason'<>'active_production_policy_allowed' THEN
    RAISE EXCEPTION 'active exact scope was blocked: %',result;
  END IF;
  decision_id:=(result->>'decisionId')::uuid;

  UPDATE public.subjects SET attributes=attributes-'synthetic'
   WHERE organization_id=org_id AND id=subject_id;
  result:=public.dop_evaluate_submission_data_admission(case_id,'PROD','real_data','prod.fixture.policy',
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('7',64),
    'm45-regression-prod-unmarked-blocked','14500000-0000-4000-8000-000000000017',
    '2026-08-17T04:06:30Z');
  IF coalesce((result->>'allowed')::boolean,true) IS NOT FALSE
     OR result->>'reason'<>'production_subject_and_case_not_authorized' THEN
    RAISE EXCEPTION 'unmarked production Subject was allowed: %',result;
  END IF;
  UPDATE public.subjects SET attributes=attributes||'{"synthetic":false}'::jsonb
   WHERE organization_id=org_id AND id=subject_id;

  result:=public.dop_evaluate_submission_data_admission(case_id,'PROD','real_data','prod.fixture.policy',
    'email',1,1024,ARRAY['application/pdf'],repeat('5',64),
    'm45-regression-prod-source-blocked','14500000-0000-4000-8000-000000000009',
    '2026-08-17T04:07:00Z');
  IF coalesce((result->>'allowed')::boolean,true) IS NOT FALSE
     OR result->>'reason'<>'production_source_out_of_scope' THEN
    RAISE EXCEPTION 'out-of-scope source was allowed: %',result;
  END IF;

  BEGIN
    UPDATE public.data_admission_decisions SET reason_code='tampered' WHERE id=decision_id;
    RAISE EXCEPTION 'immutable decision unexpectedly updated';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  result:=public.dop_revoke_production_data_admission(admin_id,policy_id,
    'Revoke the rollback-only fictional policy and prove immediate shutdown.',
    '14500000-0000-4000-8000-000000000010','14500000-0000-4000-8000-000000000011',
    '2026-08-17T04:08:00Z');
  IF result->>'outcome'<>'completed' OR result->>'status'<>'revoked' THEN
    RAISE EXCEPTION 'revocation failed: %',result;
  END IF;
  result:=public.dop_evaluate_submission_data_admission(case_id,'PROD','real_data','prod.fixture.policy',
    'internal_upload',1,1024,ARRAY['application/pdf'],repeat('6',64),
    'm45-regression-prod-revoked-blocked','14500000-0000-4000-8000-000000000012',
    '2026-08-17T04:09:00Z');
  IF coalesce((result->>'allowed')::boolean,true) IS NOT FALSE
     OR result->>'reason'<>'active_production_policy_required' THEN
    RAISE EXCEPTION 'revoked policy still allowed intake: %',result;
  END IF;

  SELECT count(*) INTO mutation_grants FROM information_schema.role_table_grants
   WHERE grantee='dop_app' AND table_schema='public'
     AND table_name IN ('production_data_admission_policies','data_admission_decisions')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF mutation_grants<>0 THEN RAISE EXCEPTION 'dop_app received direct admission mutation grants'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='DataAdmission.Blocked' AND payload->>'reasonCode'='nonproduction_real_data_blocked') THEN
    RAISE EXCEPTION 'blocked admission audit event missing';
  END IF;
END $$;

ROLLBACK;
