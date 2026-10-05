export type SourceConnectorType = "manual_upload" | "form" | "email" | "sharepoint" | "api" | "sftp" | "object_storage";
export type SourceConnectorTransport = "operator" | "push" | "pull";
export type SourceConnectorCapability = "documents" | "metadata" | "attachments" | "webhook" | "polling";

export interface SourceConnectorTestFixture {
  fixtureKey: string;
  displayName: string;
  synthetic: true;
  filename: string;
  mimeType: string;
  payloadSummary: string;
}

export interface SourceConnectorDefinition {
  schemaVersion: "1.0";
  environment: "DEV";
  connectorKey: string;
  connectorType: SourceConnectorType;
  transport: SourceConnectorTransport;
  capabilities: SourceConnectorCapability[];
  credentialReference: {
    mode: "none" | "secret_reference";
    provider: "none" | "railway" | "supabase" | "external_vault";
    reference: string | null;
  };
  dataBoundary: {
    syntheticOnly: true;
    externalDelivery: "disabled";
    maxFilesPerSubmission: number;
    maxFileBytes: number;
    allowedMimeTypes: string[];
  };
  activationPolicy: {
    explicitApprovalRequired: true;
    emergencySuspendEnabled: true;
    runtimeExecution: "disabled";
  };
  testFixtures: SourceConnectorTestFixture[];
}

export interface SourceConnectorDifference {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

export interface OpsSourceConnectorVersion {
  id: string;
  connectorId: string;
  connectorKey: string;
  displayName: string;
  description: string;
  lifecycleStatus: "registered" | "active" | "suspended" | "revoked";
  version: number;
  revision: number;
  status: "draft" | "in_review" | "approved" | "active" | "suspended" | "revoked";
  definition: SourceConnectorDefinition;
  enforcementProfile: {
    schemaVersion: "1.0";
    policySource: "connector_definition" | "legacy_safe_default";
    capabilities: SourceConnectorCapability[];
    maxFilesPerSubmission: number;
    maxFileBytes: number;
    allowedMimeTypes: string[];
    syntheticOnly: boolean;
    externalDelivery: "disabled";
    runtimeExecution: "disabled";
  };
  definitionHash: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  isLatestRevision: boolean;
  isCurrentVersion: boolean;
  isActiveVersion: boolean;
  hasPassingTest: boolean;
  referencedByPlanCount: number;
  differencesFromActive: SourceConnectorDifference[];
}

export interface OpsSourceConnectorTestRun {
  id: string;
  connectorId: string;
  connectorVersionId: string;
  definitionHash: string;
  status: "passed" | "failed";
  result: Record<string, unknown>;
  adapterContractVersion: "1.0" | null;
  replayHash: string | null;
  runByName: string | null;
  reason: string;
  createdAt: string;
}

export interface OpsSourceConnectorSnapshot {
  generatedAt: string;
  canManage: boolean;
  versions: OpsSourceConnectorVersion[];
  testRuns: OpsSourceConnectorTestRun[];
  supportedTypes: SourceConnectorType[];
  supportedCapabilities: SourceConnectorCapability[];
}

export type OpsSourceConnectorMutationResult = Record<string, unknown> & {
  outcome: "completed" | "duplicate" | "conflict" | "not_found";
  reason?: string;
};

export interface OpsSourceConnectorRepository {
  getConnectors(organizationKey: string, actorId: string, now: Date): Promise<OpsSourceConnectorSnapshot>;
  createConnector(organizationKey: string, request: {
    actorId: string; connectorKey: string; displayName: string; description: string;
    definition: SourceConnectorDefinition; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsSourceConnectorMutationResult>;
  updateDraft(organizationKey: string, request: {
    actorId: string; versionId: string; definition: SourceConnectorDefinition;
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsSourceConnectorMutationResult>;
  runTest(organizationKey: string, request: {
    actorId: string; versionId: string; reason: string; idempotencyKey: string;
    correlationId: string; now: Date;
  }): Promise<OpsSourceConnectorMutationResult>;
  transitionVersion(organizationKey: string, request: {
    actorId: string; versionId: string;
    action: "submit_review" | "return_to_draft" | "approve" | "activate" | "suspend" | "reactivate" | "revoke";
    reason: string; idempotencyKey: string; correlationId: string; now: Date;
  }): Promise<OpsSourceConnectorMutationResult>;
}
