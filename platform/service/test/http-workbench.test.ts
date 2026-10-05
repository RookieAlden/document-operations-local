import { createServer, request as httpRequest, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchRouter, type WorkbenchSessionAuthorizer } from "../src/http/workbench-router.js";
import type { OpsCaseDetail, OpsCaseDocument, OpsCaseSummary, OpsOverview } from "../src/ports/ops-read-repository.js";
import type { WorkbenchRepository } from "../src/ports/workbench-repository.js";
import type { ResolveDocumentReview, ResolveDocumentReviewInput } from "../src/application/resolve-document-review.js";

const sessionSecret = "synthetic-workbench-session-secret-longer-than-thirty-two-characters";
const detailCaseId = "00000000-0000-4000-8000-000000000001";
const servers: Server[] = [];

class StubWorkbenchAuthorizer implements WorkbenchSessionAuthorizer {
  authenticated = true;
  actorType = "staff";
  calls = 0;

  async authorize() {
    this.calls += 1;
    if (!this.authenticated) return null;
    return {
      actorId: "actor-1",
      displayName: "Synthetic Operator",
      actorType: this.actorType,
      expiresAt: new Date("2026-08-23T10:00:00.000Z").getTime(),
      cookieValue: "v2.synthetic.signed",
    };
  }
}

class StubCaseRepository {
  cases: OpsCaseSummary[] = [];
  detail: OpsCaseDetail | null = null;
  reads: Array<{ organizationKey: string; now: Date; actorId: string }> = [];
  detailReads: Array<{ organizationKey: string; caseId: string; now: Date; actorId: string }> = [];
  overview: OpsOverview = {
    generatedAt: "2026-08-23T01:00:00.000Z", organizationKey: "dev-accounting-firm",
    operator: { id: "actor-1", displayName: "Synthetic Operator", actorType: "staff" },
    summary: { activeCaseCount: 0, dueSoonCaseCount: 0, overdueCaseCount: 0, reviewDocumentCount: 0,
      openIssueCount: 0, scheduledRetryCount: 0, manualErrorCount: 0, overdueRetryCount: 0 },
    cases: [], reviewQueue: [], issues: [], retryQueue: [], recentActivity: [],
  };

  async listCases(organizationKey: string, now: Date, actorId: string) {
    this.reads.push({ organizationKey, now, actorId });
    return this.cases;
  }

  async getCaseDetail(organizationKey: string, caseId: string, now: Date, actorId: string) {
    this.detailReads.push({ organizationKey, caseId, now, actorId });
    return this.detail;
  }
  async getOverview() { return this.overview; }
}

class StubWorkbenchRepository implements WorkbenchRepository {
  duplicateRequests: Parameters<WorkbenchRepository["acknowledgeDuplicates"]>[1][] = [];
  async acknowledgeDuplicates(_organizationKey: string, request: Parameters<WorkbenchRepository["acknowledgeDuplicates"]>[1]) {
    this.duplicateRequests.push(request); return { outcome: "completed" as const, caseId: request.caseId };
  }
  async escalateReview() { return { outcome: "completed" as const }; }
  createRequests: Parameters<WorkbenchRepository["createClientCase"]>[1][] = [];
  invitationRequests: Parameters<WorkbenchRepository["issueInvitation"]>[1][] = [];
  createResult: Awaited<ReturnType<WorkbenchRepository["createClientCase"]>> = {
    outcome: "completed", commandId: "00000000-0000-4000-8000-000000000101",
    subjectId: "00000000-0000-4000-8000-000000000102", releaseId: "00000000-0000-4000-8000-000000000103",
    caseId: detailCaseId, syntheticOnly: true, externalCalls: 0,
  };
  invitationResult: Awaited<ReturnType<WorkbenchRepository["issueInvitation"]>> = {
    outcome: "completed", invitationId: "00000000-0000-4000-8000-000000000104",
    caseId: detailCaseId, status: "active", validUntil: "2026-09-06T01:00:00.000Z",
  };
  async getSetup(_organizationKey: string, now: Date) {
    return { generatedAt: now.toISOString(), serviceOptions: [{
      id: "00000000-0000-4000-c600-000000006202", name: "季度会计资料基础包",
      description: "季度资料收集", frequency: "quarterly" as const,
      requirements: [{ code: "bank.minimum", name: "银行流水", minimumCount: 3, maximumCount: 3 }],
    }] };
  }
  async createClientCase(_organizationKey: string, request: Parameters<WorkbenchRepository["createClientCase"]>[1]) {
    this.createRequests.push(request); return this.createResult;
  }
  async issueInvitation(_organizationKey: string, request: Parameters<WorkbenchRepository["issueInvitation"]>[1]) {
    this.invitationRequests.push(request); return this.invitationResult;
  }
}

function caseSummary(overrides: Partial<OpsCaseSummary> = {}): OpsCaseSummary {
  return {
    id: "case-active",
    subjectKey: "synthetic-client",
    subjectName: "Synthetic Client Limited",
    periodStart: "2026-07-01",
    periodEnd: "2026-09-30",
    status: "waiting_for_documents",
    riskStatus: "normal",
    dueAt: "2026-08-20T00:00:00.000Z",
    acceptedRequirementCount: 1,
    requiredRequirementCount: 3,
    documentCount: 1,
    openIssueCount: 9,
    requirements: [{
      requirementCode: "bank.minimum",
      documentTypeCode: "bank_statement",
      displayName: "Bank statement",
      minimumCount: 3,
      maximumCount: 3,
      acceptedCount: 1,
      missingCount: 2,
      reviewCount: 0,
      duplicateCount: 0,
      excessCount: 0,
      status: "missing",
    }],
    completeness: {
      id: "assessment-latest",
      status: "incomplete",
      algorithmVersion: "1.0",
      inputHash: "a".repeat(64),
      matchedDocumentCount: 1,
      missingRequirementCount: 1,
      duplicateDocumentCount: 0,
      excessDocumentCount: 0,
      reviewRequiredDocumentCount: 0,
      unmatchedDocumentCount: 0,
      activeSubmissionCount: 0,
      createdAt: "2026-08-22T23:00:00.000Z",
    },
    ...overrides,
  };
}

function caseDocument(status: string, overrides: Partial<OpsCaseDocument> = {}): OpsCaseDocument {
  return {
    id: `document-${status}`,
    filename: `${status}.pdf`,
    declaredMimeType: "application/pdf",
    detectedMimeType: "application/pdf",
    sizeBytes: 128,
    status,
    documentTypeCode: "bank_statement",
    documentTypeName: "Bank statement",
    confidence: 0.998,
    reviewReason: "technical detail must stay internal",
    createdAt: "2026-08-23T00:10:00.000Z",
    updatedAt: "2026-08-23T00:20:00.000Z",
    previewAvailable: true,
    relation: { kind: "same_content", position: 2, total: 2 },
    latestAttempt: {
      attemptNumber: 3,
      status: "failed",
      errorCode: "provider_timeout",
      startedAt: "2026-08-23T00:10:00.000Z",
      completedAt: "2026-08-23T00:11:00.000Z",
    },
    activeError: {
      errorCode: "provider_timeout",
      errorClass: "timeout",
      status: "retry_scheduled",
      retryCount: 2,
      nextRetryAt: "2026-08-23T00:30:00.000Z",
      openedAt: "2026-08-23T00:11:00.000Z",
    },
    requirementMatch: {
      status: "matched",
      requirementCode: "bank.minimum",
      duplicateKind: "none",
      isExcess: false,
      countsTowardMinimum: true,
      reasonCode: "document_type_matches_requirement",
    },
    ...overrides,
  };
}

function caseDetail(): OpsCaseDetail {
  return {
    generatedAt: "2026-08-23T01:00:00.000Z",
    case: caseSummary({ id: detailCaseId }),
    documents: [
      caseDocument("incoming_saved"),
      caseDocument("accepted"),
      caseDocument("review_required"),
      caseDocument("excluded"),
      caseDocument("failed_recoverable"),
      caseDocument("human_confirmed"),
      caseDocument("failed_manual"),
      caseDocument("duplicate_skipped"),
    ],
    issues: [{
      id: "issue-internal",
      caseId: detailCaseId,
      documentId: "document-review_required",
      subjectName: "Synthetic Client Limited",
      issueType: "document_review_required",
      severity: "medium",
      status: "open",
      routingReason: "technical reason",
      filename: "review_required.pdf",
      dueAt: null,
      openedAt: "2026-08-23T00:20:00.000Z",
    }],
    missingDocumentRequestDraft: null,
    reminders: [],
    handoffTask: {
      id: "task-internal",
      name: "准备 Synthetic Client Limited 2026年第三季度会计工作",
      taskType: "case-handoff",
      status: "open",
      assignedActorId: null,
      assignedActorName: null,
      dueAt: null,
      instructions: "核对资料收集结果并开始后续会计处理。",
      completionCriteria: "后续处理已经完成并留下可审计的结果。",
      createdAt: "2026-08-23T00:20:00.000Z",
      externalExecution: "disabled",
    },
    recentActivity: [{
      id: "event-internal",
      eventType: "document.accepted",
      aggregateType: "document",
      aggregateId: "document-accepted",
      occurredAt: "2026-08-23T00:20:00.000Z",
    }],
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start() {
  const authorizer = new StubWorkbenchAuthorizer();
  const caseRepository = new StubCaseRepository();
  const workbenchRepository = new StubWorkbenchRepository();
  const reviewRequests: ResolveDocumentReviewInput[] = [];
  const reviewHandler = { execute: async (input: ResolveDocumentReviewInput) => {
    reviewRequests.push(input);
    return { outcome: "completed" as const, decisionId: "decision-1", eventId: "event-1",
      documentId: input.documentId, action: input.action, exclusionReason: input.exclusionReason ?? null,
      documentStatus: "human_confirmed", documentTypeCode: input.documentTypeCode ?? "gst_workpaper",
      issueStatus: "resolved", decidedAt: input.now.toISOString() };
  } } as unknown as ResolveDocumentReview;
  const router = new WorkbenchRouter({
    sessionAuthorizer: authorizer,
    caseRepository,
    workbenchRepository,
    reviewHandler,
    organizationKey: "dev-accounting-firm",
    sessionSecret,
    staticDirectory: fileURLToPath(new URL("../public/workbench", import.meta.url)),
    clientPortalOrigin: "https://uat.example.invalid",
    secureCookie: false,
    now: () => new Date("2026-08-23T01:00:00.000Z"),
  });
  const server = createServer(async (request, response) => {
    if (!await router.handle(request, response)) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, authorizer, caseRepository, workbenchRepository, reviewRequests };
}

async function call(server: Server, path: string, cookie?: string, options: { method?: string; body?: unknown; headers?: Record<string,string> } = {}) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const headers = {
      ...(options.method === "POST" ? { origin: `http://127.0.0.1:${address.port}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    };
    const request = httpRequest({ host: "127.0.0.1", port: address.port, path, method: options.method ?? "GET", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

describe("firm workbench HTTP boundary", () => {
  it("acknowledges duplicates with the authenticated employee and CSRF, never a supplied actor", async () => {
    const { server, workbenchRepository } = await start();
    const path = `/v1/workbench/cases/${detailCaseId}/acknowledge-duplicates`;
    const body = { actorId: "forged-manager", idempotencyKey: "00000000-0000-4000-8000-000000000421" };
    expect((await call(server, path, "dop_ops_session=signed", { method: "POST", body })).status).toBe(403);
    expect(workbenchRepository.duplicateRequests).toHaveLength(0);
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    expect((await call(server, path, "dop_ops_session=signed", { method: "POST", body,
      headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken } })).status).toBe(200);
    expect(workbenchRepository.duplicateRequests[0]).toMatchObject({ actorId: "actor-1", caseId: detailCaseId });
  });

  it("separates duplicate acknowledgement from customer questions and blocks it until other work is done", async () => {
    const { server, caseRepository } = await start();
    const detail = caseDetail();
    detail.documents = [caseDocument("accepted"), caseDocument("duplicate_skipped")];
    detail.case.requirements = detail.case.requirements.map(item => ({ ...item, acceptedCount: 3, missingCount: 0 }));
    detail.case.completeness = { ...detail.case.completeness!, status: "review_required", missingRequirementCount: 0,
      duplicateDocumentCount: 1, reviewRequiredDocumentCount: 0, unmatchedDocumentCount: 0, excessDocumentCount: 0 };
    detail.issues = [{ ...detail.issues[0]!, issueType: "completeness_duplicate", documentId: null }];
    caseRepository.detail = detail;
    const get = async () => JSON.parse((await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed")).text).case;
    expect(await get()).toMatchObject({ actionableIssues: [], duplicateReview: { count: 1, canAcknowledge: true }, completion: { canComplete: false } });
    detail.documents.push(caseDocument("review_required"));
    expect((await get()).duplicateReview.canAcknowledge).toBe(false);
    detail.documents.pop(); detail.issues.push({ ...detail.issues[0]!, issueType: "document_review_required" });
    expect((await get()).duplicateReview.canAcknowledge).toBe(false);
  });
  it("serves the isolated employee shell with exactly three daily-work navigation entries", async () => {
    const { server } = await start();
    const shell = await call(server, "/workbench");
    const script = await call(server, "/workbench/app.js");
    const stylesheet = await call(server, "/workbench/app.css");

    expect(shell.status).toBe(200);
    expect(shell.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(shell.text).toContain("员工工作台");
    for (const view of ["today", "cases", "completed"]) {
      expect(shell.text).toContain(`data-view="${view}"`);
    }
    expect(shell.text).not.toContain('data-view="metrics"');
    expect(script.text).toContain('fetch("/v1/workbench/session")');
    expect(script.text).toContain('fetch("/v1/ops/session"');
    expect(script.text).toContain('fetch("/v1/workbench/cases")');
    expect(script.text).not.toContain("/v1/ops/overview");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.text).toContain("prefers-reduced-motion:reduce");
  });

  it.each(["staff", "manager", "admin"])("allows an authenticated %s actor to restore the workbench session", async (actorType) => {
    const { server, authorizer } = await start();
    authorizer.actorType = actorType;

    const response = await call(server, "/v1/workbench/session", "dop_ops_session=signed");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      operator: { displayName: "Synthetic Operator", actorType },
      expiresAt: "2026-08-23T10:00:00.000Z",
    });
    expect(JSON.parse(response.text).csrfToken).toEqual(expect.any(String));
  });

  it("returns 401 when no active shared session exists", async () => {
    const { server, authorizer } = await start();
    authorizer.authenticated = false;

    const response = await call(server, "/v1/workbench/session");
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: "session_required" });
  });

  it("creates a synthetic client and Case through one CSRF-protected employee command", async () => {
    const { server, workbenchRepository } = await start();
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    const response = await call(server, "/v1/workbench/client-cases", "dop_ops_session=signed", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken },
      body: {
        customerName: "星河二号咨询有限公司",
        contactName: "虚构联系人",
        serviceOptionId: "00000000-0000-4000-c600-000000006202",
        periodStart: "2026-10-01",
        periodEnd: "2026-12-31",
        idempotencyKey: "00000000-0000-4000-8000-000000000202",
        requirements: [{ code: "bank.minimum", minimumCount: 3, maximumCount: 3 }],
      },
    });

    expect(response.status).toBe(201);
    expect(JSON.parse(response.text)).toMatchObject({ outcome: "completed", caseId: detailCaseId, externalCalls: 0 });
    expect(workbenchRepository.createRequests).toHaveLength(1);
    expect(workbenchRepository.createRequests[0]).toMatchObject({ actorId: "actor-1", displayName: "星河二号咨询有限公司" });
  });

  it("reconstructs the same governed client link when invitation delivery is retried", async () => {
    const { server, workbenchRepository } = await start();
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken },
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000203" },
    };
    const first = await call(server, `/v1/workbench/cases/${detailCaseId}/invitations`, "dop_ops_session=signed", request);
    workbenchRepository.invitationResult = {
      outcome: "duplicate", invitationId: "00000000-0000-4000-8000-000000000104",
      caseId: detailCaseId, status: "active", validUntil: "2026-09-06T01:00:00.000Z",
    };
    const replay = await call(server, `/v1/workbench/cases/${detailCaseId}/invitations`, "dop_ops_session=signed", request);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(JSON.parse(first.text).submissionUrl).toBe(JSON.parse(replay.text).submissionUrl);
    expect(JSON.parse(first.text).submissionUrl).toMatch(/^https:\/\/uat\.example\.invalid\/submit#access=/);
    expect(workbenchRepository.invitationRequests).toHaveLength(2);
  });

  it("rejects mutations without same-origin CSRF verification", async () => {
    const { server, workbenchRepository } = await start();
    const response = await call(server, "/v1/workbench/client-cases", "dop_ops_session=signed", {
      method: "POST", headers: { "content-type": "application/json" }, body: {},
    });
    expect(response.status).toBe(403);
    expect(workbenchRepository.createRequests).toHaveLength(0);
  });

  it("recovers a valid existing link across browsers without exposing recovery material", async () => {
    const { server, workbenchRepository } = await start();
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    const key = "00000000-0000-4000-8000-000000000203";
    const token = createHmac("sha256", sessionSecret).update(`workbench-client-invitation:${key}`).digest("base64url");
    workbenchRepository.invitationResult = { outcome: "duplicate", invitationId: detailCaseId, caseId: detailCaseId,
      status: "active", validUntil: "2026-09-06T01:00:00.000Z", recoveryKey: key,
      tokenSha256: createHash("sha256").update(token).digest("hex"), remainingSubmissions: 7 };
    const response = await call(server, `/v1/workbench/cases/${detailCaseId}/invitations`, "dop_ops_session=signed", {
      method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken },
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000204" } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ remainingSubmissions: 7,
      submissionUrl: `https://uat.example.invalid/submit#access=${token}` });
    expect(response.text).not.toMatch(/recoveryKey|tokenSha256/);
  });

  it.each(["expired", "revoked", "mismatched_token"])("never returns a broken invitation for %s", async (failure) => {
    const { server, workbenchRepository } = await start();
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    workbenchRepository.invitationResult = { outcome: "duplicate", invitationId: detailCaseId, caseId: detailCaseId,
      status: failure === "revoked" ? "revoked" : "active",
      validUntil: failure === "expired" ? "2026-08-01T00:00:00Z" : "2026-09-06T01:00:00Z",
      ...(failure === "mismatched_token" ? { recoveryKey: detailCaseId, tokenSha256: "b".repeat(64) } : {}) };
    const response = await call(server, `/v1/workbench/cases/${detailCaseId}/invitations`, "dop_ops_session=signed", {
      method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken },
      body: { idempotencyKey: "00000000-0000-4000-8000-000000000204" } });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.text)).toMatchObject({ reason: "invitation_unavailable", canRenew: true });
    expect(response.text).not.toContain("submissionUrl");
  });

  it("projects business conflict explanations, duplicate counting and paused processing", async () => {
    const { server, caseRepository } = await start();
    caseRepository.detail = caseDetail();
    caseRepository.detail.documents = [
      caseDocument("review_required", { conflictFlags: ["subject_conflict", "period_conflict"], supervisorReviewRequested: true }),
      caseDocument("duplicate_skipped"),
      caseDocument("failed_recoverable", { activeError: null }),
    ];
    const result = JSON.parse((await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed")).text);
    expect(result.case.files[0].reviewExplanation.join(" ")).toMatch(/客户.*期间/);
    expect(result.case.files[0].supervisorReviewRequested).toBe(true);
    expect(result.case.files[0].canExclude).toBe(true);
    expect(result.case.files[0].canResolveReview).toBe(false);
    expect(result.case.files[1].duplicateNotCounted).toBe(true);
    expect(result.case.files[2].processingNotice).toContain("不需要重复上传");
  });

  it("shows a 1% conflicting candidate as uncertain, not a reliable classification", async () => {
    const { server, caseRepository } = await start(); caseRepository.detail = caseDetail();
    caseRepository.detail.documents = [caseDocument("review_required", {
      documentTypeCode: "contractor_statement", documentTypeName: "Contractor Statement",
      confidence: 0.01, reviewReason: "low_confidence,conflict_flags_present", conflictFlags: ["document_type_conflict"],
    })];
    const result = JSON.parse((await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed")).text);
    expect(result.case.files[0]).toMatchObject({ status: "awaiting_human_review", canExclude: true });
    expect(result.case.files[0].classificationNotice).toContain("1%");
    expect(result.case.files[0].classificationNotice).toContain("不代表实际准确率");
    expect(result.case.files[0].classificationNotice).toContain("尚未计入清单");
  });

  it("offers staff recovery only for exclusions in open Cases, never for duplicates or accepted files", async () => {
    const { server, caseRepository } = await start(); caseRepository.detail = caseDetail();
    caseRepository.detail.documents = [caseDocument("excluded"), caseDocument("duplicate_skipped"), caseDocument("human_confirmed")];
    const read = async () => JSON.parse((await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed")).text);
    expect((await read()).case.files.map((file: { canRestoreExclusion: boolean }) => file.canRestoreExclusion)).toEqual([true,false,false]);
    caseRepository.detail.case.status = "completed";
    expect((await read()).case.files.map((file: { canRestoreExclusion: boolean }) => file.canRestoreExclusion)).toEqual([false,false,false]);
  });

  it("separates active and completed Cases while projecting only current checklist business fields", async () => {
    const { server, caseRepository } = await start();
    caseRepository.cases = [
      caseSummary(),
      caseSummary({
        id: "case-completed",
        subjectName: "Completed Client Limited",
        status: "completed",
        requirements: [{
          ...caseSummary().requirements[0]!, acceptedCount: 3, missingCount: 0, status: "complete",
        }],
        completeness: { ...caseSummary().completeness!, id: "assessment-completed", status: "complete" },
      }),
      caseSummary({ id: "case-cancelled", status: "cancelled" }),
    ];

    const response = await call(server, "/v1/workbench/cases", "dop_ops_session=signed");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text);
    expect(body.activeCases).toEqual([{
      id: "case-active",
      customerName: "Synthetic Client Limited",
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      status: "waiting_for_documents",
      dueAt: "2026-08-20T00:00:00.000Z",
      checklist: { receivedCount: 1, requiredCount: 3, missingCount: 2, reviewCount: 0, processingCount: 0,
        attentionCount: 9, evaluatedAt: "2026-08-22T23:00:00.000Z" },
      nextAction: "missing",
      labels: { overdue: true, missingDocuments: true },
    }]);
    expect(body.completedCases).toHaveLength(1);
    expect(body.completedCases[0]).toMatchObject({
      id: "case-completed",
      checklist: { receivedCount: 3, requiredCount: 3, missingCount: 0 }, nextAction: "completed",
      labels: { overdue: false, missingDocuments: false },
    });
    expect(response.text).not.toMatch(/issue|retry|manifest|event|confidence/i);
    expect(caseRepository.reads).toEqual([{
      organizationKey: "dev-accounting-firm",
      now: new Date("2026-08-23T01:00:00.000Z"),
      actorId: "actor-1",
    }]);
  });

  it("does not label a Case ready while review, processing, or business issues remain", async () => {
    const { server, caseRepository } = await start();
    caseRepository.cases = [
      caseSummary({ id: "case-review", requirements: [{ ...caseSummary().requirements[0]!, acceptedCount: 3, missingCount: 0, reviewCount: 1 }],
        completeness: { ...caseSummary().completeness!, status: "review_required", reviewRequiredDocumentCount: 1 } }),
      caseSummary({ id: "case-processing", requirements: [{ ...caseSummary().requirements[0]!, acceptedCount: 3, missingCount: 0 }],
        completeness: { ...caseSummary().completeness!, activeSubmissionCount: 2 } }),
      caseSummary({ id: "case-issues", requirements: [{ ...caseSummary().requirements[0]!, acceptedCount: 3, missingCount: 0 }],
        openIssueCount: 1, completeness: { ...caseSummary().completeness!, status: "complete" } }),
    ];
    const body = JSON.parse((await call(server, "/v1/workbench/cases", "dop_ops_session=signed")).text);
    expect(body.activeCases.map((item: { nextAction: string }) => item.nextAction)).toEqual(["review", "processing", "issues"]);
  });

  it("requires the shared workbench session before reading Cases", async () => {
    const { server, authorizer, caseRepository } = await start();
    authorizer.authenticated = false;

    expect((await call(server, "/v1/workbench/cases")).status).toBe(401);
    expect(caseRepository.reads).toHaveLength(0);
  });

  it("puts a human review ahead of missing-document suggestions and hides recoverable retries", async () => {
    const { server, caseRepository } = await start();
    caseRepository.overview = {
      ...caseRepository.overview,
      cases: [caseSummary({ id: detailCaseId, subjectName: "银蕨创意咨询有限公司（虚构）" })],
      reviewQueue: [{ id: "00000000-0000-4000-8000-000000000301", caseId: detailCaseId,
        subjectName: "银蕨创意咨询有限公司（虚构）", periodStart: "2026-07-01", periodEnd: "2026-09-30",
        filename: "Yinjue_GST_Workpaper_2026-Q3.pdf", status: "review_required", documentTypeCode: "gst_workpaper",
        documentTypeName: "GST Workpaper", confidence: 0.99, reviewReason: "policy_requires_human_confirmation",
        updatedAt: "2026-08-23T00:00:00.000Z", availableDocumentTypes: [] },
        { id: "00000000-0000-4000-8000-000000000302", caseId: detailCaseId,
          subjectName: "银蕨创意咨询有限公司（虚构）", periodStart: "2026-07-01", periodEnd: "2026-09-30",
          filename: "retry.pdf", status: "failed_recoverable", documentTypeCode: null, documentTypeName: null,
          confidence: null, reviewReason: null, updatedAt: "2026-08-23T00:00:00.000Z", availableDocumentTypes: [] }],
    };
    const response = await call(server, "/v1/workbench/today", "dop_ops_session=signed");
    expect(response.status).toBe(200);
    const actions = JSON.parse(response.text).actions;
    expect(actions[0]).toMatchObject({ kind: "review", customerName: "银蕨创意咨询有限公司（虚构）", title: "确认资料分类" });
    expect(actions.filter((item: { kind: string }) => item.kind === "review")).toHaveLength(1);
    expect(response.text).not.toContain("retry.pdf");
    const review = caseRepository.overview.reviewQueue[0]!;
    review.reviewReason = "low_confidence,conflict_flags_present";
    review.documentTypeName = "Contractor Statement";
    review.confidence = 0.01;
    const uncertain = await call(server, "/v1/workbench/today", "dop_ops_session=signed");
    expect(uncertain.text).toContain("类型尚未可靠确定");
    expect(uncertain.text).not.toContain("Contractor Statement");
  });

  it("lets a staff member confirm a review through the workbench CSRF boundary", async () => {
    const { server, reviewRequests } = await start();
    const session = JSON.parse((await call(server, "/v1/workbench/session", "dop_ops_session=signed")).text);
    const documentId = "00000000-0000-4000-8000-000000000301";
    const response = await call(server, `/v1/workbench/reviews/${documentId}`, "dop_ops_session=signed", {
      method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": session.csrfToken },
      body: { action: "confirm", rationale: "员工已查看原件并确认系统分类正确。", idempotencyKey: "00000000-0000-4000-8000-000000000401" },
    });
    expect(response.status).toBe(200);
    expect(reviewRequests).toHaveLength(1);
    expect(reviewRequests[0]).toMatchObject({ actorId: "actor-1", documentId, action: "confirm" });
  });

  it("projects a read-only Case detail with exactly five file business statuses", async () => {
    const { server, caseRepository } = await start();
    caseRepository.detail = caseDetail();

    const response = await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text);
    expect(body).toMatchObject({
      generatedAt: "2026-08-23T01:00:00.000Z",
      case: {
        id: detailCaseId,
        customerName: "Synthetic Client Limited",
        periodStart: "2026-07-01",
        periodEnd: "2026-09-30",
        checklist: {
          receivedCount: 1,
          requiredCount: 3,
          missingCount: 2,
          evaluatedAt: "2026-08-22T23:00:00.000Z",
          items: [{
            name: "Bank statement",
            receivedCount: 1,
            requiredCount: 3,
            missingCount: 2,
            status: "missing",
          }],
        },
        files: [
          expect.objectContaining({ filename: "incoming_saved.pdf", status: "processing" }),
          expect.objectContaining({ filename: "accepted.pdf", status: "automatically_accepted" }),
          expect.objectContaining({ filename: "review_required.pdf", status: "awaiting_human_review" }),
          expect.objectContaining({ filename: "excluded.pdf", status: "excluded" }),
          expect.objectContaining({ filename: "failed_recoverable.pdf", status: "processing_failed" }),
          expect.objectContaining({ filename: "human_confirmed.pdf", status: "automatically_accepted" }),
          expect.objectContaining({ filename: "failed_manual.pdf", status: "awaiting_human_review" }),
          expect.objectContaining({ filename: "duplicate_skipped.pdf", status: "excluded" }),
        ],
      },
    });
    expect(new Set(body.case.files.map((file: { status: string }) => file.status))).toEqual(new Set([
      "processing", "automatically_accepted", "awaiting_human_review", "excluded", "processing_failed",
    ]));
    const forbiddenKeys = [
      "confidence", "reviewReason", "relation", "latestAttempt", "activeError",
      "requirementMatch", "issues", "missingDocumentRequestDraft", "reminders", "handoffTask", "recentActivity",
      "subjectKey", "riskStatus", "openIssueCount", "completeness",
    ];
    expect(allKeys(body)).not.toEqual(expect.arrayContaining(forbiddenKeys));
    expect(caseRepository.detailReads).toEqual([{
      organizationKey: "dev-accounting-firm",
      caseId: detailCaseId,
      now: new Date("2026-08-23T01:00:00.000Z"),
      actorId: "actor-1",
    }]);
  });

  it("rejects invalid Case identifiers before the repository read", async () => {
    const { server, caseRepository } = await start();

    const response = await call(server, "/v1/workbench/cases/not-a-case", "dop_ops_session=signed");
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toEqual({ error: "invalid_identifier" });
    expect(caseRepository.detailReads).toHaveLength(0);
  });

  it("returns 404 without exposing whether a Case exists outside the current tenant", async () => {
    const { server, caseRepository } = await start();

    const response = await call(server, `/v1/workbench/cases/${detailCaseId}`, "dop_ops_session=signed");
    expect(response.status).toBe(404);
    expect(JSON.parse(response.text)).toEqual({ outcome: "not_found", resource: "case" });
    expect(caseRepository.detailReads).toHaveLength(1);
  });

  it.each(["customer", "service"])("returns 403 for an authenticated %s actor", async (actorType) => {
    const { server, authorizer } = await start();
    authorizer.actorType = actorType;

    const response = await call(server, "/v1/workbench/session", "dop_ops_session=signed");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toEqual({ error: "workbench_access_required" });
  });

  it("does not claim the existing operations or client submission routes", async () => {
    const { server, authorizer } = await start();

    expect((await call(server, "/ops")).status).toBe(404);
    expect((await call(server, "/submit")).status).toBe(404);
    expect(authorizer.calls).toBe(0);
  });
});

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allKeys(nested)]);
}
