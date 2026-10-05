const elements = {
  loading: document.querySelector("#loading-view"), error: document.querySelector("#error-view"),
  errorMessage: document.querySelector("#error-message"), portal: document.querySelector("#portal-view"),
  organizationName: document.querySelector("#organization-name"), caseTitle: document.querySelector("#case-title"),
  periodLabel: document.querySelector("#period-label"), overallStatus: document.querySelector("#overall-status"),
  progressSummary: document.querySelector("#progress-summary"), progressBar: document.querySelector("#progress-bar"),
  requirements: document.querySelector("#requirements-list"), questions: document.querySelector("#questions-list"),
  questionsSection: document.querySelector("#questions-section"), documents: document.querySelector("#documents-list"),
  refresh: document.querySelector("#refresh-button"), uploadButton: document.querySelector("#open-upload-button"),
  uploadHelp: document.querySelector("#upload-help"), invitationMeta: document.querySelector("#invitation-meta"),
  uploadReturn: document.querySelector("#upload-return"), uploadedRefresh: document.querySelector("#uploaded-refresh-button"),
  lastUpdated: document.querySelector("#last-updated"),
};

const token = portalToken();
let snapshot = null;
let loading = false;
let timer = null;
let uploadOpenedAt = 0;

if (!token) showError("专属链接缺少访问凭证。请使用会计人员提供的完整链接。");
else {
  bindActions();
  void refresh();
  timer = window.setInterval(() => { if (!document.hidden && !loading) void refresh(true); }, 15_000);
}

function portalToken() {
  const fragment = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const value = fragment.get("access");
  return value && /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : null;
}

function bindActions() {
  elements.refresh.addEventListener("click", () => void refresh());
  elements.uploadedRefresh.addEventListener("click", () => void refresh());
  elements.uploadButton.addEventListener("click", noteUploadOpened);
  document.addEventListener("visibilitychange", refreshAfterUpload);
  window.addEventListener("focus", refreshAfterUpload);
  window.addEventListener("pagehide", () => { if (timer) window.clearInterval(timer); }, { once: true });
}

async function refresh(quiet = false) {
  if (loading) return;
  loading = true;
  elements.refresh.disabled = true;
  elements.uploadedRefresh.disabled = true;
  if (!quiet) elements.refresh.textContent = "正在刷新…";
  try {
    const response = await fetch("/v1/client-portal/case", {
      headers: { authorization: `DOP-Portal ${token}` }, cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 429 ? "请求过于频繁，请稍后再试。" : "这个链接可能已过期或已被撤销。");
    snapshot = await response.json();
    render(snapshot);
  } catch (error) {
    showError(error instanceof Error ? error.message : "暂时无法读取资料状态，请稍后再试。");
  } finally {
    loading = false;
    elements.refresh.disabled = false;
    elements.uploadedRefresh.disabled = false;
    elements.refresh.textContent = "刷新状态";
  }
}

function render(data) {
  elements.loading.hidden = true;
  elements.error.hidden = true;
  elements.portal.hidden = false;
  elements.organizationName.textContent = data.organizationName;
  elements.caseTitle.textContent = `${data.subjectName} 的资料提交`;
  elements.periodLabel.textContent = `业务期间：${data.periodKey}`;
  renderOverall(data);
  renderRequirements(data);
  renderQuestions(data.questions);
  renderDocuments(data.documents);
  renderUpload(data);
  elements.lastUpdated.textContent = `状态更新于 ${formatDateTime(data.updatedAt)}`;
}

function renderOverall(data) {
  const content = {
    complete: ["资料已经齐全，当前无需继续操作", "会计人员已确认清单和问题均已处理。请保留此链接以便查看。", "is-complete"],
    needs_action: ["需要您补交资料", "请先查看下方会计人员提出的问题。", "is-action"],
    processing: ["资料正在处理中", "系统或会计人员正在核对刚提交的文件。", "is-processing"],
    missing: ["资料尚未齐全", "请按下方清单继续上传仍缺少的项目。", "is-action"],
    in_review: ["等待会计人员确认", "您暂时无需重复上传；如果需要补充，会计人员会在本页提出问题。", "is-review"],
  }[data.portalStatus] ?? ["正在核对资料", "请稍后刷新查看最新结果。", "is-processing"];
  elements.overallStatus.className = `overall-status ${content[2]}`;
  replace(elements.overallStatus, node("strong", content[0]), node("span", content[1]));
}

function renderRequirements(data) {
  const ratio = data.requiredCount > 0 ? Math.min(data.acceptedRequirementCount / data.requiredCount, 1) : 0;
  elements.progressBar.value = Math.round(ratio * 100);
  elements.progressSummary.textContent = `${data.acceptedRequirementCount} / ${data.requiredCount} 已接受`;
  replace(elements.requirements, ...data.requirements.map((item) => {
    const row = node("div", "", "requirement-row");
    const name = node("div");
    name.append(node("strong", item.displayName), node("small", `最低需要 ${item.minimumCount} 份`));
    const progress = [`已接受 ${item.acceptedCount}`];
    if (item.reviewCount > 0) progress.push(`待确认 ${item.reviewCount}`);
    if (item.missingCount > 0) progress.push(`仍缺 ${item.missingCount}`);
    const count = node("span", progress.join(" · "), "requirement-count");
    const label = item.status === "accepted" ? "已满足" : item.status === "in_review" ? "待会计确认" : "仍缺少";
    row.append(name, count, status(label, item.status));
    return row;
  }));
}

function renderQuestions(items) {
  elements.questionsSection.hidden = false;
  if (items.length === 0) {
    replace(elements.questions, node("p", "当前没有需要您处理的问题。", "question-empty"));
    return;
  }
  replace(elements.questions, ...items.map((item) => {
    const region = node("article", "", "question");
    region.append(node("strong", item.title), node("p", item.body),
      node("div", `需要动作：补交资料 · ${formatDateTime(item.publishedAt)}`, "question-meta"));
    return region;
  }));
}

function renderDocuments(items) {
  if (items.length === 0) {
    replace(elements.documents, node("p", "还没有提交资料。使用下方上传表单提交第一批文件。", "document-empty"));
    return;
  }
  const labels = { submitted: "已提交", processing: "系统处理中", in_review: "待会计确认", accepted: "已接受", needs_supplement: "需要补交" };
  const notes = { duplicate_not_counted: "同内容重复，不重复计入清单", not_counted: "未计入本次资料清单" };
  replace(elements.documents, ...items.map((item) => {
    const row = node("div", "", "document-row");
    const file = node("div");
    file.append(node("div", item.filename, "document-name"));
    if (item.noteCode) file.append(node("span", notes[item.noteCode] ?? "未计入清单", "document-note"));
    row.append(file, node("time", formatDateTime(item.submittedAt), "document-date"),
      status(labels[item.status] ?? "处理中", item.status));
    return row;
  }));
}

function renderUpload(data) {
  elements.uploadButton.href = data.uploadAllowed ? data.submissionUrl : "";
  elements.uploadButton.setAttribute("aria-disabled", String(!data.uploadAllowed));
  elements.uploadButton.tabIndex = data.uploadAllowed ? 0 : -1;
  elements.uploadButton.textContent = data.uploadAllowed ? "打开新的上传页面" : data.isComplete ? "资料已经齐全" : "当前不能继续上传";
  elements.uploadHelp.textContent = data.uploadAllowed
    ? "每批最多5个文件，只接受PDF、JPG、JPEG和PNG。每次请从这里打开一个全新的上传页面；提交成功后关闭新标签页并返回。"
    : data.isComplete ? "资料已经齐全，当前无需继续操作；如果会计人员提出新问题，本页会显示。"
      : "提交次数已用尽、本次资料收集已结束或入口已停止接收。您仍可查看现有状态。";
  elements.invitationMeta.textContent = `剩余提交次数 ${data.remainingSubmissions} · 链接有效至 ${formatDateTime(data.validUntil)}`;
  if (!data.uploadAllowed) elements.uploadReturn.hidden = true;
}

function noteUploadOpened(event) {
  if (!snapshot?.uploadAllowed) { event.preventDefault(); return; }
  uploadOpenedAt = Date.now();
  elements.uploadReturn.hidden = false;
  elements.uploadButton.textContent = "再打开一批新的上传页面";
}

function refreshAfterUpload() {
  if (!uploadOpenedAt || document.hidden || Date.now() - uploadOpenedAt < 800) return;
  uploadOpenedAt = 0;
  window.setTimeout(() => void refresh(true), 600);
}

function status(label, kind) { return node("span", label, `status is-${kind}`); }
function node(tag, text = "", className = "") {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function replace(parent, ...children) { parent.replaceChildren(...children); }
function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待确认" : new Intl.DateTimeFormat("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}
function showError(message) {
  elements.loading.hidden = true;
  elements.portal.hidden = true;
  elements.error.hidden = false;
  elements.errorMessage.textContent = message;
}
