BEGIN;

DO $$
DECLARE
    selected_draft public.missing_document_request_drafts%ROWTYPE;
    recipient_id uuid;
    author_id uuid := gen_random_uuid();
    reviewer_id uuid := gen_random_uuid();
    plan_result jsonb;
    duplicate_plan_result jsonb;
    rejected_plan_result jsonb;
    evaluation_result jsonb;
    duplicate_evaluation_result jsonb;
    approved_revision_id uuid := gen_random_uuid();
    setup_event_id uuid := gen_random_uuid();
    recipient_allowlist_id uuid;
    content_hash_value text;
    planned_job_id uuid;
    notification_count_before integer;
    notification_count_after integer;
    delivery_job_count integer;
    evaluation_count integer;
    non_rls_table_count integer;
BEGIN
    SELECT * INTO selected_draft
      FROM public.missing_document_request_drafts
     WHERE status = 'draft'
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    IF selected_draft.id IS NULL THEN
        RAISE EXCEPTION 'M28 requires one current synthetic missing-document request draft';
    END IF;

    PERFORM public.dop_set_organization_context(
        (SELECT organization_key FROM public.organizations
          WHERE id = selected_draft.organization_id)
    );
    INSERT INTO public.actors (
        id, organization_id, external_subject_id, actor_type, display_name,
        email, status, attributes, created_at, updated_at
    ) VALUES
      (author_id, selected_draft.organization_id, 'm28-author-' || author_id::text,
       'manager', 'M28 synthetic author', 'm28-author-' || author_id::text || '@example.invalid',
       'active', '{"synthetic":true}'::jsonb, now(), now()),
      (reviewer_id, selected_draft.organization_id, 'm28-reviewer-' || reviewer_id::text,
       'admin', 'M28 synthetic reviewer', 'm28-reviewer-' || reviewer_id::text || '@example.invalid',
       'active', '{"synthetic":true}'::jsonb, now(), now());

    PERFORM public.dop_seed_missing_request_review(selected_draft.id, now());
    SELECT actor_id INTO recipient_id
      FROM public.subject_message_recipient_allowlist
     WHERE organization_id = selected_draft.organization_id
       AND subject_id = selected_draft.subject_id
       AND purpose = 'missing_document_request' AND status = 'active'
     ORDER BY approved_at DESC, id DESC
     LIMIT 1;
    IF recipient_id IS NULL THEN
        RAISE EXCEPTION 'M28 current synthetic subject lacks a governed recipient';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.delivery_recipient_allowlist delivery
          JOIN public.actors actor ON actor.organization_id = delivery.organization_id
           AND actor.id = delivery.actor_id
         WHERE delivery.organization_id = selected_draft.organization_id
           AND actor.id = recipient_id AND delivery.environment = 'DEV'
           AND delivery.purpose = 'missing_document_request' AND delivery.status = 'active'
    ) THEN
        RAISE EXCEPTION 'governed .invalid recipient was not synchronized to the DEV delivery allowlist';
    END IF;

    BEGIN
        INSERT INTO public.delivery_recipient_allowlist (
            organization_id, environment, channel, purpose, recipient_address,
            actor_id, display_name, status, source, reason, approved_at, created_at, updated_at
        ) VALUES (
            selected_draft.organization_id, 'DEV', 'email', 'missing_document_request',
            'real-recipient@example.com', author_id, 'Unsafe real recipient', 'active', 'manual_approval',
            'Verification must reject any address outside the RFC-reserved invalid domain.',
            now(), now(), now()
        );
        RAISE EXCEPTION 'real-world recipient unexpectedly entered the DEV delivery allowlist';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    SELECT count(*) INTO notification_count_before
      FROM public.notifications WHERE organization_id = selected_draft.organization_id;

    SELECT id INTO recipient_allowlist_id
      FROM public.subject_message_recipient_allowlist
     WHERE organization_id = selected_draft.organization_id
       AND subject_id = selected_draft.subject_id AND actor_id = recipient_id
       AND purpose = 'missing_document_request' AND status = 'active';
    content_hash_value := encode(digest(
        'actor:' || recipient_id::text || '|' ||
        selected_draft.subject_line || ' — M28 readiness|' ||
        selected_draft.body_text || E'\n\nThis synthetic revision is approved only for a non-executable delivery plan.|' ||
        selected_draft.requested_items::text, 'sha256'), 'hex');
    UPDATE public.missing_document_request_revisions
       SET status = 'superseded'
     WHERE organization_id = selected_draft.organization_id
       AND request_draft_id = selected_draft.id AND status = 'approved';
    INSERT INTO public.workflow_events (
        id, organization_id, idempotency_key, event_type, event_version,
        aggregate_type, aggregate_id, correlation_id, actor_id, producer, payload, occurred_at
    ) VALUES (
        setup_event_id, selected_draft.organization_id, gen_random_uuid()::text,
        'MissingDocumentRequest.VerificationApproved', 1,
        'missing_document_request_revision', approved_revision_id, gen_random_uuid(),
        reviewer_id, 'm28-regression-setup',
        jsonb_build_object('verification_fixture',true,'delivery_mode','disabled'), now()
    );
    INSERT INTO public.missing_document_request_revisions (
        id, organization_id, request_draft_id, revision, status,
        recipient_allowlist_id, recipient_reference, recipient_snapshot,
        subject_line, body_text, content_hash, change_reason,
        created_by_actor_id, submitted_by_actor_id, submitted_at,
        reviewed_by_actor_id, reviewed_at, review_reason,
        delivery_mode, external_call_count, idempotency_key, request_fingerprint,
        event_id, created_at
    ) VALUES (
        approved_revision_id, selected_draft.organization_id, selected_draft.id,
        (SELECT coalesce(max(revision),0) + 1 FROM public.missing_document_request_revisions
          WHERE organization_id = selected_draft.organization_id
            AND request_draft_id = selected_draft.id),
        'approved', recipient_allowlist_id, 'actor:' || recipient_id::text,
        jsonb_build_object('resolutionStatus','ready','actorId',recipient_id,
            'displayName',(SELECT display_name FROM public.actors WHERE id = recipient_id),
            'email',(SELECT lower(email) FROM public.actors WHERE id = recipient_id),
            'policy','allowlist_only','allowlistId',recipient_allowlist_id),
        selected_draft.subject_line || ' — M28 readiness',
        selected_draft.body_text || E'\n\nThis synthetic revision is approved only for a non-executable delivery plan.',
        content_hash_value,
        'Verification fixture provides one exact independently approved source revision.',
        author_id, author_id, now(), reviewer_id, now(),
        'Independent verification approval covers internal content only, never delivery.',
        'disabled', 0, gen_random_uuid(), encode(digest(approved_revision_id::text,'sha256'),'hex'),
        setup_event_id, now()
    );

    rejected_plan_result := public.dop_plan_missing_request_delivery(
        reviewer_id,
        (SELECT id FROM public.missing_document_request_revisions
          WHERE request_draft_id = selected_draft.id AND status <> 'approved'
          ORDER BY revision DESC LIMIT 1),
        'Verification refuses every revision that lacks independent approval.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF rejected_plan_result->>'reason' <> 'approved_revision_required' THEN
        RAISE EXCEPTION 'non-approved revision was not rejected: %', rejected_plan_result;
    END IF;

    plan_result := public.dop_plan_missing_request_delivery(
        reviewer_id, approved_revision_id,
        'Verification plans exact approved content for DEV contract evidence without sending.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF plan_result->>'outcome' <> 'completed'
       OR plan_result->>'status' <> 'planned'
       OR plan_result->>'runtimeExecution' <> 'disabled'
       OR (plan_result->>'providerConfigured')::boolean
       OR (plan_result->>'attemptCount')::integer <> 0
       OR (plan_result->>'externalCallCount')::integer <> 0 THEN
        RAISE EXCEPTION 'delivery plan crossed the disabled boundary: %', plan_result;
    END IF;
    planned_job_id := (plan_result->>'deliveryJobId')::uuid;

    duplicate_plan_result := public.dop_plan_missing_request_delivery(
        reviewer_id, approved_revision_id,
        'A distinct retry still resolves to the one exact approved-revision delivery plan.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF duplicate_plan_result->>'outcome' <> 'duplicate'
       OR duplicate_plan_result->>'deliveryJobId' <> planned_job_id::text THEN
        RAISE EXCEPTION 'approved-revision send key was not exactly-once: %', duplicate_plan_result;
    END IF;

    evaluation_result := public.dop_run_delivery_contract_evaluation(
        reviewer_id, planned_job_id,
        'Verification evaluates send lock, failure recovery and receipt idempotency without a provider.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF evaluation_result->>'outcome' <> 'completed'
       OR evaluation_result->>'status' <> 'passed'
       OR evaluation_result->>'runtimeExecution' <> 'disabled'
       OR (evaluation_result->>'externalCallCount')::integer <> 0 THEN
        RAISE EXCEPTION 'delivery contract evaluation failed its zero-execution boundary: %', evaluation_result;
    END IF;
    duplicate_evaluation_result := public.dop_run_delivery_contract_evaluation(
        reviewer_id, planned_job_id,
        'Verification evaluates send lock, failure recovery and receipt idempotency without a provider.',
        (SELECT idempotency_key FROM public.delivery_contract_evaluations
          WHERE id = (evaluation_result->>'evaluationId')::uuid),
        gen_random_uuid(), now()
    );
    IF duplicate_evaluation_result->>'outcome' <> 'duplicate' THEN
        RAISE EXCEPTION 'contract evaluation retry was not idempotent: %', duplicate_evaluation_result;
    END IF;

    SELECT count(*) INTO delivery_job_count FROM public.delivery_jobs
     WHERE organization_id = selected_draft.organization_id AND source_revision_id = approved_revision_id;
    SELECT count(*) INTO evaluation_count FROM public.delivery_contract_evaluations evaluation
     WHERE evaluation.organization_id = selected_draft.organization_id
       AND evaluation.delivery_job_id = planned_job_id;
    SELECT count(*) INTO notification_count_after FROM public.notifications
     WHERE organization_id = selected_draft.organization_id;
    IF delivery_job_count <> 1 OR evaluation_count <> 1
       OR notification_count_after <> notification_count_before
       OR EXISTS (SELECT 1 FROM public.delivery_attempts WHERE organization_id = selected_draft.organization_id
            AND delivery_job_id = planned_job_id)
       OR EXISTS (SELECT 1 FROM public.delivery_receipts WHERE organization_id = selected_draft.organization_id
            AND delivery_job_id = planned_job_id) THEN
        RAISE EXCEPTION 'readiness evidence produced duplicate or external-delivery state';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.delivery_contract_evaluations
         WHERE id = (evaluation_result->>'evaluationId')::uuid
           AND result @> '{"passed":true,"sendKeyUnique":true,"leaseRequired":true,"lateWorkerCannotCommit":true,"receiptIdempotent":true,"receiptPayload":"sha256_digest_only","runtimeExecution":"disabled","providerConfigured":false,"attemptRows":0,"receiptRows":0,"externalCalls":0}'::jsonb
    ) THEN
        RAISE EXCEPTION 'contract evaluation evidence is incomplete';
    END IF;

    IF NOT has_function_privilege('dop_app',
        'public.dop_plan_missing_request_delivery(uuid,uuid,text,uuid,uuid,timestamptz)', 'EXECUTE')
       OR NOT has_function_privilege('dop_app',
        'public.dop_run_delivery_contract_evaluation(uuid,uuid,text,uuid,uuid,timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'application role cannot execute constrained readiness functions';
    END IF;
    IF has_function_privilege('dop_app',
        'public.dop_sync_dev_delivery_recipient(uuid,timestamptz)', 'EXECUTE')
       OR has_function_privilege('dop_app',
        'public.dop_subject_recipient_sync_delivery_trigger()', 'EXECUTE') THEN
        RAISE EXCEPTION 'application role can execute internal delivery allowlist functions';
    END IF;
    IF has_table_privilege('dop_app','public.delivery_recipient_allowlist','INSERT')
       OR has_table_privilege('dop_app','public.delivery_jobs','INSERT')
       OR has_table_privilege('dop_app','public.delivery_jobs','UPDATE')
       OR has_table_privilege('dop_app','public.delivery_attempts','INSERT')
       OR has_table_privilege('dop_app','public.delivery_receipts','INSERT')
       OR has_table_privilege('dop_app','public.delivery_contract_evaluations','INSERT') THEN
        RAISE EXCEPTION 'application role has unexpected direct delivery write privileges';
    END IF;
    SELECT count(*) INTO non_rls_table_count
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
       AND NOT relation.relrowsecurity;
    IF non_rls_table_count <> 0 THEN
        RAISE EXCEPTION 'public schema contains % tables without RLS', non_rls_table_count;
    END IF;

    RAISE NOTICE 'M28 verification passed: exact approved revision, .invalid allowlist, unique send key, inert attempts/receipts, provider absent, external calls 0';
END;
$$;

SELECT jsonb_build_object(
    'verification','passed',
    'source','exact_approved_revision',
    'recipientPolicy','synthetic_actor_to_invalid_alias_only',
    'sendKeyUnique',true,
    'runtimeExecution','disabled',
    'providerConfigured',false,
    'attemptRows',0,
    'receiptRows',0,
    'notificationsCreated',0,
    'externalCalls',0,
    'persistentSideEffects',0
) AS m28_result;

ROLLBACK;
