BEGIN;

-- Explicit, atomic employee acknowledgement, not a deletion or a Case completion.
-- Reuse M53's immutable duplicate evidence; never manufacture accepted documents.
CREATE FUNCTION public.dop_workbench_acknowledge_duplicates(
  p_actor_id uuid, p_case_id uuid, p_idempotency_key uuid, p_correlation_id uuid,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  org_id uuid := public.dop_current_organization_id();
  case_row public.cases%ROWTYPE;
  assessment public.case_completeness_assessments%ROWTYPE;
  issue_row public.issues%ROWTYPE;
  existing public.workflow_events%ROWTYPE;
  event_id uuid; transition_id uuid; last_issue_id uuid;
  result_value jsonb; handled integer := 0;
  event_key text := 'workbench-duplicates-acknowledged|' || p_idempotency_key::text;
BEGIN
  IF org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.actors
    WHERE organization_id=org_id AND id=p_actor_id AND status='active'
      AND actor_type IN ('staff','manager','admin')) THEN
    RAISE EXCEPTION 'active workbench operator required' USING ERRCODE='42501';
  END IF;
  IF p_idempotency_key IS NULL OR p_correlation_id IS NULL OR p_now IS NULL THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org_id::text || '|' || event_key,0));
  SELECT * INTO case_row FROM public.cases
    WHERE organization_id=org_id AND id=p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','case_not_found'); END IF;
  IF NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb OR NOT EXISTS(
    SELECT 1 FROM public.subjects WHERE organization_id=org_id AND id=case_row.subject_id
      AND attributes @> '{"synthetic":true}'::jsonb) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required');
  END IF;
  SELECT * INTO existing FROM public.workflow_events WHERE organization_id=org_id AND idempotency_key=event_key;
  IF FOUND THEN
    IF existing.aggregate_id<>p_case_id OR existing.actor_id<>p_actor_id THEN
      RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    RETURN existing.payload || jsonb_build_object('outcome','duplicate');
  END IF;
  IF case_row.status IN ('completed','cancelled') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','case_not_active');
  END IF;
  SELECT * INTO assessment FROM public.case_completeness_assessments
    WHERE organization_id=org_id AND case_id=p_case_id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF NOT FOUND OR assessment.status<>'review_required' OR assessment.duplicate_document_count<1
    OR assessment.missing_requirement_count<>0 OR assessment.excess_document_count<>0
    OR assessment.review_required_document_count<>0 OR assessment.unmatched_document_count<>0
    OR assessment.active_submission_count<>0 OR EXISTS(
      SELECT 1 FROM public.issues WHERE organization_id=org_id AND case_id=p_case_id
        AND status IN ('open','assigned','waiting_internal','waiting_external','reopened')
        AND issue_type<>'completeness_duplicate') OR EXISTS(
      SELECT 1 FROM public.client_portal_question_versions WHERE organization_id=org_id
        AND case_id=p_case_id AND status='published') OR EXISTS(
      SELECT 1 FROM public.documents WHERE organization_id=org_id AND case_id=p_case_id
        AND status NOT IN ('accepted','human_confirmed','archived','duplicate_skipped','excluded')) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','other_completeness_blockers');
  END IF;
  IF (SELECT coalesce(sum(quantity),0) FROM public.completeness_exception_evidence
      WHERE organization_id=org_id AND assessment_id=assessment.id AND exception_type='duplicate')
      < assessment.duplicate_document_count THEN
    RETURN jsonb_build_object('outcome','conflict','reason','duplicate_evidence_missing');
  END IF;
  -- A single business action, but an independent transition and audit event per Issue.
  FOR issue_row IN SELECT i.* FROM public.issues i
    WHERE i.organization_id=org_id AND i.case_id=p_case_id AND i.issue_type='completeness_duplicate'
      AND EXISTS(SELECT 1 FROM public.completeness_exception_evidence e
        WHERE e.organization_id=org_id AND e.assessment_id=assessment.id AND e.issue_id=i.id
          AND e.exception_type='duplicate') ORDER BY i.id FOR UPDATE
  LOOP
    last_issue_id := issue_row.id;
    IF issue_row.status IN ('resolved','closed') AND EXISTS(SELECT 1 FROM public.issue_operator_transitions
      WHERE organization_id=org_id AND issue_id=issue_row.id AND action IN ('resolve','close')) THEN
      CONTINUE;
    END IF;
    event_id := gen_random_uuid(); transition_id := gen_random_uuid();
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(event_id,org_id,event_key||'|'||issue_row.id::text,'Issue.StatusChanged',1,'issue',issue_row.id,
      p_correlation_id,p_actor_id,'dop.workbench.duplicate-acknowledgement.v1',jsonb_build_object(
        'transition_id',transition_id,'action','resolve','previous_status',issue_row.status,
        'resulting_status','resolved','caseId',p_case_id,'sourceAssessmentId',assessment.id,
        'note','员工确认重复文件不重复计数；原件保留。'),p_now);
    INSERT INTO public.issue_operator_transitions(id,organization_id,issue_id,actor_id,idempotency_key,
      request_fingerprint,action,previous_status,resulting_status,previous_assigned_actor_id,
      resulting_assigned_actor_id,note,event_id,transitioned_at)
    VALUES(transition_id,org_id,issue_row.id,p_actor_id,event_key||'|'||issue_row.id::text,
      encode(digest(p_case_id::text||'|'||p_actor_id::text||'|'||issue_row.id::text,'sha256'),'hex'),
      'resolve',issue_row.status,'resolved',issue_row.assigned_actor_id,p_actor_id,
      '员工确认重复文件不重复计数；原件保留。',event_id,p_now);
    UPDATE public.issues SET status='resolved',assigned_actor_id=p_actor_id,resolved_at=p_now,closed_at=NULL
      WHERE organization_id=org_id AND id=issue_row.id;
    handled := handled+1;
  END LOOP;
  result_value := public.dop_acknowledge_resolved_duplicate_case(last_issue_id,p_actor_id,p_now);
  IF last_issue_id IS NULL OR coalesce(result_value->>'outcome','') NOT IN ('completed','duplicate') THEN
    -- Roll back the whole command if current evidence cannot produce a valid acknowledgement.
    RAISE EXCEPTION 'duplicate acknowledgement evidence changed' USING ERRCODE='40001';
  END IF;
  result_value := result_value || jsonb_build_object('caseId',p_case_id,'resolvedIssueCount',handled);
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(gen_random_uuid(),org_id,event_key,'Workbench.DuplicatesAcknowledged',1,'case',p_case_id,
    p_correlation_id,p_actor_id,'dop.workbench.duplicate-acknowledgement.v1',result_value,p_now);
  RETURN result_value;
END $$;

REVOKE ALL ON FUNCTION public.dop_workbench_acknowledge_duplicates(uuid,uuid,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_workbench_acknowledge_duplicates(uuid,uuid,uuid,uuid,timestamptz) TO dop_app;
COMMIT;
