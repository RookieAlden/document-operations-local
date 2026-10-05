-- Local owner can operate both existing consoles. Never applied to cloud databases.
UPDATE actors SET actor_type='manager', display_name='本地负责人'
WHERE external_subject_id='local-stage1-employee'
  AND organization_id=(SELECT id FROM organizations WHERE organization_key='dev-accounting-firm');

CREATE OR REPLACE FUNCTION dop_local_prepare_manual(p_actor uuid, p_document uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org uuid := dop_current_organization_id(); d documents%ROWTYPE; c cases%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM organizations WHERE id=org AND settings->>'local_persistence_mode'='stage1')
    OR NOT EXISTS(SELECT 1 FROM actors WHERE id=p_actor AND organization_id=org AND status='active'
      AND actor_type IN ('staff','manager','admin')) THEN
    RAISE EXCEPTION 'local operator required' USING ERRCODE='42501';
  END IF;
  SELECT c0.* INTO c FROM cases c0 JOIN documents d0 ON d0.case_id=c0.id
    WHERE d0.id=p_document AND d0.organization_id=org FOR UPDATE OF c0;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF c.status IN ('completed','cancelled') THEN RETURN jsonb_build_object('outcome','conflict','reason','case_closed'); END IF;
  SELECT * INTO d FROM documents WHERE id=p_document AND organization_id=org FOR UPDATE;
  IF EXISTS(SELECT 1 FROM idempotency_reservations WHERE organization_id=org AND scope='document.classify'
      AND idempotency_key LIKE 'document.classify|'||p_document::text||'|%'
      AND status='processing' AND lease_expires_at>now()) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','classification_in_progress');
  END IF;
  IF d.status IN ('review_required','failed_manual') THEN RETURN jsonb_build_object('outcome','duplicate'); END IF;
  IF d.status NOT IN ('incoming_saved','failed_recoverable','accepted','human_confirmed') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','document_not_reviewable');
  END IF;
  UPDATE documents SET status='review_required',review_reason='local_manual_review_requested',updated_at=now() WHERE id=d.id;
  INSERT INTO issues(organization_id,case_id,document_id,issue_key,issue_type,severity,status,routing_reason,details,opened_at)
    VALUES(org,d.case_id,d.id,'local-manual|'||d.id,'document_classification_review','medium','open',
      'local_manual_review_requested',jsonb_build_object('actor_id',p_actor),now())
    ON CONFLICT(organization_id,issue_key) DO UPDATE SET status='reopened',resolved_at=NULL,closed_at=NULL;
  RETURN jsonb_build_object('outcome','completed');
END $$;
REVOKE ALL ON FUNCTION dop_local_prepare_manual(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dop_local_prepare_manual(uuid,uuid) TO dop_app;
