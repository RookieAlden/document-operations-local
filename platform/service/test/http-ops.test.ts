import { request as httpRequest, createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpsRouter } from "../src/http/ops-router.js";
import { ResolveDocumentReview } from "../src/application/resolve-document-review.js";
import { TransitionIssue } from "../src/application/transition-issue.js";
import { TransitionTask } from "../src/application/transition-task.js";
import type { OpsCaseDetail, OpsOverview, OpsReadRepository } from "../src/ports/ops-read-repository.js";
import type { OpsIssueRepository, TransitionIssueRequest, TransitionIssueResult } from "../src/ports/ops-issue-repository.js";
import type { OpsTaskRepository, OpsTaskSnapshot, TransitionTaskRequest, TransitionTaskResult } from "../src/ports/ops-task-repository.js";
import type { OpsReminderRepository, ReminderDecisionResult } from "../src/ports/ops-reminder-repository.js";
import type { OpsRetentionRepository,RetentionDashboard,RetentionMutationResult } from "../src/ports/ops-retention-repository.js";
import type { OpsDemoFormRepository,OpsDemoFormSnapshot,OpsDemoFormMutationResult,OpsClientPortalQuestionMutationResult } from "../src/ports/ops-demo-form-repository.js";
import type { OpsReviewRepository, ResolveDocumentReviewRequest, ResolveDocumentReviewResult } from "../src/ports/ops-review-repository.js";
import type {
  OpsIdentityAuthenticator,
  OpsIdentityAuthenticationResult,
  OpsIdentityCredentials,
  OpsIdentityRepository,
  OpsAuthorizedActor,
} from "../src/ports/ops-identity.js";
import type { OpsAccessRepository, OpsAccessSnapshot, OpsAccessMutationResult } from "../src/ports/ops-access-repository.js";
import type { OpsConfigurationRepository, OpsConfigurationSnapshot, OpsConfigurationMutationResult } from "../src/ports/ops-configuration-repository.js";
import type { OpsOnboardingRepository, OpsOnboardingSnapshot, OpsOnboardingMutationResult } from "../src/ports/ops-onboarding-repository.js";
import type {
  CasePlanDefinition,
  OpsCasePlanMutationResult,
  OpsCasePlanRepository,
  OpsCasePlanSnapshot,
} from "../src/ports/ops-case-plan-repository.js";
import type {
  OpsWorkPackageMutationResult,
  OpsWorkPackageRepository,
  OpsWorkPackageSnapshot,
  WorkPackageBlueprint,
} from "../src/ports/ops-work-package-repository.js";
import type {
  ClassificationProfileDefinition,
  OpsClassificationProfileMutationResult,
  OpsClassificationProfileRepository,
  OpsClassificationProfileSnapshot,
} from "../src/ports/ops-classification-profile-repository.js";
import type {
  OpsMissingRequestMutationResult,
  OpsMissingRequestRepository,
} from "../src/ports/ops-missing-request-repository.js";
import type {
  OpsPersistedSession,
  OpsSessionRepository,
} from "../src/ports/ops-session-repository.js";
import type {
  OpsReleaseReadinessMutationResult,
  OpsReleaseReadinessRepository,
  OpsReleaseReadinessSnapshot,
  ReleaseReadinessDeclarations,
} from "../src/ports/ops-release-readiness-repository.js";
import type {
  OpsUatBlueprintMutationResult,
  OpsUatBlueprintRepository,
  OpsUatBlueprintSnapshot,
  OpsUatAuthorizationRecompilation,
  UatEnvironmentBlueprintDefinition,
} from "../src/ports/ops-uat-blueprint-repository.js";
import type {
  OpsDocumentUploadBroker,
  OpsTrialRepository,
} from "../src/ports/ops-trial-repository.js";

const sessionSecret = "session-secret-with-more-than-thirty-two-characters";
const operatorEmail = "operator@example.invalid";
const operatorPassword = "correct-dev-password";
const externalSubjectId = "supabase-auth:00000000-0000-4000-9000-000000000999";
const operatorActorId = "00000000-0000-4000-8200-000000000201";
const reviewDocumentId = "00000000-0000-4000-e000-000000000001";
const caseId = "00000000-0000-4000-8000-000000000001";
const issueIdOne = "00000000-0000-4000-a000-000000000001";
const issueIdTwo = "00000000-0000-4000-a000-000000000002";
const taskId = "00000000-0000-4000-a100-000000000001";
const reminderId = "00000000-0000-4000-a200-000000000001";
const packageVersionId = "00000000-0000-4000-c600-000000006201";
const releaseId = "00000000-0000-4000-c400-000000005101";
const subjectId = "00000000-0000-4000-8100-000000000101";
const casePlanVersionId = "00000000-0000-4000-c700-000000007101";
const casePlanPreviewId = "00000000-0000-4000-c800-000000008101";
const workPackageId = "00000000-0000-4000-c500-000000006101";
const workPackageVersionId = "00000000-0000-4000-c600-000000006301";
const workflowTemplateId = "00000000-0000-4000-a000-000000002001";
const classificationProfileVersionId = "00000000-0000-4000-c900-000000009101";
const missingRequestDraftId = "00000000-0000-4000-ca00-000000000101";
const missingRequestRevisionId = "00000000-0000-4000-cb00-000000000101";
const deliveryJobId = "00000000-0000-4000-cc00-000000000101";
const deliveryEvaluationId = "00000000-0000-4000-cd00-000000000101";
const recipientActorId = "00000000-0000-4000-8300-000000000101";
const releaseManifestId = "00000000-0000-4000-ce00-000000000101";
const uatBlueprintId = "00000000-0000-4000-cf00-000000000101";
const uatProvisioningPackageId = "00000000-0000-4000-cf00-000000000201";
const uatActivationApprovalPackId = "00000000-0000-4000-cf00-000000000301";
const uatFinalAuthorizationRequestId = "00000000-0000-4000-cf00-000000000401";
const servers: Server[] = [];
const casePlanDefinition: CasePlanDefinition = {
  cadence: { mode: "calendar_months", intervalMonths: 1, anchorDate: "2026-11-01" },
  timezone: "Pacific/Auckland",
  dueRule: { basis: "period_end", offsetDays: 7, localTime: "17:00" },
  defaultPreviewCount: 2,
  sourceBinding: { type: "manual_upload", bindingKey: "m16-manual-upload", metadata: { synthetic: true } },
  externalDelivery: "disabled",
};
const workPackageBlueprint: WorkPackageBlueprint = {
  subjectDefaults: { status: "active", attributes: { synthetic: true, case_generation_enabled: true } },
  workflow: {
    frequency: "monthly", environment: "DEV", external_messages_require_approval: true,
    dev_recipient_policy: "allowlist_only",
  },
  requirements: [{ code: "bank.minimum", documentTypeCode: "bank_statement", minimumCount: 1, maximumCount: null, acceptanceRule: { notes: "Complete synthetic period." } }],
};
const classificationProfileDefinition: ClassificationProfileDefinition = {
  schemaVersion: "1.0", environment: "DEV", unknownDocumentRoute: "review_required", ambiguityRoute: "review_required",
  labels: [{ code: "bank_statement", displayName: "Bank Statement",
    description: "Synthetic bank statement classification definition.", allowedMimeTypes: ["application/pdf"],
    extractionFields: [{ key: "account_number", displayName: "Account number", valueType: "string", required: false }],
    policy: { minimumConfidence: 0.8, alwaysHumanConfirm: false, manualOnConflict: true,
      rejectOnQualityFlags: ["partial"], rejectOnConflictFlags: ["period_conflict"] } }],
  evaluationCases: [
    { caseKey: "baseline.accepted", displayName: "Accepted synthetic sample", synthetic: true, filename: "accepted.pdf", mimeType: "application/pdf", predictedLabelCode: "bank_statement", ambiguousLabelCodes: [], confidence: 0.99, qualityFlags: [], conflictFlags: [], expectedRoute: "accepted" },
    { caseKey: "baseline.low", displayName: "Low confidence synthetic sample", synthetic: true, filename: "low.pdf", mimeType: "application/pdf", predictedLabelCode: "bank_statement", ambiguousLabelCodes: [], confidence: 0.1, qualityFlags: [], conflictFlags: [], expectedRoute: "review_required" },
    { caseKey: "baseline.unknown", displayName: "Unknown synthetic sample", synthetic: true, filename: "unknown.bin", mimeType: "application/octet-stream", predictedLabelCode: "__unknown__", ambiguousLabelCodes: [], confidence: 0.95, qualityFlags: [], conflictFlags: [], expectedRoute: "review_required" },
  ],
};
const releaseReadinessDeclarations: ReleaseReadinessDeclarations = {
  schemaVersion: "1.0",
  sourceEnvironment: "DEV",
  targetEnvironment: "UAT",
  targetProvisioning: "not_started",
  runtimeExecution: "disabled",
  externalDelivery: "disabled",
  externalIngress: "disabled",
  dataBoundary: "synthetic_only",
  approvals: {
    dataRegion: { status: "approved", reference: "decision://data-region/NZ" },
    privacyRetention: { status: "approved", reference: "decision://privacy/90-days" },
    budget: { status: "approved", reference: "decision://budget/zero-uat", monthlyLimitUsd: 0 },
    sharedMailbox: { status: "not_required", reference: null },
  },
  secretReferences: ["keychain://OPENAI_API_KEY_DEV"],
};
const uatBlueprintDefinition: UatEnvironmentBlueprintDefinition = {
  schemaVersion:"1.0",sourceEnvironment:"DEV",targetEnvironment:"UAT",provisioningMode:"dry_run_only",
  targetProvisioning:"not_started",dataBoundary:"synthetic_only",dataCopy:"none",runtimeExecution:"disabled",
  externalIngress:"disabled",externalDelivery:"disabled",secretMaterialization:"disabled",
  topology:{provider:"railway",isolation:"dedicated_environment",database:"dedicated_supabase_project",
    storage:"dedicated_private_bucket",services:[
      {key:"intake",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
      {key:"preservation",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
      {key:"classification",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
    ]},
  decisions:{dataRegion:{status:"approved",reference:"decision://uat/region/sydney",region:"Sydney"},
    privacyRetention:{status:"approved",reference:"decision://uat/retention/30-days",retentionDays:30,realDataRequiresReapproval:true},
    budget:{status:"approved",reference:"decision://uat/budget/zero",monthlyLimitUsd:0,paidResourceProvisioning:"prohibited"},
    runtimeOwner:{status:"approved",reference:"decision://uat/owner/project-owner",actorId:operatorActorId}},
  variableNames:["DOP_ENVIRONMENT","DOP_ORGANIZATION_KEY","DATABASE_URL","OPENAI_API_KEY","DOP_OPS_SESSION_SECRET"],
  secretReferences:[{variableName:"DATABASE_URL",reference:"vault://uat/database-url"}],
  migration:{strategy:"ordered_sql",seedMode:"synthetic_only",migrations:["001..028"],verificationScripts:["032_zero_budget_uat_decision_lock_regression.sql"]},
  acceptance:{healthCheck:"required",errorLogs:"zero_required",syntheticJourney:"required",realData:"prohibited"},
  rollback:{strategy:"remove_unexposed_target",preserveAuditEvidence:true,maxMinutes:30},
};
const overview: OpsOverview = {
  generatedAt: "2026-08-07T02:00:00.000Z",
  organizationKey: "dev-accounting-firm",
  operator: { id: operatorActorId, displayName: "Emma Chen", actorType: "staff" },
  summary: {
    activeCaseCount: 1, dueSoonCaseCount: 0, overdueCaseCount: 0, reviewDocumentCount: 0,
    openIssueCount: 0, scheduledRetryCount: 1, manualErrorCount: 0, overdueRetryCount: 1,
  },
  cases: [{
    id: caseId,
    subjectKey: "dev-client-001",
    subjectName: "Kauri Coast Cafe Limited",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    status: "waiting_for_documents",
    riskStatus: "normal",
    dueAt: "2026-08-07T05:00:00.000Z",
    acceptedRequirementCount: 1,
    requiredRequirementCount: 4,
    documentCount: 1,
    openIssueCount: 0,
    requirements: [],
    completeness: null,
  }],
  reviewQueue: [],
  issues: [],
  retryQueue: [{
    id: "00000000-0000-4000-f000-000000000001",
    documentId: reviewDocumentId,
    caseId,
    subjectName: "Kauri Coast Cafe Limited",
    filename: "bank-july.pdf",
    moduleId: "classify-document",
    errorCode: "provider_timeout",
    errorClass: "timeout",
    status: "retry_scheduled",
    retryCount: 1,
    nextRetryAt: "2026-08-07T01:55:00.000Z",
    openedAt: "2026-08-07T01:50:00.000Z",
  }],
  recentActivity: [],
};
const caseDetail: OpsCaseDetail = {
  generatedAt: overview.generatedAt,
  case: overview.cases[0]!,
  documents: [],
  issues: [],
      missingDocumentRequestDraft: null,
      reminders: [],
      handoffTask: null,
  recentActivity: [],
};

class StubRepository implements OpsReadRepository {
  calls = 0;
  detailCalls = 0;
  async listCases(organizationKey: string, _now: Date, suppliedActorId: string) {
    expect(organizationKey).toBe("dev-accounting-firm");
    expect(suppliedActorId).toBe(operatorActorId);
    return overview.cases;
  }
  async getOverview(organizationKey: string, _now: Date, suppliedActorId: string): Promise<OpsOverview> {
    this.calls += 1;
    expect(organizationKey).toBe("dev-accounting-firm");
    expect(suppliedActorId).toBe(operatorActorId);
    return overview;
  }
  async getCaseDetail(organizationKey: string, suppliedCaseId: string, _now: Date, suppliedActorId: string): Promise<OpsCaseDetail | null> {
    this.detailCalls += 1;
    expect(organizationKey).toBe("dev-accounting-firm");
    expect(suppliedActorId).toBe(operatorActorId);
    return suppliedCaseId === caseId ? caseDetail : null;
  }
}

class StubIdentityAuthenticator implements OpsIdentityAuthenticator {
  async authenticate(credentials: OpsIdentityCredentials): Promise<OpsIdentityAuthenticationResult> {
    return credentials.email === operatorEmail && credentials.password === operatorPassword
      ? { outcome: "authenticated", externalSubjectId }
      : { outcome: "invalid_credentials" };
  }
}

class StubIdentityRepository implements OpsIdentityRepository {
  active = true;
  authorized = true;
  actorType: "staff" | "manager" | "admin" = "staff";
  platformConsoleAccess = true;
  private actor(): OpsAuthorizedActor {
    return {
      id: operatorActorId,
      displayName: "Emma Chen",
      actorType: this.actorType,
      platformConsoleAccess: this.platformConsoleAccess,
    };
  }
  async findActiveByExternalSubject(_organizationKey: string, suppliedSubject: string) {
    return this.active && this.authorized && suppliedSubject === externalSubjectId ? this.actor() : null;
  }
  async findActiveById(_organizationKey: string, actorId: string) {
    return this.active && actorId === operatorActorId ? this.actor() : null;
  }
}

class StubSessionRepository implements OpsSessionRepository {
  readonly sessions = new Map<string, OpsPersistedSession & { revoked: boolean }>();
  cleanupRequests: Parameters<OpsSessionRepository["cleanup"]>[1][] = [];
  private sequence = 1;
  async create(_organizationKey: string, request: Parameters<OpsSessionRepository["create"]>[1]) {
    if (this.sessions.has(request.tokenHash)) return false;
    this.sessions.set(request.tokenHash, {
      id: `00000000-0000-4000-a900-${String(this.sequence++).padStart(12, "0")}`,
      actorId: request.actorId,
      expiresAt: request.expiresAt,
      sessionMode: request.sessionMode,
      issuedAt: request.issuedAt,
      lastSeenAt: request.issuedAt,
      revoked: false,
    });
    return true;
  }
  async findActive(_organizationKey: string, tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    return session && !session.revoked && session.expiresAt > now ? session : null;
  }
  async revoke(_organizationKey: string, tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revoked) return false;
    session.revoked = true;
    return true;
  }
  async list(_organizationKey: string, request: Parameters<OpsSessionRepository["list"]>[1]) {
    return [...this.sessions.entries()].map(([tokenHash, session]) => ({
      id: session.id, actorId: session.actorId, actorDisplayName: "Emma Chen", actorType: "admin" as const,
      sessionMode: session.sessionMode, status: session.revoked ? "revoked" as const : "active" as const,
      issuedAt: session.issuedAt, expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt,
      revokedAt: session.revoked ? request.now : null, revokeReason: session.revoked ? "user_revoked" : null,
      isCurrent: tokenHash === request.currentTokenHash,
    }));
  }
  async revokeById(_organizationKey: string, request: Parameters<OpsSessionRepository["revokeById"]>[1]) {
    const entry = [...this.sessions.entries()].find(([, session]) => session.id === request.sessionId);
    if (!entry) return { outcome: "session_not_found", revoked: false, currentSession: false };
    const [tokenHash, session] = entry;
    if (session.revoked) return { outcome: "session_not_active", revoked: false, currentSession: false };
    session.revoked = true;
    return { outcome: "completed", revoked: true, currentSession: tokenHash === request.currentTokenHash };
  }
  async revokeOtherDevices(_organizationKey: string, request: Parameters<OpsSessionRepository["revokeOtherDevices"]>[1]) {
    let revokedCount = 0;
    for (const [tokenHash, session] of this.sessions) {
      if (session.actorId === request.actorId && tokenHash !== request.currentTokenHash && !session.revoked) {
        session.revoked = true; revokedCount += 1;
      }
    }
    return { outcome: "completed", revokedCount };
  }
  async cleanup(_organizationKey: string, request: Parameters<OpsSessionRepository["cleanup"]>[1]) {
    this.cleanupRequests.push(request);
    return { outcome: request.apply ? "completed" : "dry_run", candidateCount: 2,
      deletedCount: request.apply ? 2 : 0, cutoffAt: new Date(request.now.getTime() - request.retentionDays * 86_400_000) };
  }
}

class StubAccessRepository implements OpsAccessRepository {
  reads = 0;
  creations: Parameters<OpsAccessRepository["createInvitation"]>[1][] = [];
  result: OpsAccessMutationResult = { outcome: "completed", invitationId: "00000000-0000-4000-8400-000000000501" };
  async getAccess(): Promise<OpsAccessSnapshot> { this.reads += 1; return { generatedAt: overview.generatedAt, members: [], invitations: [] }; }
  async createInvitation(_organizationKey: string, request: Parameters<OpsAccessRepository["createInvitation"]>[1]) { this.creations.push(request); return this.result; }
  async cancelInvitation() { return this.result; }
  async changeActorAccess() { return this.result; }
}

class StubConfigurationRepository implements OpsConfigurationRepository {
  reads = 0;
  clones: Parameters<OpsConfigurationRepository["cloneRelease"]>[1][] = [];
  result: OpsConfigurationMutationResult = { outcome: "completed", releaseId: "00000000-0000-4000-c400-000000009999" };
  async getConfigurations(): Promise<OpsConfigurationSnapshot> {
    this.reads += 1;
    return { generatedAt: overview.generatedAt, canManage: true, canCreateCases: true, releases: [], documentTypes: [], customerContacts: [] };
  }
  async cloneRelease(_organizationKey: string, request: Parameters<OpsConfigurationRepository["cloneRelease"]>[1]) { this.clones.push(request); return this.result; }
  async updateDraft() { return this.result; }
  async transitionRelease() { return this.result; }
}

class StubOnboardingRepository implements OpsOnboardingRepository {
  reads = 0;
  onboardings: Parameters<OpsOnboardingRepository["onboardSubject"]>[1][] = [];
  cases: Parameters<OpsOnboardingRepository["createCase"]>[1][] = [];
  result: OpsOnboardingMutationResult = { outcome: "completed" };
  async getOnboarding(): Promise<OpsOnboardingSnapshot> {
    this.reads += 1;
    return {
      generatedAt: overview.generatedAt,
      packages: [{
        id: packageVersionId,
        packageId: "00000000-0000-4000-c500-000000006101",
        packageKey: "monthly-document-operations",
        displayName: "Monthly document operations",
        description: "Reusable monthly document collection and classification starter.",
        industryPackage: "accounting",
        version: 1,
        workflowTemplateId: "00000000-0000-4000-9000-000000000001",
        workflowTemplateName: "Monthly accounting workflow",
        subjectDefaults: { status: "active", attributes: { synthetic: true } },
        workflow: { external_messages_require_approval: true },
        requirements: [{ code: "bank", documentTypeCode: "bank_statement", minimumCount: 1, maximumCount: null, acceptanceRule: {} }],
        definitionHash: "a".repeat(64),
        publishedAt: overview.generatedAt,
      }],
      recentOnboardings: [],
      customerContacts: [],
    };
  }
  async onboardSubject(_organizationKey: string, request: Parameters<OpsOnboardingRepository["onboardSubject"]>[1]) {
    this.onboardings.push(request);
    return this.result;
  }
  async createCase(_organizationKey: string, request: Parameters<OpsOnboardingRepository["createCase"]>[1]) {
    this.cases.push(request);
    return this.result;
  }
}

class StubCasePlanRepository implements OpsCasePlanRepository {
  reads = 0;
  creations: Parameters<OpsCasePlanRepository["createPlan"]>[1][] = [];
  previews: Parameters<OpsCasePlanRepository["previewPlan"]>[1][] = [];
  approvals: Parameters<OpsCasePlanRepository["approvePreview"]>[1][] = [];
  result: OpsCasePlanMutationResult = { outcome: "completed", versionId: casePlanVersionId };
  async getCasePlans(): Promise<OpsCasePlanSnapshot> {
    this.reads += 1;
    return {
      generatedAt: overview.generatedAt,
      canManage: true,
      canPreview: true,
      eligibleSubjects: [{ id: subjectId, subjectKey: "m15-rimu-design", subjectName: "Rimu Design Limited", configurationReleaseId: releaseId, configurationReleaseNumber: 2 }],
      eligibleSourceConnectors: [],
      versions: [],
      previews: [],
    };
  }
  async createPlan(_organizationKey: string, request: Parameters<OpsCasePlanRepository["createPlan"]>[1]) {
    this.creations.push(request);
    return this.result;
  }
  async updateDraft() { return this.result; }
  async transitionVersion() { return this.result; }
  async cloneVersion() { return this.result; }
  async previewPlan(_organizationKey: string, request: Parameters<OpsCasePlanRepository["previewPlan"]>[1]) {
    this.previews.push(request);
    return { outcome: "completed", previewId: casePlanPreviewId } as OpsCasePlanMutationResult;
  }
  async approvePreview(_organizationKey: string, request: Parameters<OpsCasePlanRepository["approvePreview"]>[1]) {
    this.approvals.push(request);
    return { outcome: "completed", approvalId: crypto.randomUUID(), generatedCaseIds: [crypto.randomUUID(), crypto.randomUUID()] } as OpsCasePlanMutationResult;
  }
}

class StubWorkPackageRepository implements OpsWorkPackageRepository {
  reads = 0;
  creations: Parameters<OpsWorkPackageRepository["createPackage"]>[1][] = [];
  dryRuns: Parameters<OpsWorkPackageRepository["runDryRun"]>[1][] = [];
  transitions: Parameters<OpsWorkPackageRepository["transitionVersion"]>[1][] = [];
  result: OpsWorkPackageMutationResult = { outcome: "completed", packageId: workPackageId, versionId: workPackageVersionId };
  async getWorkPackages(): Promise<OpsWorkPackageSnapshot> {
    this.reads += 1;
    return {
      generatedAt: overview.generatedAt, canManage: true, versions: [], dryRuns: [],
      workflowTemplates: [{ id: workflowTemplateId, templateKey: "monthly.documents", displayName: "Monthly documents", industryPackage: "accounting" }],
      documentTypes: [{ code: "bank_statement", displayName: "Bank Statement" }],
    };
  }
  async createPackage(_organizationKey: string, request: Parameters<OpsWorkPackageRepository["createPackage"]>[1]) { this.creations.push(request); return this.result; }
  async updateDraft() { return this.result; }
  async cloneVersion() { return this.result; }
  async runDryRun(_organizationKey: string, request: Parameters<OpsWorkPackageRepository["runDryRun"]>[1]) { this.dryRuns.push(request); return { outcome: "completed", status: "passed" } as OpsWorkPackageMutationResult; }
  async transitionVersion(_organizationKey: string, request: Parameters<OpsWorkPackageRepository["transitionVersion"]>[1]) { this.transitions.push(request); return this.result; }
  async retirePackage() { return this.result; }
}

class StubClassificationProfileRepository implements OpsClassificationProfileRepository {
  reads = 0;
  revisions: Parameters<OpsClassificationProfileRepository["updateDraft"]>[1][] = [];
  evaluations: Parameters<OpsClassificationProfileRepository["runEvaluation"]>[1][] = [];
  result: OpsClassificationProfileMutationResult = { outcome: "completed", versionId: classificationProfileVersionId };
  async getProfile(): Promise<OpsClassificationProfileSnapshot> {
    this.reads += 1;
    return { generatedAt: overview.generatedAt, canManage: true, versions: [], evaluationRuns: [],
      qualityFlags: ["partial"], conflictFlags: ["period_conflict"] };
  }
  async cloneVersion() { return this.result; }
  async updateDraft(_organizationKey: string, request: Parameters<OpsClassificationProfileRepository["updateDraft"]>[1]) {
    this.revisions.push(request); return this.result;
  }
  async runEvaluation(_organizationKey: string, request: Parameters<OpsClassificationProfileRepository["runEvaluation"]>[1]) {
    this.evaluations.push(request); return { outcome: "completed", status: "passed" } as OpsClassificationProfileMutationResult;
  }
  async transitionVersion() { return this.result; }
}

class StubMissingRequestRepository implements OpsMissingRequestRepository {
  revisions: Parameters<OpsMissingRequestRepository["createRevision"]>[1][] = [];
  transitions: Parameters<OpsMissingRequestRepository["transitionRevision"]>[1][] = [];
  deliveryPlans: Parameters<OpsMissingRequestRepository["planDelivery"]>[1][] = [];
  deliveryEvaluations: Parameters<OpsMissingRequestRepository["runDeliveryEvaluation"]>[1][] = [];
  deliveryAuthorizations: Parameters<OpsMissingRequestRepository["authorizeSyntheticDelivery"]>[1][] = [];
  deliveryReconciliations: Parameters<OpsMissingRequestRepository["reconcileUnknownDelivery"]>[1][] = [];
  result: OpsMissingRequestMutationResult = {
    outcome: "completed", revisionId: missingRequestRevisionId, revision: 2,
    status: "draft", deliveryMode: "disabled", externalCallCount: 0,
  };
  async createRevision(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["createRevision"]>[1]) {
    this.revisions.push(request); return this.result;
  }
  async transitionRevision(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["transitionRevision"]>[1]) {
    this.transitions.push(request);
    return { ...this.result, action: request.action, status: request.action === "submit_review" ? "in_review" : "approved" };
  }
  async planDelivery(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["planDelivery"]>[1]) {
    this.deliveryPlans.push(request);
    return { outcome: "completed", deliveryJobId, status: "planned", runtimeExecution: "disabled",
      providerConfigured: false, attemptCount: 0, externalCallCount: 0 } as OpsMissingRequestMutationResult;
  }
  async runDeliveryEvaluation(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["runDeliveryEvaluation"]>[1]) {
    this.deliveryEvaluations.push(request);
    return { outcome: "completed", evaluationId: deliveryEvaluationId, status: "passed",
      runtimeExecution: "disabled", externalCallCount: 0 } as OpsMissingRequestMutationResult;
  }
  async authorizeSyntheticDelivery(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["authorizeSyntheticDelivery"]>[1]) {
    this.deliveryAuthorizations.push(request);
    return { outcome: "completed", deliveryJobId, status: "queued", runtimeExecution: "synthetic",
      providerConfigured: true, scenario: request.scenario, externalCallCount: 0 } as OpsMissingRequestMutationResult;
  }
  async reconcileUnknownDelivery(_organizationKey: string, request: Parameters<OpsMissingRequestRepository["reconcileUnknownDelivery"]>[1]) {
    this.deliveryReconciliations.push(request);
    return { outcome: "completed", deliveryJobId, status: request.action === "proved_not_sent_retry" ? "queued" : "outcome_unknown",
      externalCallCount: 0 } as OpsMissingRequestMutationResult;
  }
}

class StubReminderRepository implements OpsReminderRepository {
  decisions: Parameters<OpsReminderRepository["decide"]>[1][] = [];
  result: ReminderDecisionResult = {
    outcome: "completed", decisionId: "00000000-0000-4000-a200-000000000002",
    reminderInstanceId: reminderId, status: "approved", deliveryMode: "disabled",
    externalCallCount: 0,
  };
  async decide(_organizationKey: string, request: Parameters<OpsReminderRepository["decide"]>[1]) {
    this.decisions.push(request);
    return this.result;
  }
}

class StubReleaseReadinessRepository implements OpsReleaseReadinessRepository {
  reads = 0;
  creations: Parameters<OpsReleaseReadinessRepository["createManifest"]>[1][] = [];
  evaluations: Parameters<OpsReleaseReadinessRepository["evaluateManifest"]>[1][] = [];
  submissions: Parameters<OpsReleaseReadinessRepository["submitManifest"]>[1][] = [];
  decisions: Parameters<OpsReleaseReadinessRepository["decideManifest"]>[1][] = [];
  result: OpsReleaseReadinessMutationResult = { outcome: "completed", manifestId: releaseManifestId };
  async getSnapshot(): Promise<OpsReleaseReadinessSnapshot> {
    this.reads += 1;
    return {
      generatedAt: overview.generatedAt, canManage: true, canApprove: true,
      manifests: [{
        id: releaseManifestId, manifestKey: "dev-to-uat", version: 1, status: "draft",
        sourceEnvironment: "DEV", targetEnvironment: "UAT", components: [],
        componentSnapshotHash: "a".repeat(64), readinessDeclarations: releaseReadinessDeclarations,
        declarationsHash: "b".repeat(64), manifestHash: "c".repeat(64), rollbackManifestId: null,
        createdByName: "Emma Chen", submittedByName: null, approvedByName: null,
        reason: "Freeze a synthetic-only DEV to UAT readiness manifest.", createdAt: overview.generatedAt,
        submittedAt: null, approvedAt: null, latestRun: null, decisions: [],
      }],
    };
  }
  async createManifest(_organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["createManifest"]>[1]) {
    this.creations.push(request); return this.result;
  }
  async evaluateManifest(_organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["evaluateManifest"]>[1]) {
    this.evaluations.push(request); return this.result;
  }
  async submitManifest(_organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["submitManifest"]>[1]) {
    this.submissions.push(request); return this.result;
  }
  async decideManifest(_organizationKey: string, request: Parameters<OpsReleaseReadinessRepository["decideManifest"]>[1]) {
    this.decisions.push(request); return this.result;
  }
}

class StubUatBlueprintRepository implements OpsUatBlueprintRepository {
  reads=0;
  currentAuthorization:OpsUatAuthorizationRecompilation|null=null;
  creations: Parameters<OpsUatBlueprintRepository["createBlueprint"]>[1][]=[];
  dryRuns: Parameters<OpsUatBlueprintRepository["runDryRun"]>[1][]=[];
  packageCompilations: Parameters<OpsUatBlueprintRepository["compileProvisioningPackage"]>[1][]=[];
  packageDryRuns: Parameters<OpsUatBlueprintRepository["runProvisioningPackageDryRun"]>[1][]=[];
  activationCompilations: Parameters<OpsUatBlueprintRepository["compileActivationApprovalPack"]>[1][]=[];
  activationDecisions: Parameters<OpsUatBlueprintRepository["recordActivationDecision"]>[1][]=[];
  activationEvaluations: Parameters<OpsUatBlueprintRepository["evaluateActivationApprovalPack"]>[1][]=[];
  finalAuthorizationCompilations: Parameters<OpsUatBlueprintRepository["compileFinalAuthorizationRequest"]>[1][]=[];
  finalAuthorizationEvaluations: Parameters<OpsUatBlueprintRepository["evaluateFinalAuthorizationRequest"]>[1][]=[];
  result: OpsUatBlueprintMutationResult={outcome:"completed",blueprintId:uatBlueprintId};
  async getSnapshot(): Promise<OpsUatBlueprintSnapshot> {
    this.reads+=1;
    return {generatedAt:overview.generatedAt,canManage:true,
      releaseManifests:[{id:releaseManifestId,manifestKey:"dev-to-uat",version:1,status:"approved"}],
      blueprints:[{id:uatBlueprintId,blueprintKey:"uat-isolated",version:1,status:"draft",
        releaseManifestId,releaseManifestLabel:"dev-to-uat · v1 · approved",definition:uatBlueprintDefinition,
        definitionHash:"d".repeat(64),deploymentPlan:[{sequence:1,action:"verify_governance_inputs",execution:"disabled"}],
        deploymentPlanHash:"e".repeat(64),previousBlueprintId:null,createdByName:"Emma Chen",
        reason:"Record the non-executable UAT plan.",createdAt:overview.generatedAt,latestDryRun:null}],
      provisioningPackages:[],activationApprovalPacks:[],finalAuthorizationRequests:[],currentAuthorization:this.currentAuthorization};
  }
  async createBlueprint(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["createBlueprint"]>[1]) {
    this.creations.push(request); return this.result;
  }
  async runDryRun(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["runDryRun"]>[1]) {
    this.dryRuns.push(request); return {...this.result,status:"blocked",blockerCount:4};
  }
  async compileProvisioningPackage(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["compileProvisioningPackage"]>[1]) {
    this.packageCompilations.push(request); return {...this.result,packageId:uatProvisioningPackageId,executionDecision:"no_go"};
  }
  async runProvisioningPackageDryRun(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["runProvisioningPackageDryRun"]>[1]) {
    this.packageDryRuns.push(request); return {...this.result,dryRunId:crypto.randomUUID(),status:"passed",executionDecision:"no_go",blockerCount:0};
  }
  async compileActivationApprovalPack(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["compileActivationApprovalPack"]>[1]) {
    this.activationCompilations.push(request); return {...this.result,approvalPackId:uatActivationApprovalPackId,pendingDecisionCount:4,executionDecision:"no_go"};
  }
  async recordActivationDecision(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["recordActivationDecision"]>[1]) {
    this.activationDecisions.push(request); return {...this.result,decisionId:crypto.randomUUID(),decisionKey:request.decisionKey,status:request.status,executionDecision:"no_go"};
  }
  async evaluateActivationApprovalPack(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["evaluateActivationApprovalPack"]>[1]) {
    this.activationEvaluations.push(request); return {...this.result,evaluationId:crypto.randomUUID(),status:"blocked",recommendation:"blocked",executionDecision:"no_go",blockerCount:4};
  }
  async compileFinalAuthorizationRequest(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["compileFinalAuthorizationRequest"]>[1]) {
    this.finalAuthorizationCompilations.push(request); return {...this.result,requestId:uatFinalAuthorizationRequestId,
      status:"draft",blockerCount:4,submissionAllowed:false,authorizationGranted:false,executionDecision:"no_go"};
  }
  async evaluateFinalAuthorizationRequest(_organizationKey:string,request:Parameters<OpsUatBlueprintRepository["evaluateFinalAuthorizationRequest"]>[1]) {
    this.finalAuthorizationEvaluations.push(request); return {...this.result,evaluationId:crypto.randomUUID(),
      status:"blocked",recommendation:"blocked",executionDecision:"no_go",blockerCount:4,submissionAllowed:false,authorizationGranted:false};
  }
}

class StubIssueRepository implements OpsIssueRepository {
  requests: TransitionIssueRequest[] = [];
  async transition(request: TransitionIssueRequest): Promise<TransitionIssueResult> {
    this.requests.push(request);
    if (request.issueId === issueIdTwo) return { outcome: "conflict", reason: "transition_not_allowed" };
    return { outcome: "completed", transitionId: request.transitionId, eventId: request.eventId,
      issueId: request.issueId, action: request.action, issueStatus: "assigned",
      assignedActorId: request.actorId, transitionedAt: request.now.toISOString() };
  }
}

class StubTaskRepository implements OpsTaskRepository {
  requests: TransitionTaskRequest[] = [];
  result: TransitionTaskResult | null = null;
  async getSnapshot(_organizationKey: string, suppliedActorId: string): Promise<OpsTaskSnapshot> {
    return { generatedAt: overview.generatedAt, canManage: true, operatorActorId: suppliedActorId,
      assignees: [{ id: operatorActorId, displayName: "Emma Chen", actorType: "manager" }],
      tasks: [{ id: taskId, name: "准备 Kauri Coast Cafe Limited 2026年7月会计工作", caseId, subjectName: "Kauri Coast Cafe Limited", periodStart: "2026-07-01",
        periodEnd: "2026-07-31", taskType: "document_operations.next_step", status: "open",
        assignedActorId: null, assignedActorName: null, dueAt: null,
        instructions: "核对资料并开始后续会计处理。", completionCriteria: "工作已经完成并记录处理结果。", createdAt: overview.generatedAt,
        updatedAt: overview.generatedAt, completedAt: null, externalExecution: "disabled" }],
      recentTransitions: [] };
  }
  async transition(request: TransitionTaskRequest): Promise<TransitionTaskResult> {
    this.requests.push(request);
    return this.result ?? { outcome: "completed", transitionId: request.transitionId, eventId: request.eventId,
      taskId: request.taskId, action: request.action, taskStatus: "open",
      assignedActorId: request.actorId, transitionedAt: request.now.toISOString() };
  }
}

class StubRetentionRepository implements OpsRetentionRepository {
  policyConfirmations:Parameters<OpsRetentionRepository["confirmPolicy"]>[1][]=[];
  holds:Parameters<OpsRetentionRepository["setLegalHold"]>[1][]=[];
  runs:Parameters<OpsRetentionRepository["planRun"]>[1][]=[];
  result:RetentionMutationResult={outcome:"completed"};
  dashboard:RetentionDashboard={policy:{retentionDays:30,anchor:"case_terminal_at",holdApproverRoles:["manager","admin"],
    rpoHours:24,rtoHours:4,executionEnabled:false,syntheticOnly:true,policyVersion:"uat-synthetic-30d-v1"},
    activeHolds:[],recentRuns:[],deletionProofs:[],restoreDrills:[],storageReconciliations:[]};
  async getDashboard(){return this.dashboard;}
  async confirmPolicy(_organizationKey:string,request:Parameters<OpsRetentionRepository["confirmPolicy"]>[1]){this.policyConfirmations.push(request);return this.result;}
  async setLegalHold(_organizationKey:string,request:Parameters<OpsRetentionRepository["setLegalHold"]>[1]){this.holds.push(request);return this.result;}
  async planRun(_organizationKey:string,request:Parameters<OpsRetentionRepository["planRun"]>[1]){this.runs.push(request);return this.result;}
}

class StubDemoFormRepository implements OpsDemoFormRepository{
  issues:Parameters<OpsDemoFormRepository["issueInvitation"]>[1][]=[];
  revocations:Parameters<OpsDemoFormRepository["revokeInvitation"]>[1][]=[];
  questionPublishes:Parameters<OpsDemoFormRepository["publishClientQuestion"]>[1][]=[];
  questionTransitions:Parameters<OpsDemoFormRepository["transitionClientQuestion"]>[1][]=[];
  result:OpsDemoFormMutationResult={outcome:"completed",invitationId:"00000000-0000-4000-8600-000000000451",status:"active",validUntil:"2026-08-14T02:00:00.000Z"};
  snapshot:OpsDemoFormSnapshot={generatedAt:overview.generatedAt,entries:[{id:"00000000-0000-4000-8600-000000000401",
    entryKey:"m45-1.sales-demo",version:1,connectorKey:"m45-1.synthetic-fillout-uat",providerFormId:"synthetic-form-id",
    status:"active",allowedMimeTypes:["application/pdf","image/jpeg","image/png"],maximumFilesPerSubmission:20,
    maximumDeclaredBytes:52428800,requireDeclaredBytes:false}],invitations:[],eligibleCases:[{id:caseId,
      caseKey:"dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07",
      subjectDisplayName:"Kauri Coast Cafe Limited",status:"waiting_for_documents",periodKey:"2026-07",submissionCount:0}],
    issues:[{id:"00000000-0000-4000-8600-000000000452",caseId,issueKey:"missing-bank-statement",issueType:"missing",
      status:"waiting_external",documentFilename:null,displayName:"仍缺少：银行对账单"}],clientQuestions:[]};
  async getSnapshot(){return this.snapshot;}
  async issueInvitation(_organizationKey:string,request:Parameters<OpsDemoFormRepository["issueInvitation"]>[1]){this.issues.push(request);return this.result;}
  async revokeInvitation(_organizationKey:string,request:Parameters<OpsDemoFormRepository["revokeInvitation"]>[1]){this.revocations.push(request);return this.result;}
  async publishClientQuestion(_organizationKey:string,request:Parameters<OpsDemoFormRepository["publishClientQuestion"]>[1]){
    this.questionPublishes.push(request);return {outcome:"completed",questionId:"00000000-0000-4000-8600-000000000453",status:"published"} as OpsClientPortalQuestionMutationResult;
  }
  async transitionClientQuestion(_organizationKey:string,request:Parameters<OpsDemoFormRepository["transitionClientQuestion"]>[1]){
    this.questionTransitions.push(request);return {outcome:"completed",questionId:request.questionId,status:request.action==="resolve"?"resolved":"withdrawn"} as OpsClientPortalQuestionMutationResult;
  }
}

class StubReviewRepository implements OpsReviewRepository {
  requests: ResolveDocumentReviewRequest[] = [];
  result: ResolveDocumentReviewResult = {
    outcome: "completed",
    decisionId: "decision-1",
    eventId: "event-1",
    documentId: reviewDocumentId,
    action: "confirm",
    exclusionReason: null,
    documentStatus: "human_confirmed",
    documentTypeCode: "bank_statement",
    issueStatus: "resolved",
    decidedAt: "2026-08-07T02:00:00.000Z",
  };
  async resolve(request: ResolveDocumentReviewRequest): Promise<ResolveDocumentReviewResult> {
    this.requests.push(request);
    return this.result;
  }
}

class StubTrialRepository implements OpsTrialRepository {
  uploads: Parameters<OpsTrialRepository["acceptStoredUpload"]>[1][] = [];
  completions: Parameters<OpsTrialRepository["completeCase"]>[1][] = [];
  failCompletion = false;
  async acceptStoredUpload(_organizationKey: string, request: Parameters<OpsTrialRepository["acceptStoredUpload"]>[1]) {
    this.uploads.push(request);
    return { outcome: "completed", caseId: request.caseId, documentId: request.documentId,
      submissionId: request.submissionId, documentStatus: "incoming_saved" } as const;
  }
  async completeCase(_organizationKey: string, request: Parameters<OpsTrialRepository["completeCase"]>[1]) {
    this.completions.push(request);
    if (this.failCompletion) throw Object.assign(new Error("synthetic database failure"), { code: "42501" });
    return { outcome: "completed", caseId: request.caseId,
      taskId: "00000000-0000-4000-8a00-000000000001", taskType: "document_operations.next_step",
      assignedActorId: request.actorId, dueAt: null } as const;
  }
}

class StubUploadBroker implements OpsDocumentUploadBroker {
  uploads: Parameters<OpsDocumentUploadBroker["store"]>[0][] = [];
  async store(request: Parameters<OpsDocumentUploadBroker["store"]>[0]) {
    this.uploads.push(request);
    return { storageReference: `supabase://dop-incoming-dev/${request.organizationKey}/${request.documentId}/${request.sha256}` };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(
  now = new Date("2026-08-07T02:00:00.000Z"),
  providedSessionRepository?: StubSessionRepository,
): Promise<{ server: Server; repository: StubRepository; reviewRepository: StubReviewRepository; issueRepository: StubIssueRepository; taskRepository: StubTaskRepository; reminderRepository: StubReminderRepository; retentionRepository:StubRetentionRepository; demoFormRepository:StubDemoFormRepository; identityRepository: StubIdentityRepository; sessionRepository: StubSessionRepository; accessRepository: StubAccessRepository; configurationRepository: StubConfigurationRepository; onboardingRepository: StubOnboardingRepository; casePlanRepository: StubCasePlanRepository; workPackageRepository: StubWorkPackageRepository; classificationProfileRepository: StubClassificationProfileRepository; missingRequestRepository: StubMissingRequestRepository; releaseReadinessRepository: StubReleaseReadinessRepository; uatBlueprintRepository: StubUatBlueprintRepository; trialRepository: StubTrialRepository; uploadBroker: StubUploadBroker }> {
  const repository = new StubRepository();
  const reviewRepository = new StubReviewRepository();
  const issueRepository = new StubIssueRepository();
  const taskRepository = new StubTaskRepository();
  const reminderRepository = new StubReminderRepository();
  const retentionRepository = new StubRetentionRepository();
  const demoFormRepository = new StubDemoFormRepository();
  const identityRepository = new StubIdentityRepository();
  const sessionRepository = providedSessionRepository ?? new StubSessionRepository();
  const accessRepository = new StubAccessRepository();
  const configurationRepository = new StubConfigurationRepository();
  const onboardingRepository = new StubOnboardingRepository();
  const casePlanRepository = new StubCasePlanRepository();
  const workPackageRepository = new StubWorkPackageRepository();
  const classificationProfileRepository = new StubClassificationProfileRepository();
  const missingRequestRepository = new StubMissingRequestRepository();
  const releaseReadinessRepository = new StubReleaseReadinessRepository();
  const uatBlueprintRepository = new StubUatBlueprintRepository();
  const trialRepository = new StubTrialRepository();
  const uploadBroker = new StubUploadBroker();
  const router = new OpsRouter({
    repository,
    identityAuthenticator: new StubIdentityAuthenticator(),
    identityRepository,
    sessionRepository,
    accessRepository,
    configurationRepository,
    onboardingRepository,
    casePlanRepository,
    workPackageRepository,
    classificationProfileRepository,
    missingRequestRepository,
    reminderRepository,
    retentionRepository,
    demoFormRepository,
    releaseReadinessRepository,
    uatBlueprintRepository,
    trialRepository,
    uploadBroker,
    reviewHandler: new ResolveDocumentReview(reviewRepository),
    issueHandler: new TransitionIssue(issueRepository),
    taskRepository,
    taskHandler: new TransitionTask(taskRepository),
    organizationKey: "dev-accounting-firm",
    sessionSecret,
    staticDirectory: fileURLToPath(new URL("../public/ops", import.meta.url)),
    clientPortalOrigin: "https://dop-intake-uat.example.invalid",
    secureCookie: false,
    now: () => now,
  });
  const server = createServer(async (request, response) => {
    if (!await router.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, repository, reviewRepository, issueRepository, taskRepository, reminderRepository, retentionRepository, demoFormRepository, identityRepository, sessionRepository, accessRepository, configurationRepository, onboardingRepository, casePlanRepository, workPackageRepository, classificationProfileRepository, missingRequestRepository, releaseReadinessRepository, uatBlueprintRepository, trialRepository, uploadBroker };
}

async function login(server: Server, email = operatorEmail, password = operatorPassword, rememberDevice = false) {
  return await call(server, { method: "POST", path: "/v1/ops/session", body: { email, password, rememberDevice } });
}

async function call(
  server: Server,
  options: { method?: string; path?: string; body?: unknown; rawBody?: string | Buffer; cookie?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const body = options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: options.method ?? "GET",
      path: options.path ?? "/ops",
      headers: {
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("DEV operations HTTP boundary", () => {
  it("serves the operations shell with a restrictive same-origin policy", async () => {
    const response = await call((await start()).server);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.text).toContain("资料运营台");
    expect(response.text).toContain("记住此设备 30 天");
    expect(response.text).toContain('id="boot-view"');
    expect(response.text).toContain('id="login-view" class="login-layout" aria-labelledby="login-title" hidden');
  });

  it("denies an active employee session from the advanced operations console", async () => {
    const { server, identityRepository } = await start();
    identityRepository.platformConsoleAccess = false;
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");

    const shell = await call(server, { path: "/ops", cookie: sessionCookie });
    const api = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    expect(shell.status).toBe(403);
    expect(api.status).toBe(403);
    expect(JSON.parse(api.text)).toEqual({ error: "platform_console_required" });
  });

  it("restores a remembered session before showing the login form and retries transient startup failures", async () => {
    const response = await call((await start()).server, { path: "/ops/app.js" });
    expect(response.status).toBe(200);
    expect(response.text).toContain("for (let attempt = 0; attempt < 3; attempt += 1)");
    expect(response.text).toContain("if (response?.status === 401)");
    expect(response.text).toContain("你的已保存会话没有被清除");
  });

  it("keeps the mobile navigation in one horizontally scrollable row", async () => {
    const response = await call((await start()).server, { path: "/ops/app.css" });
    expect(response.status).toBe(200);
    expect(response.text).toContain(".nav-list { display: flex; overflow-x: auto; }");
    expect(response.text).not.toContain(".nav-list { display: grid; grid-template-columns: repeat(2");
  });

  it("keeps sidebar identity actions visible while the desktop feature menu scrolls independently", async () => {
    const shell = await call((await start()).server);
    const stylesheet = await call((await start()).server, { path: "/ops/app.css" });
    expect(shell.text).toContain('<nav class="nav-list" aria-label="功能菜单">');
    expect(shell.text).toContain('<div class="sidebar-footer">');
    expect(stylesheet.text).toContain(".nav-list { flex: 1 1 auto; min-height: 0;");
    expect(stylesheet.text).toContain("overflow-y: auto; overscroll-behavior: contain;");
    expect(stylesheet.text).toContain(".sidebar-footer { flex: 0 0 auto;");
    expect(stylesheet.text).toContain(".sidebar-footer { display: none; }");
  });

  it("exposes a manager-only governed synthetic Fillout invitation surface", async () => {
    const server = (await start()).server;
    const shell = await call(server);
    const script = await call(server, { path: "/ops/app.js" });
    const stylesheet = await call(server, { path: "/ops/app.css" });
    expect(shell.text).toContain('data-view="demo-form"');
    expect(shell.text).toContain('id="demo-form-invitation-form"');
    expect(shell.text).toContain("不接收真实资料 · 不外发邮件 · 不进入 PROD");
    expect(script.text).toContain('fetch("/v1/ops/demo-form")');
    expect(script.text).toContain('"x-dop-csrf": state.overview.csrfToken');
    expect(script.text).toContain('referrerpolicy: "no-referrer"');
    expect(script.text).toContain('if (view === "demo-form" && !["manager", "admin"].includes');
    expect(script.text).toContain("function applyRuntimeEnvironment()");
    expect(stylesheet.text).toContain(".demo-form-issued-link");
  });

  it("exposes the minimal Task queue and all governed lifecycle actions", async () => {
    const server = (await start()).server;
    const shell = await call(server);
    const script = await call(server, { path: "/ops/app.js" });
    const stylesheet = await call(server, { path: "/ops/app.css" });
    expect(shell.text).toContain('data-view="tasks"');
    expect(shell.text).toContain('id="task-scope-filter"');
    expect(shell.text).toContain("每次变化都会追加不可变审计记录");
    for (const action of ["claim", "start", "wait", "resume", "complete", "reassign", "reopen"]) {
      expect(script.text).toContain(`"${action}"`);
    }
    expect(script.text).toContain("打开来源 Case");
    expect(script.text).toContain("reason: String(reasonControl?.value ?? \"\")");
    expect(script.text).toContain("assignedActorId: String(assigneeControl?.value ?? \"\") || null");
    expect(stylesheet.text).toContain(".task-transition-form");
  });

  it("exposes the manager-only wrong-subject exclusion with clear preservation copy", async () => {
    const script = await call((await start()).server, { path: "/ops/app.js" });
    const stylesheet = await call((await start()).server, { path: "/ops/app.css" });
    expect(script.status).toBe(200);
    expect(script.text).toContain('actionButton("不属于当前客户 / 排除", "exclude", "button-danger")');
    expect(script.text).toContain('name: "exclusionReason"');
    expect(script.text).toContain('value: "wrong_period"');
    expect(script.text).toContain('value: "irrelevant_or_unknown"');
    expect(script.text).toContain('result.reason ?? result.error');
    expect(script.text).toContain('action === "exclude" ? "文件已从当前 Case 安全排除；原件、AI 结果和审计记录均已保留。"');
    expect(script.text).toContain('["manager", "admin"].includes(state.overview.operator.actorType)');
    expect(stylesheet.text).toContain(".button-danger");
  });

  it("submits the visible Case completion reason from the textarea value", async () => {
    const response = await call((await start()).server, { path: "/ops/app.js" });
    expect(response.status).toBe(200);
    expect(response.text).toContain('form.elements.reason?.value');
    expect(response.text).not.toContain('new FormData(form).get("reason") ?? ""), assignedActorId');
  });

  it("does not expose operations data without a session", async () => {
    const { server, repository } = await start();
    const response = await call(server, { path: "/v1/ops/overview" });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: "session_required" });
    expect(repository.calls).toBe(0);
  });

  it("rejects invalid credentials without echoing them", async () => {
    const response = await login((await start()).server, operatorEmail, "wrong-password");
    expect(response.status).toBe(401);
    expect(response.text).not.toContain("wrong-password");
  });

  it("reports malformed and oversized login requests without a generic server error", async () => {
    const { server } = await start();
    const malformed = await call(server, {
      method: "POST", path: "/v1/ops/session", rawBody: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.text)).toEqual({ error: "invalid_json" });

    const oversized = await call(server, {
      method: "POST", path: "/v1/ops/session", rawBody: JSON.stringify({ email: operatorEmail, password: "x".repeat(8_193) }),
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.text)).toEqual({ error: "request_body_too_large" });
  });

  it("creates an HttpOnly session and returns tenant-scoped data", async () => {
    const { server, repository } = await start();
    const loginResponse = await login(server);
    expect(loginResponse.status).toBe(200);
    const setCookie = loginResponse.headers["set-cookie"]?.[0];
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(operatorPassword);
    expect(setCookie).not.toContain(operatorActorId);
    const sessionCookie = setCookie?.split(";", 1)[0];
    expect(sessionCookie).toBeTruthy();
    if (!sessionCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      organizationKey: "dev-accounting-firm",
      summary: { activeCaseCount: 1, scheduledRetryCount: 1, overdueRetryCount: 1 },
      retryQueue: [{ errorCode: "provider_timeout", status: "retry_scheduled" }],
    });
    expect(repository.calls).toBe(1);
  });

  it("keeps the default session short and remembers an explicitly opted-in device for 30 days", async () => {
    const { server } = await start();
    const standard = await login(server);
    expect(standard.headers["set-cookie"]?.[0]).toContain("Max-Age=28800");
    expect(JSON.parse(standard.text)).toMatchObject({
      remembered_device: false,
      expires_at: "2026-08-07T10:00:00.000Z",
    });

    const remembered = await login(server, operatorEmail, operatorPassword, true);
    const rememberedCookie = remembered.headers["set-cookie"]?.[0];
    expect(rememberedCookie).toContain("Max-Age=2592000");
    expect(rememberedCookie).toContain("HttpOnly");
    expect(rememberedCookie).toContain("SameSite=Strict");
    expect(JSON.parse(remembered.text)).toMatchObject({
      remembered_device: true,
      expires_at: "2026-09-06T02:00:00.000Z",
    });

    const stringClaim = await call(server, {
      method: "POST",
      path: "/v1/ops/session",
      body: { email: operatorEmail, password: operatorPassword, rememberDevice: "true" },
    });
    expect(stringClaim.headers["set-cookie"]?.[0]).toContain("Max-Age=28800");
    expect(JSON.parse(stringClaim.text)).toMatchObject({ remembered_device: false });
  });

  it("keeps an opaque persisted session valid across router restarts and revokes it on logout", async () => {
    const persistedSessions = new StubSessionRepository();
    const first = await start(new Date("2026-08-07T02:00:00.000Z"), persistedSessions);
    const loginResponse = await login(first.server, operatorEmail, operatorPassword, true);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    expect(sessionCookie).toContain("dop_ops_session=v2.");
    expect([...persistedSessions.sessions.keys()]).toHaveLength(1);
    expect([...persistedSessions.sessions.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    expect([...persistedSessions.sessions.keys()][0]).not.toContain(sessionCookie.split(".")[1] ?? "missing");

    const restarted = await start(new Date("2026-08-07T02:01:00.000Z"), persistedSessions);
    expect((await call(restarted.server, { path: "/v1/ops/overview", cookie: sessionCookie })).status).toBe(200);
    const logout = await call(restarted.server, { method: "DELETE", path: "/v1/ops/session", cookie: sessionCookie });
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

    const afterLogoutRestart = await start(new Date("2026-08-07T02:02:00.000Z"), persistedSessions);
    expect((await call(afterLogoutRestart.server, { path: "/v1/ops/overview", cookie: sessionCookie })).status).toBe(401);
  });

  it("lists safe session metadata and revokes every other device without invalidating the current device", async () => {
    const { server } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const firstLogin = await login(server, operatorEmail, operatorPassword, true);
    const firstCookie = firstLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    const currentLogin = await login(server, operatorEmail, operatorPassword, true);
    const currentCookie = currentLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!firstCookie || !currentCookie) throw new Error("session cookie missing");

    const sessions = await call(server, { path: "/v1/ops/sessions", cookie: currentCookie });
    expect(sessions.status).toBe(200);
    const snapshot = JSON.parse(sessions.text);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions.filter((item: { isCurrent: boolean }) => item.isCurrent)).toHaveLength(1);
    expect(sessions.text).not.toContain("tokenHash");
    expect(sessions.text).not.toContain(currentCookie.split(".")[1] ?? "raw-token");

    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: currentCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const revoked = await call(server, {
      method: "POST", path: "/v1/ops/sessions/revoke-others", cookie: currentCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { reason: "撤销当前个人设备之外的全部测试会话。", idempotencyKey: crypto.randomUUID() },
    });
    expect(revoked.status).toBe(200);
    expect(JSON.parse(revoked.text)).toMatchObject({ outcome: "completed", revokedCount: 1 });
    expect((await call(server, { path: "/v1/ops/overview", cookie: firstCookie })).status).toBe(401);
    expect((await call(server, { path: "/v1/ops/overview", cookie: currentCookie })).status).toBe(200);
  });

  it("limits retention cleanup to admins and separates dry-run from audited deletion", async () => {
    const { server, identityRepository, sessionRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    const staffOverview = await call(server, { path: "/v1/ops/overview", cookie: staffCookie });
    const staffCsrf = JSON.parse(staffOverview.text).csrfToken as string;
    const denied = await call(server, {
      method: "POST", path: "/v1/ops/sessions/cleanup", cookie: staffCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": staffCsrf },
      body: { retentionDays: 90, apply: false },
    });
    expect(denied.status).toBe(403);
    expect(sessionRepository.cleanupRequests).toHaveLength(0);

    identityRepository.actorType = "admin";
    const adminLogin = await login(server);
    const adminCookie = adminLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!adminCookie) throw new Error("session cookie missing");
    const adminOverview = await call(server, { path: "/v1/ops/overview", cookie: adminCookie });
    const adminCsrf = JSON.parse(adminOverview.text).csrfToken as string;
    const dryRun = await call(server, {
      method: "POST", path: "/v1/ops/sessions/cleanup", cookie: adminCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": adminCsrf },
      body: { retentionDays: 90, apply: false },
    });
    expect(dryRun.status).toBe(200);
    expect(JSON.parse(dryRun.text)).toMatchObject({ outcome: "dry_run", candidateCount: 2, deletedCount: 0 });
    const applied = await call(server, {
      method: "POST", path: "/v1/ops/sessions/cleanup", cookie: adminCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": adminCsrf },
      body: { retentionDays: 90, apply: true, reason: "按会话保留策略清理超过九十天的已结束记录。", idempotencyKey: crypto.randomUUID() },
    });
    expect(applied.status).toBe(200);
    expect(JSON.parse(applied.text)).toMatchObject({ outcome: "completed", candidateCount: 2, deletedCount: 2 });
    expect(sessionRepository.cleanupRequests).toHaveLength(2);
  });

  it("governs M43 policy confirmation, dry-run, apply and legal hold by role",async()=>{
    const {server,identityRepository,retentionRepository}=await start();
    const address=server.address();if(!address||typeof address==="string")throw new Error("server did not bind");
    identityRepository.actorType="manager";
    const managerLogin=await login(server);const managerCookie=managerLogin.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if(!managerCookie)throw new Error("session cookie missing");
    const managerOverview=await call(server,{path:"/v1/ops/overview",cookie:managerCookie});
    const managerCsrf=JSON.parse(managerOverview.text).csrfToken;
    expect((await call(server,{path:"/v1/ops/retention",cookie:managerCookie})).status).toBe(200);
    const hold=await call(server,{method:"POST",path:`/v1/ops/cases/${caseId}/legal-holds`,cookie:managerCookie,
      headers:{origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":managerCsrf},body:{action:"place",
        reviewDueAt:"2026-08-14T02:00:00.000Z",reason:"保留此纯虚构Case以验证Legal Hold阻断边界。",idempotencyKey:crypto.randomUUID()}});
    expect(hold.status).toBe(200);expect(retentionRepository.holds).toHaveLength(1);
    const managerApply=await call(server,{method:"POST",path:"/v1/ops/retention/runs",cookie:managerCookie,
      headers:{origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":managerCsrf},
      body:{mode:"apply",reason:"执行已批准纯虚构资料清理。",idempotencyKey:crypto.randomUUID()}});
    expect(managerApply.status).toBe(403);expect(retentionRepository.runs).toHaveLength(0);

    identityRepository.actorType="admin";
    const adminLogin=await login(server);const adminCookie=adminLogin.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if(!adminCookie)throw new Error("session cookie missing");
    const adminOverview=await call(server,{path:"/v1/ops/overview",cookie:adminCookie});
    const adminCsrf=JSON.parse(adminOverview.text).csrfToken;
    const confirm=await call(server,{method:"POST",path:"/v1/ops/retention/policy-confirmations",cookie:adminCookie,
      headers:{origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":adminCsrf},body:{retentionDays:30,
        anchor:"case_terminal_at",holdApproverRoles:["manager","admin"],rpoHours:24,rtoHours:4,
        reason:"确认纯虚构UAT三十天保留与恢复目标。",idempotencyKey:crypto.randomUUID()}});
    expect(confirm.status).toBe(200);expect(retentionRepository.policyConfirmations).toHaveLength(1);
    const dryRun=await call(server,{method:"POST",path:"/v1/ops/retention/runs",cookie:adminCookie,
      headers:{origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":adminCsrf},
      body:{mode:"dry_run",reason:"预览三十天保留策略候选且不得删除。",idempotencyKey:crypto.randomUUID()}});
    expect(dryRun.status).toBe(200);expect(retentionRepository.runs[0]?.mode).toBe("dry_run");
  });

  it("returns an authenticated, tenant-scoped Case detail and validates identifiers", async () => {
    const { server, repository } = await start();
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const detail = await call(server, { path: `/v1/ops/cases/${caseId}`, cookie: sessionCookie });
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.text)).toMatchObject({ case: { id: caseId, subjectName: "Kauri Coast Cafe Limited" } });
    expect(repository.detailCalls).toBe(1);
    const invalid = await call(server, { path: "/v1/ops/cases/not-a-uuid", cookie: sessionCookie });
    expect(invalid.status).toBe(400);
    expect(repository.detailCalls).toBe(1);
  });

  it("stores a signature-verified synthetic document before recording it on the Case", async () => {
    const { server, trialRepository, uploadBroker } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const content = Buffer.from("%PDF-1.7\nsynthetic-only\n%%EOF");
    const response = await call(server, {
      method: "POST", path: `/v1/ops/cases/${caseId}/documents`, cookie: sessionCookie, rawBody: content,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken,
        "content-type": "application/pdf", "x-dop-filename": encodeURIComponent("synthetic statement.pdf") },
    });
    expect(response.status).toBe(201);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "completed", caseId, documentStatus: "incoming_saved" });
    expect(uploadBroker.uploads).toHaveLength(1);
    expect(uploadBroker.uploads[0]).toMatchObject({ organizationKey: "dev-accounting-firm", filename: "synthetic statement.pdf", mimeType: "application/pdf" });
    expect(trialRepository.uploads).toHaveLength(1);
    expect(trialRepository.uploads[0]).toMatchObject({ caseId, actorId: operatorActorId,
      storageReference: expect.stringMatching(/^supabase:\/\//), sizeBytes: content.length });
  });

  it("rejects a forged document signature before private storage", async () => {
    const { server, uploadBroker, trialRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: `/v1/ops/cases/${caseId}/documents`, cookie: sessionCookie,
      rawBody: Buffer.from("not a pdf"), headers: { origin: `http://127.0.0.1:${address.port}`,
        "x-dop-csrf": csrfToken, "content-type": "application/pdf", "x-dop-filename": "forged.pdf" },
    });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toEqual({ error: "file_signature_mismatch" });
    expect(uploadBroker.uploads).toHaveLength(0);
    expect(trialRepository.uploads).toHaveLength(0);
  });

  it("lets a manager atomically complete a ready Case and request one handoff task", async () => {
    const { server, identityRepository, trialRepository } = await start();
    identityRepository.actorType = "manager";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const idempotencyKey = crypto.randomUUID();
    const response = await call(server, {
      method: "POST", path: `/v1/ops/cases/${caseId}/complete`, cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { reason: "纯虚构资料已经逐项核对，可以结束本轮个人试运行。", assignedActorId: null, idempotencyKey },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "completed", caseId, taskType: "document_operations.next_step" });
    expect(trialRepository.completions).toEqual([expect.objectContaining({
      caseId, actorId: operatorActorId, assignedActorId: null, idempotencyKey,
    })]);
  });

  it("rejects an invalid Case completion operation key before the repository", async () => {
    const { server, identityRepository, trialRepository } = await start();
    identityRepository.actorType = "manager";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: `/v1/ops/cases/${caseId}/complete`, cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { reason: "纯虚构资料已经逐项核对，可以安全完成。", assignedActorId: null, idempotencyKey: "invalid" },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({ error: "invalid_completion_idempotency_key" });
    expect(trialRepository.completions).toHaveLength(0);
  });

  it("fails a Case completion atomically and emits only a safe database error code", async () => {
    const { server, identityRepository, trialRepository } = await start();
    identityRepository.actorType = "manager";
    trialRepository.failCompletion = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: `/v1/ops/cases/${caseId}/complete`, cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { reason: "纯虚构资料已经逐项核对，可以安全失败。", assignedActorId: null, idempotencyKey: crypto.randomUUID() },
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toEqual({ error: "case_completion_failed" });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"errorCode":"42501"'));
    errorLog.mockRestore();
  });

  it("governs missing-request revisions behind manager, same-origin and CSRF boundaries", async () => {
    const { server, identityRepository, missingRequestRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    const denied = await call(server, {
      method: "POST", path: `/v1/ops/missing-request-drafts/${missingRequestDraftId}/revisions`,
      cookie: staffCookie, body: {},
    });
    expect(denied.status).toBe(403);
    expect(missingRequestRepository.revisions).toHaveLength(0);

    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: managerCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const created = await call(server, {
      method: "POST", path: `/v1/ops/missing-request-drafts/${missingRequestDraftId}/revisions`,
      cookie: managerCookie, headers,
      body: {
        recipientActorId,
        subjectLine: "Synthetic Client｜资料补充清单｜2026-08",
        bodyText: "您好：\n\n请补充本期完整的银行流水资料，以便继续内部核对。",
        reason: "修订主题和正文并固定受治理的主联系人快照。",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(created.status).toBe(200);
    expect(JSON.parse(created.text)).toMatchObject({
      outcome: "completed", deliveryMode: "disabled", externalCallCount: 0,
    });
    expect(missingRequestRepository.revisions[0]).toMatchObject({
      actorId: operatorActorId, requestDraftId: missingRequestDraftId, recipientActorId,
    });

    const submitted = await call(server, {
      method: "POST", path: `/v1/ops/missing-request-revisions/${missingRequestRevisionId}/transitions`,
      cookie: managerCookie, headers,
      body: {
        action: "submit_review", reason: "收件人与内容已核对，送交另一位主管进行内部批准。",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(submitted.status).toBe(200);
    expect(missingRequestRepository.transitions[0]).toMatchObject({
      actorId: operatorActorId, revisionId: missingRequestRevisionId, action: "submit_review",
    });

    const planned = await call(server, {
      method: "POST", path: `/v1/ops/missing-request-revisions/${missingRequestRevisionId}/delivery-plans`,
      cookie: managerCookie, headers,
      body: { reason: "为已批准精确修订建立不可发送的 DEV 投递计划。", idempotencyKey: crypto.randomUUID() },
    });
    expect(planned.status).toBe(200);
    expect(JSON.parse(planned.text)).toMatchObject({
      outcome: "completed", deliveryJobId, runtimeExecution: "disabled",
      providerConfigured: false, attemptCount: 0, externalCallCount: 0,
    });
    expect(missingRequestRepository.deliveryPlans[0]).toMatchObject({
      actorId: operatorActorId, revisionId: missingRequestRevisionId,
    });

    const evaluated = await call(server, {
      method: "POST", path: `/v1/ops/delivery-jobs/${deliveryJobId}/evaluations`,
      cookie: managerCookie, headers,
      body: { reason: "验证发送锁、失败恢复与回执幂等合同，保持运行关闭。", idempotencyKey: crypto.randomUUID() },
    });
    expect(evaluated.status).toBe(200);
    expect(JSON.parse(evaluated.text)).toMatchObject({
      outcome: "completed", evaluationId: deliveryEvaluationId,
      runtimeExecution: "disabled", externalCallCount: 0,
    });
    expect(missingRequestRepository.deliveryEvaluations[0]).toMatchObject({
      actorId: operatorActorId, deliveryJobId,
    });

    const authorized = await call(server, {
      method: "POST", path: `/v1/ops/delivery-jobs/${deliveryJobId}/synthetic-authorizations`,
      cookie: managerCookie, headers,
      body: { scenario: "timeout_unknown", reason: "验证超时后进入结果未知且禁止自动重发。",
        idempotencyKey: crypto.randomUUID() },
    });
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.text)).toMatchObject({
      outcome: "completed", deliveryJobId, runtimeExecution: "synthetic",
      providerConfigured: true, scenario: "timeout_unknown", externalCallCount: 0,
    });
    expect(missingRequestRepository.deliveryAuthorizations[0]).toMatchObject({
      actorId: operatorActorId, deliveryJobId, scenario: "timeout_unknown",
    });

    const reconciled = await call(server, {
      method: "POST", path: `/v1/ops/delivery-jobs/${deliveryJobId}/unknown-reconciliations`,
      cookie: managerCookie, headers,
      body: { action: "remain_unknown", reason: "当前证据不足，保持人工任务并继续禁止自动重发。",
        idempotencyKey: crypto.randomUUID() },
    });
    expect(reconciled.status).toBe(200);
    expect(missingRequestRepository.deliveryReconciliations[0]).toMatchObject({
      actorId: operatorActorId, deliveryJobId, action: "remain_unknown",
    });
  });

  it("clears the session cookie on logout", async () => {
    const { server } = await start();
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const response = await call(server, { method: "DELETE", path: "/v1/ops/session", cookie: sessionCookie });
    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("refuses an authenticated identity without an active Canonical Actor", async () => {
    const { server, identityRepository } = await start();
    identityRepository.authorized = false;
    const response = await login(server);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toEqual({ error: "identity_not_authorized" });
  });

  it("revokes an existing session as soon as the Canonical Actor becomes inactive", async () => {
    const { server, identityRepository, repository } = await start();
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    identityRepository.active = false;
    const response = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    expect(response.status).toBe(401);
    expect(repository.calls).toBe(0);
  });

  it("keeps people and access unavailable to authenticated staff", async () => {
    const { server, accessRepository } = await start();
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/access", cookie: sessionCookie });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toEqual({ error: "admin_required" });
    expect(accessRepository.reads).toBe(0);
  });

  it("lets a current admin read access and create a non-delivered invitation draft", async () => {
    const { server, identityRepository, accessRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const access = await call(server, { path: "/v1/ops/access", cookie: sessionCookie });
    expect(access.status).toBe(200);
    expect(accessRepository.reads).toBe(1);
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: "/v1/ops/access/invitations", cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { email: "new.staff@example.invalid", displayName: "New Staff", actorType: "staff",
        reason: "Synthetic M13 invitation draft for access testing.", idempotencyKey: crypto.randomUUID() },
    });
    expect(response.status).toBe(200);
    expect(accessRepository.creations).toHaveLength(1);
    expect(accessRepository.creations[0]).toMatchObject({ actorId: operatorActorId, email: "new.staff@example.invalid", actorType: "staff" });
  });

  it("lets a manager issue a one-time governed synthetic Fillout invitation",async()=>{
    const {server,identityRepository,demoFormRepository}=await start();identityRepository.actorType="manager";
    const address=server.address();if(!address||typeof address==="string")throw new Error("server did not bind");
    const loginResponse=await login(server);const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if(!cookie)throw new Error("session cookie missing");
    const snapshot=await call(server,{path:"/v1/ops/demo-form",cookie});
    expect(snapshot.status).toBe(200);
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const issued=await call(server,{method:"POST",path:"/v1/ops/demo-form/invitations",cookie,headers,body:{
      entryVersionId:demoFormRepository.snapshot.entries[0]!.id,caseId,periodKey:"2026-07",
      maximumSubmissions:4,validDays:7,reason:"Create a bounded synthetic sales demonstration invitation.",
      idempotencyKey:crypto.randomUUID(),
    }});
    expect(issued.status).toBe(201);
    const body=JSON.parse(issued.text);
    expect(body.invitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.submissionUrl).toMatch(/^https:\/\/dop-intake-uat\.example\.invalid\/submit#access=/);
    expect(body.submissionUrl).not.toContain("forms.fillout.com");
    expect(demoFormRepository.issues).toHaveLength(1);
    expect(demoFormRepository.issues[0]).toMatchObject({actorId:operatorActorId,caseId,periodKey:"2026-07",
      allowInitial:true,allowSupplement:true,maximumSubmissions:4});
    expect(demoFormRepository.issues[0]!.invitationTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(demoFormRepository.issues[0])).not.toContain(body.invitationToken);
    const revoked=await call(server,{method:"POST",path:`/v1/ops/demo-form/invitations/${body.invitationId}/revoke`,
      cookie,headers,body:{reason:"Revoke the synthetic demonstration invitation after use.",idempotencyKey:crypto.randomUUID()}});
    expect(revoked.status).toBe(200);expect(demoFormRepository.revocations).toHaveLength(1);
  });

  it("publishes and concludes only explicit client-visible questions for a synthetic Case",async()=>{
    const {server,identityRepository,demoFormRepository}=await start();identityRepository.actorType="manager";
    const address=server.address();if(!address||typeof address==="string")throw new Error("server did not bind");
    const loginResponse=await login(server);const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if(!cookie)throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const published=await call(server,{method:"POST",path:"/v1/ops/client-portal/questions",cookie,headers,body:{
      caseId,issueId:demoFormRepository.snapshot.issues[0]!.id,publicTitle:"请补交银行月结单",
      publicBody:"请补交本期完整的纯虚构银行月结单PDF文件。",reason:"Publish only the minimum client-visible synthetic request.",
      idempotencyKey:crypto.randomUUID(),
    }});
    expect(published.status).toBe(200);expect(demoFormRepository.questionPublishes).toHaveLength(1);
    expect(demoFormRepository.questionPublishes[0]).toMatchObject({actorId:operatorActorId,caseId,
      publicTitle:"请补交银行月结单"});
    const questionId=JSON.parse(published.text).questionId;
    const concluded=await call(server,{method:"POST",path:`/v1/ops/client-portal/questions/${questionId}/transitions`,
      cookie,headers,body:{action:"resolve",reason:"Synthetic supplement reviewed and accepted by the operator.",
        idempotencyKey:crypto.randomUUID()}});
    expect(concluded.status).toBe(200);expect(demoFormRepository.questionTransitions).toHaveLength(1);
    expect(demoFormRepository.questionTransitions[0]).toMatchObject({actorId:operatorActorId,questionId,action:"resolve"});
  });

  it("lets managers inspect configuration releases but keeps staff outside the configuration boundary", async () => {
    const { server, identityRepository, configurationRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server, { path: "/v1/ops/configurations", cookie: staffCookie })).status).toBe(403);
    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/configurations", cookie: managerCookie });
    expect(response.status).toBe(200);
    expect(configurationRepository.reads).toBe(1);
  });

  it("allows only an admin with same-origin CSRF evidence to create a configuration draft", async () => {
    const { server, identityRepository, configurationRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: `/v1/ops/configurations/${releaseId}/clone`, cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { reason: "Create a controlled synthetic configuration change draft.", idempotencyKey: crypto.randomUUID() },
    });
    expect(response.status).toBe(200);
    expect(configurationRepository.clones).toHaveLength(1);
    expect(configurationRepository.clones[0]).toMatchObject({ actorId: operatorActorId, releaseId });
  });

  it("keeps reusable onboarding packages admin-only and creates a draft without external delivery", async () => {
    const { server, identityRepository, onboardingRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const catalog = await call(server, { path: "/v1/ops/onboarding", cookie: sessionCookie });
    expect(catalog.status).toBe(200);
    expect(JSON.parse(catalog.text)).toMatchObject({ packages: [{ id: packageVersionId, version: 1 }] });
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: "/v1/ops/onboarding/subjects", cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        packageVersionId, subjectKey: "m15-synthetic-client", displayName: "M15 Synthetic Client Limited",
        subjectType: "accounting_client", primaryContactActorId: null, attributes: { synthetic: true },
        reason: "Create the controlled M15 synthetic onboarding draft only.", idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(200);
    expect(onboardingRepository.reads).toBe(1);
    expect(onboardingRepository.onboardings).toHaveLength(1);
    expect(onboardingRepository.onboardings[0]).toMatchObject({
      actorId: operatorActorId, packageVersionId, subjectKey: "m15-synthetic-client",
      attributes: { synthetic: true },
    });
  });

  it("allows managers to create a future Case from a published configuration and refuses staff", async () => {
    const { server, identityRepository, onboardingRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    const denied = await call(server, {
      method: "POST", path: `/v1/ops/configurations/${releaseId}/cases`, cookie: staffCookie,
      body: {},
    });
    expect(denied.status).toBe(403);
    identityRepository.actorType = "manager";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: managerCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: `/v1/ops/configurations/${releaseId}/cases`, cookie: managerCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        periodKey: "2026-09", periodStart: "2026-09-01", periodEnd: "2026-09-30",
        dueAt: "2026-10-07T04:00:00.000Z", timezone: "Pacific/Auckland",
        externalReference: "M15-SYNTHETIC-SEP", reason: "Create a pinned future synthetic Case for M15 verification.",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(200);
    expect(onboardingRepository.cases).toHaveLength(1);
    expect(onboardingRepository.cases[0]).toMatchObject({
      actorId: operatorActorId, releaseId, periodKey: "2026-09", timezone: "Pacific/Auckland",
    });
  });

  it("lets managers inspect Case Plans while keeping staff outside the planning boundary", async () => {
    const { server, identityRepository, casePlanRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server, { path: "/v1/ops/case-plans", cookie: staffCookie })).status).toBe(403);
    expect(casePlanRepository.reads).toBe(0);

    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/case-plans", cookie: managerCookie });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ canPreview: true, eligibleSubjects: [{ id: subjectId, configurationReleaseNumber: 2 }] });
    expect(casePlanRepository.reads).toBe(1);
  });

  it("allows only an admin with same-origin CSRF evidence to create a versioned Case Plan draft", async () => {
    const { server, identityRepository, casePlanRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: "/v1/ops/case-plans", cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        subjectId, planKey: "m16-monthly-plan", displayName: "M16 monthly operations",
        definition: casePlanDefinition, reason: "Create a controlled synthetic M16 Case Plan draft.",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(200);
    expect(casePlanRepository.creations).toHaveLength(1);
    expect(casePlanRepository.creations[0]).toMatchObject({
      actorId: operatorActorId, subjectId, planKey: "m16-monthly-plan",
      definition: { externalDelivery: "disabled", sourceBinding: { bindingKey: "m16-manual-upload" } },
    });
  });

  it("lets a manager preview and atomically approve a pinned Case batch while refusing staff", async () => {
    const { server, identityRepository, casePlanRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    const denied = await call(server, {
      method: "POST", path: `/v1/ops/case-plans/${casePlanVersionId}/previews`, cookie: staffCookie,
      body: { candidateCount: 2, startOn: null, reason: "Synthetic staff request must remain outside approval.", idempotencyKey: crypto.randomUUID() },
    });
    expect(denied.status).toBe(403);
    expect(casePlanRepository.previews).toHaveLength(0);

    identityRepository.actorType = "manager";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: managerCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const preview = await call(server, {
      method: "POST", path: `/v1/ops/case-plans/${casePlanVersionId}/previews`, cookie: managerCookie, headers,
      body: { candidateCount: 2, startOn: "2026-11-01", reason: "Preview two pinned future periods before manual approval.", idempotencyKey: crypto.randomUUID() },
    });
    expect(preview.status).toBe(200);
    expect(casePlanRepository.previews[0]).toMatchObject({ actorId: operatorActorId, versionId: casePlanVersionId, candidateCount: 2, startOn: "2026-11-01" });

    const approval = await call(server, {
      method: "POST", path: `/v1/ops/case-plan-previews/${casePlanPreviewId}/approve`, cookie: managerCookie, headers,
      body: { reason: "Approve the exact two-period synthetic preview as one atomic batch.", idempotencyKey: crypto.randomUUID() },
    });
    expect(approval.status).toBe(200);
    expect(JSON.parse(approval.text)).toMatchObject({ outcome: "completed", generatedCaseIds: expect.any(Array) });
    expect(casePlanRepository.approvals[0]).toMatchObject({ actorId: operatorActorId, previewId: casePlanPreviewId });
  });

  it("lets managers inspect Work Package history while keeping staff outside the authoring boundary", async () => {
    const { server, identityRepository, workPackageRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server, { path: "/v1/ops/work-packages", cookie: staffCookie })).status).toBe(403);
    expect(workPackageRepository.reads).toBe(0);
    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/work-packages", cookie: managerCookie });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ canManage: true, documentTypes: [{ code: "bank_statement" }] });
    expect(workPackageRepository.reads).toBe(1);
  });

  it("allows only an admin with same-origin CSRF evidence to create a safe structured Work Package draft", async () => {
    const { server, identityRepository, workPackageRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: "/v1/ops/work-packages", cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        packageKey: "m17.synthetic.documents", displayName: "M17 Synthetic Documents",
        description: "Reusable synthetic document classification package for M17 verification.",
        industryPackage: "generic", workflowTemplateId, blueprint: workPackageBlueprint,
        reason: "Create a controlled M17 structured Work Package draft.", idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(response.status).toBe(200);
    expect(workPackageRepository.creations).toHaveLength(1);
    expect(workPackageRepository.creations[0]).toMatchObject({
      actorId: operatorActorId, packageKey: "m17.synthetic.documents",
      blueprint: { workflow: { environment: "DEV", external_messages_require_approval: true } },
    });
  });

  it("accepts only explicitly synthetic Work Package dry-runs and preserves the no-persistence boundary", async () => {
    const { server, identityRepository, workPackageRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const denied = await call(server, {
      method: "POST", path: `/v1/ops/work-packages/${workPackageVersionId}/dry-runs`, cookie: sessionCookie, headers,
      body: { syntheticSample: { subjectKey: "m17-real", displayName: "Not Synthetic", subjectType: "client", attributes: { synthetic: false } }, reason: "Reject a sample without the synthetic boundary marker.", idempotencyKey: crypto.randomUUID() },
    });
    expect(denied.status).toBe(400);
    const response = await call(server, {
      method: "POST", path: `/v1/ops/work-packages/${workPackageVersionId}/dry-runs`, cookie: sessionCookie, headers,
      body: { syntheticSample: { subjectKey: "m17-synthetic", displayName: "M17 Synthetic Limited", subjectType: "synthetic_subject", attributes: { synthetic: true } }, reason: "Validate the exact synthetic M17 definition without persistence.", idempotencyKey: crypto.randomUUID() },
    });
    expect(response.status).toBe(200);
    expect(workPackageRepository.dryRuns).toHaveLength(1);
    expect(workPackageRepository.dryRuns[0]).toMatchObject({ actorId: operatorActorId, syntheticSample: { attributes: { synthetic: true } } });
  });

  it("lets managers inspect classification governance while keeping staff outside the boundary", async () => {
    const { server, identityRepository, classificationProfileRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server, { path: "/v1/ops/classification-profile", cookie: staffCookie })).status).toBe(403);
    expect(classificationProfileRepository.reads).toBe(0);
    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/classification-profile", cookie: managerCookie });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ qualityFlags: ["partial"], conflictFlags: ["period_conflict"] });
    expect(classificationProfileRepository.reads).toBe(1);
  });

  it("allows only an admin to save a DEV-safe profile and run its provider-free evaluation", async () => {
    const { server, identityRepository, classificationProfileRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const unsafe = structuredClone(classificationProfileDefinition) as ClassificationProfileDefinition;
    unsafe.unknownDocumentRoute = "accepted" as "review_required";
    expect((await call(server, { method: "POST", path: `/v1/ops/classification-profile/${classificationProfileVersionId}/revisions`, cookie: sessionCookie, headers,
      body: { definition: unsafe, reason: "Unsafe unknown route must be rejected at the HTTP boundary.", idempotencyKey: crypto.randomUUID() } })).status).toBe(400);
    const saved = await call(server, { method: "POST", path: `/v1/ops/classification-profile/${classificationProfileVersionId}/revisions`, cookie: sessionCookie, headers,
      body: { definition: classificationProfileDefinition, reason: "Save the exact safe synthetic classification profile revision.", idempotencyKey: crypto.randomUUID() } });
    expect(saved.status).toBe(200);
    expect(classificationProfileRepository.revisions[0]).toMatchObject({ actorId: operatorActorId,
      definition: { environment: "DEV", unknownDocumentRoute: "review_required", ambiguityRoute: "review_required" } });
    const evaluated = await call(server, { method: "POST", path: `/v1/ops/classification-profile/${classificationProfileVersionId}/evaluations`, cookie: sessionCookie, headers,
      body: { reason: "Evaluate deterministic synthetic routes without a provider call.", idempotencyKey: crypto.randomUUID() } });
    expect(evaluated.status).toBe(200);
    expect(classificationProfileRepository.evaluations[0]).toMatchObject({ actorId: operatorActorId, versionId: classificationProfileVersionId });
  });

  it("keeps release readiness outside staff access while managers can inspect reference-only evidence", async () => {
    const { server, identityRepository, releaseReadinessRepository } = await start();
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server, { path: "/v1/ops/release-readiness", cookie: staffCookie })).status).toBe(403);
    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response = await call(server, { path: "/v1/ops/release-readiness", cookie: managerCookie });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.text);
    expect(payload.manifests[0]).toMatchObject({
      sourceEnvironment: "DEV", targetEnvironment: "UAT",
      readinessDeclarations: { targetProvisioning: "not_started", runtimeExecution: "disabled",
        externalDelivery: "disabled", externalIngress: "disabled", dataBoundary: "synthetic_only",
        secretReferences: ["keychain://OPENAI_API_KEY_DEV"] },
    });
    expect(JSON.stringify(payload)).not.toContain("sk-");
    expect(releaseReadinessRepository.reads).toBe(1);
  });

  it("lets only an admin freeze a structurally safe DEV to UAT manifest with same-origin verification", async () => {
    const { server, identityRepository, releaseReadinessRepository } = await start();
    identityRepository.actorType = "admin";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const unsafe = structuredClone(releaseReadinessDeclarations) as ReleaseReadinessDeclarations;
    unsafe.externalIngress = "enabled" as "disabled";
    expect((await call(server, { method: "POST", path: "/v1/ops/release-manifests", cookie: sessionCookie, headers,
      body: { manifestKey: "dev-to-uat", declarations: unsafe,
        reason: "Reject any manifest that enables external ingress in this phase.", idempotencyKey: crypto.randomUUID() } })).status).toBe(400);
    const positiveBudget=structuredClone(releaseReadinessDeclarations) as ReleaseReadinessDeclarations;
    positiveBudget.approvals.budget.monthlyLimitUsd=1;
    expect((await call(server,{method:"POST",path:"/v1/ops/release-manifests",cookie:sessionCookie,headers,
      body:{manifestKey:"dev-to-uat",declarations:positiveBudget,
        reason:"Reject positive UAT budget until the first customer is confirmed.",idempotencyKey:crypto.randomUUID()}})).status).toBe(400);
    const created = await call(server, { method: "POST", path: "/v1/ops/release-manifests", cookie: sessionCookie, headers,
      body: { manifestKey: "dev-to-uat", declarations: releaseReadinessDeclarations,
        reason: "Freeze the exact synthetic-only DEV to UAT readiness evidence.", idempotencyKey: crypto.randomUUID() } });
    expect(created.status).toBe(200);
    expect(releaseReadinessRepository.creations).toHaveLength(1);
    expect(releaseReadinessRepository.creations[0]).toMatchObject({ actorId: operatorActorId,
      declarations: { targetProvisioning: "not_started", runtimeExecution: "disabled", externalDelivery: "disabled" } });
  });

  it("allows managers to evaluate and decide readiness but reserves submission for admins", async () => {
    const { server, identityRepository, releaseReadinessRepository } = await start();
    identityRepository.actorType = "manager";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const mutation = { reason: "Recheck the immutable manifest against current DEV state.", idempotencyKey: crypto.randomUUID() };
    expect((await call(server, { method: "POST", path: `/v1/ops/release-manifests/${releaseManifestId}/evaluations`, cookie: sessionCookie, headers, body: mutation })).status).toBe(200);
    expect((await call(server, { method: "POST", path: `/v1/ops/release-manifests/${releaseManifestId}/submit`, cookie: sessionCookie, headers, body: mutation })).status).toBe(403);
    expect((await call(server, { method: "POST", path: `/v1/ops/release-manifests/${releaseManifestId}/decisions`, cookie: sessionCookie, headers,
      body: { ...mutation, idempotencyKey: crypto.randomUUID(), action: "approve" } })).status).toBe(200);
    expect(releaseReadinessRepository.evaluations).toHaveLength(1);
    expect(releaseReadinessRepository.submissions).toHaveLength(0);
    expect(releaseReadinessRepository.decisions[0]).toMatchObject({ action: "approve", actorId: operatorActorId });
  });

  it("keeps UAT blueprints outside staff access while managers inspect zero-side-effect plans", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    const staffLogin=await login(server);
    const staffCookie=staffLogin.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    expect((await call(server,{path:"/v1/ops/uat-blueprints",cookie:staffCookie})).status).toBe(403);
    identityRepository.actorType="manager";
    const managerLogin=await login(server);
    const managerCookie=managerLogin.headers["set-cookie"]?.[0]?.split(";",1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const response=await call(server,{path:"/v1/ops/uat-blueprints",cookie:managerCookie});
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).blueprints[0]).toMatchObject({definition:{provisioningMode:"dry_run_only",
      targetProvisioning:"not_started",dataCopy:"none",runtimeExecution:"disabled",externalIngress:"disabled",
      externalDelivery:"disabled",secretMaterialization:"disabled"}});
    expect(response.text).not.toContain("secret-value");
    expect(uatBlueprintRepository.reads).toBe(1);
  });

  it("returns the M39 budget authorization separately from resource creation authority", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="manager";
    uatBlueprintRepository.currentAuthorization={
      id:crypto.randomUUID(),authorizationKey:"uat-sydney-synthetic",version:1,
      currentPolicy:{schemaVersion:"2.0",dataRegion:"Sydney",computeRegion:"Singapore",retentionDays:30,
        dataMode:"synthetic_only",realDataApproved:false,realDataRequiresReapproval:true,monthlyBudgetLimitUsd:40,
        resourceCreationAuthorized:false,executionWindow:null,runtimeOwnerActorId:operatorActorId,
        runtimeExecution:"disabled",externalIngress:"disabled",externalDelivery:"disabled",devDataCopy:"none"},
      costPlan:{estimatedMonthlyCostUsd:33},iacPlan:{status:"compiled_not_applied",applyAllowed:false},
      secretReferences:[{variableName:"DATABASE_URL",reference:"secretref://uat/supabase/database-url"}],
      destructionPlan:[{sequence:1,action:"disable_ingress_and_stop_uat_runtime",execution:"disabled"}],
      actualEffects:{environmentsCreated:0,servicesCreated:0,externalCalls:0,estimatedAddedMonthlyCostUsd:0},
      bundleHash:"f".repeat(64),compiledByName:"DEV Owner",reason:"Compile the M39 planning boundary without provider actions.",
      createdAt:overview.generatedAt,
    };
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const response=await call(server,{path:"/v1/ops/uat-blueprints",cookie});
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).currentAuthorization).toMatchObject({
      currentPolicy:{monthlyBudgetLimitUsd:40,realDataApproved:false,resourceCreationAuthorized:false},
      iacPlan:{status:"compiled_not_applied",applyAllowed:false},
      actualEffects:{environmentsCreated:0,servicesCreated:0,externalCalls:0},
    });
    expect(response.text).not.toContain("secret-value");
  });

  it("lets only admins create a structurally safe UAT blueprint", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="admin";
    const address=server.address(); if (!address || typeof address==="string") throw new Error("server did not bind");
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const unsafe=structuredClone(uatBlueprintDefinition) as UatEnvironmentBlueprintDefinition;
    unsafe.externalIngress="enabled" as "disabled";
    expect((await call(server,{method:"POST",path:"/v1/ops/uat-blueprints",cookie,headers,body:{
      blueprintKey:"uat-isolated",releaseManifestId,definition:unsafe,reason:"Reject external ingress in blueprint-only stage.",idempotencyKey:crypto.randomUUID(),
    }})).status).toBe(400);
    const paid=structuredClone(uatBlueprintDefinition) as UatEnvironmentBlueprintDefinition;
    paid.decisions.budget.monthlyLimitUsd=1;
    expect((await call(server,{method:"POST",path:"/v1/ops/uat-blueprints",cookie,headers,body:{
      blueprintKey:"uat-isolated",releaseManifestId,definition:paid,reason:"Reject any positive UAT budget before renewed approval.",idempotencyKey:crypto.randomUUID(),
    }})).status).toBe(400);
    const created=await call(server,{method:"POST",path:"/v1/ops/uat-blueprints",cookie,headers,body:{
      blueprintKey:"uat-isolated",releaseManifestId,definition:uatBlueprintDefinition,
      reason:"Record a non-executable synthetic-only UAT environment blueprint.",idempotencyKey:crypto.randomUUID(),
    }});
    expect(created.status).toBe(200);
    expect(uatBlueprintRepository.creations[0]).toMatchObject({actorId:operatorActorId,releaseManifestId,
      definition:{targetProvisioning:"not_started",runtimeExecution:"disabled",dataCopy:"none",decisions:{
        dataRegion:{region:"Sydney"},privacyRetention:{retentionDays:30,realDataRequiresReapproval:true},
        budget:{monthlyLimitUsd:0,paidResourceProvisioning:"prohibited"},runtimeOwner:{actorId:operatorActorId},
      }}});
  });

  it("allows managers to run a UAT dry-run but not create a blueprint", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="manager";
    const address=server.address(); if (!address || typeof address==="string") throw new Error("server did not bind");
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const body={reason:"Enumerate blockers without creating or changing UAT resources.",idempotencyKey:crypto.randomUUID()};
    expect((await call(server,{method:"POST",path:"/v1/ops/uat-blueprints",cookie,headers,body:{
      blueprintKey:"uat-isolated",releaseManifestId:null,definition:uatBlueprintDefinition,...body,
    }})).status).toBe(403);
    const dryRun=await call(server,{method:"POST",path:`/v1/ops/uat-blueprints/${uatBlueprintId}/dry-runs`,cookie,headers,body});
    expect(dryRun.status).toBe(200);
    expect(uatBlueprintRepository.creations).toHaveLength(0);
    expect(uatBlueprintRepository.dryRuns[0]).toMatchObject({actorId:operatorActorId,blueprintId:uatBlueprintId});
  });

  it("compiles and dry-runs a zero-budget UAT provisioning package without accepting provider instructions", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="admin";
    const address=server.address(); if (!address || typeof address==="string") throw new Error("server did not bind");
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const reason="Compile a non-executable Sydney UAT package under the zero-dollar gate.";
    const compiled=await call(server,{method:"POST",path:`/v1/ops/uat-blueprints/${uatBlueprintId}/provisioning-packages`,
      cookie,headers,body:{reason,idempotencyKey:crypto.randomUUID(),execution:"enabled",providerToken:"secret-value"}});
    expect(compiled.status).toBe(200);
    expect(JSON.parse(compiled.text)).toMatchObject({executionDecision:"no_go"});
    expect(uatBlueprintRepository.packageCompilations[0]).toMatchObject({actorId:operatorActorId,blueprintId:uatBlueprintId,reason});
    expect(JSON.stringify(uatBlueprintRepository.packageCompilations[0])).not.toContain("providerToken");
    const dryRun=await call(server,{method:"POST",path:`/v1/ops/uat-provisioning-packages/${uatProvisioningPackageId}/dry-runs`,
      cookie,headers,body:{reason:"Verify the package remains NO-GO with zero external side effects.",idempotencyKey:crypto.randomUUID()}});
    expect(dryRun.status).toBe(200);
    expect(JSON.parse(dryRun.text)).toMatchObject({status:"passed",executionDecision:"no_go",blockerCount:0});
    expect(uatBlueprintRepository.packageDryRuns[0]).toMatchObject({packageId:uatProvisioningPackageId});
  });

  it("compiles, records and evaluates UAT activation approvals without accepting secret or execution fields", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="admin";
    const address=server.address(); if (!address || typeof address==="string") throw new Error("server did not bind");
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const compileReason="Prepare the explicit approval checklist without authorizing UAT provisioning.";
    const compiled=await call(server,{method:"POST",path:`/v1/ops/uat-provisioning-packages/${uatProvisioningPackageId}/activation-approval-packs`,
      cookie,headers,body:{reason:compileReason,idempotencyKey:crypto.randomUUID(),execute:true,providerToken:"must-be-ignored"}});
    expect(compiled.status).toBe(200);
    expect(JSON.parse(compiled.text)).toMatchObject({pendingDecisionCount:4,executionDecision:"no_go"});
    expect(JSON.stringify(uatBlueprintRepository.activationCompilations[0])).not.toContain("providerToken");
    const decisionReason="Record the referenced synthetic-only scope approval for later evaluation.";
    const decision=await call(server,{method:"POST",path:`/v1/ops/uat-activation-approval-packs/${uatActivationApprovalPackId}/decisions`,
      cookie,headers,body:{decisionKey:"data_scope",status:"approved",evidence:{reference:"decision://uat/data-scope/synthetic",
        mode:"synthetic_only",region:"Sydney",retentionDays:30,realDataApproved:false,ignored:"removed"},reason:decisionReason,idempotencyKey:crypto.randomUUID()}});
    expect(decision.status).toBe(200);
    expect(uatBlueprintRepository.activationDecisions[0]).toMatchObject({decisionKey:"data_scope",status:"approved",
      evidence:{reference:"decision://uat/data-scope/synthetic",mode:"synthetic_only",region:"Sydney",retentionDays:30,realDataApproved:false}});
    expect(uatBlueprintRepository.activationDecisions[0]?.evidence).not.toHaveProperty("ignored");
    const rejectedSecret=await call(server,{method:"POST",path:`/v1/ops/uat-activation-approval-packs/${uatActivationApprovalPackId}/decisions`,
      cookie,headers,body:{decisionKey:"customer_confirmation",status:"approved",evidence:{reference:"decision://uat/customer/one",
        confirmedAt:"2026-08-09T00:00:00.000Z",apiKey:"secret"},reason:decisionReason,idempotencyKey:crypto.randomUUID()}});
    expect(rejectedSecret.status).toBe(400);
    const evaluated=await call(server,{method:"POST",path:`/v1/ops/uat-activation-approval-packs/${uatActivationApprovalPackId}/evaluations`,
      cookie,headers,body:{reason:"Evaluate missing approvals while keeping execution and provider calls disabled.",idempotencyKey:crypto.randomUUID()}});
    expect(evaluated.status).toBe(200);
    expect(JSON.parse(evaluated.text)).toMatchObject({status:"blocked",executionDecision:"no_go",blockerCount:4});
  });

  it("compiles and reviews an unsubmitted UAT final-authorization draft without accepting execution fields", async () => {
    const {server,identityRepository,uatBlueprintRepository}=await start();
    identityRepository.actorType="admin";
    const address=server.address(); if (!address || typeof address==="string") throw new Error("server did not bind");
    const loginResponse=await login(server);
    const cookie=loginResponse.headers["set-cookie"]?.[0]?.split(";",1)[0]; if (!cookie) throw new Error("session cookie missing");
    const overviewResponse=await call(server,{path:"/v1/ops/overview",cookie});
    const headers={origin:`http://127.0.0.1:${address.port}`,"x-dop-csrf":JSON.parse(overviewResponse.text).csrfToken};
    const reason="Freeze the current approval snapshot and disabled execution change set.";
    const compiled=await call(server,{method:"POST",path:`/v1/ops/uat-activation-approval-packs/${uatActivationApprovalPackId}/final-authorization-requests`,
      cookie,headers,body:{reason,idempotencyKey:crypto.randomUUID(),submit:true,authorize:true,execute:true,providerToken:"ignored"}});
    expect(compiled.status).toBe(200);
    expect(JSON.parse(compiled.text)).toMatchObject({status:"draft",blockerCount:4,submissionAllowed:false,authorizationGranted:false,executionDecision:"no_go"});
    expect(uatBlueprintRepository.finalAuthorizationCompilations[0]).toMatchObject({actorId:operatorActorId,approvalPackId:uatActivationApprovalPackId,reason});
    expect(JSON.stringify(uatBlueprintRepository.finalAuthorizationCompilations[0])).not.toMatch(/providerToken|authorize|execute/);
    const evaluated=await call(server,{method:"POST",path:`/v1/ops/uat-final-authorization-requests/${uatFinalAuthorizationRequestId}/evaluations`,
      cookie,headers,body:{reason:"Review blockers and zero side effects without submitting the request.",idempotencyKey:crypto.randomUUID(),execute:true}});
    expect(evaluated.status).toBe(200);
    expect(JSON.parse(evaluated.text)).toMatchObject({status:"blocked",recommendation:"blocked",executionDecision:"no_go",blockerCount:4,submissionAllowed:false});
    expect(uatBlueprintRepository.finalAuthorizationEvaluations[0]).toMatchObject({requestId:uatFinalAuthorizationRequestId});
    expect(JSON.stringify(uatBlueprintRepository.finalAuthorizationEvaluations[0])).not.toContain("execute");
  });

  it("requires a session, same origin and a session-bound CSRF token for review writes", async () => {
    const { server, reviewRepository } = await start();
    const unauthenticated = await call(server, {
      method: "POST", path: `/v1/ops/reviews/${reviewDocumentId}`, body: { action: "confirm" },
    });
    expect(unauthenticated.status).toBe(401);

    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const missingOrigin = await call(server, {
      method: "POST", path: `/v1/ops/reviews/${reviewDocumentId}`, cookie: sessionCookie,
      headers: { "x-dop-csrf": csrfToken },
      body: { action: "confirm", rationale: "Evidence verified against the synthetic statement.", idempotencyKey: "00000000-0000-4000-9000-000000000001" },
    });
    expect(missingOrigin.status).toBe(403);
    expect(reviewRepository.requests).toHaveLength(0);
  });

  it("serves the tenant task queue and performs a CSRF-protected lifecycle transition", async () => {
    const { server, taskRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const cookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!cookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;

    const queue = await call(server, { path: "/v1/ops/tasks", cookie });
    expect(queue.status).toBe(200);
    expect(JSON.parse(queue.text)).toMatchObject({ operatorActorId, tasks: [{ id: taskId, status: "open", externalExecution: "disabled" }] });

    const idempotencyKey = crypto.randomUUID();
    const transition = await call(server, {
      method: "POST", path: `/v1/ops/tasks/${taskId}/transitions`, cookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { action: "claim", assignedActorId: null,
        reason: "I have checked the synthetic task scope and claim responsibility now.", idempotencyKey },
    });
    expect(transition.status).toBe(200);
    expect(JSON.parse(transition.text)).toMatchObject({ outcome: "completed", taskId, action: "claim", assignedActorId: operatorActorId });
    expect(taskRepository.requests).toEqual([expect.objectContaining({
      taskId, actorId: operatorActorId, action: "claim", assignedActorId: null, idempotencyKey,
    })]);
  });

  it("rejects unverified or malformed task changes before the repository", async () => {
    const { server, taskRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const cookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!cookie) throw new Error("session cookie missing");
    const missingVerification = await call(server, {
      method: "POST", path: `/v1/ops/tasks/${taskId}/transitions`, cookie,
      body: { action: "claim", reason: "This request is missing the origin and CSRF proof.", idempotencyKey: crypto.randomUUID() },
    });
    expect(missingVerification.status).toBe(403);
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const invalid = await call(server, {
      method: "POST", path: `/v1/ops/tasks/${taskId}/transitions`, cookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { action: "complete", reason: "short", idempotencyKey: crypto.randomUUID() },
    });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.text)).toEqual({ error: "invalid_reason" });
    expect(taskRepository.requests).toHaveLength(0);
  });

  it("lets only a manager approve a Reminder through same-origin CSRF while delivery stays disabled", async () => {
    const { server, identityRepository, reminderRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const staffLogin = await login(server);
    const staffCookie = staffLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!staffCookie) throw new Error("session cookie missing");
    const staffOverview = await call(server, { path: "/v1/ops/overview", cookie: staffCookie });
    const staffCsrf = JSON.parse(staffOverview.text).csrfToken as string;
    const decisionBody = { action: "approve", reason: "The synthetic reminder content and invalid recipient are correct.", idempotencyKey: crypto.randomUUID() };
    expect((await call(server, { method: "POST", path: `/v1/ops/reminders/${reminderId}/decisions`, cookie: staffCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": staffCsrf }, body: decisionBody })).status).toBe(403);

    identityRepository.actorType = "manager";
    const managerLogin = await login(server);
    const managerCookie = managerLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!managerCookie) throw new Error("session cookie missing");
    const managerOverview = await call(server, { path: "/v1/ops/overview", cookie: managerCookie });
    const managerCsrf = JSON.parse(managerOverview.text).csrfToken as string;
    const approved = await call(server, { method: "POST", path: `/v1/ops/reminders/${reminderId}/decisions`, cookie: managerCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": managerCsrf }, body: decisionBody });
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.text)).toMatchObject({ status: "approved", deliveryMode: "disabled", externalCallCount: 0 });
    expect(reminderRepository.decisions).toEqual([expect.objectContaining({
      actorId: operatorActorId, reminderInstanceId: reminderId, action: "approve",
      idempotencyKey: decisionBody.idempotencyKey,
    })]);
  });

  it("executes a valid review with the configured operator identity", async () => {
    const { server, reviewRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST",
      path: `/v1/ops/reviews/${reviewDocumentId}`,
      cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        action: "confirm",
        rationale: "Evidence verified against the synthetic statement.",
        idempotencyKey: "00000000-0000-4000-9000-000000000001",
      },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "completed", documentStatus: "human_confirmed" });
    expect(reviewRepository.requests).toHaveLength(1);
    expect(reviewRepository.requests[0]).toMatchObject({ actorId: operatorActorId, documentId: reviewDocumentId, action: "confirm" });
  });

  it("passes a valid exclusion decision to the review boundary", async () => {
    const { server, reviewRepository } = await start();
    reviewRepository.result = {
      outcome: "completed",
      decisionId: "decision-excluded",
      eventId: "event-excluded",
      documentId: reviewDocumentId,
      action: "exclude",
      exclusionReason: "wrong_subject",
      documentStatus: "excluded",
      documentTypeCode: "invoice",
      issueStatus: "resolved",
      decidedAt: "2026-08-16T02:00:00.000Z",
    };
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST",
      path: `/v1/ops/reviews/${reviewDocumentId}`,
      cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: {
        action: "exclude",
        exclusionReason: "wrong_subject",
        rationale: "The file belongs to another synthetic subject and must not count.",
        idempotencyKey: "00000000-0000-4000-9000-000000000003",
      },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "completed", documentStatus: "excluded" });
    expect(reviewRepository.requests[0]).toMatchObject({
      actorId: operatorActorId,
      documentId: reviewDocumentId,
      action: "exclude",
      exclusionReason: "wrong_subject",
      documentTypeCode: null,
    });
  });

  it("batch-assigns up to 25 unique issues with per-item idempotency and reports partial outcomes", async () => {
    const { server, issueRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const response = await call(server, {
      method: "POST", path: "/v1/ops/issues/batch-transitions", cookie: sessionCookie,
      headers: { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken },
      body: { action: "assign_to_me", issueIds: [issueIdOne, issueIdTwo],
        note: "Batch assigned for the current synthetic operations review.",
        idempotencyKey: "00000000-0000-4000-b000-000000000001" },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "partial", requestedCount: 2, completedCount: 1 });
    expect(issueRepository.requests).toHaveLength(2);
    expect(issueRepository.requests[0]?.idempotencyKey).not.toBe(issueRepository.requests[1]?.idempotencyKey);
    expect(issueRepository.requests.every((item) => item.actorId === operatorActorId && item.action === "assign_to_me")).toBe(true);
  });

  it("rejects unsafe batch shapes before executing any issue transition", async () => {
    const { server, issueRepository } = await start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const loginResponse = await login(server);
    const sessionCookie = loginResponse.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    if (!sessionCookie) throw new Error("session cookie missing");
    const overviewResponse = await call(server, { path: "/v1/ops/overview", cookie: sessionCookie });
    const csrfToken = JSON.parse(overviewResponse.text).csrfToken as string;
    const headers = { origin: `http://127.0.0.1:${address.port}`, "x-dop-csrf": csrfToken };
    const duplicate = await call(server, { method: "POST", path: "/v1/ops/issues/batch-transitions", cookie: sessionCookie, headers,
      body: { action: "assign_to_me", issueIds: [issueIdOne, issueIdOne], note: "A sufficiently long audit note.", idempotencyKey: crypto.randomUUID() } });
    expect(duplicate.status).toBe(400);
    const unsafeAction = await call(server, { method: "POST", path: "/v1/ops/issues/batch-transitions", cookie: sessionCookie, headers,
      body: { action: "resolve", issueIds: [issueIdOne], note: "A sufficiently long audit note.", idempotencyKey: crypto.randomUUID() } });
    expect(unsafeAction.status).toBe(400);
    expect(issueRepository.requests).toHaveLength(0);
  });
});
