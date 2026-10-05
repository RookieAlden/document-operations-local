BEGIN;

DO $$
DECLARE
    org public.organizations%ROWTYPE;
    operator_id uuid;
    release_id uuid;
    case_id_value uuid;
    document_id_value uuid := gen_random_uuid();
    submission_id_value uuid := gen_random_uuid();
    assessment_id_value uuid := gen_random_uuid();
    assessment_event_id_value uuid := gen_random_uuid();
    run_key text := gen_random_uuid()::text;
    at_time timestamptz := date_trunc('second', now());
    result jsonb;
    task_id_value uuid;
BEGIN
    SELECT * INTO org FROM public.organizations ORDER BY created_at, id LIMIT 1;
    IF org.id IS NULL THEN RAISE EXCEPTION 'M36 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(org.organization_key);
    SELECT id INTO operator_id FROM public.actors
     WHERE organization_id=org.id AND actor_type IN ('manager','admin') AND status='active'
     ORDER BY CASE actor_type WHEN 'admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1;
    SELECT id INTO release_id FROM public.work_configuration_releases release
     WHERE organization_id=org.id AND status='published'
       AND release_number=(SELECT max(candidate.release_number)
         FROM public.work_configuration_releases candidate
        WHERE candidate.organization_id=release.organization_id
          AND candidate.subject_id=release.subject_id AND candidate.status='published')
     ORDER BY created_at DESC, id LIMIT 1;
    IF operator_id IS NULL OR release_id IS NULL THEN
        RAISE EXCEPTION 'M36 requires one active manager/admin and one current published configuration';
    END IF;

    result := public.dop_create_case_from_configuration(
        operator_id, release_id, 'm36-' || left(run_key, 12),
        DATE '2098-01-01', DATE '2098-01-31', at_time + interval '30 days',
        'Pacific/Auckland', 'M36-SYNTHETIC-ONLY',
        'Create an isolated rollback-only Case for the personal synthetic trial regression.',
        'm36-case-' || run_key, gen_random_uuid(), at_time
    );
    IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'M36 Case creation failed: %', result; END IF;
    case_id_value := (result->>'caseId')::uuid;

    result := public.dop_accept_stored_ops_upload(
        operator_id, case_id_value, document_id_value, submission_id_value,
        'm36-synthetic-statement.pdf', 'application/pdf', 31,
        encode(digest('m36-synthetic-content-' || run_key, 'sha256'), 'hex'),
        'supabase://dop-incoming-dev/' || org.organization_key || '/' || document_id_value::text || '/synthetic.pdf',
        'ops-upload|' || case_id_value::text || '|' || encode(digest(run_key, 'sha256'), 'hex'), at_time
    );
    IF result->>'outcome'<>'completed' OR result->>'documentStatus'<>'incoming_saved' THEN
        RAISE EXCEPTION 'M36 stored upload was not accepted: %', result;
    END IF;
    result := public.dop_accept_stored_ops_upload(
        operator_id, case_id_value, document_id_value, submission_id_value,
        'm36-synthetic-statement.pdf', 'application/pdf', 31,
        encode(digest('m36-synthetic-content-' || run_key, 'sha256'), 'hex'),
        'supabase://dop-incoming-dev/' || org.organization_key || '/' || document_id_value::text || '/synthetic.pdf',
        'ops-upload|' || case_id_value::text || '|' || encode(digest(run_key, 'sha256'), 'hex'), at_time
    );
    IF result->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'M36 upload replay was not idempotent: %', result; END IF;
    IF (SELECT count(*) FROM public.documents WHERE organization_id=org.id AND case_id=case_id_value)<>1
       OR (SELECT count(*) FROM public.submissions WHERE organization_id=org.id AND case_id=case_id_value)<>1 THEN
        RAISE EXCEPTION 'M36 upload replay created duplicate rows';
    END IF;

    result := public.dop_complete_case_and_create_handoff(
        operator_id, case_id_value, NULL,
        'Completion must fail before current completeness evidence passes.',
        'm36-complete-blocked-' || run_key, at_time
    );
    IF result->>'reason'<>'completeness_not_complete' THEN
        RAISE EXCEPTION 'M36 completion did not fail closed before evidence: %', result;
    END IF;

    -- Classification and matching are covered by their own regressions. This
    -- transaction supplies a terminal synthetic document and a later immutable
    -- complete assessment to isolate the completion/handoff atomicity contract.
    UPDATE public.documents SET status='accepted', updated_at=at_time+interval '1 second'
     WHERE organization_id=org.id AND id=document_id_value;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (
        assessment_event_id_value,org.id,'m36-completeness-event-'||run_key,
        'Case.CompletenessAssessed',1,'case',case_id_value,gen_random_uuid(),operator_id,
        'verification.m36',jsonb_build_object('synthetic',true,'status','complete'),at_time+interval '2 seconds'
    );
    INSERT INTO public.case_completeness_assessments (
        id,organization_id,case_id,calculated_after_submission_id,requirement_set_version_id,
        algorithm_version,input_hash,status,matched_document_count,missing_requirement_count,
        duplicate_document_count,excess_document_count,review_required_document_count,
        unmatched_document_count,active_submission_count,result,event_id,created_at
    ) SELECT assessment_id_value,org.id,case_id_value,submission_id_value,c.requirement_set_version_id,
        '1.0',encode(digest('m36-complete-'||run_key,'sha256'),'hex'),'complete',1,0,0,0,0,0,1,
        jsonb_build_object('algorithmVersion','1.0','status','complete','requirements','[]'::jsonb,
          'processingDocumentCount',0,'syntheticVerificationFixture',true),
        assessment_event_id_value,at_time+interval '2 seconds'
      FROM public.cases c WHERE c.organization_id=org.id AND c.id=case_id_value;
    PERFORM public.dop_sync_completeness_exceptions(assessment_id_value, at_time+interval '2 seconds');

    result := public.dop_complete_case_and_create_handoff(
        operator_id, case_id_value, NULL,
        'All synthetic evidence is complete; create the single internal next-step handoff task.',
        'm36-complete-' || run_key, at_time+interval '3 seconds'
    );
    IF result->>'outcome'<>'completed' THEN RAISE EXCEPTION 'M36 atomic completion failed: %', result; END IF;
    task_id_value := (result->>'taskId')::uuid;
    result := public.dop_complete_case_and_create_handoff(
        operator_id, case_id_value, NULL,
        'All synthetic evidence is complete; create the single internal next-step handoff task.',
        'm36-complete-' || run_key, at_time+interval '3 seconds'
    );
    IF result->>'outcome'<>'duplicate' OR (result->>'taskId')::uuid<>task_id_value THEN
        RAISE EXCEPTION 'M36 completion replay created a different result: %', result;
    END IF;
    IF (SELECT status FROM public.cases WHERE organization_id=org.id AND id=case_id_value)<>'completed'
       OR (SELECT count(*) FROM public.tasks WHERE organization_id=org.id AND case_id=case_id_value)<>1
       OR (SELECT count(*) FROM public.workflow_events WHERE organization_id=org.id
            AND idempotency_key IN ('case-completed|'||case_id_value::text,'handoff-task-created|'||case_id_value::text))<>2 THEN
        RAISE EXCEPTION 'M36 completion, task and audit evidence were not atomic';
    END IF;
    IF NOT has_function_privilege('dop_app',
          'public.dop_accept_stored_ops_upload(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app',
          'public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz)','EXECUTE')
       OR (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname IN ('documents','tasks') AND c.relrowsecurity)<>2 THEN
        RAISE EXCEPTION 'M36 application write boundary is incorrect';
    END IF;
END;
$$;

SELECT jsonb_build_object(
    'verification','passed','syntheticOnly',true,'uploadReplaySafe',true,
    'completionFailsClosed',true,'caseCompleted',true,'handoffTaskCount',1,
    'externalCalls',0,'persistentSideEffects',0
) AS m36_result;

ROLLBACK;
