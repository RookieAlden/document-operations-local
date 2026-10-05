BEGIN;

DO $$
DECLARE
    org_id uuid;
    admin_id uuid;
    package_version_id uuid;
    synthetic_subject_key text := 'm58-synth-' || left(replace(gen_random_uuid()::text, '-', ''), 12);
    synthetic_release_id uuid;
    synthetic_case_id uuid;
    nonsynthetic_case_id uuid;
    connector_key text := 'm58.synthetic-entry.' || left(replace(gen_random_uuid()::text, '-', ''), 12);
    entry_id uuid;
    result jsonb;
    token_hash text := encode(digest('m58-synthetic-case-entry-token-' || gen_random_uuid()::text, 'sha256'), 'hex');
    at_time timestamptz := timestamptz '2026-09-02 01:00:00+00';
    direct_case_mutation_grants integer;
BEGIN
    org_id := public.dop_set_organization_context('uat-accounting-firm');
    SELECT id INTO admin_id FROM public.actors
     WHERE organization_id = org_id AND actor_type = 'admin' AND status = 'active'
     ORDER BY created_at, id LIMIT 1;
    SELECT version.id INTO package_version_id
      FROM public.work_configuration_package_versions version
      JOIN public.work_configuration_packages package
        ON package.organization_id = version.organization_id AND package.id = version.package_id
     WHERE version.organization_id = org_id
       AND version.status = 'published' AND package.status = 'active'
     ORDER BY version.published_at, version.id LIMIT 1;
    IF org_id IS NULL OR admin_id IS NULL OR package_version_id IS NULL THEN
        RAISE EXCEPTION 'M58 onboarding prerequisites unavailable';
    END IF;

    result := public.dop_onboard_subject_from_package(
        admin_id, package_version_id, synthetic_subject_key,
        'M58 Synthetic Entry Company Limited', 'accounting_client', NULL,
        '{"synthetic":true,"regression":"M58"}'::jsonb,
        'Create a rollback-only synthetic company for the M58 entry regression.',
        'm58-onboard-synthetic-' || synthetic_subject_key, gen_random_uuid(), at_time
    );
    IF result->>'outcome' <> 'completed' THEN
        RAISE EXCEPTION 'synthetic onboarding failed: %', result;
    END IF;
    synthetic_release_id := (result->>'releaseId')::uuid;

    result := public.dop_transition_configuration_release(
        admin_id, synthetic_release_id, 'submit_review',
        'Submit the rollback-only M58 synthetic configuration for review.',
        'm58-review-synthetic-' || synthetic_subject_key, gen_random_uuid(), at_time + interval '1 second'
    );
    IF result->>'outcome' <> 'completed' THEN RAISE EXCEPTION 'synthetic review failed: %', result; END IF;
    synthetic_release_id := (result->>'releaseId')::uuid;
    result := public.dop_transition_configuration_release(
        admin_id, synthetic_release_id, 'publish',
        'Publish the rollback-only M58 synthetic configuration for Case creation.',
        'm58-publish-synthetic-' || synthetic_subject_key, gen_random_uuid(), at_time + interval '2 seconds'
    );
    IF result->>'outcome' <> 'completed' THEN RAISE EXCEPTION 'synthetic publish failed: %', result; END IF;
    synthetic_release_id := (result->>'releaseId')::uuid;

    result := public.dop_create_case_from_configuration(
        admin_id, synthetic_release_id, '2099-Q4', DATE '2099-10-01', DATE '2099-12-31',
        at_time + interval '30 days', 'Pacific/Auckland', 'M58-SYNTHETIC-ENTRY',
        'Create the rollback-only synthetic Case for the M58 entry regression.',
        'm58-case-synthetic-' || synthetic_subject_key, gen_random_uuid(), at_time + interval '3 seconds'
    );
    IF result->>'outcome' <> 'completed' OR result->>'syntheticOnly' <> 'true' THEN
        RAISE EXCEPTION 'synthetic Case creation did not propagate the boundary: %', result;
    END IF;
    synthetic_case_id := (result->>'caseId')::uuid;
    IF NOT EXISTS (
        SELECT 1 FROM public.cases c
        JOIN public.subjects s ON s.organization_id = c.organization_id AND s.id = c.subject_id
        WHERE c.organization_id = org_id AND c.id = synthetic_case_id
          AND s.attributes @> '{"synthetic":true}'::jsonb
          AND c.config_snapshot @> '{"synthetic_only":true}'::jsonb
          AND c.status IN ('not_started','waiting_for_documents','review_required','ready','in_progress')
    ) THEN RAISE EXCEPTION 'new synthetic Case is absent from the governed eligibility predicate'; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.workflow_events
         WHERE organization_id = org_id AND aggregate_id = synthetic_case_id
           AND event_type = 'Case.CreatedFromConfiguration'
           AND payload @> '{"synthetic_only":true}'::jsonb
           AND payload->>'synthetic_boundary_source' = 'subject.attributes.synthetic_json_boolean'
    ) THEN RAISE EXCEPTION 'synthetic Case creation audit evidence is incomplete'; END IF;

    result := public.dop_create_uat_synthetic_demo_form_connector(
        admin_id, connector_key, 'M58 Synthetic Entry Connector',
        'Rollback-only connector proving a newly onboarded synthetic Case can receive an invitation.',
        'railway://uat/intake/DOP_FORM_CONNECTOR_TOKEN',
        ARRAY['application/pdf','image/jpeg','image/png'], 5, 52428800,
        'Create a rollback-only governed connector for the M58 regression.',
        'm58-connector-' || synthetic_subject_key, gen_random_uuid(), at_time + interval '4 seconds'
    );
    IF result->>'outcome' <> 'completed' OR result->>'externalCallCount' <> '0' THEN
        RAISE EXCEPTION 'M58 rollback connector failed: %', result;
    END IF;
    result := public.dop_create_demo_form_entry(
        admin_id, 'm58.synthetic-entry.' || left(replace(gen_random_uuid()::text, '-', ''), 12),
        connector_key, 'm58-regression-form-' || synthetic_subject_key,
        ARRAY['application/pdf','image/jpeg','image/png'], 5, 52428800, false,
        'Activate a rollback-only governed entry for the M58 regression.',
        gen_random_uuid(), gen_random_uuid(), at_time + interval '5 seconds'
    );
    IF result->>'outcome' <> 'completed' THEN RAISE EXCEPTION 'M58 rollback entry failed: %', result; END IF;
    entry_id := (result->>'entryVersionId')::uuid;
    result := public.dop_issue_demo_case_invitation(
        admin_id, entry_id, synthetic_case_id, token_hash, '2099-Q4', true, true, 2,
        at_time, at_time + interval '7 days',
        'Issue a rollback-only invitation proving new synthetic Case eligibility.',
        gen_random_uuid(), gen_random_uuid(), at_time + interval '6 seconds'
    );
    IF result->>'outcome' <> 'completed' OR result->>'status' <> 'active' THEN
        RAISE EXCEPTION 'new synthetic Case could not receive an invitation: %', result;
    END IF;

    -- The UAT onboarding package deliberately locks synthetic=true. Change only
    -- this rollback-only fixture after its positive path has passed so the same
    -- current published release exercises the function's explicit false branch.
    UPDATE public.subjects
       SET attributes = jsonb_set(attributes, '{synthetic}', 'false'::jsonb, true),
           updated_at = at_time + interval '7 seconds'
     WHERE organization_id = org_id AND subject_key = synthetic_subject_key;
    result := public.dop_create_case_from_configuration(
        admin_id, synthetic_release_id, '2100-Q1', DATE '2100-01-01', DATE '2100-03-31',
        at_time + interval '30 days', 'Pacific/Auckland', 'M58-NON-SYNTHETIC-BOUNDARY',
        'Create the rollback-only non-synthetic Case for the M58 boundary test.',
        'm58-case-real-' || synthetic_subject_key, gen_random_uuid(), at_time + interval '8 seconds'
    );
    IF result->>'outcome' <> 'completed' OR result->>'syntheticOnly' <> 'false' THEN
        RAISE EXCEPTION 'non-synthetic Case creation result is incorrect: %', result;
    END IF;
    nonsynthetic_case_id := (result->>'caseId')::uuid;
    IF (SELECT config_snapshot ? 'synthetic_only' FROM public.cases WHERE id = nonsynthetic_case_id)
       OR EXISTS (
          SELECT 1 FROM public.cases c
          JOIN public.subjects s ON s.organization_id = c.organization_id AND s.id = c.subject_id
          WHERE c.id = nonsynthetic_case_id
            AND s.attributes @> '{"synthetic":true}'::jsonb
            AND c.config_snapshot @> '{"synthetic_only":true}'::jsonb
       ) THEN RAISE EXCEPTION 'non-synthetic Case entered the synthetic eligibility boundary'; END IF;
    result := public.dop_issue_demo_case_invitation(
        admin_id, entry_id, nonsynthetic_case_id, repeat('f', 64), '2100-Q1', true, true, 2,
        at_time, at_time + interval '7 days',
        'Verify that the non-synthetic rollback Case fails the invitation boundary.',
        gen_random_uuid(), gen_random_uuid(), at_time + interval '9 seconds'
    );
    IF result->>'outcome' <> 'conflict' OR result->>'reason' <> 'synthetic_scope_required' THEN
        RAISE EXCEPTION 'non-synthetic Case did not fail invitation issuance closed: %', result;
    END IF;

    SELECT count(*) INTO direct_case_mutation_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat')
       AND table_schema = 'public' AND table_name = 'cases'
       AND privilege_type IN ('INSERT','UPDATE','DELETE');
    IF direct_case_mutation_grants <> 0 OR NOT has_function_privilege(
        'dop_app',
        'public.dop_create_case_from_configuration(uuid,uuid,text,date,date,timestamptz,text,text,text,text,uuid,timestamptz)',
        'EXECUTE'
    ) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cases'::regclass) THEN
        RAISE EXCEPTION 'Case RLS or function-only write boundary regressed';
    END IF;
END;
$$;

SELECT jsonb_build_object(
    'verification', 'passed',
    'newSyntheticCompanyOnboarded', true,
    'configurationPublished', true,
    'caseMarkerPropagated', true,
    'eligibleForClientEntry', true,
    'invitationIssuable', true,
    'nonSyntheticFailedClosed', true,
    'externalCalls', 0,
    'persistentSideEffects', 0
) AS m58_result;

ROLLBACK;
