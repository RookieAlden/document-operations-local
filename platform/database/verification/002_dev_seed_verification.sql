SELECT
    (SELECT count(*) FROM organizations WHERE organization_key = 'dev-accounting-firm') AS organizations,
    (SELECT count(*) FROM actors WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS actors,
    (SELECT count(*) FROM subjects WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS subjects,
    (SELECT count(*) FROM document_types WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS document_types,
    (SELECT count(*) FROM prompt_versions WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS prompt_versions,
    (SELECT count(*) FROM requirements WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS requirements,
    (SELECT count(*) FROM cases WHERE organization_id = '00000000-0000-4000-8000-000000000001') AS cases;

SELECT s.subject_key, s.status, count(c.id) AS case_count
FROM subjects s
LEFT JOIN cases c ON c.organization_id = s.organization_id AND c.subject_id = s.id
WHERE s.organization_id = '00000000-0000-4000-8000-000000000001'
GROUP BY s.subject_key, s.status
ORDER BY s.subject_key;

SELECT count(*) AS paused_client_cases
FROM cases c
JOIN subjects s ON s.organization_id = c.organization_id AND s.id = c.subject_id
WHERE c.organization_id = '00000000-0000-4000-8000-000000000001'
  AND s.status = 'paused';

SELECT
    count(*) FILTER (WHERE prompt_version_id IS NOT NULL) AS cases_with_prompt,
    count(*) FILTER (WHERE prompt_version_id IS NULL) AS cases_without_prompt
FROM cases
WHERE organization_id = '00000000-0000-4000-8000-000000000001';
