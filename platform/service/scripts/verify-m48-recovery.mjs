// Explicit UAT-only, rollback-only regression. No Storage, AI, email or HTTP calls.
// Credentials are supplied in process memory by the operator; never written or logged.
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { postgresPoolConfig } from "../dist/src/runtime/postgres-pool-config.js";
import { PostgresOpsReviewRepository } from "../dist/src/adapters/postgres/postgres-ops-review-repository.js";

const url = process.env.DOP_MIGRATION_DATABASE_URL;
if (!url || !process.env.DOP_MIGRATION_SSL_CA_PATH) throw Error("Explicit UAT connection and CA required");
const client = new pg.Client(postgresPoolConfig(url, process.env.DOP_MIGRATION_SSL_CA_PATH, 1));
const passed = [];
const assert = (value, label) => { if (!value) throw Error(label); passed.push(label); };
const scalar = async (sql, values = []) => (await client.query(sql, values)).rows[0];
const snapshot = async () => scalar(`
  SELECT (SELECT count(*) FROM cases)::int AS cases,
    (SELECT count(*) FROM subjects)::int AS subjects,
    (SELECT count(*) FROM documents)::int AS documents,
    (SELECT count(*) FROM demo_case_invitations)::int AS invitations,
    (SELECT count(*) FROM workflow_events)::int AS events,
    (SELECT count(*) FROM delivery_jobs)::int AS deliveries,
    (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,'|' ORDER BY c.id),'')) FROM cases c) AS all_case_digest,
    (SELECT md5(coalesce(string_agg(to_jsonb(d)::text,'|' ORDER BY d.id),'')) FROM documents d) AS all_document_digest,
    (SELECT md5(coalesce(string_agg(to_jsonb(i)::text,'|' ORDER BY i.id),'')) FROM issues i) AS all_issue_digest,
    (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,'|' ORDER BY c.id),''))
      FROM cases c WHERE c.status='completed') AS completed_case_digest,
    (SELECT md5(coalesce(string_agg(to_jsonb(d)::text,'|' ORDER BY d.id),''))
      FROM documents d JOIN cases c ON c.id=d.case_id WHERE c.status='completed') AS completed_document_digest,
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY t.id),''))
      FROM tasks t JOIN cases c ON c.id=t.case_id WHERE c.status='completed') AS completed_task_digest
`);
await client.connect();
try {
  const target = await scalar("SELECT organization_key FROM organizations WHERE organization_key='uat-accounting-firm'");
  if (!target || (await scalar("SELECT count(*)::int AS n FROM organizations WHERE organization_key='dev-accounting-firm'")).n)
    throw Error("Refusing non-isolated-UAT database");
  const before = await snapshot();
  await client.query("BEGIN");
  if (process.argv.includes("--preview-migration")) {
    const sql = readFileSync(new URL("../../database/migrations/064_m48_employee_exclusion_case_lock.sql", import.meta.url), "utf8");
    await client.query(sql.replace(/^BEGIN;\s*/,"").replace(/COMMIT;\s*$/,""));
  }
  await client.query("SET LOCAL ROLE dop_app");
  assert((await scalar("SELECT count(*)::int AS n FROM cases")).n === 0, "RLS rejects reads without organization context");
  const org = (await scalar("SELECT dop_set_organization_context('uat-accounting-firm') AS id")).id;
  const staff = (await scalar("SELECT id FROM actors WHERE actor_type='staff' AND status='active' ORDER BY created_at LIMIT 1")).id;
  const manager = (await scalar("SELECT id FROM actors WHERE actor_type IN ('manager','admin') AND status='active' ORDER BY created_at LIMIT 1")).id;
  const service = await scalar(`SELECT v.id,v.blueprint->'requirements' AS requirements
    FROM work_configuration_package_versions v JOIN work_configuration_packages p ON p.id=v.package_id
    WHERE p.current_published_version_id=v.id AND v.status='published' AND p.status='active'
      AND v.blueprint#>>'{workflow,frequency}'='quarterly'
      AND v.blueprint#>'{subjectDefaults,attributes,synthetic}'='true'::jsonb LIMIT 1`);
  const now = new Date();
  const requirements = service.requirements.map(r => ({code:r.code,minimumCount:r.minimumCount,maximumCount:r.maximumCount ?? null}));
  const createKey = randomUUID();
  const createArgs = [staff, service.id, "M48 Rollback-only Fictional Client", null, "2098-01-01", "2098-03-31", JSON.stringify(requirements), createKey, randomUUID(), now];
  const create = async () => (await scalar("SELECT dop_create_workbench_client_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",createArgs)).result;
  const created = await create();
  assert(created.outcome === "completed", "Employee creates a new synthetic Case atomically");
  assert((await create()).caseId === created.caseId, "Repeated onboarding returns the same Case");
  const caseId = created.caseId;
  const inviteKey = randomUUID(), until = new Date(now.getTime()+86400000);
  const invite = async (key=inviteKey, at=now, replace=null, actor=staff) => (await scalar(
    "SELECT dop_workbench_issue_case_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [actor,caseId,createHash("sha256").update(key).digest("hex"),20,new Date(at.getTime()+86400000),key,randomUUID(),at,replace])).result;
  const first = await invite();
  assert(first.outcome === "completed", "New employee Case can issue an invitation");
  const recovered = await invite(randomUUID());
  assert(recovered.outcome === "duplicate" && recovered.invitationId === first.invitationId &&
    recovered.recoveryKey === inviteKey && recovered.validUntil === first.validUntil,
    "Fresh-browser recovery preserves invitation, key and original expiry");
  const expired = await invite(inviteKey,new Date(until.getTime()+1000));
  assert(expired.outcome === "conflict" && expired.canRenew, "Expired active label never returns a usable link");
  const replacementKey=randomUUID();
  const replacement=await invite(replacementKey,new Date(until.getTime()+1000),first.invitationId);
  assert(replacement.outcome === "completed" && replacement.invitationId !== first.invitationId,
    "Explicit renewal creates a new invitation");
  assert((await scalar("SELECT status FROM demo_case_invitations WHERE id=$1",[first.invitationId])).status === "revoked",
    "Explicit renewal revokes the old active invitation");
  assert((await invite(replacementKey,new Date(until.getTime()+2000),first.invitationId)).invitationId===replacement.invitationId,
    "Lost renewal response is retryable without issuing another invitation");
  assert((await invite(randomUUID(),now,first.invitationId)).reason==="invitation_changed",
    "Stale replacement cannot revoke a newer invitation");
  await client.query("SAVEPOINT invalid_actor");
  let rejected=false;
  try { await invite(randomUUID(),now,null,randomUUID()); } catch (error) { rejected=error.code==="42501"; }
  await client.query("ROLLBACK TO SAVEPOINT invalid_actor");
  assert(rejected,"Unknown actor cannot recover or issue an invitation");
  await client.query("RESET ROLE");
  await client.query("UPDATE demo_case_invitations SET used_submissions=maximum_submissions,status='exhausted' WHERE id=$1",[replacement.invitationId]);
  await client.query("SET LOCAL ROLE dop_app");
  assert((await invite(replacementKey)).outcome==="conflict","Exhausted invitation fails closed");
  await client.query("RESET ROLE");
  await client.query("UPDATE subjects SET attributes=attributes-'synthetic' WHERE id=$1",[created.subjectId]);
  await client.query("SET LOCAL ROLE dop_app");
  assert((await invite(randomUUID())).reason==="synthetic_scope_required","Untagged subject fails closed even on invitation recovery");
  await client.query("RESET ROLE");
  await client.query("UPDATE subjects SET attributes=attributes||'{\"synthetic\":true}'::jsonb WHERE id=$1",[created.subjectId]);
  await client.query("UPDATE cases SET config_snapshot=config_snapshot-'synthetic_only' WHERE id=$1",[caseId]);
  await client.query("SET LOCAL ROLE dop_app");
  assert((await invite(randomUUID())).reason==="synthetic_scope_required","Untagged Case fails closed");
  await client.query("RESET ROLE");
  await client.query("UPDATE cases SET config_snapshot=config_snapshot||'{\"synthetic_only\":true}'::jsonb WHERE id=$1",[caseId]);
  const submission=randomUUID();
  await client.query(`INSERT INTO submissions(id,organization_id,case_id,submission_key,source,source_submission_id,status,received_at,
    source_connector_key,expected_document_count)
    SELECT $1,$2,$3,$4,'fillout',$4,'completed',$5,connector.connector_key,3
    FROM cases c JOIN source_connector_versions v ON v.id=c.source_connector_version_id
    JOIN source_connectors connector ON connector.id=v.connector_id WHERE c.id=$3`,
    [submission,org,caseId,randomUUID(),now]);
  const type=(await scalar("SELECT r.document_type_id AS id FROM requirements r JOIN cases c ON c.requirement_set_version_id=r.requirement_set_version_id WHERE c.id=$1 LIMIT 1",[caseId])).id;
  const docs=[];
  for (const reason of ["wrong_subject","wrong_period","irrelevant_or_unknown"]) {
    const id=randomUUID(); docs.push({id,reason});
    await client.query(`INSERT INTO documents(id,organization_id,case_id,submission_id,idempotency_key,
      original_filename,status,accepted_document_type_id,review_reason,declared_mime_type,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,'review_required',$7,'conflict_requires_review','application/pdf',1024)`,
      [id,org,caseId,submission,randomUUID(),reason+".pdf",type]);
  }
  await client.query("SET LOCAL ROLE dop_app");
  await client.query("SAVEPOINT foreign_review_scope");
  await client.query("RESET ROLE");
  const foreignOrg=randomUUID(), foreignActor=randomUUID();
  await client.query("INSERT INTO organizations(id,organization_key,display_name) VALUES($1,$2,'M48 rollback foreign organization')",[foreignOrg,foreignOrg]);
  await client.query("INSERT INTO actors(id,organization_id,external_subject_id,actor_type,display_name) VALUES($1,$2,$3,'staff','M48 rollback foreign staff')",[foreignActor,foreignOrg,foreignActor]);
  await client.query("SET LOCAL ROLE dop_app");
  await client.query("SELECT set_config('dop.organization_id',$1,true)",[foreignOrg]);
  assert((await scalar("SELECT count(*)::int n FROM documents WHERE id=$1",[docs[0].id])).n===0,
    "Foreign organization cannot read review document");
  assert((await scalar("SELECT dop_lock_document_review_case($1,$2) status",[foreignActor,docs[0].id])).status===null,
    "Security-definer Case lock cannot expose or lock another organization document");
  await client.query("ROLLBACK TO SAVEPOINT foreign_review_scope");
  // Keep real repository transactions inside the outer rollback-only fixture.
  let failDecisionInsert=false;
  const borrowed={query:async(sql,values)=>{
    if(sql==="BEGIN") return client.query("SAVEPOINT review_operation");
    if(sql==="COMMIT") return client.query("RELEASE SAVEPOINT review_operation");
    if(sql==="ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT review_operation");
    if(failDecisionInsert && sql.includes("INSERT INTO document_review_decisions")) throw Error("injected decision persistence failure");
    return client.query(sql,values);
  },release(){}};
  const reviews=new PostgresOpsReviewRepository({connect:async()=>borrowed});
  for(const doc of docs) {
    const escalationKey=randomUUID();
    const escalate=async()=> (await scalar("SELECT dop_workbench_escalate_document_review($1,$2,$3,$4,$5) AS result",
      [staff,doc.id,escalationKey,randomUUID(),now])).result;
    assert((await escalate()).outcome==="completed","Employee supervisor handoff: "+doc.reason);
    assert((await escalate()).outcome==="duplicate","Handoff replay is idempotent: "+doc.reason);
    // Closing a related client question must not quietly restore staff approval authority.
    await client.query("UPDATE issues SET status='resolved' WHERE document_id=$1 AND routing_reason='supervisor_review_requested'",[doc.id]);
    const base={organizationKey:"uat-accounting-firm",documentId:doc.id,actorId:staff,action:"confirm",
      exclusionReason:null,documentTypeCode:null,rationale:"M48 synthetic rollback acceptance decision.",
      idempotencyKey:randomUUID(),requestFingerprint:createHash("sha256").update(doc.id).digest("hex"),
      decisionId:randomUUID(),eventId:randomUUID(),issueId:randomUUID(),correlationId:randomUUID(),now};
    assert((await reviews.resolve(base)).reason==="manager_required","Staff cannot bypass handoff even after related Issue closure: "+doc.reason);
    const excludedRequest={...base,action:"exclude",exclusionReason:doc.reason,
      requestFingerprint:createHash("sha256").update(doc.id+"|exclude").digest("hex"),idempotencyKey:randomUUID()};
    const original=await scalar("SELECT content_hash_sha256,incoming_storage_ref,archive_storage_ref FROM documents WHERE id=$1",[doc.id]);
    const result=await reviews.resolve(excludedRequest);
    assert(result.outcome==="completed" && result.exclusionReason===doc.reason,
      "Employee exclusion retains the exact reason: "+doc.reason);
    assert((await reviews.resolve(excludedRequest)).outcome==="duplicate","Exclusion replay adds no second decision: "+doc.reason);
    assert((await reviews.resolve({...excludedRequest,requestFingerprint:"f".repeat(64)})).reason==="idempotency_key_reused",
      "Changed exclusion replay fails closed: "+doc.reason);
    assert((await scalar("SELECT count(*)::int AS n FROM issues WHERE document_id=$1 AND status NOT IN ('resolved','closed')",[doc.id])).n===0,
      "Employee exclusion closes the handoff issue: "+doc.reason);
    assert((await scalar("SELECT count(*)::int AS n FROM document_review_decisions WHERE document_id=$1",[doc.id])).n===1,
      "One immutable decision per document: "+doc.reason);
    const restoredRequest={...base,action:"reopen",idempotencyKey:randomUUID(),
      decisionId:randomUUID(),eventId:randomUUID(),issueId:randomUUID(),
      requestFingerprint:createHash("sha256").update(doc.id+"|restore").digest("hex")};
    const beforeFailure=await scalar(`SELECT (SELECT md5(to_jsonb(d)::text) FROM documents d WHERE id=$1) digest,
      (SELECT count(*) FROM issues WHERE document_id=$1) issues,
      (SELECT count(*) FROM workflow_events WHERE aggregate_id=$1) events`,[doc.id]);
    failDecisionInsert=true;
    let failed=false;
    try { await reviews.resolve(restoredRequest); } catch(error) { failed=error.message==="injected decision persistence failure"; }
    failDecisionInsert=false;
    assert(failed && JSON.stringify(beforeFailure)===JSON.stringify(await scalar(`SELECT
      (SELECT md5(to_jsonb(d)::text) FROM documents d WHERE id=$1) digest,
      (SELECT count(*) FROM issues WHERE document_id=$1) issues,
      (SELECT count(*) FROM workflow_events WHERE aggregate_id=$1) events`,[doc.id])),
      "Failed restoration rolls back document, issue and audit together: "+doc.reason);
    assert((await reviews.resolve(restoredRequest)).documentStatus==="review_required","Employee restores exclusion only to review: "+doc.reason);
    assert((await reviews.resolve(restoredRequest)).outcome==="duplicate","Restoration replay is idempotent: "+doc.reason);
    assert((await reviews.resolve({...base,idempotencyKey:randomUUID()})).reason==="manager_required",
      "Exclude and restore cannot launder a pre-existing supervisor hold: "+doc.reason);
    assert((await scalar("SELECT count(*)::int n FROM issues WHERE document_id=$1 AND routing_reason='exclusion_restored_for_review' AND status='reopened'",[doc.id])).n===1,
      "Restoration creates one actionable issue: "+doc.reason);
    assert((await reviews.resolve({...excludedRequest,idempotencyKey:randomUUID(),decisionId:randomUUID(),eventId:randomUUID()})).outcome==="completed",
      "Restored file can be excluded again by employee: "+doc.reason);
    assert((await scalar("SELECT count(*)::int n FROM document_review_decisions WHERE document_id=$1",[doc.id])).n===3,
      "Exclude, restore and corrected exclusion retain three independent decisions: "+doc.reason);
    assert((await scalar("SELECT count(*)::int n FROM workflow_events WHERE aggregate_id=$1 AND event_type IN ('Document.ExcludedFromCase','Document.ReviewReopened')",[doc.id])).n===3,
      "Every exclusion and restoration has an actor-attributed event: "+doc.reason);
    assert(JSON.stringify(original)===JSON.stringify(await scalar("SELECT content_hash_sha256,incoming_storage_ref,archive_storage_ref FROM documents WHERE id=$1",[doc.id])),
      "Exclusion and correction preserve original reference and checksum: "+doc.reason);
    assert((await reviews.resolve({...base,actorId:randomUUID()})).resource==="operator","Unknown actor cannot decide: "+doc.reason);
    assert((await reviews.resolve({...excludedRequest,actorId:randomUUID()})).resource==="operator","Unknown actor cannot replay prior exclusion: "+doc.reason);
    assert((await reviews.resolve({...base,documentId:randomUUID()})).resource==="document","Invisible document cannot be reviewed: "+doc.reason);
  }
  assert((await scalar("SELECT count(*)::int AS n FROM issue_operator_transitions WHERE issue_id IN (SELECT id FROM issues WHERE case_id=$1)",[caseId])).n===3,
    "Each handoff has an independent immutable transition");
  assert((await scalar("SELECT count(*)::int AS n FROM workflow_events WHERE aggregate_id=$1 AND event_type='DemoForm.InvitationReplaced'",[caseId])).n===1,
    "Explicit invitation renewal has exactly one audit event");
  const ackKey=randomUUID();
  const acknowledge=async(key=ackKey,actor=staff,target=caseId)=> (await scalar(
    "SELECT dop_workbench_acknowledge_duplicates($1,$2,$3,$4,$5) AS result",
    [actor,target,key,randomUUID(),new Date(Date.now()+1000)])).result;
  assert((await acknowledge()).reason==="other_completeness_blockers","Duplicate acknowledgement cannot bypass missing requirements");
  await client.query("RESET ROLE");
  const needed=(await client.query(`SELECT r.document_type_id,r.minimum_count FROM requirements r
    JOIN cases c ON c.requirement_set_version_id=r.requirement_set_version_id WHERE c.id=$1`,[caseId])).rows;
  for(const requirement of needed) for(let i=0;i<requirement.minimum_count;i++) {
    const id=randomUUID();
    await client.query(`INSERT INTO documents(id,organization_id,case_id,submission_id,idempotency_key,
      original_filename,status,accepted_document_type_id,declared_mime_type,size_bytes,content_hash_sha256)
      VALUES($1,$2,$3,$4,$5,'rollback-only.pdf','accepted',$6,'application/pdf',1024,$7)`,
      [id,org,caseId,submission,randomUUID(),requirement.document_type_id,createHash("sha256").update(id).digest("hex")]);
  }
  await client.query(`INSERT INTO documents(id,organization_id,case_id,submission_id,idempotency_key,
    original_filename,status,accepted_document_type_id,declared_mime_type,size_bytes,content_hash_sha256,created_at)
    SELECT gen_random_uuid(),organization_id,case_id,submission_id,$2,'rollback-duplicate.pdf','duplicate_skipped',
      accepted_document_type_id,'application/pdf',size_bytes,content_hash_sha256,now()+interval '1 second'
    FROM documents WHERE case_id=$1 AND status='accepted' LIMIT 1`,[caseId,randomUUID()]);
  await client.query("UPDATE submissions SET expected_document_count=(SELECT count(*) FROM documents WHERE submission_id=$1),status='completed' WHERE id=$1",[submission]);
  await client.query("SELECT dop_recompute_submission_completeness($1,$2)",[submission,new Date()]);
  await client.query("SET LOCAL ROLE dop_app");
  const prior=(await scalar("SELECT count(*)::int AS n FROM documents WHERE case_id=$1 AND status='accepted'",[caseId])).n;
  const acknowledged=await acknowledge();
  assert(acknowledged.outcome==="completed","Employee acknowledges real duplicate evidence without using /ops");
  assert((await acknowledge()).outcome==="duplicate","Duplicate acknowledgement is idempotent");
  await client.query("SAVEPOINT invalid_ack_actor");
  let rejectedAck=false;
  try { await acknowledge(randomUUID(),randomUUID()); } catch(error) { rejectedAck=error.code==="42501"; }
  await client.query("ROLLBACK TO SAVEPOINT invalid_ack_actor");
  assert(rejectedAck,"Unknown actor cannot acknowledge duplicate files");
  assert((await acknowledge(ackKey,manager)).reason==="idempotency_key_reused","Acknowledgement cannot be replayed by a different actor");
  assert((await scalar("SELECT count(*)::int AS n FROM documents WHERE case_id=$1 AND status='accepted'",[caseId])).n===prior,
    "Duplicate acknowledgement never increases accepted document count");
  assert((await scalar("SELECT count(*)::int AS n FROM documents WHERE case_id=$1 AND status='duplicate_skipped'",[caseId])).n===1,
    "Duplicate file is retained, not deleted or reclassified");
  assert((await scalar("SELECT count(*)::int AS n FROM issues WHERE case_id=$1 AND status NOT IN ('resolved','closed')",[caseId])).n===0,
    "Duplicate acknowledgement resolves the last open Issue");
  assert((await scalar("SELECT count(*)::int AS n FROM case_completeness_acknowledgements WHERE case_id=$1",[caseId])).n===1,
    "Append-only duplicate acknowledgement evidence is recorded once");
  const completed=(await scalar("SELECT dop_complete_case_and_create_handoff($1,$2,$1,$3,$4,$5) AS result",
    [staff,caseId,"M48 duplicate branch rollback-only acceptance.",randomUUID(),new Date(Date.now()+2000)])).result;
  assert(["completed","duplicate"].includes(completed.outcome),"Employee can complete the Case after audited duplicate acknowledgement");
  assert((await reviews.resolve({organizationKey:"uat-accounting-firm",documentId:docs[0].id,actorId:staff,action:"reopen",
    exclusionReason:null,documentTypeCode:null,rationale:"M48 closed Case must reject exclusion correction.",idempotencyKey:randomUUID(),
    requestFingerprint:"c".repeat(64),decisionId:randomUUID(),eventId:randomUUID(),issueId:randomUUID(),correlationId:randomUUID(),now})).reason==="case_closed",
    "Completed Case cannot be reopened by exclusion correction");
  await client.query("RESET ROLE");
  await client.query("UPDATE cases SET config_snapshot=config_snapshot-'synthetic_only' WHERE id=$1",[caseId]);
  await client.query("SET LOCAL ROLE dop_app");
  assert((await acknowledge()).reason==="synthetic_scope_required","Acknowledgement replay fails closed for an untagged Case");
  await client.query("RESET ROLE");
  await client.query("UPDATE cases SET config_snapshot=config_snapshot||'{\"synthetic_only\":true}'::jsonb WHERE id=$1",[caseId]);
  await client.query("UPDATE subjects SET attributes=attributes-'synthetic' WHERE id=$1",[created.subjectId]);
  await client.query("SET LOCAL ROLE dop_app");
  assert((await acknowledge()).reason==="synthetic_scope_required","Even acknowledgement replay fails closed for an untagged subject");
  await client.query("ROLLBACK");
  const after=await snapshot();
  assert(JSON.stringify(before)===JSON.stringify(after),"Rollback leaves every existing Case, successful Case digest, event and delivery count unchanged");
  console.log(JSON.stringify({result:"passed",checks:passed.length,passed,persistentSideEffects:0,
    storageCalls:0,openaiCalls:0,externalSends:0,baseline:before},null,2));
} catch(error) {
  await client.query("ROLLBACK").catch(()=>{});
  console.error(JSON.stringify({result:"failed",check:error.message,code:error.code??null,passedChecks:passed}));
  process.exitCode=1;
} finally { await client.end(); }
