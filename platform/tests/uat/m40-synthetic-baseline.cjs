const { randomUUID } = require("node:crypto");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const baseUrl = process.env.DOP_UAT_BASE_URL ?? "https://dop-intake-uat-production.up.railway.app";
const email = process.env.DOP_UAT_OPS_EMAIL ?? "aldenli.eth@gmail.com";
const password = process.env.DOP_UAT_OPS_PASSWORD;

if (process.env.DOP_UAT_ACCEPTANCE_CONFIRMED !== "true") {
  throw new Error("DOP_UAT_ACCEPTANCE_CONFIRMED=true is required");
}
if (!password) throw new Error("DOP_UAT_OPS_PASSWORD is required");

let cookie;
let csrfToken;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${path}:${response.status}:${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { response, body };
}

function mutationOptions(body) {
  return {
    method: "POST",
    headers: { cookie, origin: baseUrl, "x-dop-csrf": csrfToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function createPdf(spec) {
  const pdf = await PDFDocument.create();
  const fixedDate = new Date("2026-08-16T00:00:00.000Z");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  pdf.setProducer("Document Operations UAT repeatable synthetic acceptance");
  pdf.setCreator("M40.1 acceptance runner");
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  [
    "SYNTHETIC UAT DOCUMENT - NOT REAL CLIENT DATA",
    `Client: ${spec.client}`,
    `Reporting period: ${spec.period}`,
    `Document type: ${spec.type}`,
    `Synthetic reference: ${spec.reference}`,
    `Document date: ${spec.date}`,
    spec.detail1,
    spec.detail2,
    "All names, identifiers and amounts in this document are fictional.",
  ].forEach((line, index) => page.drawText(line, { x: 42, y: 790 - index * 28, size: 12, font }));
  return Buffer.from(await pdf.save());
}

async function upload(caseId, spec, bytes) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await request(`/v1/ops/cases/${caseId}/documents`, {
        method: "POST",
        headers: {
          cookie, origin: baseUrl, "x-dop-csrf": csrfToken,
          "content-type": "application/pdf", "x-dop-filename": encodeURIComponent(spec.filename),
        },
        body: bytes,
      });
    } catch (error) {
      lastError = error;
      if (![502, 503, 504].includes(error.status) || attempt === 5) throw error;
      await delay(attempt * 1_000);
    }
  }
  throw lastError;
}

async function waitForCase(caseId, predicate, label, timeoutMs = 300_000) {
  const started = Date.now();
  let detail;
  while (Date.now() - started < timeoutMs) {
    detail = (await request(`/v1/ops/cases/${caseId}`, { headers: { cookie } })).body;
    if (predicate(detail)) return detail;
    await delay(2_000);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(summarizeCase(detail))}`);
}

function summarizeCase(detail) {
  return {
    status: detail?.case?.status,
    completeness: detail?.case?.completeness?.status,
    openIssueCount: detail?.case?.openIssueCount,
    documents: detail?.documents?.map((item) => ({ filename: item.filename, status: item.status, reviewReason: item.reviewReason })),
  };
}

function assert(condition, message, evidence) {
  if (!condition) throw new Error(`${message}${evidence === undefined ? "" : `: ${JSON.stringify(evidence)}`}`);
}

function nextQuarter(cases) {
  const latestEnd = cases.filter((item) => item.subjectName === "Blue Peak Consulting Limited" && item.periodEnd)
    .map((item) => item.periodEnd).sort().at(-1) ?? "2026-09-30";
  const start = new Date(`${latestEnd}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
  const due = new Date(end); due.setUTCDate(due.getUTCDate() + 7);
  return { start: day(start), end: day(end), dueAt: due.toISOString() };
}

function day(value) { return value.toISOString().slice(0, 10); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function specs(run, period) {
  const filename = (name) => `M40_1_${run}_${name}.pdf`;
  const common = { caseClient: "Blue Peak Consulting Limited", period: `${period.start} to ${period.end}` };
  const correct = [];
  for (let index = 1; index <= 3; index += 1) correct.push({ ...common, client: common.caseClient, type: "Bank Statement", date: period.end, reference: `${run}-BANK-${index}`, filename: filename(`Bank_${index}`), detail1: "Account: SYNTHETIC-BP-UAT", detail2: `Closing balance: NZD ${1200 + index}.00` });
  for (let index = 1; index <= 3; index += 1) correct.push({ ...common, client: common.caseClient, type: "Invoice", date: period.start, reference: `${run}-INV-${index}`, filename: filename(`Invoice_${index}`), detail1: `Invoice: SYN-${run}-${index}`, detail2: "Total: NZD 575.00 including GST" });
  correct.push({ ...common, client: common.caseClient, type: "Contractor Statement", date: period.end, reference: `${run}-CONTRACTOR`, filename: filename("Contractor_1"), detail1: "Contractor: Fictional Contractor Limited", detail2: "Quarter total: NZD 1800.00" });
  for (let index = 1; index <= 5; index += 1) correct.push({ ...common, client: common.caseClient, type: "Expense Receipt", date: period.start, reference: `${run}-RECEIPT-${index}`, filename: filename(`Receipt_${index}`), detail1: "Merchant: Synthetic Office Supplies", detail2: "Total: NZD 48.50 including GST" });
  const edges = {
    wrongSubject: { ...common, client: "Kauri Coast Cafe Limited", type: "Invoice", date: period.start, reference: `${run}-WRONG-SUBJECT`, filename: filename("Edge_Wrong_Subject"), detail1: "Invoice: SYN-WRONG-SUBJECT", detail2: "Total: NZD 999.00" },
    wrongPeriod: { ...common, client: common.caseClient, period: "2025-01-01 to 2025-03-31", type: "Invoice", date: "2025-01-15", reference: `${run}-WRONG-PERIOD`, filename: filename("Edge_Wrong_Period"), detail1: "Invoice: SYN-WRONG-PERIOD", detail2: "Total: NZD 777.00" },
    unknown: { ...common, client: common.caseClient, type: "Board Meeting Agenda", date: period.start, reference: `${run}-UNKNOWN`, filename: filename("Edge_Unknown_Type"), detail1: "Agenda: fictional strategy workshop", detail2: "This is not an accounting document." },
  };
  const supplement = { ...common, client: common.caseClient, type: "Invoice", date: period.end, reference: `${run}-SUPPLEMENT`, filename: filename("Supplement_Invoice_4"), detail1: "Invoice: SYN-CORRECT-SUPPLEMENT", detail2: "Total: NZD 680.00 including GST" };
  return { correct, edges, supplement };
}

async function review(documentId, action, rationale, exclusionReason) {
  return (await request(`/v1/ops/reviews/${documentId}`, mutationOptions({
    action, rationale, idempotencyKey: randomUUID(), ...(exclusionReason ? { exclusionReason } : {}),
  }))).body;
}

async function transitionTask(taskId, action) {
  return (await request(`/v1/ops/tasks/${taskId}/transitions`, mutationOptions({
    action, assignedActorId: null,
    reason: `M40.1 synthetic acceptance ${action} transition.`, idempotencyKey: randomUUID(),
  }))).body;
}

async function main() {
  const login = await request("/v1/ops/session", {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password, rememberDevice: false }),
  });
  cookie = login.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "session cookie missing");
  const overview = (await request("/v1/ops/overview", { headers: { cookie } })).body;
  csrfToken = overview.csrfToken;
  assert(csrfToken, "CSRF token missing");

  const configurations = (await request("/v1/ops/configurations", { headers: { cookie } })).body;
  const release = configurations.releases.find((item) => item.subjectName === "Blue Peak Consulting Limited" && item.isCurrentPublished);
  assert(release, "published Blue Peak configuration missing");
  const period = nextQuarter(overview.cases);
  const run = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const createdCase = (await request(`/v1/ops/configurations/${release.id}/cases`, mutationOptions({
    periodKey: `M40.1-${run}`, periodStart: period.start, periodEnd: period.end,
    dueAt: period.dueAt, timezone: "Pacific/Auckland", externalReference: `synthetic-m40.1-${run}`,
    reason: "Create an isolated synthetic M40.1 repeatable acceptance Case.", idempotencyKey: randomUUID(),
  }))).body;
  const caseId = createdCase.caseId;
  assert(/^[0-9a-f-]{36}$/i.test(caseId ?? ""), "case creation did not return a UUID", createdCase);

  const fixture = specs(run, period);
  const bytesByFilename = new Map();
  for (const spec of [...fixture.correct, ...Object.values(fixture.edges)]) {
    const bytes = await createPdf(spec);
    bytesByFilename.set(spec.filename, bytes);
    const result = await upload(caseId, spec, bytes);
    assert(result.body.outcome === "completed", "new upload was not accepted", result.body);
  }

  const first = fixture.correct[0];
  const duplicate = await upload(caseId, first, bytesByFilename.get(first.filename));
  assert(duplicate.body.outcome === "duplicate", "exact duplicate was not idempotent", duplicate.body);

  let detail = await waitForCase(caseId, (value) => value.documents.length === 15 && value.documents.every((item) => ["accepted", "review_required", "failed_manual"].includes(item.status)), "initial classification");
  const byName = (name) => detail.documents.find((item) => item.filename === name);
  const wrongSubject = byName(fixture.edges.wrongSubject.filename);
  const wrongPeriod = byName(fixture.edges.wrongPeriod.filename);
  const unknown = byName(fixture.edges.unknown.filename);
  assert(wrongSubject?.status === "review_required" && wrongSubject.reviewReason?.includes("conflict"), "wrong-subject route failed", wrongSubject);
  assert(wrongPeriod?.status === "review_required" && wrongPeriod.reviewReason?.includes("conflict"), "wrong-period route failed", wrongPeriod);
  assert(unknown?.status === "review_required", "unknown-type route failed", unknown);

  const subjectDecision = await review(wrongSubject.id, "exclude", "Synthetic invoice belongs to another subject and must not count.", "wrong_subject");
  assert(subjectDecision.exclusionReason === "wrong_subject", "wrong-subject audit reason missing", subjectDecision);
  const informationDecision = await review(wrongPeriod.id, "request_information", "Correct-period invoice is required before this Case can be completed.");
  assert(informationDecision.issueStatus === "waiting_external", "request-information did not wait externally", informationDecision);
  const unknownDecision = await review(unknown.id, "exclude", "Synthetic board agenda is irrelevant to this accounting Case.", "irrelevant_or_unknown");
  assert(unknownDecision.exclusionReason === "irrelevant_or_unknown", "unknown exclusion audit reason missing", unknownDecision);

  detail = await waitForCase(caseId, (value) => value.issues.some((item) => item.documentId === wrongPeriod.id && item.status === "waiting_external"), "waiting supplement issue");
  const supplementBytes = await createPdf(fixture.supplement);
  const supplementResult = await upload(caseId, fixture.supplement, supplementBytes);
  assert(supplementResult.body.outcome === "completed", "supplement upload failed", supplementResult.body);
  await waitForCase(caseId, (value) => value.documents.some((item) => item.filename === fixture.supplement.filename && item.status === "accepted"), "correct-period supplement");
  const periodDecision = await review(wrongPeriod.id, "exclude", "Synthetic invoice is outside this Case reporting period and is retained only as audit evidence.", "wrong_period");
  assert(periodDecision.exclusionReason === "wrong_period", "wrong-period audit reason missing", periodDecision);

  detail = await waitForCase(caseId, (value) => value.case.completeness?.status === "complete" && value.case.openIssueCount === 0, "complete evidence and resolved issues");
  const accepted = detail.documents.filter((item) => item.status === "accepted");
  const excluded = detail.documents.filter((item) => item.status === "excluded");
  assert(accepted.length === 13, "accepted document count is not 13", summarizeCase(detail));
  assert(excluded.length === 3, "excluded document count is not 3", summarizeCase(detail));
  assert(detail.case.acceptedRequirementCount === detail.case.requiredRequirementCount, "requirements are not complete", detail.case);

  const completion = (await request(`/v1/ops/cases/${caseId}/complete`, mutationOptions({
    reason: "M40.1 synthetic evidence is complete and ready for the governed handoff.",
    assignedActorId: null, idempotencyKey: randomUUID(),
  }))).body;
  assert(completion.outcome === "completed" && completion.taskId, "Case completion did not create one task", completion);
  for (const action of ["start", "wait", "resume", "complete"]) await transitionTask(completion.taskId, action);

  const tasks = (await request("/v1/ops/tasks", { headers: { cookie } })).body;
  const task = tasks.tasks.find((item) => item.id === completion.taskId);
  const transitions = tasks.recentTransitions.filter((item) => item.taskId === completion.taskId);
  assert(task?.status === "completed" && task.externalExecution === "disabled", "Task did not finish safely", task);
  for (const action of ["start", "wait", "resume", "complete"]) {
    assert(transitions.some((item) => item.action === action), `Task ${action} audit transition missing`, transitions);
  }

  const finalDetail = await waitForCase(caseId, (value) => value.case.status === "completed", "completed Case");
  const finalOverview = (await request("/v1/ops/overview", { headers: { cookie } })).body;
  const exclusions = finalOverview.recentReviewDecisions.filter((item) => item.action === "exclude"
    && item.documentId && [wrongSubject.id, wrongPeriod.id, unknown.id].includes(item.documentId));
  const exclusionByDocument = new Map(exclusions.map((item) => [item.documentId, item.exclusionReason]));
  assert(exclusionByDocument.get(wrongSubject.id) === "wrong_subject"
    && exclusionByDocument.get(wrongPeriod.id) === "wrong_period"
    && exclusionByDocument.get(unknown.id) === "irrelevant_or_unknown",
  "three governed exclusion reasons are not visible in audit history", exclusions);
  assert(!finalOverview.recentActivity.some((item) => item.eventType?.startsWith("Delivery.")), "external delivery event was created");

  await request("/v1/ops/session", { method: "DELETE", headers: { cookie, origin: baseUrl, "x-dop-csrf": csrfToken } }).catch(() => undefined);
  console.log(JSON.stringify({
    acceptance: "passed", run, caseId, period,
    documents: { total: finalDetail.documents.length, accepted: 13, excluded: 3, duplicateOutcome: duplicate.body.outcome },
    routes: { wrongSubject: "review_required->excluded:wrong_subject", wrongPeriod: "review_required->waiting_external->supplement->excluded:wrong_period", unknown: "review_required->excluded:irrelevant_or_unknown" },
    completeness: finalDetail.case.completeness?.status,
    caseStatus: finalDetail.case.status,
    task: { id: task.id, status: task.status, transitions: ["start", "wait", "resume", "complete"], externalExecution: task.externalExecution },
    externalDeliveryEvents: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
