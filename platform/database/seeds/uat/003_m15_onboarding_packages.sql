BEGIN;

-- UAT-only package catalogue. The package schema is generic; these two
-- published versions are the first accounting examples.
INSERT INTO work_configuration_packages (
    id, organization_id, package_key, display_name, description,
    industry_package, status, created_at, updated_at
) VALUES
    ('00000000-0000-4000-c500-000000006101','00000000-0000-4000-8000-000000000001',
     'accounting.monthly.basic','月度会计资料基础包',
     '按月收集银行流水、发票、工资和经营汇总的可编辑开户起点。','accounting','active',
     '2026-08-08T01:00:00Z','2026-08-08T01:00:00Z'),
    ('00000000-0000-4000-c500-000000006102','00000000-0000-4000-8000-000000000001',
     'accounting.quarterly.basic','季度会计资料基础包',
     '按季度收集银行流水、发票、费用凭证和GST工作底稿的可编辑开户起点。','accounting','active',
     '2026-08-08T01:00:00Z','2026-08-08T01:00:00Z')
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name, description = EXCLUDED.description,
    status = EXCLUDED.status, updated_at = EXCLUDED.updated_at;

WITH source(package_version_id, package_id, workflow_template_id, release_id) AS (
    VALUES
      ('00000000-0000-4000-c600-000000006201'::uuid,'00000000-0000-4000-c500-000000006101'::uuid,
       '00000000-0000-4000-a000-000000002001'::uuid,'00000000-0000-4000-c400-000000005101'::uuid),
      ('00000000-0000-4000-c600-000000006202'::uuid,'00000000-0000-4000-c500-000000006102'::uuid,
       '00000000-0000-4000-a000-000000002002'::uuid,'00000000-0000-4000-c400-000000005103'::uuid)
), blueprint AS (
    SELECT source.*,
      jsonb_build_object(
        'subjectDefaults', jsonb_build_object(
          'status', 'active',
          'attributes', jsonb_build_object('synthetic', true, 'case_generation_enabled', true)
        ),
        'workflow', release.manifest->'workflow',
        'requirements', release.manifest->'requirements'
      ) AS definition
    FROM source
    JOIN work_configuration_releases release ON release.id = source.release_id
)
INSERT INTO work_configuration_package_versions (
    id, organization_id, package_id, workflow_template_id, version, revision, status,
    blueprint, definition_hash, display_name_snapshot, description_snapshot,
    industry_package_snapshot, reason, published_at, created_at
)
SELECT package_version_id, '00000000-0000-4000-8000-000000000001', package_id,
       workflow_template_id, 1, 1, 'published', definition,
       encode(digest(definition::text, 'sha256'), 'hex'),
       package.display_name, package.description, package.industry_package,
       'Initial synthetic UAT onboarding package.',
       '2026-08-08T01:00:00Z','2026-08-08T01:00:00Z'
FROM blueprint
JOIN work_configuration_packages package ON package.id = blueprint.package_id
ON CONFLICT (id) DO UPDATE SET
    blueprint = EXCLUDED.blueprint,
    definition_hash = EXCLUDED.definition_hash,
    display_name_snapshot = EXCLUDED.display_name_snapshot,
    description_snapshot = EXCLUDED.description_snapshot,
    industry_package_snapshot = EXCLUDED.industry_package_snapshot,
    status = 'published';

UPDATE work_configuration_packages package
   SET current_published_version_id = version.id,
       updated_at = now()
  FROM work_configuration_package_versions version
 WHERE version.package_id = package.id
   AND version.organization_id = package.organization_id
   AND version.status = 'published';

DO $$
DECLARE
    active_count integer;
BEGIN
    SELECT count(*) INTO active_count
      FROM work_configuration_package_versions version
      JOIN work_configuration_packages package ON package.id = version.package_id
     WHERE version.organization_id = '00000000-0000-4000-8000-000000000001'
       AND version.status = 'published' AND package.status = 'active';
    IF active_count < 2 THEN
        RAISE EXCEPTION 'M15 UAT seed invariant failed: expected at least 2 active published packages, found %', active_count;
    END IF;
END $$;

COMMIT;
