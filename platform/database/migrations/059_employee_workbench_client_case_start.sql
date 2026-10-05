BEGIN;

CREATE TABLE public.workbench_client_case_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    actor_id uuid NOT NULL REFERENCES public.actors(id),
    idempotency_key uuid NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('processing','completed')),
    subject_id uuid REFERENCES public.subjects(id),
    configuration_release_id uuid REFERENCES public.work_configuration_releases(id),
    case_id uuid REFERENCES public.cases(id),
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    UNIQUE (organization_id, id),
    UNIQUE (organization_id, idempotency_key),
    CHECK ((status = 'completed' AND subject_id IS NOT NULL
        AND configuration_release_id IS NOT NULL AND case_id IS NOT NULL
        AND completed_at IS NOT NULL) OR status = 'processing')
);

ALTER TABLE public.workbench_client_case_commands
    ADD CONSTRAINT workbench_command_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id) REFERENCES public.actors(organization_id, id),
    ADD CONSTRAINT workbench_command_subject_same_org_fk
        FOREIGN KEY (organization_id, subject_id) REFERENCES public.subjects(organization_id, id),
    ADD CONSTRAINT workbench_command_release_same_org_fk
        FOREIGN KEY (organization_id, configuration_release_id)
        REFERENCES public.work_configuration_releases(organization_id, id),
    ADD CONSTRAINT workbench_command_case_same_org_fk
        FOREIGN KEY (organization_id, case_id) REFERENCES public.cases(organization_id, id);

CREATE INDEX workbench_client_case_commands_actor_idx
    ON public.workbench_client_case_commands (organization_id, actor_id, created_at DESC);

ALTER TABLE public.workbench_client_case_commands ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.workbench_client_case_commands TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.workbench_client_case_commands
    FOR SELECT TO dop_app USING (organization_id = public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_require_active_workbench_employee(p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_current_organization_id();
BEGIN
    IF v_organization_id IS NULL THEN
        RAISE EXCEPTION 'organization_context_required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.actors
         WHERE id = p_actor_id AND organization_id = v_organization_id
           AND actor_type IN ('staff','manager','admin') AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'workbench_employee_required' USING ERRCODE = '42501';
    END IF;
    RETURN v_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_workbench_client_case(
    p_actor_id uuid,
    p_package_version_id uuid,
    p_display_name text,
    p_contact_name text,
    p_period_start date,
    p_period_end date,
    p_requirements jsonb,
    p_idempotency_key uuid,
    p_correlation_id uuid,
    p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_organization_id uuid := public.dop_require_active_workbench_employee(p_actor_id);
    organization_row public.organizations%ROWTYPE;
    package_version public.work_configuration_package_versions%ROWTYPE;
    package_row public.work_configuration_packages%ROWTYPE;
    workflow_template public.workflow_templates%ROWTYPE;
    prompt_version_id uuid;
    workflow_version_id uuid;
    command_row public.workbench_client_case_commands%ROWTYPE;
    normalized_name text := btrim(coalesce(p_display_name, ''));
    normalized_contact text := nullif(btrim(coalesce(p_contact_name, '')), '');
    frequency text;
    period_key text;
    subject_key text := 'client-' || left(replace(p_idempotency_key::text, '-', ''), 12);
    v_contact_actor_id uuid;
    v_subject_id uuid := gen_random_uuid();
    requirement_set_id uuid := gen_random_uuid();
    requirement_version_id uuid := gen_random_uuid();
    v_release_id uuid := gen_random_uuid();
    series_id uuid := gen_random_uuid();
    v_case_id uuid := gen_random_uuid();
    subject_event_id uuid := gen_random_uuid();
    configuration_event_id uuid := gen_random_uuid();
    case_event_id uuid := gen_random_uuid();
    command_event_id uuid := gen_random_uuid();
    manifest jsonb;
    selected_requirements jsonb;
    subject_attributes jsonb;
    v_definition_hash text;
    v_requirement_hash text;
    request_fingerprint text;
    validation_error text;
    due_at timestamptz;
    case_key text;
    requested_count integer;
    matched_count integer;
    requirement jsonb;
BEGIN
    request_fingerprint := encode(digest(concat_ws('|', p_package_version_id::text,
        normalized_name, coalesce(normalized_contact, ''), p_period_start::text,
        p_period_end::text, coalesce(p_requirements, 'null'::jsonb)::text), 'sha256'), 'hex');

    SELECT * INTO command_row
      FROM public.workbench_client_case_commands
     WHERE organization_id = v_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF command_row.request_fingerprint <> request_fingerprint THEN
            RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
        END IF;
        IF command_row.status = 'completed' THEN
            RETURN jsonb_build_object('outcome','duplicate','commandId',command_row.id,
                'subjectId',command_row.subject_id,'releaseId',command_row.configuration_release_id,
                'caseId',command_row.case_id);
        END IF;
        RETURN jsonb_build_object('outcome','conflict','reason','operation_in_progress','commandId',command_row.id);
    END IF;

    SELECT * INTO organization_row FROM public.organizations
     WHERE id = v_organization_id AND status = 'active' FOR UPDATE;
    IF NOT FOUND OR organization_row.settings->>'data_classification' <> 'synthetic_only' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_uat_required');
    END IF;
    IF char_length(normalized_name) NOT BETWEEN 2 AND 160
       OR (normalized_contact IS NOT NULL AND char_length(normalized_contact) NOT BETWEEN 2 AND 120)
       OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start
       OR jsonb_typeof(p_requirements) <> 'array'
       OR jsonb_array_length(p_requirements) NOT BETWEEN 1 AND 100 THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;

    SELECT version.* INTO package_version
      FROM public.work_configuration_package_versions version
      JOIN public.work_configuration_packages package
        ON package.organization_id = version.organization_id AND package.id = version.package_id
     WHERE version.organization_id = v_organization_id
       AND version.id = p_package_version_id
       AND version.status = 'published' AND package.status = 'active'
       AND package.current_published_version_id = version.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','service_template_not_found'); END IF;
    SELECT * INTO package_row FROM public.work_configuration_packages
     WHERE organization_id = v_organization_id AND id = package_version.package_id;
    IF package_version.blueprint#>'{subjectDefaults,attributes,synthetic}' <> 'true'::jsonb THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_template_required');
    END IF;
    frequency := package_version.blueprint#>>'{workflow,frequency}';
    IF frequency = 'monthly' THEN
        IF extract(day FROM p_period_start) <> 1
           OR p_period_end <> (p_period_start + interval '1 month - 1 day')::date THEN
            RETURN jsonb_build_object('outcome','conflict','reason','monthly_period_invalid');
        END IF;
        period_key := to_char(p_period_start, 'YYYY-MM');
        due_at := ((p_period_end + 10)::date + time '17:00') AT TIME ZONE organization_row.default_timezone;
    ELSIF frequency = 'quarterly' THEN
        IF extract(day FROM p_period_start) <> 1
           OR extract(month FROM p_period_start)::integer NOT IN (1,4,7,10)
           OR p_period_end <> (p_period_start + interval '3 months - 1 day')::date THEN
            RETURN jsonb_build_object('outcome','conflict','reason','quarterly_period_invalid');
        END IF;
        period_key := extract(year FROM p_period_start)::integer::text || '-Q'
            || (((extract(month FROM p_period_start)::integer - 1) / 3) + 1)::integer::text;
        due_at := ((p_period_end + 15)::date + time '17:00') AT TIME ZONE organization_row.default_timezone;
    ELSE
        RETURN jsonb_build_object('outcome','conflict','reason','service_cycle_not_supported');
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_requirements) item
         WHERE jsonb_typeof(item) <> 'object'
            OR char_length(btrim(coalesce(item->>'code',''))) NOT BETWEEN 2 AND 120
            OR jsonb_typeof(item->'minimumCount') <> 'number'
            OR (item->>'minimumCount')::numeric <> trunc((item->>'minimumCount')::numeric)
            OR (item->>'minimumCount')::integer NOT BETWEEN 1 AND 100
            OR (item ? 'maximumCount' AND item->'maximumCount' <> 'null'::jsonb
                AND (jsonb_typeof(item->'maximumCount') <> 'number'
                  OR (item->>'maximumCount')::numeric <> trunc((item->>'maximumCount')::numeric)
                  OR (item->>'maximumCount')::integer < (item->>'minimumCount')::integer))
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_requirements) item
         GROUP BY lower(btrim(item->>'code')) HAVING count(*) > 1
    ) THEN
        RETURN jsonb_build_object('outcome','conflict','reason','requirements_invalid');
    END IF;

    requested_count := jsonb_array_length(p_requirements);
    SELECT count(*)::integer INTO matched_count
      FROM jsonb_array_elements(package_version.blueprint->'requirements') base
      JOIN jsonb_array_elements(p_requirements) requested
        ON lower(btrim(requested->>'code')) = lower(btrim(base->>'code'));
    IF matched_count <> requested_count THEN
        RETURN jsonb_build_object('outcome','conflict','reason','requirement_not_in_template');
    END IF;

    SELECT jsonb_agg(
        (base - 'minimumCount' - 'maximumCount') || jsonb_build_object(
            'minimumCount',(requested->>'minimumCount')::integer,
            'maximumCount',CASE WHEN requested->'maximumCount' IS NULL OR requested->'maximumCount' = 'null'::jsonb
                THEN NULL ELSE (requested->>'maximumCount')::integer END
        ) ORDER BY base->>'code'
    ) INTO selected_requirements
      FROM jsonb_array_elements(package_version.blueprint->'requirements') base
      JOIN jsonb_array_elements(p_requirements) requested
        ON lower(btrim(requested->>'code')) = lower(btrim(base->>'code'));

    subject_attributes := coalesce(package_version.blueprint#>'{subjectDefaults,attributes}','{}'::jsonb)
        || jsonb_build_object('synthetic',true,'frequency',frequency,'workbench_created',true,
            'onboarding_package_key',package_row.package_key,'onboarding_package_version',package_version.version);
    manifest := jsonb_build_object(
        'subject',jsonb_build_object('displayName',normalized_name,'subjectType','accounting_client',
            'status','active','primaryContactActorId',v_contact_actor_id,'attributes',subject_attributes),
        'workflow',package_version.blueprint->'workflow',
        'requirements',selected_requirements
    );
    validation_error := public.dop_configuration_manifest_error(v_organization_id, manifest);
    IF validation_error IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason',validation_error);
    END IF;

    SELECT * INTO workflow_template FROM public.workflow_templates
     WHERE organization_id = v_organization_id AND id = package_version.workflow_template_id AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','workflow_template_not_active'); END IF;
    SELECT id INTO workflow_version_id FROM public.workflow_template_versions
     WHERE organization_id = v_organization_id AND workflow_template_id = workflow_template.id
       AND status = 'published'
       AND definition_hash = encode(digest((package_version.blueprint->'workflow')::text,'sha256'),'hex')
     ORDER BY version DESC LIMIT 1;
    IF workflow_version_id IS NULL THEN
        RETURN jsonb_build_object('outcome','conflict','reason','published_workflow_not_found');
    END IF;
    SELECT id INTO prompt_version_id FROM public.prompt_versions
     WHERE organization_id = v_organization_id AND prompt_key = 'document-classifier' AND status = 'published'
     ORDER BY version DESC LIMIT 1;
    IF prompt_version_id IS NULL THEN RETURN jsonb_build_object('outcome','conflict','reason','published_prompt_not_found'); END IF;

    INSERT INTO public.workbench_client_case_commands(
        organization_id,actor_id,idempotency_key,request_fingerprint,status,created_at
    ) VALUES(v_organization_id,p_actor_id,p_idempotency_key,request_fingerprint,'processing',p_now)
    RETURNING * INTO command_row;

    IF normalized_contact IS NOT NULL THEN
        v_contact_actor_id := gen_random_uuid();
        INSERT INTO public.actors(id,organization_id,external_subject_id,actor_type,display_name,status,attributes,created_at,updated_at)
        VALUES(v_contact_actor_id,v_organization_id,'workbench-contact-'||left(replace(p_idempotency_key::text,'-',''),16),
            'customer',normalized_contact,'active','{"synthetic":true,"external_messages":"disabled"}'::jsonb,p_now,p_now);
        manifest := jsonb_set(manifest,'{subject,primaryContactActorId}',to_jsonb(v_contact_actor_id::text),true);
    END IF;
    v_definition_hash := encode(digest(manifest::text,'sha256'),'hex');
    v_requirement_hash := encode(digest(selected_requirements::text,'sha256'),'hex');

    INSERT INTO public.subjects(id,organization_id,subject_key,subject_type,display_name,status,
        primary_contact_actor_id,attributes,created_at,updated_at)
    VALUES(v_subject_id,v_organization_id,subject_key,'accounting_client',normalized_name,'active',
        v_contact_actor_id,subject_attributes,p_now,p_now);
    INSERT INTO public.requirement_sets(id,organization_id,set_key,display_name,created_at,updated_at)
    VALUES(requirement_set_id,v_organization_id,'subject.'||subject_key||'.requirements',
        normalized_name||' requirements',p_now,p_now);
    INSERT INTO public.requirement_set_versions(id,organization_id,requirement_set_id,version,status,
        effective_from,definition_hash,created_at)
    VALUES(requirement_version_id,v_organization_id,requirement_set_id,1,'published',p_now,v_requirement_hash,p_now);
    FOR requirement IN SELECT value FROM jsonb_array_elements(selected_requirements) LOOP
        INSERT INTO public.requirements(id,organization_id,requirement_set_version_id,requirement_code,
            document_type_id,minimum_count,maximum_count,acceptance_rule,created_at)
        SELECT gen_random_uuid(),v_organization_id,requirement_version_id,requirement->>'code',type.id,
            (requirement->>'minimumCount')::integer,
            CASE WHEN requirement->'maximumCount' IS NULL OR requirement->'maximumCount'='null'::jsonb
                THEN NULL ELSE (requirement->>'maximumCount')::integer END,
            coalesce(requirement->'acceptanceRule','{}'::jsonb),p_now
          FROM public.document_types type
         WHERE type.organization_id=v_organization_id AND type.code=requirement->>'documentTypeCode' AND type.status='active';
    END LOOP;

    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(subject_event_id,v_organization_id,'workbench-subject|'||p_idempotency_key,'Subject.Onboarded',1,
        'subject',v_subject_id,p_correlation_id,p_actor_id,'employee-workbench',jsonb_build_object(
            'package_key',package_row.package_key,'configuration_status','published','external_delivery','not_sent'),p_now);
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(configuration_event_id,v_organization_id,'workbench-configuration|'||p_idempotency_key,
        'Configuration.Published',1,'work_configuration',v_release_id,p_correlation_id,p_actor_id,
        'employee-workbench',jsonb_build_object('release_number',1,'revision',1,'status','published',
            'definition_hash',v_definition_hash,'single_employee_action',true),p_now);
    INSERT INTO public.work_configuration_releases(id,organization_id,series_id,release_number,revision,
        subject_id,workflow_template_id,requirement_set_id,status,manifest,definition_hash,
        produced_workflow_template_version_id,produced_requirement_set_version_id,created_by_actor_id,
        reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES(v_release_id,v_organization_id,series_id,1,1,v_subject_id,workflow_template.id,requirement_set_id,
        'published',manifest,v_definition_hash,workflow_version_id,requirement_version_id,p_actor_id,
        'Employee created and published the client configuration in one governed action.',
        'workbench-configuration|'||p_idempotency_key,request_fingerprint,configuration_event_id,p_now);
    INSERT INTO public.subject_onboardings(id,organization_id,subject_id,package_version_id,
        configuration_release_id,created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
    VALUES(gen_random_uuid(),v_organization_id,v_subject_id,p_package_version_id,v_release_id,p_actor_id,
        'Employee created the synthetic client through the guided workbench.',
        'workbench-onboarding|'||p_idempotency_key,request_fingerprint,subject_event_id,p_now);

    case_key := organization_row.organization_key||'|'||workflow_template.template_key||'|'||subject_key||'|'||period_key;
    INSERT INTO public.cases(id,organization_id,case_key,subject_id,workflow_template_version_id,
        requirement_set_version_id,prompt_version_id,external_reference,period_start,period_end,timezone,
        status,risk_status,due_at,config_snapshot,version,created_at,updated_at)
    VALUES(v_case_id,v_organization_id,case_key,v_subject_id,workflow_version_id,requirement_version_id,
        prompt_version_id,'M46-WB-'||left(replace(p_idempotency_key::text,'-',''),12),p_period_start,p_period_end,
        organization_row.default_timezone,'waiting_for_documents','normal',due_at,jsonb_build_object(
            'source','employee_workbench','configuration_release_id',v_release_id,
            'configuration_release_number',1,'configuration_definition_hash',v_definition_hash,
            'manifest',manifest,'synthetic_only',true,'external_messages_require_approval',true),1,p_now,p_now);
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(case_event_id,v_organization_id,'workbench-case|'||p_idempotency_key,'Case.CreatedFromConfiguration',1,
        'case',v_case_id,p_correlation_id,p_actor_id,'employee-workbench',jsonb_build_object(
            'configuration_release_id',v_release_id,'request_fingerprint',request_fingerprint,
            'period_key',period_key,'period_start',p_period_start,'period_end',p_period_end,
            'due_at',due_at,'synthetic_only',true,
            'synthetic_boundary_source','workbench_locked_synthetic_package'),p_now);
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
        aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(command_event_id,v_organization_id,'workbench-command|'||p_idempotency_key,
        'Workbench.ClientCaseCreated',1,'case',v_case_id,p_correlation_id,p_actor_id,'employee-workbench',
        jsonb_build_object('command_id',command_row.id,'subject_id',v_subject_id,'release_id',v_release_id,
            'case_id',v_case_id,'single_employee_action',true,'external_calls',0),p_now);
    UPDATE public.workbench_client_case_commands command
       SET status='completed',subject_id=v_subject_id,
           configuration_release_id=v_release_id,case_id=v_case_id,completed_at=p_now
     WHERE command.id=command_row.id;

    RETURN jsonb_build_object('outcome','completed','commandId',command_row.id,'subjectId',v_subject_id,
        'releaseId',v_release_id,'caseId',v_case_id,'caseKey',case_key,'periodKey',period_key,
        'dueAt',due_at,'syntheticOnly',true,'externalCalls',0);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_workbench_issue_case_invitation(
    p_actor_id uuid,p_case_id uuid,p_invitation_token_sha256 text,
    p_maximum_submissions integer,p_valid_until timestamptz,p_idempotency_key uuid,
    p_correlation_id uuid,p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
    org_id uuid:=public.dop_require_active_workbench_employee(p_actor_id);
    entry_row public.demo_form_entry_versions%ROWTYPE;
    case_row public.cases%ROWTYPE;
    subject_row public.subjects%ROWTYPE;
    existing public.demo_case_invitations%ROWTYPE;
    invitation_id uuid:=gen_random_uuid();
    event_id uuid:=gen_random_uuid();
    connector_version_id uuid;
    connector_definition_hash text;
    previous_connector_version_id uuid;
    period_key text;
BEGIN
    SELECT * INTO existing FROM public.demo_case_invitations
     WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','invitationId',existing.id,
        'caseId',existing.case_id,'status',existing.status,'validUntil',existing.valid_until); END IF;
    IF p_invitation_token_sha256 !~ '^[0-9a-f]{64}$'
       OR p_maximum_submissions NOT BETWEEN 2 AND 20
       OR p_valid_until<=p_now OR p_valid_until>p_now+interval '30 days' THEN
        RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
    END IF;
    SELECT * INTO entry_row FROM public.demo_form_entry_versions
     WHERE organization_id=org_id AND status='active' ORDER BY created_at DESC LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','active_entry_required'); END IF;
    SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id
      AND status IN ('not_started','waiting_for_documents','review_required','ready','in_progress') FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','case_not_receiving'); END IF;
    SELECT * INTO subject_row FROM public.subjects WHERE organization_id=org_id AND id=case_row.subject_id AND status='active';
    IF NOT FOUND OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb
       OR NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
        RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required');
    END IF;
    period_key:=regexp_replace(case_row.case_key,'^.*\|','');
    SELECT version.id,version.definition_hash INTO connector_version_id,connector_definition_hash
      FROM public.source_connector_versions version
      JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
     WHERE version.organization_id=org_id AND version.id=case_row.source_connector_version_id
       AND connector.connector_key=entry_row.connector_key AND connector.lifecycle_status='active'
       AND connector.active_version_id=version.id AND version.status='active';
    IF connector_version_id IS NULL THEN
        IF EXISTS(SELECT 1 FROM public.submissions WHERE organization_id=org_id AND case_id=case_row.id) THEN
            RETURN jsonb_build_object('outcome','conflict','reason','case_connector_mismatch'); END IF;
        previous_connector_version_id:=case_row.source_connector_version_id;
        SELECT version.id,version.definition_hash INTO connector_version_id,connector_definition_hash
          FROM public.source_connector_versions version
          JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
         WHERE version.organization_id=org_id AND connector.connector_key=entry_row.connector_key
           AND connector.lifecycle_status='active' AND connector.active_version_id=version.id AND version.status='active';
        IF connector_version_id IS NULL THEN
            RETURN jsonb_build_object('outcome','conflict','reason','active_uat_form_connector_required'); END IF;
        UPDATE public.cases SET source_connector_version_id=connector_version_id,
          source_connector_definition_hash=connector_definition_hash,
          config_snapshot=jsonb_set(config_snapshot,'{sourceBinding}',jsonb_build_object(
            'bindingKey',entry_row.connector_key,'connectorVersionId',connector_version_id,
            'definitionHash',connector_definition_hash,'mode','governed_synthetic_demo'),true),
          version=version+1,updated_at=p_now WHERE organization_id=org_id AND id=case_row.id;
    END IF;
    IF EXISTS(SELECT 1 FROM public.demo_case_invitations WHERE organization_id=org_id
        AND entry_version_id=entry_row.id AND case_id=case_row.id AND status='active') THEN
        RETURN jsonb_build_object('outcome','conflict','reason','active_invitation_already_exists'); END IF;
    INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES(event_id,org_id,'workbench-invitation|'||p_idempotency_key,'DemoForm.InvitationIssued',1,
      'case',case_row.id,p_correlation_id,p_actor_id,'employee-workbench',jsonb_build_object(
        'invitationId',invitation_id,'entryVersionId',entry_row.id,'periodKey',period_key,
        'syntheticOnly',true,'allowInitialSubmission',true,'allowSupplement',true,
        'maximumSubmissions',p_maximum_submissions,'validUntil',p_valid_until,
        'sourceConnectorVersionId',connector_version_id,'previousSourceConnectorVersionId',previous_connector_version_id),p_now);
    INSERT INTO public.demo_case_invitations(id,organization_id,entry_version_id,subject_id,case_id,
      invitation_token_sha256,period_key,status,synthetic_only,allow_initial_submission,allow_supplement,
      maximum_submissions,valid_from,valid_until,created_by_actor_id,reason,idempotency_key,event_id,created_at,updated_at)
    VALUES(invitation_id,org_id,entry_row.id,case_row.subject_id,case_row.id,p_invitation_token_sha256,
      period_key,'active',true,true,true,p_maximum_submissions,p_now,p_valid_until,p_actor_id,
      'Employee generated the governed synthetic client submission link.',p_idempotency_key,event_id,p_now,p_now);
    RETURN jsonb_build_object('outcome','completed','invitationId',invitation_id,'caseId',case_row.id,
      'status','active','validUntil',p_valid_until,'eventId',event_id,'providerFormId',entry_row.provider_form_id);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_require_active_workbench_employee(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_workbench_client_case(uuid,uuid,text,text,date,date,jsonb,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_workbench_issue_case_invitation(uuid,uuid,text,integer,timestamptz,uuid,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_workbench_client_case(uuid,uuid,text,text,date,date,jsonb,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_workbench_issue_case_invitation(uuid,uuid,text,integer,timestamptz,uuid,uuid,timestamptz) TO dop_app;

COMMIT;
