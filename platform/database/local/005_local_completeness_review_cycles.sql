-- Local-only fix: returning to an earlier accepted state must create a current assessment.
-- Retains all existing completeness rules and immutable assessment history.
CREATE OR REPLACE FUNCTION public.dop_recompute_submission_completeness(p_submission_id uuid, p_now timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    submission_row public.submissions%ROWTYPE;
    case_row public.cases%ROWTYPE;
    terminal_count_value integer;
    submission_complete boolean;
    requirement_input jsonb;
    document_input jsonb;
    submission_input jsonb;
    input_hash_value text;
    assessment_id_value uuid := gen_random_uuid();
    event_id_value uuid := gen_random_uuid();
    correlation_id_value uuid := gen_random_uuid();
    existing_assessment_id uuid;
    assessment_status_value text;
    matched_count_value integer := 0;
    missing_count_value integer := 0;
    duplicate_count_value integer := 0;
    excess_count_value integer := 0;
    review_count_value integer := 0;
    unmatched_count_value integer := 0;
    processing_count_value integer := 0;
    active_submission_count_value integer := 0;
    requirement_results jsonb := '[]'::jsonb;
BEGIN
    SELECT * INTO submission_row
      FROM public.submissions
     WHERE id = p_submission_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT count(*)::integer INTO terminal_count_value
      FROM public.documents
     WHERE organization_id = submission_row.organization_id
       AND submission_id = submission_row.id
       AND status IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped','excluded');

    submission_complete := submission_row.expected_document_count IS NOT NULL
        AND terminal_count_value = submission_row.expected_document_count;

    UPDATE public.submissions
       SET terminal_document_count = terminal_count_value,
           status = CASE
               WHEN submission_complete THEN 'completed'
               WHEN status IN ('rejected','failed_manual') THEN status
               ELSE 'processing'
           END,
           completed_at = CASE WHEN submission_complete THEN coalesce(completed_at, p_now) ELSE NULL END,
           updated_at = p_now
     WHERE id = submission_row.id;

    IF NOT submission_complete THEN RETURN NULL; END IF;

    SELECT * INTO case_row
      FROM public.cases
     WHERE organization_id = submission_row.organization_id
       AND id = submission_row.case_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'code', r.requirement_code,
               'documentTypeId', r.document_type_id,
               'minimumCount', r.minimum_count,
               'maximumCount', r.maximum_count,
               'acceptanceRule', r.acceptance_rule
           ) ORDER BY r.requirement_code), '[]'::jsonb)
      INTO requirement_input
      FROM public.requirements r
     WHERE r.organization_id = submission_row.organization_id
       AND r.requirement_set_version_id = case_row.requirement_set_version_id;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id,
               'submissionId', d.submission_id,
               'status', d.status,
               'documentTypeId', d.accepted_document_type_id,
               'contentHash', d.content_hash_sha256,
               'createdAt', d.created_at,
               'updatedAt', d.updated_at
           ) ORDER BY d.created_at, d.id), '[]'::jsonb)
      INTO document_input
      FROM public.documents d
     WHERE d.organization_id = submission_row.organization_id
       AND d.case_id = case_row.id;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'status', s.status,
               'expectedDocumentCount', s.expected_document_count,
               'terminalDocumentCount', s.terminal_document_count
           ) ORDER BY s.created_at, s.id), '[]'::jsonb)
      INTO submission_input
      FROM public.submissions s
     WHERE s.organization_id = submission_row.organization_id
       AND s.case_id = case_row.id;

    input_hash_value := encode(digest(
        requirement_input::text || '|' || document_input::text || '|' || submission_input::text,
        'sha256'
    ), 'hex');

    SELECT id INTO existing_assessment_id
      FROM public.case_completeness_assessments
     WHERE organization_id = submission_row.organization_id
       AND case_id = case_row.id
       AND input_hash = input_hash_value;
    IF FOUND THEN RETURN existing_assessment_id; END IF;

    SELECT count(*)::integer INTO active_submission_count_value
      FROM public.submissions s
     WHERE s.organization_id = submission_row.organization_id
       AND s.case_id = case_row.id
       AND s.status NOT IN ('completed','rejected','failed_manual');

    WITH ranked AS (
        SELECT d.*,
               CASE WHEN d.content_hash_sha256 IS NULL THEN 1
                    ELSE row_number() OVER (
                        PARTITION BY d.case_id, d.content_hash_sha256
                        ORDER BY CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END, d.created_at, d.id
                    ) END AS content_position
          FROM public.documents d
         WHERE d.organization_id = submission_row.organization_id
           AND d.case_id = case_row.id
    ), marked AS (
        SELECT ranked.*,
               (status <> 'excluded' AND (status = 'duplicate_skipped'
                OR (content_hash_sha256 IS NOT NULL AND content_position > 1))) AS is_duplicate
          FROM ranked
    ), positioned AS (
        SELECT marked.*,
               r.id AS requirement_id,
               r.requirement_code,
               r.minimum_count,
               r.maximum_count,
               sum(CASE
                   WHEN status IN ('accepted','human_confirmed','archived') AND NOT is_duplicate THEN 1
                   ELSE 0
               END) OVER (
                   PARTITION BY marked.accepted_document_type_id
                   ORDER BY marked.created_at, marked.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               )::integer AS unique_type_position
          FROM marked
          LEFT JOIN public.requirements r
            ON r.organization_id = marked.organization_id
           AND r.requirement_set_version_id = case_row.requirement_set_version_id
           AND r.document_type_id = marked.accepted_document_type_id
    )
    SELECT
        count(*) FILTER (
            WHERE status IN ('accepted','human_confirmed','archived')
              AND NOT is_duplicate AND requirement_id IS NOT NULL
        )::integer,
        count(*) FILTER (WHERE is_duplicate)::integer,
        count(*) FILTER (
            WHERE status IN ('accepted','human_confirmed','archived')
              AND NOT is_duplicate AND requirement_id IS NOT NULL
              AND maximum_count IS NOT NULL AND unique_type_position > maximum_count
        )::integer,
        count(*) FILTER (WHERE status IN ('review_required','failed_manual'))::integer,
        count(*) FILTER (
            WHERE status IN ('accepted','human_confirmed','archived')
              AND NOT is_duplicate AND requirement_id IS NULL
        )::integer,
        count(*) FILTER (
            WHERE status NOT IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped','excluded')
        )::integer
      INTO matched_count_value, duplicate_count_value, excess_count_value,
           review_count_value, unmatched_count_value, processing_count_value
      FROM positioned;

    WITH ranked AS (
        SELECT d.*,
               CASE WHEN d.content_hash_sha256 IS NULL THEN 1
                    ELSE row_number() OVER (
                        PARTITION BY d.case_id, d.content_hash_sha256
                        ORDER BY CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END, d.created_at, d.id
                    ) END AS content_position
          FROM public.documents d
         WHERE d.organization_id = submission_row.organization_id
           AND d.case_id = case_row.id
    ), requirement_counts AS (
        SELECT r.id, r.requirement_code, dt.code AS document_type_code,
               dt.display_name, r.minimum_count, r.maximum_count,
               count(*) FILTER (
                   WHERE ranked.status IN ('accepted','human_confirmed','archived')
                     AND (ranked.content_hash_sha256 IS NULL OR ranked.content_position = 1)
               )::integer AS accepted_count,
               count(*) FILTER (WHERE ranked.status IN ('review_required','failed_manual'))::integer AS review_count,
               count(*) FILTER (
                   WHERE ranked.status <> 'excluded'
                     AND (ranked.status = 'duplicate_skipped'
                      OR (ranked.content_hash_sha256 IS NOT NULL AND ranked.content_position > 1))
               )::integer AS duplicate_count
          FROM public.requirements r
          JOIN public.document_types dt ON dt.id = r.document_type_id
          LEFT JOIN ranked ON ranked.accepted_document_type_id = r.document_type_id
         WHERE r.organization_id = submission_row.organization_id
           AND r.requirement_set_version_id = case_row.requirement_set_version_id
         GROUP BY r.id, r.requirement_code, dt.code, dt.display_name, r.minimum_count, r.maximum_count
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'requirementId', id,
               'requirementCode', requirement_code,
               'documentTypeCode', document_type_code,
               'displayName', display_name,
               'minimumCount', minimum_count,
               'maximumCount', maximum_count,
               'acceptedCount', accepted_count,
               'missingCount', greatest(minimum_count - accepted_count, 0),
               'reviewCount', review_count,
               'duplicateCount', duplicate_count,
               'excessCount', CASE WHEN maximum_count IS NULL THEN 0 ELSE greatest(accepted_count - maximum_count, 0) END,
               'status', CASE
                   WHEN review_count > 0 THEN 'review_required'
                   WHEN accepted_count < minimum_count THEN 'missing'
                   WHEN maximum_count IS NOT NULL AND accepted_count > maximum_count THEN 'excess'
                   WHEN duplicate_count > 0 THEN 'attention'
                   ELSE 'complete'
               END
           ) ORDER BY requirement_code), '[]'::jsonb),
           coalesce(sum(greatest(minimum_count - accepted_count, 0)), 0)::integer
      INTO requirement_results, missing_count_value
      FROM requirement_counts;

    assessment_status_value := CASE
        WHEN active_submission_count_value > 0 OR processing_count_value > 0 THEN 'pending'
        WHEN review_count_value > 0 OR unmatched_count_value > 0
          OR duplicate_count_value > 0 OR excess_count_value > 0 THEN 'review_required'
        WHEN missing_count_value > 0 THEN 'incomplete'
        ELSE 'complete'
    END;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
    ) VALUES (
        event_id_value,
        submission_row.organization_id,
        'case-completeness|' || case_row.id::text || '|' || input_hash_value,
        'Case.CompletenessAssessed',
        1,
        'case',
        case_row.id,
        correlation_id_value,
        'dop.core.completeness.v1',
        jsonb_build_object(
            'assessment_id', assessment_id_value,
            'algorithm_version', '1.0',
            'input_hash', input_hash_value,
            'status', assessment_status_value,
            'calculated_after_submission_id', submission_row.id,
            'matched_document_count', matched_count_value,
            'missing_requirement_count', missing_count_value,
            'duplicate_document_count', duplicate_count_value,
            'excess_document_count', excess_count_value,
            'review_required_document_count', review_count_value,
            'unmatched_document_count', unmatched_count_value,
            'active_submission_count', active_submission_count_value
        ),
        p_now
    );

    INSERT INTO public.case_completeness_assessments (
        id, organization_id, case_id, calculated_after_submission_id,
        requirement_set_version_id, algorithm_version, input_hash, status,
        matched_document_count, missing_requirement_count, duplicate_document_count,
        excess_document_count, review_required_document_count, unmatched_document_count,
        active_submission_count, result, event_id, created_at
    ) VALUES (
        assessment_id_value, submission_row.organization_id, case_row.id, submission_row.id,
        case_row.requirement_set_version_id, '1.0', input_hash_value, assessment_status_value,
        matched_count_value, missing_count_value, duplicate_count_value,
        excess_count_value, review_count_value, unmatched_count_value,
        active_submission_count_value,
        jsonb_build_object(
            'algorithmVersion', '1.0',
            'status', assessment_status_value,
            'requirements', requirement_results,
            'processingDocumentCount', processing_count_value,
            'terminalBoundary', jsonb_build_object(
                'submissionId', submission_row.id,
                'expectedDocumentCount', submission_row.expected_document_count,
                'terminalDocumentCount', terminal_count_value
            )
        ),
        event_id_value,
        p_now
    );

    WITH ranked AS (
        SELECT d.*,
               CASE WHEN d.content_hash_sha256 IS NULL THEN 1
                    ELSE row_number() OVER (
                        PARTITION BY d.case_id, d.content_hash_sha256
                        ORDER BY CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END, d.created_at, d.id
                    ) END AS content_position,
               count(*) OVER (
                   PARTITION BY d.case_id, lower(d.original_filename)
               )::integer AS filename_group_size
          FROM public.documents d
         WHERE d.organization_id = submission_row.organization_id
           AND d.case_id = case_row.id
    ), marked AS (
        SELECT ranked.*,
               (status <> 'excluded' AND (status = 'duplicate_skipped'
                OR (content_hash_sha256 IS NOT NULL AND content_position > 1))) AS is_duplicate
          FROM ranked
    ), positioned AS (
        SELECT marked.*,
               r.id AS requirement_id,
               r.requirement_code,
               r.minimum_count,
               r.maximum_count,
               sum(CASE
                   WHEN status IN ('accepted','human_confirmed','archived') AND NOT is_duplicate THEN 1
                   ELSE 0
               END) OVER (
                   PARTITION BY marked.accepted_document_type_id
                   ORDER BY marked.created_at, marked.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               )::integer AS unique_type_position
          FROM marked
          LEFT JOIN public.requirements r
            ON r.organization_id = marked.organization_id
           AND r.requirement_set_version_id = case_row.requirement_set_version_id
           AND r.document_type_id = marked.accepted_document_type_id
    )
    INSERT INTO public.document_requirement_matches (
        id, organization_id, assessment_id, document_id, requirement_id,
        match_status, duplicate_kind, is_excess, counts_toward_minimum,
        reason_code, evidence, created_at
    )
    SELECT gen_random_uuid(), submission_row.organization_id, assessment_id_value,
           id, requirement_id,
           CASE
               WHEN status = 'excluded' THEN 'excluded'
               WHEN status IN ('review_required','failed_manual') THEN 'review_required'
               WHEN is_duplicate THEN 'duplicate'
               WHEN status IN ('accepted','human_confirmed','archived') AND requirement_id IS NULL THEN 'unmatched'
               WHEN status IN ('accepted','human_confirmed','archived') THEN 'matched'
               ELSE 'processing'
           END,
           CASE WHEN is_duplicate THEN 'same_content' ELSE 'none' END,
           status IN ('accepted','human_confirmed','archived')
               AND NOT is_duplicate AND requirement_id IS NOT NULL
               AND maximum_count IS NOT NULL AND unique_type_position > maximum_count,
           status IN ('accepted','human_confirmed','archived')
               AND NOT is_duplicate AND requirement_id IS NOT NULL
               AND unique_type_position <= minimum_count,
           CASE
               WHEN status = 'excluded' THEN CASE review_reason
                   WHEN 'operator_excluded_wrong_subject' THEN 'document_excluded_wrong_subject'
                   WHEN 'operator_excluded_wrong_period' THEN 'document_excluded_wrong_period'
                   ELSE 'document_excluded_irrelevant_or_unknown'
               END
               WHEN status IN ('review_required','failed_manual') THEN 'human_confirmation_required'
               WHEN is_duplicate THEN 'same_content_duplicate'
               WHEN status IN ('accepted','human_confirmed','archived') AND requirement_id IS NULL THEN 'document_type_not_required'
               WHEN status IN ('accepted','human_confirmed','archived')
                    AND maximum_count IS NOT NULL AND unique_type_position > maximum_count THEN 'maximum_count_exceeded'
               WHEN status IN ('accepted','human_confirmed','archived') THEN 'document_type_matches_requirement'
               ELSE 'document_not_terminal'
           END,
           jsonb_build_object(
               'requirementCode', requirement_code,
               'contentPosition', content_position,
               'sameFilenameCount', filename_group_size,
               'uniqueTypePosition', unique_type_position,
               'documentStatus', status
           ),
           p_now
      FROM positioned;

    IF case_row.status NOT IN ('completed','cancelled') THEN
        UPDATE public.cases
           SET status = CASE assessment_status_value
               WHEN 'pending' THEN 'in_progress'
               WHEN 'review_required' THEN 'review_required'
               WHEN 'incomplete' THEN 'waiting_for_documents'
               ELSE 'ready'
           END,
           updated_at = p_now
         WHERE id = case_row.id;
    END IF;

    RETURN assessment_id_value;
END;
$function$
