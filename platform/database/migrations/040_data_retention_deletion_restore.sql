BEGIN;

-- M43 governs synthetic UAT data lifecycle. A run is planned by an operator,
-- object deletion is performed by the existing preservation service, and
-- database redaction happens only after every referenced object is gone.

CREATE TABLE public.data_retention_policies (
    organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
    environment text NOT NULL CHECK (environment = 'UAT'),
    retention_days integer NOT NULL CHECK (retention_days = 30),
    anchor text NOT NULL CHECK (anchor = 'case_terminal_at'),
    hold_approver_roles text[] NOT NULL CHECK (hold_approver_roles = ARRAY['manager','admin']::text[]),
    rpo_hours integer NOT NULL CHECK (rpo_hours BETWEEN 1 AND 24),
    rto_hours integer NOT NULL CHECK (rto_hours BETWEEN 1 AND 24),
    execution_enabled boolean NOT NULL DEFAULT false,
    synthetic_only boolean NOT NULL CHECK (synthetic_only),
    policy_version text NOT NULL,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    updated_by_actor_id uuid,
    updated_at timestamptz NOT NULL,
    FOREIGN KEY (organization_id, updated_by_actor_id)
        REFERENCES public.actors(organization_id, id)
);

CREATE TABLE public.case_legal_holds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    status text NOT NULL CHECK (status IN ('active','released','expired')),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    approved_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    approved_at timestamptz NOT NULL,
    review_due_at timestamptz NOT NULL,
    released_by_actor_id uuid REFERENCES public.actors(id),
    released_at timestamptz,
    release_reason text,
    idempotency_key uuid NOT NULL,
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, approved_by_actor_id) REFERENCES public.actors(organization_id, id),
    FOREIGN KEY (organization_id, released_by_actor_id) REFERENCES public.actors(organization_id, id),
    CHECK ((status = 'active' AND released_at IS NULL AND released_by_actor_id IS NULL)
        OR (status IN ('released','expired') AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX case_legal_holds_active_unique
    ON public.case_legal_holds (organization_id, case_id) WHERE status = 'active';

CREATE TABLE public.retention_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    mode text NOT NULL CHECK (mode IN ('dry_run','apply')),
    status text NOT NULL CHECK (status IN ('completed','queued','processing','failed')),
    policy_version text NOT NULL,
    cutoff_at timestamptz NOT NULL,
    requested_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    candidate_case_count integer NOT NULL DEFAULT 0 CHECK (candidate_case_count >= 0),
    candidate_document_count integer NOT NULL DEFAULT 0 CHECK (candidate_document_count >= 0),
    candidate_object_count integer NOT NULL DEFAULT 0 CHECK (candidate_object_count >= 0),
    deleted_object_count integer NOT NULL DEFAULT 0 CHECK (deleted_object_count >= 0),
    not_found_object_count integer NOT NULL DEFAULT 0 CHECK (not_found_object_count >= 0),
    redacted_case_count integer NOT NULL DEFAULT 0 CHECK (redacted_case_count >= 0),
    failed_object_count integer NOT NULL DEFAULT 0 CHECK (failed_object_count >= 0),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count >= 0),
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    FOREIGN KEY (organization_id, requested_by_actor_id) REFERENCES public.actors(organization_id, id)
);

CREATE TABLE public.retention_case_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    retention_run_id uuid NOT NULL REFERENCES public.retention_runs(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    terminal_at timestamptz NOT NULL,
    document_count integer NOT NULL CHECK (document_count >= 0),
    object_count integer NOT NULL CHECK (object_count >= 0),
    status text NOT NULL CHECK (status IN ('candidate','redacted','blocked_hold','failed')),
    content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    redacted_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, retention_run_id, case_id),
    FOREIGN KEY (organization_id, retention_run_id) REFERENCES public.retention_runs(organization_id, id),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id)
);

CREATE TABLE public.retention_object_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    retention_run_id uuid NOT NULL REFERENCES public.retention_runs(id),
    retention_case_candidate_id uuid NOT NULL REFERENCES public.retention_case_candidates(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    document_id uuid REFERENCES public.documents(id),
    object_kind text NOT NULL CHECK (object_kind IN ('incoming','archive','preview','derived')),
    storage_reference text NOT NULL,
    storage_reference_hash text NOT NULL CHECK (storage_reference_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('queued','processing','deleted','not_found','failed')),
    lease_owner text,
    lease_token uuid,
    lease_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    last_error_code text,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, retention_run_id, storage_reference_hash),
    FOREIGN KEY (organization_id, retention_run_id) REFERENCES public.retention_runs(organization_id, id),
    FOREIGN KEY (organization_id, retention_case_candidate_id) REFERENCES public.retention_case_candidates(organization_id, id),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, document_id) REFERENCES public.documents(organization_id, id),
    CHECK ((status = 'processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR status <> 'processing')
);
CREATE INDEX retention_object_claim_idx ON public.retention_object_candidates
    (organization_id, status, lease_expires_at, created_at);

CREATE TABLE public.data_deletion_proofs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    retention_run_id uuid NOT NULL REFERENCES public.retention_runs(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    policy_version text NOT NULL,
    terminal_at timestamptz NOT NULL,
    deleted_at timestamptz NOT NULL,
    deleted_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    document_count integer NOT NULL CHECK (document_count >= 0),
    object_deleted_count integer NOT NULL CHECK (object_deleted_count >= 0),
    object_not_found_count integer NOT NULL CHECK (object_not_found_count >= 0),
    redacted_event_count integer NOT NULL CHECK (redacted_event_count >= 0),
    proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, retention_run_id, case_id),
    UNIQUE (organization_id, proof_hash),
    FOREIGN KEY (organization_id, retention_run_id) REFERENCES public.retention_runs(organization_id, id),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, deleted_by_actor_id) REFERENCES public.actors(organization_id, id)
);

CREATE TABLE public.retention_restore_drills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    source_case_id uuid NOT NULL REFERENCES public.cases(id),
    status text NOT NULL CHECK (status IN ('passed','failed')),
    backup_format text NOT NULL CHECK (backup_format = 'encrypted_logical_snapshot'),
    backup_digest text NOT NULL CHECK (backup_digest ~ '^[0-9a-f]{64}$'),
    restored_digest text NOT NULL CHECK (restored_digest ~ '^[0-9a-f]{64}$'),
    rpo_hours integer NOT NULL CHECK (rpo_hours BETWEEN 1 AND 24),
    rto_target_hours integer NOT NULL CHECK (rto_target_hours BETWEEN 1 AND 24),
    actual_rto_seconds integer NOT NULL CHECK (actual_rto_seconds >= 0),
    plaintext_written_to_disk boolean NOT NULL CHECK (NOT plaintext_written_to_disk),
    temporary_artifacts_removed boolean NOT NULL CHECK (temporary_artifacts_removed),
    run_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    FOREIGN KEY (organization_id, source_case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, run_by_actor_id) REFERENCES public.actors(organization_id, id)
);

ALTER TABLE public.cases
    ADD COLUMN content_deleted_at timestamptz,
    ADD COLUMN content_deletion_proof_id uuid REFERENCES public.data_deletion_proofs(id);
ALTER TABLE public.documents
    ADD COLUMN content_deleted_at timestamptz,
    ADD COLUMN content_deletion_proof_id uuid REFERENCES public.data_deletion_proofs(id);

ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_case_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_object_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_deletion_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_restore_drills ENABLE ROW LEVEL SECURITY;

CREATE POLICY dop_tenant_isolation ON public.data_retention_policies FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.case_legal_holds FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.retention_runs FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.retention_case_candidates FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.retention_object_candidates FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.data_deletion_proofs FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.retention_restore_drills FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());

GRANT SELECT ON public.data_retention_policies, public.case_legal_holds, public.retention_runs,
    public.retention_case_candidates, public.retention_object_candidates,
    public.data_deletion_proofs, public.retention_restore_drills TO dop_app;

INSERT INTO public.data_retention_policies (
    organization_id,environment,retention_days,anchor,hold_approver_roles,
    rpo_hours,rto_hours,execution_enabled,synthetic_only,policy_version,reason,updated_at
)
SELECT id,'UAT',30,'case_terminal_at',ARRAY['manager','admin']::text[],24,4,false,true,
       'uat-synthetic-30d-v1',
       'M43 conservative UAT candidate policy; execution remains disabled until the operator confirms policy parameters.',
       now()
  FROM public.organizations WHERE organization_key='uat-accounting-firm'
ON CONFLICT (organization_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.dop_confirm_retention_policy(
    p_actor_id uuid,p_retention_days integer,p_anchor text,p_hold_approver_roles text[],
    p_rpo_hours integer,p_rto_hours integer,p_reason text,p_idempotency_key uuid,
    p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_retention_days<>30 OR p_anchor<>'case_terminal_at'
    OR p_hold_approver_roles<>ARRAY['manager','admin']::text[]
    OR p_rpo_hours NOT BETWEEN 1 AND 24 OR p_rto_hours NOT BETWEEN 1 AND 24
    OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_policy_confirmation'); END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id
      AND idempotency_key='retention-policy|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate','executionEnabled',true); END IF;
  UPDATE public.data_retention_policies SET retention_days=30,anchor=p_anchor,
    hold_approver_roles=p_hold_approver_roles,rpo_hours=p_rpo_hours,rto_hours=p_rto_hours,
    execution_enabled=true,reason=btrim(p_reason),updated_by_actor_id=p_actor_id,updated_at=p_now
    WHERE organization_id=org_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','policy_not_found'); END IF;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'retention-policy|'||p_idempotency_key,'Retention.PolicyConfirmed',1,
    'organization',org_id,p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object(
      'retentionDays',30,'anchor',p_anchor,'holdApproverRoles',p_hold_approver_roles,
      'rpoHours',p_rpo_hours,'rtoHours',p_rto_hours,'syntheticOnly',true),p_now);
  RETURN jsonb_build_object('outcome','completed','executionEnabled',true,'policyVersion','uat-synthetic-30d-v1');
END; $$;

CREATE OR REPLACE FUNCTION public.dop_set_case_legal_hold(
    p_actor_id uuid,p_case_id uuid,p_action text,p_reason text,p_review_due_at timestamptz,
    p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    org_id uuid:=public.dop_require_active_manager(p_actor_id);
    case_row public.cases%ROWTYPE; existing public.case_legal_holds%ROWTYPE;
    hold_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
    IF p_action NOT IN ('place','release') OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id FOR UPDATE;
    IF NOT FOUND OR case_row.content_deleted_at IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','not_found','reason','case_not_available');
    END IF;
    SELECT * INTO existing FROM public.case_legal_holds
     WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','legalHoldId',existing.id,'status',existing.status); END IF;
    SELECT * INTO existing FROM public.case_legal_holds
     WHERE organization_id=org_id AND case_id=p_case_id AND status='active' FOR UPDATE;
    IF p_action='place' THEN
        IF p_review_due_at IS NULL OR p_review_due_at <= p_now OR p_review_due_at > p_now + interval '365 days' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','invalid_review_due_at');
        END IF;
        IF FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','active_hold_exists'); END IF;
        INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
          aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
        VALUES (event_id,org_id,'legal-hold|'||p_idempotency_key,'Case.LegalHoldPlaced',1,'case',p_case_id,
          p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object('reviewDueAt',p_review_due_at,'policy','uat-synthetic-30d-v1'),p_now);
        INSERT INTO public.case_legal_holds (id,organization_id,case_id,status,reason,approved_by_actor_id,
          approved_at,review_due_at,idempotency_key,event_id,created_at,updated_at)
        VALUES (hold_id,org_id,p_case_id,'active',btrim(p_reason),p_actor_id,p_now,p_review_due_at,
          p_idempotency_key,event_id,p_now,p_now);
        RETURN jsonb_build_object('outcome','completed','legalHoldId',hold_id,'status','active');
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','active_hold_not_found'); END IF;
    UPDATE public.case_legal_holds SET status='released',released_by_actor_id=p_actor_id,
      released_at=p_now,release_reason=btrim(p_reason),updated_at=p_now WHERE id=existing.id;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (event_id,org_id,'legal-hold|'||p_idempotency_key,'Case.LegalHoldReleased',1,'case',p_case_id,
      p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object('legalHoldId',existing.id),p_now);
    RETURN jsonb_build_object('outcome','completed','legalHoldId',existing.id,'status','released');
END; $$;

CREATE OR REPLACE FUNCTION public.dop_plan_retention_run(
    p_actor_id uuid,p_mode text,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
    org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
    existing public.retention_runs%ROWTYPE; run_id uuid:=gen_random_uuid(); fingerprint text;
    case_count integer:=0; document_count integer:=0; object_count integer:=0;
BEGIN
    IF p_mode NOT IN ('dry_run','apply') OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','policy_not_configured'); END IF;
    IF p_mode='apply' AND NOT policy.execution_enabled THEN
        RETURN jsonb_build_object('outcome','conflict','reason','execution_not_enabled');
    END IF;
    fingerprint:=encode(digest(concat_ws('|',p_mode,btrim(p_reason),policy.policy_version,p_now::text),'sha256'),'hex');
    SELECT * INTO existing FROM public.retention_runs WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','retentionRunId',existing.id,'status',existing.status); END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    INSERT INTO public.retention_runs (id,organization_id,mode,status,policy_version,cutoff_at,
      requested_by_actor_id,reason,idempotency_key,request_fingerprint,started_at,completed_at,created_at,updated_at)
    VALUES (run_id,org_id,p_mode,CASE WHEN p_mode='dry_run' THEN 'completed' ELSE 'queued' END,
      policy.policy_version,p_now-make_interval(days=>policy.retention_days),p_actor_id,btrim(p_reason),
      p_idempotency_key,fingerprint,p_now,CASE WHEN p_mode='dry_run' THEN p_now END,p_now,p_now);

    INSERT INTO public.retention_case_candidates (organization_id,retention_run_id,case_id,terminal_at,
      document_count,object_count,status,content_digest,created_at,updated_at)
    SELECT org_id,run_id,c.id,coalesce(c.completed_at,c.updated_at),count(DISTINCT d.id),
      count(DISTINCT refs.storage_reference),'candidate',
      encode(digest(concat_ws('|',c.id::text,coalesce(c.completed_at,c.updated_at)::text,
        count(DISTINCT d.id)::text,count(DISTINCT refs.storage_reference)::text),'sha256'),'hex'),p_now,p_now
      FROM public.cases c
      LEFT JOIN public.documents d ON d.organization_id=c.organization_id AND d.case_id=c.id
      LEFT JOIN LATERAL (VALUES (d.incoming_storage_ref),(d.archive_storage_ref)) refs(storage_reference)
        ON refs.storage_reference IS NOT NULL
     WHERE c.organization_id=org_id AND c.status IN ('completed','cancelled')
       AND coalesce(c.completed_at,c.updated_at) <= p_now-make_interval(days=>policy.retention_days)
       AND c.content_deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=c.id AND h.status='active')
     GROUP BY c.id,c.completed_at,c.updated_at;

    IF p_mode='apply' THEN
      INSERT INTO public.retention_object_candidates (organization_id,retention_run_id,
        retention_case_candidate_id,case_id,document_id,object_kind,storage_reference,
        storage_reference_hash,status,created_at,updated_at)
      SELECT org_id,run_id,cc.id,d.case_id,d.id,refs.object_kind,refs.storage_reference,
        encode(digest(refs.storage_reference,'sha256'),'hex'),'queued',p_now,p_now
        FROM public.retention_case_candidates cc
        JOIN public.documents d ON d.organization_id=cc.organization_id AND d.case_id=cc.case_id
        CROSS JOIN LATERAL (VALUES ('incoming',d.incoming_storage_ref),('archive',d.archive_storage_ref))
          refs(object_kind,storage_reference)
       WHERE cc.organization_id=org_id AND cc.retention_run_id=run_id AND refs.storage_reference IS NOT NULL
      ON CONFLICT (organization_id,retention_run_id,storage_reference_hash) DO NOTHING;
    END IF;
    SELECT count(*),coalesce(sum(document_count),0),coalesce(sum(object_count),0)
      INTO case_count,document_count,object_count FROM public.retention_case_candidates
     WHERE organization_id=org_id AND retention_run_id=run_id;
    UPDATE public.retention_runs SET candidate_case_count=case_count,candidate_document_count=document_count,
      candidate_object_count=object_count,
      status=CASE WHEN p_mode='apply' AND case_count=0 THEN 'completed' ELSE status END,
      completed_at=CASE WHEN p_mode='apply' AND case_count=0 THEN p_now ELSE completed_at END,
      updated_at=p_now WHERE id=run_id;
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (gen_random_uuid(),org_id,'retention-run|'||p_idempotency_key,'Retention.RunPlanned',1,
      'retention_run',run_id,p_correlation_id,p_actor_id,'ops-retention',jsonb_build_object(
      'mode',p_mode,'policyVersion',policy.policy_version,'candidateCases',case_count,
      'candidateDocuments',document_count,'candidateObjects',object_count,'deletedObjects',0),p_now);
    RETURN jsonb_build_object('outcome','completed','retentionRunId',run_id,
      'status',CASE WHEN p_mode='dry_run' OR case_count=0 THEN 'completed' ELSE 'queued' END,
      'mode',p_mode,'candidateCases',case_count,'candidateDocuments',document_count,
      'candidateObjects',object_count,'deletedObjects',0);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_claim_retention_object(
    p_organization_key text,p_worker_id text,p_lease_seconds integer,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid; candidate public.retention_object_candidates%ROWTYPE; token uuid:=gen_random_uuid();
BEGIN
    IF length(btrim(p_worker_id)) NOT BETWEEN 3 AND 200 OR p_lease_seconds NOT BETWEEN 15 AND 900 THEN
      RETURN jsonb_build_object('outcome','conflict','reason','invalid_claim'); END IF;
    SELECT id INTO org_id FROM public.organizations WHERE organization_key=p_organization_key AND status='active';
    IF org_id IS NULL THEN RETURN jsonb_build_object('outcome','empty'); END IF;
    UPDATE public.case_legal_holds SET status='expired',released_at=p_now,release_reason='Automatic expiry at review deadline.',updated_at=p_now
      WHERE organization_id=org_id AND status='active' AND review_due_at<=p_now;
    SELECT o.* INTO candidate FROM public.retention_object_candidates o
      JOIN public.retention_runs r ON r.organization_id=o.organization_id AND r.id=o.retention_run_id
      JOIN public.retention_case_candidates c ON c.organization_id=o.organization_id AND c.id=o.retention_case_candidate_id
     WHERE o.organization_id=org_id AND r.mode='apply' AND r.status IN ('queued','processing')
       AND c.status='candidate' AND o.attempt_count<3
       AND (o.status='queued' OR (o.status='processing' AND o.lease_expires_at<=p_now)
         OR (o.status='failed' AND o.updated_at<=p_now-interval '5 minutes'))
       AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h
         WHERE h.organization_id=org_id AND h.case_id=o.case_id AND h.status='active')
     ORDER BY o.created_at,o.id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','empty'); END IF;
    UPDATE public.retention_object_candidates SET status='processing',lease_owner=btrim(p_worker_id),
      lease_token=token,lease_expires_at=p_now+make_interval(secs=>p_lease_seconds),
      attempt_count=attempt_count+1,last_error_code=NULL,updated_at=p_now WHERE id=candidate.id;
    UPDATE public.retention_runs SET status='processing',updated_at=p_now WHERE id=candidate.retention_run_id AND status='queued';
    RETURN jsonb_build_object('outcome','claimed','candidateId',candidate.id,'retentionRunId',candidate.retention_run_id,
      'caseId',candidate.case_id,'storageReference',candidate.storage_reference,'storageReferenceHash',candidate.storage_reference_hash,
      'leaseToken',token,'attemptCount',candidate.attempt_count+1);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_complete_retention_object(
    p_candidate_id uuid,p_lease_token uuid,p_outcome text,p_error_code text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate public.retention_object_candidates%ROWTYPE;
BEGIN
    IF p_outcome NOT IN ('deleted','not_found','failed') THEN RETURN jsonb_build_object('outcome','conflict'); END IF;
    SELECT * INTO candidate FROM public.retention_object_candidates WHERE id=p_candidate_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    IF candidate.status IN ('deleted','not_found') THEN RETURN jsonb_build_object('outcome','duplicate','status',candidate.status); END IF;
    IF candidate.status<>'processing' OR candidate.lease_token IS DISTINCT FROM p_lease_token THEN
      RETURN jsonb_build_object('outcome','conflict','reason','lease_mismatch'); END IF;
    UPDATE public.retention_object_candidates SET status=p_outcome,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,last_error_code=CASE WHEN p_outcome='failed' THEN coalesce(p_error_code,'storage_delete_failed') END,
      deleted_at=CASE WHEN p_outcome IN ('deleted','not_found') THEN p_now END,updated_at=p_now WHERE id=candidate.id;
    RETURN jsonb_build_object('outcome','completed','status',p_outcome,'retentionRunId',candidate.retention_run_id);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_finalize_retention_runs(
    p_organization_key text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org_id uuid; candidate record; proof_id uuid; proof_event_id uuid; proof_hash text;
  event_count integer; deleted_count integer; not_found_count integer; finalized integer:=0;
BEGIN
    SELECT id INTO org_id FROM public.organizations WHERE organization_key=p_organization_key AND status='active';
    IF org_id IS NULL THEN RETURN jsonb_build_object('outcome','completed','finalizedCases',0); END IF;
    FOR candidate IN
      SELECT cc.*,r.policy_version,r.requested_by_actor_id FROM public.retention_case_candidates cc
      JOIN public.retention_runs r ON r.organization_id=cc.organization_id AND r.id=cc.retention_run_id
      WHERE cc.organization_id=org_id AND cc.status='candidate' AND r.mode='apply' AND r.status IN ('queued','processing')
        AND NOT EXISTS (SELECT 1 FROM public.case_legal_holds h WHERE h.organization_id=org_id AND h.case_id=cc.case_id AND h.status='active')
        AND NOT EXISTS (SELECT 1 FROM public.retention_object_candidates o WHERE o.organization_id=org_id
          AND o.retention_case_candidate_id=cc.id AND o.status NOT IN ('deleted','not_found'))
      ORDER BY cc.created_at FOR UPDATE OF cc SKIP LOCKED
    LOOP
      proof_id:=gen_random_uuid(); proof_event_id:=gen_random_uuid();
      SELECT count(*) INTO event_count FROM public.workflow_events e WHERE e.organization_id=org_id AND (
        (e.aggregate_type='case' AND e.aggregate_id=candidate.case_id)
        OR (e.aggregate_type='document' AND e.aggregate_id IN (SELECT id FROM public.documents WHERE organization_id=org_id AND case_id=candidate.case_id))
        OR (e.aggregate_type='issue' AND e.aggregate_id IN (SELECT id FROM public.issues WHERE organization_id=org_id AND case_id=candidate.case_id))
        OR (e.aggregate_type='task' AND e.aggregate_id IN (SELECT id FROM public.tasks WHERE organization_id=org_id AND case_id=candidate.case_id))
        OR (e.aggregate_type='delivery_job' AND e.aggregate_id IN (SELECT id FROM public.delivery_jobs WHERE organization_id=org_id AND case_id=candidate.case_id))
      );
      SELECT count(*) FILTER (WHERE status='deleted'),count(*) FILTER (WHERE status='not_found')
        INTO deleted_count,not_found_count FROM public.retention_object_candidates
        WHERE organization_id=org_id AND retention_case_candidate_id=candidate.id;
      proof_hash:=encode(digest(concat_ws('|',candidate.retention_run_id::text,candidate.case_id::text,
        candidate.content_digest,deleted_count::text,not_found_count::text,event_count::text,p_now::text),'sha256'),'hex');

      INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
      VALUES (proof_event_id,org_id,'retention-proof|'||proof_id,'Case.ContentDeleted',1,'case',candidate.case_id,
        gen_random_uuid(),candidate.requested_by_actor_id,'retention-worker',jsonb_build_object('proofId',proof_id,
        'policyVersion',candidate.policy_version,'contentDigest',candidate.content_digest,'documentCount',candidate.document_count,
        'objectDeletedCount',deleted_count,'objectNotFoundCount',not_found_count,'redactedEventCount',event_count),p_now);
      INSERT INTO public.data_deletion_proofs (id,organization_id,retention_run_id,case_id,policy_version,terminal_at,
        deleted_at,deleted_by_actor_id,content_digest,document_count,object_deleted_count,object_not_found_count,
        redacted_event_count,proof_hash,event_id,created_at)
      VALUES (proof_id,org_id,candidate.retention_run_id,candidate.case_id,candidate.policy_version,candidate.terminal_at,
        p_now,candidate.requested_by_actor_id,candidate.content_digest,candidate.document_count,deleted_count,
        not_found_count,event_count,proof_hash,proof_event_id,p_now);

      UPDATE public.submissions SET raw_payload_reference=NULL,source_submission_id='deleted:'||id::text,updated_at=p_now
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.classification_attempts SET predicted_document_type_code=NULL,confidence=NULL,result=NULL,
        raw_response_reference=NULL,error_code=CASE WHEN error_code IS NULL THEN NULL ELSE 'content_deleted' END
        WHERE organization_id=org_id AND document_id IN (SELECT id FROM public.documents WHERE organization_id=org_id AND case_id=candidate.case_id);
      UPDATE public.document_review_decisions SET rationale='Content deleted under retention policy; immutable decision identity retained.'
        WHERE organization_id=org_id AND document_id IN (SELECT id FROM public.documents WHERE organization_id=org_id AND case_id=candidate.case_id);
      UPDATE public.issues SET routing_reason=NULL,details=jsonb_build_object('contentDeleted',true,'proofId',proof_id)
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.tasks SET context=jsonb_build_object('contentDeleted',true,'proofId',proof_id)
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.case_completeness_assessments SET result=jsonb_build_object('contentDeleted',true,'proofId',proof_id)
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.completeness_exception_evidence SET evidence=jsonb_build_object('contentDeleted',true,'proofId',proof_id)
        WHERE organization_id=org_id AND assessment_id IN (SELECT id FROM public.case_completeness_assessments WHERE organization_id=org_id AND case_id=candidate.case_id);
      UPDATE public.missing_document_request_drafts SET recipient_reference='deleted',recipient_snapshot='{"contentDeleted":true}'::jsonb,
        subject_line='[deleted]',body_text='Content deleted under retention policy.',requested_items='[]'::jsonb,source_issue_ids=ARRAY[]::uuid[],updated_at=p_now
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.missing_document_request_revisions SET recipient_reference='deleted',recipient_snapshot='{"contentDeleted":true}'::jsonb,
        subject_line='[deleted]',body_text='Content deleted under retention policy.'
        WHERE organization_id=org_id AND request_draft_id IN (SELECT id FROM public.missing_document_request_drafts WHERE organization_id=org_id AND case_id=candidate.case_id);
      UPDATE public.reminder_instances SET recipient_reference='deleted',recipient_snapshot='{"address":"deleted@document-operations.invalid"}'::jsonb,
        content_snapshot='{"contentDeleted":true}'::jsonb
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.delivery_jobs SET recipient_snapshot='{"address":"deleted@document-operations.invalid"}'::jsonb,
        subject_line='[deleted]',body_text='Content deleted under retention policy.',provider_message_id=NULL,last_error_code=NULL,updated_at=p_now
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.documents SET source_file_id=NULL,original_filename='[deleted]',declared_mime_type=NULL,
        detected_mime_type=NULL,size_bytes=NULL,incoming_storage_ref=NULL,archive_storage_ref=NULL,
        classification_summary=NULL,review_reason=NULL,content_deleted_at=p_now,content_deletion_proof_id=proof_id,updated_at=p_now
        WHERE organization_id=org_id AND case_id=candidate.case_id;
      UPDATE public.workflow_events SET payload=jsonb_build_object('contentDeleted',true,'originalPayloadHash',
        encode(digest(payload::text,'sha256'),'hex'),'proofId',proof_id)
        WHERE organization_id=org_id AND id<>proof_event_id AND (
          (aggregate_type='case' AND aggregate_id=candidate.case_id)
          OR (aggregate_type='document' AND aggregate_id IN (SELECT id FROM public.documents WHERE organization_id=org_id AND case_id=candidate.case_id))
          OR (aggregate_type='issue' AND aggregate_id IN (SELECT id FROM public.issues WHERE organization_id=org_id AND case_id=candidate.case_id))
          OR (aggregate_type='task' AND aggregate_id IN (SELECT id FROM public.tasks WHERE organization_id=org_id AND case_id=candidate.case_id))
          OR (aggregate_type='delivery_job' AND aggregate_id IN (SELECT id FROM public.delivery_jobs WHERE organization_id=org_id AND case_id=candidate.case_id))
        );
      UPDATE public.cases SET config_snapshot=jsonb_build_object('contentDeleted',true,'proofId',proof_id),
        external_reference=NULL,content_deleted_at=p_now,content_deletion_proof_id=proof_id,updated_at=p_now
        WHERE organization_id=org_id AND id=candidate.case_id;
      UPDATE public.retention_case_candidates SET status='redacted',redacted_at=p_now,updated_at=p_now WHERE id=candidate.id;
      finalized:=finalized+1;
    END LOOP;
    UPDATE public.retention_runs r SET
      deleted_object_count=(SELECT count(*) FROM public.retention_object_candidates o WHERE o.retention_run_id=r.id AND o.status='deleted'),
      not_found_object_count=(SELECT count(*) FROM public.retention_object_candidates o WHERE o.retention_run_id=r.id AND o.status='not_found'),
      failed_object_count=(SELECT count(*) FROM public.retention_object_candidates o WHERE o.retention_run_id=r.id AND o.status='failed' AND o.attempt_count>=3),
      redacted_case_count=(SELECT count(*) FROM public.retention_case_candidates c WHERE c.retention_run_id=r.id AND c.status='redacted'),
      status=CASE
        WHEN EXISTS (SELECT 1 FROM public.retention_object_candidates o WHERE o.retention_run_id=r.id AND o.status='failed' AND o.attempt_count>=3) THEN 'failed'
        WHEN NOT EXISTS (SELECT 1 FROM public.retention_case_candidates c WHERE c.retention_run_id=r.id AND c.status='candidate') THEN 'completed'
        ELSE r.status END,
      completed_at=CASE WHEN NOT EXISTS (SELECT 1 FROM public.retention_case_candidates c WHERE c.retention_run_id=r.id AND c.status='candidate') THEN p_now ELSE r.completed_at END,
      updated_at=p_now
      WHERE r.organization_id=org_id AND r.mode='apply' AND r.status IN ('queued','processing');
    RETURN jsonb_build_object('outcome','completed','finalizedCases',finalized);
END; $$;

CREATE OR REPLACE FUNCTION public.dop_record_retention_restore_drill(
    p_actor_id uuid,p_case_id uuid,p_status text,p_backup_digest text,p_restored_digest text,
    p_actual_rto_seconds integer,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); policy public.data_retention_policies%ROWTYPE;
  drill_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_status NOT IN ('passed','failed') OR p_backup_digest !~ '^[0-9a-f]{64}$' OR p_restored_digest !~ '^[0-9a-f]{64}$'
    OR p_actual_rto_seconds<0 OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO policy FROM public.data_retention_policies WHERE organization_id=org_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.cases WHERE organization_id=org_id AND id=p_case_id) THEN
    RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=org_id AND idempotency_key='restore-drill|'||p_idempotency_key) THEN
    RETURN jsonb_build_object('outcome','duplicate'); END IF;
  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (event_id,org_id,'restore-drill|'||p_idempotency_key,'Retention.RestoreDrillRecorded',1,'case',p_case_id,
    p_correlation_id,p_actor_id,'retention-restore-drill',jsonb_build_object('status',p_status,
    'backupDigest',p_backup_digest,'restoredDigest',p_restored_digest,'actualRtoSeconds',p_actual_rto_seconds,
    'plaintextWrittenToDisk',false,'temporaryArtifactsRemoved',true),p_now);
  INSERT INTO public.retention_restore_drills (id,organization_id,source_case_id,status,backup_format,
    backup_digest,restored_digest,rpo_hours,rto_target_hours,actual_rto_seconds,plaintext_written_to_disk,
    temporary_artifacts_removed,run_by_actor_id,reason,event_id,created_at)
  VALUES (drill_id,org_id,p_case_id,p_status,'encrypted_logical_snapshot',p_backup_digest,p_restored_digest,
    policy.rpo_hours,policy.rto_hours,p_actual_rto_seconds,false,true,p_actor_id,btrim(p_reason),event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','restoreDrillId',drill_id,'status',p_status);
END; $$;

REVOKE ALL ON FUNCTION public.dop_set_case_legal_hold(uuid,uuid,text,text,timestamptz,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_confirm_retention_policy(uuid,integer,text,text[],integer,integer,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_claim_retention_object(text,text,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_complete_retention_object(uuid,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_finalize_retention_runs(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_record_retention_restore_drill(uuid,uuid,text,text,text,integer,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_set_case_legal_hold(uuid,uuid,text,text,timestamptz,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_confirm_retention_policy(uuid,integer,text,text[],integer,integer,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_plan_retention_run(uuid,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_claim_retention_object(text,text,integer,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_complete_retention_object(uuid,uuid,text,text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_finalize_retention_runs(text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_record_retention_restore_drill(uuid,uuid,text,text,text,integer,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
