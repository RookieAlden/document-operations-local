BEGIN;

-- M45 starts with a fail-closed boundary. This migration does not approve real
-- data or create PROD. It defines the evidence that a future, separately
-- approved production Case must possess before the runtime may accept a byte.
CREATE TABLE public.production_data_admission_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  version integer NOT NULL CHECK (version > 0),
  subject_id uuid NOT NULL REFERENCES public.subjects(id),
  case_id uuid NOT NULL REFERENCES public.cases(id),
  status text NOT NULL CHECK (status IN ('draft','active','revoked')),
  processing_scope jsonb NOT NULL CHECK (jsonb_typeof(processing_scope)='object'),
  consent_evidence jsonb NOT NULL CHECK (jsonb_typeof(consent_evidence)='object'),
  privacy_evidence jsonb NOT NULL CHECK (jsonb_typeof(privacy_evidence)='object'),
  residency_decision jsonb NOT NULL CHECK (jsonb_typeof(residency_decision)='object'),
  production_resources jsonb NOT NULL CHECK (jsonb_typeof(production_resources)='object'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  created_by_actor_id uuid NOT NULL REFERENCES public.actors(id),
  activated_by_actor_id uuid REFERENCES public.actors(id),
  activation_approval_reference text,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 12 AND 1000),
  idempotency_key uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  activation_event_id uuid REFERENCES public.workflow_events(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (valid_until > valid_from),
  CHECK ((status='active')=(activated_by_actor_id IS NOT NULL AND activation_event_id IS NOT NULL
    AND activation_approval_reference IS NOT NULL)),
  CHECK ((status='revoked')=(revoked_at IS NOT NULL)),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,policy_key,version),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,event_id),
  CONSTRAINT production_admission_subject_same_org_fk FOREIGN KEY (organization_id,subject_id)
    REFERENCES public.subjects(organization_id,id),
  CONSTRAINT production_admission_case_same_org_fk FOREIGN KEY (organization_id,case_id)
    REFERENCES public.cases(organization_id,id),
  CONSTRAINT production_admission_creator_same_org_fk FOREIGN KEY (organization_id,created_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT production_admission_activator_same_org_fk FOREIGN KEY (organization_id,activated_by_actor_id)
    REFERENCES public.actors(organization_id,id),
  CONSTRAINT production_admission_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id),
  CONSTRAINT production_admission_activation_event_same_org_fk FOREIGN KEY (organization_id,activation_event_id)
    REFERENCES public.workflow_events(organization_id,id)
);

CREATE UNIQUE INDEX one_active_production_data_admission_per_case
  ON public.production_data_admission_policies(organization_id,case_id) WHERE status='active';
CREATE INDEX production_data_admission_history
  ON public.production_data_admission_policies(organization_id,subject_id,case_id,version DESC);

CREATE TABLE public.data_admission_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  case_id uuid NOT NULL REFERENCES public.cases(id),
  policy_id uuid,
  runtime_environment text NOT NULL CHECK (runtime_environment IN ('DEV','UAT','PROD')),
  data_mode text NOT NULL CHECK (data_mode IN ('synthetic_only','real_data')),
  decision text NOT NULL CHECK (decision IN ('allowed','blocked')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,119}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 12 AND 500),
  event_id uuid NOT NULL REFERENCES public.workflow_events(id),
  evaluated_at timestamptz NOT NULL,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,event_id),
  CONSTRAINT data_admission_decision_case_same_org_fk FOREIGN KEY (organization_id,case_id)
    REFERENCES public.cases(organization_id,id),
  CONSTRAINT data_admission_decision_policy_same_org_fk FOREIGN KEY (organization_id,policy_id)
    REFERENCES public.production_data_admission_policies(organization_id,id),
  CONSTRAINT data_admission_decision_event_same_org_fk FOREIGN KEY (organization_id,event_id)
    REFERENCES public.workflow_events(organization_id,id)
);
CREATE INDEX data_admission_decisions_case_history
  ON public.data_admission_decisions(organization_id,case_id,evaluated_at DESC);

ALTER TABLE public.production_data_admission_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_admission_decisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.production_data_admission_policies,public.data_admission_decisions TO dop_app;
CREATE POLICY dop_tenant_isolation ON public.production_data_admission_policies FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());
CREATE POLICY dop_tenant_isolation ON public.data_admission_decisions FOR SELECT TO dop_app
  USING (organization_id=public.dop_current_organization_id());

CREATE OR REPLACE FUNCTION public.dop_data_admission_evidence_valid(
  p_scope jsonb,p_consent jsonb,p_privacy jsonb,p_residency jsonb,p_resources jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
BEGIN
  RETURN
    jsonb_typeof(p_scope->'allowedSourceTypes')='array'
    AND jsonb_array_length(p_scope->'allowedSourceTypes')>0
    AND jsonb_typeof(p_scope->'allowedMimeTypes')='array'
    AND jsonb_array_length(p_scope->'allowedMimeTypes')>0
    AND jsonb_typeof(p_scope->'purposes')='array'
    AND jsonb_array_length(p_scope->'purposes')>0
    AND jsonb_typeof(p_scope->'documentTypeCodes')='array'
    AND jsonb_array_length(p_scope->'documentTypeCodes')>0
    AND coalesce((p_scope->>'maximumFilesPerSubmission')::integer,0) BETWEEN 1 AND 100
    AND coalesce((p_scope->>'maximumFileBytes')::bigint,0) BETWEEN 1 AND 104857600
    AND (p_scope->>'periodStart')::date <= (p_scope->>'periodEnd')::date
    AND length(coalesce(p_consent->>'reference','')) BETWEEN 12 AND 1000
    AND coalesce(p_consent->>'sha256','') ~ '^[0-9a-f]{64}$'
    AND coalesce((p_consent->>'realDataApproved')::boolean,false)=true
    AND (p_consent->>'signedAt')::timestamptz IS NOT NULL
    AND length(coalesce(p_privacy->>'reference','')) BETWEEN 12 AND 1000
    AND coalesce(p_privacy->>'sha256','') ~ '^[0-9a-f]{64}$'
    AND coalesce((p_privacy->>'approved')::boolean,false)=true
    AND length(coalesce(p_residency->>'persistentRegion','')) BETWEEN 2 AND 120
    AND length(coalesce(p_residency->>'computeRegion','')) BETWEEN 2 AND 120
    AND jsonb_typeof(p_residency->'processors')='array'
    AND jsonb_array_length(p_residency->'processors')>0
    AND (
      coalesce((p_residency->>'crossBorderRequired')::boolean,false)=false
      OR (coalesce((p_residency->>'crossBorderApproved')::boolean,false)=true
          AND length(coalesce(p_residency->>'crossBorderDecisionReference','')) BETWEEN 12 AND 1000)
    )
    AND p_resources->>'environment'='PROD'
    AND coalesce((p_resources->>'isolatedFromDevAndUat')::boolean,false)=true
    AND coalesce((p_resources->>'backupVerified')::boolean,false)=true
    AND coalesce((p_resources->>'secretRotationVerified')::boolean,false)=true
    AND length(coalesce(p_resources->>'resourceReference','')) BETWEEN 12 AND 1000;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.dop_create_production_data_admission_draft(
  p_actor_id uuid,p_policy_key text,p_subject_id uuid,p_case_id uuid,
  p_processing_scope jsonb,p_consent_evidence jsonb,p_privacy_evidence jsonb,
  p_residency_decision jsonb,p_production_resources jsonb,
  p_valid_from timestamptz,p_valid_until timestamptz,p_reason text,
  p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  existing public.production_data_admission_policies%ROWTYPE;
  policy_id uuid:=gen_random_uuid(); event_id uuid:=gen_random_uuid(); next_version integer;
BEGIN
  SELECT * INTO existing FROM public.production_data_admission_policies
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate','policyId',existing.id,'status',existing.status); END IF;
  IF p_policy_key !~ '^[a-z0-9][a-z0-9._-]{2,119}$'
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000
     OR p_valid_until<=p_valid_from THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_request');
  END IF;
  IF NOT public.dop_data_admission_evidence_valid(p_processing_scope,p_consent_evidence,
      p_privacy_evidence,p_residency_decision,p_production_resources) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','evidence_incomplete');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.cases c JOIN public.subjects s
      ON s.organization_id=c.organization_id AND s.id=c.subject_id
     WHERE c.organization_id=org_id AND c.id=p_case_id AND c.subject_id=p_subject_id
       AND c.status<>'cancelled' AND s.status='active'
       AND s.attributes @> '{"synthetic":false}'::jsonb
       AND c.config_snapshot @> '{"synthetic_only":false}'::jsonb
  ) THEN RETURN jsonb_build_object('outcome','conflict','reason','real_subject_and_case_required'); END IF;
  SELECT coalesce(max(version),0)+1 INTO next_version FROM public.production_data_admission_policies
   WHERE organization_id=org_id AND policy_key=p_policy_key;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'production-admission-draft|'||p_idempotency_key,
    'DataAdmission.DraftRecorded',1,'case',p_case_id,p_correlation_id,p_actor_id,
    'dop.governance.production-data-admission.v1',jsonb_build_object(
      'policyId',policy_id,'policyKey',p_policy_key,'version',next_version,
      'realDataApproved',true,'runtimeEnabled',false),p_now);
  INSERT INTO public.production_data_admission_policies(id,organization_id,policy_key,version,
    subject_id,case_id,status,processing_scope,consent_evidence,privacy_evidence,
    residency_decision,production_resources,valid_from,valid_until,created_by_actor_id,
    reason,idempotency_key,event_id,created_at,updated_at)
  VALUES(policy_id,org_id,p_policy_key,next_version,p_subject_id,p_case_id,'draft',
    p_processing_scope,p_consent_evidence,p_privacy_evidence,p_residency_decision,
    p_production_resources,p_valid_from,p_valid_until,p_actor_id,btrim(p_reason),
    p_idempotency_key,event_id,p_now,p_now);
  RETURN jsonb_build_object('outcome','completed','policyId',policy_id,'status','draft',
    'version',next_version,'runtimeEnabled',false);
END $$;

CREATE OR REPLACE FUNCTION public.dop_activate_production_data_admission(
  p_actor_id uuid,p_policy_id uuid,p_external_approval_reference text,p_reason text,
  p_idempotency_key uuid,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  policy_row public.production_data_admission_policies%ROWTYPE;
  existing_event public.workflow_events%ROWTYPE; activation_event_id_value uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO existing_event FROM public.workflow_events
   WHERE organization_id=org_id AND idempotency_key='production-admission-activate|'||p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('outcome','duplicate',
    'policyId',existing_event.payload->>'policyId'); END IF;
  SELECT * INTO policy_row FROM public.production_data_admission_policies
   WHERE organization_id=org_id AND id=p_policy_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF policy_row.status<>'draft' THEN RETURN jsonb_build_object('outcome','conflict','reason','draft_required'); END IF;
  IF p_now<policy_row.valid_from OR p_now>=policy_row.valid_until
     OR length(btrim(p_external_approval_reference)) NOT BETWEEN 12 AND 1000
     OR length(btrim(p_reason)) NOT BETWEEN 12 AND 1000
     OR NOT public.dop_data_admission_evidence_valid(policy_row.processing_scope,
       policy_row.consent_evidence,policy_row.privacy_evidence,policy_row.residency_decision,
       policy_row.production_resources) THEN
    RETURN jsonb_build_object('outcome','conflict','reason','activation_gate_incomplete');
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_data_admission_policies
      WHERE organization_id=org_id AND case_id=policy_row.case_id AND status='active') THEN
    RETURN jsonb_build_object('outcome','conflict','reason','active_policy_exists');
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(activation_event_id_value,org_id,'production-admission-activate|'||p_idempotency_key,
    'DataAdmission.Activated',1,'case',policy_row.case_id,p_correlation_id,p_actor_id,
    'dop.governance.production-data-admission.v1',jsonb_build_object(
      'policyId',policy_row.id,'policyKey',policy_row.policy_key,'version',policy_row.version,
      'approvalReference',btrim(p_external_approval_reference),'runtimeEnabled',true),p_now);
  UPDATE public.production_data_admission_policies SET status='active',
    activated_by_actor_id=p_actor_id,activation_approval_reference=btrim(p_external_approval_reference),
    activation_event_id=activation_event_id_value,reason=btrim(p_reason),updated_at=p_now
   WHERE id=policy_row.id;
  RETURN jsonb_build_object('outcome','completed','policyId',policy_row.id,'status','active',
    'runtimeEnabled',true);
END $$;

CREATE OR REPLACE FUNCTION public.dop_revoke_production_data_admission(
  p_actor_id uuid,p_policy_id uuid,p_reason text,p_idempotency_key uuid,
  p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_require_active_admin(p_actor_id);
  policy_row public.production_data_admission_policies%ROWTYPE; event_id uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO policy_row FROM public.production_data_admission_policies
   WHERE organization_id=org_id AND id=p_policy_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
  IF policy_row.status='revoked' THEN RETURN jsonb_build_object('outcome','duplicate','policyId',policy_row.id); END IF;
  IF length(btrim(p_reason)) NOT BETWEEN 12 AND 1000 THEN
    RETURN jsonb_build_object('outcome','conflict','reason','invalid_reason');
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'production-admission-revoke|'||p_idempotency_key,
    'DataAdmission.Revoked',1,'case',policy_row.case_id,p_correlation_id,p_actor_id,
    'dop.governance.production-data-admission.v1',jsonb_build_object(
      'policyId',policy_row.id,'previousStatus',policy_row.status,'runtimeEnabled',false),p_now)
  ON CONFLICT(organization_id,idempotency_key) DO NOTHING;
  UPDATE public.production_data_admission_policies SET status='revoked',reason=btrim(p_reason),
    revoked_at=p_now,updated_at=p_now,activated_by_actor_id=NULL,
    activation_approval_reference=NULL,activation_event_id=NULL WHERE id=policy_row.id;
  RETURN jsonb_build_object('outcome','completed','policyId',policy_row.id,'status','revoked',
    'runtimeEnabled',false);
END $$;

CREATE OR REPLACE FUNCTION public.dop_evaluate_submission_data_admission(
  p_case_id uuid,p_runtime_environment text,p_data_mode text,p_policy_key text,
  p_source_type text,p_file_count integer,p_max_file_bytes bigint,p_mime_types text[],
  p_request_fingerprint text,p_idempotency_key text,p_correlation_id uuid,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  org_id uuid:=public.dop_current_organization_id(); case_row public.cases%ROWTYPE;
  subject_row public.subjects%ROWTYPE; policy_row public.production_data_admission_policies%ROWTYPE;
  existing public.data_admission_decisions%ROWTYPE; allowed boolean:=false;
  reason_code text:='admission_policy_required'; decision_id uuid:=gen_random_uuid();
  event_id uuid:=gen_random_uuid(); policy_id uuid; allowed_sources text[]; allowed_mimes text[];
BEGIN
  IF p_runtime_environment NOT IN ('DEV','UAT','PROD') OR p_data_mode NOT IN ('synthetic_only','real_data')
     OR p_file_count NOT BETWEEN 1 AND 100 OR p_max_file_bytes<0
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' OR length(p_idempotency_key) NOT BETWEEN 12 AND 500 THEN
    RETURN jsonb_build_object('outcome','conflict','allowed',false,'reason','invalid_request');
  END IF;
  SELECT * INTO existing FROM public.data_admission_decisions
   WHERE organization_id=org_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint<>p_request_fingerprint THEN
      RETURN jsonb_build_object('outcome','conflict','allowed',false,'reason','idempotency_payload_mismatch');
    END IF;
    RETURN jsonb_build_object('outcome','duplicate','allowed',existing.decision='allowed',
      'reason',existing.reason_code,'decisionId',existing.id,'policyId',existing.policy_id);
  END IF;
  SELECT * INTO case_row FROM public.cases WHERE organization_id=org_id AND id=p_case_id AND status<>'cancelled';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','allowed',false,'reason','case_not_found'); END IF;
  SELECT * INTO STRICT subject_row FROM public.subjects
   WHERE organization_id=org_id AND id=case_row.subject_id;
  IF p_runtime_environment IN ('DEV','UAT') THEN
    IF p_data_mode='synthetic_only' AND subject_row.status='active'
       AND coalesce((subject_row.attributes->>'synthetic')::boolean,false)=true THEN
      allowed:=true; reason_code:='synthetic_subject_allowed';
    ELSE reason_code:='nonproduction_real_data_blocked'; END IF;
  ELSE
    IF subject_row.status<>'active'
       OR NOT subject_row.attributes @> '{"synthetic":false}'::jsonb
       OR NOT case_row.config_snapshot @> '{"synthetic_only":false}'::jsonb THEN
      reason_code:='production_subject_and_case_not_authorized';
    ELSIF p_data_mode<>'real_data' THEN reason_code:='production_real_data_claim_required';
    ELSIF coalesce(p_policy_key,'')='' THEN reason_code:='production_policy_key_required';
    ELSE
      SELECT * INTO policy_row FROM public.production_data_admission_policies
       WHERE organization_id=org_id AND case_id=case_row.id AND subject_id=case_row.subject_id
         AND policy_key=p_policy_key AND status='active' ORDER BY version DESC LIMIT 1;
      IF NOT FOUND THEN reason_code:='active_production_policy_required';
      ELSIF p_now<policy_row.valid_from OR p_now>=policy_row.valid_until THEN reason_code:='production_policy_expired';
      ELSIF NOT public.dop_data_admission_evidence_valid(policy_row.processing_scope,
          policy_row.consent_evidence,policy_row.privacy_evidence,policy_row.residency_decision,
          policy_row.production_resources) THEN reason_code:='production_policy_evidence_invalid';
      ELSIF case_row.period_start IS DISTINCT FROM (policy_row.processing_scope->>'periodStart')::date
         OR case_row.period_end IS DISTINCT FROM (policy_row.processing_scope->>'periodEnd')::date THEN reason_code:='production_period_out_of_scope';
      ELSE
        policy_id:=policy_row.id;
        SELECT coalesce(array_agg(value),ARRAY[]::text[]) INTO allowed_sources
          FROM jsonb_array_elements_text(policy_row.processing_scope->'allowedSourceTypes');
        SELECT coalesce(array_agg(lower(value)),ARRAY[]::text[]) INTO allowed_mimes
          FROM jsonb_array_elements_text(policy_row.processing_scope->'allowedMimeTypes');
        IF NOT p_source_type=ANY(allowed_sources) THEN reason_code:='production_source_out_of_scope';
        ELSIF p_file_count>(policy_row.processing_scope->>'maximumFilesPerSubmission')::integer
           OR p_max_file_bytes>(policy_row.processing_scope->>'maximumFileBytes')::bigint THEN
          reason_code:='production_file_boundary_exceeded';
        ELSIF cardinality(p_mime_types)<>p_file_count
           OR EXISTS(SELECT 1 FROM unnest(p_mime_types) mime
                      WHERE coalesce(lower(mime),'__missing__')<>ALL(allowed_mimes)) THEN
          reason_code:='production_mime_out_of_scope';
        ELSE allowed:=true; reason_code:='active_production_policy_allowed'; policy_id:=policy_row.id; END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,producer,payload,occurred_at)
  VALUES(event_id,org_id,'data-admission-decision|'||p_idempotency_key,
    CASE WHEN allowed THEN 'DataAdmission.Allowed' ELSE 'DataAdmission.Blocked' END,
    1,'case',case_row.id,p_correlation_id,'dop.core.data-admission.v1',jsonb_build_object(
      'runtimeEnvironment',p_runtime_environment,'dataMode',p_data_mode,'decision',
      CASE WHEN allowed THEN 'allowed' ELSE 'blocked' END,'reasonCode',reason_code,
      'policyId',policy_id,'fileCount',p_file_count),p_now);
  INSERT INTO public.data_admission_decisions(id,organization_id,case_id,policy_id,runtime_environment,
    data_mode,decision,reason_code,request_fingerprint,correlation_id,idempotency_key,event_id,evaluated_at)
  VALUES(decision_id,org_id,case_row.id,policy_id,p_runtime_environment,p_data_mode,
    CASE WHEN allowed THEN 'allowed' ELSE 'blocked' END,reason_code,p_request_fingerprint,
    p_correlation_id,p_idempotency_key,event_id,p_now);
  RETURN jsonb_build_object('outcome','completed','allowed',allowed,'reason',reason_code,
    'decisionId',decision_id,'policyId',policy_id);
END $$;

CREATE OR REPLACE FUNCTION public.dop_reject_data_admission_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'data admission decisions are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER data_admission_decisions_immutable BEFORE UPDATE OR DELETE ON public.data_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION public.dop_reject_data_admission_decision_mutation();

REVOKE ALL ON public.production_data_admission_policies,public.data_admission_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_data_admission_evidence_valid(jsonb,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_create_production_data_admission_draft(uuid,text,uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_activate_production_data_admission(uuid,uuid,text,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_revoke_production_data_admission(uuid,uuid,text,uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_evaluate_submission_data_admission(uuid,text,text,text,text,integer,bigint,text[],text,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_reject_data_admission_decision_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_evaluate_submission_data_admission(uuid,text,text,text,text,integer,bigint,text[],text,text,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_create_production_data_admission_draft(uuid,text,uuid,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_activate_production_data_admission(uuid,uuid,text,text,uuid,uuid,timestamptz) TO dop_app;
GRANT EXECUTE ON FUNCTION public.dop_revoke_production_data_admission(uuid,uuid,text,uuid,uuid,timestamptz) TO dop_app;

COMMENT ON TABLE public.production_data_admission_policies IS
'M45 versioned real-data admission evidence. A draft never enables runtime; activation requires a separate external approval reference and complete PROD evidence.';
COMMENT ON TABLE public.data_admission_decisions IS
'M45 append-only, content-free intake admission audit. Request fingerprints and policy IDs are retained; filenames and document contents are not.';

COMMIT;
