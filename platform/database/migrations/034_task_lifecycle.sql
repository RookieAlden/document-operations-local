BEGIN;

-- M38 turns the handoff row created at Case completion into an operable,
-- tenant-bound work item. Every mutation is executed by one guarded function;
-- dop_app can read tasks but cannot write either tasks or their audit ledger
-- directly.
ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_org_id_pair UNIQUE (organization_id, id);

CREATE TABLE public.task_operator_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    task_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN (
        'claim','start','wait','resume','complete','reassign','reopen'
    )),
    previous_status text NOT NULL,
    resulting_status text NOT NULL,
    previous_assigned_actor_id uuid,
    resulting_assigned_actor_id uuid,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    event_id uuid NOT NULL,
    transitioned_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    FOREIGN KEY (organization_id, task_id)
        REFERENCES public.tasks (organization_id, id),
    FOREIGN KEY (organization_id, actor_id)
        REFERENCES public.actors (organization_id, id),
    FOREIGN KEY (organization_id, previous_assigned_actor_id)
        REFERENCES public.actors (organization_id, id),
    FOREIGN KEY (organization_id, resulting_assigned_actor_id)
        REFERENCES public.actors (organization_id, id),
    FOREIGN KEY (organization_id, event_id)
        REFERENCES public.workflow_events (organization_id, id)
);

CREATE INDEX task_operator_transitions_task_idx
    ON public.task_operator_transitions (organization_id, task_id, transitioned_at DESC, id DESC);

ALTER TABLE public.task_operator_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY dop_tenant_isolation ON public.task_operator_transitions
    FOR SELECT TO dop_app
    USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_reject_task_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'task transition audit rows are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER task_operator_transitions_immutable
BEFORE UPDATE OR DELETE ON public.task_operator_transitions
FOR EACH ROW EXECUTE FUNCTION public.dop_reject_task_transition_mutation();

CREATE OR REPLACE FUNCTION public.dop_transition_task(
    p_actor_id uuid,
    p_task_id uuid,
    p_action text,
    p_assigned_actor_id uuid,
    p_reason text,
    p_idempotency_key text,
    p_request_fingerprint text,
    p_transition_id uuid,
    p_event_id uuid,
    p_correlation_id uuid,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_current_organization_id();
    operator_row public.actors%ROWTYPE;
    task_row public.tasks%ROWTYPE;
    existing_row public.task_operator_transitions%ROWTYPE;
    target_actor_id uuid;
    resulting_status text;
    event_type_value text;
BEGIN
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO operator_row
      FROM public.actors
     WHERE organization_id = organization_id_value
       AND id = p_actor_id
       AND actor_type IN ('staff','manager','admin')
       AND status = 'active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome','not_found','resource','operator');
    END IF;

    IF p_action NOT IN ('claim','start','wait','resume','complete','reassign','reopen')
       OR length(trim(p_reason)) NOT BETWEEN 12 AND 1000
       OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
    END IF;

    -- An advisory lock keeps same-key replays deterministic even before the
    -- unique ledger row exists.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        organization_id_value::text || '|ops-task|' || p_idempotency_key, 0
    ));
    SELECT * INTO existing_row
      FROM public.task_operator_transitions
     WHERE organization_id = organization_id_value
       AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF existing_row.request_fingerprint <> p_request_fingerprint THEN
            RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
        END IF;
        RETURN jsonb_build_object(
            'outcome','duplicate','transitionId',existing_row.id,
            'eventId',existing_row.event_id,'taskId',existing_row.task_id,
            'action',existing_row.action,'taskStatus',existing_row.resulting_status,
            'assignedActorId',existing_row.resulting_assigned_actor_id,
            'transitionedAt',existing_row.transitioned_at
        );
    END IF;

    SELECT * INTO task_row
      FROM public.tasks
     WHERE organization_id = organization_id_value AND id = p_task_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome','not_found','resource','task');
    END IF;

    IF p_action IN ('reassign','reopen')
       AND operator_row.actor_type NOT IN ('manager','admin') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','manager_required');
    END IF;

    IF p_action = 'claim' THEN
        IF task_row.status <> 'open' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF task_row.assigned_actor_id IS NOT NULL THEN
            RETURN jsonb_build_object('outcome','conflict','reason','task_already_assigned');
        END IF;
        target_actor_id := p_actor_id;
        resulting_status := 'open';
        event_type_value := 'Task.Claimed';
    ELSIF p_action = 'start' THEN
        IF task_row.status <> 'open' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF task_row.assigned_actor_id IS DISTINCT FROM p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','task_not_owned');
        END IF;
        target_actor_id := task_row.assigned_actor_id;
        resulting_status := 'in_progress';
        event_type_value := 'Task.Started';
    ELSIF p_action = 'wait' THEN
        IF task_row.status <> 'in_progress' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF task_row.assigned_actor_id IS DISTINCT FROM p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','task_not_owned');
        END IF;
        target_actor_id := task_row.assigned_actor_id;
        resulting_status := 'waiting';
        event_type_value := 'Task.Waiting';
    ELSIF p_action = 'resume' THEN
        IF task_row.status <> 'waiting' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF task_row.assigned_actor_id IS DISTINCT FROM p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','task_not_owned');
        END IF;
        target_actor_id := task_row.assigned_actor_id;
        resulting_status := 'in_progress';
        event_type_value := 'Task.Resumed';
    ELSIF p_action = 'complete' THEN
        IF task_row.status <> 'in_progress' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF task_row.assigned_actor_id IS DISTINCT FROM p_actor_id THEN
            RETURN jsonb_build_object('outcome','conflict','reason','task_not_owned');
        END IF;
        target_actor_id := task_row.assigned_actor_id;
        resulting_status := 'completed';
        event_type_value := 'Task.Completed';
    ELSIF p_action = 'reassign' THEN
        IF task_row.status NOT IN ('open','waiting','in_progress') THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        IF p_assigned_actor_id IS NULL THEN
            RETURN jsonb_build_object('outcome','conflict','reason','assignee_required');
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.actors
             WHERE organization_id = organization_id_value
               AND id = p_assigned_actor_id
               AND actor_type IN ('staff','manager','admin')
               AND status = 'active'
        ) THEN
            RETURN jsonb_build_object('outcome','conflict','reason','assignee_invalid');
        END IF;
        target_actor_id := p_assigned_actor_id;
        resulting_status := 'open';
        event_type_value := 'Task.Reassigned';
    ELSE
        IF task_row.status <> 'completed' THEN
            RETURN jsonb_build_object('outcome','conflict','reason','transition_not_allowed');
        END IF;
        target_actor_id := coalesce(p_assigned_actor_id, task_row.assigned_actor_id, p_actor_id);
        IF NOT EXISTS (
            SELECT 1 FROM public.actors
             WHERE organization_id = organization_id_value
               AND id = target_actor_id
               AND actor_type IN ('staff','manager','admin')
               AND status = 'active'
        ) THEN
            RETURN jsonb_build_object('outcome','conflict','reason','assignee_invalid');
        END IF;
        resulting_status := 'open';
        event_type_value := 'Task.Reopened';
    END IF;

    UPDATE public.tasks
       SET status = resulting_status,
           assigned_actor_id = target_actor_id,
           context = context || jsonb_build_object('latestOperatorTransition',jsonb_build_object(
               'action',p_action,'actorId',p_actor_id,'reason',trim(p_reason),'at',p_now
           )),
           updated_at = p_now,
           completed_at = CASE WHEN resulting_status = 'completed' THEN p_now ELSE NULL END
     WHERE organization_id = organization_id_value AND id = p_task_id;

    INSERT INTO public.workflow_events (
        id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at
    ) VALUES (
        p_event_id,organization_id_value,'ops-task|' || p_idempotency_key,
        event_type_value,1,'task',p_task_id,p_correlation_id,p_actor_id,
        'dop.ops.task.v1',jsonb_build_object(
            'transition_id',p_transition_id,'case_id',task_row.case_id,
            'action',p_action,'previous_status',task_row.status,
            'resulting_status',resulting_status,
            'previous_assigned_actor_id',task_row.assigned_actor_id,
            'resulting_assigned_actor_id',target_actor_id,
            'reason',trim(p_reason),'external_execution','disabled'
        ),p_now
    );

    INSERT INTO public.task_operator_transitions (
        id,organization_id,task_id,actor_id,idempotency_key,request_fingerprint,
        action,previous_status,resulting_status,previous_assigned_actor_id,
        resulting_assigned_actor_id,reason,event_id,transitioned_at
    ) VALUES (
        p_transition_id,organization_id_value,p_task_id,p_actor_id,p_idempotency_key,
        p_request_fingerprint,p_action,task_row.status,resulting_status,
        task_row.assigned_actor_id,target_actor_id,trim(p_reason),p_event_id,p_now
    );

    RETURN jsonb_build_object(
        'outcome','completed','transitionId',p_transition_id,'eventId',p_event_id,
        'taskId',p_task_id,'action',p_action,'taskStatus',resulting_status,
        'assignedActorId',target_actor_id,'transitionedAt',p_now
    );
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.tasks FROM dop_app;
GRANT SELECT ON TABLE public.tasks, public.task_operator_transitions TO dop_app;
REVOKE ALL ON FUNCTION public.dop_transition_task(
    uuid,uuid,text,uuid,text,text,text,uuid,uuid,uuid,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_transition_task(
    uuid,uuid,text,uuid,text,text,text,uuid,uuid,uuid,timestamptz
) TO dop_app;
REVOKE ALL ON FUNCTION public.dop_reject_task_transition_mutation() FROM PUBLIC;

COMMIT;
