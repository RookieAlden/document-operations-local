import { describe,expect,it } from "vitest";
import { ConnectorAdapterReplayError,replayConnectorAdapter } from "../src/connectors/adapter-contract.js";
import type { SourceConnectorDefinition,SourceConnectorType } from "../src/ports/ops-source-connector-repository.js";

const variants:Array<{type:SourceConnectorType;transport:"operator"|"push"|"pull";capabilities:SourceConnectorDefinition["capabilities"]}>=[
  {type:"manual_upload",transport:"operator",capabilities:["documents","metadata"]},
  {type:"form",transport:"push",capabilities:["documents","metadata","webhook"]},
  {type:"email",transport:"push",capabilities:["documents","metadata","attachments"]},
  {type:"api",transport:"push",capabilities:["documents","metadata"]},
  {type:"sharepoint",transport:"pull",capabilities:["documents","metadata","polling"]},
  {type:"sftp",transport:"pull",capabilities:["documents","polling"]},
  {type:"object_storage",transport:"pull",capabilities:["documents","metadata","polling"]},
];

describe("Connector Adapter Contract offline replay",()=>{
  it.each(variants)("deterministically replays the $type adapter without network or persistence",({type,transport,capabilities})=>{
    const definition=fixture(type,transport,capabilities);
    const first=replayConnectorAdapter(definition,"a".repeat(64));
    const second=replayConnectorAdapter(definition,"a".repeat(64));
    expect(second).toEqual(first);
    expect(first).toMatchObject({contractVersion:"1.0",adapterKey:type,connectorType:type,transport,
      syntheticOnly:true,fixtureCount:1,passedCount:1,externalCallCount:0,credentialResolution:"not_attempted",
      persistedDocuments:false,runtimeExecution:"disabled",externalDelivery:"disabled"});
    expect(first.fixtures[0]).toMatchObject({status:"passed",normalizedMimeType:"application/pdf",fileCount:1});
    expect(JSON.stringify(first)).not.toContain("example.invalid");
  });

  it("produces different hashes for distinct adapter fixtures",()=>{
    const first=replayConnectorAdapter(fixture("api","push",["documents"]),"b".repeat(64));
    const changed=fixture("api","push",["documents"]); changed.testFixtures[0]!.payloadSummary+=" Changed synthetic content.";
    const second=replayConnectorAdapter(changed,"b".repeat(64));
    expect(second.fixtures[0]!.canonicalSubmissionHash).not.toBe(first.fixtures[0]!.canonicalSubmissionHash);
    expect(second.fixtures[0]!.canonicalEnvelopeHash).not.toBe(first.fixtures[0]!.canonicalEnvelopeHash);
  });

  it("fails closed on unsafe capabilities, MIME and size boundaries",()=>{
    const noDocuments=fixture("api","push",["metadata"]);
    expect(()=>replayConnectorAdapter(noDocuments,"c".repeat(64))).toThrowError(
      expect.objectContaining<Partial<ConnectorAdapterReplayError>>({code:"adapter_documents_capability_required"}));
    const wrongMime=fixture("api","push",["documents"]); wrongMime.testFixtures[0]!.mimeType="image/png";
    expect(()=>replayConnectorAdapter(wrongMime,"c".repeat(64))).toThrowError(
      expect.objectContaining<Partial<ConnectorAdapterReplayError>>({code:"adapter_fixture_mime_not_allowed"}));
    const tooLarge=fixture("api","push",["documents"]); tooLarge.dataBoundary.maxFileBytes=10;
    expect(()=>replayConnectorAdapter(tooLarge,"c".repeat(64))).toThrowError(
      expect.objectContaining<Partial<ConnectorAdapterReplayError>>({code:"adapter_fixture_size_exceeded"}));
  });
});

function fixture(type:SourceConnectorType,transport:"operator"|"push"|"pull",capabilities:SourceConnectorDefinition["capabilities"]):SourceConnectorDefinition {
  return {schemaVersion:"1.0",environment:"DEV",connectorKey:`m23.${type}.synthetic`,connectorType:type,transport,capabilities,
    credentialReference:type==="manual_upload"?{mode:"none",provider:"none",reference:null}:
      {mode:"secret_reference",provider:"railway",reference:`railway://secret/DOP_M23_${type.toUpperCase()}`},
    dataBoundary:{syntheticOnly:true,externalDelivery:"disabled",maxFilesPerSubmission:5,maxFileBytes:1000,
      allowedMimeTypes:["application/pdf"]},
    activationPolicy:{explicitApprovalRequired:true,emergencySuspendEnabled:true,runtimeExecution:"disabled"},
    testFixtures:[{fixtureKey:`${type}.fixture`,displayName:`${type} synthetic fixture`,synthetic:true,
      filename:`${type}-synthetic.pdf`,mimeType:"application/pdf",
      payloadSummary:`Purely synthetic ${type} fixture for deterministic offline adapter replay without external access.`}]};
}
