BEGIN;

-- Supersede 055 for acknowledgement-only completeness snapshots, which carry
-- the terminal status but intentionally do not duplicate document match rows.
-- Keep the customer-facing checklist aligned with the latest canonical match
-- assessment. A human-confirmed physical duplicate is still valid evidence of
-- its document type, but it must not be presented or counted as another
-- accepted checklist item.
CREATE OR REPLACE FUNCTION public.dop_read_client_portal_snapshot(
  p_token_sha256 text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  invitation_row public.demo_case_invitations%ROWTYPE; entry_row public.demo_form_entry_versions%ROWTYPE;
  case_row public.cases%ROWTYPE; subject_row public.subjects%ROWTYPE; org_row public.organizations%ROWTYPE;
  requirements_value jsonb:='[]'::jsonb; documents_value jsonb:='[]'::jsonb; questions_value jsonb:='[]'::jsonb;
  processing_count integer:=0; accepted_count integer:=0; open_issue_count integer:=0;
  latest_assessment_id uuid; latest_match_assessment_id uuid; latest_status text; latest_active integer:=0; latest_review integer:=0;
  required_count integer:=0; satisfied_count integer:=0; published_question_count integer:=0;
  reason_value text:='link_unavailable'; portal_status text; complete_value boolean:=false; upload_allowed boolean:=false;
BEGIN
  IF p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    INSERT INTO public.client_portal_access_attempts(token_sha256,decision,reason_code,correlation_id,occurred_at)
    VALUES(repeat('0',64),'blocked','invalid_token',p_correlation_id,p_now);
    RETURN jsonb_build_object('outcome','blocked','reason','link_unavailable');
  END IF;
  SELECT * INTO invitation_row FROM public.demo_case_invitations WHERE invitation_token_sha256=p_token_sha256;
  IF NOT FOUND THEN reason_value:='link_not_found';
  ELSIF invitation_row.status='revoked' THEN reason_value:='link_revoked';
  ELSIF p_now<invitation_row.valid_from OR p_now>=invitation_row.valid_until THEN reason_value:='link_expired';
  ELSE
    SELECT * INTO entry_row FROM public.demo_form_entry_versions WHERE id=invitation_row.entry_version_id;
    SELECT * INTO case_row FROM public.cases WHERE organization_id=invitation_row.organization_id AND id=invitation_row.case_id;
    SELECT * INTO subject_row FROM public.subjects WHERE organization_id=invitation_row.organization_id AND id=invitation_row.subject_id;
    SELECT * INTO org_row FROM public.organizations WHERE id=invitation_row.organization_id;
    IF entry_row.status<>'active' THEN reason_value:='entry_disabled';
    ELSIF NOT invitation_row.synthetic_only OR NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb
       OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb THEN reason_value:='synthetic_scope_required';
    ELSE reason_value:='authorized'; END IF;
  END IF;
  IF reason_value<>'authorized' THEN
    INSERT INTO public.client_portal_access_attempts(organization_id,invitation_id,case_id,token_sha256,
      decision,reason_code,correlation_id,occurred_at)
    VALUES(invitation_row.organization_id,invitation_row.id,invitation_row.case_id,p_token_sha256,
      'blocked',reason_value,p_correlation_id,p_now);
    RETURN jsonb_build_object('outcome','blocked','reason','link_unavailable');
  END IF;

  SELECT a.id,a.status,a.active_submission_count,a.review_required_document_count
    INTO latest_assessment_id,latest_status,latest_active,latest_review
    FROM public.case_completeness_assessments a
   WHERE a.organization_id=case_row.organization_id AND a.case_id=case_row.id
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1;

  SELECT a.id INTO latest_match_assessment_id
    FROM public.case_completeness_assessments a
   WHERE a.organization_id=case_row.organization_id AND a.case_id=case_row.id
     AND EXISTS(SELECT 1 FROM public.document_requirement_matches m WHERE m.assessment_id=a.id)
   ORDER BY a.created_at DESC,a.id DESC LIMIT 1;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'code',item.requirement_code,'displayName',item.display_name,'minimumCount',item.minimum_count,
      'acceptedCount',item.accepted_count,'missingCount',greatest(item.minimum_count-item.accepted_count,0),
      'reviewCount',item.review_count,'status',CASE
        WHEN item.accepted_count>=item.minimum_count THEN 'accepted'
        WHEN item.review_count>0 THEN 'processing' ELSE 'missing' END
    ) ORDER BY item.requirement_code),'[]'::jsonb),
    coalesce(sum(item.minimum_count),0)::integer,
    coalesce(sum(least(item.accepted_count,item.minimum_count)),0)::integer
    INTO requirements_value,required_count,satisfied_count
    FROM (SELECT r.requirement_code,dt.display_name,r.minimum_count,
      (SELECT count(*)::integer FROM public.document_requirement_matches m
        WHERE m.assessment_id=latest_match_assessment_id AND m.requirement_id=r.id
          AND m.match_status='matched' AND m.counts_toward_minimum) AS accepted_count,
      (SELECT count(*)::integer FROM public.document_requirement_matches m
        WHERE m.assessment_id=latest_match_assessment_id AND m.requirement_id=r.id
          AND m.match_status='review_required') AS review_count
      FROM public.requirements r JOIN public.document_types dt ON dt.organization_id=r.organization_id AND dt.id=r.document_type_id
      WHERE r.organization_id=case_row.organization_id AND r.requirement_set_version_id=case_row.requirement_set_version_id) item;

  SELECT coalesce(jsonb_agg(jsonb_build_object('filename',item.original_filename,'submittedAt',item.created_at,
      'updatedAt',item.updated_at,'status',item.public_status,'noteCode',item.note_code)
      ORDER BY item.created_at,item.id),'[]'::jsonb),
    count(*) FILTER (WHERE item.public_status='processing')::integer,
    count(*) FILTER (WHERE item.public_status='accepted')::integer
    INTO documents_value,processing_count,accepted_count
    FROM (SELECT d.id,d.original_filename,d.created_at,d.updated_at,
      CASE
        WHEN d.status='excluded' THEN 'submitted'
        WHEN latest_match.match_status='duplicate' OR latest_match.duplicate_kind='same_content' THEN 'submitted'
        WHEN d.status IN ('accepted','human_confirmed','archived') THEN 'accepted'
        WHEN EXISTS(SELECT 1 FROM public.client_portal_question_versions q
          JOIN public.issues i ON i.organization_id=q.organization_id AND i.id=q.issue_id
          WHERE q.organization_id=d.organization_id AND q.case_id=d.case_id AND q.status='published' AND i.document_id=d.id)
          THEN 'needs_supplement'
        WHEN d.status='duplicate_skipped' THEN 'submitted'
        ELSE 'processing' END AS public_status,
      CASE WHEN d.status='excluded' THEN 'not_counted'
           WHEN latest_match.match_status='duplicate' OR latest_match.duplicate_kind='same_content'
             OR d.status='duplicate_skipped' THEN 'duplicate_not_counted'
           ELSE NULL END AS note_code
      FROM public.documents d
      LEFT JOIN public.document_requirement_matches latest_match
        ON latest_match.assessment_id=latest_match_assessment_id AND latest_match.document_id=d.id
      WHERE d.organization_id=case_row.organization_id AND d.case_id=case_row.id) item;

  SELECT coalesce(jsonb_agg(jsonb_build_object('title',q.public_title,'body',q.public_body,
      'requestedAction',q.requested_action,'status',q.status,'publishedAt',q.published_at)
      ORDER BY q.published_at DESC),'[]'::jsonb),count(*)::integer
    INTO questions_value,published_question_count
    FROM public.client_portal_question_versions q
   WHERE q.organization_id=case_row.organization_id AND q.case_id=case_row.id AND q.status='published';

  SELECT count(*)::integer INTO open_issue_count FROM public.issues i
   WHERE i.organization_id=case_row.organization_id AND i.case_id=case_row.id
     AND i.status IN ('open','assigned','waiting_external','waiting_internal','reopened');
  complete_value:=latest_status='complete' AND coalesce(latest_active,0)=0 AND coalesce(latest_review,0)=0
    AND open_issue_count=0 AND published_question_count=0 AND processing_count=0;
  upload_allowed:=invitation_row.status='active' AND invitation_row.used_submissions<invitation_row.maximum_submissions
    AND invitation_row.allow_supplement AND case_row.status IN ('not_started','waiting_for_documents','review_required','ready','in_progress');
  portal_status:=CASE WHEN complete_value THEN 'complete'
    WHEN published_question_count>0 THEN 'needs_action'
    WHEN processing_count>0 OR coalesce(latest_active,0)>0 OR coalesce(latest_review,0)>0 THEN 'processing'
    WHEN satisfied_count<required_count THEN 'missing' ELSE 'in_review' END;

  INSERT INTO public.client_portal_access_attempts(organization_id,invitation_id,case_id,token_sha256,
    decision,reason_code,correlation_id,occurred_at)
  VALUES(invitation_row.organization_id,invitation_row.id,invitation_row.case_id,p_token_sha256,
    'authorized','authorized',p_correlation_id,p_now);
  RETURN jsonb_build_object('outcome','authorized','providerFormId',entry_row.provider_form_id,
    'periodKey',invitation_row.period_key,'snapshot',jsonb_build_object(
      'organizationName',org_row.display_name,'subjectName',subject_row.display_name,'periodKey',invitation_row.period_key,
      'caseStatus',case_row.status,'portalStatus',portal_status,'isComplete',complete_value,
      'uploadAllowed',upload_allowed,'validUntil',invitation_row.valid_until,
      'remainingSubmissions',greatest(invitation_row.maximum_submissions-invitation_row.used_submissions,0),
      'requiredCount',required_count,'acceptedRequirementCount',satisfied_count,
      'processingDocumentCount',processing_count,'acceptedDocumentCount',accepted_count,
      'requirements',requirements_value,'documents',documents_value,'questions',questions_value,
      'updatedAt',greatest(case_row.updated_at,coalesce((SELECT max(d.updated_at) FROM public.documents d
        WHERE d.organization_id=case_row.organization_id AND d.case_id=case_row.id),case_row.updated_at))));
END $$;

REVOKE ALL ON FUNCTION public.dop_read_client_portal_snapshot(text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_read_client_portal_snapshot(text,uuid,timestamptz) TO dop_app;

COMMIT;

