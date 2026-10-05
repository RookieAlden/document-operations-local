BEGIN;

DO $$
DECLARE
    selected_draft public.missing_document_request_drafts%ROWTYPE;
    selected_subject public.subjects%ROWTYPE;
    recipient_id uuid;
    unlisted_recipient_id uuid := gen_random_uuid();
    author_id uuid := gen_random_uuid();
    reviewer_id uuid := gen_random_uuid();
    revision_key uuid := gen_random_uuid();
    submit_key uuid := gen_random_uuid();
    approve_key uuid := gen_random_uuid();
    rejected_recipient_result jsonb;
    created_result jsonb;
    submitted_result jsonb;
    self_approval_result jsonb;
    approved_result jsonb;
    duplicate_result jsonb;
    created_revision_id uuid;
    notification_count_before integer;
    notification_count_after integer;
    decision_count integer;
BEGIN
    SELECT * INTO selected_draft
      FROM public.missing_document_request_drafts
     WHERE status = 'draft'
     ORDER BY created_at DESC, id DESC
     LIMIT 1;
    IF selected_draft.id IS NULL THEN
        RAISE EXCEPTION 'M26 requires one current synthetic missing-document request draft';
    END IF;

    SELECT * INTO selected_subject
      FROM public.subjects
     WHERE organization_id = selected_draft.organization_id
       AND id = selected_draft.subject_id;

    -- Normalize only this transaction's current fixture. Later milestones may
    -- have approved or submitted its historical revisions; the M26 contract
    -- must remain repeatable without depending on that mutable live status.
    UPDATE public.missing_document_request_revisions
       SET status = 'rejected'
     WHERE organization_id = selected_draft.organization_id
       AND request_draft_id = selected_draft.id;

    PERFORM public.dop_set_organization_context(
        (SELECT organization_key FROM public.organizations
          WHERE id = selected_draft.organization_id)
    );

    -- Verification identities are rolled back. They exercise the same manager
    -- authorization and separation-of-duties boundary used by the Ops API.
    INSERT INTO public.actors (
        id, organization_id, external_subject_id, actor_type, display_name,
        email, status, attributes, created_at, updated_at
    ) VALUES
      (author_id, selected_draft.organization_id, 'm26-author-' || author_id::text,
       'manager', 'M26 synthetic author', 'm26-author-' || author_id::text || '@example.invalid',
       'active', '{"synthetic":true}'::jsonb, now(), now()),
      (reviewer_id, selected_draft.organization_id, 'm26-reviewer-' || reviewer_id::text,
       'admin', 'M26 synthetic reviewer', 'm26-reviewer-' || reviewer_id::text || '@example.invalid',
       'active', '{"synthetic":true}'::jsonb, now(), now()),
      (unlisted_recipient_id, selected_draft.organization_id,
       'm26-unlisted-' || unlisted_recipient_id::text, 'customer',
       'M26 unlisted recipient', 'm26-unlisted-' || unlisted_recipient_id::text || '@example.invalid',
       'active', '{"synthetic":true}'::jsonb, now(), now());

    -- The seed function revalidates the current Canonical primary contact and
    -- places only that governed contact on the purpose-specific allowlist.
    PERFORM public.dop_seed_missing_request_review(selected_draft.id, now());
    SELECT actor_id INTO recipient_id
      FROM public.subject_message_recipient_allowlist
     WHERE organization_id = selected_draft.organization_id
       AND subject_id = selected_draft.subject_id
       AND purpose = 'missing_document_request'
       AND status = 'active'
     ORDER BY approved_at DESC, id DESC
     LIMIT 1;
    IF recipient_id IS NULL THEN
        RAISE EXCEPTION 'current synthetic subject has no governed primary-contact recipient';
    END IF;

    SELECT count(*) INTO notification_count_before
      FROM public.notifications
     WHERE organization_id = selected_draft.organization_id;

    rejected_recipient_result := public.dop_create_missing_request_revision(
        author_id, selected_draft.id, unlisted_recipient_id,
        selected_draft.subject_line, selected_draft.body_text,
        'Verification rejects a customer who is outside the governed recipient allowlist.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF rejected_recipient_result->>'reason' <> 'recipient_not_allowlisted' THEN
        RAISE EXCEPTION 'ungoverned recipient was not rejected: %', rejected_recipient_result;
    END IF;

    created_result := public.dop_create_missing_request_revision(
        author_id, selected_draft.id, recipient_id,
        selected_draft.subject_line || ' — internal review',
        selected_draft.body_text || E'\n\nThis synthetic revision remains internal and cannot be delivered.',
        'Verification creates one immutable internal revision with governed recipient evidence.',
        revision_key, gen_random_uuid(), now()
    );
    IF created_result->>'outcome' <> 'completed'
       OR created_result->>'deliveryMode' <> 'disabled'
       OR (created_result->>'externalCallCount')::integer <> 0 THEN
        RAISE EXCEPTION 'revision creation did not preserve the delivery boundary: %', created_result;
    END IF;
    created_revision_id := (created_result->>'revisionId')::uuid;

    submitted_result := public.dop_transition_missing_request_revision(
        author_id, created_revision_id, 'submit_review',
        'Verification submits the immutable content hash for an independent reviewer.',
        submit_key, gen_random_uuid(), now()
    );
    IF submitted_result->>'status' <> 'in_review' THEN
        RAISE EXCEPTION 'revision was not submitted for review: %', submitted_result;
    END IF;

    self_approval_result := public.dop_transition_missing_request_revision(
        author_id, created_revision_id, 'approve',
        'Verification proves that an author cannot approve the revision they submitted.',
        gen_random_uuid(), gen_random_uuid(), now()
    );
    IF self_approval_result->>'reason' <> 'independent_reviewer_required' THEN
        RAISE EXCEPTION 'self-approval was not blocked: %', self_approval_result;
    END IF;

    approved_result := public.dop_transition_missing_request_revision(
        reviewer_id, created_revision_id, 'approve',
        'Independent synthetic reviewer approves only the internal draft, never delivery.',
        approve_key, gen_random_uuid(), now()
    );
    IF approved_result->>'status' <> 'approved'
       OR approved_result->>'deliveryMode' <> 'disabled'
       OR (approved_result->>'externalCallCount')::integer <> 0 THEN
        RAISE EXCEPTION 'independent approval crossed the delivery boundary: %', approved_result;
    END IF;

    duplicate_result := public.dop_transition_missing_request_revision(
        reviewer_id, created_revision_id, 'approve',
        'Independent synthetic reviewer approves only the internal draft, never delivery.',
        approve_key, gen_random_uuid(), now()
    );
    IF duplicate_result->>'outcome' <> 'duplicate' THEN
        RAISE EXCEPTION 'approval retry was not idempotent: %', duplicate_result;
    END IF;
    SELECT count(*) INTO decision_count
      FROM public.missing_document_request_review_decisions
     WHERE organization_id = selected_draft.organization_id
       AND revision_id = created_revision_id;
    IF decision_count <> 2 THEN
        RAISE EXCEPTION 'expected one submit and one approval decision, got %', decision_count;
    END IF;

    SELECT count(*) INTO notification_count_after
      FROM public.notifications
     WHERE organization_id = selected_draft.organization_id;
    IF notification_count_after <> notification_count_before THEN
        RAISE EXCEPTION 'internal review unexpectedly created a Notification';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.missing_document_request_revisions
         WHERE id = created_revision_id
           AND (delivery_mode <> 'disabled' OR external_call_count <> 0)
    ) THEN
        RAISE EXCEPTION 'approved revision contains an external delivery capability';
    END IF;

    IF NOT has_function_privilege('dop_app',
        'public.dop_create_missing_request_revision(uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz)',
        'EXECUTE')
       OR NOT has_function_privilege('dop_app',
        'public.dop_transition_missing_request_revision(uuid,uuid,text,text,uuid,uuid,timestamptz)',
        'EXECUTE') THEN
        RAISE EXCEPTION 'application role cannot execute the governed mutation functions';
    END IF;
    IF has_function_privilege('dop_app',
        'public.dop_seed_missing_request_review(uuid,timestamptz)', 'EXECUTE') THEN
        RAISE EXCEPTION 'application role can invoke the internal seed function';
    END IF;
    IF has_table_privilege('dop_app','public.subject_message_recipient_allowlist','INSERT')
       OR has_table_privilege('dop_app','public.missing_document_request_revisions','INSERT')
       OR has_table_privilege('dop_app','public.missing_document_request_revisions','UPDATE')
       OR has_table_privilege('dop_app','public.missing_document_request_review_decisions','INSERT') THEN
        RAISE EXCEPTION 'application role has unexpected direct write privileges';
    END IF;

    RAISE NOTICE 'M26 verification passed: allowlist-only recipient, independent approval, idempotent retry, delivery disabled, external calls 0';
END;
$$;

SELECT jsonb_build_object(
    'verification','passed',
    'recipientPolicy','allowlist_only',
    'independentReviewerRequired',true,
    'idempotent',true,
    'approvalMeansDelivery',false,
    'externalCalls',0,
    'externalDelivery','disabled',
    'persistentSideEffects',0
) AS m26_result;

ROLLBACK;
