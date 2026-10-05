BEGIN;

-- M20 creates a provider-neutral registry for governed intake sources. A
-- registry activation only makes a binding eligible for future configuration;
-- runtime execution and all external delivery remain disabled in this phase.
CREATE TABLE public.source_connectors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    connector_key text NOT NULL CHECK (connector_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 160),
    description text NOT NULL CHECK (char_length(description) BETWEEN 12 AND 1000),
    lifecycle_status text NOT NULL DEFAULT 'registered'
        CHECK (lifecycle_status IN ('registered','active','suspended','revoked')),
    current_version_id uuid,
    active_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id,id),
    UNIQUE (organization_id,connector_key)
);

CREATE TABLE public.source_connector_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    connector_id uuid NOT NULL REFERENCES public.source_connectors(id),
    version integer NOT NULL CHECK (version > 0),
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('draft','in_review','approved','active','suspended','revoked')),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    created_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text,
    request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid,
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    UNIQUE (connector_id,version,revision),
    CONSTRAINT source_connector_version_connector_same_org_fk
        FOREIGN KEY (organization_id,connector_id) REFERENCES public.source_connectors(organization_id,id),
    CONSTRAINT source_connector_version_actor_same_org_fk
        FOREIGN KEY (organization_id,created_by_actor_id) REFERENCES public.actors(organization_id,id),
    CONSTRAINT source_connector_version_event_same_org_fk
        FOREIGN KEY (organization_id,event_id) REFERENCES public.workflow_events(organization_id,id)
);
CREATE UNIQUE INDEX source_connector_version_idempotency_key
    ON public.source_connector_versions (organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX source_connector_version_history_idx
    ON public.source_connector_versions (organization_id,connector_id,version DESC,revision DESC);

CREATE TABLE public.source_connector_test_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    connector_id uuid NOT NULL REFERENCES public.source_connectors(id),
    connector_version_id uuid NOT NULL REFERENCES public.source_connector_versions(id),
    definition_hash text NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('passed','failed')),
    result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
    run_by_actor_id uuid REFERENCES public.actors(id),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 12 AND 1000),
    idempotency_key text,
    request_fingerprint text CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'),
    event_id uuid,
    created_at timestamptz NOT NULL,
    UNIQUE (organization_id,id),
    CONSTRAINT source_connector_test_connector_same_org_fk
        FOREIGN KEY (organization_id,connector_id) REFERENCES public.source_connectors(organization_id,id),
    CONSTRAINT source_connector_test_version_same_org_fk
        FOREIGN KEY (organization_id,connector_version_id) REFERENCES public.source_connector_versions(organization_id,id),
    CONSTRAINT source_connector_test_actor_same_org_fk
        FOREIGN KEY (organization_id,run_by_actor_id) REFERENCES public.actors(organization_id,id),
    CONSTRAINT source_connector_test_event_same_org_fk
        FOREIGN KEY (organization_id,event_id) REFERENCES public.workflow_events(organization_id,id)
);
CREATE UNIQUE INDEX source_connector_test_idempotency_key
    ON public.source_connector_test_runs (organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX source_connector_test_history_idx
    ON public.source_connector_test_runs (organization_id,connector_id,created_at DESC);

ALTER TABLE public.source_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_connector_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_connector_test_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.source_connectors,public.source_connector_versions,public.source_connector_test_runs TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.source_connectors
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.source_connector_versions
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.source_connector_test_runs
    FOR SELECT TO dop_app USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_source_connector_definition_error(p_definition jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fixture jsonb; capability jsonb; mime jsonb; credential_mode text; connector_type text;
BEGIN
    IF jsonb_typeof(p_definition)<>'object'
       OR p_definition->>'schemaVersion'<>'1.0'
       OR p_definition->>'environment'<>'DEV'
       OR coalesce(p_definition->>'connectorKey','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
       OR p_definition->>'connectorType' NOT IN ('manual_upload','form','email','sharepoint','api','sftp','object_storage')
       OR p_definition->>'transport' NOT IN ('operator','push','pull')
       OR jsonb_typeof(p_definition->'capabilities')<>'array'
       OR jsonb_array_length(p_definition->'capabilities') NOT BETWEEN 1 AND 5
       OR jsonb_typeof(p_definition->'credentialReference')<>'object'
       OR jsonb_typeof(p_definition->'dataBoundary')<>'object'
       OR jsonb_typeof(p_definition->'activationPolicy')<>'object'
       OR jsonb_typeof(p_definition->'testFixtures')<>'array'
       OR jsonb_array_length(p_definition->'testFixtures') NOT BETWEEN 1 AND 10 THEN
        RETURN 'source_connector_definition_invalid';
    END IF;
    connector_type:=p_definition->>'connectorType';
    IF (connector_type='manual_upload' AND p_definition->>'transport'<>'operator')
       OR (connector_type<>'manual_upload' AND p_definition->>'transport'='operator') THEN
        RETURN 'source_connector_transport_invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_definition->'capabilities') value
                WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN ('documents','metadata','attachments','webhook','polling'))
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_definition->'capabilities') value GROUP BY value HAVING count(*)>1) THEN
        RETURN 'source_connector_capabilities_invalid';
    END IF;
    credential_mode:=p_definition#>>'{credentialReference,mode}';
    IF credential_mode NOT IN ('none','secret_reference')
       OR p_definition#>>'{credentialReference,provider}' NOT IN ('none','railway','supabase','external_vault') THEN
        RETURN 'source_connector_credential_reference_invalid';
    END IF;
    IF credential_mode='none' AND ((p_definition#>>'{credentialReference,provider}')<>'none'
       OR p_definition#>'{credentialReference,reference}' IS DISTINCT FROM 'null'::jsonb) THEN
        RETURN 'source_connector_credential_reference_invalid';
    END IF;
    IF credential_mode='secret_reference' AND (
       p_definition#>>'{credentialReference,provider}'='none'
       OR coalesce(p_definition#>>'{credentialReference,reference}','') !~ '^[a-z][a-z0-9+.-]*://[A-Za-z0-9._/-]{3,240}$'
    ) THEN RETURN 'source_connector_credential_reference_invalid'; END IF;
    IF connector_type<>'manual_upload' AND credential_mode<>'secret_reference' THEN
        RETURN 'source_connector_credential_reference_required';
    END IF;
    IF coalesce((p_definition#>>'{dataBoundary,syntheticOnly}')::boolean,false) IS NOT TRUE
       OR p_definition#>>'{dataBoundary,externalDelivery}'<>'disabled'
       OR (p_definition#>>'{dataBoundary,maxFileBytes}')::bigint NOT BETWEEN 1 AND 104857600
       OR jsonb_typeof(p_definition#>'{dataBoundary,allowedMimeTypes}')<>'array'
       OR jsonb_array_length(p_definition#>'{dataBoundary,allowedMimeTypes}') NOT BETWEEN 1 AND 20
       OR coalesce((p_definition#>>'{activationPolicy,explicitApprovalRequired}')::boolean,false) IS NOT TRUE
       OR coalesce((p_definition#>>'{activationPolicy,emergencySuspendEnabled}')::boolean,false) IS NOT TRUE
       OR p_definition#>>'{activationPolicy,runtimeExecution}'<>'disabled' THEN
        RETURN 'source_connector_safety_boundary_invalid';
    END IF;
    FOR mime IN SELECT value FROM jsonb_array_elements(p_definition#>'{dataBoundary,allowedMimeTypes}') LOOP
        IF jsonb_typeof(mime)<>'string' OR mime#>>'{}' !~ '^[a-z0-9.+-]+/[a-z0-9.+*-]+$' THEN
            RETURN 'source_connector_mime_type_invalid';
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_definition->'testFixtures') item
               GROUP BY item->>'fixtureKey' HAVING count(*)>1) THEN RETURN 'source_connector_duplicate_fixture'; END IF;
    FOR fixture IN SELECT value FROM jsonb_array_elements(p_definition->'testFixtures') LOOP
        IF coalesce(fixture->>'fixtureKey','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
           OR char_length(btrim(coalesce(fixture->>'displayName',''))) NOT BETWEEN 2 AND 160
           OR coalesce((fixture->>'synthetic')::boolean,false) IS NOT TRUE
           OR char_length(btrim(coalesce(fixture->>'filename',''))) NOT BETWEEN 3 AND 255
           OR coalesce(fixture->>'mimeType','') !~ '^[a-z0-9.+-]+/[a-z0-9.+*-]+$'
           OR char_length(btrim(coalesce(fixture->>'payloadSummary',''))) NOT BETWEEN 20 AND 1000 THEN
            RETURN 'source_connector_fixture_invalid';
        END IF;
    END LOOP;
    RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'source_connector_definition_invalid';
END;
$$;

-- Preserve the existing Case Plan binding as a governed, internally operated
-- baseline. It performs no external call and stores no credential.
DO $$
DECLARE org record; binding_key text; connector_id uuid; version_id uuid; definition jsonb; fixture jsonb;
BEGIN
  FOR org IN SELECT id FROM public.organizations LOOP
    FOR binding_key IN
      SELECT DISTINCT plan.definition#>>'{sourceBinding,bindingKey}'
        FROM public.case_plan_versions plan
       WHERE plan.organization_id=org.id AND plan.definition#>>'{sourceBinding,bindingKey}' IS NOT NULL
    LOOP
      connector_id:=gen_random_uuid(); version_id:=gen_random_uuid();
      fixture:=jsonb_build_object('fixtureKey','baseline.synthetic','displayName','基线纯虚构上传样例','synthetic',true,
        'filename','synthetic-source-document.pdf','mimeType','application/pdf',
        'payloadSummary','Purely synthetic DEV fixture used only to validate the connector contract without network access.');
      definition:=jsonb_build_object('schemaVersion','1.0','environment','DEV','connectorKey',binding_key,
        'connectorType','manual_upload','transport','operator','capabilities',jsonb_build_array('documents','metadata'),
        'credentialReference',jsonb_build_object('mode','none','provider','none','reference',NULL),
        'dataBoundary',jsonb_build_object('syntheticOnly',true,'externalDelivery','disabled','maxFileBytes',26214400,
          'allowedMimeTypes',jsonb_build_array('application/pdf','image/jpeg','image/png','text/plain')),
        'activationPolicy',jsonb_build_object('explicitApprovalRequired',true,'emergencySuspendEnabled',true,'runtimeExecution','disabled'),
        'testFixtures',jsonb_build_array(fixture));
      INSERT INTO public.source_connectors(id,organization_id,connector_key,display_name,description,lifecycle_status,
        current_version_id,active_version_id,created_at,updated_at)
      VALUES(connector_id,org.id,binding_key,'受控人工上传','从既有 Case Plan 迁移的纯虚构 DEV 人工资料入口。','active',NULL,NULL,now(),now());
      INSERT INTO public.source_connector_versions(id,organization_id,connector_id,version,revision,status,definition,
        definition_hash,reason,created_at)
      VALUES(version_id,org.id,connector_id,1,1,'active',definition,encode(digest(definition::text,'sha256'),'hex'),
        'M20 从既有 Case Plan source binding 建立的无外部调用基线。',now());
      INSERT INTO public.source_connector_test_runs(id,organization_id,connector_id,connector_version_id,definition_hash,status,
        result,reason,created_at)
      VALUES(gen_random_uuid(),org.id,connector_id,version_id,encode(digest(definition::text,'sha256'),'hex'),'passed',
        jsonb_build_object('passed',true,'fixtureCount',1,'externalCallCount',0,'credentialResolution','not_attempted',
          'persistedDocuments',false,'externalDelivery','disabled','runtimeExecution','disabled'),
        'M20 迁移时对既有内部 binding 完成确定性安全基线检查。',now());
      UPDATE public.source_connectors SET current_version_id=version_id,active_version_id=version_id WHERE id=connector_id;
    END LOOP;
  END LOOP;
END;
$$;

ALTER TABLE public.source_connectors ADD CONSTRAINT source_connector_current_version_same_org_fk
  FOREIGN KEY (organization_id,current_version_id) REFERENCES public.source_connector_versions(organization_id,id);
ALTER TABLE public.source_connectors ADD CONSTRAINT source_connector_active_version_same_org_fk
  FOREIGN KEY (organization_id,active_version_id) REFERENCES public.source_connector_versions(organization_id,id);

CREATE OR REPLACE FUNCTION public.dop_create_source_connector(
  p_actor_id uuid,p_connector_key text,p_display_name text,p_description text,p_definition jsonb,p_reason text,
  p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); existing public.source_connector_versions%ROWTYPE;
  validation_error text; fingerprint text; connector_id uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_connector_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$' OR char_length(p_display_name) NOT BETWEEN 2 AND 160
     OR char_length(p_description) NOT BETWEEN 12 AND 1000 OR char_length(p_reason) NOT BETWEEN 12 AND 1000
     OR p_definition->>'connectorKey' IS DISTINCT FROM p_connector_key THEN RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  validation_error:=public.dop_source_connector_definition_error(p_definition);
  IF validation_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',validation_error); END IF;
  fingerprint:=encode(digest(concat_ws('|',p_connector_key,p_display_name,p_description,p_definition::text,p_reason),'sha256'),'hex');
  SELECT * INTO existing FROM public.source_connector_versions WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','connectorId',existing.connector_id,'versionId',existing.id,'status',existing.status); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused');
  END IF;
  IF EXISTS(SELECT 1 FROM public.source_connectors WHERE organization_id=org_id AND connector_key=p_connector_key)
    THEN RETURN jsonb_build_object('outcome','conflict','reason','connector_key_exists'); END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
    correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event','SourceConnector.Registered',1,'source_connector',connector_id,
    p_correlation_id,p_actor_id,'ops-source-connector',jsonb_build_object('connector_key',p_connector_key,'version_id',version_id,
      'definition_hash',encode(digest(p_definition::text,'sha256'),'hex'),'external_calls',0,'external_delivery','disabled'),p_now);
  INSERT INTO public.source_connectors(id,organization_id,connector_key,display_name,description,lifecycle_status,created_at,updated_at)
    VALUES(connector_id,org_id,p_connector_key,p_display_name,p_description,'registered',p_now,p_now);
  INSERT INTO public.source_connector_versions(id,organization_id,connector_id,version,revision,status,definition,definition_hash,
    created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(version_id,org_id,connector_id,1,1,'draft',p_definition,encode(digest(p_definition::text,'sha256'),'hex'),p_actor_id,
    p_reason,p_idempotency_key,fingerprint,event_id,p_now);
  UPDATE public.source_connectors SET current_version_id=version_id WHERE id=connector_id;
  RETURN jsonb_build_object('outcome','completed','connectorId',connector_id,'versionId',version_id,'version',1,'revision',1,'status','draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_update_source_connector_draft(
  p_actor_id uuid,p_version_id uuid,p_definition jsonb,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); source public.source_connector_versions%ROWTYPE;
  root public.source_connectors%ROWTYPE; existing public.source_connector_versions%ROWTYPE; validation_error text;
  fingerprint text; new_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); definition_hash text;
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  validation_error:=public.dop_source_connector_definition_error(p_definition);
  IF validation_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',validation_error); END IF;
  definition_hash:=encode(digest(p_definition::text,'sha256'),'hex');
  fingerprint:=encode(digest(concat_ws('|',p_version_id::text,p_definition::text,p_reason),'sha256'),'hex');
  SELECT * INTO existing FROM public.source_connector_versions WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','versionId',existing.id,'status',existing.status); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused'); END IF;
  SELECT * INTO source FROM public.source_connector_versions WHERE organization_id=org_id AND id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','source_connector_version_not_found'); END IF;
  SELECT * INTO root FROM public.source_connectors WHERE id=source.connector_id FOR UPDATE;
  IF source.status<>'draft' OR root.current_version_id<>source.id OR root.lifecycle_status='revoked'
    THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current_draft'); END IF;
  IF p_definition->>'connectorKey' IS DISTINCT FROM root.connector_key
    THEN RETURN jsonb_build_object('outcome','conflict','reason','connector_key_immutable'); END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
    correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event','SourceConnector.DraftRevised',1,'source_connector',source.connector_id,
    p_correlation_id,p_actor_id,'ops-source-connector',jsonb_build_object('source_version_id',source.id,'version_id',new_id,
      'definition_hash',definition_hash,'external_calls',0,'external_delivery','disabled'),p_now);
  INSERT INTO public.source_connector_versions(id,organization_id,connector_id,version,revision,status,definition,definition_hash,
    created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(new_id,org_id,source.connector_id,source.version,source.revision+1,'draft',p_definition,definition_hash,p_actor_id,p_reason,
    p_idempotency_key,fingerprint,event_id,p_now);
  UPDATE public.source_connectors SET current_version_id=new_id,updated_at=p_now WHERE id=source.connector_id;
  RETURN jsonb_build_object('outcome','completed','connectorId',source.connector_id,'versionId',new_id,
    'version',source.version,'revision',source.revision+1,'status','draft');
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_run_source_connector_test(
  p_actor_id uuid,p_version_id uuid,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); source public.source_connector_versions%ROWTYPE;
  root public.source_connectors%ROWTYPE; existing public.source_connector_test_runs%ROWTYPE; validation_error text;
  fingerprint text; run_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); result jsonb;
BEGIN
  IF char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  fingerprint:=encode(digest(concat_ws('|',p_version_id::text,p_reason),'sha256'),'hex');
  SELECT * INTO existing FROM public.source_connector_test_runs WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','testRunId',existing.id,'status',existing.status,'result',existing.result); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused'); END IF;
  SELECT * INTO source FROM public.source_connector_versions WHERE organization_id=org_id AND id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','source_connector_version_not_found'); END IF;
  SELECT * INTO root FROM public.source_connectors WHERE id=source.connector_id;
  IF root.current_version_id<>source.id OR source.status='revoked' THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current'); END IF;
  validation_error:=public.dop_source_connector_definition_error(source.definition);
  IF validation_error IS NOT NULL THEN RETURN jsonb_build_object('outcome','conflict','reason',validation_error); END IF;
  result:=jsonb_build_object('passed',true,'definitionHash',source.definition_hash,
    'fixtureCount',jsonb_array_length(source.definition->'testFixtures'),'externalCallCount',0,
    'credentialResolution','reference_only','persistedDocuments',false,'externalDelivery','disabled','runtimeExecution','disabled');
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
    correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event','SourceConnector.ContractTestPassed',1,'source_connector',source.connector_id,
    p_correlation_id,p_actor_id,'ops-source-connector',jsonb_build_object('version_id',source.id,'definition_hash',source.definition_hash,
      'fixture_count',jsonb_array_length(source.definition->'testFixtures'),'external_calls',0,'external_delivery','disabled'),p_now);
  INSERT INTO public.source_connector_test_runs(id,organization_id,connector_id,connector_version_id,definition_hash,status,result,
    run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(run_id,org_id,source.connector_id,source.id,source.definition_hash,'passed',result,p_actor_id,p_reason,p_idempotency_key,
    fingerprint,event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','testRunId',run_id,'status','passed','result',result);
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_transition_source_connector_version(
  p_actor_id uuid,p_version_id uuid,p_action text,p_reason text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE org_id uuid:=public.dop_require_active_admin(p_actor_id); source public.source_connector_versions%ROWTYPE;
  root public.source_connectors%ROWTYPE; existing public.source_connector_versions%ROWTYPE; target_status text; target_lifecycle text;
  event_type text; fingerprint text; new_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
BEGIN
  IF p_action NOT IN ('submit_review','return_to_draft','approve','activate','suspend','reactivate','revoke')
     OR char_length(p_reason) NOT BETWEEN 12 AND 1000 THEN RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  fingerprint:=encode(digest(concat_ws('|',p_version_id::text,p_action,p_reason),'sha256'),'hex');
  SELECT * INTO existing FROM public.source_connector_versions WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint=fingerprint THEN RETURN jsonb_build_object('outcome','duplicate','versionId',existing.id,'status',existing.status); END IF;
    RETURN jsonb_build_object('outcome','conflict','reason','idempotency_key_reused'); END IF;
  SELECT * INTO source FROM public.source_connector_versions WHERE organization_id=org_id AND id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','source_connector_version_not_found'); END IF;
  SELECT * INTO root FROM public.source_connectors WHERE id=source.connector_id FOR UPDATE;
  IF root.current_version_id<>source.id OR root.lifecycle_status='revoked'
    THEN RETURN jsonb_build_object('outcome','conflict','reason','version_not_current'); END IF;
  IF p_action='submit_review' AND source.status='draft' THEN target_status:='in_review'; target_lifecycle:='registered'; event_type:='SourceConnector.SubmittedForReview';
  ELSIF p_action='return_to_draft' AND source.status='in_review' THEN target_status:='draft'; target_lifecycle:='registered'; event_type:='SourceConnector.ReturnedToDraft';
  ELSIF p_action='approve' AND source.status='in_review' THEN target_status:='approved'; target_lifecycle:='registered'; event_type:='SourceConnector.Approved';
  ELSIF p_action='activate' AND source.status='approved' THEN target_status:='active'; target_lifecycle:='active'; event_type:='SourceConnector.Activated';
  ELSIF p_action='suspend' AND source.status='active' THEN target_status:='suspended'; target_lifecycle:='suspended'; event_type:='SourceConnector.Suspended';
  ELSIF p_action='reactivate' AND source.status='suspended' THEN target_status:='active'; target_lifecycle:='active'; event_type:='SourceConnector.Reactivated';
  ELSIF p_action='revoke' AND source.status<>'revoked' THEN target_status:='revoked'; target_lifecycle:='revoked'; event_type:='SourceConnector.Revoked';
  ELSE RETURN jsonb_build_object('outcome','conflict','reason','invalid_transition'); END IF;
  IF p_action IN ('submit_review','approve','activate','reactivate') AND NOT EXISTS(
    SELECT 1 FROM public.source_connector_test_runs test WHERE test.connector_id=source.connector_id
      AND test.definition_hash=source.definition_hash AND test.status='passed')
    THEN RETURN jsonb_build_object('outcome','conflict','reason','passing_test_required'); END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,aggregate_type,aggregate_id,
    correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event',event_type,1,'source_connector',source.connector_id,
    p_correlation_id,p_actor_id,'ops-source-connector',jsonb_build_object('source_version_id',source.id,'version_id',new_id,
      'status',target_status,'definition_hash',source.definition_hash,'runtime_execution','disabled','external_delivery','disabled'),p_now);
  INSERT INTO public.source_connector_versions(id,organization_id,connector_id,version,revision,status,definition,definition_hash,
    created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(new_id,org_id,source.connector_id,source.version,source.revision+1,target_status,source.definition,source.definition_hash,
    p_actor_id,p_reason,p_idempotency_key,fingerprint,event_id,p_now);
  UPDATE public.source_connectors SET lifecycle_status=target_lifecycle,current_version_id=new_id,
    active_version_id=CASE WHEN target_status='active' THEN new_id WHEN target_status IN ('suspended','revoked') THEN NULL ELSE active_version_id END,
    updated_at=p_now WHERE id=source.connector_id;
  RETURN jsonb_build_object('outcome','completed','connectorId',source.connector_id,'versionId',new_id,
    'version',source.version,'revision',source.revision+1,'status',target_status,'lifecycleStatus',target_lifecycle);
END;
$$;

REVOKE ALL ON FUNCTION public.dop_source_connector_definition_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_source_connector(uuid,text,text,text,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_update_source_connector_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_run_source_connector_test(uuid,uuid,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_transition_source_connector_version(uuid,uuid,text,text,text,uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_source_connector(uuid,text,text,text,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_update_source_connector_draft(uuid,uuid,jsonb,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_run_source_connector_test(uuid,uuid,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_transition_source_connector_version(uuid,uuid,text,text,text,uuid,timestamptz) TO dop_app;

COMMIT;
