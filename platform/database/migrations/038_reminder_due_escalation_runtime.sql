BEGIN;

-- M41 introduces a tenant-bound, repeatable Reminder scheduler. It produces
-- approval inputs and internal escalations only. External delivery remains
-- impossible: every address is RFC-reserved .invalid and every external call
-- counter is constrained to zero.
CREATE TABLE public.reminder_business_calendar_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    calendar_key text NOT NULL CHECK (calendar_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    local_date date NOT NULL,
    is_business_day boolean NOT NULL,
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300),
    created_by_actor_id uuid REFERENCES public.actors(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, calendar_key, local_date),
    FOREIGN KEY (organization_id, created_by_actor_id)
        REFERENCES public.actors (organization_id, id)
);

CREATE TABLE public.reminder_schedule_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    run_key text NOT NULL CHECK (char_length(run_key) BETWEEN 12 AND 200),
    worker_id text NOT NULL CHECK (char_length(worker_id) BETWEEN 3 AND 200),
    evaluated_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status = 'completed'),
    cases_scanned integer NOT NULL CHECK (cases_scanned >= 0),
    reminders_created integer NOT NULL CHECK (reminders_created >= 0),
    reminders_stopped integer NOT NULL CHECK (reminders_stopped >= 0),
    escalations_created integer NOT NULL CHECK (escalations_created >= 0),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id, run_key)
);

CREATE TABLE public.reminder_instances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    case_id uuid NOT NULL REFERENCES public.cases(id),
    subject_id uuid NOT NULL REFERENCES public.subjects(id),
    request_draft_id uuid NOT NULL REFERENCES public.missing_document_request_drafts(id),
    source_schedule_run_id uuid NOT NULL REFERENCES public.reminder_schedule_runs(id),
    reminder_key text NOT NULL CHECK (reminder_key ~ '^[0-9a-f]{64}$'),
    window_key text NOT NULL CHECK (char_length(window_key) BETWEEN 8 AND 160),
    sequence_number integer NOT NULL CHECK (sequence_number >= 1),
    reminder_kind text NOT NULL CHECK (reminder_kind IN (
        'initial','follow_up','overdue','escalation'
    )),
    scheduled_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN (
        'pending_approval','approved','rejected','cancelled'
    )),
    trigger_reason text NOT NULL CHECK (char_length(trigger_reason) BETWEEN 12 AND 1000),
    policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
    recipient_reference text NOT NULL,
    recipient_snapshot jsonb NOT NULL CHECK (
        jsonb_typeof(recipient_snapshot) = 'object'
        AND recipient_snapshot->>'address' ~ '^[^[:space:]@]+@[^[:space:]@]+[.]invalid$'
    ),
    content_snapshot jsonb NOT NULL CHECK (jsonb_typeof(content_snapshot) = 'object'),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    escalation_owner_actor_id uuid REFERENCES public.actors(id),
    stop_reason text CHECK (stop_reason IS NULL OR char_length(stop_reason) BETWEEN 3 AND 300),
    decided_by_actor_id uuid REFERENCES public.actors(id),
    decided_at timestamptz,
    decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 12 AND 1000),
    delivery_mode text NOT NULL DEFAULT 'disabled' CHECK (delivery_mode = 'disabled'),
    external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count = 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, reminder_key),
    UNIQUE (organization_id, case_id, window_key, reminder_kind),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, subject_id) REFERENCES public.subjects(organization_id, id),
    FOREIGN KEY (organization_id, escalation_owner_actor_id)
        REFERENCES public.actors(organization_id, id),
    FOREIGN KEY (organization_id, decided_by_actor_id)
        REFERENCES public.actors(organization_id, id),
    CHECK ((decided_by_actor_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
        OR (decided_by_actor_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL))
);

CREATE TABLE public.reminder_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    reminder_instance_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('approve','reject')),
    prior_status text NOT NULL CHECK (prior_status = 'pending_approval'),
    resulting_status text NOT NULL CHECK (resulting_status IN ('approved','rejected')),
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 12 AND 1000),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid NOT NULL,
    decided_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    FOREIGN KEY (organization_id, reminder_instance_id)
        REFERENCES public.reminder_instances(organization_id, id),
    FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    FOREIGN KEY (organization_id, event_id) REFERENCES public.workflow_events(organization_id, id)
);

CREATE TABLE public.reminder_escalations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    reminder_instance_id uuid NOT NULL,
    case_id uuid NOT NULL,
    owner_actor_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('open','cancelled','resolved')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    opened_at timestamptz NOT NULL,
    closed_at timestamptz,
    close_reason text,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, reminder_instance_id),
    FOREIGN KEY (organization_id, reminder_instance_id)
        REFERENCES public.reminder_instances(organization_id, id),
    FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id),
    FOREIGN KEY (organization_id, owner_actor_id) REFERENCES public.actors(organization_id, id),
    CHECK ((status = 'open' AND closed_at IS NULL AND close_reason IS NULL)
        OR (status IN ('cancelled','resolved') AND closed_at IS NOT NULL
            AND char_length(close_reason) BETWEEN 3 AND 300))
);

CREATE INDEX reminder_instances_case_idx ON public.reminder_instances
    (organization_id, case_id, scheduled_at DESC, id DESC);
CREATE INDEX reminder_instances_approval_idx ON public.reminder_instances
    (organization_id, status, scheduled_at, id);
CREATE INDEX reminder_escalations_owner_idx ON public.reminder_escalations
    (organization_id, owner_actor_id, status, opened_at);
CREATE INDEX reminder_schedule_runs_time_idx ON public.reminder_schedule_runs
    (organization_id, evaluated_at DESC, id DESC);

ALTER TABLE public.reminder_business_calendar_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_schedule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_escalations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.reminder_business_calendar_exceptions,
    public.reminder_schedule_runs, public.reminder_instances,
    public.reminder_decisions, public.reminder_escalations TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.reminder_business_calendar_exceptions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.reminder_schedule_runs
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.reminder_instances
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.reminder_decisions
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.reminder_escalations
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_reminder_is_business_day(
    p_organization_id uuid,
    p_calendar_key text,
    p_local_date date
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        (SELECT exception.is_business_day
           FROM public.reminder_business_calendar_exceptions exception
          WHERE exception.organization_id = p_organization_id
            AND exception.calendar_key = p_calendar_key
            AND exception.local_date = p_local_date),
        extract(isodow FROM p_local_date) BETWEEN 1 AND 5
    );
$$;

CREATE OR REPLACE FUNCTION public.dop_reminder_shift_business_days(
    p_organization_id uuid,
    p_calendar_key text,
    p_start_date date,
    p_business_days integer
) RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    result_date date := p_start_date;
    remaining integer := abs(p_business_days);
    direction integer := CASE WHEN p_business_days < 0 THEN -1 ELSE 1 END;
    guard integer := 0;
BEGIN
    IF abs(p_business_days) > 366 THEN
        RAISE EXCEPTION 'business day shift exceeds safety boundary' USING ERRCODE = '22023';
    END IF;
    WHILE remaining > 0 LOOP
        result_date := result_date + direction;
        guard := guard + 1;
        IF guard > 732 THEN
            RAISE EXCEPTION 'business calendar did not converge' USING ERRCODE = '22023';
        END IF;
        IF public.dop_reminder_is_business_day(p_organization_id, p_calendar_key, result_date) THEN
            remaining := remaining - 1;
        END IF;
    END LOOP;
    RETURN result_date;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_reminder_scheduler(
    p_worker_id text,
    p_run_key text,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_current_organization_id();
    run_row public.reminder_schedule_runs%ROWTYPE;
    run_id_value uuid := gen_random_uuid();
    case_item record;
    stop_item record;
    sequence_value integer;
    maximum_value integer;
    interval_value integer;
    lead_value integer;
    escalation_days_value integer;
    calendar_key_value text;
    initial_local_date date;
    scheduled_local_date date;
    scheduled_at_value timestamptz;
    escalation_at_value timestamptz;
    reminder_kind_value text;
    window_key_value text;
    reminder_key_value text;
    reminder_id_value uuid;
    event_id_value uuid;
    recipient_address_value text;
    policy_value jsonb;
    content_value jsonb;
    content_hash_value text;
    escalation_owner_id uuid;
    cases_scanned_value integer := 0;
    reminders_created_value integer := 0;
    reminders_stopped_value integer := 0;
    escalations_created_value integer := 0;
    stop_reason_value text;
BEGIN
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
    END IF;
    IF char_length(p_worker_id) NOT BETWEEN 3 AND 200
       OR char_length(p_run_key) NOT BETWEEN 12 AND 200 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_scheduler_request');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        organization_id_value::text || '|reminder-scheduler|' || p_run_key, 0
    ));
    SELECT * INTO run_row FROM public.reminder_schedule_runs
     WHERE organization_id = organization_id_value AND run_key = p_run_key;
    IF FOUND THEN
        RETURN jsonb_build_object('outcome','duplicate','scheduleRunId',run_row.id,
            'casesScanned',run_row.cases_scanned,'remindersCreated',run_row.reminders_created,
            'remindersStopped',run_row.reminders_stopped,
            'escalationsCreated',run_row.escalations_created,'externalCallCount',0);
    END IF;

    INSERT INTO public.reminder_schedule_runs (
        id,organization_id,run_key,worker_id,evaluated_at,status,cases_scanned,
        reminders_created,reminders_stopped,escalations_created,
        external_call_count,result,created_at
    ) VALUES (
        run_id_value,organization_id_value,p_run_key,p_worker_id,p_now,'completed',
        0,0,0,0,0,'{}'::jsonb,p_now
    );

    -- Re-evaluate every outstanding reminder first. A complete/ready Case or a
    -- revoked/unavailable contact closes approval inputs before any new window.
    FOR stop_item IN
        SELECT reminder.id, reminder.case_id,
               CASE
                 WHEN case_record.status IN ('completed','cancelled') THEN 'case_terminal'
                 WHEN latest_assessment.status = 'complete' THEN 'case_ready'
                 WHEN NOT EXISTS (
                     SELECT 1 FROM public.subject_message_recipient_allowlist allowlist
                      JOIN public.actors recipient ON recipient.id = allowlist.actor_id
                     WHERE allowlist.organization_id = reminder.organization_id
                       AND allowlist.subject_id = reminder.subject_id
                       AND allowlist.purpose = 'missing_document_request'
                       AND allowlist.status = 'active'
                       AND recipient.status = 'active'
                       AND recipient.actor_type = 'customer'
                 ) THEN 'contact_revoked_or_unavailable'
                 ELSE NULL
               END AS stop_reason
          FROM public.reminder_instances reminder
          JOIN public.cases case_record ON case_record.id = reminder.case_id
          LEFT JOIN LATERAL (
              SELECT assessment.status
                FROM public.case_completeness_assessments assessment
               WHERE assessment.organization_id = reminder.organization_id
                 AND assessment.case_id = reminder.case_id
               ORDER BY assessment.created_at DESC, assessment.id DESC LIMIT 1
          ) latest_assessment ON true
         WHERE reminder.organization_id = organization_id_value
           AND reminder.status IN ('pending_approval','approved')
    LOOP
        IF stop_item.stop_reason IS NULL THEN CONTINUE; END IF;
        UPDATE public.reminder_instances SET status='cancelled',
            stop_reason=stop_item.stop_reason,updated_at=p_now
         WHERE organization_id=organization_id_value AND id=stop_item.id;
        UPDATE public.reminder_escalations SET status='cancelled',closed_at=p_now,
            close_reason=stop_item.stop_reason
         WHERE organization_id=organization_id_value
           AND reminder_instance_id=stop_item.id AND status='open';
        INSERT INTO public.workflow_events (
            id,organization_id,idempotency_key,event_type,event_version,
            aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at
        ) VALUES (
            gen_random_uuid(),organization_id_value,
            'reminder-stop|'||stop_item.id::text||'|'||stop_item.stop_reason,
            'Reminder.Stopped',1,'reminder_instance',stop_item.id,run_id_value,
            'dop.automation.reminder.v1',jsonb_build_object(
                'case_id',stop_item.case_id,'stop_reason',stop_item.stop_reason,
                'delivery_mode','disabled','external_call_count',0),p_now
        ) ON CONFLICT (organization_id,idempotency_key) DO NOTHING;
        reminders_stopped_value := reminders_stopped_value + 1;
    END LOOP;

    FOR case_item IN
        SELECT case_record.*, subject.display_name AS subject_name,
               subject.attributes AS subject_attributes,
               draft.id AS request_draft_id,draft.subject_line,draft.body_text,
               draft.requested_items,draft.content_hash AS draft_content_hash,
               contact.id AS contact_actor_id,contact.display_name AS contact_name,
               latest_assessment.status AS completeness_status,
               latest_assessment.missing_requirement_count
          FROM public.cases case_record
          JOIN public.subjects subject ON subject.id=case_record.subject_id
          JOIN LATERAL (
              SELECT assessment.status,assessment.missing_requirement_count
                FROM public.case_completeness_assessments assessment
               WHERE assessment.organization_id=case_record.organization_id
                 AND assessment.case_id=case_record.id
               ORDER BY assessment.created_at DESC,assessment.id DESC LIMIT 1
          ) latest_assessment ON true
          JOIN LATERAL (
              SELECT request.* FROM public.missing_document_request_drafts request
               WHERE request.organization_id=case_record.organization_id
                 AND request.case_id=case_record.id AND request.status='draft'
               ORDER BY request.draft_version DESC,request.id DESC LIMIT 1
          ) draft ON true
          JOIN LATERAL (
              SELECT actor.id,actor.display_name
                FROM public.subject_message_recipient_allowlist allowlist
                JOIN public.actors actor ON actor.id=allowlist.actor_id
               WHERE allowlist.organization_id=case_record.organization_id
                 AND allowlist.subject_id=case_record.subject_id
                 AND allowlist.purpose='missing_document_request'
                 AND allowlist.status='active' AND actor.status='active'
                 AND actor.actor_type='customer'
               ORDER BY allowlist.approved_at DESC,allowlist.id DESC LIMIT 1
          ) contact ON true
         WHERE case_record.organization_id=organization_id_value
           AND case_record.status NOT IN ('completed','cancelled')
           AND subject.status='active'
           AND subject.attributes @> '{"synthetic":true}'::jsonb
           AND latest_assessment.status IN ('incomplete','review_required')
           AND latest_assessment.missing_requirement_count > 0
           AND case_record.due_at IS NOT NULL
           AND coalesce((case_record.config_snapshot->>'external_messages_enabled')::boolean,false)=false
         ORDER BY case_record.due_at,case_record.id
    LOOP
        cases_scanned_value := cases_scanned_value + 1;
        maximum_value := least(greatest(coalesce(
            (case_item.config_snapshot#>>'{reminder,maximum}')::integer,2),1),12);
        interval_value := least(greatest(coalesce(
            (case_item.config_snapshot#>>'{reminder,interval_business_days}')::integer,2),1),31);
        lead_value := least(greatest(coalesce(
            (case_item.config_snapshot#>>'{reminder,lead_business_days}')::integer,2),0),31);
        escalation_days_value := least(greatest(coalesce(
            (case_item.config_snapshot#>>'{reminder,escalation_business_days}')::integer,2),0),31);
        calendar_key_value := lower(regexp_replace(coalesce(
            case_item.subject_attributes->>'holiday_region','new-zealand'),
            '[^a-z0-9]+','-','g'));
        IF char_length(calendar_key_value)<3 THEN calendar_key_value:='new-zealand'; END IF;
        IF case_item.config_snapshot#>>'{reminder,first_at}' IS NOT NULL THEN
            initial_local_date := ((case_item.config_snapshot#>>'{reminder,first_at}')::timestamptz
                AT TIME ZONE case_item.timezone)::date;
        ELSE
            initial_local_date := public.dop_reminder_shift_business_days(
                organization_id_value,calendar_key_value,
                (case_item.due_at AT TIME ZONE case_item.timezone)::date,-lead_value);
        END IF;
        recipient_address_value := 'reminder+'||replace(case_item.contact_actor_id::text,'-','')
            ||'@document-operations.invalid';
        SELECT actor.id INTO escalation_owner_id FROM public.actors actor
         WHERE actor.organization_id=organization_id_value
           AND actor.external_subject_id=case_item.subject_attributes->>'manager'
           AND actor.actor_type IN ('manager','admin') AND actor.status='active';
        policy_value := jsonb_build_object(
            'schemaVersion','1.0','timezone',case_item.timezone,
            'calendarKey',calendar_key_value,'workweek','monday_friday_with_exceptions',
            'leadBusinessDays',lead_value,'intervalBusinessDays',interval_value,
            'maximumReminders',maximum_value,
            'escalationBusinessDays',escalation_days_value,
            'escalationDefaultApplied',
                NOT (case_item.config_snapshot#>'{reminder}' ? 'escalation_business_days'),
            'approvalRequired',true,'recipientPolicy','synthetic_invalid_only',
            'stopConditions',jsonb_build_array('case_ready','case_terminal','contact_revoked_or_unavailable'),
            'deliveryMode','disabled');
        FOR sequence_value IN 1..maximum_value LOOP
            scheduled_local_date := public.dop_reminder_shift_business_days(
                organization_id_value,calendar_key_value,initial_local_date,
                (sequence_value-1)*interval_value);
            scheduled_at_value := (scheduled_local_date + time '10:00') AT TIME ZONE case_item.timezone;
            IF sequence_value=1 AND case_item.config_snapshot#>>'{reminder,first_at}' IS NOT NULL THEN
                scheduled_at_value := (case_item.config_snapshot#>>'{reminder,first_at}')::timestamptz;
            END IF;
            IF scheduled_at_value > p_now THEN CONTINUE; END IF;
            reminder_kind_value := CASE
                WHEN scheduled_at_value > case_item.due_at THEN 'overdue'
                WHEN sequence_value=1 THEN 'initial' ELSE 'follow_up' END;
            window_key_value := to_char(scheduled_at_value AT TIME ZONE case_item.timezone,
                'YYYY-MM-DD"T"HH24:MI')||'|'||sequence_value::text;
            reminder_key_value := encode(digest(concat_ws('|','reminder-v1',
                organization_id_value::text,case_item.id::text,window_key_value,
                reminder_kind_value,case_item.request_draft_id::text),'sha256'),'hex');
            content_value := jsonb_build_object(
                'subjectLine',case_item.subject_line,'bodyText',case_item.body_text,
                'requestedItems',case_item.requested_items,'subjectName',case_item.subject_name,
                'caseId',case_item.id,'periodStart',case_item.period_start,
                'periodEnd',case_item.period_end,'reminderSequence',sequence_value,
                'reminderKind',reminder_kind_value,'sourceDraftHash',case_item.draft_content_hash);
            content_hash_value := encode(digest(content_value::text,'sha256'),'hex');
            reminder_id_value := gen_random_uuid();
            event_id_value := gen_random_uuid();
            INSERT INTO public.reminder_instances (
                id,organization_id,case_id,subject_id,request_draft_id,
                source_schedule_run_id,reminder_key,window_key,sequence_number,
                reminder_kind,scheduled_at,status,trigger_reason,policy_snapshot,
                recipient_reference,recipient_snapshot,content_snapshot,content_hash,
                escalation_owner_actor_id,delivery_mode,external_call_count,created_at,updated_at
            ) VALUES (
                reminder_id_value,organization_id_value,case_item.id,case_item.subject_id,
                case_item.request_draft_id,run_id_value,reminder_key_value,window_key_value,
                sequence_value,reminder_kind_value,scheduled_at_value,'pending_approval',
                '缺件Case已进入配置化提醒窗口；仍需人工批准且不可外发。',policy_value,
                'actor:'||case_item.contact_actor_id::text,jsonb_build_object(
                    'actorId',case_item.contact_actor_id,'displayName',case_item.contact_name,
                    'address',recipient_address_value,'policy','synthetic_invalid_only'),
                content_value,content_hash_value,escalation_owner_id,'disabled',0,p_now,p_now
            ) ON CONFLICT (organization_id,case_id,window_key,reminder_kind) DO NOTHING;
            IF FOUND THEN
                INSERT INTO public.workflow_events (
                    id,organization_id,idempotency_key,event_type,event_version,
                    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at
                ) VALUES (
                    event_id_value,organization_id_value,'reminder-created|'||reminder_key_value,
                    'Reminder.ApprovalRequested',1,'reminder_instance',reminder_id_value,
                    run_id_value,'dop.automation.reminder.v1',jsonb_build_object(
                        'case_id',case_item.id,'window_key',window_key_value,
                        'sequence',sequence_value,'reminder_kind',reminder_kind_value,
                        'scheduled_at',scheduled_at_value,'content_hash',content_hash_value,
                        'recipient_policy','synthetic_invalid_only','delivery_mode','disabled',
                        'external_call_count',0),p_now
                );
                reminders_created_value := reminders_created_value + 1;
            END IF;
        END LOOP;

        escalation_at_value := (
            public.dop_reminder_shift_business_days(organization_id_value,calendar_key_value,
                (case_item.due_at AT TIME ZONE case_item.timezone)::date,escalation_days_value)
            + time '09:00') AT TIME ZONE case_item.timezone;
        IF escalation_owner_id IS NOT NULL AND escalation_at_value <= p_now THEN
            window_key_value := to_char(escalation_at_value AT TIME ZONE case_item.timezone,
                'YYYY-MM-DD"T"HH24:MI')||'|escalation';
            reminder_key_value := encode(digest(concat_ws('|','reminder-v1',
                organization_id_value::text,case_item.id::text,window_key_value,
                'escalation',case_item.request_draft_id::text),'sha256'),'hex');
            content_value := jsonb_build_object(
                'subjectLine','逾期缺件升级：'||case_item.subject_name,
                'bodyText','该纯虚构Case已超过客户截止日，缺件仍未解决，请内部负责人处理。',
                'requestedItems',case_item.requested_items,'subjectName',case_item.subject_name,
                'caseId',case_item.id,'periodStart',case_item.period_start,
                'periodEnd',case_item.period_end,'reminderKind','escalation',
                'sourceDraftHash',case_item.draft_content_hash);
            content_hash_value := encode(digest(content_value::text,'sha256'),'hex');
            reminder_id_value := gen_random_uuid();
            INSERT INTO public.reminder_instances (
                id,organization_id,case_id,subject_id,request_draft_id,
                source_schedule_run_id,reminder_key,window_key,sequence_number,
                reminder_kind,scheduled_at,status,trigger_reason,policy_snapshot,
                recipient_reference,recipient_snapshot,content_snapshot,content_hash,
                escalation_owner_actor_id,delivery_mode,external_call_count,created_at,updated_at
            ) VALUES (
                reminder_id_value,organization_id_value,case_item.id,case_item.subject_id,
                case_item.request_draft_id,run_id_value,reminder_key_value,window_key_value,
                maximum_value+1,'escalation',escalation_at_value,'pending_approval',
                '缺件Case已超过配置化升级窗口，建立内部负责人升级记录。',policy_value,
                'actor:'||escalation_owner_id::text,jsonb_build_object(
                    'actorId',escalation_owner_id,'displayName',
                        (SELECT display_name FROM public.actors WHERE id=escalation_owner_id),
                    'address','escalation+'||replace(escalation_owner_id::text,'-','')
                        ||'@document-operations.invalid','policy','internal_invalid_only'),
                content_value,content_hash_value,escalation_owner_id,'disabled',0,p_now,p_now
            ) ON CONFLICT (organization_id,case_id,window_key,reminder_kind) DO NOTHING;
            IF FOUND THEN
                INSERT INTO public.reminder_escalations (
                    id,organization_id,reminder_instance_id,case_id,owner_actor_id,
                    status,reason,opened_at
                ) VALUES (
                    gen_random_uuid(),organization_id_value,reminder_id_value,case_item.id,
                    escalation_owner_id,'open',
                    'Case已超过配置化工作日升级窗口，等待内部负责人处理。',p_now
                );
                INSERT INTO public.workflow_events (
                    id,organization_id,idempotency_key,event_type,event_version,
                    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at
                ) VALUES (
                    gen_random_uuid(),organization_id_value,'reminder-escalated|'||reminder_key_value,
                    'Reminder.Escalated',1,'reminder_instance',reminder_id_value,
                    run_id_value,'dop.automation.reminder.v1',jsonb_build_object(
                        'case_id',case_item.id,'owner_actor_id',escalation_owner_id,
                        'scheduled_at',escalation_at_value,'delivery_mode','disabled',
                        'external_call_count',0),p_now
                );
                reminders_created_value := reminders_created_value + 1;
                escalations_created_value := escalations_created_value + 1;
            END IF;
        END IF;
    END LOOP;

    UPDATE public.reminder_schedule_runs SET
        cases_scanned=cases_scanned_value,reminders_created=reminders_created_value,
        reminders_stopped=reminders_stopped_value,
        escalations_created=escalations_created_value,
        result=jsonb_build_object('casesScanned',cases_scanned_value,
            'remindersCreated',reminders_created_value,
            'remindersStopped',reminders_stopped_value,
            'escalationsCreated',escalations_created_value,
            'recipientPolicy','synthetic_invalid_only','approvalRequired',true,
            'deliveryMode','disabled','externalCallCount',0)
     WHERE organization_id=organization_id_value AND id=run_id_value;
    RETURN jsonb_build_object('outcome','completed','scheduleRunId',run_id_value,
        'casesScanned',cases_scanned_value,'remindersCreated',reminders_created_value,
        'remindersStopped',reminders_stopped_value,
        'escalationsCreated',escalations_created_value,'externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_decide_reminder(
    p_actor_id uuid,
    p_reminder_instance_id uuid,
    p_action text,
    p_reason text,
    p_idempotency_key text,
    p_request_fingerprint text,
    p_decision_id uuid,
    p_event_id uuid,
    p_correlation_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_require_active_manager(p_actor_id);
    reminder_row public.reminder_instances%ROWTYPE;
    existing_row public.reminder_decisions%ROWTYPE;
    resulting_status_value text;
BEGIN
    IF p_action NOT IN ('approve','reject')
       OR char_length(btrim(p_reason)) NOT BETWEEN 12 AND 1000
       OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','decision_not_allowed');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        organization_id_value::text||'|reminder-decision|'||p_idempotency_key,0));
    SELECT * INTO existing_row FROM public.reminder_decisions
     WHERE organization_id=organization_id_value AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
        IF existing_row.request_fingerprint<>p_request_fingerprint THEN
            RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
        END IF;
        RETURN jsonb_build_object('outcome','duplicate','decisionId',existing_row.id,
            'reminderInstanceId',existing_row.reminder_instance_id,
            'status',existing_row.resulting_status,'externalCallCount',0);
    END IF;
    SELECT * INTO reminder_row FROM public.reminder_instances
     WHERE organization_id=organization_id_value AND id=p_reminder_instance_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','reminder_not_found'); END IF;
    IF reminder_row.status<>'pending_approval' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','reminder_not_pending');
    END IF;
    IF reminder_row.delivery_mode<>'disabled' OR reminder_row.external_call_count<>0
       OR reminder_row.recipient_snapshot->>'address' !~ '[.]invalid$' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','reminder_safety_boundary_invalid');
    END IF;
    resulting_status_value := CASE WHEN p_action='approve' THEN 'approved' ELSE 'rejected' END;
    UPDATE public.reminder_instances SET status=resulting_status_value,
        decided_by_actor_id=p_actor_id,decided_at=p_now,decision_reason=btrim(p_reason),updated_at=p_now
     WHERE organization_id=organization_id_value AND id=reminder_row.id;
    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (
        p_event_id,organization_id_value,'reminder-decision|'||p_idempotency_key,
        CASE WHEN p_action='approve' THEN 'Reminder.Approved' ELSE 'Reminder.Rejected' END,
        1,'reminder_instance',reminder_row.id,p_correlation_id,p_actor_id,
        'dop.ops.reminder.v1',jsonb_build_object(
            'case_id',reminder_row.case_id,'action',p_action,
            'content_hash',reminder_row.content_hash,'delivery_mode','disabled',
            'external_call_count',0),p_now
    );
    INSERT INTO public.reminder_decisions (
        id,organization_id,reminder_instance_id,actor_id,action,prior_status,
        resulting_status,reason,content_hash,idempotency_key,request_fingerprint,
        event_id,decided_at
    ) VALUES (
        p_decision_id,organization_id_value,reminder_row.id,p_actor_id,p_action,
        'pending_approval',resulting_status_value,btrim(p_reason),reminder_row.content_hash,
        p_idempotency_key,p_request_fingerprint,p_event_id,p_now
    );
    RETURN jsonb_build_object('outcome','completed','decisionId',p_decision_id,
        'reminderInstanceId',reminder_row.id,'status',resulting_status_value,
        'deliveryMode','disabled','externalCallCount',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_reject_reminder_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'reminder audit rows are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER reminder_decisions_immutable BEFORE UPDATE OR DELETE ON public.reminder_decisions
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_reminder_audit_mutation();
CREATE TRIGGER reminder_schedule_runs_immutable BEFORE DELETE ON public.reminder_schedule_runs
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_reminder_audit_mutation();

REVOKE INSERT,UPDATE,DELETE ON public.reminder_business_calendar_exceptions,
    public.reminder_schedule_runs,public.reminder_instances,
    public.reminder_decisions,public.reminder_escalations FROM dop_app;
REVOKE ALL ON FUNCTION public.dop_reminder_is_business_day(uuid,text,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_reminder_shift_business_days(uuid,text,date,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_reminder_scheduler(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_decide_reminder(
    uuid,uuid,text,text,text,text,uuid,uuid,uuid,timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_reject_reminder_audit_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_run_reminder_scheduler(text,text,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_decide_reminder(
    uuid,uuid,text,text,text,text,uuid,uuid,uuid,timestamptz
) TO dop_app;

COMMIT;
