BEGIN;

DO $$
DECLARE
    selected_organization public.organizations%ROWTYPE;
    admin_actor_id uuid := gen_random_uuid();
    staff_actor_id uuid := gen_random_uuid();
    verification_time timestamptz := date_trunc('second', now());
    admin_current_hash text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
    admin_other_hash text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
    staff_current_hash text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
    staff_other_hash text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
    old_hash text := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
    admin_other_id uuid;
    staff_other_id uuid;
    staff_visible integer;
    admin_visible integer;
    current_markers integer;
    result record;
    notifications_before integer;
    notifications_after integer;
BEGIN
    SELECT * INTO selected_organization FROM public.organizations ORDER BY created_at,id LIMIT 1;
    IF selected_organization.id IS NULL THEN RAISE EXCEPTION 'M29 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(selected_organization.organization_key);
    SELECT count(*) INTO notifications_before FROM public.notifications
     WHERE organization_id = selected_organization.id;

    INSERT INTO public.actors (
        id,organization_id,external_subject_id,actor_type,display_name,email,status,
        attributes,created_at,updated_at
    ) VALUES
      (admin_actor_id,selected_organization.id,'m29-admin-'||admin_actor_id,'admin',
       'M29 synthetic admin','m29-admin-'||admin_actor_id||'@example.invalid','active',
       '{"synthetic":true}'::jsonb,verification_time,verification_time),
      (staff_actor_id,selected_organization.id,'m29-staff-'||staff_actor_id,'staff',
       'M29 synthetic staff','m29-staff-'||staff_actor_id||'@example.invalid','active',
       '{"synthetic":true}'::jsonb,verification_time,verification_time);

    IF NOT public.dop_create_ops_session(admin_actor_id,admin_current_hash,'remembered_device',
        verification_time,verification_time+interval '30 days')
       OR NOT public.dop_create_ops_session(admin_actor_id,admin_other_hash,'standard',
        verification_time,verification_time+interval '8 hours')
       OR NOT public.dop_create_ops_session(staff_actor_id,staff_current_hash,'remembered_device',
        verification_time,verification_time+interval '30 days')
       OR NOT public.dop_create_ops_session(staff_actor_id,staff_other_hash,'standard',
        verification_time,verification_time+interval '8 hours') THEN
        RAISE EXCEPTION 'M29 active fixtures were not created';
    END IF;
    SELECT id INTO admin_other_id FROM public.ops_sessions WHERE token_hash = admin_other_hash;
    SELECT id INTO staff_other_id FROM public.ops_sessions WHERE token_hash = staff_other_hash;

    IF NOT public.dop_create_ops_session(admin_actor_id,old_hash,'standard',
        verification_time-interval '200 days',verification_time-interval '199 days 23 hours')
       OR NOT public.dop_revoke_ops_session(old_hash,'logout',verification_time-interval '190 days') THEN
        RAISE EXCEPTION 'M29 old ended fixture was not created';
    END IF;

    SELECT count(*),count(*) FILTER (WHERE is_current)
      INTO staff_visible,current_markers
      FROM public.dop_list_ops_sessions(staff_actor_id,staff_current_hash,verification_time);
    IF staff_visible <> 2 OR current_markers <> 1 THEN
        RAISE EXCEPTION 'staff session scope leaked or current marker failed: visible %, current %', staff_visible,current_markers;
    END IF;
    SELECT count(*),count(*) FILTER (WHERE is_current)
      INTO admin_visible,current_markers
      FROM public.dop_list_ops_sessions(admin_actor_id,admin_current_hash,verification_time)
     WHERE actor_id IN (admin_actor_id,staff_actor_id);
    IF admin_visible <> 4 OR current_markers <> 1 THEN
        RAISE EXCEPTION 'admin organization scope or current marker failed: visible %, current %', admin_visible,current_markers;
    END IF;

    SELECT * INTO result FROM public.dop_revoke_ops_session_by_id(
        staff_actor_id,admin_other_id,staff_current_hash,
        'Staff must not revoke an administrator session.',
        'm29-denied-'||gen_random_uuid(),gen_random_uuid(),verification_time
    );
    IF result.outcome <> 'session_not_found' OR result.revoked THEN
        RAISE EXCEPTION 'staff could revoke another actor session: %',row_to_json(result);
    END IF;
    SELECT * INTO result FROM public.dop_revoke_ops_session_by_id(
        staff_actor_id,staff_other_id,staff_current_hash,
        'Staff revokes an unused personal device session.',
        'm29-staff-revoke-'||gen_random_uuid(),gen_random_uuid(),verification_time
    );
    IF result.outcome <> 'completed' OR NOT result.revoked OR result.current_session THEN
        RAISE EXCEPTION 'staff own-device revocation failed: %',row_to_json(result);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dop_validate_ops_session(staff_current_hash,verification_time)) THEN
        RAISE EXCEPTION 'staff current session was lost while revoking another device';
    END IF;

    SELECT * INTO result FROM public.dop_revoke_other_ops_sessions(
        admin_actor_id,admin_current_hash,'Administrator revokes every other personal device session.',
        'm29-revoke-others-'||gen_random_uuid(),gen_random_uuid(),verification_time
    );
    IF result.outcome <> 'completed' OR result.revoked_count <> 1 THEN
        RAISE EXCEPTION 'revoke-other-devices did not preserve exact scope: %',row_to_json(result);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.dop_validate_ops_session(admin_current_hash,verification_time)) THEN
        RAISE EXCEPTION 'administrator current session was lost';
    END IF;

    SELECT * INTO result FROM public.dop_cleanup_ops_sessions(
        admin_actor_id,90,false,'dry run only','m29-cleanup-preview-'||gen_random_uuid(),
        gen_random_uuid(),verification_time
    );
    IF result.outcome <> 'dry_run' OR result.candidate_count <> 1 OR result.deleted_count <> 0
       OR NOT EXISTS (SELECT 1 FROM public.ops_sessions WHERE token_hash = old_hash) THEN
        RAISE EXCEPTION 'cleanup preview was not side-effect free: %',row_to_json(result);
    END IF;
    SELECT * INTO result FROM public.dop_cleanup_ops_sessions(
        admin_actor_id,90,true,'Delete only ended session records beyond the approved retention window.',
        'm29-cleanup-apply-'||gen_random_uuid(),gen_random_uuid(),verification_time
    );
    IF result.outcome <> 'completed' OR result.candidate_count <> 1 OR result.deleted_count <> 1
       OR EXISTS (SELECT 1 FROM public.ops_sessions WHERE token_hash = old_hash) THEN
        RAISE EXCEPTION 'cleanup apply did not delete exactly the eligible row: %',row_to_json(result);
    END IF;
    IF (SELECT count(*) FROM public.ops_sessions WHERE organization_id=selected_organization.id
        AND status='active' AND actor_id IN (admin_actor_id,staff_actor_id)) <> 2 THEN
        RAISE EXCEPTION 'cleanup touched an active current session';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=selected_organization.id
        AND event_type='OpsSession.RetentionCleanup' AND (payload->>'activeSessionsDeleted')::integer=0
        AND (payload->>'tokenMaterialExposed')::boolean=false) THEN
        RAISE EXCEPTION 'cleanup audit evidence is incomplete';
    END IF;

    SELECT count(*) INTO notifications_after FROM public.notifications
     WHERE organization_id = selected_organization.id;
    IF notifications_after <> notifications_before THEN
        RAISE EXCEPTION 'M29 created an external notification';
    END IF;
    IF has_table_privilege('dop_app','public.ops_sessions','SELECT')
       OR has_table_privilege('dop_app','public.ops_sessions','INSERT')
       OR has_table_privilege('dop_app','public.ops_sessions','UPDATE')
       OR has_table_privilege('dop_app','public.ops_sessions','DELETE') THEN
        RAISE EXCEPTION 'dop_app gained direct ops_sessions table privileges';
    END IF;
    IF NOT has_function_privilege('dop_app','public.dop_list_ops_sessions(uuid,text,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_revoke_ops_session_by_id(uuid,uuid,text,text,text,uuid,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_revoke_other_ops_sessions(uuid,text,text,text,uuid,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_cleanup_ops_sessions(uuid,integer,boolean,text,text,uuid,timestamptz)','EXECUTE') THEN
        RAISE EXCEPTION 'dop_app cannot execute constrained M29 functions';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.ops_sessions'::regclass) THEN
        RAISE EXCEPTION 'ops_sessions RLS is disabled';
    END IF;

    RAISE NOTICE 'M29 verification passed: scoped list, self/admin revoke, current preservation and retention cleanup enforced';
END;
$$;

SELECT jsonb_build_object(
    'verification','passed','tokenMaterialExposed',false,'currentSessionPreserved',true,
    'crossActorDenied',true,'cleanupDryRunSideEffects',0,'activeSessionsDeleted',0,
    'notificationsCreated',0,'externalCalls',0,'persistentSideEffects',0
) AS m29_result;

ROLLBACK;
