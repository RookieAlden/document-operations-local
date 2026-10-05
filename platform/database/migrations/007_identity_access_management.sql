BEGIN;

CREATE TABLE identity_invitation_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    email text NOT NULL CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
    display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 120),
    actor_type text NOT NULL CHECK (actor_type IN ('staff', 'manager', 'admin')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'cancelled', 'provisioned')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    created_by_actor_id uuid NOT NULL REFERENCES actors(id),
    cancelled_by_actor_id uuid REFERENCES actors(id),
    cancelled_at timestamptz,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, idempotency_key),
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX identity_invitation_drafts_active_email_idx
    ON identity_invitation_drafts (organization_id, email)
    WHERE status = 'draft';

ALTER TABLE identity_invitation_drafts
    ADD CONSTRAINT identity_invitation_creator_same_org_fk
        FOREIGN KEY (organization_id, created_by_actor_id) REFERENCES actors (organization_id, id),
    ADD CONSTRAINT identity_invitation_canceller_same_org_fk
        FOREIGN KEY (organization_id, cancelled_by_actor_id) REFERENCES actors (organization_id, id);

CREATE TABLE actor_access_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    target_actor_id uuid NOT NULL REFERENCES actors(id),
    changed_by_actor_id uuid NOT NULL REFERENCES actors(id),
    action text NOT NULL CHECK (action IN ('change_role', 'deactivate', 'reactivate')),
    previous_actor_type text NOT NULL CHECK (previous_actor_type IN ('staff', 'manager', 'admin')),
    resulting_actor_type text NOT NULL CHECK (resulting_actor_type IN ('staff', 'manager', 'admin')),
    previous_status text NOT NULL CHECK (previous_status IN ('active', 'inactive')),
    resulting_status text NOT NULL CHECK (resulting_status IN ('active', 'inactive')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    changed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, idempotency_key),
    UNIQUE (organization_id, id)
);

ALTER TABLE actor_access_changes
    ADD CONSTRAINT actor_access_target_same_org_fk
        FOREIGN KEY (organization_id, target_actor_id) REFERENCES actors (organization_id, id),
    ADD CONSTRAINT actor_access_changer_same_org_fk
        FOREIGN KEY (organization_id, changed_by_actor_id) REFERENCES actors (organization_id, id),
    ADD CONSTRAINT actor_access_event_same_org_fk
        FOREIGN KEY (organization_id, event_id) REFERENCES workflow_events (organization_id, id);

ALTER TABLE identity_invitation_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE actor_access_changes ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE identity_invitation_drafts, actor_access_changes TO dop_app;

CREATE POLICY dop_tenant_isolation ON identity_invitation_drafts
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON actor_access_changes
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_require_active_admin(p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_current_organization_id();
BEGIN
    IF v_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE id = p_actor_id AND organization_id = v_organization_id
           AND actor_type = 'admin' AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;
    RETURN v_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_identity_invitation_draft(
    p_actor_id uuid, p_email text, p_display_name text, p_actor_type text,
    p_reason text, p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    normalized_email text := lower(btrim(p_email));
    normalized_name text := btrim(p_display_name);
    fingerprint text;
    existing public.identity_invitation_drafts%ROWTYPE;
    invitation_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF p_actor_type NOT IN ('staff', 'manager', 'admin') OR char_length(normalized_email) NOT BETWEEN 3 AND 254
       OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       OR char_length(normalized_name) NOT BETWEEN 2 AND 120 OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', normalized_email, normalized_name, p_actor_type, p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.identity_invitation_drafts
     WHERE identity_invitation_drafts.organization_id = v_organization_id
       AND identity_invitation_drafts.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'invitationId', existing.id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    IF EXISTS (SELECT 1 FROM public.actors WHERE actors.organization_id = v_organization_id AND lower(email) = normalized_email) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'email_already_registered');
    END IF;
    IF EXISTS (SELECT 1 FROM public.identity_invitation_drafts WHERE identity_invitation_drafts.organization_id = v_organization_id AND email = normalized_email AND status = 'draft') THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invitation_already_exists');
    END IF;
    INSERT INTO public.identity_invitation_drafts (
        id, organization_id, email, display_name, actor_type, reason, created_by_actor_id,
        idempotency_key, request_fingerprint, created_at, updated_at
    ) VALUES (invitation_id, v_organization_id, normalized_email, normalized_name, p_actor_type, p_reason,
        p_actor_id, p_idempotency_key, fingerprint, p_now, p_now);
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'Identity.InvitationDrafted', 1,
        'identity_invitation', invitation_id, p_correlation_id, p_actor_id, 'ops-access',
        jsonb_build_object('email', normalized_email, 'display_name', normalized_name, 'actor_type', p_actor_type,
            'delivery', 'not_sent'), p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'invitationId', invitation_id, 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_cancel_identity_invitation_draft(
    p_actor_id uuid, p_invitation_id uuid, p_reason text, p_idempotency_key text,
    p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    invitation public.identity_invitation_drafts%ROWTYPE;
    event_id uuid := gen_random_uuid();
    existing_event public.workflow_events%ROWTYPE;
BEGIN
    IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE workflow_events.organization_id = v_organization_id AND workflow_events.idempotency_key = p_idempotency_key || ':event';
    IF FOUND THEN
        IF existing_event.aggregate_id = p_invitation_id AND existing_event.event_type = 'Identity.InvitationCancelled' THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'invitationId', p_invitation_id, 'eventId', existing_event.id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    SELECT * INTO invitation FROM public.identity_invitation_drafts
     WHERE id = p_invitation_id AND identity_invitation_drafts.organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF invitation.status <> 'draft' THEN RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invitation_not_cancellable'); END IF;
    UPDATE public.identity_invitation_drafts SET status = 'cancelled', cancelled_by_actor_id = p_actor_id,
        cancelled_at = p_now, updated_at = p_now WHERE id = p_invitation_id;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event', 'Identity.InvitationCancelled', 1,
        'identity_invitation', p_invitation_id, p_correlation_id, p_actor_id, 'ops-access',
        jsonb_build_object('reason', p_reason), p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'invitationId', p_invitation_id, 'eventId', event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_change_actor_access(
    p_actor_id uuid, p_target_actor_id uuid, p_action text, p_actor_type text,
    p_reason text, p_idempotency_key text, p_correlation_id uuid, p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_admin(p_actor_id);
    target public.actors%ROWTYPE;
    previous_type text;
    previous_status text;
    resulting_type text;
    resulting_status text;
    fingerprint text;
    existing public.actor_access_changes%ROWTYPE;
    change_id uuid := gen_random_uuid();
    event_id uuid := gen_random_uuid();
BEGIN
    IF p_action NOT IN ('change_role', 'deactivate', 'reactivate') OR char_length(p_reason) NOT BETWEEN 12 AND 1000
       OR (p_action = 'change_role' AND p_actor_type NOT IN ('staff', 'manager', 'admin')) THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'invalid_request');
    END IF;
    fingerprint := encode(digest(concat_ws('|', p_target_actor_id::text, p_action, coalesce(p_actor_type, ''), p_reason), 'sha256'), 'hex');
    SELECT * INTO existing FROM public.actor_access_changes
     WHERE actor_access_changes.organization_id = v_organization_id AND actor_access_changes.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing.request_fingerprint = fingerprint THEN
            RETURN jsonb_build_object('outcome', 'duplicate', 'changeId', existing.id, 'eventId', existing.event_id);
        END IF;
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused');
    END IF;
    PERFORM 1 FROM public.organizations WHERE id = v_organization_id FOR UPDATE;
    SELECT * INTO target FROM public.actors
     WHERE id = p_target_actor_id AND actors.organization_id = v_organization_id FOR UPDATE;
    IF NOT FOUND OR target.actor_type NOT IN ('staff', 'manager', 'admin') THEN
        RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
    previous_type := target.actor_type;
    previous_status := target.status;
    resulting_type := CASE WHEN p_action = 'change_role' THEN p_actor_type ELSE target.actor_type END;
    resulting_status := CASE WHEN p_action = 'deactivate' THEN 'inactive' WHEN p_action = 'reactivate' THEN 'active' ELSE target.status END;
    IF previous_type = resulting_type AND previous_status = resulting_status THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'access_unchanged');
    END IF;
    IF target.actor_type = 'admin' AND target.status = 'active'
       AND NOT (resulting_type = 'admin' AND resulting_status = 'active')
       AND (SELECT count(*) FROM public.actors WHERE actors.organization_id = v_organization_id AND actor_type = 'admin' AND status = 'active') <= 1 THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'last_admin_required');
    END IF;
    UPDATE public.actors SET actor_type = resulting_type, status = resulting_status, updated_at = p_now
     WHERE id = p_target_actor_id;
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version, aggregate_type,
        aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (event_id, v_organization_id, p_idempotency_key || ':event',
        CASE p_action WHEN 'change_role' THEN 'Actor.RoleChanged' WHEN 'deactivate' THEN 'Actor.Deactivated' ELSE 'Actor.Reactivated' END,
        1, 'actor', p_target_actor_id, p_correlation_id, p_actor_id, 'ops-access',
        jsonb_build_object('previous_actor_type', previous_type, 'resulting_actor_type', resulting_type,
            'previous_status', previous_status, 'resulting_status', resulting_status, 'reason', p_reason), p_now);
    INSERT INTO public.actor_access_changes (
        id, organization_id, target_actor_id, changed_by_actor_id, action, previous_actor_type,
        resulting_actor_type, previous_status, resulting_status, reason, idempotency_key,
        request_fingerprint, event_id, changed_at
    ) VALUES (change_id, v_organization_id, p_target_actor_id, p_actor_id, p_action, previous_type,
        resulting_type, previous_status, resulting_status, p_reason, p_idempotency_key,
        fingerprint, event_id, p_now);
    RETURN jsonb_build_object('outcome', 'completed', 'changeId', change_id, 'eventId', event_id,
        'actorId', p_target_actor_id, 'actorType', resulting_type, 'status', resulting_status);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_require_active_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_identity_invitation_draft(uuid,text,text,text,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_cancel_identity_invitation_draft(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_change_actor_access(uuid,uuid,text,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_identity_invitation_draft(uuid,text,text,text,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_cancel_identity_invitation_draft(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_change_actor_access(uuid,uuid,text,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
