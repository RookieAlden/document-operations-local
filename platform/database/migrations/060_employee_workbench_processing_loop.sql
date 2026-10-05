BEGIN;

-- M47 makes the handoff task a first-class business record. These fields are
-- deliberately columns (not transient JSON) so they remain queryable and
-- sortable while the existing context keeps non-business execution metadata.
ALTER TABLE public.tasks
  ADD COLUMN name text,
  ADD COLUMN instructions text,
  ADD COLUMN completion_criteria text;

UPDATE public.tasks task
   SET name = coalesce(nullif(task.context->>'name',''),
         '准备 ' || subject.display_name || ' 的下一项会计工作'),
       instructions = coalesce(nullif(task.context->>'instructions',''),
         '核对本期资料收集结果，并开始后续会计处理。'),
       completion_criteria = coalesce(nullif(task.context->>'completionCriteria',''),
         '后续会计处理所需资料已确认，工作结果已记录。')
  FROM public.cases case_row
  JOIN public.subjects subject ON subject.id=case_row.subject_id
 WHERE task.case_id=case_row.id;

ALTER TABLE public.tasks
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN name SET DEFAULT '待处理工作',
  ALTER COLUMN instructions SET NOT NULL,
  ALTER COLUMN instructions SET DEFAULT '查看关联资料和问题，并按照业务要求完成处理。',
  ALTER COLUMN completion_criteria SET NOT NULL,
  ALTER COLUMN completion_criteria SET DEFAULT '工作已完成，结果和需要跟进的事项均已记录。',
  ADD CONSTRAINT tasks_name_length CHECK (char_length(name) BETWEEN 3 AND 200),
  ADD CONSTRAINT tasks_instructions_length CHECK (char_length(instructions) BETWEEN 12 AND 2000),
  ADD CONSTRAINT tasks_completion_criteria_length CHECK (char_length(completion_criteria) BETWEEN 12 AND 2000);

CREATE INDEX tasks_workbench_sort_idx
  ON public.tasks (organization_id,status,due_at NULLS LAST,name,id);

CREATE OR REPLACE FUNCTION public.dop_complete_case_and_create_handoff(
    p_actor_id uuid,
    p_case_id uuid,
    p_assigned_actor_id uuid,
    p_reason text,
    p_idempotency_key text,
    p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    organization_id_value uuid := public.dop_current_organization_id();
    operator_type text;
    case_row public.cases%ROWTYPE;
    subject_name_value text;
    assessment_row public.case_completeness_assessments%ROWTYPE;
    existing_reservation public.idempotency_reservations%ROWTYPE;
    task_id_value uuid;
    task_type_value text;
    task_name_value text;
    assigned_actor_id_value uuid := coalesce(p_assigned_actor_id,p_actor_id);
    handoff_days integer := 5;
    due_at_value timestamptz;
    correlation_id_value uuid := gen_random_uuid();
    case_event_id_value uuid := gen_random_uuid();
BEGIN
    IF organization_id_value IS NULL THEN
        RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
    END IF;
    SELECT actor_type INTO operator_type FROM public.actors
     WHERE organization_id=organization_id_value AND id=p_actor_id
       AND actor_type IN ('staff','manager','admin') AND status='active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome','conflict','reason','manager_required');
    END IF;
    IF length(trim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','case_not_ready');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE organization_id=organization_id_value AND id=assigned_actor_id_value
           AND actor_type IN ('staff','manager','admin') AND status='active'
    ) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','assignee_invalid');
    END IF;

    SELECT * INTO case_row FROM public.cases
     WHERE organization_id=organization_id_value AND id=p_case_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','case_not_found'); END IF;
    SELECT display_name INTO subject_name_value FROM public.subjects
     WHERE organization_id=organization_id_value AND id=case_row.subject_id;
    IF operator_type='staff' AND NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
        RETURN jsonb_build_object('outcome','conflict','reason','manager_required');
    END IF;
    IF case_row.status='completed' THEN
        SELECT id INTO task_id_value FROM public.tasks
         WHERE organization_id=organization_id_value AND task_key='case-handoff|' || p_case_id::text;
        RETURN jsonb_build_object('outcome','duplicate','caseId',p_case_id,'taskId',task_id_value);
    END IF;
    IF case_row.status='cancelled' THEN RETURN jsonb_build_object('outcome','conflict','reason','case_not_ready'); END IF;

    SELECT * INTO assessment_row FROM public.case_completeness_assessments
     WHERE organization_id=organization_id_value AND case_id=p_case_id
     ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR assessment_row.status <> 'complete' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','completeness_not_complete');
    END IF;
    IF EXISTS (SELECT 1 FROM public.issues WHERE organization_id=organization_id_value AND case_id=p_case_id
       AND status IN ('open','assigned','waiting_external','waiting_internal','reopened')) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','open_issues_remaining');
    END IF;
    IF EXISTS (SELECT 1 FROM public.client_portal_question_versions WHERE organization_id=organization_id_value
       AND case_id=p_case_id AND status='published') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','open_issues_remaining');
    END IF;
    IF EXISTS (SELECT 1 FROM public.documents WHERE organization_id=organization_id_value AND case_id=p_case_id
       AND status NOT IN ('accepted','human_confirmed','archived','duplicate_skipped','excluded')) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','documents_still_processing');
    END IF;

    SELECT * INTO existing_reservation FROM public.idempotency_reservations
     WHERE organization_id=organization_id_value AND scope='case.complete' AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF FOUND THEN
        SELECT id INTO task_id_value FROM public.tasks
         WHERE organization_id=organization_id_value AND task_key='case-handoff|' || p_case_id::text;
        RETURN jsonb_build_object('outcome','duplicate','caseId',p_case_id,'taskId',task_id_value);
    END IF;

    task_id_value := gen_random_uuid();
    task_type_value := coalesce(nullif(case_row.config_snapshot #>> '{handoff,task_type}',''), 'document_operations.prepare_accounting');
    IF coalesce(case_row.config_snapshot #>> '{handoff,after_ready_business_days}','') ~ '^[0-9]{1,3}$' THEN
        handoff_days := greatest(1,least((case_row.config_snapshot #>> '{handoff,after_ready_business_days}')::integer,365));
    END IF;
    due_at_value := p_now + make_interval(days=>handoff_days);
    task_name_value := '准备 ' || subject_name_value || ' ' ||
      CASE WHEN extract(month from case_row.period_start)::integer IN (1,4,7,10)
             AND case_row.period_end=(case_row.period_start + interval '3 months - 1 day')::date
           THEN extract(year from case_row.period_start)::integer::text || '年第' ||
             (((extract(month from case_row.period_start)::integer-1)/3)+1)::text || '季度会计工作'
           ELSE to_char(case_row.period_start,'YYYY年MM月') || '会计工作' END;

    INSERT INTO public.idempotency_reservations (organization_id,scope,idempotency_key,status,attempt_count,
      resource_type,resource_id,created_at,updated_at)
    VALUES (organization_id_value,'case.complete',p_idempotency_key,'reserved',1,'case',p_case_id,p_now,p_now);
    UPDATE public.cases SET status='completed',completed_at=p_now,updated_at=p_now
     WHERE organization_id=organization_id_value AND id=p_case_id;
    INSERT INTO public.tasks (id,organization_id,case_id,task_key,task_type,name,status,assigned_actor_id,
      instructions,completion_criteria,context,due_at,created_at,updated_at)
    VALUES (task_id_value,organization_id_value,p_case_id,'case-handoff|' || p_case_id::text,task_type_value,
      task_name_value,'open',assigned_actor_id_value,
      '核对本期资料收集结果，确认银行、发票、费用和税务资料可用于后续会计处理，并记录需要跟进的事项。',
      '后续会计处理已经开始，所需资料已确认，任何需要继续跟进的事项均已记录并有明确负责人。',
      jsonb_build_object('source','case_completion','sourceAssessmentId',assessment_row.id,
        'completionReason',trim(p_reason),'externalExecution','disabled'),due_at_value,p_now,p_now);

    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (case_event_id_value,organization_id_value,'case-completed|' || p_case_id::text,'Case.Completed',1,
      'case',p_case_id,correlation_id_value,p_actor_id,'dop.workbench.case-completion.v1',
      jsonb_build_object('assessment_id',assessment_row.id,'reason',trim(p_reason),'task_id',task_id_value),p_now);
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,causation_id,actor_id,producer,payload,occurred_at)
    VALUES (gen_random_uuid(),organization_id_value,'handoff-task-created|' || p_case_id::text,'Task.Created',1,
      'task',task_id_value,correlation_id_value,case_event_id_value,p_actor_id,'dop.workbench.case-completion.v1',
      jsonb_build_object('case_id',p_case_id,'task_type',task_type_value,'task_name',task_name_value,
        'assigned_actor_id',assigned_actor_id_value,'due_at',due_at_value,'external_execution','disabled'),p_now);
    UPDATE public.idempotency_reservations SET status='completed',resource_type='case',resource_id=p_case_id,
      completed_at=p_now,updated_at=p_now WHERE organization_id=organization_id_value
      AND scope='case.complete' AND idempotency_key=p_idempotency_key;
    RETURN jsonb_build_object('outcome','completed','caseId',p_case_id,'taskId',task_id_value,
      'taskType',task_type_value,'assignedActorId',assigned_actor_id_value,'dueAt',due_at_value);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz) TO dop_app;

-- The employee route may publish a question only for a governed synthetic
-- Case and an existing actionable Issue. The original /ops manager function
-- remains unchanged; this narrower function does not grant broad manager powers.
CREATE OR REPLACE FUNCTION public.dop_workbench_publish_client_question(
  p_actor_id uuid,p_case_id uuid,p_issue_id uuid,p_public_title text,p_public_body text,
  p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_current_organization_id();
  case_row public.cases%ROWTYPE; issue_row public.issues%ROWTYPE;
  existing public.client_portal_question_versions%ROWTYPE;
  prior public.client_portal_question_versions%ROWTYPE;
  question_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); next_version integer;
BEGIN
  IF org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.actors WHERE organization_id=org_id AND id=p_actor_id
      AND actor_type IN ('staff','manager','admin') AND status='active') THEN
    RAISE EXCEPTION 'active workbench operator required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO existing FROM public.client_portal_question_versions
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','questionId',existing.id,'status',existing.status); END IF;
  IF length(btrim(p_public_title)) NOT BETWEEN 3 AND 160 OR length(btrim(p_public_body)) NOT BETWEEN 12 AND 2000
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','case_not_found'); END IF;
  IF case_row.status IN ('completed','cancelled') THEN RETURN jsonb_build_object('outcome','conflict','reason','case_not_receiving'); END IF;
  IF NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb OR NOT EXISTS(
      SELECT 1 FROM public.subjects WHERE organization_id=org_id AND id=case_row.subject_id
        AND status='active' AND attributes @> '{"synthetic":true}'::jsonb) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required'); END IF;
  SELECT * INTO issue_row FROM public.issues WHERE organization_id=org_id AND id=p_issue_id AND case_id=case_row.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','issue_not_found'); END IF;
  IF issue_row.status NOT IN ('open','assigned','waiting_external','waiting_internal','reopened') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','issue_not_actionable'); END IF;
  SELECT * INTO prior FROM public.client_portal_question_versions
   WHERE organization_id=org_id AND issue_id=issue_row.id AND status='published' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.client_portal_question_versions SET status='withdrawn',concluded_by_actor_id=p_actor_id,
      conclusion_reason='由新的客户可见问题版本取代，旧版本保留审计。',concluded_at=p_now,updated_at=p_now WHERE id=prior.id;
  END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.client_portal_question_versions
   WHERE organization_id=org_id AND issue_id=issue_row.id;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'workbench-client-question-published|'||p_idempotency_key,'ClientPortal.QuestionPublished',1,
    'client_portal_question',question_id,p_correlation_id,p_actor_id,'dop.workbench.client-question.v1',
    jsonb_build_object('caseId',case_row.id,'issueId',issue_row.id,'version',next_version,
      'requestedAction','supplement','syntheticOnly',true,'externalCallCount',0),p_now);
  INSERT INTO public.client_portal_question_versions(id,organization_id,case_id,issue_id,version,status,
    public_title,public_body,requested_action,published_by_actor_id,publish_reason,idempotency_key,event_id,
    published_at,created_at,updated_at)
  VALUES(question_id,org_id,case_row.id,issue_row.id,next_version,'published',btrim(p_public_title),
    btrim(p_public_body),'supplement',p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now,p_now,p_now);
  RETURN jsonb_build_object('outcome','completed','questionId',question_id,'status','published','eventId',event_id);
END $$;

CREATE OR REPLACE FUNCTION public.dop_workbench_resolve_client_question(
  p_actor_id uuid,p_question_id uuid,p_reason text,p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid:=public.dop_current_organization_id(); question_row public.client_portal_question_versions%ROWTYPE;
  case_row public.cases%ROWTYPE; existing public.workflow_events%ROWTYPE; event_id uuid:=gen_random_uuid();
BEGIN
  IF org_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.actors WHERE organization_id=org_id AND id=p_actor_id
      AND actor_type IN ('staff','manager','admin') AND status='active') THEN
    RAISE EXCEPTION 'active workbench operator required' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM public.workflow_events WHERE organization_id=org_id
    AND idempotency_key='workbench-client-question-resolved|'||p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','questionId',existing.aggregate_id,'status','resolved'); END IF;
  IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO question_row FROM public.client_portal_question_versions WHERE organization_id=org_id AND id=p_question_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','question_not_found'); END IF;
  SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=question_row.case_id;
  IF NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required'); END IF;
  IF question_row.status<>'published' THEN RETURN jsonb_build_object('outcome','conflict','reason','question_not_published'); END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,
    aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'workbench-client-question-resolved|'||p_idempotency_key,'ClientPortal.QuestionResolved',1,
    'client_portal_question',question_row.id,p_correlation_id,p_actor_id,'dop.workbench.client-question.v1',
    jsonb_build_object('caseId',question_row.case_id,'issueId',question_row.issue_id,'externalCallCount',0),p_now);
  UPDATE public.client_portal_question_versions SET status='resolved',concluded_by_actor_id=p_actor_id,
    conclusion_reason=btrim(p_reason),concluded_at=p_now,updated_at=p_now WHERE id=question_row.id;
  UPDATE public.issues SET status='resolved',resolved_at=p_now,closed_at=NULL,
    details=details || jsonb_build_object('workbenchClientQuestionResolution',jsonb_build_object(
      'questionId',question_row.id,'actorId',p_actor_id,'resolvedAt',p_now))
   WHERE organization_id=org_id AND id=question_row.issue_id
     AND status IN ('open','assigned','waiting_external','waiting_internal','reopened');
  RETURN jsonb_build_object('outcome','completed','questionId',question_row.id,'status','resolved','eventId',event_id);
END $$;

REVOKE ALL ON FUNCTION public.dop_workbench_publish_client_question(uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_workbench_resolve_client_question(uuid,uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_workbench_publish_client_question(uuid,uuid,uuid,text,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_workbench_resolve_client_question(uuid,uuid,text,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
