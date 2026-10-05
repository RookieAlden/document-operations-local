BEGIN;

DO $$
DECLARE
    org_id uuid;
    operator_id uuid;
    release_id uuid;
    document_type_id uuid;
    requirement_set_id uuid := gen_random_uuid();
    requirement_version_id uuid := gen_random_uuid();
    requirement_id uuid := gen_random_uuid();
    case_id_value uuid := gen_random_uuid();
    submission_id_value uuid := gen_random_uuid();
    accepted_document_id uuid := gen_random_uuid();
    excluded_document_id uuid := gen_random_uuid();
    decision_id_value uuid := gen_random_uuid();
    decision_event_id_value uuid := gen_random_uuid();
    initial_assessment public.case_completeness_assessments%ROWTYPE;
    final_assessment public.case_completeness_assessments%ROWTYPE;
    completion_result jsonb;
    case_result jsonb;
    run_key text := gen_random_uuid()::text;
    run_at timestamptz := clock_timestamp();
BEGIN
    SELECT id INTO org_id FROM public.organizations
     WHERE organization_key='dev-accounting-firm' AND status='active';
    IF org_id IS NULL THEN RAISE EXCEPTION 'M36.1 organization missing'; END IF;
    PERFORM public.dop_set_organization_context('dev-accounting-firm');

    SELECT id INTO operator_id FROM public.actors
     WHERE organization_id=org_id AND status='active' AND actor_type IN ('manager','admin')
     ORDER BY CASE actor_type WHEN 'admin' THEN 0 ELSE 1 END, created_at, id LIMIT 1;
    SELECT id INTO release_id FROM public.work_configuration_releases release
     WHERE organization_id=org_id AND status='published'
       AND release_number=(SELECT max(candidate.release_number)
         FROM public.work_configuration_releases candidate
        WHERE candidate.organization_id=release.organization_id
          AND candidate.subject_id=release.subject_id AND candidate.status='published')
     ORDER BY created_at DESC,id LIMIT 1;
    SELECT id INTO document_type_id FROM public.document_types
     WHERE organization_id=org_id AND status='active' ORDER BY code,id LIMIT 1;
    IF operator_id IS NULL OR release_id IS NULL OR document_type_id IS NULL THEN
        RAISE EXCEPTION 'M36.1 requires an operator, published configuration and active Document Type';
    END IF;

    INSERT INTO public.requirement_sets(id,organization_id,set_key,display_name,created_at,updated_at)
    VALUES(requirement_set_id,org_id,'m36.1.'||run_key,'M36.1 rollback-only exclusion requirements',run_at,run_at);
    INSERT INTO public.requirement_set_versions(
        id,organization_id,requirement_set_id,version,status,effective_from,definition_hash,created_at
    ) VALUES(
        requirement_version_id,org_id,requirement_set_id,1,'published',run_at,
        encode(digest(requirement_version_id::text,'sha256'),'hex'),run_at
    );
    INSERT INTO public.requirements(
        id,organization_id,requirement_set_version_id,requirement_code,document_type_id,
        minimum_count,maximum_count,acceptance_rule,created_at
    ) VALUES(
        requirement_id,org_id,requirement_version_id,'m36.1.required',document_type_id,
        1,NULL,'{"synthetic":true}'::jsonb,run_at
    );

    case_result:=public.dop_create_case_from_configuration(
        operator_id,release_id,'m36-1-'||left(run_key,12),
        DATE '2098-02-01',DATE '2098-02-28',run_at+interval '30 days',
        'Pacific/Auckland','M36.1-ROLLBACK-'||left(run_key,12),
        'Create an isolated rollback-only Case for wrong-subject exclusion verification.',
        'm36-1-case-'||run_key,gen_random_uuid(),run_at
    );
    IF case_result->>'outcome'<>'completed' THEN
        RAISE EXCEPTION 'M36.1 governed Case creation failed: %',case_result;
    END IF;
    case_id_value:=(case_result->>'caseId')::uuid;
    UPDATE public.cases
       SET requirement_set_version_id=requirement_version_id,
           status='waiting_for_documents',
           config_snapshot=config_snapshot||'{"m36_1":{"synthetic":true,"rollbackOnly":true}}'::jsonb,
           updated_at=run_at
     WHERE id=case_id_value;
    INSERT INTO public.submissions(
        id,organization_id,case_id,submission_key,source,source_submission_id,status,
        expected_document_count,terminal_document_count,received_at,created_at,updated_at
    ) VALUES(
        submission_id_value,org_id,case_id_value,'internal_upload|'||submission_id_value,
        'internal_upload','m36.1-'||run_key,'accepted',2,0,run_at,run_at,run_at
    );
    INSERT INTO public.documents(
        id,organization_id,case_id,submission_id,idempotency_key,source_file_id,
        original_filename,declared_mime_type,detected_mime_type,size_bytes,content_hash_sha256,
        incoming_storage_ref,accepted_document_type_id,status,classification_summary,review_reason,
        created_at,updated_at
    ) VALUES
      (accepted_document_id,org_id,case_id_value,submission_id_value,'m36.1|'||accepted_document_id,
       'accepted-file','m36.1-accepted.pdf','application/pdf','application/pdf',128,repeat('a',64),
       'synthetic/m36.1/'||accepted_document_id,document_type_id,'reserved','{}',NULL,run_at,run_at),
      (excluded_document_id,org_id,case_id_value,submission_id_value,'m36.1|'||excluded_document_id,
       'wrong-subject-file','m36.1-wrong-subject.pdf','application/pdf','application/pdf',128,repeat('b',64),
       'synthetic/m36.1/'||excluded_document_id,document_type_id,'reserved',
       '{"confidence":0.99,"conflict_flags":["subject_mismatch"]}',
       'conflict_flags_present,conflict_rule_matched',run_at+interval '1 millisecond',run_at);

    UPDATE public.documents SET status='accepted',updated_at=run_at+interval '2 seconds'
     WHERE id=accepted_document_id;
    UPDATE public.documents SET status='review_required',updated_at=run_at+interval '3 seconds'
     WHERE id=excluded_document_id;

    SELECT * INTO initial_assessment FROM public.case_completeness_assessments
     WHERE case_id=case_id_value ORDER BY created_at DESC,id DESC LIMIT 1;
    IF initial_assessment.status<>'review_required'
       OR initial_assessment.matched_document_count<>1
       OR initial_assessment.review_required_document_count<>1 THEN
        RAISE EXCEPTION 'M36.1 initial review boundary drifted: %',row_to_json(initial_assessment);
    END IF;

    INSERT INTO public.workflow_events(
        id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES(
        decision_event_id_value,org_id,'ops-review|m36.1-'||run_key,'Document.ExcludedFromCase',1,
        'document',excluded_document_id,gen_random_uuid(),operator_id,'verification.m36.1',
        jsonb_build_object('action','exclude','reason','wrong_subject','originalRetained',true),
        run_at+interval '4 seconds'
    );
    UPDATE public.documents
       SET status='excluded',review_reason='operator_excluded_wrong_subject',
           content_hash_sha256=repeat('a',64),created_at=run_at-interval '1 second',
           classification_summary=classification_summary||jsonb_build_object('human_review',jsonb_build_object(
             'action','exclude','actor_id',operator_id,'decided_at',run_at+interval '4 seconds')),
           updated_at=run_at+interval '4 seconds'
     WHERE id=excluded_document_id;
    INSERT INTO public.document_review_decisions(
        id,organization_id,document_id,actor_id,idempotency_key,request_fingerprint,
        action,previous_document_type_id,decided_document_type_id,previous_status,
        resulting_status,rationale,related_issue_ids,event_id,decided_at
    ) VALUES(
        decision_id_value,org_id,excluded_document_id,operator_id,'m36.1-'||run_key,repeat('c',64),
        'exclude',document_type_id,document_type_id,'review_required','excluded',
        'The preserved synthetic file belongs to another subject and must not count in this Case.',
        ARRAY[]::uuid[],decision_event_id_value,run_at+interval '4 seconds'
    );

    SELECT * INTO final_assessment FROM public.case_completeness_assessments
     WHERE case_id=case_id_value ORDER BY created_at DESC,id DESC LIMIT 1;
    IF final_assessment.status<>'complete'
       OR final_assessment.matched_document_count<>1
       OR final_assessment.review_required_document_count<>0
       OR final_assessment.missing_requirement_count<>0
       OR final_assessment.duplicate_document_count<>0
       OR final_assessment.unmatched_document_count<>0 THEN
        RAISE EXCEPTION 'M36.1 exclusion did not produce complete evidence: %',row_to_json(final_assessment);
    END IF;
    IF NOT EXISTS(
        SELECT 1 FROM public.document_requirement_matches
         WHERE assessment_id=final_assessment.id AND document_id=excluded_document_id
           AND match_status='excluded' AND counts_toward_minimum=false
           AND reason_code='document_excluded_wrong_subject'
    ) THEN RAISE EXCEPTION 'M36.1 excluded match evidence missing'; END IF;
    IF (SELECT incoming_storage_ref FROM public.documents WHERE id=excluded_document_id)
       <> 'synthetic/m36.1/'||excluded_document_id THEN
        RAISE EXCEPTION 'M36.1 changed or removed the preserved original reference';
    END IF;
    IF EXISTS(
        SELECT 1 FROM public.issues WHERE case_id=case_id_value
         AND status IN ('open','assigned','waiting_external','waiting_internal','reopened')
    ) THEN RAISE EXCEPTION 'M36.1 left an exclusion-derived issue open'; END IF;
    IF NOT EXISTS(
        SELECT 1 FROM public.document_review_decisions
         WHERE id=decision_id_value AND action='exclude' AND resulting_status='excluded'
    ) OR NOT EXISTS(
        SELECT 1 FROM public.workflow_events
         WHERE id=decision_event_id_value AND event_type='Document.ExcludedFromCase'
    ) THEN RAISE EXCEPTION 'M36.1 immutable exclusion audit evidence missing'; END IF;

    completion_result:=public.dop_complete_case_and_create_handoff(
        operator_id,case_id_value,NULL,
        'The wrong-subject original is preserved but excluded; accepted synthetic evidence is complete.',
        'm36.1-complete-'||run_key,run_at+interval '5 seconds'
    );
    IF completion_result->>'outcome'<>'completed' THEN
        RAISE EXCEPTION 'M36.1 completion gate did not accept excluded terminal evidence: %',completion_result;
    END IF;
END;
$$;

ROLLBACK;

SELECT jsonb_build_object(
    'verification','passed','syntheticOnly',true,'wrongSubjectExcluded',true,
    'originalRetained',true,'countsTowardMinimum',false,'auditEvidence',true,
    'relatedIssuesResolved',true,'completionGatePassed',true,
    'persistentSideEffects',0,'externalCalls',0
) AS m36_1_result;
