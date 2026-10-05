BEGIN;

-- M43 forward fix: qualify the local review event identifier so PostgreSQL
-- cannot confuse it with case_legal_holds.event_id.
CREATE OR REPLACE FUNCTION public.dop_mark_due_legal_holds_for_review(
    p_organization_key text,p_now timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org_id uuid; hold record; review_event_id_value uuid; marked integer:=0;
BEGIN
  SELECT id INTO org_id FROM public.organizations WHERE organization_key=p_organization_key AND status='active';
  IF org_id IS NULL THEN RETURN jsonb_build_object('outcome','completed','markedForReview',0); END IF;
  FOR hold IN
    SELECT * FROM public.case_legal_holds
     WHERE organization_id=org_id AND status='active' AND review_state='scheduled' AND review_due_at<=p_now
     ORDER BY review_due_at,id FOR UPDATE SKIP LOCKED
  LOOP
    review_event_id_value:=gen_random_uuid();
    INSERT INTO public.workflow_events (id,organization_id,idempotency_key,event_type,event_version,
      aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
    VALUES (review_event_id_value,org_id,'legal-hold-review-due|'||hold.id,'Case.LegalHoldReviewRequired',1,
      'case',hold.case_id,gen_random_uuid(),hold.approved_by_actor_id,'retention-worker',
      jsonb_build_object('legalHoldId',hold.id,'reviewDueAt',hold.review_due_at,
        'statusRemains','active','automaticRelease',false),p_now);
    UPDATE public.case_legal_holds SET review_state='pending_review',review_marked_at=p_now,
      review_event_id=review_event_id_value,updated_at=p_now WHERE id=hold.id;
    marked:=marked+1;
  END LOOP;
  RETURN jsonb_build_object('outcome','completed','markedForReview',marked);
END; $$;

COMMIT;
