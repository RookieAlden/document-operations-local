BEGIN;

DO $$
DECLARE
  org_id uuid; admin_id uuid; manager_id uuid; subject_id uuid;
  profile_version_id uuid; release_version_id uuid; operation_result jsonb; policy_id uuid;
  direct_mutation_grants integer;
  config jsonb:=jsonb_build_object(
    'syntheticOnly',true,
    'requirements',jsonb_build_array('bank_statement','invoice','contractor_statement','expense_receipt'),
    'deadlinePolicy',jsonb_build_object('basis','quarter_end_plus_15_days','timezone','Pacific/Auckland'),
    'owner',jsonb_build_object('actorRole','staff','managerRole','manager'),
    'handoff',jsonb_build_object('target','accounting_work_queue','requiresManagerApproval',true));
  passed_result jsonb:=jsonb_build_object(
    'syntheticOnly',true,'physicalObservations',63,'independentFamilies',60,
    'nearDuplicateObservationsExcluded',3,'unsafeAutoAcceptFamilies',0,
    'totalInputTokens',60000,'totalOutputTokens',6000,'estimatedCostUsd',0.48,
    'certifiedAutoAcceptDocumentTypeCodes',jsonb_build_array('bank_statement'),
    'byDocumentType',jsonb_build_array(jsonb_build_object('documentTypeCode','bank_statement',
      'independentFamilies',60,'precision',1,'precisionOneSided95LowerBound',0.9569,
      'autoAcceptEligible',true)));
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE organization_key='uat-accounting-firm';
  PERFORM public.dop_set_organization_context('uat-accounting-firm');
  SELECT id INTO admin_id FROM public.actors WHERE organization_id=org_id AND actor_type='admin' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO manager_id FROM public.actors WHERE organization_id=org_id AND actor_type='manager' AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO subject_id FROM public.subjects WHERE organization_id=org_id
    AND attributes @> '{"synthetic":true}'::jsonb AND status='active' ORDER BY created_at LIMIT 1;
  SELECT id INTO profile_version_id FROM public.classification_profile_versions WHERE organization_id=org_id AND status='published' ORDER BY published_at DESC LIMIT 1;
  SELECT id INTO release_version_id FROM public.classifier_release_versions WHERE organization_id=org_id AND status='published' ORDER BY published_at DESC LIMIT 1;
  IF admin_id IS NULL OR manager_id IS NULL OR subject_id IS NULL OR profile_version_id IS NULL OR release_version_id IS NULL THEN
    RAISE EXCEPTION 'M44 regression prerequisites unavailable';
  END IF;

  BEGIN
    operation_result:=public.dop_configure_classification_quality_policy(manager_id,subject_id,profile_version_id,
      release_version_id,ARRAY['invoice','expense_receipt','contractor_statement'],config,
      'Manager must remain unable to configure the statistical auto-accept gate.',
      gen_random_uuid(),gen_random_uuid(),'2026-08-17T01:00:00Z');
    RAISE EXCEPTION 'manager unexpectedly configured quality policy: %',operation_result;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  operation_result:=public.dop_configure_classification_quality_policy(admin_id,subject_id,profile_version_id,
    release_version_id,ARRAY['invoice','expense_receipt','contractor_statement'],config,
    'Configure a rollback-only synthetic first-client classification quality gate.',
    '14400000-0000-4000-8000-000000000001','14400000-0000-4000-8000-000000000002','2026-08-17T01:01:00Z');
  IF operation_result->>'outcome'<>'completed' OR jsonb_array_length(operation_result->'certifiedAutoAcceptDocumentTypeCodes')<>0 THEN
    RAISE EXCEPTION 'quality policy did not fail closed before evidence: %',operation_result;
  END IF;
  policy_id:=(operation_result->>'policyId')::uuid;

  operation_result:=public.dop_record_classification_quality_run(admin_id,policy_id,repeat('a',64),repeat('b',64),'failed',
    passed_result,'A failed run must never certify an auto-accept document type.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T01:02:00Z');
  IF operation_result->>'outcome'<>'conflict' OR operation_result->>'reason'<>'quality_result_invalid' THEN
    RAISE EXCEPTION 'failed run accepted certified codes: %',operation_result;
  END IF;

  operation_result:=public.dop_record_classification_quality_run(admin_id,policy_id,repeat('a',64),repeat('b',64),'passed',
    passed_result,'Record family-deduplicated synthetic classification quality evidence.',
    '14400000-0000-4000-8000-000000000003','14400000-0000-4000-8000-000000000004','2026-08-17T01:03:00Z');
  IF operation_result->>'outcome'<>'completed' OR operation_result#>>'{certifiedAutoAcceptDocumentTypeCodes,0}'<>'bank_statement' THEN
    RAISE EXCEPTION 'passing quality evidence was not recorded: %',operation_result;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.classification_quality_policies WHERE id=policy_id
      AND certified_auto_accept_document_type_codes=ARRAY['bank_statement']::text[]
      AND latest_quality_run_id=(operation_result->>'qualityRunId')::uuid) THEN
    RAISE EXCEPTION 'runtime quality gate was not updated';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND event_type='ClassificationQuality.RunRecorded' AND aggregate_id=subject_id
      AND payload->>'syntheticOnly'='true' AND payload->>'unsafeAutoAcceptFamilies'='0') THEN
    RAISE EXCEPTION 'quality audit event missing';
  END IF;

  operation_result:=public.dop_record_classification_quality_rescore(admin_id,
    (SELECT latest_quality_run_id FROM public.classification_quality_policies WHERE id=policy_id),
    '2.0','passed',passed_result,
    'Append a corrected scorer interpretation without another provider call.',
    gen_random_uuid(),gen_random_uuid(),'2026-08-17T01:04:00Z');
  IF operation_result->>'outcome'<>'completed' OR (operation_result->>'incrementalEstimatedCostUsd')::numeric<>0
      OR operation_result#>>'{certifiedAutoAcceptDocumentTypeCodes,0}'<>'bank_statement' THEN
    RAISE EXCEPTION 'zero-cost audited rescore failed: %',operation_result;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.classification_quality_runs WHERE id=(operation_result->>'qualityRunId')::uuid
      AND scorer_version='2.0' AND source_quality_run_id IS NOT NULL
      AND incremental_estimated_cost_usd=0) THEN RAISE EXCEPTION 'rescore lineage missing'; END IF;

  SELECT count(*) INTO direct_mutation_grants FROM information_schema.role_table_grants
   WHERE grantee='dop_app' AND table_schema='public'
     AND table_name IN ('classification_quality_policies','classification_quality_runs')
     AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF direct_mutation_grants<>0 THEN RAISE EXCEPTION 'dop_app received direct quality table mutation grants'; END IF;
END $$;

ROLLBACK;
