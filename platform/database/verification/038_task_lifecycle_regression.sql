BEGIN;

DO $$
DECLARE
    org public.organizations%ROWTYPE;
    manager_id uuid;
    worker_id uuid := gen_random_uuid();
    case_id_value uuid;
    task_id_value uuid := gen_random_uuid();
    run_key text := gen_random_uuid()::text;
    at_time timestamptz := date_trunc('second', clock_timestamp());
    result jsonb;
    mutation_blocked boolean := false;
BEGIN
    SELECT * INTO org FROM public.organizations
     WHERE status='active' ORDER BY created_at,id LIMIT 1;
    IF org.id IS NULL THEN RAISE EXCEPTION 'M38 requires an active organization'; END IF;
    PERFORM public.dop_set_organization_context(org.organization_key);
    SELECT id INTO manager_id FROM public.actors
     WHERE organization_id=org.id AND status='active' AND actor_type IN ('manager','admin')
     ORDER BY CASE actor_type WHEN 'admin' THEN 0 ELSE 1 END,created_at,id LIMIT 1;
    SELECT id INTO case_id_value FROM public.cases
     WHERE organization_id=org.id ORDER BY created_at,id LIMIT 1;
    IF manager_id IS NULL OR case_id_value IS NULL THEN
        RAISE EXCEPTION 'M38 requires one manager/admin and one Case';
    END IF;

    INSERT INTO public.actors(
        id,organization_id,external_subject_id,actor_type,display_name,status,attributes,created_at,updated_at
    ) VALUES (
        worker_id,org.id,'m38-worker-'||run_key,'staff','M38 Synthetic Worker','active',
        '{"synthetic":true,"verification":"M38"}'::jsonb,at_time,at_time
    );
    INSERT INTO public.tasks(
        id,organization_id,case_id,task_key,task_type,status,assigned_actor_id,context,created_at,updated_at
    ) VALUES (
        task_id_value,org.id,case_id_value,'m38-task-'||run_key,'document_operations.next_step',
        'open',NULL,'{"externalExecution":"disabled","syntheticVerification":true}'::jsonb,at_time,at_time
    );

    result := public.dop_transition_task(
        worker_id,task_id_value,'claim',NULL,
        'The synthetic worker claims the unassigned task for lifecycle verification.',
        'm38-claim-'||run_key,repeat('a',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'outcome'<>'completed' OR result->>'taskStatus'<>'open'
       OR (result->>'assignedActorId')::uuid<>worker_id THEN
        RAISE EXCEPTION 'M38 claim failed: %',result;
    END IF;
    result := public.dop_transition_task(
        worker_id,task_id_value,'claim',NULL,
        'The synthetic worker claims the unassigned task for lifecycle verification.',
        'm38-claim-'||run_key,repeat('a',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'outcome'<>'duplicate' THEN RAISE EXCEPTION 'M38 claim replay failed: %',result; END IF;
    result := public.dop_transition_task(
        manager_id,task_id_value,'claim',NULL,
        'A competing claimant must lose after the task row lock exposes the first assignment.',
        'm38-competing-claim-'||run_key,repeat('9',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'reason'<>'task_already_assigned' THEN
        RAISE EXCEPTION 'M38 competing claim boundary failed: %',result;
    END IF;
    result := public.dop_transition_task(
        worker_id,task_id_value,'start',NULL,
        'The same operation key must not be reusable for different task content.',
        'm38-claim-'||run_key,repeat('b',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'reason'<>'idempotency_key_reused' THEN RAISE EXCEPTION 'M38 replay mismatch not rejected: %',result; END IF;

    result := public.dop_transition_task(
        manager_id,task_id_value,'start',NULL,
        'A manager who does not own this task must not start it directly.',
        'm38-manager-start-'||run_key,repeat('c',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time
    );
    IF result->>'reason'<>'task_not_owned' THEN RAISE EXCEPTION 'M38 owner boundary failed: %',result; END IF;

    result := public.dop_transition_task(worker_id,task_id_value,'start',NULL,
        'The assigned synthetic worker starts the task after checking its source Case.',
        'm38-start-'||run_key,repeat('d',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '1 second');
    IF result->>'taskStatus'<>'in_progress' THEN RAISE EXCEPTION 'M38 start failed: %',result; END IF;
    result := public.dop_transition_task(worker_id,task_id_value,'wait',NULL,
        'The task waits for an internal synthetic verification condition.',
        'm38-wait-'||run_key,repeat('e',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '2 seconds');
    IF result->>'taskStatus'<>'waiting' THEN RAISE EXCEPTION 'M38 wait failed: %',result; END IF;
    result := public.dop_transition_task(worker_id,task_id_value,'resume',NULL,
        'The synthetic verification condition is met and processing resumes.',
        'm38-resume-'||run_key,repeat('f',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '3 seconds');
    IF result->>'taskStatus'<>'in_progress' THEN RAISE EXCEPTION 'M38 resume failed: %',result; END IF;
    result := public.dop_transition_task(worker_id,task_id_value,'complete',NULL,
        'The synthetic task scope is complete and the result has been checked.',
        'm38-complete-'||run_key,repeat('1',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '4 seconds');
    IF result->>'taskStatus'<>'completed' THEN RAISE EXCEPTION 'M38 complete failed: %',result; END IF;

    result := public.dop_transition_task(worker_id,task_id_value,'reopen',worker_id,
        'A staff actor must not be able to reopen a completed task.',
        'm38-staff-reopen-'||run_key,repeat('2',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '5 seconds');
    IF result->>'reason'<>'manager_required' THEN RAISE EXCEPTION 'M38 supervisor boundary failed: %',result; END IF;
    result := public.dop_transition_task(manager_id,task_id_value,'reopen',worker_id,
        'Supervisor review found more work, so the completed task is reopened.',
        'm38-reopen-'||run_key,repeat('3',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '6 seconds');
    IF result->>'taskStatus'<>'open' THEN RAISE EXCEPTION 'M38 reopen failed: %',result; END IF;
    result := public.dop_transition_task(manager_id,task_id_value,'reassign',manager_id,
        'The reopened task is reassigned to the supervising operator for final handling.',
        'm38-reassign-'||run_key,repeat('4',64),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),at_time+interval '7 seconds');
    IF result->>'taskStatus'<>'open' OR (result->>'assignedActorId')::uuid<>manager_id THEN
        RAISE EXCEPTION 'M38 reassign failed: %',result;
    END IF;

    IF (SELECT count(*) FROM public.task_operator_transitions
         WHERE organization_id=org.id AND task_id=task_id_value)<>7
       OR (SELECT count(*) FROM public.workflow_events
            WHERE organization_id=org.id AND aggregate_type='task' AND aggregate_id=task_id_value
              AND producer='dop.ops.task.v1')<>7 THEN
        RAISE EXCEPTION 'M38 immutable transition/event evidence count drifted';
    END IF;
    IF (SELECT status FROM public.tasks WHERE id=task_id_value)<>'open'
       OR (SELECT assigned_actor_id FROM public.tasks WHERE id=task_id_value)<>manager_id
       OR (SELECT completed_at FROM public.tasks WHERE id=task_id_value) IS NOT NULL THEN
        RAISE EXCEPTION 'M38 final task state is incorrect';
    END IF;

    BEGIN
        UPDATE public.task_operator_transitions SET reason='This update must be rejected by immutable audit enforcement.'
         WHERE organization_id=org.id AND task_id=task_id_value;
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        mutation_blocked := true;
    END;
    IF NOT mutation_blocked THEN RAISE EXCEPTION 'M38 audit transition update was not blocked'; END IF;

    IF has_table_privilege('dop_app','public.tasks','INSERT')
       OR has_table_privilege('dop_app','public.tasks','UPDATE')
       OR has_table_privilege('dop_app','public.tasks','DELETE')
       OR has_table_privilege('dop_app','public.task_operator_transitions','INSERT')
       OR has_table_privilege('dop_app','public.task_operator_transitions','UPDATE')
       OR has_table_privilege('dop_app','public.task_operator_transitions','DELETE')
       OR NOT has_table_privilege('dop_app','public.tasks','SELECT')
       OR NOT has_table_privilege('dop_app','public.task_operator_transitions','SELECT')
       OR NOT has_function_privilege('dop_app',
          'public.dop_transition_task(uuid,uuid,text,uuid,text,text,text,uuid,uuid,uuid,timestamptz)','EXECUTE')
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.task_operator_transitions'::regclass) THEN
        RAISE EXCEPTION 'M38 RLS or application write boundary drifted';
    END IF;
END;
$$;

SELECT jsonb_build_object(
    'verification','passed','syntheticOnly',true,
    'lifecycle',jsonb_build_array('claim','start','wait','resume','complete','reassign','reopen'),
    'ownerBoundary',true,'managerBoundary',true,'replaySafe',true,
    'immutableAudit',true,'directTaskWrites',false,'externalCalls',0,
    'persistentSideEffects',0
) AS m38_result;

ROLLBACK;
