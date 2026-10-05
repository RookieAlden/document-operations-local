BEGIN;

-- M45.1 creates a synthetic UAT sales-demo boundary. It does not enable real
-- data, create PROD, or grant the application role direct governance writes.
CREATE TABLE public.demo_form_entry_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  entry_key text NOT NULL CHECK (entry_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  version integer NOT NULL CHECK (version > 0),
  runtime_environment text NOT NULL CHECK (runtime_environment='UAT'),
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  provider_form_id text NOT NULL CHECK (length(btrim(provider_form_id)) BETWEEN 3 AND 300),
  status text NOT NULL CHECK (status IN ('active','disabled')),
  synthetic_only boolean NOT NULL CHECK (synthetic_only=true),
  allowed_mime_types text[] NOT NULL,
  maximum_files_per_submission integer NOT NULL CHECK (maximum_files_per_submission BETWEEN 1 AND 100),
  maximum_declared_bytes bigint NOT NULL CHECK (maximum_declared_bytes BETWEEN 1 AND 1048576000),
  require_declared_bytes boolean NOT NULL DEFAULT false,
  created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  disabled_at timestamptz,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,entry_key,version),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,event_id),
  CONSTRAINT demo_form_entry_creator_same_org_fk FOREIGN KEY (organization_id,created_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT demo_form_entry_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id),
  CHECK ((status='disabled')=(disabled_at IS NOT NULL)),
  CHECK (cardinality(allowed_mime_types) BETWEEN 1 AND 10),
  CHECK (allowed_mime_types <@ ARRAY['application/pdf','image/jpeg','image/png']::text[])
);
CREATE UNIQUE INDEX one_active_demo_entry_per_provider_form
  ON public.demo_form_entry_versions(organization_id,provider_form_id) WHERE status='active';
CREATE UNIQUE INDEX one_active_demo_entry_per_key
  ON public.demo_form_entry_versions(organization_id,entry_key) WHERE status='active';

CREATE TABLE public.demo_case_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  entry_version_id uuid NOT NULL REFERENCES public.demo_form_entry_versions(id),
  subject_id uuid NOT NULL REFERENCES public.subjects(id),
  case_id uuid NOT NULL REFERENCES public.cases(id),
  invitation_token_sha256 text NOT NULL CHECK (invitation_token_sha256 ~ '^[0-9a-f]{64}$'),
  period_key text NOT NULL CHECK (period_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  status text NOT NULL CHECK (status IN ('active','revoked','exhausted')),
  synthetic_only boolean NOT NULL CHECK (synthetic_only=true),
  allow_initial_submission boolean NOT NULL DEFAULT true,
  allow_supplement boolean NOT NULL DEFAULT true,
  maximum_submissions integer NOT NULL CHECK (maximum_submissions BETWEEN 1 AND 100),
  used_submissions integer NOT NULL DEFAULT 0 CHECK (used_submissions >= 0 AND used_submissions <= maximum_submissions),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
  revoked_by_actor_id uuid REFERENCES public.actors(id),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,invitation_token_sha256),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,event_id),
  CONSTRAINT demo_invitation_entry_same_org_fk FOREIGN KEY (organization_id,entry_version_id)
    REFERENCES public.demo_form_entry_versions(organization_id,id),
  CONSTRAINT demo_invitation_subject_same_org_fk FOREIGN KEY (organization_id,subject_id)
    REFERENCES public.subjects(organization_id,id),
  CONSTRAINT demo_invitation_case_same_org_fk FOREIGN KEY (organization_id,case_id)
    REFERENCES public.cases(organization_id,id),
  CONSTRAINT demo_invitation_creator_same_org_fk FOREIGN KEY (organization_id,created_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT demo_invitation_revoker_same_org_fk FOREIGN KEY (organization_id,revoked_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT demo_invitation_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id),
  CHECK (valid_until>valid_from),
  CHECK ((status='revoked')=(revoked_at IS NOT NULL AND revoked_by_actor_id IS NOT NULL)),
  CHECK (status<>'exhausted' OR used_submissions=maximum_submissions)
);
CREATE UNIQUE INDEX one_active_demo_invitation_per_case_entry
  ON public.demo_case_invitations(organization_id,entry_version_id,case_id) WHERE status='active';
CREATE INDEX demo_case_invitation_expiry
  ON public.demo_case_invitations(organization_id,status,valid_until);

CREATE TABLE public.demo_form_access_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  entry_version_id uuid REFERENCES public.demo_form_entry_versions(id),
  invitation_id uuid REFERENCES public.demo_case_invitations(id),
  case_id uuid REFERENCES public.cases(id),
  provider_submission_id_hash text NOT NULL CHECK (provider_submission_id_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('authorized','blocked')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,119}$'),
  submission_phase text CHECK (submission_phase IS NULL OR submission_phase IN ('initial','supplement')),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 100),
  declared_total_bytes bigint NOT NULL CHECK (declared_total_bytes >= 0),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 12 AND 500),
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  decided_at timestamptz NOT NULL,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,event_id),
  CONSTRAINT demo_access_entry_same_org_fk FOREIGN KEY (organization_id,entry_version_id)
    REFERENCES public.demo_form_entry_versions(organization_id,id),
  CONSTRAINT demo_access_invitation_same_org_fk FOREIGN KEY (organization_id,invitation_id)
    REFERENCES public.demo_case_invitations(organization_id,id),
  CONSTRAINT demo_access_case_same_org_fk FOREIGN KEY (organization_id,case_id)
    REFERENCES public.cases(organization_id,id),
  CONSTRAINT demo_access_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id)
);
CREATE UNIQUE INDEX demo_access_provider_submission_once
  ON public.demo_form_access_decisions(organization_id,invitation_id,provider_submission_id_hash)
  WHERE invitation_id IS NOT NULL AND decision='authorized';
CREATE INDEX demo_access_decision_history
  ON public.demo_form_access_decisions(organization_id,decided_at DESC);

ALTER TABLE public.demo_form_entry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_case_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_form_access_decisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.demo_form_entry_versions,public.demo_case_invitations,public.demo_form_access_decisions TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.demo_form_entry_versions FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.demo_case_invitations FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.demo_form_access_decisions FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_create_uat_synthetic_demo_form_connector(
  p_actor_id uuid,p_connector_key text,p_display_name text,p_description text,
  p_credential_reference text,p_allowed_mime_types text[],p_maximum_files integer,
  p_maximum_file_bytes bigint,p_reason text,p_idempotency_key text,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  connector_id uuid:=gen_random_uuid(); version_id uuid:=gen_random_uuid();
  test_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); definition jsonb; definition_hash text;
  existing public.source_connector_versions%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM public.source_connector_versions
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','connectorId',existing.connector_id,
    'versionId',existing.id,'status',existing.status); END IF;
  IF p_connector_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR length(btrim(p_display_name)) NOT BETWEEN 2 AND 160
     OR length(btrim(p_description)) NOT BETWEEN 12 AND 1000
     OR p_credential_reference !~ '^railway://[A-Za-z0-9._/-]{3,240}$'
     OR cardinality(p_allowed_mime_types) NOT BETWEEN 1 AND 3
     OR NOT p_allowed_mime_types <@ ARRAY['application/pdf','image/jpeg','image/png']::text[]
     OR p_maximum_files NOT BETWEEN 1 AND 100
     OR p_maximum_file_bytes NOT BETWEEN 1 AND 104857600
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  IF EXISTS(SELECT 1 FROM public.source_connectors WHERE organization_id=org_id AND connector_key=p_connector_key) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','connector_key_exists'); END IF;
  definition:=jsonb_build_object('schemaVersion','1.0','environment','UAT','connectorKey',p_connector_key,
    'connectorType','form','transport','push','capabilities',jsonb_build_array('documents','metadata','webhook'),
    'credentialReference',jsonb_build_object('mode','secret_reference','provider','railway','reference',p_credential_reference),
    'dataBoundary',jsonb_build_object('syntheticOnly',true,'externalDelivery','disabled',
      'maxFilesPerSubmission',p_maximum_files,'maxFileBytes',p_maximum_file_bytes,
      'allowedMimeTypes',to_jsonb(p_allowed_mime_types)),
    'activationPolicy',jsonb_build_object('explicitApprovalRequired',true,
      'emergencySuspendEnabled',true,'runtimeExecution','disabled'),
    'testFixtures',jsonb_build_array(jsonb_build_object('fixtureKey','m45-1.synthetic-demo',
      'displayName','M45.1 synthetic Fillout fixture','synthetic',true,
      'filename','m45-1-synthetic-demo.pdf','mimeType','application/pdf',
      'payloadSummary','Purely synthetic UAT fixture used to verify the governed Fillout connector without an external call.')));
  definition_hash:=encode(digest(definition::text,'sha256'),'hex');
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,p_idempotency_key||':event','SourceConnector.Activated',1,
    'source_connector',connector_id,p_correlation_id,p_actor_id,'dop.governance.synthetic-demo.v1',
    jsonb_build_object('versionId',version_id,'definitionHash',definition_hash,'environment','UAT',
      'syntheticOnly',true,'runtimeExecution','disabled','demoEntryRequired',true,
      'externalCalls',0,'externalDelivery','disabled'),p_now);
  INSERT INTO public.source_connectors(id,organization_id,connector_key,display_name,description,
    lifecycle_status,current_version_id,active_version_id,created_at,updated_at)
  VALUES(connector_id,org_id,p_connector_key,btrim(p_display_name),btrim(p_description),
    'active',NULL,NULL,p_now,p_now);
  INSERT INTO public.source_connector_versions(id,organization_id,connector_id,version,revision,status,
    definition,definition_hash,created_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(version_id,org_id,connector_id,1,1,'active',definition,definition_hash,p_actor_id,btrim(p_reason),
    p_idempotency_key,encode(digest(concat_ws('|',p_connector_key,definition::text,btrim(p_reason)),'sha256'),'hex'),event_id,p_now);
  INSERT INTO public.source_connector_test_runs(id,organization_id,connector_id,connector_version_id,
    definition_hash,status,result,run_by_actor_id,reason,idempotency_key,request_fingerprint,event_id,created_at)
  VALUES(test_id,org_id,connector_id,version_id,definition_hash,'passed',jsonb_build_object(
    'passed',true,'fixtureCount',1,'externalCallCount',0,'credentialResolution','reference_only',
    'persistedDocuments',false,'externalDelivery','disabled','runtimeExecution','disabled',
    'demoEntryRequired',true),p_actor_id,btrim(p_reason),p_idempotency_key||':test',
    encode(digest(definition_hash||'|offline-test','sha256'),'hex'),NULL,p_now);
  UPDATE public.source_connectors SET current_version_id=version_id,active_version_id=version_id
   WHERE id=connector_id;
  RETURN jsonb_build_object('outcome','completed','connectorId',connector_id,'versionId',version_id,
    'status','active','definitionHash',definition_hash,'externalCallCount',0,'runtimeExecution','disabled');
END $$;

CREATE OR REPLACE FUNCTION public.dop_create_demo_form_entry(
  p_actor_id uuid,p_entry_key text,p_connector_key text,p_provider_form_id text,
  p_allowed_mime_types text[],p_maximum_files integer,p_maximum_declared_bytes bigint,
  p_require_declared_bytes boolean,p_reason text,p_idempotency_key uuid,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_manager(p_actor_id);
  existing public.demo_form_entry_versions%ROWTYPE;
  entry_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); next_version integer;
BEGIN
  SELECT * INTO existing FROM public.demo_form_entry_versions
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','entryVersionId',existing.id,'status',existing.status); END IF;
  IF p_entry_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR p_connector_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR length(btrim(p_provider_form_id)) NOT BETWEEN 3 AND 300
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000
     OR p_maximum_files NOT BETWEEN 1 AND 100
     OR p_maximum_declared_bytes NOT BETWEEN 1 AND 1048576000
     OR cardinality(p_allowed_mime_types) NOT BETWEEN 1 AND 10
     OR NOT p_allowed_mime_types <@ ARRAY['application/pdf','image/jpeg','image/png']::text[] THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  IF EXISTS(SELECT 1 FROM public.demo_form_entry_versions
     WHERE organization_id=org_id AND (entry_key=p_entry_key OR provider_form_id=btrim(p_provider_form_id)) AND status='active') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','active_entry_already_exists');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.source_connectors connector
    JOIN public.source_connector_versions version ON version.organization_id=connector.organization_id
      AND version.connector_id=connector.id AND version.id=connector.active_version_id
    WHERE connector.organization_id=org_id AND connector.connector_key=p_connector_key
      AND connector.lifecycle_status='active' AND version.status='active'
      AND version.definition->>'environment'='UAT'
      AND version.definition->>'connectorType'='form'
      AND version.definition->'capabilities' ? 'documents'
      AND version.definition->'capabilities' ? 'webhook'
      AND version.enforcement_profile @> '{"runtimeExecution":"disabled","syntheticOnly":true}'::jsonb
  ) THEN RETURN jsonb_build_object('outcome','conflict','reason','active_uat_form_connector_required'); END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.demo_form_entry_versions
   WHERE organization_id=org_id AND entry_key=p_entry_key;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'demo-form-entry-created|'||p_idempotency_key,'DemoForm.EntryActivated',1,
    'demo_form_entry',entry_id,p_correlation_id,p_actor_id,'dop.governance.synthetic-demo.v1',
    jsonb_build_object('entryKey',p_entry_key,'version',next_version,'runtimeEnvironment','UAT',
      'connectorKey',p_connector_key,'providerFormId',btrim(p_provider_form_id),
      'syntheticOnly',true,'maximumFilesPerSubmission',p_maximum_files,
      'maximumDeclaredBytes',p_maximum_declared_bytes),p_now);
  INSERT INTO public.demo_form_entry_versions(id,organization_id,entry_key,version,runtime_environment,
    connector_key,provider_form_id,status,synthetic_only,allowed_mime_types,
    maximum_files_per_submission,maximum_declared_bytes,require_declared_bytes,
    created_by_actor_id,reason,idempotency_key,event_id,created_at,updated_at)
  VALUES(entry_id,org_id,p_entry_key,next_version,'UAT',p_connector_key,btrim(p_provider_form_id),
    'active',true,p_allowed_mime_types,p_maximum_files,p_maximum_declared_bytes,
    p_require_declared_bytes,p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now,p_now);
  RETURN jsonb_build_object('outcome','completed','entryVersionId',entry_id,'version',next_version,'status','active');
END $$;

CREATE OR REPLACE FUNCTION public.dop_set_demo_form_entry_status(
  p_actor_id uuid,p_entry_version_id uuid,p_status text,p_reason text,
  p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_manager(p_actor_id);
  entry_row public.demo_form_entry_versions%ROWTYPE; existing public.workflow_events%ROWTYPE;
  event_id uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO existing FROM public.workflow_events
   WHERE organization_id=org_id AND idempotency_key='demo-form-entry-status|'||p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','entryVersionId',existing.aggregate_id); END IF;
  IF p_status NOT IN ('active','disabled') OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO entry_row FROM public.demo_form_entry_versions
   WHERE organization_id=org_id AND id=p_entry_version_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','entry_not_found'); END IF;
  IF entry_row.status=p_status THEN RETURN jsonb_build_object('outcome','conflict','reason','status_unchanged'); END IF;
  IF p_status='active' AND EXISTS(SELECT 1 FROM public.demo_form_entry_versions
      WHERE organization_id=org_id AND status='active' AND id<>entry_row.id
        AND (entry_key=entry_row.entry_key OR provider_form_id=entry_row.provider_form_id)) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','active_entry_already_exists'); END IF;
  UPDATE public.demo_form_entry_versions SET status=p_status,updated_at=p_now,
    disabled_at=CASE WHEN p_status='disabled' THEN p_now ELSE NULL END WHERE id=entry_row.id;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'demo-form-entry-status|'||p_idempotency_key,
    CASE WHEN p_status='active' THEN 'DemoForm.EntryActivated' ELSE 'DemoForm.EntryDisabled' END,
    1,'demo_form_entry',entry_row.id,p_correlation_id,p_actor_id,'dop.governance.synthetic-demo.v1',
    jsonb_build_object('entryKey',entry_row.entry_key,'version',entry_row.version,'status',p_status,'reason',btrim(p_reason)),p_now);
  RETURN jsonb_build_object('outcome','completed','entryVersionId',entry_row.id,'status',p_status,'eventId',event_id);
END $$;

CREATE OR REPLACE FUNCTION public.dop_issue_demo_case_invitation(
  p_actor_id uuid,p_entry_version_id uuid,p_case_id uuid,p_invitation_token_sha256 text,
  p_period_key text,p_allow_initial boolean,p_allow_supplement boolean,p_maximum_submissions integer,
  p_valid_from timestamptz,p_valid_until timestamptz,p_reason text,p_idempotency_key uuid,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_manager(p_actor_id);
  entry_row public.demo_form_entry_versions%ROWTYPE; case_row public.cases%ROWTYPE;
  subject_row public.subjects%ROWTYPE; existing public.demo_case_invitations%ROWTYPE;
  invitation_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
  connector_version_id uuid; connector_definition_hash text; previous_connector_version_id uuid;
BEGIN
  SELECT * INTO existing FROM public.demo_case_invitations
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','invitationId',existing.id,'status',existing.status); END IF;
  IF p_invitation_token_sha256 !~ '^[0-9a-f]{64}$' OR p_period_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR NOT (p_allow_initial OR p_allow_supplement) OR p_maximum_submissions NOT BETWEEN 1 AND 100
     OR p_valid_until<=p_valid_from OR p_valid_until<=p_now
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO entry_row FROM public.demo_form_entry_versions
   WHERE organization_id=org_id AND id=p_entry_version_id AND status='active';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','active_entry_required'); END IF;
  SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id
    AND status IN ('not_started','waiting_for_documents','review_required','ready','in_progress');
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','conflict','reason','case_not_receiving'); END IF;
  SELECT * INTO subject_row FROM public.subjects WHERE organization_id=org_id AND id=case_row.subject_id AND status='active';
  IF NOT FOUND OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb THEN
    RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required'); END IF;
  IF NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb THEN
    IF EXISTS(SELECT 1 FROM public.submissions WHERE organization_id=org_id AND case_id=case_row.id) THEN
      RETURN jsonb_build_object('outcome','conflict','reason','synthetic_scope_required'); END IF;
    UPDATE public.cases SET config_snapshot=jsonb_set(config_snapshot,'{synthetic_only}','true'::jsonb,true),
      version=version+1,updated_at=p_now WHERE organization_id=org_id AND id=case_row.id;
    case_row.config_snapshot:=jsonb_set(case_row.config_snapshot,'{synthetic_only}','true'::jsonb,true);
  END IF;
  IF case_row.case_key NOT LIKE '%|'||p_period_key THEN
    RETURN jsonb_build_object('outcome','conflict','reason','period_mismatch'); END IF;
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
  VALUES(event_id,org_id,'demo-invitation-issued|'||p_idempotency_key,'DemoForm.InvitationIssued',1,
    'case',case_row.id,p_correlation_id,p_actor_id,'dop.governance.synthetic-demo.v1',jsonb_build_object(
      'invitationId',invitation_id,'entryVersionId',entry_row.id,'periodKey',p_period_key,
      'syntheticOnly',true,'allowInitialSubmission',p_allow_initial,'allowSupplement',p_allow_supplement,
      'maximumSubmissions',p_maximum_submissions,'validUntil',p_valid_until,
      'sourceConnectorVersionId',connector_version_id,'previousSourceConnectorVersionId',previous_connector_version_id),p_now);
  INSERT INTO public.demo_case_invitations(id,organization_id,entry_version_id,subject_id,case_id,
    invitation_token_sha256,period_key,status,synthetic_only,allow_initial_submission,allow_supplement,
    maximum_submissions,valid_from,valid_until,created_by_actor_id,reason,idempotency_key,event_id,
    created_at,updated_at)
  VALUES(invitation_id,org_id,entry_row.id,case_row.subject_id,case_row.id,p_invitation_token_sha256,
    p_period_key,'active',true,p_allow_initial,p_allow_supplement,p_maximum_submissions,p_valid_from,
    p_valid_until,p_actor_id,btrim(p_reason),p_idempotency_key,event_id,p_now,p_now);
  RETURN jsonb_build_object('outcome','completed','invitationId',invitation_id,'caseId',case_row.id,
    'status','active','validUntil',p_valid_until,'eventId',event_id);
END $$;

CREATE OR REPLACE FUNCTION public.dop_revoke_demo_case_invitation(
  p_actor_id uuid,p_invitation_id uuid,p_reason text,p_idempotency_key uuid,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_manager(p_actor_id);
  invitation_row public.demo_case_invitations%ROWTYPE; existing public.workflow_events%ROWTYPE;
  event_id uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO existing FROM public.workflow_events
   WHERE organization_id=org_id AND idempotency_key='demo-invitation-revoked|'||p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','invitationId',existing.payload->>'invitationId'); END IF;
  IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request'); END IF;
  SELECT * INTO invitation_row FROM public.demo_case_invitations
   WHERE organization_id=org_id AND id=p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','reason','invitation_not_found'); END IF;
  IF invitation_row.status<>'active' THEN RETURN jsonb_build_object('outcome','conflict','reason','invitation_not_active'); END IF;
  UPDATE public.demo_case_invitations SET status='revoked',revoked_by_actor_id=p_actor_id,
    revoked_at=p_now,updated_at=p_now WHERE id=invitation_row.id;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'demo-invitation-revoked|'||p_idempotency_key,'DemoForm.InvitationRevoked',1,
    'case',invitation_row.case_id,p_correlation_id,p_actor_id,'dop.governance.synthetic-demo.v1',
    jsonb_build_object('invitationId',invitation_row.id,'reason',btrim(p_reason)),p_now);
  RETURN jsonb_build_object('outcome','completed','invitationId',invitation_row.id,'status','revoked','eventId',event_id);
END $$;

CREATE OR REPLACE FUNCTION public.dop_authorize_demo_form_submission(
  p_connector_key text,p_provider_form_id text,p_provider_submission_id text,
  p_invitation_token_sha256 text,p_claimed_period text,p_file_count integer,
  p_declared_total_bytes bigint,p_declared_bytes_complete boolean,p_mime_types text[],
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_current_organization_id();
  entry_row public.demo_form_entry_versions%ROWTYPE; invitation_row public.demo_case_invitations%ROWTYPE;
  case_row public.cases%ROWTYPE; subject_row public.subjects%ROWTYPE; existing public.demo_form_access_decisions%ROWTYPE;
  decision_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid();
  provider_hash text; fingerprint text; decision_reason text:='invalid_request'; phase text;
  workflow_key text; allowed boolean:=false;
BEGIN
  IF org_id IS NULL THEN RAISE EXCEPTION 'organization context is required' USING ERRCODE='42501'; END IF;
  provider_hash:=encode(digest(coalesce(p_provider_submission_id,''),'sha256'),'hex');
  fingerprint:=encode(digest(concat_ws('|',coalesce(p_connector_key,''),coalesce(p_provider_form_id,''),
    provider_hash,coalesce(p_invitation_token_sha256,''),coalesce(p_claimed_period,''),
    coalesce(p_file_count,-1)::text,coalesce(p_declared_total_bytes,-1)::text,
    coalesce(p_declared_bytes_complete,false)::text,array_to_string(coalesce(p_mime_types,ARRAY[]::text[]),',')),'sha256'),'hex');
  IF p_connector_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR length(btrim(p_provider_form_id)) NOT BETWEEN 3 AND 300
     OR length(btrim(p_provider_submission_id)) NOT BETWEEN 1 AND 300
     OR p_invitation_token_sha256 !~ '^[0-9a-f]{64}$'
     OR p_claimed_period !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_file_count NOT BETWEEN 1 AND 100 OR p_declared_total_bytes<0
     OR cardinality(coalesce(p_mime_types,ARRAY[]::text[]))<>p_file_count THEN
    decision_reason:='invalid_request';
  ELSE
    SELECT * INTO entry_row FROM public.demo_form_entry_versions WHERE organization_id=org_id
      AND connector_key=p_connector_key AND provider_form_id=btrim(p_provider_form_id) AND status='active';
    IF NOT FOUND THEN decision_reason:='entry_not_active';
    ELSE
      SELECT * INTO invitation_row FROM public.demo_case_invitations WHERE organization_id=org_id
        AND entry_version_id=entry_row.id AND invitation_token_sha256=p_invitation_token_sha256 FOR UPDATE;
      IF NOT FOUND THEN decision_reason:='invitation_not_found';
      ELSE
        SELECT * INTO existing FROM public.demo_form_access_decisions WHERE organization_id=org_id
          AND invitation_id=invitation_row.id AND provider_submission_id_hash=provider_hash AND decision='authorized';
        IF FOUND THEN
          IF existing.request_fingerprint<>fingerprint THEN
            decision_reason:='idempotency_payload_mismatch';
          ELSE
            SELECT c.* INTO case_row FROM public.cases c
            JOIN public.workflow_template_versions wtv ON wtv.organization_id=c.organization_id AND wtv.id=c.workflow_template_version_id
            JOIN public.workflow_templates wt ON wt.organization_id=wtv.organization_id AND wt.id=wtv.workflow_template_id
            WHERE c.organization_id=org_id AND c.id=invitation_row.case_id;
            SELECT wt.template_key INTO workflow_key FROM public.cases c
            JOIN public.workflow_template_versions wtv ON wtv.organization_id=c.organization_id AND wtv.id=c.workflow_template_version_id
            JOIN public.workflow_templates wt ON wt.organization_id=wtv.organization_id AND wt.id=wtv.workflow_template_id
            WHERE c.organization_id=org_id AND c.id=invitation_row.case_id;
            SELECT * INTO subject_row FROM public.subjects WHERE organization_id=org_id AND id=invitation_row.subject_id;
            RETURN jsonb_build_object('outcome','duplicate','authorizationId',existing.id,
              'organizationKey',(SELECT organization_key FROM public.organizations WHERE id=org_id),
              'workflowTemplateKey',workflow_key,'subjectKey',subject_row.subject_key,
              'subjectDisplayName',subject_row.display_name,'caseKey',case_row.case_key,
              'period',invitation_row.period_key,'timezone',case_row.timezone);
          END IF;
        ELSIF invitation_row.status<>'active' THEN decision_reason:='invitation_not_active';
        ELSIF p_now<invitation_row.valid_from OR p_now>=invitation_row.valid_until THEN decision_reason:='invitation_expired';
        ELSIF invitation_row.used_submissions>=invitation_row.maximum_submissions THEN decision_reason:='invitation_submission_limit_reached';
        ELSE
          SELECT c.* INTO case_row FROM public.cases c
          JOIN public.workflow_template_versions wtv ON wtv.organization_id=c.organization_id AND wtv.id=c.workflow_template_version_id
          JOIN public.workflow_templates wt ON wt.organization_id=wtv.organization_id AND wt.id=wtv.workflow_template_id
          WHERE c.organization_id=org_id AND c.id=invitation_row.case_id;
          SELECT wt.template_key INTO workflow_key FROM public.cases c
          JOIN public.workflow_template_versions wtv ON wtv.organization_id=c.organization_id AND wtv.id=c.workflow_template_version_id
          JOIN public.workflow_templates wt ON wt.organization_id=wtv.organization_id AND wt.id=wtv.workflow_template_id
          WHERE c.organization_id=org_id AND c.id=invitation_row.case_id;
          SELECT * INTO subject_row FROM public.subjects WHERE organization_id=org_id AND id=invitation_row.subject_id;
          phase:=CASE WHEN invitation_row.used_submissions=0 THEN 'initial' ELSE 'supplement' END;
          IF case_row.status NOT IN ('not_started','waiting_for_documents','review_required','ready','in_progress') THEN decision_reason:='case_not_receiving';
          ELSIF subject_row.status<>'active' OR NOT subject_row.attributes @> '{"synthetic":true}'::jsonb
             OR NOT case_row.config_snapshot @> '{"synthetic_only":true}'::jsonb
             OR NOT invitation_row.synthetic_only OR NOT entry_row.synthetic_only THEN decision_reason:='synthetic_scope_required';
          ELSIF p_claimed_period<>invitation_row.period_key THEN decision_reason:='period_mismatch';
          ELSIF phase='initial' AND NOT invitation_row.allow_initial_submission THEN decision_reason:='invitation_not_current';
          ELSIF phase='supplement' AND NOT invitation_row.allow_supplement THEN decision_reason:='invitation_not_current';
          ELSIF p_file_count>entry_row.maximum_files_per_submission THEN decision_reason:='file_count_exceeded';
          ELSIF entry_row.require_declared_bytes AND NOT p_declared_bytes_complete THEN decision_reason:='declared_bytes_required';
          ELSIF p_declared_total_bytes>entry_row.maximum_declared_bytes THEN decision_reason:='declared_bytes_exceeded';
          ELSIF EXISTS(SELECT 1 FROM unnest(p_mime_types) mime WHERE coalesce(mime,'')='') THEN decision_reason:='mime_type_required';
          ELSIF EXISTS(SELECT 1 FROM unnest(p_mime_types) mime WHERE lower(mime)<>ALL(entry_row.allowed_mime_types)) THEN decision_reason:='mime_type_not_allowed';
          ELSIF NOT EXISTS(
            SELECT 1 FROM public.source_connector_versions version
            JOIN public.source_connectors connector ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
            WHERE version.organization_id=org_id AND version.id=case_row.source_connector_version_id
              AND connector.connector_key=entry_row.connector_key AND connector.lifecycle_status='active'
              AND connector.active_version_id=version.id AND version.status='active'
          ) THEN decision_reason:='entry_not_active';
          ELSE allowed:=true; decision_reason:='synthetic_demo_invitation_allowed'; END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'demo-form-access|'||p_correlation_id,
    CASE WHEN allowed THEN 'DemoForm.SubmissionAuthorized' ELSE 'DemoForm.SubmissionBlocked' END,1,
    CASE WHEN invitation_row.case_id IS NULL THEN 'organization' ELSE 'case' END,
    coalesce(invitation_row.case_id,org_id),p_correlation_id,'dop.runtime.synthetic-demo.v1',
    jsonb_build_object('entryVersionId',entry_row.id,'invitationId',invitation_row.id,
      'decision',CASE WHEN allowed THEN 'authorized' ELSE 'blocked' END,'reasonCode',decision_reason,
      'submissionPhase',phase,'fileCount',least(greatest(coalesce(p_file_count,0),0),100),'syntheticOnly',true),p_now);
  INSERT INTO public.demo_form_access_decisions(id,organization_id,entry_version_id,invitation_id,case_id,
    provider_submission_id_hash,request_fingerprint,decision,reason_code,submission_phase,file_count,
    declared_total_bytes,correlation_id,idempotency_key,event_id,decided_at)
  VALUES(decision_id,org_id,entry_row.id,invitation_row.id,invitation_row.case_id,provider_hash,fingerprint,
    CASE WHEN allowed THEN 'authorized' ELSE 'blocked' END,decision_reason,phase,least(greatest(coalesce(p_file_count,0),0),100),
    greatest(coalesce(p_declared_total_bytes,0),0),p_correlation_id,'demo-form-access|'||p_correlation_id,event_id,p_now);
  IF NOT allowed THEN RETURN jsonb_build_object('outcome','rejected','reason',decision_reason); END IF;
  UPDATE public.demo_case_invitations SET used_submissions=used_submissions+1,
    status=CASE WHEN used_submissions+1=maximum_submissions THEN 'exhausted' ELSE 'active' END,
    updated_at=p_now WHERE id=invitation_row.id;
  RETURN jsonb_build_object('outcome','authorized','authorizationId',decision_id,
    'organizationKey',(SELECT organization_key FROM public.organizations WHERE id=org_id),
    'workflowTemplateKey',workflow_key,'subjectKey',subject_row.subject_key,
    'subjectDisplayName',subject_row.display_name,'caseKey',case_row.case_key,
    'period',invitation_row.period_key,'timezone',case_row.timezone);
END $$;

CREATE OR REPLACE FUNCTION public.dop_reject_demo_access_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'demo form access decisions are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER demo_form_access_decisions_immutable BEFORE UPDATE OR DELETE ON public.demo_form_access_decisions
  FOR EACH ROW EXECUTE FUNCTION public.dop_reject_demo_access_decision_mutation();

REVOKE ALL ON public.demo_form_entry_versions,public.demo_case_invitations,public.demo_form_access_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_uat_synthetic_demo_form_connector(uuid,text,text,text,text,text[],integer,bigint,text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_demo_form_entry(uuid,text,text,text,text[],integer,bigint,boolean,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_set_demo_form_entry_status(uuid,uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_issue_demo_case_invitation(uuid,uuid,uuid,text,text,boolean,boolean,integer,timestamptz,timestamptz,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_demo_case_invitation(uuid,uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_authorize_demo_form_submission(text,text,text,text,text,integer,bigint,boolean,text[],uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_reject_demo_access_decision_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_create_demo_form_entry(uuid,text,text,text,text[],integer,bigint,boolean,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_create_uat_synthetic_demo_form_connector(uuid,text,text,text,text,text[],integer,bigint,text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_set_demo_form_entry_status(uuid,uuid,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_issue_demo_case_invitation(uuid,uuid,uuid,text,text,boolean,boolean,integer,timestamptz,timestamptz,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_revoke_demo_case_invitation(uuid,uuid,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_authorize_demo_form_submission(text,text,text,text,text,integer,bigint,boolean,text[],uuid,timestamptz) TO dop_app;

COMMENT ON TABLE public.demo_form_entry_versions IS
'M45.1 versioned UAT-only synthetic Fillout entry boundary. It never authorizes real data or PROD.';
COMMENT ON TABLE public.demo_case_invitations IS
'M45.1 short-lived, hashed, bounded invitation that pins one synthetic Subject and Case.';
COMMENT ON TABLE public.demo_form_access_decisions IS
'M45.1 append-only, content-free authorization audit. Provider submission identifiers are stored only as SHA-256.';

COMMIT;
