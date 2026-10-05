BEGIN;

-- Connector envelopes are execution evidence while a Case is live, but may
-- contain the original filename, source submission id or provider reference.
-- They are content, not part of the minimal deletion proof.
CREATE OR REPLACE FUNCTION public.dop_redact_deleted_case_connector_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE public.submissions
     SET canonical_envelope=NULL,
         source_provenance=jsonb_build_object('contentDeleted',true,'proofId',NEW.content_deletion_proof_id),
         updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND case_id=NEW.id;

  UPDATE public.documents
     SET source_download_ref=NULL,source_envelope=NULL,updated_at=NEW.content_deleted_at
   WHERE organization_id=NEW.organization_id AND case_id=NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dop_redact_deleted_case_connector_context_trigger ON public.cases;
CREATE TRIGGER dop_redact_deleted_case_connector_context_trigger
AFTER UPDATE OF content_deleted_at ON public.cases
FOR EACH ROW
WHEN (OLD.content_deleted_at IS NULL AND NEW.content_deleted_at IS NOT NULL)
EXECUTE FUNCTION public.dop_redact_deleted_case_connector_context();

-- Forward correction for content deleted before this completeness guard was
-- installed. This includes the approved M43 synthetic UAT acceptance Case.
UPDATE public.submissions submission
   SET canonical_envelope=NULL,
       source_provenance=jsonb_build_object('contentDeleted',true,'proofId',case_row.content_deletion_proof_id),
       updated_at=case_row.content_deleted_at
  FROM public.cases case_row
 WHERE submission.organization_id=case_row.organization_id
   AND submission.case_id=case_row.id AND case_row.content_deleted_at IS NOT NULL;

UPDATE public.documents document
   SET source_download_ref=NULL,source_envelope=NULL,updated_at=case_row.content_deleted_at
  FROM public.cases case_row
 WHERE document.organization_id=case_row.organization_id
   AND document.case_id=case_row.id AND case_row.content_deleted_at IS NOT NULL;

REVOKE ALL ON FUNCTION public.dop_redact_deleted_case_connector_context() FROM PUBLIC;

COMMIT;
