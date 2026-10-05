BEGIN;

-- M27 stores only a SHA-256 digest of the browser's opaque session token.
-- The raw token remains in the signed HttpOnly cookie and never enters the
-- database, Workflow Events or application logs.
CREATE TABLE public.ops_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    session_mode text NOT NULL CHECK (session_mode IN ('standard','remembered_device')),
    status text NOT NULL CHECK (status IN ('active','revoked','expired')),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoke_reason text CHECK (revoke_reason IN ('logout','actor_inactive')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (token_hash),
    CONSTRAINT ops_session_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    CHECK (expires_at > issued_at),
    CHECK ((status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
        OR (status = 'expired' AND revoked_at IS NULL AND revoke_reason IS NULL))
);

CREATE INDEX ops_sessions_active_actor_idx
    ON public.ops_sessions (organization_id, actor_id, expires_at)
    WHERE status = 'active';
CREATE INDEX ops_sessions_expiry_idx
    ON public.ops_sessions (expires_at)
    WHERE status = 'active';

ALTER TABLE public.ops_sessions ENABLE ROW LEVEL SECURITY;
-- No direct table privileges are granted to dop_app. All access is constrained
-- by the security-definer functions below and the transaction organization context.

CREATE OR REPLACE FUNCTION public.dop_create_ops_session(
    p_actor_id uuid,
    p_token_hash text,
    p_session_mode text,
    p_issued_at timestamptz,
    p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    org_id uuid := public.dop_current_organization_id();
    maximum_duration interval;
BEGIN
    IF org_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF p_token_hash !~ '^[0-9a-f]{64}$' OR p_session_mode NOT IN ('standard','remembered_device') THEN
        RETURN false;
    END IF;
    maximum_duration := CASE WHEN p_session_mode = 'remembered_device'
        THEN interval '30 days' ELSE interval '24 hours' END;
    IF p_expires_at <= p_issued_at OR p_expires_at > p_issued_at + maximum_duration THEN
        RETURN false;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE organization_id = org_id AND id = p_actor_id
           AND actor_type IN ('staff','manager','admin') AND status = 'active'
    ) THEN
        RETURN false;
    END IF;
    INSERT INTO public.ops_sessions (
        organization_id, actor_id, token_hash, session_mode, status,
        issued_at, expires_at, last_seen_at, created_at, updated_at
    ) VALUES (
        org_id, p_actor_id, p_token_hash, p_session_mode, 'active',
        p_issued_at, p_expires_at, p_issued_at, p_issued_at, p_issued_at
    );
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_validate_ops_session(
    p_token_hash text,
    p_now timestamptz
) RETURNS TABLE(actor_id uuid, expires_at timestamptz, session_mode text)
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
    SELECT s.actor_id, s.expires_at, s.session_mode
      FROM public.ops_sessions s
     WHERE s.organization_id = org_id AND s.token_hash = p_token_hash
       AND s.status = 'active' AND s.expires_at > p_now;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_revoke_ops_session(
    p_token_hash text,
    p_reason text,
    p_now timestamptz
) RETURNS boolean
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
    IF p_reason NOT IN ('logout','actor_inactive') THEN RETURN false; END IF;
    UPDATE public.ops_sessions
       SET status = 'revoked', revoked_at = p_now, revoke_reason = p_reason, updated_at = p_now
     WHERE organization_id = org_id AND token_hash = p_token_hash AND status = 'active';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_revoke_actor_ops_sessions_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status = 'inactive' THEN
        UPDATE public.ops_sessions
           SET status = 'revoked', revoked_at = now(), revoke_reason = 'actor_inactive', updated_at = now()
         WHERE organization_id = NEW.organization_id AND actor_id = NEW.id AND status = 'active';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER actor_deactivation_revokes_ops_sessions
AFTER UPDATE OF status ON public.actors
FOR EACH ROW EXECUTE FUNCTION public.dop_revoke_actor_ops_sessions_trigger();

REVOKE ALL ON FUNCTION public.dop_create_ops_session(uuid,text,text,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_validate_ops_session(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_ops_session(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_actor_ops_sessions_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_ops_session(uuid,text,text,timestamptz,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_validate_ops_session(text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_revoke_ops_session(text,text,timestamptz) TO dop_app;

COMMIT;
