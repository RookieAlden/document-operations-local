BEGIN;

-- M25 converts immutable completeness evidence into the existing Canonical
-- Issue lifecycle and creates a separate, non-deliverable request draft. A
-- draft is not a Notification and cannot be sent by any application role.
CREATE TABLE public.completeness_exception_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    assessment_id uuid NOT NULL REFERENCES public.case_completeness_assessments(id),
    issue_id uuid NOT NULL REFERENCES public.issues(id),
    exception_key text NOT NULL,
    exception_type text NOT NULL CHECK (exception_type IN (
        'missing','duplicate','excess','review_required','unmatched'
    )),
    requirement_id uuid REFERENCES public.requirements(id),
    document_id uuid REFERENCES public.documents(id),
    quantity integer NOT NULL CHECK (quantity > 0),
    evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, assessment_id, exception_key),
    CONSTRAINT completeness_exception_assessment_same_org_fk
        FOREIGN KEY (organization_id, assessment_id)
        REFERENCES public.case_completeness_assessments(organization_id, id),
    CONSTRAINT completeness_exception_issue_same_org_fk
        FOREIGN KEY (organization_id, issue_id) REFERENCES public.issues(organization_id, id),
    CONSTRAINT completeness_exception_requirement_same_org_fk
        FOREIGN KEY (organization_id, requirement_id) REFERENCES public.requirements(organization_id, id),
    CONSTRAINT completeness_exception_document_same_org_fk
        FOREIGN KEY (organization_id, document_id) REFERENCES public.documents(organization_id, id)
);

CREATE TABLE public.missing_document_request_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    subject_id uuid NOT NULL REFERENCES public.subjects(id),
    assessment_id uuid NOT NULL REFERENCES public.case_completeness_assessments(id),
    draft_version integer NOT NULL CHECK (draft_version > 0),
    status text NOT NULL CHECK (status IN ('draft','superseded','cancelled')),
    recipient_reference text NOT NULL,
    recipient_snapshot jsonb NOT NULL CHECK (jsonb_typeof(recipient_snapshot) = 'object'),
    subject_line text NOT NULL CHECK (length(subject_line) BETWEEN 1 AND 300),
    body_text text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 10000),
    requested_items jsonb NOT NULL CHECK (jsonb_typeof(requested_items) = 'array'),
    source_issue_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    delivery_mode text NOT NULL DEFAULT 'disabled' CHECK (delivery_mode = 'disabled'),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, case_id, assessment_id),
    UNIQUE (organization_id, case_id, draft_version),
    CONSTRAINT missing_request_case_same_org_fk
        FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    CONSTRAINT missing_request_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES public.subjects(organization_id, id),
    CONSTRAINT missing_request_assessment_same_org_fk
        FOREIGN KEY (organization_id, assessment_id)
        REFERENCES public.case_completeness_assessments(organization_id, id),
    CONSTRAINT missing_request_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

CREATE INDEX completeness_exception_issue_idx
    ON public.completeness_exception_evidence (organization_id, issue_id, created_at DESC);
CREATE INDEX completeness_exception_assessment_idx
    ON public.completeness_exception_evidence (organization_id, assessment_id, exception_type);
CREATE INDEX missing_request_case_latest_idx
    ON public.missing_document_request_drafts (organization_id, case_id, draft_version DESC);
CREATE UNIQUE INDEX missing_request_current_unique
    ON public.missing_document_request_drafts (organization_id, case_id)
    WHERE status = 'draft';

ALTER TABLE public.completeness_exception_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missing_document_request_drafts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.completeness_exception_evidence,
    public.missing_document_request_drafts TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.completeness_exception_evidence
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.missing_document_request_drafts
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_sync_completeness_exceptions(
    p_assessment_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    assessment_row public.case_completeness_assessments%ROWTYPE;
    case_row public.cases%ROWTYPE;
    subject_row public.subjects%ROWTYPE;
    contact_row public.actors%ROWTYPE;
    exception_row record;
    stale_issue record;
    prior_draft record;
    issue_row public.issues%ROWTYPE;
    issue_id_value uuid;
    event_id_value uuid;
    current_issue_keys text[] := ARRAY[]::text[];
    missing_items jsonb := '[]'::jsonb;
    missing_issue_ids uuid[] := ARRAY[]::uuid[];
    draft_id_value uuid;
    draft_event_id_value uuid;
    draft_version_value integer;
    recipient_reference_value text;
    recipient_snapshot_value jsonb;
    period_label text;
    request_subject text;
    request_body text;
    request_content_hash text;
    opened_count integer := 0;
    reopened_count integer := 0;
    resolved_count integer := 0;
    evidence_count integer := 0;
BEGIN
    SELECT * INTO assessment_row
      FROM public.case_completeness_assessments
     WHERE id = p_assessment_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;

    SELECT * INTO case_row
      FROM public.cases
     WHERE organization_id = assessment_row.organization_id
       AND id = assessment_row.case_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','case_not_found'); END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        assessment_row.organization_id::text || '|completeness-exceptions|' || case_row.id::text, 0
    ));

    SELECT * INTO subject_row
      FROM public.subjects
     WHERE organization_id = assessment_row.organization_id
       AND id = case_row.subject_id;
    IF subject_row.primary_contact_actor_id IS NOT NULL THEN
        SELECT * INTO contact_row
          FROM public.actors
         WHERE organization_id = assessment_row.organization_id
           AND id = subject_row.primary_contact_actor_id
           AND status = 'active';
    END IF;

    FOR exception_row IN
        WITH requirement_exceptions AS (
            SELECT
                'requirement:' || (item->>'requirementId') || ':missing' AS exception_key,
                'missing'::text AS exception_type,
                (item->>'requirementId')::uuid AS requirement_id,
                NULL::uuid AS document_id,
                (item->>'missingCount')::integer AS quantity,
                jsonb_build_object(
                    'requirementCode', item->>'requirementCode',
                    'documentTypeCode', item->>'documentTypeCode',
                    'displayName', item->>'displayName',
                    'minimumCount', (item->>'minimumCount')::integer,
                    'acceptedCount', (item->>'acceptedCount')::integer,
                    'missingCount', (item->>'missingCount')::integer
                ) AS details
              FROM jsonb_array_elements(coalesce(assessment_row.result->'requirements', '[]'::jsonb)) item
             WHERE (item->>'missingCount')::integer > 0
        ), document_exceptions AS (
            SELECT
                'document:' || match.document_id::text || ':' || exception.exception_type AS exception_key,
                exception.exception_type,
                match.requirement_id,
                match.document_id,
                1 AS quantity,
                jsonb_build_object(
                    'requirementCode', match.evidence->>'requirementCode',
                    'reasonCode', match.reason_code,
                    'documentStatus', match.evidence->>'documentStatus',
                    'isExcess', match.is_excess,
                    'duplicateKind', match.duplicate_kind
                ) AS details
              FROM public.document_requirement_matches match
              CROSS JOIN LATERAL (
                  VALUES
                    (CASE WHEN match.match_status = 'duplicate' THEN 'duplicate' END),
                    (CASE WHEN match.is_excess THEN 'excess' END),
                    (CASE WHEN match.match_status = 'review_required' THEN 'review_required' END),
                    (CASE WHEN match.match_status = 'unmatched' THEN 'unmatched' END)
              ) exception(exception_type)
             WHERE match.organization_id = assessment_row.organization_id
               AND match.assessment_id = assessment_row.id
               AND exception.exception_type IS NOT NULL
        )
        SELECT * FROM requirement_exceptions
        UNION ALL
        SELECT * FROM document_exceptions
        ORDER BY exception_key
    LOOP
        current_issue_keys := array_append(
            current_issue_keys,
            'completeness|' || case_row.id::text || '|' || exception_row.exception_key
        );

        SELECT * INTO issue_row
          FROM public.issues
         WHERE organization_id = assessment_row.organization_id
           AND issue_key = current_issue_keys[array_length(current_issue_keys, 1)]
         FOR UPDATE;

        IF NOT FOUND THEN
            issue_id_value := gen_random_uuid();
            INSERT INTO public.issues (
                id, organization_id, case_id, document_id, issue_key, issue_type,
                severity, status, routing_reason, details, due_at, opened_at
            ) VALUES (
                issue_id_value, assessment_row.organization_id, case_row.id,
                exception_row.document_id,
                current_issue_keys[array_length(current_issue_keys, 1)],
                'completeness_' || exception_row.exception_type,
                CASE exception_row.exception_type
                    WHEN 'duplicate' THEN 'low'
                    WHEN 'missing' THEN 'medium'
                    WHEN 'excess' THEN 'medium'
                    ELSE 'high'
                END,
                'open', 'completeness_' || exception_row.exception_type,
                jsonb_build_object('completenessException', exception_row.details || jsonb_build_object(
                    'assessmentId', assessment_row.id,
                    'assessmentInputHash', assessment_row.input_hash,
                    'exceptionType', exception_row.exception_type,
                    'quantity', exception_row.quantity
                )),
                case_row.due_at, p_now
            );
            event_id_value := gen_random_uuid();
            INSERT INTO public.workflow_events (
                id, organization_id, idempotency_key, event_type, event_version,
                aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
            ) VALUES (
                event_id_value, assessment_row.organization_id,
                'completeness-issue-open|' || assessment_row.id::text || '|' || exception_row.exception_key,
                'Issue.CompletenessOpened', 1, 'issue', issue_id_value, gen_random_uuid(),
                'dop.core.completeness-exceptions.v1',
                jsonb_build_object('assessment_id', assessment_row.id, 'exception_key', exception_row.exception_key,
                    'exception_type', exception_row.exception_type, 'quantity', exception_row.quantity), p_now
            );
            opened_count := opened_count + 1;
        ELSE
            issue_id_value := issue_row.id;
            UPDATE public.issues
               SET document_id = exception_row.document_id,
                   severity = CASE exception_row.exception_type
                       WHEN 'duplicate' THEN 'low'
                       WHEN 'missing' THEN 'medium'
                       WHEN 'excess' THEN 'medium'
                       ELSE 'high'
                   END,
                   status = CASE WHEN status IN ('resolved','closed') THEN 'reopened' ELSE status END,
                   routing_reason = 'completeness_' || exception_row.exception_type,
                   details = details || jsonb_build_object('completenessException', exception_row.details || jsonb_build_object(
                       'assessmentId', assessment_row.id,
                       'assessmentInputHash', assessment_row.input_hash,
                       'exceptionType', exception_row.exception_type,
                       'quantity', exception_row.quantity
                   )),
                   due_at = case_row.due_at,
                   resolved_at = CASE WHEN status IN ('resolved','closed') THEN NULL ELSE resolved_at END,
                   closed_at = CASE WHEN status IN ('resolved','closed') THEN NULL ELSE closed_at END
             WHERE id = issue_row.id;
            IF issue_row.status IN ('resolved','closed') THEN
                event_id_value := gen_random_uuid();
                INSERT INTO public.workflow_events (
                    id, organization_id, idempotency_key, event_type, event_version,
                    aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
                ) VALUES (
                    event_id_value, assessment_row.organization_id,
                    'completeness-issue-reopen|' || assessment_row.id::text || '|' || exception_row.exception_key,
                    'Issue.CompletenessReopened', 1, 'issue', issue_row.id, gen_random_uuid(),
                    'dop.core.completeness-exceptions.v1',
                    jsonb_build_object('assessment_id', assessment_row.id, 'previous_status', issue_row.status,
                        'exception_key', exception_row.exception_key), p_now
                );
                reopened_count := reopened_count + 1;
            END IF;
        END IF;

        INSERT INTO public.completeness_exception_evidence (
            id, organization_id, assessment_id, issue_id, exception_key,
            exception_type, requirement_id, document_id, quantity, evidence, created_at
        ) VALUES (
            gen_random_uuid(), assessment_row.organization_id, assessment_row.id, issue_id_value,
            exception_row.exception_key, exception_row.exception_type, exception_row.requirement_id,
            exception_row.document_id, exception_row.quantity, exception_row.details, p_now
        ) ON CONFLICT (organization_id, assessment_id, exception_key) DO NOTHING;
        IF FOUND THEN evidence_count := evidence_count + 1; END IF;
    END LOOP;

    FOR stale_issue IN
        SELECT i.*
          FROM public.issues i
         WHERE i.organization_id = assessment_row.organization_id
           AND i.case_id = case_row.id
           AND i.issue_type IN (
               'completeness_missing','completeness_duplicate','completeness_excess',
               'completeness_review_required','completeness_unmatched'
           )
           AND i.status IN ('open','assigned','waiting_external','waiting_internal','reopened')
           AND NOT (i.issue_key = ANY(current_issue_keys))
         FOR UPDATE
    LOOP
        UPDATE public.issues
           SET status = 'resolved', resolved_at = p_now,
               details = details || jsonb_build_object('completenessResolution', jsonb_build_object(
                   'assessmentId', assessment_row.id,
                   'assessmentInputHash', assessment_row.input_hash,
                   'reason', 'exception_absent_from_latest_assessment',
                   'resolvedAt', p_now
               ))
         WHERE id = stale_issue.id;
        INSERT INTO public.workflow_events (
            id, organization_id, idempotency_key, event_type, event_version,
            aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
        ) VALUES (
            gen_random_uuid(), assessment_row.organization_id,
            'completeness-issue-resolve|' || assessment_row.id::text || '|' || stale_issue.id::text,
            'Issue.CompletenessResolved', 1, 'issue', stale_issue.id, gen_random_uuid(),
            'dop.core.completeness-exceptions.v1',
            jsonb_build_object('assessment_id', assessment_row.id,
                'previous_status', stale_issue.status,
                'reason', 'exception_absent_from_latest_assessment'), p_now
        );
        resolved_count := resolved_count + 1;
    END LOOP;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'requirementId', item->>'requirementId',
               'requirementCode', item->>'requirementCode',
               'documentTypeCode', item->>'documentTypeCode',
               'displayName', item->>'displayName',
               'missingCount', (item->>'missingCount')::integer
           ) ORDER BY item->>'requirementCode'), '[]'::jsonb)
      INTO missing_items
      FROM jsonb_array_elements(coalesce(assessment_row.result->'requirements', '[]'::jsonb)) item
     WHERE (item->>'missingCount')::integer > 0;

    FOR prior_draft IN
        SELECT draft.*
          FROM public.missing_document_request_drafts draft
         WHERE draft.organization_id = assessment_row.organization_id
           AND draft.case_id = case_row.id
           AND draft.status = 'draft'
           AND (jsonb_array_length(missing_items) = 0 OR draft.assessment_id <> assessment_row.id)
         FOR UPDATE
    LOOP
        UPDATE public.missing_document_request_drafts
           SET status = 'superseded', updated_at = p_now
         WHERE id = prior_draft.id;
        INSERT INTO public.workflow_events (
            id, organization_id, idempotency_key, event_type, event_version,
            aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
        ) VALUES (
            gen_random_uuid(), assessment_row.organization_id,
            'missing-request-supersede|' || assessment_row.id::text || '|' || prior_draft.id::text,
            'MissingDocumentRequest.DraftSuperseded', 1, 'missing_document_request_draft',
            prior_draft.id, gen_random_uuid(), 'dop.core.completeness-exceptions.v1',
            jsonb_build_object('assessment_id', assessment_row.id,
                'previous_assessment_id', prior_draft.assessment_id), p_now
        );
    END LOOP;

    IF jsonb_array_length(missing_items) > 0 AND NOT EXISTS (
        SELECT 1 FROM public.missing_document_request_drafts
         WHERE organization_id = assessment_row.organization_id
           AND case_id = case_row.id AND assessment_id = assessment_row.id
    ) THEN
        SELECT coalesce(array_agg(i.id ORDER BY i.issue_key), ARRAY[]::uuid[])
          INTO missing_issue_ids
          FROM public.issues i
         WHERE i.organization_id = assessment_row.organization_id
           AND i.issue_key = ANY(current_issue_keys)
           AND i.issue_type = 'completeness_missing';

        draft_id_value := gen_random_uuid();
        draft_event_id_value := gen_random_uuid();
        SELECT coalesce(max(draft_version), 0) + 1 INTO draft_version_value
          FROM public.missing_document_request_drafts
         WHERE organization_id = assessment_row.organization_id AND case_id = case_row.id;
        recipient_reference_value := CASE WHEN contact_row.id IS NULL
            THEN 'subject:' || subject_row.subject_key
            ELSE 'actor:' || contact_row.id::text END;
        recipient_snapshot_value := jsonb_build_object(
            'resolutionStatus', CASE WHEN contact_row.id IS NOT NULL AND contact_row.email IS NOT NULL
                THEN 'ready' ELSE 'unresolved' END,
            'actorId', contact_row.id,
            'displayName', contact_row.display_name,
            'email', contact_row.email
        );
        period_label := coalesce(to_char(case_row.period_start, 'YYYY-MM-DD'), '未设置') || ' 至 '
            || coalesce(to_char(case_row.period_end, 'YYYY-MM-DD'), '未设置');
        request_subject := subject_row.display_name || '｜资料补充清单｜' || period_label;
        SELECT subject_row.display_name || E'，您好：\n\n我们正在核对 ' || period_label
               || E' 的资料，目前仍需要以下项目：\n'
               || string_agg('- ' || (item->>'displayName') || '：还缺 '
                   || (item->>'missingCount') || ' 份', E'\n' ORDER BY (item->>'requirementCode'))
               || E'\n\n此内容目前仅为内部草稿，尚未发送。'
          INTO request_body
          FROM jsonb_array_elements(missing_items) item;
        request_content_hash := encode(digest(
            recipient_reference_value || '|' || request_subject || '|' || request_body || '|' || missing_items::text,
            'sha256'
        ), 'hex');

        INSERT INTO public.workflow_events (
            id, organization_id, idempotency_key, event_type, event_version,
            aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
        ) VALUES (
            draft_event_id_value, assessment_row.organization_id,
            'missing-request-draft|' || assessment_row.id::text,
            'MissingDocumentRequest.DraftCreated', 1, 'missing_document_request_draft',
            draft_id_value, gen_random_uuid(), 'dop.core.completeness-exceptions.v1',
            jsonb_build_object('assessment_id', assessment_row.id, 'case_id', case_row.id,
                'draft_version', draft_version_value, 'requested_item_count', jsonb_array_length(missing_items),
                'delivery_mode', 'disabled', 'external_call_count', 0), p_now
        );
        INSERT INTO public.missing_document_request_drafts (
            id, organization_id, case_id, subject_id, assessment_id, draft_version,
            status, recipient_reference, recipient_snapshot, subject_line, body_text,
            requested_items, source_issue_ids, content_hash, delivery_mode,
            external_call_count, event_id, created_at, updated_at
        ) VALUES (
            draft_id_value, assessment_row.organization_id, case_row.id, subject_row.id,
            assessment_row.id, draft_version_value, 'draft', recipient_reference_value,
            recipient_snapshot_value, request_subject, request_body, missing_items,
            missing_issue_ids, request_content_hash, 'disabled', 0,
            draft_event_id_value, p_now, p_now
        );
    END IF;

    RETURN jsonb_build_object(
        'outcome', 'completed',
        'assessmentId', assessment_row.id,
        'openedIssueCount', opened_count,
        'reopenedIssueCount', reopened_count,
        'resolvedIssueCount', resolved_count,
        'evidenceCount', evidence_count,
        'missingRequestDraft', jsonb_array_length(missing_items) > 0,
        'externalCallCount', 0,
        'deliveryMode', 'disabled'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_completeness_matches_sync_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE item record;
BEGIN
    FOR item IN SELECT DISTINCT assessment_id FROM new_matches
    LOOP
        PERFORM public.dop_sync_completeness_exceptions(item.assessment_id, now());
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER document_requirement_matches_sync_exceptions
AFTER INSERT ON public.document_requirement_matches
REFERENCING NEW TABLE AS new_matches
FOR EACH STATEMENT
EXECUTE FUNCTION public.dop_completeness_matches_sync_trigger();

REVOKE ALL ON FUNCTION public.dop_sync_completeness_exceptions(uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_completeness_matches_sync_trigger() FROM PUBLIC;

-- Existing records are synthetic DEV evidence. Replay every immutable snapshot
-- in chronological order so the latest Case issue/draft state is authoritative.
DO $$
DECLARE item record;
BEGIN
    FOR item IN
        SELECT id, created_at FROM public.case_completeness_assessments
         ORDER BY created_at, id
    LOOP
        PERFORM public.dop_sync_completeness_exceptions(item.id, item.created_at);
    END LOOP;
END;
$$;

COMMIT;
