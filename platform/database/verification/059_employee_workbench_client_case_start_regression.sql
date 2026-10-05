BEGIN;

DO $$
DECLARE
    org_id uuid;
    staff_id uuid;
    package_version_id uuid;
    operation_id uuid := gen_random_uuid();
    result jsonb;
    created_case_id uuid;
    created_subject_id uuid;
    created_release_id uuid;
    initial_subjects integer;
    initial_cases integer;
    initial_releases integer;
    initial_delivery_jobs integer;
    after_subjects integer;
    after_cases integer;
    after_releases integer;
    abc_digest text;
    abc_digest_after text;
    at_time timestamptz := timestamptz '2026-09-02 03:00:00+00';
BEGIN
    org_id := public.dop_set_organization_context('uat-accounting-firm');
    SELECT id INTO staff_id FROM public.actors
     WHERE organization_id=org_id AND actor_type='staff' AND status='active'
     ORDER BY created_at,id LIMIT 1;
    SELECT version.id INTO package_version_id
      FROM public.work_configuration_package_versions version
      JOIN public.work_configuration_packages package
        ON package.organization_id=version.organization_id AND package.id=version.package_id
     WHERE version.organization_id=org_id AND version.status='published' AND package.status='active'
       AND package.current_published_version_id=version.id
       AND version.blueprint#>'{subjectDefaults,attributes,synthetic}'='true'::jsonb
       AND version.blueprint#>>'{workflow,frequency}'='quarterly'
     ORDER BY version.published_at,version.id LIMIT 1;
    IF org_id IS NULL OR staff_id IS NULL OR package_version_id IS NULL THEN
        RAISE EXCEPTION 'M59 employee workbench prerequisites unavailable';
    END IF;

    SELECT count(*) INTO initial_subjects FROM public.subjects WHERE organization_id=org_id;
    SELECT count(*) INTO initial_cases FROM public.cases WHERE organization_id=org_id;
    SELECT count(*) INTO initial_releases FROM public.work_configuration_releases WHERE organization_id=org_id;
    SELECT count(*) INTO initial_delivery_jobs FROM public.delivery_jobs WHERE organization_id=org_id;
    SELECT encode(digest(coalesce(string_agg(concat_ws('|',c.id::text,c.status,c.version::text,c.config_snapshot::text),',' ORDER BY c.id),'none'),'sha256'),'hex')
      INTO abc_digest
      FROM public.cases c JOIN public.subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
     WHERE c.organization_id=org_id AND s.subject_key='abc-xinghe-demo-001';

    result := public.dop_create_workbench_client_case(
      staff_id,package_version_id,'M46 Invalid Period Company',NULL,DATE '2098-01-02',DATE '2098-03-31',
      (SELECT jsonb_agg(jsonb_build_object('code',item->>'code','minimumCount',item->>'minimumCount','maximumCount',item->'maximumCount'))
         FROM public.work_configuration_package_versions version, jsonb_array_elements(version.blueprint->'requirements') item
        WHERE version.id=package_version_id),
      gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'outcome'<>'conflict' OR result->>'reason'<>'quarterly_period_invalid'
       OR EXISTS(SELECT 1 FROM public.subjects WHERE organization_id=org_id AND display_name='M46 Invalid Period Company') THEN
      RAISE EXCEPTION 'invalid employee command did not fail atomically: %',result;
    END IF;

    result := public.dop_create_workbench_client_case(
      staff_id,package_version_id,'M46 Employee Acceptance Company','M46 Synthetic Contact',
      DATE '2098-01-01',DATE '2098-03-31',
      (SELECT jsonb_agg(jsonb_build_object('code',item->>'code','minimumCount',(item->>'minimumCount')::integer,'maximumCount',item->'maximumCount'))
         FROM public.work_configuration_package_versions version, jsonb_array_elements(version.blueprint->'requirements') item
        WHERE version.id=package_version_id),
      operation_id,gen_random_uuid(),at_time+interval '1 second'
    );
    IF result->>'outcome'<>'completed' OR result->>'syntheticOnly'<>'true' OR result->>'externalCalls'<>'0' THEN
      RAISE EXCEPTION 'employee command failed: %',result;
    END IF;
    created_case_id := (result->>'caseId')::uuid;
    created_subject_id := (result->>'subjectId')::uuid;
    created_release_id := (result->>'releaseId')::uuid;

    IF NOT EXISTS(
      SELECT 1 FROM public.workbench_client_case_commands command
      JOIN public.subjects subject ON subject.organization_id=command.organization_id AND subject.id=command.subject_id
      JOIN public.work_configuration_releases release ON release.organization_id=command.organization_id AND release.id=command.configuration_release_id
      JOIN public.cases c ON c.organization_id=command.organization_id AND c.id=command.case_id
      WHERE command.organization_id=org_id AND command.idempotency_key=operation_id AND command.status='completed'
        AND subject.id=created_subject_id AND subject.subject_key LIKE 'client-%'
        AND subject.attributes @> '{"synthetic":true,"workbench_created":true}'::jsonb
        AND release.id=created_release_id AND release.status='published'
        AND c.id=created_case_id AND c.config_snapshot @> '{"synthetic_only":true}'::jsonb
    ) THEN RAISE EXCEPTION 'employee command result is not a governed completed aggregate'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.requirements requirement
      JOIN public.cases c ON c.organization_id=requirement.organization_id
       AND c.requirement_set_version_id=requirement.requirement_set_version_id
      WHERE c.id=created_case_id GROUP BY c.id HAVING count(*)>0 AND sum(requirement.minimum_count)>0) THEN
      RAISE EXCEPTION 'employee-selected requirements were not materialized';
    END IF;

    SELECT count(*) INTO after_subjects FROM public.subjects WHERE organization_id=org_id;
    SELECT count(*) INTO after_cases FROM public.cases WHERE organization_id=org_id;
    SELECT count(*) INTO after_releases FROM public.work_configuration_releases WHERE organization_id=org_id;
    result := public.dop_create_workbench_client_case(
      staff_id,package_version_id,'M46 Employee Acceptance Company','M46 Synthetic Contact',
      DATE '2098-01-01',DATE '2098-03-31',
      (SELECT jsonb_agg(jsonb_build_object('code',item->>'code','minimumCount',(item->>'minimumCount')::integer,'maximumCount',item->'maximumCount'))
         FROM public.work_configuration_package_versions version, jsonb_array_elements(version.blueprint->'requirements') item
        WHERE version.id=package_version_id),
      operation_id,gen_random_uuid(),at_time+interval '2 seconds'
    );
    IF result->>'outcome'<>'duplicate' OR (result->>'caseId')::uuid<>created_case_id
       OR after_subjects<>(SELECT count(*) FROM public.subjects WHERE organization_id=org_id)
       OR after_cases<>(SELECT count(*) FROM public.cases WHERE organization_id=org_id)
       OR after_releases<>(SELECT count(*) FROM public.work_configuration_releases WHERE organization_id=org_id) THEN
      RAISE EXCEPTION 'employee command replay was not idempotent: %',result;
    END IF;
    result := public.dop_create_workbench_client_case(
      staff_id,package_version_id,'Changed Name Must Conflict',NULL,DATE '2098-01-01',DATE '2098-03-31',
      '[{"code":"bank.minimum","minimumCount":1,"maximumCount":1}]'::jsonb,
      operation_id,gen_random_uuid(),at_time+interval '3 seconds'
    );
    IF result->>'outcome'<>'conflict' OR result->>'reason'<>'idempotency_key_reused' THEN
      RAISE EXCEPTION 'changed replay did not fail closed: %',result;
    END IF;

    result := public.dop_workbench_issue_case_invitation(
      staff_id,created_case_id,encode(digest('m46-employee-invitation','sha256'),'hex'),20,
      at_time+interval '14 days',gen_random_uuid(),gen_random_uuid(),at_time+interval '4 seconds'
    );
    IF result->>'outcome'<>'completed' OR result->>'status'<>'active' THEN
      RAISE EXCEPTION 'employee invitation issuance failed: %',result;
    END IF;
    IF (SELECT count(*) FROM public.delivery_jobs WHERE organization_id=org_id)<>initial_delivery_jobs THEN
      RAISE EXCEPTION 'employee workflow unexpectedly created an outbound delivery job';
    END IF;

    SELECT encode(digest(coalesce(string_agg(concat_ws('|',c.id::text,c.status,c.version::text,c.config_snapshot::text),',' ORDER BY c.id),'none'),'sha256'),'hex')
      INTO abc_digest_after
      FROM public.cases c JOIN public.subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
     WHERE c.organization_id=org_id AND s.subject_key='abc-xinghe-demo-001';
    IF abc_digest IS DISTINCT FROM abc_digest_after THEN RAISE EXCEPTION 'ABC successful Case was modified'; END IF;
    IF (SELECT count(*) FROM public.subjects WHERE organization_id=org_id)<>initial_subjects+1
       OR (SELECT count(*) FROM public.cases WHERE organization_id=org_id)<>initial_cases+1
       OR (SELECT count(*) FROM public.work_configuration_releases WHERE organization_id=org_id)<>initial_releases+1 THEN
      RAISE EXCEPTION 'employee command aggregate counts are unexpected';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.workbench_client_case_commands'::regclass)
       OR EXISTS(SELECT 1 FROM information_schema.role_table_grants WHERE grantee IN ('dop_app','dop_app_uat')
          AND table_schema='public' AND table_name='workbench_client_case_commands'
          AND privilege_type IN ('INSERT','UPDATE','DELETE'))
       OR NOT has_function_privilege('dop_app','public.dop_create_workbench_client_case(uuid,uuid,text,text,date,date,jsonb,uuid,uuid,timestamptz)','EXECUTE') THEN
      RAISE EXCEPTION 'employee workbench RLS or function-only mutation boundary regressed';
    END IF;
END;
$$;

SELECT jsonb_build_object(
  'verification','passed','staffClientCaseCreation',true,'atomicRecovery',true,'idempotentReplay',true,
  'changedReplayFailedClosed',true,'syntheticBoundary',true,'governedInvitation',true,
  'abcSuccessfulCaseUnchanged',true,'externalSends',0,'persistentSideEffects',0
) AS m59_result;

ROLLBACK;
