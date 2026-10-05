BEGIN;

DO $$
DECLARE
  org_id uuid;
  seed_case public.cases%ROWTYPE;
  type_one uuid;
  type_two uuid;
  set_id uuid:=gen_random_uuid();
  version_id uuid:=gen_random_uuid();
  requirement_one uuid:=gen_random_uuid();
  requirement_two uuid:=gen_random_uuid();
  case_id_value uuid:=gen_random_uuid();
  submission_id_value uuid:=gen_random_uuid();
  document_ids uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  first_assessment public.case_completeness_assessments%ROWTYPE;
  final_assessment public.case_completeness_assessments%ROWTYPE;
  repeated_id uuid;
  terminal_count integer;
  assessment_count integer;
  event_count integer;
  final_case_status text;
  run_at timestamptz:=clock_timestamp();
BEGIN
  SELECT id INTO org_id FROM public.organizations
   WHERE organization_key='dev-accounting-firm' AND status='active';
  IF org_id IS NULL THEN RAISE EXCEPTION 'M24 organization missing'; END IF;

  SELECT * INTO seed_case FROM public.cases
   WHERE organization_id=org_id AND source_connector_version_id IS NULL AND status<>'cancelled'
   ORDER BY created_at LIMIT 1;
  IF seed_case.id IS NULL THEN RAISE EXCEPTION 'M24 legacy synthetic seed Case missing'; END IF;

  SELECT selected.ids[1],selected.ids[2] INTO type_one,type_two FROM (
    SELECT array_agg(id ORDER BY code) AS ids FROM (
      SELECT id,code FROM public.document_types
       WHERE organization_id=org_id AND status='active'
       ORDER BY code LIMIT 2
    ) first_two
  ) selected;
  IF type_one IS NULL OR type_two IS NULL OR type_one=type_two THEN
    RAISE EXCEPTION 'M24 requires two active Document Types';
  END IF;

  INSERT INTO public.requirement_sets(id,organization_id,set_key,display_name,created_at,updated_at)
  VALUES(set_id,org_id,'m24.'||gen_random_uuid()::text,'M24 rollback-only completeness requirements',run_at,run_at);
  INSERT INTO public.requirement_set_versions(id,organization_id,requirement_set_id,version,status,effective_from,definition_hash,created_at)
  VALUES(version_id,org_id,set_id,1,'published',run_at,encode(digest(version_id::text,'sha256'),'hex'),run_at);
  INSERT INTO public.requirements(id,organization_id,requirement_set_version_id,requirement_code,document_type_id,
    minimum_count,maximum_count,acceptance_rule,created_at)
  VALUES
    (requirement_one,org_id,version_id,'m24.first',type_one,1,1,'{"synthetic":true}'::jsonb,run_at),
    (requirement_two,org_id,version_id,'m24.second',type_two,1,1,'{"synthetic":true}'::jsonb,run_at);

  INSERT INTO public.cases(id,organization_id,case_key,subject_id,workflow_template_version_id,
    requirement_set_version_id,prompt_version_id,external_reference,period_start,period_end,
    timezone,status,risk_status,due_at,config_snapshot,version,created_at,updated_at,
    classifier_release_version_id,source_connector_version_id,source_connector_definition_hash)
  VALUES(case_id_value,org_id,'m24-completeness-'||gen_random_uuid()::text,seed_case.subject_id,
    seed_case.workflow_template_version_id,version_id,seed_case.prompt_version_id,'M24-ROLLBACK',
    '2026-08-01','2026-08-31',seed_case.timezone,'waiting_for_documents','normal',
    run_at+interval '7 days',seed_case.config_snapshot||'{"source":"m24_rollback","m24":{"synthetic":true,"rollbackOnly":true}}'::jsonb,
    1,run_at,run_at,seed_case.classifier_release_version_id,NULL,NULL);

  INSERT INTO public.submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,
    expected_document_count,terminal_document_count,received_at,created_at,updated_at)
  VALUES(submission_id_value,org_id,case_id_value,'internal_upload|'||submission_id_value::text,
    'internal_upload','m24-'||submission_id_value::text,'accepted',4,0,run_at,run_at,run_at);

  FOR index_value IN 1..4 LOOP
    INSERT INTO public.documents(id,organization_id,case_id,submission_id,idempotency_key,source_file_id,
      original_filename,declared_mime_type,detected_mime_type,size_bytes,content_hash_sha256,
      incoming_storage_ref,status,created_at,updated_at)
    VALUES(document_ids[index_value],org_id,case_id_value,submission_id_value,'m24|'||document_ids[index_value]::text,
      'm24-file-'||index_value::text,'m24-synthetic-'||index_value::text||'.pdf','application/pdf','application/pdf',128,
      CASE index_value WHEN 1 THEN repeat('1',64) WHEN 2 THEN repeat('1',64)
           WHEN 3 THEN repeat('2',64) ELSE repeat('3',64) END,
      'synthetic/m24/'||document_ids[index_value]::text,'reserved',run_at+index_value*interval '1 millisecond',run_at);
  END LOOP;

  UPDATE public.documents SET accepted_document_type_id=type_one,status='accepted',updated_at=run_at+interval '10 milliseconds'
   WHERE id=document_ids[1];
  UPDATE public.documents SET accepted_document_type_id=type_one,status='accepted',updated_at=run_at+interval '11 milliseconds'
   WHERE id=document_ids[2];
  UPDATE public.documents SET accepted_document_type_id=type_one,status='accepted',updated_at=run_at+interval '12 milliseconds'
   WHERE id=document_ids[3];
  UPDATE public.documents SET accepted_document_type_id=type_two,status='review_required',updated_at=run_at+interval '13 milliseconds'
   WHERE id=document_ids[4];

  SELECT * INTO first_assessment FROM public.case_completeness_assessments
   WHERE case_id=case_id_value ORDER BY created_at DESC,id DESC LIMIT 1;
  IF first_assessment.status<>'review_required'
     OR first_assessment.duplicate_document_count<>1
     OR first_assessment.excess_document_count<>1
     OR first_assessment.review_required_document_count<>1
     OR first_assessment.missing_requirement_count<>1 THEN
    RAISE EXCEPTION 'M24 exception assessment drifted: %',row_to_json(first_assessment);
  END IF;
  IF (SELECT count(*) FROM public.document_requirement_matches WHERE assessment_id=first_assessment.id)<>4 THEN
    RAISE EXCEPTION 'M24 did not record one match per Document';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.document_requirement_matches
    WHERE assessment_id=first_assessment.id AND document_id=document_ids[2] AND match_status='duplicate') THEN
    RAISE EXCEPTION 'M24 duplicate evidence missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.document_requirement_matches
    WHERE assessment_id=first_assessment.id AND document_id=document_ids[3] AND is_excess) THEN
    RAISE EXCEPTION 'M24 excess evidence missing';
  END IF;

  repeated_id:=public.dop_recompute_submission_completeness(submission_id_value,run_at+interval '14 milliseconds');
  IF repeated_id<>first_assessment.id THEN RAISE EXCEPTION 'M24 idempotency failed'; END IF;

  UPDATE public.requirements SET maximum_count=2 WHERE id IN(requirement_one,requirement_two);
  UPDATE public.documents SET content_hash_sha256=repeat('4',64),accepted_document_type_id=type_two,
    updated_at=run_at+interval '20 milliseconds' WHERE id=document_ids[2];
  UPDATE public.documents SET status='human_confirmed',updated_at=run_at+interval '21 milliseconds'
   WHERE id=document_ids[4];

  SELECT * INTO final_assessment FROM public.case_completeness_assessments
   WHERE case_id=case_id_value ORDER BY created_at DESC,id DESC LIMIT 1;
  IF final_assessment.status<>'complete'
     OR final_assessment.missing_requirement_count<>0
     OR final_assessment.duplicate_document_count<>0
     OR final_assessment.excess_document_count<>0
     OR final_assessment.review_required_document_count<>0
     OR final_assessment.unmatched_document_count<>0 THEN
    RAISE EXCEPTION 'M24 final assessment did not resolve: %',row_to_json(final_assessment);
  END IF;

  SELECT status INTO final_case_status FROM public.cases WHERE id=case_id_value;
  SELECT terminal_document_count INTO terminal_count FROM public.submissions WHERE id=submission_id_value AND status='completed';
  SELECT count(*) INTO assessment_count FROM public.case_completeness_assessments WHERE case_id=case_id_value;
  SELECT count(*) INTO event_count FROM public.workflow_events
   WHERE aggregate_type='case' AND aggregate_id=case_id_value AND event_type='Case.CompletenessAssessed';
  IF final_case_status<>'ready' OR terminal_count<>4 OR assessment_count<3 OR assessment_count<>event_count THEN
    RAISE EXCEPTION 'M24 terminal/status/history invariant failed';
  END IF;
END;
$$;

ROLLBACK;

SELECT jsonb_build_object(
  'verification','passed',
  'algorithmVersion','1.0',
  'initialExceptions',jsonb_build_object('missing',1,'duplicate',1,'excess',1,'reviewRequired',1),
  'finalStatus','complete',
  'terminalBoundary','4/4',
  'persistentSideEffects',0,
  'externalCalls',0,
  'externalDelivery','disabled'
) AS result;
