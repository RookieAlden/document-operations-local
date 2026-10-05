import { bankStatement, highRiskDocument } from "./synthetic-classification-content.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { OpenAIClassificationProvider } from "../adapters/openai/openai-classification-provider.js";
import { decideClassification, effectiveConflictFlags } from "../application/classify-document.js";
import {
  CLASSIFICATION_QUALITY_SCORER_VERSION,
  assertClassificationBudgetAvailable,
  estimateClassificationCostUsd,
  evaluateClassificationQuality,
  type ClassificationQualityObservation,
  type ClassificationQualityPolicy,
  type ClassificationRiskStratum,
} from "../domain/classification-quality.js";

interface M44Manifest {
  schemaVersion: "1.0";
  environment: "UAT";
  dataClassification: "synthetic_only";
  subjectKey: string;
  subjectDisplayName: string;
  expectedPeriod: string;
  generatorSeed: string;
  routineBankStatementFamilies: number;
  nearDuplicateVariants: number;
  highRiskFamiliesPerType: number;
  safetyFamiliesPerStratum: number;
  highRiskDocumentTypeCodes: string[];
  safetyStrata: ClassificationRiskStratum[];
  firstClientConfiguration: Record<string, unknown>;
  policy: Omit<ClassificationQualityPolicy, "highRiskDocumentTypeCodes"> & { reservedNextCallUsd: number };
}

interface EvaluationSample {
  sampleId: string;
  familyId: string;
  filename: string;
  expectedDocumentTypeCode: string;
  expectedRoute: "accepted" | "review_required";
  riskStratum: ClassificationRiskStratum;
  content: string[];
}

interface RuntimeContext {
  organizationId: string;
  subjectId: string;
  actorId: string;
  profileVersionId: string;
  releaseVersionId: string;
  releaseDefinition: {
    model: string; promptInstructions: string; promptInstructionHash: string;
    responseSchemaVersion: "1.0"; responseSchemaHash: string;
    requestPolicy: { maxOutputTokens: number; reasoningEffort: "low" | "medium" | "high" };
  };
  allowedDocumentTypes: Array<{ id: string; code: string; displayName: string; description: string }>;
}

const serviceDirectory = process.cwd();
const workspaceRoot = resolve(serviceDirectory, "../..");
const manifestPath = resolve(workspaceRoot, "platform/tests/fixtures/m44-classification-quality-manifest.json");
const initialEvidencePath = resolve(workspaceRoot, "platform/docs/evidence/M44_CLASSIFICATION_QUALITY_EVIDENCE_INITIAL.json");
const correctedEvidencePath = resolve(workspaceRoot, "platform/docs/evidence/M44_CLASSIFICATION_QUALITY_EVIDENCE.json");
const rescoreMode = process.argv.includes("--rescore-evidence");
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText) as M44Manifest;
if (manifest.environment !== "UAT" || manifest.dataClassification !== "synthetic_only" ||
    manifest.firstClientConfiguration.syntheticOnly !== true) {
  throw new Error("M44 runner accepts only an explicitly synthetic UAT manifest");
}

const manifestHash = sha256(manifestText);
const samples = buildSamples(manifest);
const datasetHash = sha256(JSON.stringify(samples.map((sample) => ({
  sampleId: sample.sampleId,
  familyId: sample.familyId,
  filename: sample.filename,
  expectedDocumentTypeCode: sample.expectedDocumentTypeCode,
  expectedRoute: sample.expectedRoute,
  riskStratum: sample.riskStratum,
  contentHash: sha256(sample.content.join("\n")),
}))));
const policy: ClassificationQualityPolicy = {
  confidenceLevel: manifest.policy.confidenceLevel,
  minimumAutoAcceptPrecisionLowerBound: manifest.policy.minimumAutoAcceptPrecisionLowerBound,
  minimumIndependentFamilies: manifest.policy.minimumIndependentFamilies,
  highRiskDocumentTypeCodes: manifest.highRiskDocumentTypeCodes,
  inputUsdPerMillionTokens: manifest.policy.inputUsdPerMillionTokens,
  outputUsdPerMillionTokens: manifest.policy.outputUsdPerMillionTokens,
  monthlyProviderLimitUsd: manifest.policy.monthlyProviderLimitUsd,
  applicationCircuitBreakerUsd: manifest.policy.applicationCircuitBreakerUsd,
};

const client = new pg.Client(databaseOptions(process.env.DATABASE_URL ??
  readKeychain("document-operations-uat", "DOP_SUPABASE_UAT_ADMIN_DATABASE_URL")));
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)", [process.env.DOP_ORGANIZATION_KEY ?? "uat-accounting-firm"]);
  const runtime = await loadRuntimeContext(client, manifest.subjectKey);
  const policyId = await configurePolicy(client, runtime, manifest, manifestHash);
  await client.query("COMMIT");
  if (rescoreMode) {
    await rescoreExistingEvidence(client, runtime, policyId, policy);
  } else {
  const provider = new OpenAIClassificationProvider({
    apiKey: process.env.OPENAI_API_KEY ?? readKeychain("openai-uat", "dop-openai-uat"),
    model: runtime.releaseDefinition.model,
    prompt: runtime.releaseDefinition.promptInstructions,
    timeoutMs: 120_000,
  });
  const observations: ClassificationQualityObservation[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  let circuitOpen = false;

  for (const [index, sample] of samples.entries()) {
    const accrued = estimateClassificationCostUsd(
      observations.reduce((sum, item) => sum + item.inputTokens, 0),
      observations.reduce((sum, item) => sum + item.outputTokens, 0),
      policy.inputUsdPerMillionTokens,
      policy.outputUsdPerMillionTokens,
    );
    const observedReserve = observations.length === 0 ? manifest.policy.reservedNextCallUsd
      : Math.max(manifest.policy.reservedNextCallUsd, accrued / observations.length * 1.5);
    try {
      assertClassificationBudgetAvailable(accrued, observedReserve, policy);
    } catch {
      circuitOpen = true;
      break;
    }
    const pdf = await syntheticPdf(sample.content);
    const started = Date.now();
    try {
      const response = await provider.classify({
        documentId: sample.sampleId,
        filename: sample.filename,
        declaredMimeType: "application/pdf",
        allowedDocumentTypes: runtime.allowedDocumentTypes,
        source: { kind: "file_data", filename: sample.filename, mimeType: "application/pdf", base64: pdf.toString("base64") },
        expectedSubjectReferences: [manifest.subjectKey, manifest.subjectDisplayName],
        expectedPeriod: manifest.expectedPeriod,
        execution: {
          model: runtime.releaseDefinition.model,
          prompt: runtime.releaseDefinition.promptInstructions,
          promptInstructionHash: runtime.releaseDefinition.promptInstructionHash,
          responseSchemaVersion: runtime.releaseDefinition.responseSchemaVersion,
          responseSchemaHash: runtime.releaseDefinition.responseSchemaHash,
          maxOutputTokens: runtime.releaseDefinition.requestPolicy.maxOutputTokens,
          reasoningEffort: runtime.releaseDefinition.requestPolicy.reasoningEffort,
        },
      });
      const predicted = runtime.allowedDocumentTypes.find((item) => item.code === response.result.predicted_document_type_code)!;
      const effectiveFlags = effectiveConflictFlags(
        manifest.expectedPeriod,
        response.result.detected_period,
        response.result.conflict_flags,
      );
      const decision = decideClassification({
        id: predicted.id,
        code: predicted.code,
        displayName: predicted.displayName,
        description: predicted.description,
        minimumConfidence: 0.8,
        alwaysHumanConfirm: manifest.highRiskDocumentTypeCodes.includes(predicted.code),
        manualOnConflict: true,
        rejectOnQualityFlags: ["blurry","blank","corrupt","partial","password_protected","unsupported","mime_mismatch","other"],
        rejectOnConflictFlags: ["subject_conflict","period_conflict","document_type_conflict","duplicate_suspected","other"],
      }, { confidence: response.result.confidence, quality_flags: response.result.quality_flags, conflict_flags: effectiveFlags });
      const observation: ClassificationQualityObservation = {
        sampleId: sample.sampleId,
        familyId: sample.familyId,
        expectedDocumentTypeCode: sample.expectedDocumentTypeCode,
        actualDocumentTypeCode: response.result.predicted_document_type_code,
        expectedRoute: sample.expectedRoute,
        actualRoute: decision.status,
        riskStratum: sample.riskStratum,
        inputTokens: response.audit.inputTokens ?? 0,
        outputTokens: response.audit.outputTokens ?? 0,
        latencyMs: Date.now() - started,
      };
      observations.push(observation);
      auditRows.push({
        ...observation,
        passed: observation.actualRoute === observation.expectedRoute &&
          (sample.riskStratum !== "routine" || observation.actualDocumentTypeCode === sample.expectedDocumentTypeCode),
        confidence: response.result.confidence,
        qualityFlags: response.result.quality_flags,
        conflictFlags: response.result.conflict_flags,
        reviewReasons: decision.reviewReasons,
        providerResponseIdHash: sha256(response.audit.responseId),
        model: response.audit.model,
      });
    } catch (error) {
      const observation: ClassificationQualityObservation = {
        sampleId: sample.sampleId, familyId: sample.familyId,
        expectedDocumentTypeCode: sample.expectedDocumentTypeCode, actualDocumentTypeCode: null,
        expectedRoute: sample.expectedRoute, actualRoute: "failed_closed", riskStratum: sample.riskStratum,
        inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started,
      };
      observations.push(observation);
      auditRows.push({ ...observation, passed: sample.expectedRoute === "review_required",
        errorCode: codedError(error) });
    }
    console.log(JSON.stringify({ completed: index + 1, total: samples.length,
      estimatedCostUsd: estimateClassificationCostUsd(
        observations.reduce((sum, item) => sum + item.inputTokens, 0),
        observations.reduce((sum, item) => sum + item.outputTokens, 0),
        policy.inputUsdPerMillionTokens, policy.outputUsdPerMillionTokens,
      ) }));
  }

  const quality = evaluateClassificationQuality(observations, policy);
  const status = circuitOpen ? "circuit_open" : quality.passed ? "passed" : "failed";
  const persistedResult = {
    syntheticOnly: true,
    ...quality,
    certifiedAutoAcceptDocumentTypeCodes: status === "passed"
      ? quality.certifiedAutoAcceptDocumentTypeCodes : [],
  };
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)", [process.env.DOP_ORGANIZATION_KEY ?? "uat-accounting-firm"]);
  const record = await client.query<{ result: Record<string, unknown> }>(
    "SELECT dop_record_classification_quality_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
    [runtime.actorId,policyId,datasetHash,manifestHash,status,persistedResult,
      "Record the M44 risk-stratified, family-deduplicated synthetic UAT classification evaluation.",
      uuidFromHash(`run|${datasetHash}`),uuidFromHash(`correlation|${datasetHash}`),new Date()],
  );
  await client.query("COMMIT");
  const evidence = {
    schemaVersion: "1.0",
    milestone: "M44",
    environment: "UAT",
    dataClassification: "synthetic_only",
    generatedAt: new Date().toISOString(),
    subjectKey: manifest.subjectKey,
    manifestHash,
    datasetHash,
    policy: { ...policy, reservedNextCallUsd: manifest.policy.reservedNextCallUsd },
    runtime: {
      classificationProfileVersionId: runtime.profileVersionId,
      classifierReleaseVersionId: runtime.releaseVersionId,
      requestedModel: runtime.releaseDefinition.model,
      promptInstructionHash: runtime.releaseDefinition.promptInstructionHash,
      responseSchemaHash: runtime.releaseDefinition.responseSchemaHash,
    },
    status,
    scorerVersion: "1.0",
    quality,
    databaseRecord: record.rows[0]?.result ?? null,
    samples: auditRows,
    limitations: [
      "All inputs are generated synthetic PDFs; no real client content was used.",
      "This evidence is a pilot baseline and does not replace M46 real-data shadow review.",
    ],
  };
  mkdirSync(resolve(initialEvidencePath, ".."), { recursive: true });
  writeFileSync(initialEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status, ...quality, evidencePath: initialEvidencePath }));
  if (status !== "passed") process.exitCode = 1;
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

async function rescoreExistingEvidence(
  client:pg.Client,runtime:RuntimeContext,policyId:string,policy:ClassificationQualityPolicy,
):Promise<void>{
  const initial=JSON.parse(readFileSync(initialEvidencePath,"utf8")) as {
    dataClassification?:unknown;status?:unknown;manifestHash?:unknown;datasetHash?:unknown;
    databaseRecord?:{qualityRunId?:unknown};samples?:unknown[];quality?:unknown;
  };
  if(initial.dataClassification!=="synthetic_only"||initial.status!=="failed"||
      initial.manifestHash!==manifestHash||typeof initial.datasetHash!=="string"||
      !Array.isArray(initial.samples)||typeof initial.databaseRecord?.qualityRunId!=="string"){
    throw new Error("m44_initial_evidence_not_rescorable");
  }
  const observations=initial.samples.map((sample)=>qualityObservation(sample));
  const sourceDatasetHash=initial.datasetHash;
  const quality=evaluateClassificationQuality(observations,policy);
  const status=quality.passed?"passed":"failed";
  const persistedResult={syntheticOnly:true,...quality,
    certifiedAutoAcceptDocumentTypeCodes:status==="passed"?quality.certifiedAutoAcceptDocumentTypeCodes:[]};
  await client.query("BEGIN");
  await client.query("SELECT dop_set_organization_context($1)",[process.env.DOP_ORGANIZATION_KEY??"uat-accounting-firm"]);
  const record=await client.query<{result:Record<string,unknown>}>(
    "SELECT dop_record_classification_quality_rescore($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [runtime.actorId,initial.databaseRecord.qualityRunId,CLASSIFICATION_QUALITY_SCORER_VERSION,status,
      persistedResult,"Correct the canonical-family scorer without another OpenAI provider call.",
      uuidFromHash(`rescore|${sourceDatasetHash}|${CLASSIFICATION_QUALITY_SCORER_VERSION}`),
      uuidFromHash(`rescore-correlation|${sourceDatasetHash}|${CLASSIFICATION_QUALITY_SCORER_VERSION}`),new Date()]);
  await client.query("COMMIT");
  const evidence={
    schemaVersion:"1.0",milestone:"M44",environment:"UAT",dataClassification:"synthetic_only",
    generatedAt:new Date().toISOString(),subjectKey:manifest.subjectKey,manifestHash,datasetHash:sourceDatasetHash,
    scorerVersion:CLASSIFICATION_QUALITY_SCORER_VERSION,status,policy,quality,
    databaseRecord:record.rows[0]?.result??null,
    sourceEvidence:{path:"M44_CLASSIFICATION_QUALITY_EVIDENCE_INITIAL.json",
      sourceQualityRunId:initial.databaseRecord.qualityRunId,sourceStatus:initial.status,
      providerCallsReused:observations.length,additionalProviderCalls:0,additionalTokens:0,additionalEstimatedCostUsd:0},
    samples:initial.samples,
    correction:{code:"canonical_family_variant_scoring_v2",
      explanation:"Only the pre-declared canonical sample casts a statistical family vote; near-duplicate variants remain auditable but cannot alter or inflate the family result."},
    limitations:["All inputs are generated synthetic PDFs; no real client content was used.",
      "This evidence is a pilot baseline and does not replace M46 real-data shadow review."],
  };
  mkdirSync(resolve(correctedEvidencePath,".."),{recursive:true});
  writeFileSync(correctedEvidencePath,`${JSON.stringify(evidence,null,2)}\n`,{mode:0o600});
  console.log(JSON.stringify({status,...quality,evidencePath:correctedEvidencePath,
    additionalProviderCalls:0,additionalEstimatedCostUsd:0}));
  if(status!=="passed")process.exitCode=1;
}

function qualityObservation(value:unknown):ClassificationQualityObservation{
  if(typeof value!=="object"||value===null)throw new Error("invalid_rescore_observation");
  const row=value as Record<string,unknown>;
  const observation={sampleId:row.sampleId,familyId:row.familyId,
    expectedDocumentTypeCode:row.expectedDocumentTypeCode,actualDocumentTypeCode:row.actualDocumentTypeCode,
    expectedRoute:row.expectedRoute,actualRoute:row.actualRoute,riskStratum:row.riskStratum,
    inputTokens:row.inputTokens,outputTokens:row.outputTokens,latencyMs:row.latencyMs};
  if(typeof observation.sampleId!=="string"||typeof observation.familyId!=="string"||
      typeof observation.expectedDocumentTypeCode!=="string"||
      !(typeof observation.actualDocumentTypeCode==="string"||observation.actualDocumentTypeCode===null)||
      !["accepted","review_required"].includes(String(observation.expectedRoute))||
      !["accepted","review_required","failed_closed"].includes(String(observation.actualRoute))||
      !["routine","high_risk_type","wrong_subject","wrong_period","unknown_type","critical_conflict","low_quality"].includes(String(observation.riskStratum))||
      typeof observation.inputTokens!=="number"||typeof observation.outputTokens!=="number"||typeof observation.latencyMs!=="number"){
    throw new Error("invalid_rescore_observation");
  }
  return observation as ClassificationQualityObservation;
}

async function loadRuntimeContext(client: pg.Client, subjectKey: string): Promise<RuntimeContext> {
  const result = await client.query<{
    organization_id:string;subject_id:string;actor_id:string;profile_version_id:string;
    release_version_id:string;release_definition:RuntimeContext["releaseDefinition"];
  }>(`SELECT subject.organization_id,subject.id AS subject_id,actor.id AS actor_id,
      release.definition->>'classificationProfileVersionId' AS profile_version_id,
      case_row.classifier_release_version_id AS release_version_id,
      release.definition AS release_definition
    FROM subjects subject
    JOIN cases case_row ON case_row.organization_id=subject.organization_id AND case_row.subject_id=subject.id
    JOIN classifier_release_versions release ON release.organization_id=case_row.organization_id
      AND release.id=case_row.classifier_release_version_id AND release.status='published'
    JOIN actors actor ON actor.organization_id=subject.organization_id AND actor.actor_type='admin' AND actor.status='active'
   WHERE subject.subject_key=$1 AND subject.status='active' AND subject.attributes @> '{"synthetic":true}'::jsonb
   ORDER BY case_row.created_at DESC,actor.created_at LIMIT 1`,[subjectKey]);
  const row = result.rows[0];
  if (!row) throw new Error("synthetic_uat_runtime_context_not_found");
  const types = await client.query<{id:string;code:string;display_name:string;description:string}>(
    "SELECT id,code,display_name,description FROM document_types WHERE organization_id=$1 AND status='active' ORDER BY code",
    [row.organization_id]);
  return {
    organizationId:row.organization_id,subjectId:row.subject_id,actorId:row.actor_id,
    profileVersionId:row.profile_version_id,releaseVersionId:row.release_version_id,
    releaseDefinition:row.release_definition,
    allowedDocumentTypes:types.rows.map((item)=>({id:item.id,code:item.code,displayName:item.display_name,description:item.description})),
  };
}

async function configurePolicy(client:pg.Client,runtime:RuntimeContext,manifest:M44Manifest,manifestHash:string):Promise<string>{
  const result=await client.query<{result:Record<string,unknown>}>(
    "SELECT dop_configure_classification_quality_policy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result",
    [runtime.actorId,runtime.subjectId,runtime.profileVersionId,runtime.releaseVersionId,
      manifest.highRiskDocumentTypeCodes,manifest.firstClientConfiguration,
      "Configure Blue Peak as the synthetic first-client M44 statistical classification quality programme.",
      uuidFromHash(`policy|${manifestHash}`),uuidFromHash(`policy-correlation|${manifestHash}`),new Date()]);
  const value=result.rows[0]?.result;
  if (!value || (value.outcome!=="completed" && value.outcome!=="duplicate") || typeof value.policyId!=="string") {
    throw new Error(`classification_quality_policy_configuration_failed:${JSON.stringify(value)}`);
  }
  return value.policyId;
}

function buildSamples(manifest:M44Manifest):EvaluationSample[]{
  const samples:EvaluationSample[]=[];
  for(let index=1;index<=manifest.routineBankStatementFamilies;index+=1){
    const key=String(index).padStart(3,"0");
    samples.push({sampleId:`m44-bank-${key}`,familyId:`bank-family-${key}`,filename:`m44-bank-${key}.pdf`,
      expectedDocumentTypeCode:"bank_statement",expectedRoute:"review_required",riskStratum:"routine",
      content:bankStatement(manifest.subjectDisplayName,"2026-Q3",index)});
  }
  for(let index=1;index<=manifest.nearDuplicateVariants;index+=1){
    samples.push({sampleId:`m44-near-duplicate-${index}`,familyId:"bank-family-001",filename:`m44-bank-001-variant-${index}.pdf`,
      expectedDocumentTypeCode:"bank_statement",expectedRoute:"accepted",riskStratum:"routine",
      content:[...bankStatement(manifest.subjectDisplayName,"2026-Q3",1),`LAYOUT VARIANT ${index} OF THE SAME LOGICAL STATEMENT`]});
  }
  for(const code of manifest.highRiskDocumentTypeCodes){
    for(let index=1;index<=manifest.highRiskFamiliesPerType;index+=1){
      samples.push({sampleId:`m44-${code}-${index}`,familyId:`${code}-family-${index}`,filename:`m44-${code}-${index}.pdf`,
        expectedDocumentTypeCode:code,expectedRoute:"review_required",riskStratum:"high_risk_type",
        content:highRiskDocument(code,manifest.subjectDisplayName,index)});
    }
  }
  for(const stratum of manifest.safetyStrata){
    for(let index=1;index<=manifest.safetyFamiliesPerStratum;index+=1){
      samples.push(safetySample(stratum,index,manifest.subjectDisplayName));
    }
  }
  return samples;
}

function safetySample(stratum:ClassificationRiskStratum,index:number,subject:string):EvaluationSample{
  const base={sampleId:`m44-${stratum}-${index}`,familyId:`${stratum}-family-${index}`,filename:`m44-${stratum}-${index}.pdf`,
    expectedDocumentTypeCode:stratum==="unknown_type"||stratum==="critical_conflict"?"unknown":"bank_statement",
    expectedRoute:"review_required" as const,riskStratum:stratum};
  if(stratum==="wrong_subject") return {...base,content:bankStatement("Harbour Ridge Trading Limited","2026-Q3",200+index)};
  if(stratum==="wrong_period") return {...base,content:bankStatement(subject,"2025-Q4",300+index)};
  if(stratum==="unknown_type") return {...base,content:["SYNTHETIC BOARD MEETING MINUTES",`ENTITY: ${subject}`,
    "DIRECTORS DISCUSSED A FUTURE MARKETING PLAN.","NO FINANCIAL DOCUMENT IS ATTACHED.",`MINUTE SERIAL ${index}`]};
  if(stratum==="critical_conflict") return {...base,content:["SYNTHETIC MERGED AND CONFLICTING DOCUMENT",
    `BANK STATEMENT ACCOUNT HOLDER: ${subject}`,"STATEMENT PERIOD: 2026-Q3","TAX INVOICE CUSTOMER: DIFFERENT FICTIONAL COMPANY",
    `INVOICE TOTAL: NZD ${100+index}`,"TWO DIFFERENT DOCUMENT TYPES AND ENTITIES APPEAR IN THIS FILE"]};
  return {...base,content:["SYNTHETIC PARTIAL SCAN","MOST OF THIS DOCUMENT IS MISSING OR ILLEGIBLE",
    `POSSIBLE ENTITY FRAGMENT: ${subject.slice(0,8)}...`,`UNREADABLE AMOUNT: ??${index}??`,"PAGE 1 OF 4 ONLY"]};
}

async function syntheticPdf(lines:string[]):Promise<Buffer>{
  const document=await PDFDocument.create();
  document.setTitle("Synthetic M44 classification fixture");
  document.setAuthor("Document Operations Platform synthetic evaluation");
  document.setCreationDate(new Date("2026-08-17T00:00:00Z"));
  document.setModificationDate(new Date("2026-08-17T00:00:00Z"));
  const page=document.addPage([595,842]);
  const font=await document.embedFont(StandardFonts.Helvetica);
  lines.forEach((line,index)=>page.drawText(line,{x:42,y:790-index*28,size:11,font}));
  return Buffer.from(await document.save({useObjectStreams:false}));
}

function databaseOptions(raw:string):pg.ClientConfig{
  const url=new URL(raw);url.searchParams.delete("sslmode");
  return {connectionString:url.toString(),ssl:{ca:readFileSync(resolve(workspaceRoot,"platform/config/certificates/supabase-root-2021.crt"),"utf8"),rejectUnauthorized:true}};
}
function readKeychain(account:string,service:string):string{
  const value=execFileSync("/usr/bin/security",["find-generic-password","-a",account,"-s",service,"-w"],
    {encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
  if(!value) throw new Error(`Keychain item is empty: ${service}`);return value;
}
function sha256(value:string):string{return createHash("sha256").update(value).digest("hex");}
function uuidFromHash(value:string):string{const hash=sha256(value);return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;}
function codedError(error:unknown):string{return typeof error==="object"&&error!==null&&"code" in error&&typeof (error as {code?:unknown}).code==="string"?(error as {code:string}).code:"unexpected_error";}
