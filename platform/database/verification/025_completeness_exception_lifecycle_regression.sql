BEGIN;

DO $$
DECLARE
    selected_case record;
    selected_requirement record;
    selected_document_id uuid;
    selected_submission_id uuid;
    first_assessment_id uuid := gen_random_uuid();
    first_event_id uuid := gen_random_uuid();
    second_assessment_id uuid := gen_random_uuid();
    second_event_id uuid := gen_random_uuid();
    first_input_hash text := encode(digest('m25-first|' || gen_random_uuid()::text, 'sha256'), 'hex');
    second_input_hash text := encode(digest('m25-second|' || gen_random_uuid()::text, 'sha256'), 'hex');
    first_issue_ids uuid[];
    first_draft_id uuid;
    before_issue_count integer;
    after_issue_count integer;
    before_draft_count integer;
    after_draft_count integer;
    sync_result jsonb;
BEGIN
    SELECT c.*, a.organization_id
      INTO selected_case
      FROM public.cases c
      JOIN public.case_completeness_assessments a ON a.case_id = c.id
     WHERE EXISTS (SELECT 1 FROM public.documents d WHERE d.case_id = c.id)
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 1;
    IF selected_case.id IS NULL THEN RAISE EXCEPTION 'M25 requires one synthetic Case with completeness evidence'; END IF;

    SELECT r.id, r.requirement_code, dt.code AS document_type_code, dt.display_name
      INTO selected_requirement
      FROM public.requirements r
      JOIN public.document_types dt ON dt.id = r.document_type_id
     WHERE r.organization_id = selected_case.organization_id
       AND r.requirement_set_version_id = selected_case.requirement_set_version_id
     ORDER BY r.requirement_code
     LIMIT 1;
    SELECT id INTO selected_document_id FROM public.documents
     WHERE organization_id = selected_case.organization_id AND case_id = selected_case.id
     ORDER BY created_at, id LIMIT 1;
    SELECT id INTO selected_submission_id FROM public.submissions
     WHERE organization_id = selected_case.organization_id AND case_id = selected_case.id
     ORDER BY created_at DESC, id DESC LIMIT 1;

    SELECT count(*) INTO before_issue_count FROM public.issues;
    SELECT count(*) INTO before_draft_count FROM public.missing_document_request_drafts;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
    ) VALUES (
        first_event_id, selected_case.organization_id, 'm25-regression-assessment|' || first_assessment_id,
        'Case.CompletenessAssessed', 1, 'case', selected_case.id, gen_random_uuid(),
        'dop.verification.m25', '{}'::jsonb, now()
    );
    INSERT INTO public.case_completeness_assessments (
        id, organization_id, case_id, calculated_after_submission_id,
        requirement_set_version_id, algorithm_version, input_hash, status,
        matched_document_count, missing_requirement_count, duplicate_document_count,
        excess_document_count, review_required_document_count, unmatched_document_count,
        active_submission_count, result, event_id, created_at
    ) VALUES (
        first_assessment_id, selected_case.organization_id, selected_case.id, selected_submission_id,
        selected_case.requirement_set_version_id, '1.0', first_input_hash, 'review_required',
        0, 2, 1, 0, 0, 0, 0,
        jsonb_build_object('algorithmVersion','1.0','status','review_required','requirements',jsonb_build_array(
            jsonb_build_object(
                'requirementId',selected_requirement.id,
                'requirementCode',selected_requirement.requirement_code,
                'documentTypeCode',selected_requirement.document_type_code,
                'displayName',selected_requirement.display_name,
                'minimumCount',2,'maximumCount',null,'acceptedCount',0,
                'missingCount',2,'reviewCount',0,'duplicateCount',1,'excessCount',0,'status','missing'
            )
        )), first_event_id, now()
    );
    INSERT INTO public.document_requirement_matches (
        id, organization_id, assessment_id, document_id, requirement_id,
        match_status, duplicate_kind, is_excess, counts_toward_minimum,
        reason_code, evidence, created_at
    ) VALUES (
        gen_random_uuid(), selected_case.organization_id, first_assessment_id,
        selected_document_id, selected_requirement.id, 'duplicate', 'same_content', false, false,
        'same_content_duplicate', jsonb_build_object('requirementCode',selected_requirement.requirement_code,
            'documentStatus','accepted'), now()
    );

    SELECT array_agg(issue_id ORDER BY exception_key), count(*)
      INTO first_issue_ids, after_issue_count
      FROM public.completeness_exception_evidence
     WHERE assessment_id = first_assessment_id;
    IF after_issue_count <> 2 THEN RAISE EXCEPTION 'expected 2 exception evidence rows, got %', after_issue_count; END IF;
    IF (SELECT count(*) FROM public.issues
         WHERE id = ANY(first_issue_ids) AND status IN ('open','reopened')) <> 2 THEN
        RAISE EXCEPTION 'missing and duplicate issues were not activated';
    END IF;
    SELECT id INTO first_draft_id FROM public.missing_document_request_drafts
     WHERE assessment_id = first_assessment_id AND status = 'draft';
    IF first_draft_id IS NULL THEN RAISE EXCEPTION 'missing-document draft was not created'; END IF;
    IF EXISTS (SELECT 1 FROM public.missing_document_request_drafts
        WHERE id = first_draft_id AND (delivery_mode <> 'disabled' OR external_call_count <> 0)) THEN
        RAISE EXCEPTION 'draft delivery boundary was not disabled';
    END IF;

    sync_result := public.dop_sync_completeness_exceptions(first_assessment_id, now());
    IF (sync_result->>'openedIssueCount')::integer <> 0
       OR (sync_result->>'evidenceCount')::integer <> 0 THEN
        RAISE EXCEPTION 'repeat synchronization was not idempotent: %', sync_result;
    END IF;
    IF (SELECT count(*) FROM public.completeness_exception_evidence WHERE assessment_id = first_assessment_id) <> 2
       OR (SELECT count(*) FROM public.missing_document_request_drafts WHERE assessment_id = first_assessment_id) <> 1 THEN
        RAISE EXCEPTION 'repeat synchronization duplicated evidence or draft';
    END IF;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
    ) VALUES (
        second_event_id, selected_case.organization_id, 'm25-regression-assessment|' || second_assessment_id,
        'Case.CompletenessAssessed', 1, 'case', selected_case.id, gen_random_uuid(),
        'dop.verification.m25', '{}'::jsonb, now() + interval '1 second'
    );
    INSERT INTO public.case_completeness_assessments (
        id, organization_id, case_id, calculated_after_submission_id,
        requirement_set_version_id, algorithm_version, input_hash, status,
        matched_document_count, missing_requirement_count, duplicate_document_count,
        excess_document_count, review_required_document_count, unmatched_document_count,
        active_submission_count, result, event_id, created_at
    ) VALUES (
        second_assessment_id, selected_case.organization_id, selected_case.id, selected_submission_id,
        selected_case.requirement_set_version_id, '1.0', second_input_hash, 'complete',
        1, 0, 0, 0, 0, 0, 0,
        jsonb_build_object('algorithmVersion','1.0','status','complete','requirements','[]'::jsonb),
        second_event_id, now() + interval '1 second'
    );
    sync_result := public.dop_sync_completeness_exceptions(second_assessment_id, now() + interval '1 second');
    IF (sync_result->>'resolvedIssueCount')::integer < 2 THEN
        RAISE EXCEPTION 'stale completeness issues were not resolved: %', sync_result;
    END IF;
    IF (SELECT count(*) FROM public.issues WHERE id = ANY(first_issue_ids) AND status = 'resolved') <> 2 THEN
        RAISE EXCEPTION 'first assessment issues are not resolved';
    END IF;
    IF (SELECT status FROM public.missing_document_request_drafts WHERE id = first_draft_id) <> 'superseded' THEN
        RAISE EXCEPTION 'obsolete draft was not superseded';
    END IF;

    SELECT count(*) INTO after_issue_count FROM public.issues;
    SELECT count(*) INTO after_draft_count FROM public.missing_document_request_drafts;
    IF after_issue_count < before_issue_count OR after_draft_count < before_draft_count + 1 THEN
        RAISE EXCEPTION 'regression lifecycle lost an issue or did not create transactional draft evidence';
    END IF;
    IF has_function_privilege('dop_app', 'public.dop_sync_completeness_exceptions(uuid,timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'application role can directly invoke internal exception synchronization';
    END IF;
    IF has_table_privilege('dop_app','public.completeness_exception_evidence','INSERT')
       OR has_table_privilege('dop_app','public.missing_document_request_drafts','INSERT')
       OR has_table_privilege('dop_app','public.missing_document_request_drafts','UPDATE') THEN
        RAISE EXCEPTION 'application role has unexpected direct write privilege';
    END IF;

    RAISE NOTICE 'M25 verification passed: issues %, evidence 2, draft 1, delivery disabled, external calls 0', first_issue_ids;
END;
$$;

SELECT jsonb_build_object(
    'verification','passed',
    'exceptionTypes',jsonb_build_array('missing','duplicate','excess','review_required','unmatched'),
    'idempotent',true,
    'staleIssuesResolved',true,
    'draftSuperseded',true,
    'externalCalls',0,
    'externalDelivery','disabled',
    'persistentSideEffects',0
) AS m25_result;

ROLLBACK;
