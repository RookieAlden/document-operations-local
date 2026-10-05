BEGIN;

-- A same-content duplicate remains immutable evidence, but it must not keep a
-- Case permanently blocked after an operator has explicitly resolved every
-- duplicate Issue. This append-only ledger records that acknowledgement and
-- creates a new effective completeness assessment; the source assessment and
-- its duplicate matches are never changed or deleted.
CREATE TABLE public.case_completeness_acknowledgements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    source_assessment_id uuid NOT NULL REFERENCES public.case_completeness_assessments(id),
    effective_assessment_id uuid NOT NULL REFERENCES public.case_completeness_assessments(id),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    duplicate_issue_ids uuid[] NOT NULL CHECK (cardinality(duplicate_issue_ids) > 0),
    transition_ids uuid[] NOT NULL CHECK (cardinality(transition_ids) > 0),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 500),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, source_assessment_id),
    UNIQUE (organization_id, effective_assessment_id),
    CONSTRAINT completeness_ack_case_same_org_fk
        FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    CONSTRAINT completeness_ack_source_same_org_fk
        FOREIGN KEY (organization_id, source_assessment_id)
        REFERENCES public.case_completeness_assessments(organization_id, id),
    CONSTRAINT completeness_ack_effective_same_org_fk
        FOREIGN KEY (organization_id, effective_assessment_id)
        REFERENCES public.case_completeness_assessments(organization_id, id),
    CONSTRAINT completeness_ack_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT completeness_ack_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

ALTER TABLE public.case_completeness_acknowledgements ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.case_completeness_acknowledgements TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.case_completeness_acknowledgements
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE FUNCTION public.dop_reject_case_completeness_acknowledgement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'case completeness acknowledgements are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER case_completeness_acknowledgements_immutable
BEFORE UPDATE OR DELETE ON public.case_completeness_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_case_completeness_acknowledgement_mutation();

CREATE FUNCTION public.dop_acknowledge_resolved_duplicate_case(
    p_issue_id uuid,
    p_actor_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_current_organization_id();
    issue_row public.issues%ROWTYPE;
    source_row public.case_completeness_assessments%ROWTYPE;
    effective_assessment_id_value uuid := gen_random_uuid();
    acknowledgement_id_value uuid := gen_random_uuid();
    event_id_value uuid := gen_random_uuid();
    correlation_id_value uuid := gen_random_uuid();
    duplicate_issue_ids_value uuid[];
    transition_ids_value uuid[];
    acknowledged_quantity_value integer;
    effective_input_hash_value text;
    existing_effective_id uuid;
BEGIN
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO issue_row
      FROM public.issues
     WHERE organization_id = organization_id_value AND id = p_issue_id;
    IF NOT FOUND OR issue_row.issue_type <> 'completeness_duplicate' THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','not_duplicate_issue');
    END IF;
    IF issue_row.status NOT IN ('resolved','closed') THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','duplicate_issue_not_resolved');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE organization_id = organization_id_value AND id = p_actor_id
           AND actor_type IN ('staff','manager','admin') AND status = 'active'
    ) THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','operator_not_active');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        organization_id_value::text || '|duplicate-completeness|' || issue_row.case_id::text, 0
    ));

    SELECT * INTO source_row
      FROM public.case_completeness_assessments
     WHERE organization_id = organization_id_value AND case_id = issue_row.case_id
     ORDER BY created_at DESC, id DESC LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','assessment_not_found');
    END IF;
    IF source_row.status = 'complete' THEN
        RETURN jsonb_build_object('outcome','duplicate','assessmentId',source_row.id);
    END IF;
    IF source_row.status <> 'review_required'
       OR source_row.duplicate_document_count < 1
       OR source_row.missing_requirement_count <> 0
       OR source_row.excess_document_count <> 0
       OR source_row.review_required_document_count <> 0
       OR source_row.unmatched_document_count <> 0
       OR source_row.active_submission_count <> 0 THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','other_completeness_blockers');
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.issues
         WHERE organization_id = organization_id_value AND case_id = issue_row.case_id
           AND status IN ('open','assigned','waiting_external','waiting_internal','reopened')
    ) THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','open_issues_remaining');
    END IF;

    SELECT array_agg(e.issue_id ORDER BY e.issue_id),
           array_agg(t.id ORDER BY t.id),
           sum(e.quantity)::integer
      INTO duplicate_issue_ids_value, transition_ids_value, acknowledged_quantity_value
      FROM public.completeness_exception_evidence e
      JOIN public.issues i
        ON i.organization_id = e.organization_id AND i.id = e.issue_id
      JOIN LATERAL (
          SELECT transition.id
            FROM public.issue_operator_transitions transition
           WHERE transition.organization_id = e.organization_id
             AND transition.issue_id = e.issue_id
             AND transition.action IN ('resolve','close')
           ORDER BY transition.transitioned_at DESC, transition.id DESC
           LIMIT 1
      ) t ON true
     WHERE e.organization_id = organization_id_value
       AND e.assessment_id = source_row.id
       AND e.exception_type = 'duplicate'
       AND i.status IN ('resolved','closed');

    IF duplicate_issue_ids_value IS NULL
       OR acknowledged_quantity_value < source_row.duplicate_document_count THEN
        RETURN jsonb_build_object('outcome','not_applicable','reason','duplicate_evidence_not_acknowledged');
    END IF;

    effective_input_hash_value := encode(digest(
        source_row.input_hash || '|acknowledged-duplicates|' || array_to_string(transition_ids_value, ','),
        'sha256'
    ), 'hex');

    SELECT id INTO existing_effective_id
      FROM public.case_completeness_assessments
     WHERE organization_id = organization_id_value
       AND case_id = issue_row.case_id
       AND input_hash = effective_input_hash_value;
    IF FOUND THEN
        RETURN jsonb_build_object('outcome','duplicate','assessmentId',existing_effective_id);
    END IF;

    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        event_id_value, organization_id_value,
        'case-duplicate-acknowledged|' || source_row.id::text,
        'Case.CompletenessDuplicateAcknowledged', 1, 'case', issue_row.case_id,
        correlation_id_value, p_actor_id, 'dop.ops.completeness-acknowledgement.v1',
        jsonb_build_object(
            'source_assessment_id', source_row.id,
            'effective_assessment_id', effective_assessment_id_value,
            'duplicate_document_count', source_row.duplicate_document_count,
            'duplicate_issue_ids', duplicate_issue_ids_value,
            'issue_transition_ids', transition_ids_value,
            'external_execution', 'disabled'
        ), p_now
    );

    INSERT INTO public.case_completeness_assessments (
        id, organization_id, case_id, calculated_after_submission_id,
        requirement_set_version_id, algorithm_version, input_hash, status,
        matched_document_count, missing_requirement_count, duplicate_document_count,
        excess_document_count, review_required_document_count, unmatched_document_count,
        active_submission_count, result, event_id, created_at
    ) VALUES (
        effective_assessment_id_value, organization_id_value, issue_row.case_id,
        source_row.calculated_after_submission_id, source_row.requirement_set_version_id,
        source_row.algorithm_version, effective_input_hash_value, 'complete',
        source_row.matched_document_count, source_row.missing_requirement_count,
        source_row.duplicate_document_count, source_row.excess_document_count,
        source_row.review_required_document_count, source_row.unmatched_document_count,
        source_row.active_submission_count,
        source_row.result || jsonb_build_object(
            'status','complete',
            'sourceAssessmentId',source_row.id,
            'duplicateAcknowledgement',jsonb_build_object(
                'reason','operator_resolved_all_duplicate_issues',
                'issueIds',duplicate_issue_ids_value,
                'transitionIds',transition_ids_value,
                'acknowledgedAt',p_now
            )
        ), event_id_value, p_now
    );

    INSERT INTO public.case_completeness_acknowledgements (
        id, organization_id, case_id, source_assessment_id, effective_assessment_id,
        actor_id, duplicate_issue_ids, transition_ids, reason, event_id, created_at
    ) VALUES (
        acknowledgement_id_value, organization_id_value, issue_row.case_id,
        source_row.id, effective_assessment_id_value, p_actor_id,
        duplicate_issue_ids_value, transition_ids_value,
        'All same-content duplicate Issues were explicitly resolved by an operator.',
        event_id_value, p_now
    );

    UPDATE public.cases
       SET status = 'ready', updated_at = p_now
     WHERE organization_id = organization_id_value AND id = issue_row.case_id
       AND status NOT IN ('completed','cancelled');

    RETURN jsonb_build_object(
        'outcome','completed',
        'acknowledgementId',acknowledgement_id_value,
        'sourceAssessmentId',source_row.id,
        'assessmentId',effective_assessment_id_value,
        'duplicateDocumentCount',source_row.duplicate_document_count,
        'eventId',event_id_value
    );
END;
$$;

REVOKE ALL ON FUNCTION public.dop_reject_case_completeness_acknowledgement_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_acknowledge_resolved_duplicate_case(uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_acknowledge_resolved_duplicate_case(uuid,uuid,timestamptz) TO dop_app;

COMMIT;
