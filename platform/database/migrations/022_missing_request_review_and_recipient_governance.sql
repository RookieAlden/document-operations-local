BEGIN;

-- M26 turns the M25 non-deliverable snapshot into an auditable internal
-- authoring and review workflow. Approval is explicitly not permission to
-- send: every revision remains delivery_mode=disabled and external_call_count=0.
CREATE TABLE public.subject_message_recipient_allowlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    subject_id uuid NOT NULL REFERENCES public.subjects(id),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    purpose text NOT NULL CHECK (purpose = 'missing_document_request'),
    status text NOT NULL CHECK (status IN ('active','revoked')),
    source text NOT NULL CHECK (source IN ('canonical_primary_contact','manual_approval')),
    approved_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(reason) BETWEEN 12 AND 1000),
    approved_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, subject_id, actor_id, purpose),
    CONSTRAINT subject_message_recipient_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES public.subjects(organization_id, id),
    CONSTRAINT subject_message_recipient_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT subject_message_recipient_approver_same_org_fk
        FOREIGN KEY (organization_id, approved_by_actor_id) REFERENCES public.actors(organization_id, id),
    CHECK ((status = 'active' AND revoked_at IS NULL) OR status = 'revoked')
);

CREATE TABLE public.missing_document_request_revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    request_draft_id uuid NOT NULL REFERENCES public.missing_document_request_drafts(id),
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN (
        'draft','in_review','changes_requested','approved','rejected','superseded','cancelled'
    )),
    recipient_allowlist_id uuid REFERENCES public.subject_message_recipient_allowlist(id),
    recipient_reference text NOT NULL,
    recipient_snapshot jsonb NOT NULL CHECK (jsonb_typeof(recipient_snapshot) = 'object'),
    subject_line text NOT NULL CHECK (length(subject_line) BETWEEN 1 AND 300),
    body_text text NOT NULL CHECK (length(body_text) BETWEEN 20 AND 10000),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    change_reason text NOT NULL CHECK (length(change_reason) BETWEEN 12 AND 1000),
    created_by_actor_id uuid REFERENCES public.actors(id),
    submitted_by_actor_id uuid REFERENCES public.actors(id),
    submitted_at timestamptz,
    reviewed_by_actor_id uuid REFERENCES public.actors(id),
    reviewed_at timestamptz,
    review_reason text,
    delivery_mode text NOT NULL DEFAULT 'disabled' CHECK (delivery_mode = 'disabled'),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    idempotency_key uuid,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, request_draft_id, revision),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT missing_request_revision_draft_same_org_fk
        FOREIGN KEY (organization_id, request_draft_id)
        REFERENCES public.missing_document_request_drafts(organization_id, id),
    CONSTRAINT missing_request_revision_recipient_same_org_fk
        FOREIGN KEY (organization_id, recipient_allowlist_id)
        REFERENCES public.subject_message_recipient_allowlist(organization_id, id),
    CONSTRAINT missing_request_revision_creator_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT missing_request_revision_submitter_same_org_fk
        FOREIGN KEY (organization_id, submitted_by_actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT missing_request_revision_reviewer_same_org_fk
        FOREIGN KEY (organization_id, reviewed_by_actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT missing_request_revision_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id),
    CHECK ((submitted_by_actor_id IS NULL AND submitted_at IS NULL)
        OR (submitted_by_actor_id IS NOT NULL AND submitted_at IS NOT NULL)),
    CHECK ((reviewed_by_actor_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
        OR (reviewed_by_actor_id IS NOT NULL AND reviewed_at IS NOT NULL
            AND length(review_reason) BETWEEN 12 AND 1000))
);

CREATE TABLE public.missing_document_request_review_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    revision_id uuid NOT NULL REFERENCES public.missing_document_request_revisions(id),
    action text NOT NULL CHECK (action IN ('submitted','returned','approved','rejected')),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    reason text NOT NULL CHECK (length(reason) BETWEEN 12 AND 1000),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES public.workflow_events(id),
    decided_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    CONSTRAINT missing_request_decision_revision_same_org_fk
        FOREIGN KEY (organization_id, revision_id)
        REFERENCES public.missing_document_request_revisions(organization_id, id),
    CONSTRAINT missing_request_decision_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    CONSTRAINT missing_request_decision_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

CREATE INDEX subject_message_recipient_active_idx
    ON public.subject_message_recipient_allowlist (organization_id, subject_id, purpose, status);
CREATE INDEX missing_request_revision_history_idx
    ON public.missing_document_request_revisions (organization_id, request_draft_id, revision DESC);
CREATE INDEX missing_request_decision_history_idx
    ON public.missing_document_request_review_decisions (organization_id, revision_id, decided_at DESC);
CREATE UNIQUE INDEX missing_request_open_revision_unique
    ON public.missing_document_request_revisions (organization_id, request_draft_id)
    WHERE status IN ('draft','in_review');
CREATE UNIQUE INDEX missing_request_approved_revision_unique
    ON public.missing_document_request_revisions (organization_id, request_draft_id)
    WHERE status = 'approved';

ALTER TABLE public.subject_message_recipient_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missing_document_request_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.missing_document_request_review_decisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.subject_message_recipient_allowlist,
    public.missing_document_request_revisions,
    public.missing_document_request_review_decisions TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.subject_message_recipient_allowlist
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.missing_document_request_revisions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.missing_document_request_review_decisions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_seed_missing_request_review(
    p_request_draft_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    draft_row public.missing_document_request_drafts%ROWTYPE;
    subject_row public.subjects%ROWTYPE;
    contact_row public.actors%ROWTYPE;
    allow_row public.subject_message_recipient_allowlist%ROWTYPE;
    revision_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    recipient_reference_value text;
    recipient_snapshot_value jsonb;
    revision_content_hash text;
    revision_fingerprint text;
BEGIN
    SELECT * INTO draft_row FROM public.missing_document_request_drafts
     WHERE id = p_request_draft_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO subject_row FROM public.subjects
     WHERE organization_id = draft_row.organization_id AND id = draft_row.subject_id;
    IF subject_row.primary_contact_actor_id IS NOT NULL THEN
        SELECT * INTO contact_row FROM public.actors
         WHERE organization_id = draft_row.organization_id
           AND id = subject_row.primary_contact_actor_id
           AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL;
    END IF;
    IF contact_row.id IS NOT NULL THEN
        INSERT INTO public.subject_message_recipient_allowlist (
            id, organization_id, subject_id, actor_id, purpose, status, source,
            approved_by_actor_id, reason, approved_at, created_at, updated_at
        ) VALUES (
            gen_random_uuid(), draft_row.organization_id, draft_row.subject_id, contact_row.id,
            'missing_document_request', 'active', 'canonical_primary_contact', NULL,
            'Canonical主联系人已通过既有工作对象治理进入补件收件人名单。',
            p_now, p_now, p_now
        ) ON CONFLICT (organization_id, subject_id, actor_id, purpose)
          DO UPDATE SET status = 'active', revoked_at = NULL, updated_at = EXCLUDED.updated_at;
        SELECT * INTO allow_row FROM public.subject_message_recipient_allowlist
         WHERE organization_id = draft_row.organization_id
           AND subject_id = draft_row.subject_id AND actor_id = contact_row.id
           AND purpose = 'missing_document_request' AND status = 'active';
    END IF;
    IF EXISTS (SELECT 1 FROM public.missing_document_request_revisions
        WHERE organization_id = draft_row.organization_id AND request_draft_id = draft_row.id) THEN
        SELECT id INTO revision_id FROM public.missing_document_request_revisions
         WHERE organization_id = draft_row.organization_id AND request_draft_id = draft_row.id
         ORDER BY revision DESC LIMIT 1;
        RETURN revision_id;
    END IF;
    recipient_reference_value := CASE WHEN allow_row.id IS NULL
        THEN 'subject:' || subject_row.subject_key ELSE 'actor:' || contact_row.id::text END;
    recipient_snapshot_value := jsonb_build_object(
        'resolutionStatus', CASE WHEN allow_row.id IS NULL THEN 'unresolved' ELSE 'ready' END,
        'actorId', contact_row.id, 'displayName', contact_row.display_name, 'email', contact_row.email,
        'policy', 'allowlist_only', 'allowlistId', allow_row.id
    );
    revision_content_hash := encode(digest(
        recipient_reference_value || '|' || trim(draft_row.subject_line) || '|'
        || trim(draft_row.body_text) || '|' || draft_row.requested_items::text,
        'sha256'), 'hex');
    revision_fingerprint := encode(digest(concat_ws('|', draft_row.id::text,
        recipient_reference_value, revision_content_hash, 'seed'), 'sha256'), 'hex');
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, producer, payload, occurred_at
    ) VALUES (
        event_id, draft_row.organization_id, 'missing-request-review-seed|' || draft_row.id::text,
        'MissingDocumentRequest.RevisionCreated', 1, 'missing_document_request_revision',
        revision_id, gen_random_uuid(), 'dop.core.missing-request-review.v1',
        jsonb_build_object('request_draft_id', draft_row.id, 'revision', 1,
            'recipient_policy', 'allowlist_only', 'delivery_mode', 'disabled', 'external_call_count', 0), p_now
    );
    INSERT INTO public.missing_document_request_revisions (
        id, organization_id, request_draft_id, revision, status,
        recipient_allowlist_id, recipient_reference, recipient_snapshot,
        subject_line, body_text, content_hash, change_reason, created_by_actor_id,
        delivery_mode, external_call_count, idempotency_key, request_fingerprint,
        event_id, created_at
    ) VALUES (
        revision_id, draft_row.organization_id, draft_row.id, 1,
        CASE WHEN draft_row.status = 'draft' THEN 'draft' ELSE 'cancelled' END,
        allow_row.id,
        recipient_reference_value, recipient_snapshot_value, draft_row.subject_line,
        draft_row.body_text, revision_content_hash,
        '系统根据最新完整性证据生成初始内部草稿修订。', NULL,
        'disabled', 0, NULL, revision_fingerprint, event_id, p_now
    );
    RETURN revision_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_missing_request_seed_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.dop_seed_missing_request_review(NEW.id, NEW.created_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER missing_document_request_seed_review
AFTER INSERT ON public.missing_document_request_drafts
FOR EACH ROW EXECUTE FUNCTION public.dop_missing_request_seed_trigger();

CREATE OR REPLACE FUNCTION public.dop_create_missing_request_revision(
    p_actor_id uuid,
    p_request_draft_id uuid,
    p_recipient_actor_id uuid,
    p_subject_line text,
    p_body_text text,
    p_reason text,
    p_idempotency_key uuid,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_require_active_manager(p_actor_id);
    draft_row public.missing_document_request_drafts%ROWTYPE;
    source public.missing_document_request_revisions%ROWTYPE;
    existing public.missing_document_request_revisions%ROWTYPE;
    allow_row public.subject_message_recipient_allowlist%ROWTYPE;
    recipient_row public.actors%ROWTYPE;
    new_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    content_hash_value text;
    fingerprint text;
    next_revision integer;
BEGIN
    IF length(trim(p_subject_line)) NOT BETWEEN 1 AND 300
       OR length(trim(p_body_text)) NOT BETWEEN 20 AND 10000
       OR length(trim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO draft_row FROM public.missing_document_request_drafts
     WHERE organization_id = org_id AND id = p_request_draft_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','request_draft_not_found'); END IF;
    IF draft_row.status <> 'draft' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','request_draft_not_current');
    END IF;
    SELECT * INTO allow_row FROM public.subject_message_recipient_allowlist
     WHERE organization_id = org_id AND subject_id = draft_row.subject_id
       AND actor_id = p_recipient_actor_id AND purpose = 'missing_document_request'
       AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_allowlisted'); END IF;
    SELECT * INTO recipient_row FROM public.actors
     WHERE organization_id = org_id AND id = p_recipient_actor_id
       AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_available'); END IF;
    content_hash_value := encode(digest(
        'actor:' || recipient_row.id::text || '|' || trim(p_subject_line) || '|'
        || trim(p_body_text) || '|' || draft_row.requested_items::text, 'sha256'), 'hex');
    fingerprint := encode(digest(concat_ws('|', p_request_draft_id::text,
        recipient_row.id::text, content_hash_value, trim(p_reason)), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.missing_document_request_revisions
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','revisionId',existing.id,
                'revision',existing.revision,'status',existing.status);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO source FROM public.missing_document_request_revisions
     WHERE organization_id = org_id AND request_draft_id = draft_row.id
     ORDER BY revision DESC LIMIT 1 FOR UPDATE;
    IF source.id IS NOT NULL AND source.status NOT IN ('draft','changes_requested','rejected') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','revision_not_editable');
    END IF;
    next_revision := coalesce(source.revision, 0) + 1;
    IF source.status = 'draft' THEN
        UPDATE public.missing_document_request_revisions SET status = 'superseded'
         WHERE id = source.id;
    END IF;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        event_id, org_id, p_idempotency_key::text || ':event',
        'MissingDocumentRequest.RevisionCreated', 1, 'missing_document_request_revision',
        new_id, p_correlation_id, p_actor_id, 'ops-missing-request-review',
        jsonb_build_object('request_draft_id',draft_row.id,'revision',next_revision,
            'content_hash',content_hash_value,'recipient_policy','allowlist_only',
            'reason',trim(p_reason),'delivery_mode','disabled','external_call_count',0), p_now
    );
    INSERT INTO public.missing_document_request_revisions (
        id, organization_id, request_draft_id, revision, status,
        recipient_allowlist_id, recipient_reference, recipient_snapshot,
        subject_line, body_text, content_hash, change_reason, created_by_actor_id,
        delivery_mode, external_call_count, idempotency_key, request_fingerprint,
        event_id, created_at
    ) VALUES (
        new_id, org_id, draft_row.id, next_revision, 'draft', allow_row.id,
        'actor:' || recipient_row.id::text,
        jsonb_build_object('resolutionStatus','ready','actorId',recipient_row.id,
            'displayName',recipient_row.display_name,'email',lower(recipient_row.email),
            'policy','allowlist_only','allowlistId',allow_row.id),
        trim(p_subject_line), trim(p_body_text), content_hash_value, trim(p_reason), p_actor_id,
        'disabled', 0, p_idempotency_key, fingerprint, event_id, p_now
    );
    RETURN jsonb_build_object('outcome','completed','revisionId',new_id,
        'revision',next_revision,'status','draft','contentHash',content_hash_value,
        'deliveryMode','disabled','externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_missing_request_revision(
    p_actor_id uuid,
    p_revision_id uuid,
    p_action text,
    p_reason text,
    p_idempotency_key uuid,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_require_active_manager(p_actor_id);
    revision_row public.missing_document_request_revisions%ROWTYPE;
    draft_row public.missing_document_request_drafts%ROWTYPE;
    allow_row public.subject_message_recipient_allowlist%ROWTYPE;
    existing public.missing_document_request_review_decisions%ROWTYPE;
    decision_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
    target_status text;
    decision_action text;
    event_type text;
    fingerprint text;
BEGIN
    IF p_action NOT IN ('submit_review','return_to_draft','approve','reject')
       OR length(trim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|',p_revision_id::text,p_action,trim(p_reason)), 'sha256'),'hex');
    SELECT * INTO existing FROM public.missing_document_request_review_decisions
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome','duplicate','decisionId',existing.id,
                'revisionId',existing.revision_id,'action',existing.action);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
    END IF;
    SELECT * INTO revision_row FROM public.missing_document_request_revisions
     WHERE organization_id = org_id AND id = p_revision_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','revision_not_found'); END IF;
    SELECT * INTO draft_row FROM public.missing_document_request_drafts
     WHERE organization_id = org_id AND id = revision_row.request_draft_id FOR UPDATE;
    IF draft_row.status <> 'draft' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','request_draft_not_current');
    END IF;
    IF EXISTS (SELECT 1 FROM public.missing_document_request_revisions newer
        WHERE newer.organization_id = org_id AND newer.request_draft_id = revision_row.request_draft_id
          AND newer.revision > revision_row.revision) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','revision_not_current');
    END IF;
    IF revision_row.recipient_allowlist_id IS NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_allowlisted');
    END IF;
    SELECT * INTO allow_row FROM public.subject_message_recipient_allowlist
     WHERE organization_id = org_id AND id = revision_row.recipient_allowlist_id
       AND subject_id = draft_row.subject_id AND status = 'active';
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.actors
        WHERE organization_id = org_id AND id = allow_row.actor_id
          AND actor_type = 'customer' AND status = 'active' AND email IS NOT NULL) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','recipient_not_available');
    END IF;
    IF p_action = 'submit_review' AND revision_row.status = 'draft' THEN
        target_status := 'in_review'; decision_action := 'submitted';
        event_type := 'MissingDocumentRequest.ReviewSubmitted';
    ELSIF p_action = 'return_to_draft' AND revision_row.status = 'in_review' THEN
        target_status := 'changes_requested'; decision_action := 'returned';
        event_type := 'MissingDocumentRequest.ChangesRequested';
    ELSIF p_action = 'approve' AND revision_row.status = 'in_review' THEN
        IF revision_row.submitted_by_actor_id = p_actor_id
           OR revision_row.created_by_actor_id = p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','independent_reviewer_required');
        END IF;
        target_status := 'approved'; decision_action := 'approved';
        event_type := 'MissingDocumentRequest.Approved';
    ELSIF p_action = 'reject' AND revision_row.status = 'in_review' THEN
        IF revision_row.submitted_by_actor_id = p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','independent_reviewer_required');
        END IF;
        target_status := 'rejected'; decision_action := 'rejected';
        event_type := 'MissingDocumentRequest.Rejected';
    ELSE
        RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
    END IF;
    UPDATE public.missing_document_request_revisions
       SET status = target_status,
           submitted_by_actor_id = CASE WHEN p_action = 'submit_review' THEN p_actor_id ELSE submitted_by_actor_id END,
           submitted_at = CASE WHEN p_action = 'submit_review' THEN p_now ELSE submitted_at END,
           reviewed_by_actor_id = CASE WHEN p_action <> 'submit_review' THEN p_actor_id ELSE reviewed_by_actor_id END,
           reviewed_at = CASE WHEN p_action <> 'submit_review' THEN p_now ELSE reviewed_at END,
           review_reason = CASE WHEN p_action <> 'submit_review' THEN trim(p_reason) ELSE review_reason END
     WHERE id = revision_row.id;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        event_id, org_id, p_idempotency_key::text || ':event', event_type, 1,
        'missing_document_request_revision', revision_row.id, p_correlation_id,
        p_actor_id, 'ops-missing-request-review',
        jsonb_build_object('request_draft_id',draft_row.id,'revision',revision_row.revision,
            'content_hash',revision_row.content_hash,'status',target_status,'reason',trim(p_reason),
            'delivery_mode','disabled','external_call_count',0), p_now
    );
    INSERT INTO public.missing_document_request_review_decisions (
        id, organization_id, revision_id, action, actor_id, reason, content_hash,
        idempotency_key, request_fingerprint, event_id, decided_at
    ) VALUES (
        decision_id, org_id, revision_row.id, decision_action, p_actor_id, trim(p_reason),
        revision_row.content_hash, p_idempotency_key, fingerprint, event_id, p_now
    );
    RETURN jsonb_build_object('outcome','completed','revisionId',revision_row.id,
        'decisionId',decision_id,'action',decision_action,'status',target_status,
        'deliveryMode','disabled','externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_missing_request_parent_status_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF OLD.status = 'draft' AND NEW.status IN ('superseded','cancelled') THEN
        UPDATE public.missing_document_request_revisions
           SET status = 'cancelled'
         WHERE organization_id = NEW.organization_id AND request_draft_id = NEW.id
           AND status IN ('draft','in_review','changes_requested');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER missing_document_request_cancel_open_reviews
AFTER UPDATE OF status ON public.missing_document_request_drafts
FOR EACH ROW EXECUTE FUNCTION public.dop_missing_request_parent_status_trigger();

-- Backfill existing synthetic DEV drafts and their current Canonical primary
-- contacts into the governed review model.
DO $$
DECLARE item record;
BEGIN
    FOR item IN SELECT id, created_at FROM public.missing_document_request_drafts ORDER BY created_at, id
    LOOP
        PERFORM public.dop_seed_missing_request_review(item.id, item.created_at);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.dop_seed_missing_request_review(uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_missing_request_seed_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_missing_request_revision(uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_missing_request_revision(uuid,uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_missing_request_parent_status_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_missing_request_revision(uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_missing_request_revision(uuid,uuid,text,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
