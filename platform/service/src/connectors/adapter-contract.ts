import { createHash } from "node:crypto";
import type { CanonicalSubmission } from "../domain/submission.js";
import type { SourceConnectorDefinition, SourceConnectorType } from "../ports/ops-source-connector-repository.js";

export const CONNECTOR_ADAPTER_CONTRACT_VERSION = "1.0" as const;
type CanonicalAdapterSourceType = CanonicalSubmission["source"]["type"] | "sharepoint" | "sftp" | "object_storage";
type OfflineCanonicalSubmission = Omit<CanonicalSubmission,"source"> & {
  source: Omit<CanonicalSubmission["source"],"type"> & { type: CanonicalAdapterSourceType };
};

export type ConnectorAdapterReplayErrorCode =
  | "adapter_documents_capability_required"
  | "adapter_webhook_capability_required"
  | "adapter_attachments_capability_required"
  | "adapter_polling_capability_required"
  | "adapter_fixture_mime_not_allowed"
  | "adapter_fixture_size_exceeded"
  | "adapter_fixture_not_synthetic"
  | "adapter_definition_boundary_invalid";

export class ConnectorAdapterReplayError extends Error {
  constructor(readonly code: ConnectorAdapterReplayErrorCode) { super(code); }
}

export interface ConnectorAdapterFixtureEvidence {
  fixtureKey: string;
  status: "passed";
  canonicalSourceType: CanonicalAdapterSourceType;
  submissionIdempotencyKey: string;
  documentIdempotencyKey: string;
  canonicalSubmissionHash: string;
  canonicalEnvelopeHash: string;
  normalizedMimeType: string;
  declaredSizeBytes: number;
  fileCount: 1;
}

export interface ConnectorAdapterReplayEvidence {
  contractVersion: typeof CONNECTOR_ADAPTER_CONTRACT_VERSION;
  adapterKey: SourceConnectorType;
  connectorType: SourceConnectorType;
  transport: SourceConnectorDefinition["transport"];
  definitionHash: string;
  syntheticOnly: true;
  fixtureCount: number;
  passedCount: number;
  externalCallCount: 0;
  credentialResolution: "not_attempted";
  persistedDocuments: false;
  runtimeExecution: "disabled";
  externalDelivery: "disabled";
  fixtures: ConnectorAdapterFixtureEvidence[];
}

export function replayConnectorAdapter(
  definition: SourceConnectorDefinition,
  definitionHash: string,
): ConnectorAdapterReplayEvidence {
  validateReplayBoundary(definition);
  const canonicalSourceType=sourceTypeFor(definition.connectorType);
  const fixtures=definition.testFixtures.map((fixture,index):ConnectorAdapterFixtureEvidence=>{
    if (fixture.synthetic!==true) throw new ConnectorAdapterReplayError("adapter_fixture_not_synthetic");
    const normalizedMimeType=fixture.mimeType.trim().toLowerCase();
    if (!definition.dataBoundary.allowedMimeTypes.includes(normalizedMimeType))
      throw new ConnectorAdapterReplayError("adapter_fixture_mime_not_allowed");
    const declaredSizeBytes=Math.max(1,Buffer.byteLength(fixture.payloadSummary,"utf8"));
    if (declaredSizeBytes>definition.dataBoundary.maxFileBytes)
      throw new ConnectorAdapterReplayError("adapter_fixture_size_exceeded");
    const submission:OfflineCanonicalSubmission={
      schema_version:"1.0",environment:"DEV",organization_key:"synthetic-offline-replay",
      workflow_template_key:"connector.adapter.contract",case_key:`synthetic|${definition.connectorKey}|${fixture.fixtureKey}`,
      subject:{subject_key:"synthetic-adapter-subject",display_name:"Synthetic Adapter Replay Subject"},
      source:{type:canonicalSourceType,connector_key:definition.connectorKey,
        submission_id:`${definition.connectorKey}:${fixture.fixtureKey}`,received_at:"2000-01-01T00:00:00.000Z",
        source_reference:`offline-replay://${definition.connectorType}/${fixture.fixtureKey}`},
      business_context:{synthetic:true,adapter_contract_version:CONNECTOR_ADAPTER_CONTRACT_VERSION},
      files:[{source_file_id:`${fixture.fixtureKey}:file:${index}`,original_filename:fixture.filename,
        download_url:`https://example.invalid/offline-replay/${definition.connectorType}/${encodeURIComponent(fixture.fixtureKey)}`,
        declared_mime_type:normalizedMimeType,declared_size_bytes:declaredSizeBytes,
        content_hash_sha256:sha256(`${fixture.fixtureKey}|${fixture.filename}|${fixture.payloadSummary}`)}],
    };
    const envelope={schemaVersion:"1.0",adapterContractVersion:CONNECTOR_ADAPTER_CONTRACT_VERSION,
      connector:{key:definition.connectorKey,type:definition.connectorType,transport:definition.transport,definitionHash},
      source:{type:canonicalSourceType,referenceScheme:"offline-replay",submissionId:submission.source.submission_id},
      file:{originalFilename:fixture.filename,declaredMimeType:normalizedMimeType,declaredSizeBytes},
      boundary:{maxFilesPerSubmission:definition.dataBoundary.maxFilesPerSubmission,
        maxFileBytes:definition.dataBoundary.maxFileBytes,allowedMimeTypes:definition.dataBoundary.allowedMimeTypes},
      validation:{status:"passed",syntheticFixture:true},
      safety:{credentialResolution:"not_attempted",externalCallCount:0,persistedDocuments:false,
        runtimeExecution:"disabled",externalDelivery:"disabled"}};
    return {fixtureKey:fixture.fixtureKey,status:"passed",canonicalSourceType,
      submissionIdempotencyKey:`${submission.source.type}|${submission.source.submission_id}`,
      documentIdempotencyKey:`${submission.source.type}|${submission.source.submission_id}|${submission.files[0]!.source_file_id}`,
      canonicalSubmissionHash:sha256(stableJson(submission)),canonicalEnvelopeHash:sha256(stableJson(envelope)),
      normalizedMimeType,declaredSizeBytes,fileCount:1};
  });
  return {contractVersion:CONNECTOR_ADAPTER_CONTRACT_VERSION,adapterKey:definition.connectorType,
    connectorType:definition.connectorType,transport:definition.transport,definitionHash,syntheticOnly:true,
    fixtureCount:fixtures.length,passedCount:fixtures.length,externalCallCount:0,credentialResolution:"not_attempted",
    persistedDocuments:false,runtimeExecution:"disabled",externalDelivery:"disabled",fixtures};
}

function validateReplayBoundary(definition:SourceConnectorDefinition):void {
  const capabilities=definition.capabilities;
  if (!capabilities.includes("documents")) throw new ConnectorAdapterReplayError("adapter_documents_capability_required");
  if (definition.connectorType==="form"&&!capabilities.includes("webhook"))
    throw new ConnectorAdapterReplayError("adapter_webhook_capability_required");
  if (definition.connectorType==="email"&&!capabilities.includes("attachments"))
    throw new ConnectorAdapterReplayError("adapter_attachments_capability_required");
  if (definition.transport==="pull"&&!capabilities.includes("polling"))
    throw new ConnectorAdapterReplayError("adapter_polling_capability_required");
  if (definition.dataBoundary.syntheticOnly!==true||definition.dataBoundary.externalDelivery!=="disabled"
    ||definition.activationPolicy.runtimeExecution!=="disabled"||definition.dataBoundary.maxFilesPerSubmission<1
    ||definition.testFixtures.length>definition.dataBoundary.maxFilesPerSubmission)
    throw new ConnectorAdapterReplayError("adapter_definition_boundary_invalid");
}

function sourceTypeFor(connectorType:SourceConnectorType):CanonicalAdapterSourceType {
  return ({manual_upload:"internal_upload",form:"fillout",email:"email",api:"api",sharepoint:"sharepoint",
    sftp:"sftp",object_storage:"object_storage"} as const)[connectorType];
}

function stableJson(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value&&typeof value==="object") return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value:string):string { return createHash("sha256").update(value,"utf8").digest("hex"); }
