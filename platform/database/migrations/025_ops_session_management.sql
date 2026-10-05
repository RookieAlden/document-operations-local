BEGIN;

-- M29 extends the opaque-token session store with constrained lifecycle
-- management. Raw tokens and token digests are never returned to callers.
ALTER TABLE public.ops_sessions
    DROP CONSTRAINT IF EXISTS ops_sessions_revoke_reason_check;
ALTER TABLE public.ops_sessions
    ADD CONSTRAINT ops_sessions_revoke_reason_check
    CHECK (revoke_reason IN (
        'logout','actor_inactive','user_revoked','admin_revoked','other_devices_revoked'
    ));

DROP FUNCTION public.dop_validate_ops_session(text,timestamptz);
CREATE FUNCTION public.dop_validate_ops_session(
    p_token_hash text,
    p_now timestamptz
) RETURNS TABLE(
    session_id uuid,
    actor_id uuid,
    expires_at timestamptz,
    session_mode text,
    issued_at timestamptz,
    last_seen_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    UPDATE public.ops_sessions AS s
       SET status = 'expired', updated_at = p_now
     WHERE s.organization_id = org_id AND s.token_hash = p_token_hash
       AND s.status = 'active' AND s.expires_at <= p_now;
    UPDATE public.ops_sessions AS s
       SET last_seen_at = p_now, updated_at = p_now
     WHERE s.organization_id = org_id AND s.token_hash = p_token_hash
       AND s.status = 'active' AND s.expires_at > p_now
       AND s.last_seen_at <= p_now - interval '15 minutes';
    RETURN QUERY
    SELECT s.id, s.actor_id, s.expires_at, s.session_mode, s.issued_at, s.last_seen_at
      FROM public.ops_sessions s
     WHERE s.organization_id = org_id AND s.token_hash = p_token_hash
       AND s.status = 'active' AND s.expires_at > p_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_list_ops_sessions(
    p_request_actor_id uuid,
    p_current_token_hash text,
    p_now timestamptz
) RETURNS TABLE(
    session_id uuid,
    actor_id uuid,
    actor_display_name text,
    actor_type text,
    session_mode text,
    session_status text,
    issued_at timestamptz,
    expires_at timestamptz,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text,
    is_current boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
    requester public.actors%ROWTYPE;
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF p_current_token_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid_session_token_hash' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO requester FROM public.actors AS request_actor
     WHERE request_actor.organization_id = org_id AND request_actor.id = p_request_actor_id
       AND request_actor.actor_type IN ('staff','manager','admin') AND request_actor.status = 'active';
    IF requester.id IS NULL THEN
        RAISE EXCEPTION 'active_actor_required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.ops_sessions AS expiring_session
       SET status = 'expired', updated_at = p_now
     WHERE expiring_session.organization_id = org_id
       AND expiring_session.status = 'active' AND expiring_session.expires_at <= p_now;

    RETURN QUERY
    SELECT s.id, s.actor_id, a.display_name, a.actor_type, s.session_mode,
           s.status, s.issued_at, s.expires_at, s.last_seen_at,
           s.revoked_at, s.revoke_reason, s.token_hash = p_current_token_hash
      FROM public.ops_sessions s
      JOIN public.actors a
        ON a.organization_id = s.organization_id AND a.id = s.actor_id
     WHERE s.organization_id = org_id
       AND (requester.actor_type = 'admin' OR s.actor_id = requester.id)
       AND (s.status = 'active' OR s.updated_at >= p_now - interval '90 days')
     ORDER BY (s.token_hash = p_current_token_hash) DESC,
              (s.status = 'active') DESC, s.last_seen_at DESC, s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_revoke_ops_session_by_id(
    p_request_actor_id uuid,
    p_session_id uuid,
    p_current_token_hash text,
    p_reason text,
    p_idempotency_key text,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS TABLE(outcome text, revoked boolean, current_session boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
    requester public.actors%ROWTYPE;
    target public.ops_sessions%ROWTYPE;
    existing_event public.workflow_events%ROWTYPE;
    is_current boolean;
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF p_current_token_hash !~ '^[0-9a-f]{64}$'
       OR length(trim(p_reason)) NOT BETWEEN 12 AND 1000
       OR p_idempotency_key = '' THEN
        RETURN QUERY SELECT 'invalid_request'::text, false, false;
        RETURN;
    END IF;
    SELECT * INTO requester FROM public.actors
     WHERE organization_id = org_id AND id = p_request_actor_id
       AND actor_type IN ('staff','manager','admin') AND status = 'active';
    IF requester.id IS NULL THEN
        RAISE EXCEPTION 'active_actor_required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF existing_event.id IS NOT NULL THEN
        IF existing_event.event_type <> 'OpsSession.Revoked'
           OR existing_event.aggregate_id <> p_session_id THEN
            RETURN QUERY SELECT 'idempotency_key_reused'::text, false, false;
        ELSE
            RETURN QUERY SELECT 'duplicate'::text, true,
                COALESCE((existing_event.payload->>'currentSession')::boolean, false);
        END IF;
        RETURN;
    END IF;

    SELECT * INTO target FROM public.ops_sessions
     WHERE organization_id = org_id AND id = p_session_id FOR UPDATE;
    IF target.id IS NULL THEN
        RETURN QUERY SELECT 'session_not_found'::text, false, false;
        RETURN;
    END IF;
    IF target.actor_id <> requester.id AND requester.actor_type <> 'admin' THEN
        RETURN QUERY SELECT 'session_not_found'::text, false, false;
        RETURN;
    END IF;
    IF target.status <> 'active' OR target.expires_at <= p_now THEN
        IF target.status = 'active' THEN
            UPDATE public.ops_sessions SET status = 'expired', updated_at = p_now
             WHERE organization_id = org_id AND id = target.id;
        END IF;
        RETURN QUERY SELECT 'session_not_active'::text, false, false;
        RETURN;
    END IF;
    is_current := target.token_hash = p_current_token_hash;
    UPDATE public.ops_sessions
       SET status = 'revoked', revoked_at = p_now,
           revoke_reason = CASE WHEN requester.id = target.actor_id
               THEN 'user_revoked' ELSE 'admin_revoked' END,
           updated_at = p_now
     WHERE organization_id = org_id AND id = target.id;
    INSERT INTO public.workflow_events (
        organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at,recorded_at
    ) VALUES (
        org_id,p_idempotency_key,'OpsSession.Revoked',1,'ops_session',target.id,
        p_correlation_id,requester.id,'ops-session-management',jsonb_build_object(
            'targetActorId',target.actor_id,'currentSession',is_current,
            'reason',trim(p_reason),'tokenMaterialExposed',false),p_now,p_now
    );
    RETURN QUERY SELECT 'completed'::text, true, is_current;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_revoke_other_ops_sessions(
    p_request_actor_id uuid,
    p_current_token_hash text,
    p_reason text,
    p_idempotency_key text,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS TABLE(outcome text, revoked_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
    existing_event public.workflow_events%ROWTYPE;
    affected integer := 0;
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF p_current_token_hash !~ '^[0-9a-f]{64}$'
       OR length(trim(p_reason)) NOT BETWEEN 12 AND 1000
       OR p_idempotency_key = '' THEN
        RETURN QUERY SELECT 'invalid_request'::text, 0;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.actors WHERE organization_id = org_id
        AND id = p_request_actor_id AND actor_type IN ('staff','manager','admin') AND status = 'active') THEN
        RAISE EXCEPTION 'active_actor_required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF existing_event.id IS NOT NULL THEN
        IF existing_event.event_type <> 'OpsSession.OtherDevicesRevoked'
           OR existing_event.aggregate_id <> p_request_actor_id THEN
            RETURN QUERY SELECT 'idempotency_key_reused'::text, 0;
        ELSE
            RETURN QUERY SELECT 'duplicate'::text,
                COALESCE((existing_event.payload->>'revokedCount')::integer, 0);
        END IF;
        RETURN;
    END IF;
    UPDATE public.ops_sessions SET status = 'expired', updated_at = p_now
     WHERE organization_id = org_id AND actor_id = p_request_actor_id
       AND status = 'active' AND expires_at <= p_now;
    UPDATE public.ops_sessions
       SET status = 'revoked', revoked_at = p_now,
           revoke_reason = 'other_devices_revoked', updated_at = p_now
     WHERE organization_id = org_id AND actor_id = p_request_actor_id
       AND status = 'active' AND expires_at > p_now
       AND token_hash <> p_current_token_hash;
    GET DIAGNOSTICS affected = ROW_COUNT;
    INSERT INTO public.workflow_events (
        organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at,recorded_at
    ) VALUES (
        org_id,p_idempotency_key,'OpsSession.OtherDevicesRevoked',1,'actor',p_request_actor_id,
        p_correlation_id,p_request_actor_id,'ops-session-management',jsonb_build_object(
            'revokedCount',affected,'reason',trim(p_reason),'currentSessionPreserved',true,
            'tokenMaterialExposed',false),p_now,p_now
    );
    RETURN QUERY SELECT 'completed'::text, affected;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_cleanup_ops_sessions(
    p_request_actor_id uuid,
    p_retention_days integer,
    p_apply boolean,
    p_reason text,
    p_idempotency_key text,
    p_correlation_id uuid,
    p_now timestamptz
) RETURNS TABLE(outcome text, candidate_count integer, deleted_count integer, cutoff_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
    requester public.actors%ROWTYPE;
    cutoff_value timestamptz;
    candidates integer := 0;
    deleted integer := 0;
    existing_event public.workflow_events%ROWTYPE;
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO requester FROM public.actors WHERE organization_id = org_id
      AND id = p_request_actor_id AND actor_type = 'admin' AND status = 'active';
    IF requester.id IS NULL THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;
    IF p_retention_days NOT BETWEEN 30 AND 365 THEN
        RETURN QUERY SELECT 'invalid_request'::text, 0, 0, NULL::timestamptz;
        RETURN;
    END IF;
    cutoff_value := p_now - make_interval(days => p_retention_days);
    UPDATE public.ops_sessions SET status = 'expired', updated_at = p_now
     WHERE organization_id = org_id AND status = 'active' AND expires_at <= p_now;
    SELECT count(*)::integer INTO candidates FROM public.ops_sessions
     WHERE organization_id = org_id AND status IN ('expired','revoked')
       AND COALESCE(revoked_at, expires_at) < cutoff_value;
    IF NOT p_apply THEN
        RETURN QUERY SELECT 'dry_run'::text, candidates, 0, cutoff_value;
        RETURN;
    END IF;
    IF length(trim(p_reason)) NOT BETWEEN 12 AND 1000 OR p_idempotency_key = '' THEN
        RETURN QUERY SELECT 'invalid_request'::text, candidates, 0, cutoff_value;
        RETURN;
    END IF;
    SELECT * INTO existing_event FROM public.workflow_events
     WHERE organization_id = org_id AND idempotency_key = p_idempotency_key;
    IF existing_event.id IS NOT NULL THEN
        IF existing_event.event_type <> 'OpsSession.RetentionCleanup'
           OR existing_event.aggregate_id <> requester.id THEN
            RETURN QUERY SELECT 'idempotency_key_reused'::text, 0, 0, cutoff_value;
        ELSE
            RETURN QUERY SELECT 'duplicate'::text,
                COALESCE((existing_event.payload->>'candidateCount')::integer, 0),
                COALESCE((existing_event.payload->>'deletedCount')::integer, 0),
                (existing_event.payload->>'cutoffAt')::timestamptz;
        END IF;
        RETURN;
    END IF;
    DELETE FROM public.ops_sessions
     WHERE organization_id = org_id AND status IN ('expired','revoked')
       AND COALESCE(revoked_at, expires_at) < cutoff_value;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    INSERT INTO public.workflow_events (
        organization_id,idempotency_key,event_type,event_version,aggregate_type,
        aggregate_id,correlation_id,actor_id,producer,payload,occurred_at,recorded_at
    ) VALUES (
        org_id,p_idempotency_key,'OpsSession.RetentionCleanup',1,'actor',requester.id,
        p_correlation_id,requester.id,'ops-session-management',jsonb_build_object(
            'candidateCount',candidates,'deletedCount',deleted,'retentionDays',p_retention_days,
            'cutoffAt',cutoff_value,'reason',trim(p_reason),'activeSessionsDeleted',0,
            'tokenMaterialExposed',false),p_now,p_now
    );
    RETURN QUERY SELECT 'completed'::text, candidates, deleted, cutoff_value;
END;
$$;

REVOKE ALL ON FUNCTION public.dop_validate_ops_session(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_list_ops_sessions(uuid,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_ops_session_by_id(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_other_ops_sessions(uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_cleanup_ops_sessions(uuid,integer,boolean,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_validate_ops_session(text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_list_ops_sessions(uuid,text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_revoke_ops_session_by_id(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_revoke_other_ops_sessions(uuid,text,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_cleanup_ops_sessions(uuid,integer,boolean,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
