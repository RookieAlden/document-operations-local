-- Historical DEV seeds used baseline hashes which do not match M46's exact
-- blueprint hash check. Add matching versions; retain old versions/case pins.
DO $$
DECLARE package record; next_version integer;
BEGIN
 FOR package IN SELECT DISTINCT p.organization_id,p.workflow_template_id,p.blueprint->'workflow' definition
   FROM work_configuration_package_versions p JOIN organizations o ON o.id=p.organization_id
   WHERE o.settings->>'local_persistence_mode'='stage1' AND p.status='published'
 LOOP
   IF NOT EXISTS(SELECT 1 FROM workflow_template_versions w WHERE w.organization_id=package.organization_id
       AND w.workflow_template_id=package.workflow_template_id AND w.status='published'
       AND w.definition_hash=encode(digest(package.definition::text,'sha256'),'hex')) THEN
     SELECT coalesce(max(version),0)+1 INTO next_version FROM workflow_template_versions WHERE workflow_template_id=package.workflow_template_id;
     INSERT INTO workflow_template_versions(organization_id,workflow_template_id,version,status,definition,definition_hash,published_at)
       VALUES(package.organization_id,package.workflow_template_id,next_version,'published',package.definition,
         encode(digest(package.definition::text,'sha256'),'hex'),now());
   END IF;
 END LOOP;
END $$;
