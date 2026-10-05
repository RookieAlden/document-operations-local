BEGIN;

DO $$
DECLARE
  org_id uuid;
  owner_id uuid;
  employee_id uuid;
  expected_external_subject text := 'supabase-auth:308eaa27-8814-44e3-99f0-161d65df997f';
  expected_email text := 'document-ops-uat@aijiaofu.onmicrosoft.com';
  event_key text := 'm46-uat-employee-provision|308eaa27-8814-44e3-99f0-161d65df997f';
  at_time timestamptz := now();
BEGIN
  org_id := public.dop_set_organization_context('uat-accounting-firm');
  SELECT id INTO owner_id FROM public.actors
   WHERE organization_id=org_id AND actor_type='admin' AND status='active'
   ORDER BY created_at,id LIMIT 1;
  IF org_id IS NULL OR owner_id IS NULL THEN RAISE EXCEPTION 'M46 UAT organization owner unavailable'; END IF;

  SELECT id INTO employee_id FROM public.actors
   WHERE organization_id=org_id AND external_subject_id=expected_external_subject;
  IF employee_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.actors WHERE id=employee_id AND organization_id=org_id
      AND actor_type='staff' AND status='active' AND lower(email)=expected_email
      AND attributes @> '{"synthetic":true,"environment":"UAT","m46_employee_test":true}'::jsonb) THEN
      RAISE EXCEPTION 'M46 UAT employee binding exists with unexpected boundaries';
    END IF;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM public.actors WHERE organization_id=org_id AND lower(email)=expected_email) THEN
    RAISE EXCEPTION 'M46 UAT employee email is already bound to another actor';
  END IF;
  IF EXISTS(SELECT 1 FROM public.workflow_events WHERE organization_id=org_id AND idempotency_key=event_key) THEN
    RAISE EXCEPTION 'M46 UAT employee audit event exists without its actor';
  END IF;

  employee_id := gen_random_uuid();
  INSERT INTO public.actors(id,organization_id,external_subject_id,actor_type,display_name,email,status,attributes,created_at,updated_at)
  VALUES(employee_id,org_id,expected_external_subject,'staff','M46 UAT 员工',expected_email,'active',
    '{"synthetic":true,"environment":"UAT","m46_employee_test":true,"advanced_ops_access":false,"external_messages":"disabled"}'::jsonb,
    at_time,at_time);
  INSERT INTO public.workflow_events(id,organization_id,idempotency_key,event_type,event_version,
    aggregate_type,aggregate_id,correlation_id,actor_id,producer,payload,occurred_at)
  VALUES(gen_random_uuid(),org_id,event_key,'Identity.ActorProvisioned',1,'actor',employee_id,gen_random_uuid(),owner_id,
    'uat-m46-provisioning',jsonb_build_object('actor_type','staff','environment','UAT','synthetic_only',true,
      'advanced_ops_access',false,'external_messages','disabled','credential_location','macOS Keychain'),at_time);
END;
$$;

COMMIT;
