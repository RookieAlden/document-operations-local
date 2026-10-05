BEGIN;

DO $$
DECLARE
    selected_organization public.organizations%ROWTYPE;
    admin_one uuid:=gen_random_uuid();
    admin_two uuid:=gen_random_uuid();
    staff_actor uuid:=gen_random_uuid();
    verification_time timestamptz:=date_trunc('second',now());
    approved_declarations jsonb:=jsonb_build_object(
        'schemaVersion','1.0','sourceEnvironment','DEV','targetEnvironment','UAT',
        'targetProvisioning','not_started','runtimeExecution','disabled',
        'externalDelivery','disabled','externalIngress','disabled','dataBoundary','synthetic_only',
        'approvals',jsonb_build_object(
            'dataRegion',jsonb_build_object('status','approved','reference','M30-SYNTHETIC-REGION'),
            'privacyRetention',jsonb_build_object('status','approved','reference','M30-SYNTHETIC-PRIVACY'),
            'budget',jsonb_build_object('status','approved','reference','M30-SYNTHETIC-BUDGET','monthlyLimitUsd',0),
            'sharedMailbox',jsonb_build_object('status','not_required','reference',NULL)
        ),
        'secretReferences',jsonb_build_array('railway://dop-intake-dev/session-secret','supabase://document-operations-dev/database')
    );
    create_result jsonb;
    duplicate_result jsonb;
    unchanged_result jsonb;
    evaluation_result jsonb;
    submit_result jsonb;
    decision_result jsonb;
    second_result jsonb;
    drift_result jsonb;
    first_manifest_id uuid;
    second_manifest_id uuid;
    active_connector_version_id uuid;
    original_connector_hash text;
    notifications_before integer;
    notifications_after integer;
    staff_denied boolean:=false;
BEGIN
    SELECT * INTO selected_organization FROM public.organizations ORDER BY created_at,id LIMIT 1;
    IF selected_organization.id IS NULL THEN RAISE EXCEPTION 'M30 requires one DEV organization'; END IF;
    PERFORM public.dop_set_organization_context(selected_organization.organization_key);
    SELECT count(*) INTO notifications_before FROM public.notifications WHERE organization_id=selected_organization.id;
    INSERT INTO public.actors (id,organization_id,external_subject_id,actor_type,display_name,email,status,attributes,created_at,updated_at)
    VALUES
      (admin_one,selected_organization.id,'m30-admin-one-'||admin_one,'admin','M30 synthetic author',
       'm30-author-'||admin_one||'@example.invalid','active','{"synthetic":true}'::jsonb,verification_time,verification_time),
      (admin_two,selected_organization.id,'m30-admin-two-'||admin_two,'admin','M30 synthetic reviewer',
       'm30-reviewer-'||admin_two||'@example.invalid','active','{"synthetic":true}'::jsonb,verification_time,verification_time),
      (staff_actor,selected_organization.id,'m30-staff-'||staff_actor,'staff','M30 synthetic staff',
       'm30-staff-'||staff_actor||'@example.invalid','active','{"synthetic":true}'::jsonb,verification_time,verification_time);

    BEGIN
        PERFORM public.dop_create_release_manifest(staff_actor,'dev-to-uat',approved_declarations,
            'Staff must not create a release readiness manifest.','m30-staff-denied',gen_random_uuid(),verification_time);
    EXCEPTION WHEN insufficient_privilege THEN staff_denied:=true;
    END;
    IF NOT staff_denied THEN RAISE EXCEPTION 'staff created a release manifest'; END IF;

    create_result:=public.dop_create_release_manifest(admin_one,'dev-to-uat',approved_declarations,
        'Freeze the current synthetic DEV configuration for a reversible UAT readiness review.',
        'm30-create-one',gen_random_uuid(),verification_time);
    IF create_result->>'outcome'<>'completed' OR create_result->>'status'<>'draft'
       OR (create_result->>'componentCount')::integer<6 THEN
        RAISE EXCEPTION 'manifest creation failed: %',create_result;
    END IF;
    first_manifest_id:=(create_result->>'manifestId')::uuid;
    duplicate_result:=public.dop_create_release_manifest(admin_one,'dev-to-uat',approved_declarations,
        'Freeze the current synthetic DEV configuration for a reversible UAT readiness review.',
        'm30-create-one',gen_random_uuid(),verification_time);
    IF duplicate_result->>'outcome'<>'duplicate' OR (duplicate_result->>'manifestId')::uuid<>first_manifest_id THEN
        RAISE EXCEPTION 'manifest idempotency failed: %',duplicate_result;
    END IF;
    unchanged_result:=public.dop_create_release_manifest(admin_one,'dev-to-uat',approved_declarations,
        'A new request key must not create an unchanged duplicate release manifest.',
        'm30-create-unchanged',gen_random_uuid(),verification_time);
    IF unchanged_result->>'reason'<>'release_manifest_unchanged' THEN
        RAISE EXCEPTION 'unchanged manifest was not rejected: %',unchanged_result;
    END IF;
    evaluation_result:=public.dop_evaluate_release_manifest(admin_one,first_manifest_id,
        'Evaluate frozen components, approvals and disabled external capability boundaries.',
        'm30-evaluate-one',gen_random_uuid(),verification_time);
    IF evaluation_result->>'outcome'<>'completed' OR evaluation_result->>'status'<>'passed'
       OR (evaluation_result->>'blockerCount')::integer<>0 OR (evaluation_result->>'driftDetected')::boolean THEN
        RAISE EXCEPTION 'passing readiness evaluation failed: %',evaluation_result;
    END IF;
    submit_result:=public.dop_submit_release_manifest(admin_one,first_manifest_id,
        'Submit the exact passing manifest for an independent governance decision.',
        'm30-submit-one',gen_random_uuid(),verification_time);
    IF submit_result->>'outcome'<>'completed' OR submit_result->>'status'<>'in_review' THEN
        RAISE EXCEPTION 'manifest submission failed: %',submit_result;
    END IF;
    decision_result:=public.dop_decide_release_manifest(admin_one,first_manifest_id,'approve',
        'The manifest author must not approve their own release readiness evidence.',
        'm30-self-approve',gen_random_uuid(),verification_time);
    IF decision_result->>'reason'<>'independent_reviewer_required' THEN
        RAISE EXCEPTION 'self approval was not denied: %',decision_result;
    END IF;
    decision_result:=public.dop_decide_release_manifest(admin_two,first_manifest_id,'approve',
        'Independently approve the synthetic release readiness evidence without provisioning UAT.',
        'm30-approve-one',gen_random_uuid(),verification_time);
    IF decision_result->>'outcome'<>'completed' OR decision_result->>'status'<>'approved' THEN
        RAISE EXCEPTION 'independent approval failed: %',decision_result;
    END IF;

    second_result:=public.dop_create_release_manifest(admin_one,'dev-to-uat',
        jsonb_set(approved_declarations,'{approvals,budget,reference}','"M30-SYNTHETIC-BUDGET-V2"'::jsonb),
        'Create a second frozen manifest to prove rollback pointers and drift failure behavior.',
        'm30-create-two',gen_random_uuid(),verification_time+interval '1 second');
    IF second_result->>'outcome'<>'completed'
       OR (second_result->>'rollbackManifestId')::uuid<>first_manifest_id THEN
        RAISE EXCEPTION 'rollback pointer was not fixed: %',second_result;
    END IF;
    second_manifest_id:=(second_result->>'manifestId')::uuid;
    SELECT version.id,version.definition_hash INTO active_connector_version_id,original_connector_hash
      FROM public.source_connectors connector JOIN public.source_connector_versions version ON version.id=connector.active_version_id
     WHERE connector.organization_id=selected_organization.id AND connector.lifecycle_status='active'
     ORDER BY connector.connector_key LIMIT 1;
    IF active_connector_version_id IS NULL THEN RAISE EXCEPTION 'M30 requires one active connector'; END IF;
    UPDATE public.source_connector_versions SET definition_hash=repeat('0',64) WHERE id=active_connector_version_id;
    drift_result:=public.dop_evaluate_release_manifest(admin_two,second_manifest_id,
        'Detect a synthetic cross-module definition hash drift before any promotion decision.',
        'm30-evaluate-drift',gen_random_uuid(),verification_time+interval '2 seconds');
    IF drift_result->>'outcome'<>'completed' OR drift_result->>'status'<>'blocked'
       OR NOT (drift_result->>'driftDetected')::boolean OR (drift_result->>'blockerCount')::integer<1 THEN
        RAISE EXCEPTION 'drift was not blocked: %',drift_result;
    END IF;
    UPDATE public.source_connector_versions SET definition_hash=original_connector_hash WHERE id=active_connector_version_id;

    IF EXISTS (SELECT 1 FROM public.release_manifests WHERE organization_id=selected_organization.id
        AND (source_environment<>'DEV' OR target_environment<>'UAT'
             OR readiness_declarations->>'targetProvisioning'<>'not_started'
             OR readiness_declarations->>'runtimeExecution'<>'disabled'
             OR readiness_declarations->>'externalDelivery'<>'disabled')) THEN
        RAISE EXCEPTION 'release manifest escaped the M30 safety boundary';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.workflow_events WHERE organization_id=selected_organization.id
        AND event_type='ReleaseManifest.Approved' AND (payload->>'targetEnvironmentCreated')::boolean=false
        AND (payload->>'externalCalls')::integer=0) THEN
        RAISE EXCEPTION 'approval event omitted zero-side-effect evidence';
    END IF;
    SELECT count(*) INTO notifications_after FROM public.notifications WHERE organization_id=selected_organization.id;
    IF notifications_after<>notifications_before THEN RAISE EXCEPTION 'M30 created a Notification'; END IF;
    IF has_table_privilege('dop_app','public.release_manifests','INSERT')
       OR has_table_privilege('dop_app','public.release_manifests','UPDATE')
       OR has_table_privilege('dop_app','public.release_manifests','DELETE')
       OR has_table_privilege('dop_app','public.release_readiness_runs','INSERT')
       OR has_table_privilege('dop_app','public.release_approval_decisions','INSERT') THEN
        RAISE EXCEPTION 'dop_app gained direct release governance write privileges';
    END IF;
    IF NOT has_function_privilege('dop_app','public.dop_create_release_manifest(uuid,text,jsonb,text,text,uuid,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_evaluate_release_manifest(uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_submit_release_manifest(uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')
       OR NOT has_function_privilege('dop_app','public.dop_decide_release_manifest(uuid,uuid,text,text,text,uuid,timestamptz)','EXECUTE') THEN
        RAISE EXCEPTION 'dop_app cannot execute constrained M30 functions';
    END IF;
    IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname IN ('release_manifests','release_readiness_runs','release_approval_decisions')
           AND c.relrowsecurity)<>3 THEN RAISE EXCEPTION 'M30 RLS is incomplete'; END IF;
    RAISE NOTICE 'M30 verification passed: immutable snapshot, readiness, independent approval, rollback pointer and drift block enforced';
END;
$$;

SELECT jsonb_build_object(
    'verification','passed','independentApproval',true,'rollbackPointerFixed',true,
    'driftBlocked',true,'targetEnvironmentCreated',false,'secretValuesStored',false,
    'notificationsCreated',0,'externalCalls',0,'persistentSideEffects',0
) AS m30_result;

ROLLBACK;
