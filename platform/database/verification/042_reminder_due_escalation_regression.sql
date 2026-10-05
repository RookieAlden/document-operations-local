BEGIN;

DO $$
DECLARE
    organization_id_value uuid;
    subject_row public.subjects%ROWTYPE;
    manager_id uuid;
    staff_id uuid;
    contact_id uuid;
    case_ids uuid[] := ARRAY[]::uuid[];
    assessment_ids uuid[] := ARRAY[]::uuid[];
    case_id_value uuid;
    submission_id_value uuid;
    assessment_id_value uuid;
    assessment_event_id uuid;
    draft_id_value uuid;
    draft_event_id uuid;
    index_value integer;
    schedule_result jsonb;
    replay_result jsonb;
    decision_result jsonb;
    reminder_id_value uuid;
    reminders_before integer;
    reminders_after integer;
    direct_mutation_grants integer;
BEGIN
    SELECT public.dop_set_organization_context('uat-accounting-firm') INTO organization_id_value;
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'UAT synthetic organization is unavailable';
    END IF;
    SELECT * INTO subject_row FROM public.subjects
     WHERE organization_id=organization_id_value AND subject_key='uat-client-001';
    SELECT id INTO manager_id FROM public.actors
     WHERE organization_id=organization_id_value AND external_subject_id='manager-daniel-wu';
    SELECT id INTO staff_id FROM public.actors
     WHERE organization_id=organization_id_value AND actor_type='staff' AND status='active'
     ORDER BY id LIMIT 1;
    contact_id := subject_row.primary_contact_actor_id;
    IF subject_row.id IS NULL OR manager_id IS NULL OR staff_id IS NULL OR contact_id IS NULL THEN
        RAISE EXCEPTION 'synthetic Reminder fixture actors are unavailable';
    END IF;

    INSERT INTO public.subject_message_recipient_allowlist (
        id,organization_id,subject_id,actor_id,purpose,status,source,
        approved_by_actor_id,reason,approved_at,created_at,updated_at
    ) VALUES (
        gen_random_uuid(),organization_id_value,subject_row.id,contact_id,
        'missing_document_request','active','manual_approval',manager_id,
        'M41 synthetic verification enables only the canonical test contact.',
        '2026-08-10T00:00:00Z','2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
    ) ON CONFLICT (organization_id,subject_id,actor_id,purpose)
      DO UPDATE SET status='active',revoked_at=NULL,updated_at=EXCLUDED.updated_at;

    FOR index_value IN 1..3 LOOP
        case_id_value := gen_random_uuid();
        submission_id_value := gen_random_uuid();
        assessment_id_value := gen_random_uuid();
        assessment_event_id := gen_random_uuid();
        draft_id_value := gen_random_uuid();
        draft_event_id := gen_random_uuid();
        case_ids := array_append(case_ids,case_id_value);
        assessment_ids := array_append(assessment_ids,assessment_id_value);
        INSERT INTO public.cases (
            id,organization_id,case_key,subject_id,workflow_template_version_id,
            requirement_set_version_id,prompt_version_id,period_start,period_end,
            timezone,status,risk_status,due_at,config_snapshot,created_at,updated_at
        ) SELECT
            case_id_value,organization_id_value,
            'm41-regression-'||index_value::text||'-'||case_id_value::text,
            subject_row.id,template.workflow_template_version_id,
            template.requirement_set_version_id,template.prompt_version_id,
            '2026-07-01','2026-07-31','Pacific/Auckland','waiting_for_documents',
            'overdue','2026-08-14T05:00:00Z',jsonb_build_object(
                'environment','UAT','source','m41_synthetic_regression',
                'external_messages_enabled',false,'external_messages_require_approval',true,
                'reminder',jsonb_build_object('lead_business_days',2,
                    'interval_business_days',2,'maximum',3,'escalation_business_days',2)
            ),'2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
          FROM public.cases template
         WHERE template.organization_id=organization_id_value
         ORDER BY template.created_at,template.id LIMIT 1;
        INSERT INTO public.submissions (
            id,organization_id,case_id,submission_key,source,source_submission_id,
            status,expected_document_count,terminal_document_count,received_at,
            completed_at,created_at,updated_at
        ) VALUES (
            submission_id_value,organization_id_value,case_id_value,
            'm41|'||case_id_value::text,'synthetic_regression','m41|'||case_id_value::text,
            'completed',0,0,'2026-08-10T00:00:00Z','2026-08-10T00:00:00Z',
            '2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
        );
        INSERT INTO public.workflow_events (
            id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
            aggregate_id,correlation_id,producer,payload,occurred_at
        ) VALUES (
            assessment_event_id,organization_id_value,'m41-assessment|'||case_id_value::text,
            'Case.CompletenessAssessed',1,'case',case_id_value,gen_random_uuid(),
            'm41-regression',jsonb_build_object('synthetic',true),'2026-08-10T00:00:00Z'
        );
        INSERT INTO public.case_completeness_assessments (
            id,organization_id,case_id,calculated_after_submission_id,
            requirement_set_version_id,algorithm_version,input_hash,status,
            matched_document_count,missing_requirement_count,duplicate_document_count,
            excess_document_count,review_required_document_count,unmatched_document_count,
            active_submission_count,result,event_id,created_at
        ) SELECT
            assessment_id_value,organization_id_value,case_id_value,submission_id_value,
            case_record.requirement_set_version_id,'1.0',
            encode(digest('m41-assessment|'||case_id_value::text,'sha256'),'hex'),
            'incomplete',0,1,0,0,0,0,0,
            jsonb_build_object('synthetic',true,'missing',1),assessment_event_id,
            '2026-08-10T00:00:00Z'
          FROM public.cases case_record WHERE case_record.id=case_id_value;
        INSERT INTO public.workflow_events (
            id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
            aggregate_id,correlation_id,producer,payload,occurred_at
        ) VALUES (
            draft_event_id,organization_id_value,'m41-draft|'||case_id_value::text,
            'MissingDocumentRequest.DraftCreated',1,'missing_document_request_draft',
            draft_id_value,gen_random_uuid(),'m41-regression',
            jsonb_build_object('synthetic',true),'2026-08-10T00:00:00Z'
        );
        INSERT INTO public.missing_document_request_drafts (
            id,organization_id,case_id,subject_id,assessment_id,draft_version,status,
            recipient_reference,recipient_snapshot,subject_line,body_text,requested_items,
            source_issue_ids,content_hash,delivery_mode,external_call_count,event_id,
            created_at,updated_at
        ) VALUES (
            draft_id_value,organization_id_value,case_id_value,subject_row.id,
            assessment_id_value,1,'draft','actor:'||contact_id::text,
            jsonb_build_object('resolutionStatus','ready','actorId',contact_id,
                'displayName','Synthetic Contact','email','synthetic@example.invalid'),
            'M41 synthetic missing document reminder',
            'This is a purely synthetic missing document request used only for M41 verification.',
            jsonb_build_array(jsonb_build_object('requirementCode','bank.minimum',
                'documentTypeCode','bank_statement','displayName','Bank Statement','missingCount',1)),
            ARRAY[]::uuid[],encode(digest('m41-draft|'||case_id_value::text,'sha256'),'hex'),
            'disabled',0,draft_event_id,'2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
        );
    END LOOP;

    schedule_result := public.dop_run_reminder_scheduler(
        'm41-regression-worker','m41-regression-run-2026-08-18T12','2026-08-18T12:00:00Z');
    -- This regression runs against an already seeded UAT tenant. Other synthetic
    -- Cases may also be due, so aggregate scheduler counts can be higher than the
    -- three fixtures below. Exact assertions remain scoped to case_ids.
    IF schedule_result->>'outcome'<>'completed'
       OR (schedule_result->>'casesScanned')::integer<3
       OR (schedule_result->>'remindersCreated')::integer<12
       OR (schedule_result->>'escalationsCreated')::integer<3
       OR (schedule_result->>'externalCallCount')::integer<>0 THEN
        RAISE EXCEPTION 'initial Reminder schedule result invalid: %',schedule_result;
    END IF;
    SELECT count(*) INTO reminders_before FROM public.reminder_instances
     WHERE case_id=ANY(case_ids);
    IF reminders_before<>12 THEN RAISE EXCEPTION 'expected 12 Reminder instances, got %',reminders_before; END IF;
    IF EXISTS (SELECT 1 FROM public.reminder_instances
        WHERE case_id=ANY(case_ids) AND (
            recipient_snapshot->>'address' !~ '[.]invalid$'
            OR delivery_mode<>'disabled' OR external_call_count<>0
            OR status<>'pending_approval')) THEN
        RAISE EXCEPTION 'Reminder safety boundary failed';
    END IF;

    replay_result := public.dop_run_reminder_scheduler(
        'm41-regression-worker','m41-regression-run-2026-08-18T12','2026-08-18T12:00:00Z');
    IF replay_result->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'same run was not idempotent'; END IF;
    PERFORM public.dop_run_reminder_scheduler(
        'm41-regression-worker-restarted','m41-regression-run-2026-08-18T12-restart','2026-08-18T12:05:00Z');
    SELECT count(*) INTO reminders_after FROM public.reminder_instances WHERE case_id=ANY(case_ids);
    IF reminders_after<>reminders_before THEN RAISE EXCEPTION 'worker restart duplicated Reminder windows'; END IF;

    SELECT id INTO reminder_id_value FROM public.reminder_instances
     WHERE case_id=case_ids[1] AND reminder_kind='initial' ORDER BY scheduled_at LIMIT 1;
    decision_result := public.dop_decide_reminder(
        manager_id,reminder_id_value,'approve','Synthetic content and .invalid recipient verified for M41 approval.',
        'm41-decision-idempotency',repeat('a',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
        '2026-08-18T12:10:00Z');
    IF decision_result->>'status'<>'approved' OR decision_result->>'deliveryMode'<>'disabled'
       OR (decision_result->>'externalCallCount')::integer<>0 THEN
        RAISE EXCEPTION 'Reminder approval boundary failed: %',decision_result;
    END IF;
    decision_result := public.dop_decide_reminder(
        manager_id,reminder_id_value,'approve','Synthetic content and .invalid recipient verified for M41 approval.',
        'm41-decision-idempotency',repeat('a',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
        '2026-08-18T12:10:00Z');
    IF decision_result->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'Reminder decision replay was not idempotent'; END IF;

    BEGIN
        PERFORM public.dop_decide_reminder(
            staff_id,(SELECT id FROM public.reminder_instances WHERE case_id=case_ids[2] LIMIT 1),
            'approve','A staff actor must not approve this synthetic Reminder.',
            'm41-staff-denied',repeat('b',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
            '2026-08-18T12:11:00Z');
        RAISE EXCEPTION 'staff Reminder approval unexpectedly succeeded';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    UPDATE public.case_completeness_assessments SET status='complete',missing_requirement_count=0
     WHERE id=assessment_ids[1];
    UPDATE public.cases SET status='completed',completed_at='2026-08-18T12:20:00Z'
     WHERE id=case_ids[2];
    UPDATE public.subject_message_recipient_allowlist SET status='revoked',
        revoked_at='2026-08-18T12:20:00Z',updated_at='2026-08-18T12:20:00Z'
     WHERE organization_id=organization_id_value AND subject_id=subject_row.id
       AND actor_id=contact_id AND purpose='missing_document_request';
    schedule_result := public.dop_run_reminder_scheduler(
        'm41-regression-worker','m41-regression-stop-2026-08-18T13','2026-08-18T13:00:00Z');
    IF (schedule_result->>'remindersStopped')::integer<12 THEN
        RAISE EXCEPTION 'expected at least the 12 fixture Reminder instances to stop: %',schedule_result;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.reminder_instances WHERE case_id=case_ids[1] AND stop_reason='case_ready')
       OR NOT EXISTS (SELECT 1 FROM public.reminder_instances WHERE case_id=case_ids[2] AND stop_reason='case_terminal')
       OR NOT EXISTS (SELECT 1 FROM public.reminder_instances WHERE case_id=case_ids[3] AND stop_reason='contact_revoked_or_unavailable') THEN
        RAISE EXCEPTION 'one or more stop conditions were not preserved';
    END IF;
    IF EXISTS (SELECT 1 FROM public.reminder_escalations
        WHERE case_id=ANY(case_ids) AND status='open') THEN
        RAISE EXCEPTION 'stopped Cases retained open escalation records';
    END IF;

    BEGIN
        UPDATE public.reminder_decisions SET reason='Attempted mutation must fail.'
         WHERE reminder_instance_id=reminder_id_value;
        RAISE EXCEPTION 'Reminder decision audit was mutable';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;

    SELECT count(*) INTO direct_mutation_grants
      FROM information_schema.role_table_grants
     WHERE grantee IN ('dop_app','dop_app_uat') AND table_schema='public'
       AND table_name IN ('reminder_schedule_runs','reminder_instances','reminder_decisions','reminder_escalations')
       AND privilege_type IN ('INSERT','UPDATE','DELETE');
    IF direct_mutation_grants<>0 THEN RAISE EXCEPTION 'runtime role has direct Reminder mutation grants'; END IF;
END $$;

ROLLBACK;
