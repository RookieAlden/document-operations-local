BEGIN;

-- Supabase installs pgcrypto in the protected extensions schema. The M13
-- functions have a fixed search path, so add that schema explicitly rather
-- than relying on the dashboard session's ambient search_path.
ALTER FUNCTION public.dop_create_identity_invitation_draft(uuid,text,text,text,text,text,uuid,timestamptz)
    SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.dop_change_actor_access(uuid,uuid,text,text,text,text,uuid,timestamptz)
    SET search_path = public, extensions, pg_temp;

COMMIT;
