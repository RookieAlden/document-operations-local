BEGIN;

-- UAT-only accounting package registration. The core release model is generic;
-- this seed imports the five synthetic accounting clients as published baselines.
WITH registry(
    release_id, series_id, subject_id, workflow_template_id,
    requirement_set_id, workflow_version_id, requirement_version_id
) AS (
    VALUES
      ('00000000-0000-4000-c400-000000005101'::uuid,'00000000-0000-4000-c300-000000005101'::uuid,'00000000-0000-4000-9000-000000001001'::uuid,'00000000-0000-4000-a000-000000002001'::uuid,'00000000-0000-4000-c000-000000004001'::uuid,'00000000-0000-4000-a100-000000002101'::uuid,'00000000-0000-4000-c100-000000004101'::uuid),
      ('00000000-0000-4000-c400-000000005102'::uuid,'00000000-0000-4000-c300-000000005102'::uuid,'00000000-0000-4000-9000-000000001002'::uuid,'00000000-0000-4000-a000-000000002001'::uuid,'00000000-0000-4000-c000-000000004002'::uuid,'00000000-0000-4000-a100-000000002101'::uuid,'00000000-0000-4000-c100-000000004102'::uuid),
      ('00000000-0000-4000-c400-000000005103'::uuid,'00000000-0000-4000-c300-000000005103'::uuid,'00000000-0000-4000-9000-000000001003'::uuid,'00000000-0000-4000-a000-000000002002'::uuid,'00000000-0000-4000-c000-000000004003'::uuid,'00000000-0000-4000-a100-000000002102'::uuid,'00000000-0000-4000-c100-000000004103'::uuid),
      ('00000000-0000-4000-c400-000000005104'::uuid,'00000000-0000-4000-c300-000000005104'::uuid,'00000000-0000-4000-9000-000000001004'::uuid,'00000000-0000-4000-a000-000000002001'::uuid,'00000000-0000-4000-c000-000000004004'::uuid,'00000000-0000-4000-a100-000000002101'::uuid,'00000000-0000-4000-c100-000000004104'::uuid),
      ('00000000-0000-4000-c400-000000005105'::uuid,'00000000-0000-4000-c300-000000005105'::uuid,'00000000-0000-4000-9000-000000001005'::uuid,'00000000-0000-4000-a000-000000002002'::uuid,'00000000-0000-4000-c000-000000004005'::uuid,'00000000-0000-4000-a100-000000002102'::uuid,'00000000-0000-4000-c100-000000004105'::uuid)
), manifests AS (
    SELECT registry.*,
           jsonb_build_object(
             'subject', jsonb_build_object(
               'displayName', subject.display_name,
               'subjectType', subject.subject_type,
               'status', subject.status,
               'primaryContactActorId', subject.primary_contact_actor_id,
               'attributes', subject.attributes
             ),
             'workflow', workflow_version.definition,
             'requirements', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                 'code', requirement.requirement_code,
                 'documentTypeCode', document_type.code,
                 'minimumCount', requirement.minimum_count,
                 'maximumCount', requirement.maximum_count,
                 'acceptanceRule', requirement.acceptance_rule
               ) ORDER BY requirement.requirement_code)
               FROM requirements requirement
               JOIN document_types document_type ON document_type.id = requirement.document_type_id
               WHERE requirement.requirement_set_version_id = registry.requirement_version_id
             ), '[]'::jsonb)
           ) AS manifest
      FROM registry
      JOIN subjects subject ON subject.id = registry.subject_id
      JOIN workflow_template_versions workflow_version ON workflow_version.id = registry.workflow_version_id
)
INSERT INTO work_configuration_releases (
    id, organization_id, series_id, release_number, revision, subject_id,
    workflow_template_id, requirement_set_id, status, manifest, definition_hash,
    produced_workflow_template_version_id, produced_requirement_set_version_id,
    reason, idempotency_key, request_fingerprint, created_at
)
SELECT release_id, '00000000-0000-4000-8000-000000000001', series_id, 1, 1, subject_id,
       workflow_template_id, requirement_set_id, 'published', manifest,
       encode(digest(manifest::text, 'sha256'), 'hex'), workflow_version_id, requirement_version_id,
       'Imported from the original synthetic accounting UAT package.',
       'm14-baseline-' || subject_id::text,
       encode(digest(('m14-baseline|' || subject_id::text || '|' || manifest::text), 'sha256'), 'hex'),
       '2026-08-08T00:00:00Z'
  FROM manifests
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    baseline_count integer;
BEGIN
    SELECT count(*) INTO baseline_count
      FROM work_configuration_releases
     WHERE organization_id = '00000000-0000-4000-8000-000000000001'
       AND release_number = 1 AND revision = 1 AND status = 'published';
    IF baseline_count < 5 THEN
        RAISE EXCEPTION 'M14 UAT seed invariant failed: expected at least 5 baseline releases, found %', baseline_count;
    END IF;
END $$;

COMMIT;
