import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DocumentReviewInputError, type ResolveDocumentReview } from "../application/resolve-document-review.js";
import { IssueTransitionInputError, type TransitionIssue } from "../application/transition-issue.js";
import { TaskTransitionInputError, type TransitionTask } from "../application/transition-task.js";
import type { DocumentPreviewBroker, OpsDocumentPreviewRepository } from "../ports/document-preview.js";
import type { OpsIdentityAuthenticator, OpsIdentityRepository } from "../ports/ops-identity.js";
import type { OpsAccessRepository, OpsAccessRole } from "../ports/ops-access-repository.js";
import type { OpsConfigurationRepository, WorkConfigurationManifest } from "../ports/ops-configuration-repository.js";
import type { OpsOnboardingRepository } from "../ports/ops-onboarding-repository.js";
import type { CasePlanDefinition, OpsCasePlanRepository } from "../ports/ops-case-plan-repository.js";
import type { OpsReadRepository } from "../ports/ops-read-repository.js";
import type { OpsWorkPackageRepository, WorkPackageBlueprint } from "../ports/ops-work-package-repository.js";
import type {
  ClassificationProfileDefinition,
  OpsClassificationProfileRepository,
} from "../ports/ops-classification-profile-repository.js";
import type {
  ClassifierReleaseDefinition,
  OpsClassifierReleaseRepository,
} from "../ports/ops-classifier-release-repository.js";
import type {
  OpsSourceConnectorRepository,
  SourceConnectorDefinition,
} from "../ports/ops-source-connector-repository.js";
import type {
  MissingRequestReviewAction,
  OpsMissingRequestRepository,
} from "../ports/ops-missing-request-repository.js";
import type {
  OpsReleaseReadinessRepository,
  ReleaseReadinessDeclarations,
} from "../ports/ops-release-readiness-repository.js";
import type {
  OpsUatBlueprintRepository,
  UatActivationDecisionKey,
  UatEnvironmentBlueprintDefinition,
} from "../ports/ops-uat-blueprint-repository.js";
import type { OpsSessionRepository } from "../ports/ops-session-repository.js";
import type { OpsDocumentUploadBroker, OpsTrialRepository, StoredOpsUpload } from "../ports/ops-trial-repository.js";
import type { OpsTaskRepository, TaskOperatorAction } from "../ports/ops-task-repository.js";
import type { OpsReminderRepository, ReminderDecisionAction } from "../ports/ops-reminder-repository.js";
import type { OpsRetentionRepository } from "../ports/ops-retention-repository.js";
import type { OpsDemoFormRepository } from "../ports/ops-demo-form-repository.js";
import { OpsSessionAuthorizer, type OpsAuthorizedSession as OpsSession } from "./ops-session-authorizer.js";
import {
  cookie,
  csrfToken,
  safeEqual,
  sessionCookie,
  sessionTokenHash,
  signSessionPayload,
  verifiedSessionToken,
} from "./ops-session-security.js";

export interface OpsRouterOptions {
  repository: OpsReadRepository;
  identityAuthenticator: OpsIdentityAuthenticator;
  identityRepository: OpsIdentityRepository;
  sessionRepository: OpsSessionRepository;
  sessionAuthorizer?: OpsSessionAuthorizer;
  accessRepository?: OpsAccessRepository;
  configurationRepository?: OpsConfigurationRepository;
  onboardingRepository?: OpsOnboardingRepository;
  casePlanRepository?: OpsCasePlanRepository;
  workPackageRepository?: OpsWorkPackageRepository;
  classificationProfileRepository?: OpsClassificationProfileRepository;
  classifierReleaseRepository?: OpsClassifierReleaseRepository;
  sourceConnectorRepository?: OpsSourceConnectorRepository;
  releaseReadinessRepository?: OpsReleaseReadinessRepository;
  uatBlueprintRepository?: OpsUatBlueprintRepository;
  missingRequestRepository?: OpsMissingRequestRepository;
  reminderRepository?: OpsReminderRepository;
  retentionRepository?: OpsRetentionRepository;
  demoFormRepository?: OpsDemoFormRepository;
  clientPortalOrigin?: string;
  trialRepository?: OpsTrialRepository;
  uploadBroker?: OpsDocumentUploadBroker;
  organizationKey: string;
  sessionSecret: string;
  reviewHandler: ResolveDocumentReview;
  issueHandler?: TransitionIssue;
  taskRepository?: OpsTaskRepository;
  taskHandler?: TransitionTask;
  previewRepository?: OpsDocumentPreviewRepository;
  previewBroker?: DocumentPreviewBroker;
  staticDirectory: string;
  secureCookie?: boolean;
  /** Explicitly enabled only by the loopback local entry; cloud login stays email-based. */
  localLoginUsername?: string;
  sessionHours?: number;
  rememberedSessionDays?: number;
  now?: () => Date;
}

interface LoginBucket { startedAt: number; count: number }
export class OpsRouter {
  private readonly now: () => Date;
  private readonly sessionHours: number;
  private readonly rememberedSessionDays: number;
  private readonly secureCookie: boolean;
  private readonly sessionAuthorizer: OpsSessionAuthorizer;
  private readonly loginBuckets = new Map<string, LoginBucket>();

  constructor(private readonly options: OpsRouterOptions) {
    if (options.sessionSecret.length < 32) throw new Error("DOP_OPS_SESSION_SECRET must contain at least 32 characters");
    this.now = options.now ?? (() => new Date());
    this.sessionAuthorizer = options.sessionAuthorizer ?? new OpsSessionAuthorizer({
      organizationKey: options.organizationKey,
      sessionSecret: options.sessionSecret,
      identityRepository: options.identityRepository,
      sessionRepository: options.sessionRepository,
      now: this.now,
    });
    this.sessionHours = options.sessionHours ?? 8;
    this.rememberedSessionDays = options.rememberedSessionDays ?? 30;
    if (!Number.isInteger(this.sessionHours) || this.sessionHours < 1 || this.sessionHours > 24) {
      throw new Error("ops sessionHours must be an integer between 1 and 24");
    }
    if (!Number.isInteger(this.rememberedSessionDays) || this.rememberedSessionDays < 1 || this.rememberedSessionDays > 30) {
      throw new Error("ops rememberedSessionDays must be an integer between 1 and 30");
    }
    this.secureCookie = options.secureCookie ?? true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (await this.rejectWorkbenchOnlySession(request, response, url.pathname)) return true;
    if (request.method === "GET" && (url.pathname === "/ops" || url.pathname === "/ops/")) {
      return this.sendAsset(response, "index.html", "text/html; charset=utf-8", false);
    }
    const asset = assetFor(url.pathname);
    if (request.method === "GET" && asset) {
      return this.sendAsset(response, asset.filename, asset.contentType, asset.cacheable);
    }
    if (url.pathname === "/v1/ops/session" && request.method === "POST") {
      await this.login(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/session" && request.method === "DELETE") {
      await this.logout(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/sessions" && request.method === "GET") {
      await this.getSessions(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/sessions/revoke-others" && request.method === "POST") {
      await this.revokeOtherSessions(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/sessions/cleanup" && request.method === "POST") {
      await this.cleanupSessions(request, response);
      return true;
    }
    const sessionRevokeMatch = /^\/v1\/ops\/sessions\/([^/]+)\/revoke$/.exec(url.pathname);
    if (sessionRevokeMatch && request.method === "POST") {
      await this.revokeSessionById(request, response, sessionRevokeMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/overview" && request.method === "GET") {
      opsHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      const overview = await this.options.repository.getOverview(this.options.organizationKey, this.now(), session.actorId);
      return sendJson(response, 200, { ...overview, csrfToken: csrfToken(session.cookieValue, this.options.sessionSecret) });
    }
    if (url.pathname === "/v1/ops/tasks" && request.method === "GET") {
      await this.getTasks(request, response);
      return true;
    }
    const taskTransitionMatch = /^\/v1\/ops\/tasks\/([^/]+)\/transitions$/.exec(url.pathname);
    if (taskTransitionMatch && request.method === "POST") {
      await this.transitionTask(request, response, taskTransitionMatch[1] ?? "");
      return true;
    }
    const reminderDecisionMatch = /^\/v1\/ops\/reminders\/([^/]+)\/decisions$/.exec(url.pathname);
    if (reminderDecisionMatch && request.method === "POST") {
      await this.decideReminder(request, response, reminderDecisionMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/retention" && request.method === "GET") {
      await this.getRetentionDashboard(request,response); return true;
    }
    if (url.pathname === "/v1/ops/retention/policy-confirmations" && request.method === "POST") {
      await this.confirmRetentionPolicy(request,response); return true;
    }
    if (url.pathname === "/v1/ops/retention/runs" && request.method === "POST") {
      await this.planRetentionRun(request,response); return true;
    }
    if (url.pathname === "/v1/ops/demo-form" && request.method === "GET") {
      await this.getDemoForm(request,response); return true;
    }
    if (url.pathname === "/v1/ops/demo-form/invitations" && request.method === "POST") {
      await this.issueDemoFormInvitation(request,response); return true;
    }
    if (url.pathname === "/v1/ops/client-portal/questions" && request.method === "POST") {
      await this.publishClientPortalQuestion(request,response); return true;
    }
    const clientQuestionTransitionMatch=/^\/v1\/ops\/client-portal\/questions\/([^/]+)\/transitions$/.exec(url.pathname);
    if (clientQuestionTransitionMatch && request.method==="POST") {
      await this.transitionClientPortalQuestion(request,response,clientQuestionTransitionMatch[1]??""); return true;
    }
    const demoInvitationRevokeMatch=/^\/v1\/ops\/demo-form\/invitations\/([^/]+)\/revoke$/.exec(url.pathname);
    if (demoInvitationRevokeMatch && request.method==="POST") {
      await this.revokeDemoFormInvitation(request,response,demoInvitationRevokeMatch[1]??""); return true;
    }
    const legalHoldMatch=/^\/v1\/ops\/cases\/([^/]+)\/legal-holds$/.exec(url.pathname);
    if (legalHoldMatch && request.method==="POST") {
      await this.setCaseLegalHold(request,response,legalHoldMatch[1]??""); return true;
    }
    if (url.pathname === "/v1/ops/access" && request.method === "GET") {
      await this.getAccess(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/access/invitations" && request.method === "POST") {
      await this.createInvitation(request, response);
      return true;
    }
    const invitationCancelMatch = /^\/v1\/ops\/access\/invitations\/([^/]+)\/cancel$/.exec(url.pathname);
    if (invitationCancelMatch && request.method === "POST") {
      await this.cancelInvitation(request, response, invitationCancelMatch[1] ?? "");
      return true;
    }
    const actorAccessMatch = /^\/v1\/ops\/access\/actors\/([^/]+)$/.exec(url.pathname);
    if (actorAccessMatch && request.method === "POST") {
      await this.changeActorAccess(request, response, actorAccessMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/onboarding" && request.method === "GET") {
      await this.getOnboarding(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/onboarding/subjects" && request.method === "POST") {
      await this.onboardSubject(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/work-packages" && request.method === "GET") {
      await this.getWorkPackages(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/work-packages" && request.method === "POST") {
      await this.createWorkPackage(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/classification-profile" && request.method === "GET") {
      await this.getClassificationProfile(request, response);
      return true;
    }
    const classificationProfileCloneMatch = /^\/v1\/ops\/classification-profile\/([^/]+)\/clone$/.exec(url.pathname);
    if (classificationProfileCloneMatch && request.method === "POST") {
      await this.cloneClassificationProfile(request, response, classificationProfileCloneMatch[1] ?? "");
      return true;
    }
    const classificationProfileRevisionMatch = /^\/v1\/ops\/classification-profile\/([^/]+)\/revisions$/.exec(url.pathname);
    if (classificationProfileRevisionMatch && request.method === "POST") {
      await this.updateClassificationProfile(request, response, classificationProfileRevisionMatch[1] ?? "");
      return true;
    }
    const classificationProfileEvaluationMatch = /^\/v1\/ops\/classification-profile\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (classificationProfileEvaluationMatch && request.method === "POST") {
      await this.runClassificationProfileEvaluation(request, response, classificationProfileEvaluationMatch[1] ?? "");
      return true;
    }
    const classificationProfileTransitionMatch = /^\/v1\/ops\/classification-profile\/([^/]+)\/transitions$/.exec(url.pathname);
    if (classificationProfileTransitionMatch && request.method === "POST") {
      await this.transitionClassificationProfile(request, response, classificationProfileTransitionMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/classifier-releases" && request.method === "GET") {
      await this.getClassifierReleases(request, response);
      return true;
    }
    const classifierReleaseCloneMatch = /^\/v1\/ops\/classifier-releases\/([^/]+)\/clone$/.exec(url.pathname);
    if (classifierReleaseCloneMatch && request.method === "POST") {
      await this.cloneClassifierRelease(request, response, classifierReleaseCloneMatch[1] ?? "");
      return true;
    }
    const classifierReleaseRevisionMatch = /^\/v1\/ops\/classifier-releases\/([^/]+)\/revisions$/.exec(url.pathname);
    if (classifierReleaseRevisionMatch && request.method === "POST") {
      await this.updateClassifierRelease(request, response, classifierReleaseRevisionMatch[1] ?? "");
      return true;
    }
    const classifierReleaseEvaluationMatch = /^\/v1\/ops\/classifier-releases\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (classifierReleaseEvaluationMatch && request.method === "POST") {
      await this.requestClassifierReleaseEvaluation(request, response, classifierReleaseEvaluationMatch[1] ?? "");
      return true;
    }
    const classifierReleaseTransitionMatch = /^\/v1\/ops\/classifier-releases\/([^/]+)\/transitions$/.exec(url.pathname);
    if (classifierReleaseTransitionMatch && request.method === "POST") {
      await this.transitionClassifierRelease(request, response, classifierReleaseTransitionMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/source-connectors" && request.method === "GET") {
      await this.getSourceConnectors(request, response); return true;
    }
    if (url.pathname === "/v1/ops/source-connectors" && request.method === "POST") {
      await this.createSourceConnector(request, response); return true;
    }
    const sourceConnectorRevisionMatch = /^\/v1\/ops\/source-connectors\/([^/]+)\/revisions$/.exec(url.pathname);
    if (sourceConnectorRevisionMatch && request.method === "POST") {
      await this.updateSourceConnector(request, response, sourceConnectorRevisionMatch[1] ?? ""); return true;
    }
    const sourceConnectorTestMatch = /^\/v1\/ops\/source-connectors\/([^/]+)\/tests$/.exec(url.pathname);
    if (sourceConnectorTestMatch && request.method === "POST") {
      await this.runSourceConnectorTest(request, response, sourceConnectorTestMatch[1] ?? ""); return true;
    }
    const sourceConnectorTransitionMatch = /^\/v1\/ops\/source-connectors\/([^/]+)\/transitions$/.exec(url.pathname);
    if (sourceConnectorTransitionMatch && request.method === "POST") {
      await this.transitionSourceConnector(request, response, sourceConnectorTransitionMatch[1] ?? ""); return true;
    }
    if (url.pathname === "/v1/ops/release-readiness" && request.method === "GET") {
      await this.getReleaseReadiness(request, response); return true;
    }
    if (url.pathname === "/v1/ops/release-manifests" && request.method === "POST") {
      await this.createReleaseManifest(request, response); return true;
    }
    const releaseEvaluationMatch = /^\/v1\/ops\/release-manifests\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (releaseEvaluationMatch && request.method === "POST") {
      await this.evaluateReleaseManifest(request, response, releaseEvaluationMatch[1] ?? ""); return true;
    }
    const releaseSubmitMatch = /^\/v1\/ops\/release-manifests\/([^/]+)\/submit$/.exec(url.pathname);
    if (releaseSubmitMatch && request.method === "POST") {
      await this.submitReleaseManifest(request, response, releaseSubmitMatch[1] ?? ""); return true;
    }
    const releaseDecisionMatch = /^\/v1\/ops\/release-manifests\/([^/]+)\/decisions$/.exec(url.pathname);
    if (releaseDecisionMatch && request.method === "POST") {
      await this.decideReleaseManifest(request, response, releaseDecisionMatch[1] ?? ""); return true;
    }
    if (url.pathname === "/v1/ops/uat-blueprints" && request.method === "GET") {
      await this.getUatBlueprints(request, response); return true;
    }
    if (url.pathname === "/v1/ops/uat-blueprints" && request.method === "POST") {
      await this.createUatBlueprint(request, response); return true;
    }
    const uatDryRunMatch = /^\/v1\/ops\/uat-blueprints\/([^/]+)\/dry-runs$/.exec(url.pathname);
    if (uatDryRunMatch && request.method === "POST") {
      await this.runUatBlueprintDryRun(request, response, uatDryRunMatch[1] ?? ""); return true;
    }
    const uatPackageCompileMatch = /^\/v1\/ops\/uat-blueprints\/([^/]+)\/provisioning-packages$/.exec(url.pathname);
    if (uatPackageCompileMatch && request.method === "POST") {
      await this.compileUatProvisioningPackage(request, response, uatPackageCompileMatch[1] ?? ""); return true;
    }
    const uatPackageDryRunMatch = /^\/v1\/ops\/uat-provisioning-packages\/([^/]+)\/dry-runs$/.exec(url.pathname);
    if (uatPackageDryRunMatch && request.method === "POST") {
      await this.runUatProvisioningPackageDryRun(request, response, uatPackageDryRunMatch[1] ?? ""); return true;
    }
    const uatApprovalCompileMatch=/^\/v1\/ops\/uat-provisioning-packages\/([^/]+)\/activation-approval-packs$/.exec(url.pathname);
    if (uatApprovalCompileMatch && request.method==="POST") {
      await this.compileUatActivationApprovalPack(request,response,uatApprovalCompileMatch[1]??""); return true;
    }
    const uatApprovalDecisionMatch=/^\/v1\/ops\/uat-activation-approval-packs\/([^/]+)\/decisions$/.exec(url.pathname);
    if (uatApprovalDecisionMatch && request.method==="POST") {
      await this.recordUatActivationDecision(request,response,uatApprovalDecisionMatch[1]??""); return true;
    }
    const uatApprovalEvaluationMatch=/^\/v1\/ops\/uat-activation-approval-packs\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (uatApprovalEvaluationMatch && request.method==="POST") {
      await this.evaluateUatActivationApprovalPack(request,response,uatApprovalEvaluationMatch[1]??""); return true;
    }
    const uatFinalCompileMatch=/^\/v1\/ops\/uat-activation-approval-packs\/([^/]+)\/final-authorization-requests$/.exec(url.pathname);
    if (uatFinalCompileMatch && request.method==="POST") {
      await this.compileUatFinalAuthorizationRequest(request,response,uatFinalCompileMatch[1]??""); return true;
    }
    const uatFinalEvaluationMatch=/^\/v1\/ops\/uat-final-authorization-requests\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (uatFinalEvaluationMatch && request.method==="POST") {
      await this.evaluateUatFinalAuthorizationRequest(request,response,uatFinalEvaluationMatch[1]??""); return true;
    }
    const workPackageCloneMatch = /^\/v1\/ops\/work-packages\/([^/]+)\/clone$/.exec(url.pathname);
    if (workPackageCloneMatch && request.method === "POST") {
      await this.cloneWorkPackage(request, response, workPackageCloneMatch[1] ?? "");
      return true;
    }
    const workPackageRevisionMatch = /^\/v1\/ops\/work-packages\/([^/]+)\/revisions$/.exec(url.pathname);
    if (workPackageRevisionMatch && request.method === "POST") {
      await this.updateWorkPackage(request, response, workPackageRevisionMatch[1] ?? "");
      return true;
    }
    const workPackageDryRunMatch = /^\/v1\/ops\/work-packages\/([^/]+)\/dry-runs$/.exec(url.pathname);
    if (workPackageDryRunMatch && request.method === "POST") {
      await this.runWorkPackageDryRun(request, response, workPackageDryRunMatch[1] ?? "");
      return true;
    }
    const workPackageTransitionMatch = /^\/v1\/ops\/work-packages\/([^/]+)\/transitions$/.exec(url.pathname);
    if (workPackageTransitionMatch && request.method === "POST") {
      await this.transitionWorkPackage(request, response, workPackageTransitionMatch[1] ?? "");
      return true;
    }
    const workPackageRetireMatch = /^\/v1\/ops\/work-packages\/([^/]+)\/retire$/.exec(url.pathname);
    if (workPackageRetireMatch && request.method === "POST") {
      await this.retireWorkPackage(request, response, workPackageRetireMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/configurations" && request.method === "GET") {
      await this.getConfigurations(request, response);
      return true;
    }
    const configurationCloneMatch = /^\/v1\/ops\/configurations\/([^/]+)\/clone$/.exec(url.pathname);
    if (configurationCloneMatch && request.method === "POST") {
      await this.cloneConfiguration(request, response, configurationCloneMatch[1] ?? "");
      return true;
    }
    const configurationRevisionMatch = /^\/v1\/ops\/configurations\/([^/]+)\/revisions$/.exec(url.pathname);
    if (configurationRevisionMatch && request.method === "POST") {
      await this.updateConfigurationDraft(request, response, configurationRevisionMatch[1] ?? "");
      return true;
    }
    const configurationTransitionMatch = /^\/v1\/ops\/configurations\/([^/]+)\/transitions$/.exec(url.pathname);
    if (configurationTransitionMatch && request.method === "POST") {
      await this.transitionConfiguration(request, response, configurationTransitionMatch[1] ?? "");
      return true;
    }
    const configurationCaseMatch = /^\/v1\/ops\/configurations\/([^/]+)\/cases$/.exec(url.pathname);
    if (configurationCaseMatch && request.method === "POST") {
      await this.createConfigurationCase(request, response, configurationCaseMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/case-plans" && request.method === "GET") {
      await this.getCasePlans(request, response);
      return true;
    }
    if (url.pathname === "/v1/ops/case-plans" && request.method === "POST") {
      await this.createCasePlan(request, response);
      return true;
    }
    const casePlanCloneMatch = /^\/v1\/ops\/case-plans\/([^/]+)\/clone$/.exec(url.pathname);
    if (casePlanCloneMatch && request.method === "POST") {
      await this.cloneCasePlan(request, response, casePlanCloneMatch[1] ?? "");
      return true;
    }
    const casePlanRevisionMatch = /^\/v1\/ops\/case-plans\/([^/]+)\/revisions$/.exec(url.pathname);
    if (casePlanRevisionMatch && request.method === "POST") {
      await this.updateCasePlan(request, response, casePlanRevisionMatch[1] ?? "");
      return true;
    }
    const casePlanTransitionMatch = /^\/v1\/ops\/case-plans\/([^/]+)\/transitions$/.exec(url.pathname);
    if (casePlanTransitionMatch && request.method === "POST") {
      await this.transitionCasePlan(request, response, casePlanTransitionMatch[1] ?? "");
      return true;
    }
    const casePlanPreviewMatch = /^\/v1\/ops\/case-plans\/([^/]+)\/previews$/.exec(url.pathname);
    if (casePlanPreviewMatch && request.method === "POST") {
      await this.previewCasePlan(request, response, casePlanPreviewMatch[1] ?? "");
      return true;
    }
    const casePlanApproveMatch = /^\/v1\/ops\/case-plan-previews\/([^/]+)\/approve$/.exec(url.pathname);
    if (casePlanApproveMatch && request.method === "POST") {
      await this.approveCasePlanPreview(request, response, casePlanApproveMatch[1] ?? "");
      return true;
    }
    const missingRequestRevisionMatch = /^\/v1\/ops\/missing-request-drafts\/([^/]+)\/revisions$/.exec(url.pathname);
    if (missingRequestRevisionMatch && request.method === "POST") {
      await this.createMissingRequestRevision(request, response, missingRequestRevisionMatch[1] ?? "");
      return true;
    }
    const missingRequestTransitionMatch = /^\/v1\/ops\/missing-request-revisions\/([^/]+)\/transitions$/.exec(url.pathname);
    if (missingRequestTransitionMatch && request.method === "POST") {
      await this.transitionMissingRequestRevision(request, response, missingRequestTransitionMatch[1] ?? "");
      return true;
    }
    const deliveryPlanMatch = /^\/v1\/ops\/missing-request-revisions\/([^/]+)\/delivery-plans$/.exec(url.pathname);
    if (deliveryPlanMatch && request.method === "POST") {
      await this.planMissingRequestDelivery(request, response, deliveryPlanMatch[1] ?? "");
      return true;
    }
    const deliveryEvaluationMatch = /^\/v1\/ops\/delivery-jobs\/([^/]+)\/evaluations$/.exec(url.pathname);
    if (deliveryEvaluationMatch && request.method === "POST") {
      await this.runDeliveryContractEvaluation(request, response, deliveryEvaluationMatch[1] ?? "");
      return true;
    }
    const deliveryAuthorizationMatch = /^\/v1\/ops\/delivery-jobs\/([^/]+)\/synthetic-authorizations$/.exec(url.pathname);
    if (deliveryAuthorizationMatch && request.method === "POST") {
      await this.authorizeSyntheticDelivery(request, response, deliveryAuthorizationMatch[1] ?? "");
      return true;
    }
    const deliveryReconciliationMatch = /^\/v1\/ops\/delivery-jobs\/([^/]+)\/unknown-reconciliations$/.exec(url.pathname);
    if (deliveryReconciliationMatch && request.method === "POST") {
      await this.reconcileUnknownDelivery(request, response, deliveryReconciliationMatch[1] ?? "");
      return true;
    }
    const caseUploadMatch = /^\/v1\/ops\/cases\/([^/]+)\/documents$/.exec(url.pathname);
    if (caseUploadMatch && request.method === "POST") {
      await this.uploadDocument(request, response, caseUploadMatch[1] ?? "");
      return true;
    }
    const caseCompleteMatch = /^\/v1\/ops\/cases\/([^/]+)\/complete$/.exec(url.pathname);
    if (caseCompleteMatch && request.method === "POST") {
      await this.completeCase(request, response, caseCompleteMatch[1] ?? "");
      return true;
    }
    const caseMatch = /^\/v1\/ops\/cases\/([^/]+)$/.exec(url.pathname);
    if (caseMatch && request.method === "GET") {
      opsHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      const caseId = caseMatch[1] ?? "";
      if (!isUuid(caseId)) return sendJson(response, 400, { error: "invalid_identifier" });
      const detail = await this.options.repository.getCaseDetail(this.options.organizationKey, caseId, this.now(), session.actorId);
      return detail ? sendJson(response, 200, detail) : sendJson(response, 404, { outcome: "not_found", resource: "case" });
    }
    const reviewMatch = /^\/v1\/ops\/reviews\/([^/]+)$/.exec(url.pathname);
    if (reviewMatch && request.method === "POST") {
      await this.resolveReview(request, response, reviewMatch[1] ?? "");
      return true;
    }
    const previewMatch = /^\/v1\/ops\/documents\/([^/]+)\/preview$/.exec(url.pathname);
    if (previewMatch && request.method === "POST") {
      await this.createPreview(request, response, previewMatch[1] ?? "");
      return true;
    }
    const issueMatch = /^\/v1\/ops\/issues\/([^/]+)\/transitions$/.exec(url.pathname);
    if (issueMatch && request.method === "POST") {
      await this.transitionIssue(request, response, issueMatch[1] ?? "");
      return true;
    }
    if (url.pathname === "/v1/ops/issues/batch-transitions" && request.method === "POST") {
      await this.batchTransitionIssues(request, response);
      return true;
    }
    if (url.pathname.startsWith("/v1/ops/") || url.pathname.startsWith("/ops/")) {
      opsHeaders(response);
      return sendJson(response, 404, { error: "not_found" });
    }
    return false;
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const key = request.socket.remoteAddress ?? "unknown";
    const now = this.now().getTime();
    const bucket = this.loginBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= 60_000) this.loginBuckets.set(key, { startedAt: now, count: 1 });
    else {
      bucket.count += 1;
      if (bucket.count > 5) {
        response.setHeader("retry-after", "60");
        sendJson(response, 429, { error: "too_many_login_attempts" });
        return;
      }
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, 8_192);
    } catch (error) {
      const payloadTooLarge = error instanceof Error && error.message === "request_body_too_large";
      sendJson(response, payloadTooLarge ? 413 : 400, {
        error: payloadTooLarge ? "request_body_too_large" : "invalid_json",
      });
      return;
    }
    const candidate = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const email = this.options.localLoginUsername !== undefined
      ? (typeof candidate.username === "string" ? candidate.username.trim() : "")
      : (typeof candidate.email === "string" ? candidate.email.trim().toLowerCase() : "");
    const password = typeof candidate.password === "string" ? candidate.password : "";
    const rememberDevice = candidate.rememberDevice === true;
    const validIdentifier = this.options.localLoginUsername !== undefined
      ? email === this.options.localLoginUsername : isEmail(email);
    if (!validIdentifier || email.length > 254 || password.length < 8 || password.length > 1_024) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    const authentication = await this.options.identityAuthenticator.authenticate({ email, password });
    if (authentication.outcome === "identity_provider_unavailable") {
      console.warn(JSON.stringify({ event: "ops_login", outcome: "identity_provider_unavailable" }));
      sendJson(response, 503, { error: "identity_provider_unavailable" });
      return;
    }
    if (authentication.outcome === "invalid_credentials") {
      console.info(JSON.stringify({ event: "ops_login", outcome: "invalid_credentials" }));
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    const actor = await this.options.identityRepository.findActiveByExternalSubject(
      this.options.organizationKey,
      authentication.externalSubjectId,
    );
    if (!actor) {
      console.info(JSON.stringify({ event: "ops_login", outcome: "identity_not_authorized" }));
      sendJson(response, 403, { error: "identity_not_authorized" });
      return;
    }
    const sessionSeconds = rememberDevice
      ? this.rememberedSessionDays * 24 * 60 * 60
      : this.sessionHours * 60 * 60;
    const expiresAt = now + sessionSeconds * 1_000;
    const opaqueToken = randomBytes(32).toString("base64url");
    const payload = `v2.${opaqueToken}`;
    const value = `${payload}.${signSessionPayload(payload, this.options.sessionSecret)}`;
    const persisted = await this.options.sessionRepository.create(this.options.organizationKey, {
      actorId: actor.id,
      tokenHash: sessionTokenHash(opaqueToken),
      sessionMode: rememberDevice ? "remembered_device" : "standard",
      issuedAt: new Date(now),
      expiresAt: new Date(expiresAt),
    });
    if (!persisted) {
      console.warn(JSON.stringify({ event: "ops_login", outcome: "session_persistence_failed", actorId: actor.id }));
      sendJson(response, 503, { error: "session_service_unavailable" });
      return;
    }
    response.setHeader("set-cookie", sessionCookie(value, sessionSeconds, this.secureCookie));
    console.info(JSON.stringify({
      event: "ops_login",
      outcome: "signed_in",
      actorId: actor.id,
      actorType: actor.actorType,
      sessionMode: rememberDevice ? "remembered_device" : "standard",
    }));
    sendJson(response, 200, {
      outcome: "signed_in",
      expires_at: new Date(expiresAt).toISOString(),
      remembered_device: rememberDevice,
      operator: { displayName: actor.displayName, actorType: actor.actorType },
    });
  }

  private async logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    response.setHeader("set-cookie", sessionCookie("", 0, this.secureCookie));
    const parsed = verifiedSessionToken(cookie(request.headers.cookie, "dop_ops_session"), this.options.sessionSecret);
    if (!parsed) return void sendJson(response, 204, null);
    try {
      await this.options.sessionRepository.revoke(
        this.options.organizationKey, sessionTokenHash(parsed.opaqueToken), "logout", this.now(),
      );
      return void sendJson(response, 204, null);
    } catch {
      console.warn(JSON.stringify({ event: "ops_logout", outcome: "session_revocation_failed" }));
      return void sendJson(response, 503, { error: "session_service_unavailable" });
    }
  }

  private async authorized(request: IncomingMessage): Promise<OpsSession | null> {
    return await this.sessionAuthorizer.authorize(request.headers.cookie);
  }

  private async getSessions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    const sessions = await this.options.sessionRepository.list(this.options.organizationKey, {
      actorId: session.actorId, currentTokenHash: session.tokenHash, now: this.now(),
    });
    return void sendJson(response, 200, {
      generatedAt: this.now().toISOString(),
      canManageAll: session.actorType === "admin",
      currentSessionId: session.sessionId,
      sessions,
    });
  }

  private async revokeSessionById(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.sessionMutationActor(request, response);
    if (!session) return;
    if (!isUuid(sessionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readAccessBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_session_request" });
    }
    const result = await this.options.sessionRepository.revokeById(this.options.organizationKey, {
      actorId: session.actorId, sessionId, currentTokenHash: session.tokenHash, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    if (result.currentSession && result.revoked) {
      response.setHeader("set-cookie", sessionCookie("", 0, this.secureCookie));
    }
    return void sendSessionMutationResult(response, result);
  }

  private async revokeOtherSessions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.sessionMutationActor(request, response);
    if (!session) return;
    const body = await readAccessBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_session_request" });
    }
    const result = await this.options.sessionRepository.revokeOtherDevices(this.options.organizationKey, {
      actorId: session.actorId, currentTokenHash: session.tokenHash, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendSessionMutationResult(response, result);
  }

  private async cleanupSessions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.sessionMutationActor(request, response);
    if (!session) return;
    if (session.actorType !== "admin") return void sendJson(response, 403, { error: "admin_required" });
    const body = await readAccessBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    const retentionDays = typeof body.retentionDays === "number" ? body.retentionDays : NaN;
    const apply = body.apply === true;
    if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 365
      || (apply && (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)))) {
      return void sendJson(response, 400, { error: "invalid_session_cleanup_request" });
    }
    const result = await this.options.sessionRepository.cleanup(this.options.organizationKey, {
      actorId: session.actorId, retentionDays, apply,
      reason: apply ? reason : "dry run only",
      idempotencyKey: apply ? idempotencyKey : randomUUID(),
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendSessionMutationResult(response, result);
  }

  private async sessionMutationActor(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!this.mutationAuthorized(request, session)) {
      sendJson(response, 403, { error: "request_verification_failed" }); return null;
    }
    return session;
  }

  private async getAccess(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (session.actorType !== "admin") return void sendJson(response, 403, { error: "admin_required" });
    if (!this.options.accessRepository) return void sendJson(response, 503, { error: "access_management_not_configured" });
    const access = await this.options.accessRepository.getAccess(this.options.organizationKey, session.actorId, this.now());
    return void sendJson(response, 200, access);
  }

  private async getDemoForm(request:IncomingMessage,response:ServerResponse):Promise<void>{
    opsHeaders(response);const session=await this.authorized(request);
    if(!session)return void sendJson(response,401,{error:"session_required"});
    if(!isConfigurationReader(session.actorType))return void sendJson(response,403,{error:"manager_required"});
    if(!this.options.demoFormRepository)return void sendJson(response,503,{error:"demo_form_not_configured"});
    return void sendJson(response,200,await this.options.demoFormRepository.getSnapshot(this.options.organizationKey,this.now()));
  }

  private async issueDemoFormInvitation(request:IncomingMessage,response:ServerResponse):Promise<void>{
    opsHeaders(response);const session=await this.demoFormMutationSession(request,response);
    if(!session||!this.options.demoFormRepository)return;
    let body:unknown;try{body=await readJsonBody(request,16_384);}catch{return void sendJson(response,400,{error:"invalid_json"});}
    if(!isPlainObject(body))return void sendJson(response,400,{error:"invalid_demo_invitation"});
    const entryVersionId=typeof body.entryVersionId==="string"?body.entryVersionId:"";
    const caseId=typeof body.caseId==="string"?body.caseId:"";
    const periodKey=typeof body.periodKey==="string"?body.periodKey.trim():"";
    const maximumSubmissions=Number(body.maximumSubmissions);
    const validDays=Number(body.validDays);
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if(!isUuid(entryVersionId)||!isUuid(caseId)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(periodKey)
      ||!Number.isInteger(maximumSubmissions)||maximumSubmissions<2||maximumSubmissions>20
      ||!Number.isInteger(validDays)||validDays<1||validDays>30
      ||reason.length<12||reason.length>1000||!isUuid(idempotencyKey)){
      return void sendJson(response,400,{error:"invalid_demo_invitation"});
    }
    const invitationToken=randomBytes(32).toString("base64url");
    const now=this.now();const validUntil=new Date(now.getTime()+validDays*86_400_000);
    const result=await this.options.demoFormRepository.issueInvitation(this.options.organizationKey,{
      actorId:session.actorId,entryVersionId,caseId,
      invitationTokenSha256:createHash("sha256").update(invitationToken).digest("hex"),periodKey,
      allowInitial:true,allowSupplement:true,maximumSubmissions,validFrom:now,validUntil,reason,
      idempotencyKey,correlationId:randomUUID(),now,
    });
    if(result.outcome==="completed"){
      const submissionUrl=this.options.clientPortalOrigin
        ?`${this.options.clientPortalOrigin.replace(/\/$/,"")}/submit#access=${encodeURIComponent(invitationToken)}`:null;
      return void sendJson(response,201,{...result,invitationToken,submissionUrl,
        warning:"完整链接只显示一次；仅允许完全虚构资料，不得转发给真实客户。"});
    }
    return void sendDemoFormResult(response,result);
  }

  private async publishClientPortalQuestion(request:IncomingMessage,response:ServerResponse):Promise<void>{
    opsHeaders(response);const session=await this.demoFormMutationSession(request,response);
    if(!session||!this.options.demoFormRepository)return;
    let body:unknown;try{body=await readJsonBody(request,16_384);}catch{return void sendJson(response,400,{error:"invalid_json"});}
    if(!isPlainObject(body))return void sendJson(response,400,{error:"invalid_client_question"});
    const caseId=typeof body.caseId==="string"?body.caseId:"";const issueId=typeof body.issueId==="string"?body.issueId:"";
    const publicTitle=typeof body.publicTitle==="string"?body.publicTitle.trim():"";
    const publicBody=typeof body.publicBody==="string"?body.publicBody.trim():"";
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if(!isUuid(caseId)||!isUuid(issueId)||publicTitle.length<3||publicTitle.length>160
      ||publicBody.length<12||publicBody.length>2000||reason.length<12||reason.length>1000||!isUuid(idempotencyKey)){
      return void sendJson(response,400,{error:"invalid_client_question"});
    }
    return void sendDemoFormResult(response,await this.options.demoFormRepository.publishClientQuestion(
      this.options.organizationKey,{actorId:session.actorId,caseId,issueId,publicTitle,publicBody,reason,
        idempotencyKey,correlationId:randomUUID(),now:this.now()},
    ));
  }

  private async transitionClientPortalQuestion(request:IncomingMessage,response:ServerResponse,questionId:string):Promise<void>{
    opsHeaders(response);const session=await this.demoFormMutationSession(request,response);
    if(!session||!this.options.demoFormRepository)return;
    if(!isUuid(questionId))return void sendJson(response,400,{error:"invalid_identifier"});
    let body:unknown;try{body=await readJsonBody(request,8_192);}catch{return void sendJson(response,400,{error:"invalid_json"});}
    if(!isPlainObject(body))return void sendJson(response,400,{error:"invalid_client_question"});
    const action=body.action;const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if((action!=="resolve"&&action!=="withdraw")||reason.length<12||reason.length>1000||!isUuid(idempotencyKey)){
      return void sendJson(response,400,{error:"invalid_client_question"});
    }
    return void sendDemoFormResult(response,await this.options.demoFormRepository.transitionClientQuestion(
      this.options.organizationKey,{actorId:session.actorId,questionId,action,reason,idempotencyKey,
        correlationId:randomUUID(),now:this.now()},
    ));
  }

  private async revokeDemoFormInvitation(request:IncomingMessage,response:ServerResponse,invitationId:string):Promise<void>{
    opsHeaders(response);const session=await this.demoFormMutationSession(request,response);
    if(!session||!this.options.demoFormRepository)return;
    if(!isUuid(invitationId))return void sendJson(response,400,{error:"invalid_identifier"});
    let body:unknown;try{body=await readJsonBody(request,8_192);}catch{return void sendJson(response,400,{error:"invalid_json"});}
    if(!isPlainObject(body))return void sendJson(response,400,{error:"invalid_demo_invitation"});
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if(reason.length<12||reason.length>1000||!isUuid(idempotencyKey))return void sendJson(response,400,{error:"invalid_demo_invitation"});
    return void sendDemoFormResult(response,await this.options.demoFormRepository.revokeInvitation(this.options.organizationKey,{
      actorId:session.actorId,invitationId,reason,idempotencyKey,correlationId:randomUUID(),now:this.now(),
    }));
  }

  private async demoFormMutationSession(request:IncomingMessage,response:ServerResponse):Promise<OpsSession|null>{
    const session=await this.authorized(request);
    if(!session){sendJson(response,401,{error:"session_required"});return null;}
    if(!isConfigurationReader(session.actorType)){sendJson(response,403,{error:"manager_required"});return null;}
    if(!this.options.demoFormRepository){sendJson(response,503,{error:"demo_form_not_configured"});return null;}
    if(!this.mutationAuthorized(request,session)){sendJson(response,403,{error:"request_verification_failed"});return null;}
    return session;
  }

  private async createInvitation(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.accessMutationSession(request, response);
    if (!session || !this.options.accessRepository) return;
    const body = await readAccessBody(request, response);
    if (!body) return;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const actorType = body.actorType;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isEmail(email) || email.length > 254 || displayName.length < 2 || displayName.length > 120
      || !isAccessRole(actorType) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_access_request" });
    }
    const result = await this.options.accessRepository.createInvitation(this.options.organizationKey, {
      actorId: session.actorId, email, displayName, actorType, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendAccessResult(response, result);
  }

  private async cancelInvitation(request: IncomingMessage, response: ServerResponse, invitationId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.accessMutationSession(request, response);
    if (!session || !this.options.accessRepository) return;
    if (!isUuid(invitationId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readAccessBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_access_request" });
    }
    const result = await this.options.accessRepository.cancelInvitation(this.options.organizationKey, {
      actorId: session.actorId, invitationId, reason, idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendAccessResult(response, result);
  }

  private async changeActorAccess(request: IncomingMessage, response: ServerResponse, targetActorId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.accessMutationSession(request, response);
    if (!session || !this.options.accessRepository) return;
    if (!isUuid(targetActorId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readAccessBody(request, response);
    if (!body) return;
    const action = body.action;
    const actorType = body.actorType;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isAccessAction(action) || (action === "change_role" && !isAccessRole(actorType))
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_access_request" });
    }
    const result = await this.options.accessRepository.changeActorAccess(this.options.organizationKey, {
      actorId: session.actorId, targetActorId, action,
      ...(isAccessRole(actorType) ? { actorType } : {}), reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendAccessResult(response, result);
  }

  private async accessMutationSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.accessRepository) { sendJson(response, 503, { error: "access_management_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async getOnboarding(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (session.actorType !== "admin") return void sendJson(response, 403, { error: "admin_required" });
    if (!this.options.onboardingRepository) return void sendJson(response, 503, { error: "onboarding_not_configured" });
    const snapshot = await this.options.onboardingRepository.getOnboarding(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async onboardSubject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.onboardingMutationSession(request, response);
    if (!session || !this.options.onboardingRepository) return;
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const packageVersionId = typeof body.packageVersionId === "string" ? body.packageVersionId : "";
    const subjectKey = typeof body.subjectKey === "string" ? body.subjectKey.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const subjectType = typeof body.subjectType === "string" ? body.subjectType.trim() : "";
    const primaryContactActorId = body.primaryContactActorId === null || body.primaryContactActorId === ""
      ? null : typeof body.primaryContactActorId === "string" ? body.primaryContactActorId : "invalid";
    const attributes = isPlainObject(body.attributes) ? body.attributes : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(packageVersionId) || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(subjectKey)
      || displayName.length < 2 || displayName.length > 160
      || subjectType.length < 2 || subjectType.length > 80
      || (primaryContactActorId !== null && !isUuid(primaryContactActorId)) || !attributes
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_onboarding_request" });
    }
    const result = await this.options.onboardingRepository.onboardSubject(this.options.organizationKey, {
      actorId: session.actorId, packageVersionId, subjectKey, displayName, subjectType,
      primaryContactActorId, attributes, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendConfigurationResult(response, result);
  }

  private async onboardingMutationSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.onboardingRepository) { sendJson(response, 503, { error: "onboarding_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async getWorkPackages(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.workPackageRepository) return void sendJson(response, 503, { error: "work_package_not_configured" });
    const snapshot = await this.options.workPackageRepository.getWorkPackages(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async createWorkPackage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const packageKey = typeof body.packageKey === "string" ? body.packageKey.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const industryPackage = typeof body.industryPackage === "string" && body.industryPackage.trim()
      ? body.industryPackage.trim().toLowerCase() : null;
    const workflowTemplateId = typeof body.workflowTemplateId === "string" ? body.workflowTemplateId : "";
    const blueprint = isWorkPackageBlueprint(body.blueprint) ? body.blueprint : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(packageKey)
      || displayName.length < 2 || displayName.length > 160
      || description.length < 12 || description.length > 1_000
      || (industryPackage?.length ?? 0) > 120 || !isUuid(workflowTemplateId) || !blueprint
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_request" });
    }
    const result = await this.options.workPackageRepository.createPackage(this.options.organizationKey, {
      actorId: session.actorId, packageKey, displayName, description, industryPackage,
      workflowTemplateId, blueprint, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async updateWorkPackage(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const industryPackage = typeof body.industryPackage === "string" && body.industryPackage.trim()
      ? body.industryPackage.trim().toLowerCase() : null;
    const workflowTemplateId = typeof body.workflowTemplateId === "string" ? body.workflowTemplateId : "";
    const blueprint = isWorkPackageBlueprint(body.blueprint) ? body.blueprint : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (displayName.length < 2 || displayName.length > 160
      || description.length < 12 || description.length > 1_000
      || (industryPackage?.length ?? 0) > 120 || !isUuid(workflowTemplateId) || !blueprint
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_request" });
    }
    const result = await this.options.workPackageRepository.updateDraft(this.options.organizationKey, {
      actorId: session.actorId, versionId, displayName, description, industryPackage,
      workflowTemplateId, blueprint, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async cloneWorkPackage(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_request" });
    }
    const result = await this.options.workPackageRepository.cloneVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async runWorkPackageDryRun(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const sample = isSyntheticWorkPackageSample(body.syntheticSample) ? body.syntheticSample : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!sample || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_dry_run" });
    }
    const result = await this.options.workPackageRepository.runDryRun(this.options.organizationKey, {
      actorId: session.actorId, versionId, syntheticSample: sample, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async transitionWorkPackage(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isWorkPackageAction(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_request" });
    }
    const result = await this.options.workPackageRepository.transitionVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async retireWorkPackage(request: IncomingMessage, response: ServerResponse, packageId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.workPackageAdminSession(request, response);
    if (!session || !this.options.workPackageRepository) return;
    if (!isUuid(packageId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_work_package_request" });
    }
    const result = await this.options.workPackageRepository.retirePackage(this.options.organizationKey, {
      actorId: session.actorId, packageId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendWorkPackageResult(response, result);
  }

  private async workPackageAdminSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.workPackageRepository) { sendJson(response, 503, { error: "work_package_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async getClassificationProfile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.classificationProfileRepository) {
      return void sendJson(response, 503, { error: "classification_profile_not_configured" });
    }
    const snapshot = await this.options.classificationProfileRepository.getProfile(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async cloneClassificationProfile(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classificationProfileAdminSession(request, response);
    if (!session || !this.options.classificationProfileRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classification_profile_request" });
    }
    const result = await this.options.classificationProfileRepository.cloneVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassificationProfileResult(response, result);
  }

  private async updateClassificationProfile(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classificationProfileAdminSession(request, response);
    if (!session || !this.options.classificationProfileRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const definition = isClassificationProfileDefinition(body.definition) ? body.definition : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!definition || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classification_profile_request" });
    }
    const result = await this.options.classificationProfileRepository.updateDraft(this.options.organizationKey, {
      actorId: session.actorId, versionId, definition, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassificationProfileResult(response, result);
  }

  private async runClassificationProfileEvaluation(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classificationProfileAdminSession(request, response);
    if (!session || !this.options.classificationProfileRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classification_profile_evaluation" });
    }
    const result = await this.options.classificationProfileRepository.runEvaluation(this.options.organizationKey, {
      actorId: session.actorId, versionId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassificationProfileResult(response, result);
  }

  private async transitionClassificationProfile(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classificationProfileAdminSession(request, response);
    if (!session || !this.options.classificationProfileRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isConfigurationAction(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classification_profile_request" });
    }
    const result = await this.options.classificationProfileRepository.transitionVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassificationProfileResult(response, result);
  }

  private async classificationProfileAdminSession(
    request: IncomingMessage, response: ServerResponse,
  ): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.classificationProfileRepository) {
      sendJson(response, 503, { error: "classification_profile_not_configured" }); return null;
    }
    if (!this.mutationAuthorized(request, session)) {
      sendJson(response, 403, { error: "request_verification_failed" }); return null;
    }
    return session;
  }

  private async getClassifierReleases(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.classifierReleaseRepository) {
      return void sendJson(response, 503, { error: "classifier_release_not_configured" });
    }
    const snapshot = await this.options.classifierReleaseRepository.getReleases(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async cloneClassifierRelease(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classifierReleaseAdminSession(request, response);
    if (!session || !this.options.classifierReleaseRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classifier_release_request" });
    }
    const result = await this.options.classifierReleaseRepository.cloneVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, reason, idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassifierReleaseResult(response, result);
  }

  private async updateClassifierRelease(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classifierReleaseAdminSession(request, response);
    if (!session || !this.options.classifierReleaseRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const definition = isClassifierReleaseDefinition(body.definition) ? body.definition : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!definition || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classifier_release_request" });
    }
    const result = await this.options.classifierReleaseRepository.updateDraft(this.options.organizationKey, {
      actorId: session.actorId, versionId, definition, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassifierReleaseResult(response, result);
  }

  private async requestClassifierReleaseEvaluation(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classifierReleaseAdminSession(request, response);
    if (!session || !this.options.classifierReleaseRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const evaluationKind = body.evaluationKind;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if ((evaluationKind !== "compatibility" && evaluationKind !== "provider")
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classifier_release_evaluation" });
    }
    const result = await this.options.classifierReleaseRepository.requestEvaluation(this.options.organizationKey, {
      actorId: session.actorId, versionId, evaluationKind, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassifierReleaseResult(response, result);
  }

  private async transitionClassifierRelease(
    request: IncomingMessage, response: ServerResponse, versionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.classifierReleaseAdminSession(request, response);
    if (!session || !this.options.classifierReleaseRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isConfigurationAction(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_classifier_release_request" });
    }
    const result = await this.options.classifierReleaseRepository.transitionVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendClassifierReleaseResult(response, result);
  }

  private async classifierReleaseAdminSession(
    request: IncomingMessage, response: ServerResponse,
  ): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.classifierReleaseRepository) {
      sendJson(response, 503, { error: "classifier_release_not_configured" }); return null;
    }
    if (!this.mutationAuthorized(request, session)) {
      sendJson(response, 403, { error: "request_verification_failed" }); return null;
    }
    return session;
  }

  private async getSourceConnectors(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.sourceConnectorRepository) return void sendJson(response, 503, { error: "source_connector_not_configured" });
    const snapshot = await this.options.sourceConnectorRepository.getConnectors(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async createSourceConnector(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.sourceConnectorAdminSession(request, response);
    if (!session || !this.options.sourceConnectorRepository) return;
    const body = await readConfigurationBody(request, response); if (!body) return;
    const connectorKey = typeof body.connectorKey === "string" ? body.connectorKey.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const definition = isSourceConnectorDefinition(body.definition) ? body.definition : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!definition || !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(connectorKey)
      || displayName.length < 2 || displayName.length > 160 || description.length < 12 || description.length > 1_000
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_source_connector_request" });
    }
    const result = await this.options.sourceConnectorRepository.createConnector(this.options.organizationKey, {
      actorId:session.actorId,connectorKey,displayName,description,definition,reason,idempotencyKey,
      correlationId:randomUUID(),now:this.now(),
    });
    return void sendSourceConnectorResult(response,result);
  }

  private async updateSourceConnector(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.sourceConnectorAdminSession(request,response);
    if (!session || !this.options.sourceConnectorRepository) return;
    if (!isUuid(versionId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const definition=isSourceConnectorDefinition(body.definition)?body.definition:null;
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if (!definition || reason.length<12 || reason.length>1_000 || !isUuid(idempotencyKey))
      return void sendJson(response,400,{error:"invalid_source_connector_request"});
    const result=await this.options.sourceConnectorRepository.updateDraft(this.options.organizationKey,{
      actorId:session.actorId,versionId,definition,reason,idempotencyKey,correlationId:randomUUID(),now:this.now(),
    });
    return void sendSourceConnectorResult(response,result);
  }

  private async runSourceConnectorTest(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session=await this.sourceConnectorAdminSession(request,response);
    if (!session || !this.options.sourceConnectorRepository) return;
    if (!isUuid(versionId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if (reason.length<12 || reason.length>1_000 || !isUuid(idempotencyKey))
      return void sendJson(response,400,{error:"invalid_source_connector_test"});
    const result=await this.options.sourceConnectorRepository.runTest(this.options.organizationKey,{
      actorId:session.actorId,versionId,reason,idempotencyKey,correlationId:randomUUID(),now:this.now(),
    });
    return void sendSourceConnectorResult(response,result);
  }

  private async transitionSourceConnector(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session=await this.sourceConnectorAdminSession(request,response);
    if (!session || !this.options.sourceConnectorRepository) return;
    if (!isUuid(versionId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const action=body.action;
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if (!isSourceConnectorAction(action) || reason.length<12 || reason.length>1_000 || !isUuid(idempotencyKey))
      return void sendJson(response,400,{error:"invalid_source_connector_request"});
    const result=await this.options.sourceConnectorRepository.transitionVersion(this.options.organizationKey,{
      actorId:session.actorId,versionId,action,reason,idempotencyKey,correlationId:randomUUID(),now:this.now(),
    });
    return void sendSourceConnectorResult(response,result);
  }

  private async sourceConnectorAdminSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession|null> {
    const session=await this.authorized(request);
    if (!session) { sendJson(response,401,{error:"session_required"}); return null; }
    if (session.actorType!=="admin") { sendJson(response,403,{error:"admin_required"}); return null; }
    if (!this.options.sourceConnectorRepository) { sendJson(response,503,{error:"source_connector_not_configured"}); return null; }
    if (!this.mutationAuthorized(request,session)) { sendJson(response,403,{error:"request_verification_failed"}); return null; }
    return session;
  }

  private async getReleaseReadiness(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) {
      return void sendJson(response, 403, { error: "manager_required" });
    }
    if (!this.options.releaseReadinessRepository) {
      return void sendJson(response, 503, { error: "release_readiness_not_configured" });
    }
    const snapshot = await this.options.releaseReadinessRepository.getSnapshot(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async createReleaseManifest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.releaseReadinessMutationSession(request, response, true);
    if (!session || !this.options.releaseReadinessRepository) return;
    const body = await readConfigurationBody(request, response); if (!body) return;
    const manifestKey = typeof body.manifestKey === "string" ? body.manifestKey.trim() : "";
    const declarations = isReleaseReadinessDeclarations(body.declarations) ? body.declarations : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(manifestKey) || !declarations
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_release_manifest_request" });
    }
    const result = await this.options.releaseReadinessRepository.createManifest(this.options.organizationKey, {
      actorId: session.actorId, manifestKey, declarations, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendReleaseReadinessResult(response, result);
  }

  private async evaluateReleaseManifest(
    request: IncomingMessage, response: ServerResponse, manifestId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.releaseReadinessMutationSession(request, response, false);
    if (!session || !this.options.releaseReadinessRepository) return;
    if (!isUuid(manifestId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response); if (!body) return;
    const parsed = releaseMutationInput(body);
    if (!parsed) return void sendJson(response, 400, { error: "invalid_release_readiness_evaluation" });
    const result = await this.options.releaseReadinessRepository.evaluateManifest(this.options.organizationKey, {
      actorId: session.actorId, manifestId, ...parsed, correlationId: randomUUID(), now: this.now(),
    });
    return void sendReleaseReadinessResult(response, result);
  }

  private async submitReleaseManifest(
    request: IncomingMessage, response: ServerResponse, manifestId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.releaseReadinessMutationSession(request, response, true);
    if (!session || !this.options.releaseReadinessRepository) return;
    if (!isUuid(manifestId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response); if (!body) return;
    const parsed = releaseMutationInput(body);
    if (!parsed) return void sendJson(response, 400, { error: "invalid_release_manifest_submission" });
    const result = await this.options.releaseReadinessRepository.submitManifest(this.options.organizationKey, {
      actorId: session.actorId, manifestId, ...parsed, correlationId: randomUUID(), now: this.now(),
    });
    return void sendReleaseReadinessResult(response, result);
  }

  private async decideReleaseManifest(
    request: IncomingMessage, response: ServerResponse, manifestId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.releaseReadinessMutationSession(request, response, false);
    if (!session || !this.options.releaseReadinessRepository) return;
    if (!isUuid(manifestId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response); if (!body) return;
    const parsed = releaseMutationInput(body);
    const action = body.action;
    if (!parsed || (action !== "approve" && action !== "reject")) {
      return void sendJson(response, 400, { error: "invalid_release_approval_decision" });
    }
    const result = await this.options.releaseReadinessRepository.decideManifest(this.options.organizationKey, {
      actorId: session.actorId, manifestId, action, ...parsed, correlationId: randomUUID(), now: this.now(),
    });
    return void sendReleaseReadinessResult(response, result);
  }

  private async releaseReadinessMutationSession(
    request: IncomingMessage, response: ServerResponse, requireAdmin: boolean,
  ): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!isConfigurationReader(session.actorType)) {
      sendJson(response, 403, { error: "manager_required" }); return null;
    }
    if (requireAdmin && session.actorType !== "admin") {
      sendJson(response, 403, { error: "admin_required" }); return null;
    }
    if (!this.options.releaseReadinessRepository) {
      sendJson(response, 503, { error: "release_readiness_not_configured" }); return null;
    }
    if (!this.mutationAuthorized(request, session)) {
      sendJson(response, 403, { error: "request_verification_failed" }); return null;
    }
    return session;
  }

  private async getUatBlueprints(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.uatBlueprintRepository) return void sendJson(response, 503, { error: "uat_blueprint_not_configured" });
    const snapshot = await this.options.uatBlueprintRepository.getSnapshot(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async createUatBlueprint(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.uatBlueprintMutationSession(request, response, true);
    if (!session || !this.options.uatBlueprintRepository) return;
    const body = await readConfigurationBody(request, response); if (!body) return;
    const blueprintKey = typeof body.blueprintKey === "string" ? body.blueprintKey.trim().toLowerCase() : "";
    const releaseManifestId = body.releaseManifestId === null ? null
      : typeof body.releaseManifestId === "string" && isUuid(body.releaseManifestId) ? body.releaseManifestId : undefined;
    const rawDefinition=isPlainObject(body.definition) ? structuredClone(body.definition) : null;
    if (rawDefinition && isPlainObject(rawDefinition.decisions) && isPlainObject(rawDefinition.decisions.runtimeOwner)) {
      rawDefinition.decisions.runtimeOwner.actorId=session.actorId;
    }
    const definition = isUatEnvironmentBlueprintDefinition(rawDefinition) ? rawDefinition : null;
    const parsed = releaseMutationInput(body);
    if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(blueprintKey) || releaseManifestId === undefined || !definition || !parsed) {
      return void sendJson(response, 400, { error: "invalid_uat_blueprint_request" });
    }
    const result = await this.options.uatBlueprintRepository.createBlueprint(this.options.organizationKey, {
      actorId:session.actorId,blueprintKey,releaseManifestId,definition,...parsed,
      correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async runUatBlueprintDryRun(
    request: IncomingMessage, response: ServerResponse, blueprintId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.uatBlueprintMutationSession(request, response, false);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(blueprintId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body = await readConfigurationBody(request,response); if (!body) return;
    const parsed = releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_blueprint_dry_run"});
    const result = await this.options.uatBlueprintRepository.runDryRun(this.options.organizationKey,{
      actorId:session.actorId,blueprintId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async compileUatProvisioningPackage(
    request: IncomingMessage, response: ServerResponse, blueprintId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.uatBlueprintMutationSession(request, response, true);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(blueprintId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_provisioning_package_request"});
    const result=await this.options.uatBlueprintRepository.compileProvisioningPackage(this.options.organizationKey,{
      actorId:session.actorId,blueprintId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async runUatProvisioningPackageDryRun(
    request: IncomingMessage, response: ServerResponse, packageId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.uatBlueprintMutationSession(request, response, false);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(packageId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_provisioning_package_dry_run"});
    const result=await this.options.uatBlueprintRepository.runProvisioningPackageDryRun(this.options.organizationKey,{
      actorId:session.actorId,packageId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async compileUatActivationApprovalPack(request:IncomingMessage,response:ServerResponse,packageId:string):Promise<void> {
    opsHeaders(response);
    const session=await this.uatBlueprintMutationSession(request,response,true);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(packageId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_activation_approval_pack_request"});
    const result=await this.options.uatBlueprintRepository.compileActivationApprovalPack(this.options.organizationKey,{
      actorId:session.actorId,packageId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async recordUatActivationDecision(request:IncomingMessage,response:ServerResponse,approvalPackId:string):Promise<void> {
    opsHeaders(response);
    const session=await this.uatBlueprintMutationSession(request,response,true);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(approvalPackId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const mutation=releaseMutationInput(body); const decision=uatActivationDecisionInput(body);
    if (!mutation || !decision) return void sendJson(response,400,{error:"invalid_uat_activation_decision_request"});
    const result=await this.options.uatBlueprintRepository.recordActivationDecision(this.options.organizationKey,{
      actorId:session.actorId,approvalPackId,...decision,...mutation,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async evaluateUatActivationApprovalPack(request:IncomingMessage,response:ServerResponse,approvalPackId:string):Promise<void> {
    opsHeaders(response);
    const session=await this.uatBlueprintMutationSession(request,response,false);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(approvalPackId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_activation_evaluation_request"});
    const result=await this.options.uatBlueprintRepository.evaluateActivationApprovalPack(this.options.organizationKey,{
      actorId:session.actorId,approvalPackId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async compileUatFinalAuthorizationRequest(request:IncomingMessage,response:ServerResponse,approvalPackId:string):Promise<void> {
    opsHeaders(response);
    const session=await this.uatBlueprintMutationSession(request,response,true);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(approvalPackId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_final_authorization_request"});
    const result=await this.options.uatBlueprintRepository.compileFinalAuthorizationRequest(this.options.organizationKey,{
      actorId:session.actorId,approvalPackId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async evaluateUatFinalAuthorizationRequest(request:IncomingMessage,response:ServerResponse,requestId:string):Promise<void> {
    opsHeaders(response);
    const session=await this.uatBlueprintMutationSession(request,response,false);
    if (!session || !this.options.uatBlueprintRepository) return;
    if (!isUuid(requestId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body) return;
    const parsed=releaseMutationInput(body);
    if (!parsed) return void sendJson(response,400,{error:"invalid_uat_final_authorization_evaluation"});
    const result=await this.options.uatBlueprintRepository.evaluateFinalAuthorizationRequest(this.options.organizationKey,{
      actorId:session.actorId,requestId,...parsed,correlationId:randomUUID(),now:this.now(),
    });
    return void sendUatBlueprintResult(response,result);
  }

  private async uatBlueprintMutationSession(
    request: IncomingMessage,response: ServerResponse,requireAdmin: boolean,
  ): Promise<OpsSession|null> {
    const session=await this.authorized(request);
    if (!session) { sendJson(response,401,{error:"session_required"}); return null; }
    if (!isConfigurationReader(session.actorType)) { sendJson(response,403,{error:"manager_required"}); return null; }
    if (requireAdmin && session.actorType!=="admin") { sendJson(response,403,{error:"admin_required"}); return null; }
    if (!this.options.uatBlueprintRepository) { sendJson(response,503,{error:"uat_blueprint_not_configured"}); return null; }
    if (!this.mutationAuthorized(request,session)) { sendJson(response,403,{error:"request_verification_failed"}); return null; }
    return session;
  }

  private async getConfigurations(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.configurationRepository) return void sendJson(response, 503, { error: "configuration_management_not_configured" });
    const snapshot = await this.options.configurationRepository.getConfigurations(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async cloneConfiguration(request: IncomingMessage, response: ServerResponse, releaseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.configurationMutationSession(request, response);
    if (!session || !this.options.configurationRepository) return;
    if (!isUuid(releaseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_configuration_request" });
    }
    const result = await this.options.configurationRepository.cloneRelease(this.options.organizationKey, {
      actorId: session.actorId, releaseId, reason, idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendConfigurationResult(response, result);
  }

  private async updateConfigurationDraft(request: IncomingMessage, response: ServerResponse, releaseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.configurationMutationSession(request, response);
    if (!session || !this.options.configurationRepository) return;
    if (!isUuid(releaseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isWorkConfigurationManifest(body.manifest) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_configuration_request" });
    }
    const result = await this.options.configurationRepository.updateDraft(this.options.organizationKey, {
      actorId: session.actorId, releaseId, manifest: body.manifest, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendConfigurationResult(response, result);
  }

  private async transitionConfiguration(request: IncomingMessage, response: ServerResponse, releaseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.configurationMutationSession(request, response);
    if (!session || !this.options.configurationRepository) return;
    if (!isUuid(releaseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isConfigurationAction(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_configuration_request" });
    }
    const result = await this.options.configurationRepository.transitionRelease(this.options.organizationKey, {
      actorId: session.actorId, releaseId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendConfigurationResult(response, result);
  }

  private async configurationMutationSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.configurationRepository) { sendJson(response, 503, { error: "configuration_management_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async createConfigurationCase(request: IncomingMessage, response: ServerResponse, releaseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.caseCreationSession(request, response);
    if (!session || !this.options.onboardingRepository) return;
    if (!isUuid(releaseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const periodKey = typeof body.periodKey === "string" ? body.periodKey.trim() : "";
    const periodStart = typeof body.periodStart === "string" ? body.periodStart : "";
    const periodEnd = typeof body.periodEnd === "string" ? body.periodEnd : "";
    const dueAt = typeof body.dueAt === "string" ? new Date(body.dueAt) : new Date(Number.NaN);
    const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
    const externalReference = typeof body.externalReference === "string" && body.externalReference.trim()
      ? body.externalReference.trim() : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(periodKey)
      || !isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodEnd < periodStart
      || Number.isNaN(dueAt.getTime()) || timezone.length < 3 || timezone.length > 80
      || (externalReference?.length ?? 0) > 200
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_creation_request" });
    }
    const result = await this.options.onboardingRepository.createCase(this.options.organizationKey, {
      actorId: session.actorId, releaseId, periodKey, periodStart, periodEnd,
      dueAt, timezone, externalReference, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendConfigurationResult(response, result);
  }

  private async caseCreationSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!isConfigurationReader(session.actorType)) { sendJson(response, 403, { error: "manager_required" }); return null; }
    if (!this.options.onboardingRepository) { sendJson(response, 503, { error: "onboarding_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async getCasePlans(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.options.casePlanRepository) return void sendJson(response, 503, { error: "case_plan_not_configured" });
    const snapshot = await this.options.casePlanRepository.getCasePlans(
      this.options.organizationKey, session.actorId, this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async createCasePlan(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanAdminSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const subjectId = typeof body.subjectId === "string" ? body.subjectId : "";
    const planKey = typeof body.planKey === "string" ? body.planKey.trim().toLowerCase() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const definition = isCasePlanDefinition(body.definition) ? body.definition : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(subjectId) || !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(planKey)
      || displayName.length < 2 || displayName.length > 160 || !definition
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_request" });
    }
    const result = await this.options.casePlanRepository.createPlan(this.options.organizationKey, {
      actorId: session.actorId, subjectId, planKey, displayName, definition, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async cloneCasePlan(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanAdminSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_request" });
    }
    const result = await this.options.casePlanRepository.cloneVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async updateCasePlan(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanAdminSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const definition = isCasePlanDefinition(body.definition) ? body.definition : null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!definition || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_request" });
    }
    const result = await this.options.casePlanRepository.updateDraft(this.options.organizationKey, {
      actorId: session.actorId, versionId, definition, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async transitionCasePlan(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanAdminSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isConfigurationAction(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_request" });
    }
    const result = await this.options.casePlanRepository.transitionVersion(this.options.organizationKey, {
      actorId: session.actorId, versionId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async previewCasePlan(request: IncomingMessage, response: ServerResponse, versionId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanApprovalSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    if (!isUuid(versionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const candidateCount = body.candidateCount;
    const startOn = body.startOn === null || body.startOn === "" ? null
      : typeof body.startOn === "string" ? body.startOn : "invalid";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!Number.isInteger(candidateCount) || Number(candidateCount) < 1 || Number(candidateCount) > 12
      || (startOn !== null && !isIsoDate(startOn))
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_preview_request" });
    }
    const result = await this.options.casePlanRepository.previewPlan(this.options.organizationKey, {
      actorId: session.actorId, versionId, candidateCount: Number(candidateCount), startOn,
      reason, idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async approveCasePlanPreview(request: IncomingMessage, response: ServerResponse, previewId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.casePlanApprovalSession(request, response);
    if (!session || !this.options.casePlanRepository) return;
    if (!isUuid(previewId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_case_plan_approval_request" });
    }
    const result = await this.options.casePlanRepository.approvePreview(this.options.organizationKey, {
      actorId: session.actorId, previewId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendCasePlanResult(response, result);
  }

  private async casePlanAdminSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (session.actorType !== "admin") { sendJson(response, 403, { error: "admin_required" }); return null; }
    if (!this.options.casePlanRepository) { sendJson(response, 503, { error: "case_plan_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async casePlanApprovalSession(request: IncomingMessage, response: ServerResponse): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!isConfigurationReader(session.actorType)) { sendJson(response, 403, { error: "manager_required" }); return null; }
    if (!this.options.casePlanRepository) { sendJson(response, 503, { error: "case_plan_not_configured" }); return null; }
    if (!this.mutationAuthorized(request, session)) { sendJson(response, 403, { error: "request_verification_failed" }); return null; }
    return session;
  }

  private async resolveReview(request: IncomingMessage, response: ServerResponse, documentId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!sameOrigin(request, this.secureCookie)) return void sendJson(response, 403, { error: "same_origin_required" });
    const suppliedCsrf = firstHeader(request.headers["x-dop-csrf"]);
    const expectedCsrf = csrfToken(session.cookieValue, this.options.sessionSecret);
    if (!suppliedCsrf || !safeEqual(suppliedCsrf, expectedCsrf)) return void sendJson(response, 403, { error: "csrf_token_invalid" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, 16_384);
    } catch (error) {
      const payloadTooLarge = error instanceof Error && error.message === "request_body_too_large";
      return void sendJson(response, payloadTooLarge ? 413 : 400, {
        error: payloadTooLarge ? "request_body_too_large" : "invalid_json",
      });
    }
    if (typeof body !== "object" || body === null) return void sendJson(response, 400, { error: "invalid_review_request" });
    const candidate = body as Record<string, unknown>;
    try {
      const result = await this.options.reviewHandler.execute({
        organizationKey: this.options.organizationKey,
        documentId,
        actorId: session.actorId,
        action: candidate.action as "confirm" | "reclassify" | "request_information" | "exclude" | "reopen",
        ...(typeof candidate.exclusionReason === "string" ? {
          exclusionReason: candidate.exclusionReason as "wrong_subject" | "wrong_period" | "irrelevant_or_unknown",
        } : {}),
        ...(typeof candidate.documentTypeCode === "string" ? { documentTypeCode: candidate.documentTypeCode } : {}),
        rationale: typeof candidate.rationale === "string" ? candidate.rationale : "",
        idempotencyKey: typeof candidate.idempotencyKey === "string" ? candidate.idempotencyKey : "",
        correlationId: randomUUID(),
        now: this.now(),
      });
      if (result.outcome === "not_found") return void sendJson(response, 404, result);
      if (result.outcome === "conflict") return void sendJson(response, 409, result);
      return void sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof DocumentReviewInputError) return void sendJson(response, 400, { error: error.code });
      throw error;
    }
  }

  // Also used by the loopback-only local entry point; keeps the same session,
  // CSRF, case visibility, byte validation and idempotent database path.
  async uploadDocument(request: IncomingMessage, response: ServerResponse, caseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (!isUuid(caseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (!this.options.trialRepository || !this.options.uploadBroker) {
      return void sendJson(response, 503, { error: "document_upload_not_configured" });
    }
    const caseDetail = await this.options.repository.getCaseDetail(
      this.options.organizationKey, caseId, this.now(), session.actorId,
    );
    if (!caseDetail) return void sendJson(response, 404, { outcome: "not_found", reason: "case_not_found" });
    if (["completed", "cancelled"].includes(caseDetail.case.status)) {
      return void sendJson(response, 409, { outcome: "conflict", reason: "case_closed" });
    }
    const declaredMimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const encodedFilename = firstHeader(request.headers["x-dop-filename"]);
    let filename = "";
    try { filename = decodeURIComponent(encodedFilename ?? ""); } catch { /* invalid below */ }
    if (!isUploadMimeType(declaredMimeType) || !validUploadFilename(filename)) {
      return void sendJson(response, 400, { error: "invalid_upload_metadata" });
    }
    let content: Buffer;
    try { content = await readBinaryBody(request, 20 * 1024 * 1024); }
    catch (error) {
      const tooLarge = error instanceof Error && error.message === "request_body_too_large";
      return void sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? "document_too_large" : "invalid_upload" });
    }
    if (content.length === 0) return void sendJson(response, 400, { error: "empty_document" });
    const detectedMimeType = detectUploadMime(content);
    if (detectedMimeType !== declaredMimeType) return void sendJson(response, 422, { error: "file_signature_mismatch" });
    const sha256 = createHash("sha256").update(content).digest("hex");
    const idempotencyKey = `ops-upload|${caseId}|${sha256}`;
    const documentId = deterministicUuid(`document|${idempotencyKey}`);
    const submissionId = deterministicUuid(`submission|${idempotencyKey}`);
    let storageReference: string;
    try {
      storageReference = (await this.options.uploadBroker.store({
        organizationKey: this.options.organizationKey,
        documentId,
        filename,
        mimeType: detectedMimeType,
        content,
        sha256,
      })).storageReference;
    } catch {
      return void sendJson(response, 503, { error: "document_storage_unavailable" });
    }
    const result = await this.options.trialRepository.acceptStoredUpload(this.options.organizationKey, {
      caseId, documentId, submissionId, actorId: session.actorId, filename,
      mimeType: detectedMimeType, sizeBytes: content.length, sha256, storageReference,
      idempotencyKey, now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, result.outcome === "duplicate" ? 200 : 201, result);
  }

  private async completeCase(request: IncomingMessage, response: ServerResponse, caseId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!isConfigurationReader(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (!isUuid(caseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (!this.options.trialRepository) return void sendJson(response, 503, { error: "case_completion_not_configured" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readJsonBody(request, 16_384); }
    catch { return void sendJson(response, 400, { error: "invalid_json" }); }
    if (!isPlainObject(body)) return void sendJson(response, 400, { error: "invalid_completion_request" });
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const assignedActorId = typeof body.assignedActorId === "string" && body.assignedActorId ? body.assignedActorId : null;
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000) {
      return void sendJson(response, 400, { error: "invalid_completion_reason" });
    }
    if (!isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_completion_idempotency_key" });
    }
    if (assignedActorId !== null && !isUuid(assignedActorId)) {
      return void sendJson(response, 400, { error: "invalid_completion_assignee" });
    }
    let result;
    try {
      result = await this.options.trialRepository.completeCase(this.options.organizationKey, {
        caseId, actorId: session.actorId, assignedActorId, reason, idempotencyKey, now: this.now(),
      });
    } catch (error) {
      const details = error as { code?: unknown };
      console.error(JSON.stringify({
        event: "ops_case_completion_failed",
        caseId,
        errorCode: typeof details.code === "string" ? details.code : "unclassified",
      }));
      return void sendJson(response, 500, { error: "case_completion_failed" });
    }
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, 200, result);
  }

  private async createPreview(request: IncomingMessage, response: ServerResponse, documentId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (!isUuid(documentId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (!this.options.previewRepository || !this.options.previewBroker) {
      return void sendJson(response, 503, { error: "preview_not_configured" });
    }
    const reference = await this.options.previewRepository.getStorageReference(this.options.organizationKey, documentId);
    if (reference.outcome === "not_found") return void sendJson(response, 404, reference);
    if (reference.outcome === "not_ready") return void sendJson(response, 409, reference);
    try {
      const preview = await this.options.previewBroker.createPreview(reference.storageReference);
      return void sendJson(response, 200, preview);
    } catch {
      return void sendJson(response, 503, { error: "preview_unavailable" });
    }
  }

  private async transitionIssue(request: IncomingMessage, response: ServerResponse, issueId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.options.issueHandler) return void sendJson(response, 503, { error: "issue_transitions_not_configured" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readJsonBody(request, 16_384); }
    catch { return void sendJson(response, 400, { error: "invalid_json" }); }
    if (typeof body !== "object" || body === null) return void sendJson(response, 400, { error: "invalid_issue_transition" });
    const candidate = body as Record<string, unknown>;
    try {
      const result = await this.options.issueHandler.execute({
        organizationKey: this.options.organizationKey,
        issueId,
        actorId: session.actorId,
        action: candidate.action as "assign_to_me" | "wait_internal" | "wait_external" | "resolve" | "reopen" | "close",
        note: typeof candidate.note === "string" ? candidate.note : "",
        idempotencyKey: typeof candidate.idempotencyKey === "string" ? candidate.idempotencyKey : "",
        correlationId: randomUUID(),
        now: this.now(),
      });
      if (result.outcome === "not_found") return void sendJson(response, 404, result);
      if (result.outcome === "conflict") return void sendJson(response, 409, result);
      return void sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof IssueTransitionInputError) return void sendJson(response, 400, { error: error.code });
      throw error;
    }
  }

  private async getTasks(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.options.taskRepository) return void sendJson(response, 503, { error: "tasks_not_configured" });
    const snapshot = await this.options.taskRepository.getSnapshot(
      this.options.organizationKey,
      session.actorId,
      this.now(),
    );
    return void sendJson(response, 200, snapshot);
  }

  private async transitionTask(request: IncomingMessage, response: ServerResponse, taskId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.options.taskHandler) return void sendJson(response, 503, { error: "tasks_not_configured" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (!isUuid(taskId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readJsonBody(request, 16_384); }
    catch { return void sendJson(response, 400, { error: "invalid_json" }); }
    if (!isPlainObject(body)) return void sendJson(response, 400, { error: "invalid_task_transition" });
    const assignedActorId = typeof body.assignedActorId === "string" && body.assignedActorId ? body.assignedActorId : null;
    try {
      const result = await this.options.taskHandler.execute({
        organizationKey: this.options.organizationKey,
        taskId,
        actorId: session.actorId,
        action: body.action as TaskOperatorAction,
        assignedActorId,
        reason: typeof body.reason === "string" ? body.reason : "",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        correlationId: randomUUID(),
        now: this.now(),
      });
      if (result.outcome === "not_found") return void sendJson(response, 404, result);
      if (result.outcome === "conflict") return void sendJson(response, 409, result);
      return void sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof TaskTransitionInputError) return void sendJson(response, 400, { error: error.code });
      throw error;
    }
  }

  private async decideReminder(request: IncomingMessage, response: ServerResponse, reminderId: string): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.options.reminderRepository) return void sendJson(response, 503, { error: "reminders_not_configured" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (!["manager", "admin"].includes(session.actorType)) return void sendJson(response, 403, { error: "manager_required" });
    if (!isUuid(reminderId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readJsonBody(request, 16_384); }
    catch { return void sendJson(response, 400, { error: "invalid_json" }); }
    if (!isPlainObject(body)) return void sendJson(response, 400, { error: "invalid_reminder_decision" });
    const action = body.action as ReminderDecisionAction;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!['approve','reject'].includes(action) || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_reminder_decision" });
    }
    const result = await this.options.reminderRepository.decide(this.options.organizationKey, {
      actorId: session.actorId, reminderInstanceId: reminderId, action, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, 200, result);
  }

  private async getRetentionDashboard(request:IncomingMessage,response:ServerResponse):Promise<void> {
    opsHeaders(response); const session=await this.authorized(request);
    if (!session) return void sendJson(response,401,{error:"session_required"});
    if (!this.options.retentionRepository) return void sendJson(response,503,{error:"retention_not_configured"});
    if (!["manager","admin"].includes(session.actorType)) return void sendJson(response,403,{error:"manager_required"});
    return void sendJson(response,200,await this.options.retentionRepository.getDashboard(this.options.organizationKey));
  }

  private async confirmRetentionPolicy(request:IncomingMessage,response:ServerResponse):Promise<void> {
    const session=await this.retentionMutationSession(request,response,true); if (!session||!this.options.retentionRepository)return;
    const body=await readConfigurationBody(request,response); if (!body)return;
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if (body.retentionDays!==30||body.anchor!=="case_terminal_at"||!Array.isArray(body.holdApproverRoles)
      ||body.holdApproverRoles.join("|")!=="manager|admin"||!Number.isInteger(body.rpoHours)
      ||Number(body.rpoHours)<1||Number(body.rpoHours)>24||!Number.isInteger(body.rtoHours)
      ||Number(body.rtoHours)<1||Number(body.rtoHours)>24||reason.length<12||reason.length>1000||!isUuid(idempotencyKey))
      return void sendJson(response,400,{error:"invalid_retention_policy_confirmation"});
    const result=await this.options.retentionRepository.confirmPolicy(this.options.organizationKey,{
      actorId:session.actorId,retentionDays:30,anchor:"case_terminal_at",holdApproverRoles:["manager","admin"],
      rpoHours:Number(body.rpoHours),rtoHours:Number(body.rtoHours),reason,idempotencyKey,
      correlationId:randomUUID(),now:this.now(),
    }); return void sendRetentionResult(response,result);
  }

  private async planRetentionRun(request:IncomingMessage,response:ServerResponse):Promise<void> {
    const session=await this.retentionMutationSession(request,response,true); if (!session||!this.options.retentionRepository)return;
    const body=await readConfigurationBody(request,response); if (!body)return;
    const mode=body.mode; const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    if ((mode!=="dry_run"&&mode!=="apply")||reason.length<12||reason.length>1000||!isUuid(idempotencyKey))
      return void sendJson(response,400,{error:"invalid_retention_run_request"});
    const result=await this.options.retentionRepository.planRun(this.options.organizationKey,{actorId:session.actorId,
      mode,reason,idempotencyKey,correlationId:randomUUID(),now:this.now()});
    return void sendRetentionResult(response,result);
  }

  private async setCaseLegalHold(request:IncomingMessage,response:ServerResponse,caseId:string):Promise<void> {
    const session=await this.retentionMutationSession(request,response,false); if (!session||!this.options.retentionRepository)return;
    if (!isUuid(caseId)) return void sendJson(response,400,{error:"invalid_identifier"});
    const body=await readConfigurationBody(request,response); if (!body)return;
    const action=body.action; const reason=typeof body.reason==="string"?body.reason.trim():"";
    const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
    const reviewDueAt=typeof body.reviewDueAt==="string"?new Date(body.reviewDueAt):new Date(NaN);
    if ((action!=="place"&&action!=="release")||reason.length<12||reason.length>1000||!isUuid(idempotencyKey)
      ||!Number.isFinite(reviewDueAt.getTime())) return void sendJson(response,400,{error:"invalid_legal_hold_request"});
    const result=await this.options.retentionRepository.setLegalHold(this.options.organizationKey,{actorId:session.actorId,
      caseId,action,reason,reviewDueAt,idempotencyKey,correlationId:randomUUID(),now:this.now()});
    return void sendRetentionResult(response,result);
  }

  private async retentionMutationSession(request:IncomingMessage,response:ServerResponse,adminOnly:boolean):Promise<OpsSession|null> {
    opsHeaders(response); const session=await this.authorized(request);
    if (!session){sendJson(response,401,{error:"session_required"});return null;}
    if ((adminOnly&&session.actorType!=="admin")||(!adminOnly&&!["manager","admin"].includes(session.actorType))) {
      sendJson(response,403,{error:adminOnly?"admin_required":"manager_required"});return null;
    }
    if (!this.options.retentionRepository){sendJson(response,503,{error:"retention_not_configured"});return null;}
    if (!this.mutationAuthorized(request,session)){sendJson(response,403,{error:"request_verification_failed"});return null;}
    return session;
  }

  private async batchTransitionIssues(request: IncomingMessage, response: ServerResponse): Promise<void> {
    opsHeaders(response);
    const session = await this.authorized(request);
    if (!session) return void sendJson(response, 401, { error: "session_required" });
    if (!this.options.issueHandler) return void sendJson(response, 503, { error: "issue_transitions_not_configured" });
    if (!this.mutationAuthorized(request, session)) return void sendJson(response, 403, { error: "request_verification_failed" });
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return void sendJson(response, 415, { error: "content_type_must_be_application_json" });
    }
    let body: unknown;
    try { body = await readJsonBody(request, 32_768); }
    catch { return void sendJson(response, 400, { error: "invalid_json" }); }
    if (typeof body !== "object" || body === null) return void sendJson(response, 400, { error: "invalid_batch_transition" });
    const candidate = body as Record<string, unknown>;
    if (candidate.action !== "assign_to_me") return void sendJson(response, 400, { error: "batch_action_not_allowed" });
    if (!Array.isArray(candidate.issueIds) || candidate.issueIds.length < 1 || candidate.issueIds.length > 25) {
      return void sendJson(response, 400, { error: "invalid_batch_size" });
    }
    const issueIds = [...new Set(candidate.issueIds)];
    if (issueIds.length !== candidate.issueIds.length || !issueIds.every((value) => typeof value === "string" && isUuid(value))) {
      return void sendJson(response, 400, { error: "invalid_issue_ids" });
    }
    const idempotencyKey = typeof candidate.idempotencyKey === "string" ? candidate.idempotencyKey : "";
    if (!isUuid(idempotencyKey)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const note = typeof candidate.note === "string" ? candidate.note : "";
    const results = [];
    for (const issueId of issueIds as string[]) {
      try {
        results.push(await this.options.issueHandler.execute({
          organizationKey: this.options.organizationKey, issueId, actorId: session.actorId,
          action: "assign_to_me", note, idempotencyKey: derivedBatchKey(idempotencyKey, issueId),
          correlationId: randomUUID(), now: this.now(),
        }));
      } catch (error) {
        if (error instanceof IssueTransitionInputError) return void sendJson(response, 400, { error: error.code });
        throw error;
      }
    }
    const completedCount = results.filter((item) => item.outcome === "completed" || item.outcome === "duplicate").length;
    return void sendJson(response, 200, {
      outcome: completedCount === results.length ? "completed" : "partial",
      requestedCount: results.length, completedCount, results,
    });
  }

  private async createMissingRequestRevision(
    request: IncomingMessage,
    response: ServerResponse,
    requestDraftId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(requestDraftId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const recipientActorId = typeof body.recipientActorId === "string" ? body.recipientActorId : "";
    const subjectLine = typeof body.subjectLine === "string" ? body.subjectLine.trim() : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(recipientActorId) || subjectLine.length < 1 || subjectLine.length > 300
      || bodyText.length < 20 || bodyText.length > 10_000
      || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_missing_request_revision" });
    }
    const result = await this.options.missingRequestRepository.createRevision(this.options.organizationKey, {
      actorId: session.actorId, requestDraftId, recipientActorId, subjectLine, bodyText, reason,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    return void sendMissingRequestResult(response, result);
  }

  private async transitionMissingRequestRevision(
    request: IncomingMessage,
    response: ServerResponse,
    revisionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(revisionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const action = body.action;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isMissingRequestReviewAction(action) || reason.length < 12 || reason.length > 1_000
      || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_missing_request_transition" });
    }
    const result = await this.options.missingRequestRepository.transitionRevision(this.options.organizationKey, {
      actorId: session.actorId, revisionId, action, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendMissingRequestResult(response, result);
  }

  private async planMissingRequestDelivery(
    request: IncomingMessage,
    response: ServerResponse,
    revisionId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(revisionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_delivery_plan" });
    }
    const result = await this.options.missingRequestRepository.planDelivery(this.options.organizationKey, {
      actorId: session.actorId, revisionId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendMissingRequestResult(response, result);
  }

  private async runDeliveryContractEvaluation(
    request: IncomingMessage,
    response: ServerResponse,
    deliveryJobId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(deliveryJobId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_delivery_evaluation" });
    }
    const result = await this.options.missingRequestRepository.runDeliveryEvaluation(this.options.organizationKey, {
      actorId: session.actorId, deliveryJobId, reason, idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    return void sendMissingRequestResult(response, result);
  }

  private async authorizeSyntheticDelivery(
    request: IncomingMessage,
    response: ServerResponse,
    deliveryJobId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(deliveryJobId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const scenarios = ["success","rate_limited_once","server_error_once","timeout_unknown",
      "crash_after_claim","bounced","receipt_replay"] as const;
    const scenario = scenarios.find((value) => value === body.scenario);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!scenario || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_delivery_authorization" });
    }
    const result = await this.options.missingRequestRepository.authorizeSyntheticDelivery(
      this.options.organizationKey, { actorId: session.actorId, deliveryJobId, scenario, reason,
        idempotencyKey, correlationId: randomUUID(), now: this.now() },
    );
    return void sendMissingRequestResult(response, result);
  }

  private async reconcileUnknownDelivery(
    request: IncomingMessage,
    response: ServerResponse,
    deliveryJobId: string,
  ): Promise<void> {
    opsHeaders(response);
    const session = await this.missingRequestMutationSession(request, response);
    if (!session || !this.options.missingRequestRepository) return;
    if (!isUuid(deliveryJobId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readConfigurationBody(request, response);
    if (!body) return;
    const actions = ["proved_not_sent_retry","confirmed_sent","remain_unknown"] as const;
    const action = actions.find((value) => value === body.action);
    const providerMessageId = typeof body.providerMessageId === "string" ? body.providerMessageId.trim() : undefined;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!action || reason.length < 12 || reason.length > 1_000 || !isUuid(idempotencyKey)) {
      return void sendJson(response, 400, { error: "invalid_delivery_reconciliation" });
    }
    const result = await this.options.missingRequestRepository.reconcileUnknownDelivery(
      this.options.organizationKey, { actorId: session.actorId, deliveryJobId, action,
        ...(providerMessageId ? { providerMessageId } : {}), reason, idempotencyKey,
        correlationId: randomUUID(), now: this.now() },
    );
    return void sendMissingRequestResult(response, result);
  }

  private async missingRequestMutationSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<OpsSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!isConfigurationReader(session.actorType)) {
      sendJson(response, 403, { error: "manager_required" }); return null;
    }
    if (!this.options.missingRequestRepository) {
      sendJson(response, 503, { error: "missing_request_review_not_configured" }); return null;
    }
    if (!this.mutationAuthorized(request, session)) {
      sendJson(response, 403, { error: "request_verification_failed" }); return null;
    }
    return session;
  }

  private mutationAuthorized(request: IncomingMessage, session: OpsSession): boolean {
    if (!sameOrigin(request, this.secureCookie)) return false;
    const supplied = firstHeader(request.headers["x-dop-csrf"]);
    const expected = csrfToken(session.cookieValue, this.options.sessionSecret);
    return Boolean(supplied && safeEqual(supplied, expected));
  }

  private async rejectWorkbenchOnlySession(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    const isOpsPath = pathname === "/ops" || pathname === "/ops/" || pathname.startsWith("/ops/")
      || pathname.startsWith("/v1/ops/");
    const isSharedSessionMutation = pathname === "/v1/ops/session"
      && (request.method === "POST" || request.method === "DELETE");
    if (!isOpsPath || isSharedSessionMutation) return false;
    const session = await this.sessionAuthorizer.authorize(request.headers.cookie);
    if (!session || session.platformConsoleAccess) return false;
    opsHeaders(response);
    sendJson(response, 403, { error: "platform_console_required" });
    return true;
  }

  private async sendAsset(
    response: ServerResponse,
    filename: string,
    contentType: string,
    cacheable: boolean,
  ): Promise<true> {
    const content = await readFile(join(this.options.staticDirectory, filename));
    opsHeaders(response);
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", cacheable ? "private, max-age=0, must-revalidate" : "no-store");
    response.end(content);
    return true;
  }
}

function assetFor(pathname: string): { filename: string; contentType: string; cacheable: boolean } | null {
  if (pathname === "/ops/app.css") return { filename: "app.css", contentType: "text/css; charset=utf-8", cacheable: true };
  if (pathname === "/ops/app.js") return { filename: "app.js", contentType: "text/javascript; charset=utf-8", cacheable: true };
  if (pathname === "/ops/favicon.svg") return { filename: "favicon.svg", contentType: "image/svg+xml", cacheable: true };
  return null;
}

function opsHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

async function readJsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  return await new Promise((resolvePromise, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) {
        reject(new Error("request_body_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid_json")); }
    });
    request.on("error", reject);
  });
}

async function readBinaryBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) { reject(new Error("request_body_too_large")); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function isUploadMimeType(value: string): value is StoredOpsUpload["mimeType"] {
  return value === "application/pdf" || value === "image/jpeg" || value === "image/png";
}

function detectUploadMime(content: Buffer): StoredOpsUpload["mimeType"] | null {
  if (content.length >= 5 && content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  return null;
}

function validUploadFilename(value: string): boolean {
  return value.length >= 1 && value.length <= 180 && !/[\/\\\0\r\n]/.test(value);
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function derivedBatchKey(batchKey: string, issueId: string): string {
  const hex = createHmac("sha256", batchKey).update(issueId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sameOrigin(request: IncomingMessage, secure: boolean): boolean {
  const origin = firstHeader(request.headers.origin);
  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) ?? (secure ? "https" : "http");
  if (!origin || !host) return false;
  try { return new URL(origin).origin === `${protocol}://${host}`; }
  catch { return false; }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): true {
  response.statusCode = status;
  if (status !== 204) response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(status === 204 ? undefined : JSON.stringify(body));
  return true;
}

async function readAccessBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    sendJson(response, 415, { error: "content_type_must_be_application_json" });
    return null;
  }
  try {
    const body = await readJsonBody(request, 16_384);
    if (typeof body !== "object" || body === null) throw new Error("invalid_json");
    return body as Record<string, unknown>;
  } catch (error) {
    sendJson(response, error instanceof Error && error.message === "request_body_too_large" ? 413 : 400,
      { error: error instanceof Error && error.message === "request_body_too_large" ? "request_body_too_large" : "invalid_json" });
    return null;
  }
}

function isAccessRole(value: unknown): value is OpsAccessRole {
  return value === "staff" || value === "manager" || value === "admin";
}
function isAccessAction(value: unknown): value is "change_role" | "deactivate" | "reactivate" {
  return value === "change_role" || value === "deactivate" || value === "reactivate";
}
function sendAccessResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}

function sendSessionMutationResult(response: ServerResponse, result: { outcome: string }): void {
  if (result.outcome === "session_not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "session_not_active" || result.outcome === "idempotency_key_reused") {
    sendJson(response, 409, result); return;
  }
  if (result.outcome === "invalid_request") { sendJson(response, 400, result); return; }
  sendJson(response, 200, result);
}

async function readConfigurationBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    sendJson(response, 415, { error: "content_type_must_be_application_json" });
    return null;
  }
  try {
    const body = await readJsonBody(request, 131_072);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("invalid_json");
    return body as Record<string, unknown>;
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_body_too_large";
    sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? "request_body_too_large" : "invalid_json" });
    return null;
  }
}

function isConfigurationReader(actorType: OpsSession["actorType"]): boolean {
  return actorType === "manager" || actorType === "admin";
}
function releaseMutationInput(body: Record<string, unknown>): { reason: string; idempotencyKey: string } | null {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  return reason.length >= 12 && reason.length <= 1_000 && isUuid(idempotencyKey)
    ? { reason, idempotencyKey } : null;
}
function uatActivationDecisionInput(body:Record<string,unknown>):{
  decisionKey:UatActivationDecisionKey; status:"approved"|"rejected"; evidence:Record<string,unknown>;
}|null {
  const decisionKey=body.decisionKey;
  const status=body.status;
  const evidence=body.evidence;
  if (!["customer_confirmation","budget_and_cost","data_scope","provisioning_window"].includes(String(decisionKey))
    || !["approved","rejected"].includes(String(status)) || !isPlainObject(evidence)
    || containsSensitiveEvidenceKey(evidence)) return null;
  const normalizedStatus=status as "approved"|"rejected";
  const reference=typeof evidence.reference==="string"?evidence.reference.trim():"";
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(reference) || reference.length>300) return null;
  if (normalizedStatus==="rejected") return {decisionKey:decisionKey as UatActivationDecisionKey,status:normalizedStatus,evidence:{reference}};
  if (decisionKey==="customer_confirmation") {
    if (!isIsoDateTime(evidence.confirmedAt)) return null;
    return {decisionKey:decisionKey as UatActivationDecisionKey,status:normalizedStatus,evidence:{reference,confirmedAt:evidence.confirmedAt}};
  }
  if (decisionKey==="budget_and_cost") {
    const approved=Number(evidence.approvedMonthlyLimitUsd),estimated=Number(evidence.estimatedMonthlyCostUsd);
    if (evidence.currency!=="USD" || !Number.isFinite(approved) || !Number.isFinite(estimated)
      || approved<=0 || approved>1000 || estimated<=0 || estimated>approved) return null;
    return {decisionKey:decisionKey as UatActivationDecisionKey,status:normalizedStatus,evidence:{reference,currency:"USD",approvedMonthlyLimitUsd:approved,estimatedMonthlyCostUsd:estimated}};
  }
  if (decisionKey==="data_scope") {
    if (!["synthetic_only","real_data"].includes(String(evidence.mode)) || evidence.region!=="Sydney"
      || evidence.retentionDays!==30 || typeof evidence.realDataApproved!=="boolean"
      || (evidence.mode==="real_data")!==evidence.realDataApproved) return null;
    return {decisionKey:decisionKey as UatActivationDecisionKey,status:normalizedStatus,evidence:{reference,mode:evidence.mode,region:"Sydney",retentionDays:30,realDataApproved:evidence.realDataApproved}};
  }
  if (!isIsoDateTime(evidence.startsAt) || !isIsoDateTime(evidence.endsAt)
    || Date.parse(evidence.endsAt as string)<=Date.parse(evidence.startsAt as string)
    || Date.parse(evidence.endsAt as string)-Date.parse(evidence.startsAt as string)>86_400_000) return null;
  return {decisionKey:decisionKey as UatActivationDecisionKey,status:normalizedStatus,evidence:{reference,startsAt:evidence.startsAt,endsAt:evidence.endsAt}};
}
function isIsoDateTime(value:unknown):value is string {
  return typeof value==="string" && value.length<=40 && !Number.isNaN(Date.parse(value));
}
function containsSensitiveEvidenceKey(value:Record<string,unknown>):boolean {
  for (const [key,nested] of Object.entries(value)) {
    if (/(secret|token|password|credential|api.?key|connection.?string)/i.test(key)) return true;
    if (isPlainObject(nested) && containsSensitiveEvidenceKey(nested)) return true;
  }
  return false;
}
function isReleaseReadinessDeclarations(value: unknown): value is ReleaseReadinessDeclarations {
  if (!isPlainObject(value) || value.schemaVersion !== "1.0" || value.sourceEnvironment !== "DEV"
    || value.targetEnvironment !== "UAT" || value.targetProvisioning !== "not_started"
    || value.runtimeExecution !== "disabled" || value.externalDelivery !== "disabled"
    || value.externalIngress !== "disabled" || value.dataBoundary !== "synthetic_only"
    || !isPlainObject(value.approvals) || !Array.isArray(value.secretReferences)
    || value.secretReferences.length > 20
    || !value.secretReferences.every((reference) => typeof reference === "string"
      && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(reference) && reference.length <= 300)) return false;
  const approvalKeys = ["dataRegion", "privacyRetention", "budget", "sharedMailbox"] as const;
  for (const key of approvalKeys) {
    const declaration = value.approvals[key];
    if (!isPlainObject(declaration)
      || !["pending", "approved", "not_required"].includes(String(declaration.status))
      || !(declaration.reference === null || (typeof declaration.reference === "string"
        && declaration.reference.trim().length >= 3 && declaration.reference.length <= 300))) return false;
    if (declaration.status === "approved" && declaration.reference === null) return false;
    if (key === "budget" && declaration.status === "approved"
      && (typeof declaration.monthlyLimitUsd !== "number" || !Number.isFinite(declaration.monthlyLimitUsd)
        || declaration.monthlyLimitUsd !== 0)) return false;
  }
  return true;
}
function isUatEnvironmentBlueprintDefinition(value: unknown): value is UatEnvironmentBlueprintDefinition {
  if (!isPlainObject(value) || value.schemaVersion!=="1.0" || value.sourceEnvironment!=="DEV"
    || value.targetEnvironment!=="UAT" || value.provisioningMode!=="dry_run_only"
    || value.targetProvisioning!=="not_started" || value.dataBoundary!=="synthetic_only"
    || value.dataCopy!=="none" || value.runtimeExecution!=="disabled"
    || value.externalIngress!=="disabled" || value.externalDelivery!=="disabled"
    || value.secretMaterialization!=="disabled" || !isPlainObject(value.topology)
    || !isPlainObject(value.decisions) || !isPlainObject(value.migration)
    || !isPlainObject(value.acceptance) || !isPlainObject(value.rollback)
    || !Array.isArray(value.variableNames) || !Array.isArray(value.secretReferences)) return false;
  const topology=value.topology;
  if (topology.provider!=="railway" || topology.isolation!=="dedicated_environment"
    || topology.database!=="dedicated_supabase_project" || topology.storage!=="dedicated_private_bucket"
    || !Array.isArray(topology.services) || topology.services.length!==3) return false;
  const serviceKeys=new Set<string>();
  for (const service of topology.services) {
    if (!isPlainObject(service) || !["intake","preservation","classification"].includes(String(service.key))
      || service.plannedExposure!=="internal_only" || service.replicas!==1 || service.runtimeState!=="disabled") return false;
    serviceKeys.add(String(service.key));
  }
  if (serviceKeys.size!==3) return false;
  for (const key of ["dataRegion","privacyRetention","budget","runtimeOwner"] as const) {
    const decision=value.decisions[key];
    if (!isPlainObject(decision) || !["pending","approved"].includes(String(decision.status))
      || !(decision.reference===null || (typeof decision.reference==="string" && decision.reference.length>=3 && decision.reference.length<=300))
      || (decision.status==="approved" && decision.reference===null)) return false;
  }
  const region=value.decisions.dataRegion;
  if (!isPlainObject(region) || region.region!=="Sydney") return false;
  const privacy=value.decisions.privacyRetention;
  if (!isPlainObject(privacy) || privacy.retentionDays!==30 || privacy.realDataRequiresReapproval!==true) return false;
  const budget=value.decisions.budget;
  if (!isPlainObject(budget) || budget.monthlyLimitUsd!==0 || budget.paidResourceProvisioning!=="prohibited") return false;
  const runtimeOwner=value.decisions.runtimeOwner;
  if (!isPlainObject(runtimeOwner) || typeof runtimeOwner.actorId!=="string" || !isUuid(runtimeOwner.actorId)) return false;
  if (value.variableNames.length<5 || value.variableNames.length>50
    || !value.variableNames.every((item) => typeof item==="string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(item))) return false;
  if (value.secretReferences.length>30 || !value.secretReferences.every((item) => isPlainObject(item)
    && typeof item.variableName==="string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(item.variableName)
    && typeof item.reference==="string" && /^[a-z][a-z0-9+.-]*:\/\/[^?#\s]{3,240}$/i.test(item.reference)
    && !("value" in item))) return false;
  const migration=value.migration;
  if (migration.strategy!=="ordered_sql" || migration.seedMode!=="synthetic_only"
    || !Array.isArray(migration.migrations) || migration.migrations.length<1
    || !migration.migrations.every((item) => typeof item==="string" && item.length<=200)
    || !Array.isArray(migration.verificationScripts) || migration.verificationScripts.length<1
    || !migration.verificationScripts.every((item) => typeof item==="string" && item.length<=200)) return false;
  return value.acceptance.healthCheck==="required" && value.acceptance.errorLogs==="zero_required"
    && value.acceptance.syntheticJourney==="required" && value.acceptance.realData==="prohibited"
    && value.rollback.strategy==="remove_unexposed_target" && value.rollback.preserveAuditEvidence===true
    && typeof value.rollback.maxMinutes==="number" && Number.isInteger(value.rollback.maxMinutes)
    && value.rollback.maxMinutes>=1 && value.rollback.maxMinutes<=120;
}
function isMissingRequestReviewAction(value: unknown): value is MissingRequestReviewAction {
  return value === "submit_review" || value === "return_to_draft" || value === "approve" || value === "reject";
}
function sendMissingRequestResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function isConfigurationAction(value: unknown): value is "submit_review" | "return_to_draft" | "publish" {
  return value === "submit_review" || value === "return_to_draft" || value === "publish";
}
function isWorkConfigurationManifest(value: unknown): value is WorkConfigurationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (!manifest.subject || typeof manifest.subject !== "object" || Array.isArray(manifest.subject)
    || !manifest.workflow || typeof manifest.workflow !== "object" || Array.isArray(manifest.workflow)
    || !Array.isArray(manifest.requirements) || manifest.requirements.length < 1 || manifest.requirements.length > 100) return false;
  const subject = manifest.subject as Record<string, unknown>;
  if (typeof subject.displayName !== "string" || typeof subject.subjectType !== "string"
    || !["active", "paused", "offboarding", "closed"].includes(String(subject.status))
    || !subject.attributes || typeof subject.attributes !== "object" || Array.isArray(subject.attributes)
    || !(subject.primaryContactActorId === null || typeof subject.primaryContactActorId === "string")) return false;
  return manifest.requirements.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const requirement = item as Record<string, unknown>;
    return typeof requirement.code === "string" && typeof requirement.documentTypeCode === "string"
      && typeof requirement.minimumCount === "number"
      && (requirement.maximumCount === null || typeof requirement.maximumCount === "number")
      && requirement.acceptanceRule !== null && typeof requirement.acceptanceRule === "object" && !Array.isArray(requirement.acceptanceRule);
  });
}
function isCasePlanDefinition(value: unknown): value is CasePlanDefinition {
  if (!isPlainObject(value) || !isPlainObject(value.cadence)
    || !isPlainObject(value.dueRule) || !isPlainObject(value.sourceBinding)) return false;
  const cadence = value.cadence;
  const dueRule = value.dueRule;
  const sourceBinding = value.sourceBinding;
  return cadence.mode === "calendar_months"
    && Number.isInteger(cadence.intervalMonths) && Number(cadence.intervalMonths) >= 1 && Number(cadence.intervalMonths) <= 12
    && typeof cadence.anchorDate === "string" && /^\d{4}-\d{2}-01$/.test(cadence.anchorDate)
    && typeof value.timezone === "string" && value.timezone.length >= 3 && value.timezone.length <= 80
    && (dueRule.basis === "period_start" || dueRule.basis === "period_end")
    && Number.isInteger(dueRule.offsetDays) && Number(dueRule.offsetDays) >= -31 && Number(dueRule.offsetDays) <= 365
    && typeof dueRule.localTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueRule.localTime)
    && Number.isInteger(value.defaultPreviewCount) && Number(value.defaultPreviewCount) >= 1 && Number(value.defaultPreviewCount) <= 12
    && ["manual_upload", "form_connector", "email", "sharepoint", "api", "sftp", "object_storage"].includes(String(sourceBinding.type))
    && typeof sourceBinding.bindingKey === "string" && /^[a-z0-9][a-z0-9._-]{2,119}$/.test(sourceBinding.bindingKey)
    && isPlainObject(sourceBinding.metadata) && value.externalDelivery === "disabled";
}
function isWorkPackageBlueprint(value: unknown): value is WorkPackageBlueprint {
  if (!isPlainObject(value) || !isPlainObject(value.subjectDefaults)
    || !isPlainObject(value.subjectDefaults.attributes) || !isPlainObject(value.workflow)
    || !Array.isArray(value.requirements) || value.requirements.length < 1 || value.requirements.length > 100) return false;
  const workflow = value.workflow;
  if ((value.subjectDefaults.status !== "active" && value.subjectDefaults.status !== "paused")
    || typeof workflow.frequency !== "string" || workflow.frequency.trim().length < 2 || workflow.frequency.length > 80
    || workflow.environment !== "DEV" || workflow.external_messages_require_approval !== true
    || workflow.dev_recipient_policy !== "allowlist_only") return false;
  return value.requirements.every((item) => {
    if (!isPlainObject(item) || typeof item.code !== "string" || item.code.trim().length < 2 || item.code.length > 120
      || typeof item.documentTypeCode !== "string" || item.documentTypeCode.trim().length < 2 || item.documentTypeCode.length > 120
      || !Number.isInteger(item.minimumCount) || Number(item.minimumCount) < 0
      || !(item.maximumCount === null || (Number.isInteger(item.maximumCount) && Number(item.maximumCount) >= Number(item.minimumCount)))
      || !isPlainObject(item.acceptanceRule)) return false;
    return true;
  });
}
function isSyntheticWorkPackageSample(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || typeof value.subjectKey !== "string"
    || typeof value.displayName !== "string" || typeof value.subjectType !== "string"
    || !isPlainObject(value.attributes)) return false;
  return /^[a-z0-9][a-z0-9-]{2,79}$/.test(value.subjectKey)
    && value.displayName.trim().length >= 2 && value.displayName.length <= 160
    && value.subjectType.trim().length >= 2 && value.subjectType.length <= 80
    && value.attributes.synthetic === true;
}
function isWorkPackageAction(value: unknown): value is "submit_review" | "return_to_draft" | "publish" {
  return value === "submit_review" || value === "return_to_draft" || value === "publish";
}
function isClassificationProfileDefinition(value: unknown): value is ClassificationProfileDefinition {
  if (!isPlainObject(value) || value.schemaVersion !== "1.0" || value.environment !== "DEV"
    || value.unknownDocumentRoute !== "review_required" || value.ambiguityRoute !== "review_required"
    || !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 100
    || !Array.isArray(value.evaluationCases) || value.evaluationCases.length < 3 || value.evaluationCases.length > 200) return false;
  const labelsValid = value.labels.every((item) => {
    if (!isPlainObject(item) || typeof item.code !== "string" || typeof item.displayName !== "string"
      || typeof item.description !== "string" || !Array.isArray(item.allowedMimeTypes)
      || !Array.isArray(item.extractionFields) || !isPlainObject(item.policy)) return false;
    return /^[a-z0-9][a-z0-9._-]{2,119}$/.test(item.code)
      && item.displayName.trim().length >= 2 && item.description.trim().length >= 12
      && item.allowedMimeTypes.length >= 1 && item.allowedMimeTypes.length <= 20
      && item.allowedMimeTypes.every((mime) => typeof mime === "string")
      && item.extractionFields.length <= 50 && item.extractionFields.every((field) => isPlainObject(field)
        && typeof field.key === "string" && typeof field.displayName === "string"
        && ["string", "number", "date", "boolean"].includes(String(field.valueType))
        && typeof field.required === "boolean")
      && typeof item.policy.minimumConfidence === "number"
      && item.policy.minimumConfidence >= 0 && item.policy.minimumConfidence <= 1
      && typeof item.policy.alwaysHumanConfirm === "boolean"
      && typeof item.policy.manualOnConflict === "boolean"
      && Array.isArray(item.policy.rejectOnQualityFlags)
      && Array.isArray(item.policy.rejectOnConflictFlags);
  });
  return labelsValid && value.evaluationCases.every((item) => isPlainObject(item)
    && typeof item.caseKey === "string" && typeof item.displayName === "string"
    && item.synthetic === true && typeof item.filename === "string" && typeof item.mimeType === "string"
    && typeof item.predictedLabelCode === "string" && Array.isArray(item.ambiguousLabelCodes)
    && typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1
    && Array.isArray(item.qualityFlags) && Array.isArray(item.conflictFlags)
    && (item.expectedRoute === "accepted" || item.expectedRoute === "review_required"));
}
function isClassifierReleaseDefinition(value: unknown): value is ClassifierReleaseDefinition {
  if (!isPlainObject(value) || value.schemaVersion !== "1.0" || value.environment !== "DEV"
    || value.provider !== "openai" || typeof value.model !== "string"
    || typeof value.promptKey !== "string" || typeof value.promptInstructions !== "string"
    || typeof value.promptInstructionHash !== "string"
    || typeof value.classificationProfileVersionId !== "string"
    || typeof value.classificationProfileDefinitionHash !== "string"
    || value.responseSchemaVersion !== "1.0" || typeof value.responseSchemaHash !== "string"
    || !isPlainObject(value.requestPolicy) || value.requestPolicy.store !== false
    || !["low", "medium", "high"].includes(String(value.requestPolicy.reasoningEffort))
    || !Number.isInteger(value.requestPolicy.maxOutputTokens)
    || Number(value.requestPolicy.maxOutputTokens) < 256 || Number(value.requestPolicy.maxOutputTokens) > 4000
    || !Array.isArray(value.providerEvaluationCases)
    || value.providerEvaluationCases.length < 3 || value.providerEvaluationCases.length > 20) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/.test(value.model)
    && /^[a-z0-9][a-z0-9._-]{2,119}$/.test(value.promptKey)
    && value.promptInstructions.length >= 100 && value.promptInstructions.length <= 20_000
    && /^[0-9a-f]{64}$/.test(value.promptInstructionHash)
    && isUuid(value.classificationProfileVersionId)
    && /^[0-9a-f]{64}$/.test(value.classificationProfileDefinitionHash)
    && /^[0-9a-f]{64}$/.test(value.responseSchemaHash)
    && value.providerEvaluationCases.every((item) => isPlainObject(item)
      && typeof item.caseKey === "string" && /^[a-z0-9][a-z0-9._-]{2,119}$/.test(item.caseKey)
      && typeof item.displayName === "string" && item.displayName.trim().length >= 2
      && item.synthetic === true && typeof item.inputText === "string"
      && item.inputText.trim().length >= 30 && item.inputText.length <= 5_000
      && typeof item.filename === "string" && item.filename.length >= 3
      && item.mimeType === "text/plain" && typeof item.expectedLabelCode === "string"
      && typeof item.minimumConfidence === "number" && item.minimumConfidence >= 0 && item.minimumConfidence <= 1);
}
function isSourceConnectorDefinition(value: unknown): value is SourceConnectorDefinition {
  if (!isPlainObject(value) || value.schemaVersion!=="1.0" || value.environment!=="DEV"
    || typeof value.connectorKey!=="string" || !/^[a-z0-9][a-z0-9._-]{2,119}$/.test(value.connectorKey)
    || !["manual_upload","form","email","sharepoint","api","sftp","object_storage"].includes(String(value.connectorType))
    || !["operator","push","pull"].includes(String(value.transport))
    || !Array.isArray(value.capabilities) || value.capabilities.length<1 || value.capabilities.length>5
    || !isPlainObject(value.credentialReference) || !isPlainObject(value.dataBoundary)
    || !isPlainObject(value.activationPolicy) || !Array.isArray(value.testFixtures)
    || value.testFixtures.length<1 || value.testFixtures.length>10) return false;
  const capabilities=["documents","metadata","attachments","webhook","polling"];
  return value.capabilities.every((item)=>typeof item==="string"&&capabilities.includes(item))
    && ["none","secret_reference"].includes(String(value.credentialReference.mode))
    && ["none","railway","supabase","external_vault"].includes(String(value.credentialReference.provider))
    && (value.credentialReference.reference===null || typeof value.credentialReference.reference==="string")
    && value.dataBoundary.syntheticOnly===true && value.dataBoundary.externalDelivery==="disabled"
    && Number.isInteger(value.dataBoundary.maxFilesPerSubmission)
    && Number(value.dataBoundary.maxFilesPerSubmission)>=1 && Number(value.dataBoundary.maxFilesPerSubmission)<=100
    && Number.isInteger(value.dataBoundary.maxFileBytes) && Number(value.dataBoundary.maxFileBytes)>=1
    && Number(value.dataBoundary.maxFileBytes)<=104_857_600
    && Array.isArray(value.dataBoundary.allowedMimeTypes) && value.dataBoundary.allowedMimeTypes.length>=1
    && value.dataBoundary.allowedMimeTypes.every((item)=>typeof item==="string")
    && value.capabilities.includes("documents")
    && (value.connectorType!=="form" || value.capabilities.includes("webhook"))
    && (value.connectorType!=="email" || value.capabilities.includes("attachments"))
    && (value.transport!=="pull" || value.capabilities.includes("polling"))
    && (value.transport==="pull" || !value.capabilities.includes("polling"))
    && (!value.capabilities.includes("webhook") || value.transport==="push")
    && value.activationPolicy.explicitApprovalRequired===true
    && value.activationPolicy.emergencySuspendEnabled===true
    && value.activationPolicy.runtimeExecution==="disabled"
    && value.testFixtures.every((item)=>isPlainObject(item) && typeof item.fixtureKey==="string"
      && typeof item.displayName==="string" && item.synthetic===true && typeof item.filename==="string"
      && typeof item.mimeType==="string" && typeof item.payloadSummary==="string");
}
function isSourceConnectorAction(value: unknown): value is "submit_review"|"return_to_draft"|"approve"|"activate"|"suspend"|"reactivate"|"revoke" {
  return value==="submit_review"||value==="return_to_draft"||value==="approve"||value==="activate"
    ||value==="suspend"||value==="reactivate"||value==="revoke";
}
function sendConfigurationResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function sendCasePlanResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function sendWorkPackageResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function sendClassificationProfileResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function sendClassifierReleaseResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, result.outcome === "queued" ? 202 : 200, result);
}
function sendSourceConnectorResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome==="not_found") { sendJson(response,404,result); return; }
  if (result.outcome==="conflict") { sendJson(response,409,result); return; }
  sendJson(response,200,result);
}
function sendDemoFormResult(response:ServerResponse,result:{outcome:string;reason?:string}):void{
  if(result.outcome==="not_found"){sendJson(response,404,result);return;}
  if(result.outcome==="conflict"){sendJson(response,409,result);return;}
  sendJson(response,200,result);
}
function sendReleaseReadinessResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome === "not_found") { sendJson(response, 404, result); return; }
  if (result.outcome === "conflict") { sendJson(response, 409, result); return; }
  sendJson(response, 200, result);
}
function sendUatBlueprintResult(response: ServerResponse, result: { outcome: string; reason?: string }): void {
  if (result.outcome==="not_found") { sendJson(response,404,result); return; }
  if (result.outcome==="conflict") { sendJson(response,409,result); return; }
  sendJson(response,200,result);
}
function sendRetentionResult(response:ServerResponse,result:{outcome:string;reason?:string}):void {
  if (result.outcome==="not_found"){sendJson(response,404,result);return;}
  if (result.outcome==="conflict"){sendJson(response,409,result);return;}
  sendJson(response,200,result);
}
