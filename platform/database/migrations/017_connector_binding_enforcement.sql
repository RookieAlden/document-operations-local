BEGIN;

-- M21 makes the governed Source Connector version a first-class, immutable
-- reference across Case Plan, Preview, Approval, generated Case and intake
-- provenance. Registry activation is still governance-only: runtime execution
-- and external delivery remain disabled.
ALTER TABLE public.case_plan_versions
  ADD COLUMN source_connector_version_id uuid,
  ADD COLUMN source_connector_definition_hash text;
ALTER TABLE public.case_plan_preview_batches
  ADD COLUMN source_connector_version_id uuid,
  ADD COLUMN source_connector_definition_hash text;
ALTER TABLE public.case_plan_approvals
  ADD COLUMN source_connector_version_id uuid,
  ADD COLUMN source_connector_definition_hash text;
ALTER TABLE public.cases
  ADD COLUMN source_connector_version_id uuid,
  ADD COLUMN source_connector_definition_hash text;
ALTER TABLE public.submissions
  ADD COLUMN source_connector_version_id uuid,
  ADD COLUMN source_connector_definition_hash text,
  ADD COLUMN source_connector_key text,
  ADD COLUMN source_provenance jsonb;

CREATE OR REPLACE FUNCTION public.dop_case_plan_source_type_matches(
  p_plan_type text,
  p_connector_type text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT CASE p_connector_type
    WHEN 'manual_upload' THEN p_plan_type='manual_upload'
    WHEN 'form' THEN p_plan_type='form_connector'
    WHEN 'email' THEN p_plan_type='email'
    WHEN 'sharepoint' THEN p_plan_type='sharepoint'
    WHEN 'api' THEN p_plan_type='api'
    WHEN 'sftp' THEN p_plan_type='sftp'
    WHEN 'object_storage' THEN p_plan_type='object_storage'
    ELSE false
  END
$$;

-- Every historical Case Plan version had already been represented by M20 as
-- one active, provider-neutral connector. Pin those rows before making the
-- reference mandatory for all future versions.
UPDATE public.case_plan_versions plan_version
   SET source_connector_version_id=connector_version.id,
       source_connector_definition_hash=connector_version.definition_hash
  FROM public.source_connectors connector
  JOIN public.source_connector_versions connector_version
    ON connector_version.organization_id=connector.organization_id
   AND connector_version.id=connector.active_version_id
 WHERE connector.organization_id=plan_version.organization_id
   AND connector.connector_key=plan_version.definition#>>'{sourceBinding,bindingKey}'
   AND connector.lifecycle_status='active'
   AND connector_version.status='active'
   AND public.dop_case_plan_source_type_matches(
         plan_version.definition#>>'{sourceBinding,type}',
         connector_version.definition->>'connectorType'
       );

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.case_plan_versions WHERE source_connector_version_id IS NULL) THEN
    RAISE EXCEPTION 'M21 cannot backfill every Case Plan Source Connector binding';
  END IF;
END;
$$;

UPDATE public.case_plan_preview_batches preview
   SET source_connector_version_id=plan_version.source_connector_version_id,
       source_connector_definition_hash=plan_version.source_connector_definition_hash
  FROM public.case_plan_versions plan_version
 WHERE plan_version.organization_id=preview.organization_id
   AND plan_version.id=preview.case_plan_version_id;

UPDATE public.case_plan_approvals approval
   SET source_connector_version_id=preview.source_connector_version_id,
       source_connector_definition_hash=preview.source_connector_definition_hash
  FROM public.case_plan_preview_batches preview
 WHERE preview.organization_id=approval.organization_id
   AND preview.id=approval.preview_batch_id;

UPDATE public.cases case_record
   SET source_connector_version_id=plan_version.source_connector_version_id,
       source_connector_definition_hash=plan_version.source_connector_definition_hash,
       config_snapshot=jsonb_set(
         jsonb_set(case_record.config_snapshot,'{source_binding,connectorVersionId}',
           to_jsonb(plan_version.source_connector_version_id::text),true),
         '{source_binding,connectorDefinitionHash}',
         to_jsonb(plan_version.source_connector_definition_hash),true
       )
  FROM public.case_plan_versions plan_version
 WHERE case_record.organization_id=plan_version.organization_id
   AND case_record.config_snapshot#>>'{case_plan,case_plan_version_id}'=plan_version.id::text;

ALTER TABLE public.case_plan_versions
  ALTER COLUMN source_connector_version_id SET NOT NULL,
  ALTER COLUMN source_connector_definition_hash SET NOT NULL,
  ADD CONSTRAINT case_plan_connector_hash_valid CHECK (source_connector_definition_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT case_plan_connector_version_same_org_fk
    FOREIGN KEY (organization_id,source_connector_version_id)
    REFERENCES public.source_connector_versions(organization_id,id);
ALTER TABLE public.case_plan_preview_batches
  ALTER COLUMN source_connector_version_id SET NOT NULL,
  ALTER COLUMN source_connector_definition_hash SET NOT NULL,
  ADD CONSTRAINT case_plan_preview_connector_hash_valid CHECK (source_connector_definition_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT case_plan_preview_connector_version_same_org_fk
    FOREIGN KEY (organization_id,source_connector_version_id)
    REFERENCES public.source_connector_versions(organization_id,id);
ALTER TABLE public.case_plan_approvals
  ALTER COLUMN source_connector_version_id SET NOT NULL,
  ALTER COLUMN source_connector_definition_hash SET NOT NULL,
  ADD CONSTRAINT case_plan_approval_connector_hash_valid CHECK (source_connector_definition_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT case_plan_approval_connector_version_same_org_fk
    FOREIGN KEY (organization_id,source_connector_version_id)
    REFERENCES public.source_connector_versions(organization_id,id);
ALTER TABLE public.cases
  ADD CONSTRAINT case_connector_hash_valid CHECK (
    source_connector_definition_hash IS NULL OR source_connector_definition_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT case_connector_pin_complete CHECK (
    (source_connector_version_id IS NULL)=(source_connector_definition_hash IS NULL)
  ),
  ADD CONSTRAINT case_connector_version_same_org_fk
    FOREIGN KEY (organization_id,source_connector_version_id)
    REFERENCES public.source_connector_versions(organization_id,id);
ALTER TABLE public.submissions
  ADD CONSTRAINT submission_connector_hash_valid CHECK (
    source_connector_definition_hash IS NULL OR source_connector_definition_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT submission_connector_key_valid CHECK (
    source_connector_key IS NULL OR source_connector_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'
  ),
  ADD CONSTRAINT submission_connector_pin_complete CHECK (
    (source_connector_version_id IS NULL)=(source_connector_definition_hash IS NULL)
  ),
  ADD CONSTRAINT submission_source_provenance_object CHECK (
    source_provenance IS NULL OR jsonb_typeof(source_provenance)='object'
  ),
  ADD CONSTRAINT submission_connector_version_same_org_fk
    FOREIGN KEY (organization_id,source_connector_version_id)
    REFERENCES public.source_connector_versions(organization_id,id);

CREATE INDEX case_plan_connector_pin_idx
  ON public.case_plan_versions(organization_id,source_connector_version_id);
CREATE INDEX case_plan_preview_connector_pin_idx
  ON public.case_plan_preview_batches(organization_id,source_connector_version_id);
CREATE INDEX case_connector_pin_idx
  ON public.cases(organization_id,source_connector_version_id)
  WHERE source_connector_version_id IS NOT NULL;
CREATE INDEX submission_connector_pin_idx
  ON public.submissions(organization_id,source_connector_version_id)
  WHERE source_connector_version_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.dop_case_plan_definition_error(p_definition jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE interval_months numeric; offset_days numeric; preview_count numeric; anchor_date date;
BEGIN
  IF jsonb_typeof(p_definition)<>'object' OR jsonb_typeof(p_definition->'cadence')<>'object'
     OR jsonb_typeof(p_definition->'dueRule')<>'object'
     OR jsonb_typeof(p_definition->'sourceBinding')<>'object' THEN RETURN 'definition_shape_invalid'; END IF;
  IF jsonb_typeof(p_definition#>'{cadence,intervalMonths}')<>'number'
     OR jsonb_typeof(p_definition#>'{dueRule,offsetDays}')<>'number'
     OR jsonb_typeof(p_definition->'defaultPreviewCount')<>'number' THEN RETURN 'definition_number_invalid'; END IF;
  interval_months:=(p_definition#>>'{cadence,intervalMonths}')::numeric;
  offset_days:=(p_definition#>>'{dueRule,offsetDays}')::numeric;
  preview_count:=(p_definition->>'defaultPreviewCount')::numeric;
  IF interval_months<>trunc(interval_months) OR interval_months NOT BETWEEN 1 AND 12
     OR offset_days<>trunc(offset_days) OR offset_days NOT BETWEEN -31 AND 365
     OR preview_count<>trunc(preview_count) OR preview_count NOT BETWEEN 1 AND 12
     THEN RETURN 'definition_number_invalid'; END IF;
  IF coalesce(p_definition#>>'{cadence,mode}','')<>'calendar_months'
     OR coalesce(p_definition#>>'{dueRule,basis}','') NOT IN ('period_start','period_end')
     OR coalesce(p_definition#>>'{dueRule,localTime}','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR char_length(coalesce(p_definition->>'timezone','')) NOT BETWEEN 3 AND 80
     OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_definition->>'timezone')
     THEN RETURN 'definition_schedule_invalid'; END IF;
  IF coalesce(p_definition#>>'{sourceBinding,type}','') NOT IN
       ('manual_upload','form_connector','email','sharepoint','api','sftp','object_storage')
     OR coalesce(p_definition#>>'{sourceBinding,bindingKey}','') !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR jsonb_typeof(p_definition#>'{sourceBinding,metadata}')<>'object'
     OR coalesce(p_definition->>'externalDelivery','')<>'disabled'
     THEN RETURN 'definition_source_invalid'; END IF;
  IF coalesce(p_definition#>>'{cadence,anchorDate}','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     THEN RETURN 'definition_anchor_invalid'; END IF;
  anchor_date:=(p_definition#>>'{cadence,anchorDate}')::date;
  IF extract(day FROM anchor_date)<>1 THEN RETURN 'definition_anchor_invalid'; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN 'definition_invalid';
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_pin_case_plan_source_connector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE connector_version public.source_connector_versions%ROWTYPE;
BEGIN
  SELECT version.* INTO connector_version
    FROM public.source_connectors connector
    JOIN public.source_connector_versions version
      ON version.organization_id=connector.organization_id
     AND version.id=connector.active_version_id
   WHERE connector.organization_id=NEW.organization_id
     AND connector.connector_key=NEW.definition#>>'{sourceBinding,bindingKey}'
     AND connector.lifecycle_status='active'
     AND version.status='active'
     AND public.dop_case_plan_source_type_matches(
       NEW.definition#>>'{sourceBinding,type}',version.definition->>'connectorType'
     )
   FOR SHARE OF connector,version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  IF NEW.source_connector_version_id IS NOT NULL
     AND NEW.source_connector_version_id<>connector_version.id THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_version_mismatch';
  END IF;
  NEW.source_connector_version_id:=connector_version.id;
  NEW.source_connector_definition_hash:=connector_version.definition_hash;
  RETURN NEW;
END;
$$;
CREATE TRIGGER case_plan_pin_source_connector
  BEFORE INSERT ON public.case_plan_versions
  FOR EACH ROW EXECUTE FUNCTION public.dop_pin_case_plan_source_connector();

CREATE OR REPLACE FUNCTION public.dop_pin_case_plan_preview_connector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE plan_version public.case_plan_versions%ROWTYPE;
BEGIN
  SELECT plan.* INTO plan_version
    FROM public.case_plan_versions plan
    JOIN public.source_connector_versions version
      ON version.organization_id=plan.organization_id AND version.id=plan.source_connector_version_id
    JOIN public.source_connectors connector
      ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
   WHERE plan.organization_id=NEW.organization_id AND plan.id=NEW.case_plan_version_id
     AND connector.lifecycle_status='active' AND connector.active_version_id=version.id
     AND version.status='active' AND version.definition_hash=plan.source_connector_definition_hash
   FOR SHARE OF plan,version,connector;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  NEW.source_connector_version_id:=plan_version.source_connector_version_id;
  NEW.source_connector_definition_hash:=plan_version.source_connector_definition_hash;
  RETURN NEW;
END;
$$;
CREATE TRIGGER case_plan_preview_pin_source_connector
  BEFORE INSERT ON public.case_plan_preview_batches
  FOR EACH ROW EXECUTE FUNCTION public.dop_pin_case_plan_preview_connector();

CREATE OR REPLACE FUNCTION public.dop_pin_case_plan_approval_connector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE preview public.case_plan_preview_batches%ROWTYPE;
BEGIN
  SELECT batch.* INTO preview
    FROM public.case_plan_preview_batches batch
    JOIN public.source_connector_versions version
      ON version.organization_id=batch.organization_id AND version.id=batch.source_connector_version_id
    JOIN public.source_connectors connector
      ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
   WHERE batch.organization_id=NEW.organization_id AND batch.id=NEW.preview_batch_id
     AND connector.lifecycle_status='active' AND connector.active_version_id=version.id
     AND version.status='active' AND version.definition_hash=batch.source_connector_definition_hash
   FOR SHARE OF batch,version,connector;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  NEW.source_connector_version_id:=preview.source_connector_version_id;
  NEW.source_connector_definition_hash:=preview.source_connector_definition_hash;
  RETURN NEW;
END;
$$;
CREATE TRIGGER case_plan_approval_pin_source_connector
  BEFORE INSERT ON public.case_plan_approvals
  FOR EACH ROW EXECUTE FUNCTION public.dop_pin_case_plan_approval_connector();

CREATE OR REPLACE FUNCTION public.dop_pin_generated_case_connector()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE plan_version public.case_plan_versions%ROWTYPE; connector_key text;
BEGIN
  IF NEW.config_snapshot->>'source'<>'case_plan_preview' THEN RETURN NEW; END IF;
  SELECT plan.* INTO plan_version
    FROM public.case_plan_versions plan
    JOIN public.source_connector_versions version
      ON version.organization_id=plan.organization_id AND version.id=plan.source_connector_version_id
    JOIN public.source_connectors connector
      ON connector.organization_id=version.organization_id AND connector.id=version.connector_id
   WHERE plan.organization_id=NEW.organization_id
     AND plan.id=(NEW.config_snapshot#>>'{case_plan,case_plan_version_id}')::uuid
     AND connector.lifecycle_status='active' AND connector.active_version_id=version.id
     AND version.status='active' AND version.definition_hash=plan.source_connector_definition_hash
   FOR SHARE OF plan,version,connector;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  SELECT source_connector.connector_key INTO connector_key
    FROM public.source_connector_versions version
    JOIN public.source_connectors source_connector
      ON source_connector.organization_id=version.organization_id AND source_connector.id=version.connector_id
   WHERE version.organization_id=NEW.organization_id AND version.id=plan_version.source_connector_version_id;
  IF NEW.config_snapshot#>>'{source_binding,bindingKey}' IS DISTINCT FROM connector_key THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  NEW.source_connector_version_id:=plan_version.source_connector_version_id;
  NEW.source_connector_definition_hash:=plan_version.source_connector_definition_hash;
  NEW.config_snapshot:=jsonb_set(
    jsonb_set(NEW.config_snapshot,'{source_binding,connectorVersionId}',
      to_jsonb(plan_version.source_connector_version_id::text),true),
    '{source_binding,connectorDefinitionHash}',
    to_jsonb(plan_version.source_connector_definition_hash),true
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER generated_case_pin_source_connector
  BEFORE INSERT ON public.cases
  FOR EACH ROW EXECUTE FUNCTION public.dop_pin_generated_case_connector();

CREATE OR REPLACE FUNCTION public.dop_enforce_submission_connector_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE case_record public.cases%ROWTYPE; connector public.source_connectors%ROWTYPE;
  connector_version public.source_connector_versions%ROWTYPE; expected_source text;
BEGIN
  SELECT * INTO case_record FROM public.cases
   WHERE organization_id=NEW.organization_id AND id=NEW.case_id FOR SHARE;
  IF case_record.source_connector_version_id IS NULL THEN
    NEW.source_connector_version_id:=NULL;
    NEW.source_connector_definition_hash:=NULL;
    NEW.source_provenance:=jsonb_build_object('bindingMode','legacy_unpinned','runtimeExecution','disabled');
    RETURN NEW;
  END IF;
  SELECT version.* INTO connector_version
    FROM public.source_connectors source_connector
    JOIN public.source_connector_versions version
      ON version.organization_id=source_connector.organization_id
     AND version.id=source_connector.active_version_id
   WHERE source_connector.organization_id=NEW.organization_id
     AND version.id=case_record.source_connector_version_id
     AND source_connector.lifecycle_status='active' AND version.status='active'
     AND version.definition_hash=case_record.source_connector_definition_hash
   FOR SHARE OF source_connector,version;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active';
  END IF;
  SELECT * INTO connector FROM public.source_connectors
   WHERE organization_id=NEW.organization_id AND id=connector_version.connector_id FOR SHARE;
  IF NEW.source_connector_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_claim_required';
  END IF;
  IF NEW.source_connector_key<>connector.connector_key THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_claim_mismatch';
  END IF;
  expected_source:=CASE connector_version.definition->>'connectorType'
    WHEN 'manual_upload' THEN 'internal_upload'
    WHEN 'form' THEN 'fillout'
    WHEN 'email' THEN 'email'
    WHEN 'api' THEN 'api'
    ELSE NULL
  END;
  IF expected_source IS NULL OR NEW.source<>expected_source THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_transport_mismatch';
  END IF;
  NEW.source_connector_version_id:=connector_version.id;
  NEW.source_connector_definition_hash:=connector_version.definition_hash;
  NEW.source_provenance:=jsonb_build_object(
    'bindingMode','governed_version','connectorKey',connector.connector_key,
    'connectorVersionId',connector_version.id,'connectorVersion',connector_version.version,
    'connectorRevision',connector_version.revision,'definitionHash',connector_version.definition_hash,
    'connectorType',connector_version.definition->>'connectorType',
    'runtimeExecution','disabled','externalDelivery','disabled'
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER submission_enforce_connector_provenance
  BEFORE INSERT ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public.dop_enforce_submission_connector_provenance();

REVOKE ALL ON FUNCTION public.dop_case_plan_source_type_matches(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_pin_case_plan_source_connector() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_pin_case_plan_preview_connector() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_pin_case_plan_approval_connector() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_pin_generated_case_connector() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_enforce_submission_connector_provenance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_case_plan_source_type_matches(text,text) TO dop_app;

COMMIT;
