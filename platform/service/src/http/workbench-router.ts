import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { OpsCaseDetail, OpsCaseDocument, OpsCaseSummary, OpsOverview, OpsReadRepository, OpsRequirementProgress } from "../ports/ops-read-repository.js";
import type { WorkbenchRepository } from "../ports/workbench-repository.js";
import type { ResolveDocumentReview } from "../application/resolve-document-review.js";
import { DocumentReviewInputError } from "../application/resolve-document-review.js";
import type { DocumentPreviewBroker, OpsDocumentPreviewRepository } from "../ports/document-preview.js";
import type { OpsDemoFormRepository, OpsDemoFormSnapshot } from "../ports/ops-demo-form-repository.js";
import type { OpsTrialRepository } from "../ports/ops-trial-repository.js";
import type { OpsTaskRepository } from "../ports/ops-task-repository.js";
import type { TransitionTask } from "../application/transition-task.js";
import { TaskTransitionInputError } from "../application/transition-task.js";
import { csrfToken, safeEqual } from "./ops-session-security.js";

interface WorkbenchAuthorizedSession {
  actorId: string;
  displayName: string;
  actorType: string;
  expiresAt: number;
  cookieValue: string;
}

export interface WorkbenchSessionAuthorizer {
  authorize(cookieHeader: string | undefined): Promise<WorkbenchAuthorizedSession | null>;
}

export interface WorkbenchRouterOptions {
  sessionAuthorizer: WorkbenchSessionAuthorizer;
  caseRepository: Pick<OpsReadRepository, "listCases" | "getCaseDetail"> & Partial<Pick<OpsReadRepository, "getOverview">>;
  workbenchRepository: WorkbenchRepository;
  reviewHandler?: ResolveDocumentReview;
  previewRepository?: OpsDocumentPreviewRepository;
  previewBroker?: DocumentPreviewBroker;
  demoFormRepository?: OpsDemoFormRepository;
  trialRepository?: OpsTrialRepository;
  taskRepository?: OpsTaskRepository;
  taskHandler?: TransitionTask;
  organizationKey: string;
  sessionSecret: string;
  staticDirectory: string;
  clientPortalOrigin: string;
  localPersistenceOnly?: boolean;
  secureCookie?: boolean;
  now?: () => Date;
}

export class WorkbenchRouter {
  private readonly now: () => Date;
  private readonly secureCookie: boolean;

  constructor(private readonly options: WorkbenchRouterOptions) {
    if (options.sessionSecret.length < 32) throw new Error("DOP_OPS_SESSION_SECRET must contain at least 32 characters");
    const localOrigin = options.localPersistenceOnly === true && options.secureCookie === false
      && /^http:\/\/127\.0\.0\.1:\d+$/.test(options.clientPortalOrigin);
    if (!localOrigin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(options.clientPortalOrigin)) {
      throw new Error("workbench client portal origin must be a secure origin");
    }
    this.now = options.now ?? (() => new Date());
    this.secureCookie = options.secureCookie ?? true;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/workbench" || url.pathname === "/workbench/")) {
      return await this.sendAsset(response, "index.html", "text/html; charset=utf-8", false);
    }
    const asset = assetFor(url.pathname);
    if (request.method === "GET" && asset) return await this.sendAsset(response, asset.filename, asset.contentType, asset.cacheable);

    if (request.method === "GET" && url.pathname === "/v1/workbench/session") {
      workbenchHeaders(response);
      const session = await this.options.sessionAuthorizer.authorize(request.headers.cookie);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      if (!isWorkbenchActor(session.actorType)) return sendJson(response, 403, { error: "workbench_access_required" });
      return sendJson(response, 200, {
        operator: { displayName: session.displayName, actorType: session.actorType },
        expiresAt: new Date(session.expiresAt).toISOString(),
        csrfToken: csrfToken(session.cookieValue, this.options.sessionSecret),
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/workbench/setup") {
      workbenchHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      return sendJson(response, 200, await this.options.workbenchRepository.getSetup(this.options.organizationKey, this.now()));
    }
    if (request.method === "POST" && url.pathname === "/v1/workbench/client-cases") {
      await this.createClientCase(request, response);
      return true;
    }
    if (request.method === "GET" && url.pathname === "/v1/workbench/cases") {
      workbenchHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      const now = this.now();
      const cases = await this.options.caseRepository.listCases(this.options.organizationKey, now, session.actorId);
      return sendJson(response, 200, projectCaseLists(cases, now));
    }
    if (request.method === "GET" && url.pathname === "/v1/workbench/today") {
      workbenchHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      if (!this.options.caseRepository.getOverview) return sendJson(response, 503, { error: "today_not_configured" });
      const overview = await this.options.caseRepository.getOverview(this.options.organizationKey, this.now(), session.actorId);
      const tasks = this.options.taskRepository
        ? await this.options.taskRepository.getSnapshot(this.options.organizationKey, session.actorId, this.now()) : null;
      return sendJson(response, 200, projectToday(overview, tasks?.tasks ?? [], session.actorId));
    }
    if (request.method === "GET" && url.pathname === "/v1/workbench/tasks") {
      workbenchHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      if (!this.options.taskRepository) return sendJson(response, 503, { error: "tasks_not_configured" });
      const snapshot = await this.options.taskRepository.getSnapshot(this.options.organizationKey, session.actorId, this.now());
      return sendJson(response, 200, projectTasks(snapshot.tasks, session.actorId));
    }
    const taskTransitionMatch = /^\/v1\/workbench\/tasks\/([^/]+)\/transitions$/.exec(url.pathname);
    if (request.method === "POST" && taskTransitionMatch) {
      await this.transitionTask(request, response, taskTransitionMatch[1] ?? "");
      return true;
    }
    const reviewMatch = /^\/v1\/workbench\/reviews\/([^/]+)$/.exec(url.pathname);
    const escalationMatch = /^\/v1\/workbench\/reviews\/([^/]+)\/escalate$/.exec(url.pathname);
    if (request.method === "POST" && escalationMatch) {
      workbenchHeaders(response);
      const session = await this.mutationSession(request, response);
      if (!session) return true;
      const body = await readBody(request, response);
      if (!body) return true;
      const documentId = escalationMatch[1] ?? "";
      const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      if (!isUuid(documentId) || !isUuid(key)) return sendJson(response, 400, { error: "invalid_identifier" });
      const result = await this.options.workbenchRepository.escalateReview(this.options.organizationKey, {
        actorId: session.actorId, documentId, idempotencyKey: key, correlationId: randomUUID(), now: this.now() });
      return sendJson(response, result.outcome === "conflict" ? 409 : result.outcome === "not_found" ? 404 : 200, result);
    }
    if (request.method === "POST" && reviewMatch) {
      await this.resolveReview(request, response, reviewMatch[1] ?? "");
      return true;
    }
    const previewMatch = /^\/v1\/workbench\/documents\/([^/]+)\/preview$/.exec(url.pathname);
    if (request.method === "POST" && previewMatch) {
      await this.createPreview(request, response, previewMatch[1] ?? "");
      return true;
    }
    const questionMatch = /^\/v1\/workbench\/cases\/([^/]+)\/questions$/.exec(url.pathname);
    if (request.method === "POST" && questionMatch) {
      await this.publishQuestion(request, response, questionMatch[1] ?? "");
      return true;
    }
    const questionResolveMatch = /^\/v1\/workbench\/questions\/([^/]+)\/resolve$/.exec(url.pathname);
    if (request.method === "POST" && questionResolveMatch) {
      await this.resolveQuestion(request, response, questionResolveMatch[1] ?? "");
      return true;
    }
    const duplicateMatch = /^\/v1\/workbench\/cases\/([^/]+)\/acknowledge-duplicates$/.exec(url.pathname);
    if (request.method === "POST" && duplicateMatch) {
      workbenchHeaders(response);
      const session = await this.mutationSession(request, response);
      if (!session) return true;
      const body = await readBody(request, response);
      if (!body) return true;
      const caseId = duplicateMatch[1] ?? "";
      const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
      if (!isUuid(caseId) || !isUuid(key)) return sendJson(response, 400, { error: "invalid_identifier" });
      const result = await this.options.workbenchRepository.acknowledgeDuplicates(this.options.organizationKey, {
        actorId: session.actorId, caseId, idempotencyKey: key, correlationId: randomUUID(), now: this.now() });
      return sendJson(response, result.outcome === "conflict" ? 409 : result.outcome === "not_found" ? 404 : 200, result);
    }
    const completeMatch = /^\/v1\/workbench\/cases\/([^/]+)\/complete$/.exec(url.pathname);
    if (request.method === "POST" && completeMatch) {
      await this.completeCase(request, response, completeMatch[1] ?? "");
      return true;
    }
    const invitationMatch = /^\/v1\/workbench\/cases\/([^/]+)\/invitations$/.exec(url.pathname);
    if (request.method === "POST" && invitationMatch) {
      await this.issueInvitation(request, response, invitationMatch[1] ?? "");
      return true;
    }
    const detailMatch = /^\/v1\/workbench\/cases\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && detailMatch) {
      workbenchHeaders(response);
      const session = await this.authorized(request);
      if (!session) return sendJson(response, 401, { error: "session_required" });
      const caseId = detailMatch[1] ?? "";
      if (!isUuid(caseId)) return sendJson(response, 400, { error: "invalid_identifier" });
      const detail = await this.options.caseRepository.getCaseDetail(this.options.organizationKey, caseId, this.now(), session.actorId);
      if (!detail) return sendJson(response, 404, { outcome: "not_found", resource: "case" });
      const demoSnapshot = this.options.demoFormRepository
        ? await this.options.demoFormRepository.getSnapshot(this.options.organizationKey, this.now()) : null;
      return sendJson(response, 200, projectCaseDetail(detail, session.actorType, demoSnapshot));
    }
    return false;
  }

  private async createClientCase(request: IncomingMessage, response: ServerResponse): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    const body = await readBody(request, response);
    if (!body) return;
    const requirements = Array.isArray(body.requirements) ? body.requirements : [];
    const normalized = requirements.map((value) => isPlainObject(value) ? {
      code: typeof value.code === "string" ? value.code.trim() : "",
      minimumCount: Number(value.minimumCount),
      maximumCount: value.maximumCount === null ? null : Number(value.maximumCount),
    } : null);
    const packageVersionId = typeof body.serviceOptionId === "string" ? body.serviceOptionId : "";
    const displayName = typeof body.customerName === "string" ? body.customerName.trim() : "";
    const contactName = typeof body.contactName === "string" && body.contactName.trim() ? body.contactName.trim() : null;
    const periodStart = typeof body.periodStart === "string" ? body.periodStart : "";
    const periodEnd = typeof body.periodEnd === "string" ? body.periodEnd : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(packageVersionId) || !isUuid(idempotencyKey) || displayName.length < 2 || displayName.length > 160
      || (contactName !== null && (contactName.length < 2 || contactName.length > 120))
      || !isDate(periodStart) || !isDate(periodEnd) || normalized.length < 1 || normalized.length > 100
      || normalized.some((item) => !item || !/^[a-z0-9][a-z0-9._-]{1,119}$/i.test(item.code)
        || !Number.isInteger(item.minimumCount) || item.minimumCount < 1 || item.minimumCount > 100
        || (item.maximumCount !== null && (!Number.isInteger(item.maximumCount) || item.maximumCount < item.minimumCount || item.maximumCount > 100)))) {
      return void sendJson(response, 400, { error: "invalid_client_case_request" });
    }
    const result = await this.options.workbenchRepository.createClientCase(this.options.organizationKey, {
      actorId: session.actorId, packageVersionId, displayName, contactName, periodStart, periodEnd,
      requirements: normalized as Array<{ code: string; minimumCount: number; maximumCount: number | null }>,
      idempotencyKey, correlationId: randomUUID(), now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, result.outcome === "completed" ? 201 : 200, result);
  }

  private async issueInvitation(request: IncomingMessage, response: ServerResponse, caseId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!isUuid(caseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(idempotencyKey)) return void sendJson(response, 400, { error: "invalid_invitation_request" });
    const replaceInvitationId = typeof body.replaceInvitationId === "string" ? body.replaceInvitationId : undefined;
    if (body.replaceInvitationId !== undefined && (!replaceInvitationId || !isUuid(replaceInvitationId)))
      return void sendJson(response, 400, { error: "invalid_invitation_request" });
    let token = createHmac("sha256", this.options.sessionSecret).update(`workbench-client-invitation:${idempotencyKey}`).digest("base64url");
    const now = this.now();
    const result = await this.options.workbenchRepository.issueInvitation(this.options.organizationKey, {
      actorId: session.actorId, caseId,
      invitationTokenSha256: createHash("sha256").update(token).digest("hex"),
      maximumSubmissions: 20, validUntil: new Date(now.getTime() + 14 * 86_400_000),
      ...(replaceInvitationId ? { replaceInvitationId } : {}),
      idempotencyKey, correlationId: randomUUID(), now,
    });
    if ("reason" in result) return void sendJson(response, result.outcome === "not_found" ? 404 : 409, result);
    if (result.recoveryKey) {
      token = createHmac("sha256", this.options.sessionSecret).update(`workbench-client-invitation:${result.recoveryKey}`).digest("base64url");
      if (createHash("sha256").update(token).digest("hex") !== result.tokenSha256)
        return void sendJson(response, 409, { outcome: "conflict", reason: "invitation_unavailable",
          invitationId: result.invitationId, canRenew: true });
    }
    if (result.status !== "active" || new Date(result.validUntil).getTime() <= now.getTime())
      return void sendJson(response, 409, { outcome: "conflict", reason: "invitation_unavailable",
        invitationId: result.invitationId, canRenew: true });
    const submissionUrl = `${this.options.clientPortalOrigin.replace(/\/$/, "")}/submit#access=${encodeURIComponent(token)}`;
    const { recoveryKey: _recoveryKey, tokenSha256: _tokenSha256, ...publicResult } = result;
    return void sendJson(response, result.outcome === "completed" ? 201 : 200, {
      ...publicResult, submissionUrl,
      warning: "此链接只可用于本次已批准的虚构资料测试，不得转发给真实客户。",
    });
  }

  private async resolveReview(request: IncomingMessage, response: ServerResponse, documentId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!this.options.reviewHandler) return void sendJson(response, 503, { error: "review_not_configured" });
    if (!isUuid(documentId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    try {
      const result = await this.options.reviewHandler.execute({
        organizationKey: this.options.organizationKey, documentId, actorId: session.actorId,
        action: body.action as "confirm" | "reclassify" | "request_information" | "exclude" | "reopen",
        ...(typeof body.exclusionReason === "string" ? { exclusionReason: body.exclusionReason as "wrong_subject" | "wrong_period" | "irrelevant_or_unknown" } : {}),
        ...(typeof body.documentTypeCode === "string" ? { documentTypeCode: body.documentTypeCode } : {}),
        rationale: typeof body.rationale === "string" ? body.rationale : "",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        correlationId: randomUUID(), now: this.now(),
      });
      if (result.outcome === "not_found") return void sendJson(response, 404, result);
      if (result.outcome === "conflict") return void sendJson(response, 409, result);
      return void sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof DocumentReviewInputError) return void sendJson(response, 400, { error: error.code });
      throw error;
    }
  }

  private async createPreview(request: IncomingMessage, response: ServerResponse, documentId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!isUuid(documentId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    if (!this.options.previewRepository || !this.options.previewBroker) return void sendJson(response, 503, { error: "preview_not_configured" });
    const reference = await this.options.previewRepository.getStorageReference(this.options.organizationKey, documentId);
    if (reference.outcome === "not_found") return void sendJson(response, 404, reference);
    if (reference.outcome === "not_ready") return void sendJson(response, 409, reference);
    try { return void sendJson(response, 200, await this.options.previewBroker.createPreview(reference.storageReference)); }
    catch { return void sendJson(response, 503, { error: "preview_unavailable" }); }
  }

  private async publishQuestion(request: IncomingMessage, response: ServerResponse, caseId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!this.options.demoFormRepository) return void sendJson(response, 503, { error: "client_questions_not_configured" });
    if (!isUuid(caseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    const issueId = typeof body.issueId === "string" ? body.issueId : "";
    const publicTitle = typeof body.title === "string" ? body.title.trim() : "";
    const publicBody = typeof body.message === "string" ? body.message.trim() : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(issueId) || !isUuid(idempotencyKey) || publicTitle.length < 3 || publicTitle.length > 160 || publicBody.length < 12 || publicBody.length > 2000) {
      return void sendJson(response, 400, { error: "invalid_client_question" });
    }
    const result = await this.options.demoFormRepository.publishClientQuestion(this.options.organizationKey, {
      actorId: session.actorId, caseId, issueId, publicTitle, publicBody,
      reason: this.options.localPersistenceOnly ? "员工在本机记录待补交事项，未向外部发送。" : "员工在资料处理过程中向提交者发布补交问题。", idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, result.outcome === "completed" ? 201 : 200, result);
  }

  private async completeCase(request: IncomingMessage, response: ServerResponse, caseId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!this.options.trialRepository) return void sendJson(response, 503, { error: "case_completion_not_configured" });
    if (!isUuid(caseId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(idempotencyKey)) return void sendJson(response, 400, { error: "invalid_completion_request" });
    const result = await this.options.trialRepository.completeCase(this.options.organizationKey, {
      caseId, actorId: session.actorId, assignedActorId: session.actorId,
      reason: "员工确认清单、客户问题及处理异常已全部完成。", idempotencyKey, now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, 200, result);
  }

  private async resolveQuestion(request: IncomingMessage, response: ServerResponse, questionId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!this.options.demoFormRepository) return void sendJson(response, 503, { error: "client_questions_not_configured" });
    if (!isUuid(questionId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!isUuid(idempotencyKey)) return void sendJson(response, 400, { error: "invalid_client_question" });
    const result = await this.options.demoFormRepository.transitionClientQuestion(this.options.organizationKey, {
      actorId: session.actorId, questionId, action: "resolve",
      reason: "员工确认提交者的补交已收到并完成问题处理。", idempotencyKey,
      correlationId: randomUUID(), now: this.now(),
    });
    if (result.outcome === "not_found") return void sendJson(response, 404, result);
    if (result.outcome === "conflict") return void sendJson(response, 409, result);
    return void sendJson(response, 200, result);
  }

  private async transitionTask(request: IncomingMessage, response: ServerResponse, taskId: string): Promise<void> {
    workbenchHeaders(response);
    const session = await this.mutationSession(request, response);
    if (!session) return;
    if (!this.options.taskHandler) return void sendJson(response, 503, { error: "tasks_not_configured" });
    if (!isUuid(taskId)) return void sendJson(response, 400, { error: "invalid_identifier" });
    const body = await readBody(request, response);
    if (!body) return;
    try {
      const result = await this.options.taskHandler.execute({
        organizationKey: this.options.organizationKey, taskId, actorId: session.actorId,
        action: body.action as "claim" | "start" | "wait" | "resume" | "complete" | "reassign" | "reopen",
        assignedActorId: null, reason: "员工在工作台更新下一任务的工作状态。",
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
        correlationId: randomUUID(), now: this.now(),
      });
      if (result.outcome === "not_found") return void sendJson(response, 404, result);
      if (result.outcome === "conflict") return void sendJson(response, 409, result);
      return void sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof TaskTransitionInputError) return void sendJson(response, 400, { error: error.code });
      throw error;
    }
  }

  private async authorized(request: IncomingMessage): Promise<WorkbenchAuthorizedSession | null> {
    const session = await this.options.sessionAuthorizer.authorize(request.headers.cookie);
    return session && isWorkbenchActor(session.actorType) ? session : null;
  }

  private async mutationSession(request: IncomingMessage, response: ServerResponse): Promise<WorkbenchAuthorizedSession | null> {
    const session = await this.authorized(request);
    if (!session) { sendJson(response, 401, { error: "session_required" }); return null; }
    if (!sameOrigin(request, this.secureCookie)) { sendJson(response, 403, { error: "same_origin_required" }); return null; }
    const supplied = firstHeader(request.headers["x-dop-csrf"]);
    const expected = csrfToken(session.cookieValue, this.options.sessionSecret);
    if (!supplied || !safeEqual(supplied, expected)) { sendJson(response, 403, { error: "csrf_token_invalid" }); return null; }
    return session;
  }

  private async sendAsset(response: ServerResponse, filename: string, contentType: string, cacheable: boolean): Promise<true> {
    const content = await readFile(join(this.options.staticDirectory, filename));
    workbenchHeaders(response);
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", cacheable ? "private, max-age=0, must-revalidate" : "no-store");
    response.end(content);
    return true;
  }
}

export interface WorkbenchCaseItem {
  id: string; customerName: string; periodStart: string | null; periodEnd: string | null; status: string; dueAt: string | null;
  checklist: { receivedCount: number; requiredCount: number; missingCount: number; reviewCount: number; processingCount: number;
    attentionCount: number; evaluatedAt: string | null };
  nextAction: "completed" | "review" | "processing" | "missing" | "issues" | "ready";
  labels: { overdue: boolean; missingDocuments: boolean };
}

export interface WorkbenchCaseLists { generatedAt: string; activeCases: WorkbenchCaseItem[]; completedCases: WorkbenchCaseItem[] }
export type WorkbenchDocumentStatus = "processing" | "automatically_accepted" | "awaiting_human_review" | "excluded" | "processing_failed";
export interface WorkbenchCaseDetail {
  generatedAt: string;
  case: {
    id: string; customerName: string; periodStart: string | null; periodEnd: string | null; status: string;
    checklist: { receivedCount: number; requiredCount: number; missingCount: number; evaluatedAt: string | null;
      items: Array<{ name: string; receivedCount: number; requiredCount: number; missingCount: number; status: OpsRequirementProgress["status"] }> };
    files: Array<{ id: string; filename: string; documentTypeCode: string | null; documentTypeName: string | null;
      receivedAt: string; status: WorkbenchDocumentStatus; previewAvailable: boolean; canExclude: boolean;
      canRestoreExclusion: boolean; canResolveReview: boolean; classificationNotice: string | null;
      reviewExplanation: string[]; supervisorReviewRequested: boolean; duplicateNotCounted: boolean;
      processingNotice: string | null }>;
    documentTypes: Array<{ code: string; name: string }>;
    openQuestions: Array<{ id: string; title: string; message: string; publishedAt: string }>;
    actionableIssues: Array<{ id: string; filename: string | null; label: string }>;
    duplicateReview: { count: number; canAcknowledge: boolean };
    completion: { canComplete: boolean; blockers: string[] };
    nextTask: null | { id: string; name: string; status: string; assignee: string | null; dueAt: string | null;
      instructions: string; completionCriteria: string };
  };
}

function projectCaseLists(cases: OpsCaseSummary[], now: Date): WorkbenchCaseLists {
  const activeCases: WorkbenchCaseItem[] = [];
  const completedCases: WorkbenchCaseItem[] = [];
  for (const item of cases) {
    if (item.status === "cancelled") continue;
    const projected = projectCase(item, now);
    if (item.status === "completed") completedCases.push(projected); else activeCases.push(projected);
  }
  return { generatedAt: now.toISOString(), activeCases, completedCases };
}

function projectCase(item: OpsCaseSummary, now: Date): WorkbenchCaseItem {
  const receivedCount = item.requirements.reduce((total, requirement) => total + Math.min(requirement.acceptedCount, requirement.minimumCount), 0);
  const requiredCount = item.requirements.reduce((total, requirement) => total + requirement.minimumCount, 0);
  const missingCount = item.requirements.reduce((total, requirement) => total + requirement.missingCount, 0);
  const reviewCount = item.completeness?.reviewRequiredDocumentCount ?? item.requirements.reduce((total, requirement) => total + requirement.reviewCount, 0);
  const processingCount = item.completeness?.activeSubmissionCount ?? 0;
  const dueAt = item.dueAt === null ? null : new Date(item.dueAt);
  const nextAction = item.status === "completed" ? "completed" : reviewCount > 0 ? "review" : processingCount > 0 ? "processing"
    : missingCount > 0 ? "missing" : item.openIssueCount > 0 ? "issues" : "ready";
  return { id: item.id, customerName: item.subjectName, periodStart: item.periodStart, periodEnd: item.periodEnd,
    status: item.status, dueAt: item.dueAt,
    checklist: { receivedCount, requiredCount, missingCount, reviewCount, processingCount,
      attentionCount: item.openIssueCount, evaluatedAt: item.completeness?.createdAt ?? null }, nextAction,
    labels: { overdue: item.status !== "completed" && dueAt !== null && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() < now.getTime(), missingDocuments: missingCount > 0 } };
}

export function projectCaseDetail(detail: OpsCaseDetail, actorType: string, demoSnapshot: OpsDemoFormSnapshot | null): WorkbenchCaseDetail {
  const checklist = projectChecklist(detail.case);
  const activeIssues = detail.issues.filter((issue) => ["open", "assigned", "waiting_external", "waiting_internal", "reopened"].includes(issue.status));
  const reviewCount = detail.documents.filter((document) => ["review_required", "failed_manual"].includes(document.status)).length;
  const processingCount = detail.documents.filter((document) => ["incoming_saved", "preserved", "processing", "failed_recoverable"].includes(document.status)).length;
  const questions = demoSnapshot?.clientQuestions.filter((question) => question.caseId === detail.case.id && question.status === "published") ?? [];
  const blockers: string[] = [];
  if (checklist.missingCount > 0) blockers.push(`仍缺 ${checklist.missingCount} 项资料`);
  if (reviewCount > 0) blockers.push(`仍有 ${reviewCount} 份资料需要人工确认`);
  if (processingCount > 0) blockers.push(`仍有 ${processingCount} 份资料正在处理`);
  const blockingIssues = activeIssues.filter((issue) => issue.issueType !== "completeness_missing" || checklist.missingCount > 0);
  if (blockingIssues.length > 0) blockers.push(`仍有 ${blockingIssues.length} 个问题未处理`);
  if (questions.length > 0) blockers.push(`仍有 ${questions.length} 个客户问题等待处理`);
  if (detail.case.completeness?.status !== "complete") blockers.push("完整性检查尚未通过");
  return { generatedAt: detail.generatedAt, case: { id: detail.case.id, customerName: detail.case.subjectName,
    periodStart: detail.case.periodStart, periodEnd: detail.case.periodEnd, status: detail.case.status,
    checklist: { ...checklist, items: detail.case.requirements.map(projectRequirement) },
    files: detail.documents.map((document) => projectDocument(document, actorType, detail.case.status)),
    documentTypes: detail.case.requirements.map((item) => ({ code: item.documentTypeCode, name: item.displayName })),
    openQuestions: questions.map((question) => ({ id: question.id, title: question.publicTitle, message: question.publicBody, publishedAt: question.publishedAt })),
    actionableIssues: activeIssues.filter((issue) => issue.issueType !== "completeness_duplicate" && (actorType !== "staff" ||
      !detail.documents.some((doc) => doc.id === issue.documentId && doc.supervisorReviewRequested)))
      .map((issue) => ({ id: issue.id, filename: issue.filename, label: issueLabel(issue.issueType, issue.filename) })),
    duplicateReview: {
      count: detail.case.completeness?.status === "review_required" ? detail.case.completeness.duplicateDocumentCount : 0,
      canAcknowledge: detail.case.status !== "completed" && detail.case.completeness?.status === "review_required"
        && detail.case.completeness.duplicateDocumentCount > 0 && checklist.missingCount === 0
        && reviewCount === 0 && processingCount === 0 && questions.length === 0
        && detail.case.completeness.excessDocumentCount === 0 && detail.case.completeness.unmatchedDocumentCount === 0
        && blockingIssues.every((issue) => issue.issueType === "completeness_duplicate"),
    },
    completion: { canComplete: blockers.length === 0 && detail.case.status !== "completed", blockers: [...new Set(blockers)] },
    nextTask: detail.handoffTask ? { id: detail.handoffTask.id, name: detail.handoffTask.name, status: detail.handoffTask.status,
      assignee: detail.handoffTask.assignedActorName, dueAt: detail.handoffTask.dueAt,
      instructions: detail.handoffTask.instructions, completionCriteria: detail.handoffTask.completionCriteria } : null,
  } };
}

function projectChecklist(item: OpsCaseSummary) {
  return { receivedCount: item.requirements.reduce((total, requirement) => total + Math.min(requirement.acceptedCount, requirement.minimumCount), 0),
    requiredCount: item.requirements.reduce((total, requirement) => total + requirement.minimumCount, 0),
    missingCount: item.requirements.reduce((total, requirement) => total + requirement.missingCount, 0),
    evaluatedAt: item.completeness?.createdAt ?? null };
}

function projectRequirement(requirement: OpsRequirementProgress): WorkbenchCaseDetail["case"]["checklist"]["items"][number] {
  return { name: requirement.displayName, receivedCount: Math.min(requirement.acceptedCount, requirement.minimumCount),
    requiredCount: requirement.minimumCount, missingCount: requirement.missingCount, status: requirement.status };
}

function projectDocument(document: OpsCaseDocument, actorType: string, caseStatus: string): WorkbenchCaseDetail["case"]["files"][number] {
  const active = !["completed", "cancelled"].includes(caseStatus);
  const employee = ["staff", "manager", "admin"].includes(actorType);
  const reviewable = ["review_required", "failed_manual"].includes(document.status);
  const abstentionNotice = /classification_unknown/.test(document.reviewReason ?? "")
    ? "这份资料不属于当前可收集的类型；请核对原件后选择正确类型，或按无关资料排除。"
    : /classification_insufficient_evidence/.test(document.reviewReason ?? "")
      ? "现有内容不足以判断类型；请查看原件，必要时请客户补充清晰、完整且独立的文件。" : null;
  const uncertain = /low_confidence/.test(document.reviewReason ?? "") || (document.conflictFlags ?? []).includes("document_type_conflict");
  return { id: document.id, filename: document.filename, documentTypeCode: document.documentTypeCode,
    documentTypeName: document.documentTypeName, receivedAt: document.createdAt,
    status: workbenchDocumentStatus(document.status), previewAvailable: document.previewAvailable,
    canExclude: active && employee && reviewable,
    canRestoreExclusion: active && employee && document.status === "excluded",
    canResolveReview: active && employee && reviewable && !(actorType === "staff" && document.supervisorReviewRequested),
    classificationNotice: reviewable && abstentionNotice ? abstentionNotice : reviewable && uncertain
      ? `类型尚未可靠确定${document.confidence === null ? "" : `（模型自报置信度 ${Math.round(document.confidence * 100)}%，不代表实际准确率）`}；候选仅供参考，尚未计入清单。`
      : null,
    reviewExplanation: reviewExplanation(document),
    supervisorReviewRequested: document.supervisorReviewRequested === true,
    duplicateNotCounted: document.status === "duplicate_skipped" || document.requirementMatch?.status === "duplicate",
    processingNotice: document.status === "failed_recoverable" && !document.activeError?.nextRetryAt
      ? "系统处理已暂停，请联系管理员检查；不需要重复上传。" : null };
}

function reviewExplanation(document: OpsCaseDocument): string[] {
  const flags = new Set(document.conflictFlags ?? []);
  const reason = document.reviewReason ?? "";
  const messages: string[] = [];
  if (flags.has("subject_conflict")) messages.push("资料上的客户与本次资料收集不一致，请核对原件，不能只确认资料类型。");
  if (flags.has("period_conflict")) messages.push("资料上的业务期间与本次资料收集不一致，请核对日期。");
  if (/conflict/.test(reason) && !messages.length) messages.push("客户、期间或资料类型存在冲突，请核对原件后再决定是否计入。");
  if (/quality/.test(reason)) messages.push("资料质量或分类验证尚不足，需要人工核对。");
  if (/policy_requires_human/.test(reason)) messages.push("这类资料按要求需要会计人员确认，尚未计入清单。");
  if (/low_confidence/.test(reason)) messages.push("系统尚不能可靠确定分类，请查看原件并选择正确类型。");
  if (!/classification_(unknown|insufficient_evidence)/.test(reason) && (document.documentTypeCode === "unknown" || !document.documentTypeCode)) messages.push("系统未确定适用资料类型；核对后可按无关／未知资料排除，原件会保留。");
  if (reason === "exclusion_restored_for_review") messages.push("已撤销排除，恢复为待人工复核；仍未计入清单，请重新核对后决定。");
  if (reason === "operator_requested_information") messages.push("已要求补充；收到补交后仍需处理这份原资料。");
  return messages.length ? messages : ["请查看原件，核对客户、期间和资料类型后再确认。"];
}

function projectToday(overview: OpsOverview, tasks: Array<{ id:string; name:string; caseId:string; subjectName:string; status:string;
  assignedActorId:string|null; dueAt:string|null; instructions:string; completionCriteria:string }>, actorId: string) {
  const reviews = overview.reviewQueue.filter((item) => ["review_required", "failed_manual"].includes(item.status)).map((item) => ({
    kind: "review", id: `review:${item.id}`, documentId: item.id, caseId: item.caseId, customerName: item.subjectName,
    title: item.supervisorReviewRequested ? "待主管处理" : "确认资料分类",
    detail: `${item.filename} · ${/low_confidence|classification_unknown|classification_insufficient_evidence/.test(item.reviewReason ?? "") ? "类型尚未可靠确定；请查看原件" : `待确认建议：${item.documentTypeName ?? "尚未确定类型"}`}`, priority: 0,
  }));
  const missing = overview.cases.filter((item) => item.status !== "completed" && item.requirements.some((requirement) => requirement.missingCount > 0)).map((item) => ({
    kind: "missing", id: `missing:${item.id}`, caseId: item.id, customerName: item.subjectName,
    title: "跟进缺少的资料", detail: `仍缺 ${item.requirements.reduce((sum, value) => sum + value.missingCount, 0)} 项`, priority: 2,
  }));
  const taskActions = tasks.filter((task) => task.assignedActorId === actorId && !["completed", "cancelled"].includes(task.status)).map((task) => ({
    kind: "task", id: `task:${task.id}`, taskId: task.id, caseId: task.caseId, customerName: task.subjectName,
    title: task.name, detail: task.status === "in_progress" ? "正在进行" : "可以开始", priority: 1,
  }));
  return { generatedAt: overview.generatedAt, actions: [...reviews, ...taskActions, ...missing].sort((a,b) => a.priority-b.priority || a.customerName.localeCompare(b.customerName, "zh-CN")) };
}

function projectTasks(tasks: Array<{ id:string; name:string; caseId:string; subjectName:string; periodStart:string|null; periodEnd:string|null;
  status:string; assignedActorId:string|null; assignedActorName:string|null; dueAt:string|null; instructions:string; completionCriteria:string }>, actorId: string) {
  return { tasks: tasks.filter((task) => task.assignedActorId === actorId || task.assignedActorId === null).map((task) => ({
    id: task.id, name: task.name, caseId: task.caseId, customerName: task.subjectName,
    periodStart: task.periodStart, periodEnd: task.periodEnd, status: task.status,
    assignee: task.assignedActorName, dueAt: task.dueAt, instructions: task.instructions,
    completionCriteria: task.completionCriteria, ownedByCurrentOperator: task.assignedActorId === actorId,
  })) };
}

function issueLabel(issueType: string, filename: string | null): string {
  if (issueType === "document_classification_review") return `确认资料分类：${filename ?? "未命名资料"}`;
  if (["document_information_request", "document_information_required"].includes(issueType)) return `等待客户补交：${filename ?? "资料"}`;
  if (issueType === "completeness_missing") return "仍有资料未提交";
  if (issueType === "completeness_review_required") return `资料计入清单前需确认：${filename ?? "资料"}`;
  return filename ? `处理资料问题：${filename}` : "处理资料问题";
}

function workbenchDocumentStatus(status: string): WorkbenchDocumentStatus {
  if (["accepted", "human_confirmed", "archived"].includes(status)) return "automatically_accepted";
  if (["review_required", "failed_manual"].includes(status)) return "awaiting_human_review";
  if (["excluded", "duplicate_skipped"].includes(status)) return "excluded";
  if (status === "failed_recoverable") return "processing_failed";
  return "processing";
}

function isWorkbenchActor(actorType: string): actorType is "staff" | "manager" | "admin" { return ["staff", "manager", "admin"].includes(actorType); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function isDate(value: string): boolean { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assetFor(pathname: string) { if (pathname === "/workbench/app.css") return { filename: "app.css", contentType: "text/css; charset=utf-8", cacheable: true }; if (pathname === "/workbench/app.js") return { filename: "app.js", contentType: "text/javascript; charset=utf-8", cacheable: true }; return null; }
function workbenchHeaders(response: ServerResponse): void { response.setHeader("cache-control", "no-store"); response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); response.setHeader("referrer-policy", "no-referrer"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("x-frame-options", "DENY"); response.setHeader("x-robots-tag", "noindex, nofollow, noarchive"); }

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { sendJson(response, 415, { error: "content_type_must_be_application_json" }); return null; }
  try { const value = await readJsonBody(request, 32_768); if (!isPlainObject(value)) throw new Error("invalid_json"); return value; }
  catch (error) { const tooLarge = error instanceof Error && error.message === "request_body_too_large"; sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? "request_body_too_large" : "invalid_json" }); return null; }
}

async function readJsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  return await new Promise((resolve, reject) => { let bytes = 0; const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximum) { reject(new Error("request_body_too_large")); request.resume(); return; } chunks.push(chunk); });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("invalid_json")); } }); request.on("error", reject); });
}

function sameOrigin(request: IncomingMessage, secure: boolean): boolean { const origin = firstHeader(request.headers.origin); const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host; const protocol = firstHeader(request.headers["x-forwarded-proto"]) ?? (secure ? "https" : "http"); if (!origin || !host) return false; try { return new URL(origin).origin === `${protocol}://${host}`; } catch { return false; } }
function firstHeader(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function sendJson(response: ServerResponse, status: number, body: unknown): true { response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(body)); return true; }
