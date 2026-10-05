BEGIN;

-- A deletion proof may retain opaque identifiers, timestamps, hashes and
-- counts. Human-readable Case/Submission/Document keys and the final orphaned
-- Subject profile are content, not audit evidence. Redact them in the same
-- transaction that marks a Case content-deleted. A Subject is only redacted
-- after every Case that references it has already been content-deleted.
CREATE OR REPLACE FUNCTION public.dop_redact_deleted_case_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,extensions,pg_temp
AS $$
DECLARE
  subject_row public.subjects%ROWTYPE;
  deletion_actor_id uuid;
  subject_event_id uuid:=gen_random_uuid();
BEGIN
  UPDATE public.cases
     SET case_key='deleted-'||replace(NEW.id::text,'-','')
   WHERE organization_id=NEW.organization_id AND id=NEW.id;

  UPDATE public.submissions
     SET submission_key='deleted-'||replace(id::text,'-',''),
         source_submission_id='deleted-'||replace(id::text,'-',''),
         updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND case_id=NEW.id;

  UPDATE public.documents
     SET idempotency_key='deleted-'||replace(id::text,'-',''),
         updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND case_id=NEW.id;

  UPDATE public.workflow_events e
     SET idempotency_key='deleted-'||encode(digest(e.idempotency_key,'sha256'),'hex')
   WHERE e.organization_id=NEW.organization_id
     AND e.event_type<>'Case.ContentDeleted'
     AND (
       (e.aggregate_type='case' AND e.aggregate_id=NEW.id)
       OR (e.aggregate_type='document' AND e.aggregate_id IN (
         SELECT d.id FROM public.documents d
          WHERE d.organization_id=NEW.organization_id AND d.case_id=NEW.id
       ))
       OR (e.aggregate_type='issue' AND e.aggregate_id IN (
         SELECT i.id FROM public.issues i
          WHERE i.organization_id=NEW.organization_id AND i.case_id=NEW.id
       ))
       OR (e.aggregate_type='task' AND e.aggregate_id IN (
         SELECT t.id FROM public.tasks t
          WHERE t.organization_id=NEW.organization_id AND t.case_id=NEW.id
       ))
       OR (e.aggregate_type='delivery_job' AND e.aggregate_id IN (
         SELECT d.id FROM public.delivery_jobs d
          WHERE d.organization_id=NEW.organization_id AND d.case_id=NEW.id
       ))
     );

  IF EXISTS (
    SELECT 1 FROM public.cases remaining
     WHERE remaining.organization_id=NEW.organization_id
       AND remaining.subject_id=NEW.subject_id
       AND remaining.content_deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO subject_row FROM public.subjects
   WHERE organization_id=NEW.organization_id AND id=NEW.subject_id FOR UPDATE;
  IF NOT FOUND OR subject_row.display_name='[deleted]' THEN RETURN NEW; END IF;

  SELECT proof.deleted_by_actor_id INTO deletion_actor_id
    FROM public.data_deletion_proofs proof
   WHERE proof.organization_id=NEW.organization_id
     AND proof.id=NEW.content_deletion_proof_id;

  UPDATE public.work_configuration_releases
     SET manifest=jsonb_build_object('contentDeleted',true,'originalManifestHash',definition_hash,
           'proofId',NEW.content_deletion_proof_id),
         reason='Content deleted under retention policy.',
         idempotency_key='deleted-'||replace(id::text,'-','')
   WHERE organization_id=NEW.organization_id AND subject_id=NEW.subject_id;

  UPDATE public.subject_onboardings
     SET reason='Content deleted under retention policy.',
         idempotency_key='deleted-'||replace(id::text,'-','')
   WHERE organization_id=NEW.organization_id AND subject_id=NEW.subject_id;

  UPDATE public.case_plan_versions version
     SET definition=jsonb_build_object('contentDeleted',true,'originalDefinitionHash',version.definition_hash,
           'proofId',NEW.content_deletion_proof_id),
         reason='Content deleted under retention policy.',
         idempotency_key='deleted-'||replace(version.id::text,'-','')
   WHERE version.organization_id=NEW.organization_id
     AND version.case_plan_id IN (
       SELECT plan.id FROM public.case_plans plan
        WHERE plan.organization_id=NEW.organization_id AND plan.subject_id=NEW.subject_id
     );

  UPDATE public.case_plan_preview_batches preview
     SET candidates=(
           SELECT jsonb_agg(jsonb_build_object('contentDeleted',true,'position',item.ordinality)
             ORDER BY item.ordinality)
             FROM jsonb_array_elements(preview.candidates) WITH ORDINALITY item(value,ordinality)
         ),
         reason='Content deleted under retention policy.',
         idempotency_key='deleted-'||replace(preview.id::text,'-','')
   WHERE preview.organization_id=NEW.organization_id AND preview.subject_id=NEW.subject_id;

  UPDATE public.case_plan_approvals approval
     SET reason='Content deleted under retention policy.',
         idempotency_key='deleted-'||replace(approval.id::text,'-','')
   WHERE approval.organization_id=NEW.organization_id
     AND approval.preview_batch_id IN (
       SELECT preview.id FROM public.case_plan_preview_batches preview
        WHERE preview.organization_id=NEW.organization_id AND preview.subject_id=NEW.subject_id
     );

  UPDATE public.case_plans
     SET plan_key='deleted-'||replace(id::text,'-',''),display_name='[deleted]',status='retired',
         updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND subject_id=NEW.subject_id;

  UPDATE public.subject_message_recipient_allowlist
     SET status='revoked',reason='Content deleted under retention policy.',
         revoked_at=coalesce(revoked_at,NEW.content_deleted_at),updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND subject_id=NEW.subject_id;

  UPDATE public.workflow_events e
     SET payload=jsonb_build_object('contentDeleted',true,
           'originalPayloadHash',encode(digest(e.payload::text,'sha256'),'hex'),
           'proofId',NEW.content_deletion_proof_id),
         idempotency_key='deleted-'||encode(digest(e.idempotency_key,'sha256'),'hex')
   WHERE e.organization_id=NEW.organization_id
     AND e.aggregate_type='subject' AND e.aggregate_id=NEW.subject_id;

  UPDATE public.subjects
     SET subject_key='deleted-'||replace(id::text,'-',''),display_name='[deleted]',status='closed',
         primary_contact_actor_id=NULL,
         attributes=jsonb_build_object('contentDeleted',true,'proofId',NEW.content_deletion_proof_id),
         updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND id=NEW.subject_id;

  INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES (subject_event_id,NEW.organization_id,'subject-content-deleted|'||NEW.content_deletion_proof_id,
    'Subject.ContentDeleted',1,'subject',NEW.subject_id,gen_random_uuid(),deletion_actor_id,
    'retention-worker',jsonb_build_object('proofId',NEW.content_deletion_proof_id,
      'triggeringCaseId',NEW.id,'remainingContentCases',0),NEW.content_deleted_at);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dop_redact_deleted_case_identity_trigger ON public.cases;
CREATE TRIGGER dop_redact_deleted_case_identity_trigger
AFTER UPDATE OF content_deleted_at ON public.cases
FOR EACH ROW
WHEN (OLD.content_deleted_at IS NULL AND NEW.content_deleted_at IS NOT NULL)
EXECUTE FUNCTION public.dop_redact_deleted_case_identity();

REVOKE ALL ON FUNCTION public.dop_redact_deleted_case_identity() FROM PUBLIC;

COMMIT;
