BEGIN;

-- M22 keeps immutable Connector Definitions intact while deriving a normalized
-- enforcement profile for every version. Existing M20 versions receive an
-- explicit, auditable compatibility default for file count; every new
-- definition must declare its own limit.
ALTER TABLE public.source_connector_versions
  ADD COLUMN enforcement_profile jsonb;

ALTER TABLE public.submissions
  ADD COLUMN canonical_envelope jsonb;

ALTER TABLE public.documents
  ADD COLUMN source_envelope jsonb;

CREATE OR REPLACE FUNCTION public.dop_source_connector_enforcement_profile(p_definition jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path=public,pg_temp
AS $$
  SELECT jsonb_build_object(
    'schemaVersion','1.0',
    'policySource',CASE WHEN p_definition#>'{dataBoundary,maxFilesPerSubmission}' IS NULL
      THEN 'legacy_safe_default' ELSE 'connector_definition' END,
    'capabilities',coalesce(p_definition->'capabilities','[]'::jsonb),
    'maxFilesPerSubmission',coalesce((p_definition#>>'{dataBoundary,maxFilesPerSubmission}')::integer,100),
    'maxFileBytes',(p_definition#>>'{dataBoundary,maxFileBytes}')::bigint,
    'allowedMimeTypes',coalesce(p_definition#>'{dataBoundary,allowedMimeTypes}','[]'::jsonb),
    'syntheticOnly',coalesce((p_definition#>>'{dataBoundary,syntheticOnly}')::boolean,false),
    'externalDelivery',coalesce(p_definition#>>'{dataBoundary,externalDelivery}','disabled'),
    'runtimeExecution',coalesce(p_definition#>>'{activationPolicy,runtimeExecution}','disabled')
  )
$$;

CREATE OR REPLACE FUNCTION public.dop_source_connector_capability_policy_error(p_definition jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path=public,pg_temp
AS $$
DECLARE connector_type text:=p_definition->>'connectorType'; transport_mode text:=p_definition->>'transport';
  capabilities jsonb:=p_definition->'capabilities'; max_files integer;
BEGIN
  IF p_definition#>'{dataBoundary,maxFilesPerSubmission}' IS NULL THEN
    RETURN 'source_connector_file_count_policy_required';
  END IF;
  BEGIN max_files:=(p_definition#>>'{dataBoundary,maxFilesPerSubmission}')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'source_connector_file_count_policy_invalid';
  END;
  IF max_files NOT BETWEEN 1 AND 100 THEN RETURN 'source_connector_file_count_policy_invalid'; END IF;
  IF jsonb_typeof(capabilities)<>'array' OR NOT capabilities ? 'documents' THEN
    RETURN 'source_connector_documents_capability_required';
  END IF;
  IF capabilities ? 'attachments' AND NOT capabilities ? 'documents' THEN
    RETURN 'source_connector_attachment_capability_invalid';
  END IF;
  IF connector_type='form' AND NOT capabilities ? 'webhook' THEN
    RETURN 'source_connector_webhook_capability_required';
  END IF;
  IF connector_type='email' AND NOT capabilities ? 'attachments' THEN
    RETURN 'source_connector_attachment_capability_required';
  END IF;
  IF transport_mode='pull' AND NOT capabilities ? 'polling' THEN
    RETURN 'source_connector_polling_capability_required';
  END IF;
  IF transport_mode<>'pull' AND capabilities ? 'polling' THEN
    RETURN 'source_connector_polling_capability_invalid';
  END IF;
  IF capabilities ? 'webhook' AND transport_mode<>'push' THEN
    RETURN 'source_connector_webhook_capability_invalid';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_prepare_source_connector_enforcement_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE policy_error text; matching_legacy_exists boolean;
BEGIN
  policy_error:=public.dop_source_connector_capability_policy_error(NEW.definition);
  IF policy_error='source_connector_file_count_policy_required' THEN
    SELECT EXISTS(
      SELECT 1 FROM public.source_connector_versions existing
       WHERE existing.connector_id=NEW.connector_id
         AND existing.definition_hash=NEW.definition_hash
         AND existing.definition=NEW.definition
    ) INTO matching_legacy_exists;
    IF NOT matching_legacy_exists THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE=policy_error;
    END IF;
  ELSIF policy_error IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE=policy_error;
  END IF;
  NEW.enforcement_profile:=public.dop_source_connector_enforcement_profile(NEW.definition);
  RETURN NEW;
END;
$$;

UPDATE public.source_connector_versions
   SET enforcement_profile=public.dop_source_connector_enforcement_profile(definition);

ALTER TABLE public.source_connector_versions
  ALTER COLUMN enforcement_profile SET NOT NULL,
  ADD CONSTRAINT source_connector_enforcement_profile_valid CHECK (
    jsonb_typeof(enforcement_profile)='object'
    AND enforcement_profile->>'schemaVersion'='1.0'
    AND (enforcement_profile->>'policySource') IN ('connector_definition','legacy_safe_default')
    AND (enforcement_profile->>'maxFilesPerSubmission')::integer BETWEEN 1 AND 100
    AND (enforcement_profile->>'maxFileBytes')::bigint BETWEEN 1 AND 104857600
    AND jsonb_typeof(enforcement_profile->'allowedMimeTypes')='array'
    AND jsonb_typeof(enforcement_profile->'capabilities')='array'
    AND enforcement_profile->>'externalDelivery'='disabled'
    AND enforcement_profile->>'runtimeExecution'='disabled'
  );

CREATE TRIGGER source_connector_prepare_enforcement_profile
  BEFORE INSERT ON public.source_connector_versions
  FOR EACH ROW EXECUTE FUNCTION public.dop_prepare_source_connector_enforcement_profile();

ALTER TABLE public.submissions
  ADD CONSTRAINT submission_canonical_envelope_object CHECK (
    canonical_envelope IS NULL OR (
      jsonb_typeof(canonical_envelope)='object'
      AND canonical_envelope->>'schemaVersion'='1.0'
      AND canonical_envelope#>>'{safety,runtimeExecution}'='disabled'
      AND canonical_envelope#>>'{safety,externalDelivery}'='disabled'
    )
  );

ALTER TABLE public.documents
  ADD CONSTRAINT document_source_envelope_object CHECK (
    source_envelope IS NULL OR (
      jsonb_typeof(source_envelope)='object'
      AND source_envelope->>'schemaVersion'='1.0'
      AND source_envelope#>>'{validation,status}'='passed'
    )
  );

CREATE OR REPLACE FUNCTION public.dop_enforce_submission_connector_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE case_record public.cases%ROWTYPE; connector public.source_connectors%ROWTYPE;
  connector_version public.source_connector_versions%ROWTYPE; expected_source text;
  profile jsonb; capabilities jsonb; max_files integer;
BEGIN
  SELECT * INTO case_record FROM public.cases
   WHERE organization_id=NEW.organization_id AND id=NEW.case_id FOR SHARE;
  IF case_record.source_connector_version_id IS NULL THEN
    NEW.source_connector_version_id:=NULL;
    NEW.source_connector_definition_hash:=NULL;
    NEW.source_provenance:=jsonb_build_object('bindingMode','legacy_unpinned','runtimeExecution','disabled');
    NEW.canonical_envelope:=jsonb_build_object(
      'schemaVersion','1.0','bindingMode','legacy_unpinned',
      'submission',jsonb_build_object('sourceType',NEW.source,'sourceSubmissionId',NEW.source_submission_id,
        'fileCount',NEW.expected_document_count),
      'boundary',jsonb_build_object('policySource','legacy_safe_default','maxFilesPerSubmission',100),
      'safety',jsonb_build_object('runtimeExecution','disabled','externalDelivery','disabled')
    );
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
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_not_active'; END IF;
  SELECT * INTO connector FROM public.source_connectors
   WHERE organization_id=NEW.organization_id AND id=connector_version.connector_id FOR SHARE;
  IF NEW.source_connector_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_claim_required';
  END IF;
  IF NEW.source_connector_key<>connector.connector_key THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_claim_mismatch';
  END IF;
  expected_source:=CASE connector_version.definition->>'connectorType'
    WHEN 'manual_upload' THEN 'internal_upload' WHEN 'form' THEN 'fillout'
    WHEN 'email' THEN 'email' WHEN 'api' THEN 'api' ELSE NULL END;
  IF expected_source IS NULL OR NEW.source<>expected_source THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_transport_mismatch';
  END IF;
  profile:=connector_version.enforcement_profile;
  capabilities:=profile->'capabilities';
  max_files:=(profile->>'maxFilesPerSubmission')::integer;
  IF NOT capabilities ? 'documents' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_documents_capability_required';
  END IF;
  IF NEW.source='fillout' AND NOT capabilities ? 'webhook' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_webhook_capability_required';
  END IF;
  IF NEW.source='email' AND NOT capabilities ? 'attachments' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_attachment_capability_required';
  END IF;
  IF NEW.expected_document_count IS NULL OR NEW.expected_document_count<1 OR NEW.expected_document_count>max_files THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_file_count_exceeded';
  END IF;
  NEW.source_connector_version_id:=connector_version.id;
  NEW.source_connector_definition_hash:=connector_version.definition_hash;
  NEW.source_provenance:=jsonb_build_object(
    'bindingMode','governed_version','connectorKey',connector.connector_key,
    'connectorVersionId',connector_version.id,'connectorVersion',connector_version.version,
    'connectorRevision',connector_version.revision,'definitionHash',connector_version.definition_hash,
    'connectorType',connector_version.definition->>'connectorType',
    'enforcementProfile',profile,'runtimeExecution','disabled','externalDelivery','disabled'
  );
  NEW.canonical_envelope:=jsonb_build_object(
    'schemaVersion','1.0','bindingMode','governed_version',
    'connector',jsonb_build_object('key',connector.connector_key,'versionId',connector_version.id,
      'version',connector_version.version,'revision',connector_version.revision,
      'definitionHash',connector_version.definition_hash,'type',connector_version.definition->>'connectorType',
      'transport',connector_version.definition->>'transport'),
    'submission',jsonb_build_object('sourceType',NEW.source,'sourceSubmissionId',NEW.source_submission_id,
      'sourceReference',NEW.raw_payload_reference,'receivedAt',NEW.received_at,'fileCount',NEW.expected_document_count),
    'boundary',profile,
    'validation',jsonb_build_object('documentsCapability','passed','transportCapability','passed','fileCount','passed'),
    'safety',jsonb_build_object('runtimeExecution','disabled','externalDelivery','disabled')
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_enforce_document_source_envelope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE intake public.submissions%ROWTYPE; boundary jsonb; allowed_mime_types jsonb;
  max_file_bytes bigint; normalized_mime text;
BEGIN
  SELECT * INTO intake FROM public.submissions
   WHERE organization_id=NEW.organization_id AND id=NEW.submission_id FOR SHARE;
  IF NOT FOUND OR intake.case_id<>NEW.case_id THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='document_submission_context_mismatch';
  END IF;
  IF intake.source_connector_version_id IS NULL THEN
    NEW.source_envelope:=jsonb_build_object(
      'schemaVersion','1.0','bindingMode','legacy_unpinned','submissionId',intake.id,
      'file',jsonb_build_object('sourceFileId',NEW.source_file_id,'originalFilename',NEW.original_filename,
        'declaredMimeType',NEW.declared_mime_type,'declaredSizeBytes',NEW.size_bytes,
        'contentHashSha256',NEW.content_hash_sha256,'downloadReference','documents.source_download_ref'),
      'validation',jsonb_build_object('status','passed','policySource','legacy_safe_default')
    );
    RETURN NEW;
  END IF;
  boundary:=intake.canonical_envelope->'boundary';
  allowed_mime_types:=boundary->'allowedMimeTypes';
  max_file_bytes:=(boundary->>'maxFileBytes')::bigint;
  normalized_mime:=lower(btrim(coalesce(NEW.declared_mime_type,'')));
  IF normalized_mime='' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_declared_mime_required';
  END IF;
  IF NEW.size_bytes IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_declared_size_required';
  END IF;
  IF NOT allowed_mime_types ? normalized_mime THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_mime_not_allowed';
  END IF;
  IF NEW.size_bytes>max_file_bytes THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source_connector_file_too_large';
  END IF;
  NEW.declared_mime_type:=normalized_mime;
  NEW.source_envelope:=jsonb_build_object(
    'schemaVersion','1.0','bindingMode','governed_version','submissionId',intake.id,
    'connector',intake.canonical_envelope->'connector',
    'file',jsonb_build_object('sourceFileId',NEW.source_file_id,'originalFilename',NEW.original_filename,
      'declaredMimeType',normalized_mime,'declaredSizeBytes',NEW.size_bytes,
      'contentHashSha256',NEW.content_hash_sha256,'downloadReference','documents.source_download_ref'),
    'boundary',jsonb_build_object('maxFileBytes',max_file_bytes,'allowedMimeTypes',allowed_mime_types),
    'validation',jsonb_build_object('status','passed','mimeType','passed','fileSize','passed')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_enforce_source_envelope
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.dop_enforce_document_source_envelope();

REVOKE ALL ON FUNCTION public.dop_source_connector_enforcement_profile(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_source_connector_capability_policy_error(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_prepare_source_connector_enforcement_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_enforce_submission_connector_provenance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_enforce_document_source_envelope() FROM PUBLIC;

COMMIT;
