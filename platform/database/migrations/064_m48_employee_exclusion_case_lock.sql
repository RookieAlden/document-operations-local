BEGIN;

-- Lock only: serialize review/correction with Case completion without granting
-- the runtime UPDATE access to cases. No business rows are changed by migration.
CREATE FUNCTION public.dop_lock_document_review_case(p_actor_id uuid, p_document_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  org_id uuid := public.dop_current_organization_id();
  case_status text;
BEGIN
  IF org_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.actors
     WHERE id=p_actor_id AND organization_id=org_id AND status='active'
       AND actor_type IN ('staff','manager','admin')
  ) THEN
    RAISE EXCEPTION 'active employee in current organization required' USING ERRCODE='42501';
  END IF;
  SELECT c.status INTO case_status
    FROM public.cases c JOIN public.documents d ON d.case_id=c.id AND d.organization_id=c.organization_id
   WHERE d.id=p_document_id AND c.organization_id=org_id
   FOR UPDATE OF c;
  RETURN case_status;
END;
$$;
REVOKE ALL ON FUNCTION public.dop_lock_document_review_case(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_lock_document_review_case(uuid,uuid) TO dop_app;
COMMENT ON FUNCTION public.dop_lock_document_review_case(uuid,uuid) IS
  'M48: same-organization active employee review lock; no mutation, no Case update grant, no cross-tenant lookup.';

COMMIT;
