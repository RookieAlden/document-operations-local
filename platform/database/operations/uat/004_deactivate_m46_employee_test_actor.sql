BEGIN;

DO $$
DECLARE
  org_id uuid;
  owner_id uuid;
  employee_id uuid;
  result jsonb;
BEGIN
  org_id := public.dop_set_organization_context('uat-accounting-firm');
  SELECT id INTO owner_id FROM public.actors
   WHERE organization_id=org_id AND actor_type='admin' AND status='active'
   ORDER BY created_at,id LIMIT 1;
  SELECT id INTO employee_id FROM public.actors
   WHERE organization_id=org_id
     AND external_subject_id='supabase-auth:308eaa27-8814-44e3-99f0-161d65df997f'
     AND actor_type='staff';
  IF owner_id IS NULL OR employee_id IS NULL THEN RAISE EXCEPTION 'M46 UAT employee deactivation target unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM public.actors WHERE id=employee_id AND status='inactive') THEN RETURN; END IF;
  result := public.dop_change_actor_access(owner_id,employee_id,'deactivate',NULL,
    'Disable the dedicated M46 employee account after its approved UAT acceptance window.',
    'm46-deactivate-employee-308eaa27',gen_random_uuid(),now());
  IF result->>'outcome' NOT IN ('completed','duplicate') THEN
    RAISE EXCEPTION 'M46 UAT employee deactivation failed: %',result;
  END IF;
END;
$$;

COMMIT;
