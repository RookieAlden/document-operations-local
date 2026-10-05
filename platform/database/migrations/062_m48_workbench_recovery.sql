BEGIN;

CREATE OR REPLACE FUNCTION public.dop_workbench_issue_case_invitation(
    p_actor_id uuid,p_case_id uuid,p_invitation_token_sha256 text,
    p_maximum_submissions integer,p_valid_until timestamptz,p_idempotency_key uuid,
    p_correlation_id uuid,p_now timestamptz,p_replace_invitation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    org_id uuid:=public.dop_require_active_workbench_employee(p_actor_id);
    entry_row public.demo_form_entry_versions%ROWTYPE;
    case_row public.cases%ROWTYPE;
    subject_row public.subjects%ROWTYPE;
    existing public.demo_case_invitations%ROWTYPE;
    invitation_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    connector_version_id uuid;
    connector_definition_hash text;
    previous_connector_version_id uuid;
    period_key text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(org_id::text||'|workbench-invitation|'||p_idempotency_key,0));
    IF p_idempotency_key IS NULL OR p_invitation_token_sha256 IS NULL OR p_maximum_submissions IS NULL OR p_valid_until IS NULL OR p_now IS NULL OR p_invitation_token_sha256 !~ '^[0-9a-f]{64}$'
       OR p_maximum_submissions NOT BETWEEN 2 AND 20
       OR p_valid_until<=p_now OR p_valid_until>p_now+interval '30 days' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO entry_row FROM public.demo_form_entry_versions
     WHERE organization_id=org_id AND status='active' ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','active_entry_required'); END IF;
    SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id
      AND status IN ('not_started','waiting_for_documents','review_required','ready','in_progress') FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','case_not_receiving'); END IF;
    SELECT * INTO subject_row FROM public.subjects WHERE organization_id=org_id AND id=case_row.subject_id AND status='active';
    IF NOT FOUND OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb
       OR NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required');
    END IF;
    -- Validate scope before replay; never recover a link for another Case or a closed Case.
    SELECT * INTO existing FROM public.demo_case_invitations
     WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND AND existing.case_id<>p_case_id THEN
      RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    IF NOT FOUND OR existing.status<>'active' THEN
      SELECT * INTO existing FROM public.demo_case_invitations
       WHERE organization_id=org_id AND case_id=p_case_id
       ORDER BY (status='active') DESC,created_at DESC,id DESC LIMIT 1;
    END IF;
    IF existing.id IS NOT NULL THEN
      IF p_replace_invitation_id IS NOT NULL AND existing.id<>p_replace_invitation_id
         AND existing.idempotency_key<>p_idempotency_key THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invitation_changed');
      END IF;
      IF existing.idempotency_key=p_idempotency_key AND p_replace_invitation_id=existing.id THEN
        RETURN jsonb_build_object('outcome','conflict','reason','new_request_key_required');
      END IF;
      IF (p_replace_invitation_id IS NULL OR existing.idempotency_key=p_idempotency_key) THEN
        IF existing.status='active' AND existing.valid_from<=p_now AND existing.valid_until>p_now
           AND existing.used_submissions<existing.maximum_submissions
           AND existing.entry_version_id=entry_row.id THEN
          IF EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
             AND id=existing.event_id AND producer='employee-workbench') THEN
            RETURN jsonb_build_object('outcome','duplicate','invitationId',existing.id,
              'caseId',existing.case_id,'status',existing.status,'validUntil',existing.valid_until,
              'remainingSubmissions',existing.maximum_submissions-existing.used_submissions,
              'recoveryKey',existing.idempotency_key,'tokenSha256',existing.invitation_token_sha256);
          END IF;
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','invitation_unavailable',
          'invitationId',existing.id,'canRenew',true);
      END IF;
    ELSIF p_replace_invitation_id IS NOT NULL THEN
      RETURN jsonb_build_object('outcome','conflict','reason','invitation_changed');
    END IF;
    period_key:=regexp_replace(case_row.case_key,'^.*\|','');
    SELECT version.id,version.definition_hash INTO connector_version_id,connector_definition_hash
      FROM public.source_connector_versions version
      JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
     WHERE version.organization_id=org_id AND version.id=case_row.source_connector_version_id
       AND connector.connector_key=entry_row.connector_key AND connector.lifecycle_status='active'
       AND connector.active_version_id=version.id AND version.status='active';
    IF connector_version_id IS NULL THEN
        IF EXISTS(SELECT 1 FROM public.submissions WHERE organization_id=org_id AND case_id=case_row.id) THEN
            RETURN jsonb_build_object('outcome','conflict','reason','case_connector_mismatch'); END IF;
        previous_connector_version_id:=case_row.source_connector_version_id;
        SELECT version.id,version.definition_hash INTO connector_version_id,connector_definition_hash
          FROM public.source_connector_versions version
          JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
         WHERE version.organization_id=org_id AND connector.connector_key=entry_row.connector_key
           AND connector.lifecycle_status='active' AND connector.active_version_id=version.id AND version.status='active';
        IF connector_version_id IS NULL THEN
            RETURN jsonb_build_object('outcome','conflict','reason','active_uat_form_connector_required'); END IF;
        UPDATE public.cases SET source_connector_version_id=connector_version_id,
          source_connector_definition_hash=connector_definition_hash,
          config_snapshot=jsonb_set(config_snapshot,'{sourceBinding}',jsonb_build_object(
            'bindingKey',entry_row.connector_key,'connectorVersionId',connector_version_id,
            'definitionHash',connector_definition_hash,'mode','governed_synthetic_demo'),true),
          version=version+1,updated_at=p_now WHERE organization_id=org_id AND id=case_row.id;
    END IF;
    IF existing.id IS NOT NULL AND p_replace_invitation_id=existing.id THEN
      IF existing.status='active' THEN
        UPDATE public.demo_case_invitations SET status='revoked',revoked_by_actor_id=p_actor_id,
          revoked_at=p_now,updated_at=p_now WHERE organization_id=org_id AND id=existing.id;
      END IF;
      INSERT INTO public.workflow_events(organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
      VALUES(org_id,'workbench-invitation-replacement|'||p_idempotency_key,'DemoForm.InvitationReplaced',1,
        'case',p_case_id,p_correlation_id,p_actor_id,'employee-workbench',
        jsonb_build_object('previousInvitationId',existing.id,'newInvitationId',invitation_id,
          'previousStatus',existing.status,'explicitReplacement',true),p_now);
    END IF;
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(event_id,org_id,'workbench-invitation|'||p_idempotency_key,'DemoForm.InvitationIssued',1,
      'case',case_row.id,p_correlation_id,p_actor_id,'employee-workbench',jsonb_build_object(
        'invitationId',invitation_id,'entryVersionId',entry_row.id,'periodKey',period_key,
        'syntheticOnly',true,'allowInitialSubmission',true,'allowSupplement',true,
        'maximumSubmissions',p_maximum_submissions,'validUntil',p_valid_until,
        'sourceConnectorVersionId',connector_version_id,'previousSourceConnectorVersionId',previous_connector_version_id),p_now);
    INSERT INTO public.demo_case_invitations(id,organization_id,entry_version_id,subject_id,case_id,
      invitation_token_sha256,period_key,status,synthetic_only,allow_initial_submission,allow_supplement,
      maximum_submissions,valid_from,valid_until,created_by_actor_id,reason,idempotency_key,event_id,created_at,updated_at)
    VALUES(invitation_id,org_id,entry_row.id,case_row.subject_id,case_row.id,p_invitation_token_sha256,
      period_key,'active',true,true,true,p_maximum_submissions,p_now,p_valid_until,p_actor_id,
      'Employee generated the governed synthetic client submission link.',p_idempotency_key,event_id,p_now,p_now);
    RETURN jsonb_build_object('outcome','completed','invitationId',invitation_id,'caseId',case_row.id,
      'status','active','validUntil',p_valid_until,'remainingSubmissions',p_maximum_submissions,'eventId',event_id,'providerFormId',entry_row.provider_form_id);
END;
$$;

-- Preserve the old callable signature for existing clients and verification scripts.
CREATE OR REPLACE FUNCTION public.dop_workbench_issue_case_invitation(
  p_actor_id uuid,p_case_id uuid,p_invitation_token_sha256 text,p_maximum_submissions integer,
  p_valid_until timestamptz,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.dop_workbench_issue_case_invitation(p_actor_id,p_case_id,p_invitation_token_sha256,
    p_maximum_submissions,p_valid_until,p_idempotency_key,p_correlation_id,p_now,NULL::uuid);
$$;
REVOKE ALL ON FUNCTION public.dop_workbench_issue_case_invitation(uuid,uuid,text,integer,timestamptz,uuid,uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_workbench_issue_case_invitation(uuid,uuid,text,integer,timestamptz,uuid,uuid,timestamptz,uuid) TO dop_app;

CREATE OR REPLACE FUNCTION public.dop_workbench_escalate_document_review(
  p_actor_id uuid,p_document_id uuid,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_workbench_employee(p_actor_id);
  doc public.documents%ROWTYPE;
  issue_row public.issues%ROWTYPE;
  event_id uuid:=gen_random_uuid();
  prior_status text;
  prior_actor uuid;
BEGIN
  IF p_idempotency_key IS NULL OR p_correlation_id IS NULL OR p_now IS NULL THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org_id::text||'|workbench-escalate|'||p_idempotency_key,0));
  IF EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
    AND idempotency_key='workbench-escalate|'||p_idempotency_key AND aggregate_id<>p_document_id) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  SELECT * INTO doc FROM public.documents WHERE organization_id=org_id AND id=p_document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','document_not_found'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.cases c JOIN public.subjects s
    ON s.organization_id=c.organization_id AND s.id=c.subject_id
    WHERE c.organization_id=org_id AND c.id=doc.case_id
      AND c.status IN ('not_started','waiting_for_documents','review_required','ready','in_progress')
      AND c.config_snapshot @> '{"synthetic_only":true}' AND s.attributes @> '{"synthetic":true}'
      AND s.status='active') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required');
  END IF;
  IF EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
    AND idempotency_key='workbench-escalate|'||p_idempotency_key AND aggregate_id=p_document_id) THEN
    RETURN jsonb_build_object('outcome','duplicate','documentId',p_document_id);
  END IF;
  IF doc.status NOT IN ('review_required','failed_manual') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','review_already_resolved');
  END IF;
  SELECT * INTO issue_row FROM public.issues WHERE organization_id=org_id AND document_id=p_document_id
    AND status='waiting_internal' AND routing_reason='supervisor_review_requested' LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','documentId',p_document_id,'issueId',issue_row.id); END IF;
  SELECT * INTO issue_row FROM public.issues WHERE organization_id=org_id AND document_id=p_document_id
    AND status IN ('open','assigned','waiting_internal','waiting_external','reopened')
    ORDER BY opened_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.issues(organization_id,case_id,document_id,issue_key,issue_type,severity,status,opened_at)
    VALUES(org_id,doc.case_id,p_document_id,'workbench-supervisor|'||p_document_id||'|'||p_idempotency_key,
      'document_classification_review','high','open',p_now) RETURNING * INTO issue_row;
  END IF;
  prior_status:=issue_row.status; prior_actor:=issue_row.assigned_actor_id;
  UPDATE public.issues SET status='waiting_internal',routing_reason='supervisor_review_requested',
    assigned_actor_id=NULL WHERE organization_id=org_id AND id=issue_row.id;
  UPDATE public.documents SET classification_summary=coalesce(classification_summary,'{}'::jsonb)
    ||'{"supervisor_review_requested":true}'::jsonb,updated_at=p_now
    WHERE organization_id=org_id AND id=p_document_id;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'workbench-escalate|'||p_idempotency_key,'Document.SupervisorReviewRequested',1,
    'document',p_document_id,p_correlation_id,p_actor_id,'employee-workbench',
    jsonb_build_object('caseId',doc.case_id,'issueId',issue_row.id,'queue','manager_admin_review',
      'documentStatusUnchanged',true),p_now);
  INSERT INTO public.issue_operator_transitions(organization_id,issue_id,actor_id,idempotency_key,
    request_fingerprint,action,previous_status,resulting_status,previous_assigned_actor_id,
    resulting_assigned_actor_id,note,event_id,transitioned_at)
  VALUES(org_id,issue_row.id,p_actor_id,'workbench-escalate|'||p_idempotency_key,
    encode(extensions.digest(p_document_id::text||'|supervisor','sha256'),'hex'),'wait_internal',
    prior_status,'waiting_internal',prior_actor,NULL,
    'Employee requested a supervisor decision; document remains unaccepted.',event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','documentId',p_document_id,'issueId',issue_row.id,'eventId',event_id);
END;
$$;
REVOKE ALL ON FUNCTION public.dop_workbench_escalate_document_review(uuid,uuid,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_workbench_escalate_document_review(uuid,uuid,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
