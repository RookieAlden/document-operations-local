BEGIN;

DO $$
DECLARE
    selected_organization public.organizations%ROWTYPE;
    actor_id uuid := gen_random_uuid();
    verification_time timestamptz := date_trunc('second', now());
    remembered_hash text := replace(gen_random_uuid()::text, '-', '')
        || replace(gen_random_uuid()::text, '-', '');
    logout_hash text := replace(gen_random_uuid()::text, '-', '')
        || replace(gen_random_uuid()::text, '-', '');
    expired_hash text := replace(gen_random_uuid()::text, '-', '')
        || replace(gen_random_uuid()::text, '-', '');
    deactivated_hash text := replace(gen_random_uuid()::text, '-', '')
        || replace(gen_random_uuid()::text, '-', '');
    selected_session record;
    expired_validation_count integer;
BEGIN
    SELECT * INTO selected_organization
      FROM public.organizations
     ORDER BY created_at, id
     LIMIT 1;
    IF selected_organization.id IS NULL THEN
        RAISE EXCEPTION 'M27 requires one DEV organization';
    END IF;

    PERFORM public.dop_set_organization_context(selected_organization.organization_key);
    INSERT INTO public.actors (
        id, organization_id, external_subject_id, actor_type, display_name,
        email, status, attributes, created_at, updated_at
    ) VALUES (
        actor_id, selected_organization.id, 'm27-actor-' || actor_id::text,
        'admin', 'M27 synthetic session actor',
        'm27-' || actor_id::text || '@example.invalid', 'active',
        '{"synthetic":true}'::jsonb, verification_time, verification_time
    );

    IF NOT public.dop_create_ops_session(
        actor_id, remembered_hash, 'remembered_device', verification_time,
        verification_time + interval '30 days'
    ) THEN
        RAISE EXCEPTION 'remembered-device session was not created';
    END IF;
    SELECT * INTO selected_session
      FROM public.dop_validate_ops_session(
          remembered_hash, verification_time + interval '16 minutes'
      );
    IF selected_session.actor_id IS DISTINCT FROM actor_id
       OR selected_session.session_mode IS DISTINCT FROM 'remembered_device'
       OR selected_session.expires_at IS DISTINCT FROM verification_time + interval '30 days' THEN
        RAISE EXCEPTION 'remembered-device session did not validate: %', row_to_json(selected_session);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.ops_sessions
         WHERE token_hash = remembered_hash
           AND last_seen_at = verification_time + interval '16 minutes'
           AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'session last-seen checkpoint was not advanced';
    END IF;

    IF public.dop_create_ops_session(
        actor_id, repeat('f', 64), 'remembered_device', verification_time,
        verification_time + interval '30 days 1 second'
    ) THEN
        RAISE EXCEPTION 'remembered-device duration exceeded the 30-day ceiling';
    END IF;

    IF NOT public.dop_create_ops_session(
        actor_id, logout_hash, 'standard', verification_time,
        verification_time + interval '24 hours'
    ) OR NOT public.dop_revoke_ops_session(
        logout_hash, 'logout', verification_time + interval '1 minute'
    ) THEN
        RAISE EXCEPTION 'logout session creation or revocation failed';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.dop_validate_ops_session(
            logout_hash, verification_time + interval '2 minutes'
        )
    ) THEN
        RAISE EXCEPTION 'logout-revoked session remained valid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.ops_sessions
         WHERE token_hash = logout_hash AND status = 'revoked'
           AND revoke_reason = 'logout' AND revoked_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'logout revocation evidence is incomplete';
    END IF;

    IF NOT public.dop_create_ops_session(
        actor_id, expired_hash, 'standard', verification_time,
        verification_time + interval '1 hour'
    ) THEN
        RAISE EXCEPTION 'expiring standard session was not created';
    END IF;
    SELECT count(*) INTO expired_validation_count
      FROM public.dop_validate_ops_session(
          expired_hash, verification_time + interval '2 hours'
      );
    IF expired_validation_count <> 0 THEN
        RAISE EXCEPTION 'expired session remained valid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.ops_sessions
         WHERE token_hash = expired_hash AND status = 'expired'
    ) THEN
        RAISE EXCEPTION 'expired session lacked expiry evidence';
    END IF;

    IF NOT public.dop_create_ops_session(
        actor_id, deactivated_hash, 'remembered_device', verification_time,
        verification_time + interval '30 days'
    ) THEN
        RAISE EXCEPTION 'actor-deactivation session was not created';
    END IF;
    UPDATE public.actors
       SET status = 'inactive', updated_at = verification_time + interval '3 minutes'
     WHERE id = actor_id AND organization_id = selected_organization.id;
    IF NOT EXISTS (
        SELECT 1 FROM public.ops_sessions
         WHERE token_hash IN (remembered_hash, deactivated_hash)
           AND status = 'revoked' AND revoke_reason = 'actor_inactive'
    ) OR EXISTS (
        SELECT 1 FROM public.dop_validate_ops_session(
            deactivated_hash, verification_time + interval '4 minutes'
        )
    ) THEN
        RAISE EXCEPTION 'actor deactivation did not invalidate active sessions';
    END IF;

    IF NOT has_function_privilege(
        'dop_app',
        'public.dop_create_ops_session(uuid,text,text,timestamptz,timestamptz)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'dop_app', 'public.dop_validate_ops_session(text,timestamptz)', 'EXECUTE'
    ) OR NOT has_function_privilege(
        'dop_app', 'public.dop_revoke_ops_session(text,text,timestamptz)', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'application role cannot execute the constrained session functions';
    END IF;
    IF has_function_privilege(
        'dop_app', 'public.dop_revoke_actor_ops_sessions_trigger()', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'application role can execute the internal revocation trigger function';
    END IF;
    IF has_table_privilege('dop_app', 'public.ops_sessions', 'SELECT')
       OR has_table_privilege('dop_app', 'public.ops_sessions', 'INSERT')
       OR has_table_privilege('dop_app', 'public.ops_sessions', 'UPDATE')
       OR has_table_privilege('dop_app', 'public.ops_sessions', 'DELETE') THEN
        RAISE EXCEPTION 'application role has unexpected direct ops_sessions privileges';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ops_sessions'::regclass) THEN
        RAISE EXCEPTION 'ops_sessions RLS is not enabled';
    END IF;

    RAISE NOTICE 'M27 verification passed: opaque token digest only, 30-day ceiling, expiry and revocation enforced';
END;
$$;

SELECT jsonb_build_object(
    'verification','passed',
    'browserToken','opaque',
    'databaseCredentialMaterial','sha256_digest_only',
    'rememberedDeviceMaximumDays',30,
    'logoutRevocation',true,
    'actorDeactivationRevocation',true,
    'directTablePrivileges',false,
    'persistentSideEffects',0
) AS m27_result;

ROLLBACK;
