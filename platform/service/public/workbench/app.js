const LOCAL_PERSISTENCE = document.body.dataset.localPersistence === "true";
const DRAFT_KEY = "dop.m46.client-draft";
const state = { session: null, cases: null, today: null, view: "today", returnView: "cases", selectedCaseId: null, setup: null, step: 1, draft: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const viewCopy = {
  today: ["今天", "今日待办", "先处理最上方事项；没有待办时再开始新客户。"],
  cases: ["进行中", "客户与资料收集", "每个客户都会直接告诉你当前状态和下一步。"],
  completed: ["历史记录", "已完成", "这里保存已经完成的资料收集和下一任务状态。"],
};

$("#login-form").addEventListener("submit", login);
$("#logout-button").addEventListener("click", logout);
$("#boot-retry").addEventListener("click", bootstrap);
$("#start-client").addEventListener("click", openClientDialog);
$$('[data-start-client]').forEach((button) => button.addEventListener("click", openClientDialog));
$$('[data-view]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#dialog-close").addEventListener("click", closeClientDialog);
$("#step-next").addEventListener("click", nextStep);
$("#step-back").addEventListener("click", previousStep);
$("#client-form").addEventListener("submit", createClientCase);
$("#detail-back").addEventListener("click", () => switchView(state.returnView));
$("#active-case-list").addEventListener("click", openCaseFromList);
$("#today-case-list").addEventListener("click", openCaseFromList);
$("#today-action-list").addEventListener("click", openTodayAction);
$("#completed-case-list").addEventListener("click", openCaseFromList);
$("#detail-content").addEventListener("click", detailAction);
$("#detail-content").addEventListener("change", detailChange);
$("#detail-content").addEventListener("submit", uploadLocalDocument);
$("#customer-name").addEventListener("input", saveDraftFromForm);
$("#contact-name").addEventListener("input", saveDraftFromForm);
$("#period-month").addEventListener("change", saveDraftFromForm);
$("#period-year").addEventListener("input", saveDraftFromForm);
$$('input[name="quarter"]').forEach((input) => input.addEventListener("change", saveDraftFromForm));

async function bootstrap() {
  showOnly("boot-view");
  $("#boot-retry").hidden = true;
  $("#boot-status").textContent = "正在连接";
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { response = await fetch("/v1/workbench/session"); } catch { response = null; }
    if (response?.ok || response?.status === 401) break;
    $("#boot-message").textContent = "服务正在启动，已自动重试。";
    await delay(450 * (attempt + 1));
  }
  if (response?.status === 401) return showLogin();
  if (!response?.ok) {
    $("#boot-status").textContent = "暂时无法连接";
    $("#boot-message").textContent = "请稍后重新连接，当前数据不会丢失。";
    $("#boot-retry").hidden = false;
    return;
  }
  showApp(await response.json());
}

async function login(event) {
  event.preventDefault();
  const error = $("#login-error");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  error.hidden = true; button.disabled = true; button.textContent = "正在登录";
  try {
    const response = await fetch("/v1/ops/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...(LOCAL_PERSISTENCE ? { username: $("#login-email").value } : { email: $("#login-email").value }),
      password: $("#login-password").value, rememberDevice: !LOCAL_PERSISTENCE && $("#login-remember").checked,
    }) });
    if (!response.ok) throw new Error(response.status === 429 ? "登录尝试过多，请稍后再试。" : (LOCAL_PERSISTENCE ? "账号或密码不正确。" : "邮箱或密码不正确。"));
    if (LOCAL_PERSISTENCE) {
      try {
        if ($("#login-remember").checked) localStorage.setItem("dop.local.username", $("#login-email").value.trim());
        else localStorage.removeItem("dop.local.username");
      } catch { /* Remembering is optional; blocked storage must not prevent login. */ }
    } else $("#login-password").value = "";
    const session = await fetch("/v1/workbench/session");
    if (!session.ok) throw new Error(session.status === 403 ? "此账号没有员工工作台权限。" : "暂时无法进入工作台。");
    showApp(await session.json());
  } catch (failure) {
    error.textContent = failure instanceof Error ? failure.message : "暂时无法登录。"; error.hidden = false;
  } finally { button.disabled = false; button.textContent = "进入工作台"; }
}

async function logout() {
  await fetch("/v1/ops/session", { method: "DELETE" }).catch(() => undefined);
  state.session = null; state.cases = null;
  if (LOCAL_PERSISTENCE) { state.today = null; state.setup = null; state.draft = null; state.selectedCaseId = null; $("#detail-content").replaceChildren(); }
  showLogin();
}

function showOnly(id) {
  ["boot-view", "login-view", "app-shell"].forEach((candidate) => { $(`#${candidate}`).hidden = candidate !== id; });
}

function showLogin(message = "") {
  if (LOCAL_PERSISTENCE) {
    $("#login-password").value = "";
    try { $("#login-email").value = localStorage.getItem("dop.local.username") || ""; } catch {}
  }
  showOnly("login-view");
  $("#login-error").textContent = message; $("#login-error").hidden = !message; $("#login-email").focus();
}

function showApp(session) {
  state.session = session; showOnly("app-shell"); $("#operator-name").textContent = session.operator.displayName;
  if (LOCAL_PERSISTENCE) void loadLocalAI();
  switchView("today");
  void Promise.all([loadToday(), loadCases()]);
}

function switchView(view) {
  if (!viewCopy[view]) return;
  state.view = view; state.selectedCaseId = null;
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view));
  $$(".view").forEach((section) => { section.hidden = section.id !== `${view}-view`; });
  const [overline, title, description] = viewCopy[view];
  $("#page-overline").textContent = overline; $("#page-title").textContent = title; $("#page-description").textContent = description;
  $("#start-client").hidden = view === "completed";
  $("#main-content").focus({ preventScroll: true });
  if (view === "today") void loadToday(); else void loadCases();
}

async function loadToday(force = false) {
  if (state.today && !force) return renderToday();
  $("#today-action-list").innerHTML = '<div class="empty-list">正在整理今天需要处理的事项…</div>';
  try {
    const response = await fetch("/v1/workbench/today");
    if (response.status === 401) return showLogin();
    if (!response.ok) throw new Error("暂时无法读取今日待办。");
    state.today = await response.json(); renderToday();
  } catch (failure) {
    $("#today-action-list").innerHTML = `<div class="empty-list error">${escapeHtml(failure.message)}</div>`;
  }
}

function renderToday() {
  const actions = state.today?.actions || [];
  $("#today-start-card").hidden = actions.length > 0;
  if (!actions.length) {
    $("#today-action-list").innerHTML = '<div class="today-clear"><span>✓</span><div><strong>今天没有必须处理的资料事项</strong><p>你可以继续进行中的工作，或为新客户开始资料收集。</p></div></div>';
    return;
  }
  $("#today-action-list").innerHTML = `<div class="section-heading compact"><h2>优先处理</h2><span>${actions.length} 项</span></div>${actions.map((action) => `<button class="action-card ${escapeHtml(action.kind)}" type="button" data-action-case="${escapeHtml(action.caseId)}"><span class="action-kind">${action.kind === "review" ? "需确认" : action.kind === "task" ? "下一任务" : "待补资料"}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.customerName)} · ${escapeHtml(action.detail)}</p></div><b>处理 →</b></button>`).join("")}`;
}

function openTodayAction(event) {
  const button = event.target.closest("[data-action-case]");
  if (!button) return;
  state.returnView = "today"; void openCase(button.dataset.actionCase);
}

async function loadCases(force = false) {
  if (state.cases && !force) return renderAllCaseLists();
  setCaseLoading();
  try {
    const response = await fetch("/v1/workbench/cases");
    if (response.status === 401) return showLogin();
    if (!response.ok) throw new Error("暂时无法读取资料收集列表。请稍后重试。");
    state.cases = await response.json(); renderAllCaseLists();
  } catch (failure) { renderCaseFailure(failure instanceof Error ? failure.message : "暂时无法读取列表。"); }
}

function renderAllCaseLists() {
  renderCaseList($("#today-case-list"), state.cases.activeCases.slice(0, 4), false);
  renderCaseList($("#active-case-list"), state.cases.activeCases, false);
  renderCaseList($("#completed-case-list"), state.cases.completedCases, true);
}

function setCaseLoading() { ["#today-case-list", "#active-case-list", "#completed-case-list"].forEach((id) => { $(id).innerHTML = '<div class="empty-list">正在读取…</div>'; }); }
function renderCaseFailure(message) { ["#today-case-list", "#active-case-list", "#completed-case-list"].forEach((id) => { $(id).innerHTML = `<div class="empty-list error">${escapeHtml(message)}</div>`; }); }

function renderCaseList(region, cases, completed) {
  if (!cases.length) {
    region.innerHTML = `<div class="empty-list"><strong>${completed ? "还没有完成记录" : "当前没有进行中的资料收集"}</strong><p>${completed ? "完成后会自动出现在这里。" : "点击“新建客户并开始资料收集”即可开始。"}</p></div>`;
    return;
  }
  region.innerHTML = cases.map((item) => {
    const percent = item.checklist.requiredCount ? Math.round(item.checklist.receivedCount / item.checklist.requiredCount * 100) : 0;
    const status = caseListStatus(item);
    const progressClass = item.nextAction === "completed" || item.nextAction === "ready" ? "is-complete"
      : item.nextAction === "review" || item.nextAction === "issues" ? "is-review" : item.nextAction === "processing" ? "is-processing" : "is-missing";
    return `<button class="case-card" type="button" data-case-id="${escapeHtml(item.id)}" data-completed="${completed}">
      <div><strong>${escapeHtml(item.customerName)}</strong><span>${periodText(item.periodStart, item.periodEnd)}</span></div>
      <div class="case-progress"><span><b>${item.checklist.receivedCount}/${item.checklist.requiredCount} 已接受</b>${escapeHtml(status)}</span><progress class="${progressClass}" max="100" value="${percent}"></progress></div>
      <span class="open-label">查看 <b>→</b></span></button>`;
  }).join("");
}

function openCaseFromList(event) {
  const card = event.target.closest("[data-case-id]");
  if (!card) return;
  state.returnView = card.dataset.completed === "true" ? "completed" : state.view;
  void openCase(card.dataset.caseId);
}

async function openCase(caseId) {
  state.selectedCaseId = caseId;
  $$(".view").forEach((section) => { section.hidden = section.id !== "detail-view"; });
  $("#page-overline").textContent = "资料收集"; $("#page-title").textContent = "正在读取"; $("#page-description").textContent = ""; $("#start-client").hidden = true;
  $("#detail-content").innerHTML = '<div class="empty-list">正在读取客户资料…</div>';
  try {
    const response = await fetch(`/v1/workbench/cases/${encodeURIComponent(caseId)}`);
    if (!response.ok) throw new Error(response.status === 404 ? "没有找到这项资料收集。" : "暂时无法读取详情。");
    renderDetail((await response.json()).case);
  } catch (failure) { $("#detail-content").innerHTML = `<div class="empty-list error">${escapeHtml(failure.message)}</div>`; }
}

function renderDetail(item) {
  $("#page-title").textContent = item.customerName;
  $("#page-description").textContent = periodText(item.periodStart, item.periodEnd);
  const reviewFiles = item.files.filter((file) => file.status === "awaiting_human_review");
  const current = detailStatus(item, reviewFiles);
  $("#detail-content").innerHTML = `<div class="detail-hero">
    <div><p class="overline">现在做什么</p><h2>${escapeHtml(current.title)}</h2><p>${escapeHtml(current.description)}</p></div>
    <div class="detail-hero-actions"><button class="button secondary" type="button" data-refresh-case>刷新最新状态</button>${item.status === "completed" || LOCAL_PERSISTENCE ? "" : '<button class="button primary" type="button" data-invite>生成或继续使用客户提交链接</button>'}</div>
  </div><div id="invitation-result"></div>
  ${LOCAL_PERSISTENCE && item.status !== "completed" ? localUploadPanel(item) : ""}
  ${LOCAL_PERSISTENCE ? `<p><a href="/v1/local/cases/${escapeHtml(item.id)}/export" target="_blank" rel="noopener">查看与导出${item.status === "completed" ? "交接" : "当前（未完成）"}清单</a></p>` : ""}
  ${reviewFiles.length ? `<section class="detail-section attention-section"><header><div><p class="overline">需要你处理</p><h2>人工确认</h2></div><span>${reviewFiles.length} 份</span></header><div class="review-list">${reviewFiles.map((file) => reviewCard(file, item.documentTypes)).join("")}</div></section>` : ""}
  <section class="detail-section"><header><h2>资料清单</h2><span>${item.checklist.receivedCount}/${item.checklist.requiredCount} 已接受</span></header>
    <div class="rows">${item.checklist.items.map((requirement) => `<div class="row"><div><strong>${escapeHtml(requirement.name)}</strong><span>${requirement.missingCount ? `还需 ${requirement.missingCount} 份` : "已满足"}</span></div><b>${requirement.receivedCount}/${requirement.requiredCount}</b></div>`).join("")}</div></section>
  <section class="detail-section"><header><h2>已提交文件</h2><span>${item.files.length} 个</span></header>
    <div class="rows">${item.files.length ? item.files.map((file) => `<div class="row"><div><strong>${escapeHtml(file.filename)}</strong><span>${escapeHtml(file.classificationNotice ? "类型尚未可靠确定" : file.documentTypeName || (file.status === "excluded" ? "已排除，保留原件" : LOCAL_PERSISTENCE ? "尚未分类，请选择 AI 或人工处理" : "正在识别资料类型"))}</span>${file.processingNotice ? `<span class="permission-note">${escapeHtml(file.processingNotice)}</span>` : ""}${file.canRestoreExclusion ? restoreExclusionControl(file) : ""}</div><div class="row-actions">${LOCAL_PERSISTENCE && item.status !== "completed" && ["processing","processing_failed","automatically_accepted"].includes(file.status) ? `<button class="text-button" data-local-manual="${escapeHtml(file.id)}" type="button">${file.status === "automatically_accepted" ? "重新复核／改类" : "人工分类"}</button>` : ""}${LOCAL_PERSISTENCE && item.status !== "completed" && ["processing","processing_failed"].includes(file.status) ? `<button class="text-button" data-local-classify="${escapeHtml(file.id)}" type="button">AI 分类（付费）</button>` : ""}${file.previewAvailable ? `<button class="text-button" data-preview="${escapeHtml(file.id)}" type="button">查看原件</button>` : ""}<span class="file-status ${file.status}">${file.duplicateNotCounted ? "重复文件 · 不重复计数" : statusText(file.status)}</span></div></div>`).join("") : '<div class="empty-list">客户还没有提交文件。</div>'}</div></section>
  ${item.openQuestions.length ? `<section class="detail-section"><header><h2>${LOCAL_PERSISTENCE ? "待补交事项（仅本机记录）" : "已向客户提出的问题"}</h2><span>${item.openQuestions.length} 个待处理</span></header><div class="question-list">${item.openQuestions.map((question) => `<article class="question-card"><strong>${escapeHtml(question.title)}</strong><p>${escapeHtml(question.message)}</p><button class="button secondary" data-resolve-question="${escapeHtml(question.id)}" type="button">确认已收到补交并关闭问题</button></article>`).join("")}</div></section>` : ""}
  ${item.actionableIssues.length && item.status !== "completed" ? questionComposer(item.actionableIssues) : ""}
  ${item.duplicateReview?.count ? `<section class="detail-section"><header><h2>重复文件确认</h2><span>${item.duplicateReview.count} 份</span></header><p>重复文件已经保留，不会重复计入资料清单。${item.duplicateReview.canAcknowledge ? "请确认本次重复文件的处理结果，再完成资料收集。" : "请先处理缺失资料、人工确认和客户问题，之后即可确认重复文件。"}</p><button class="button secondary" type="button" data-acknowledge-duplicates ${item.duplicateReview.canAcknowledge ? "" : "disabled"}>确认重复文件不重复计数</button></section>` : ""}
  ${completionPanel(item)}
  ${item.nextTask ? taskPanel(item.nextTask) : ""}`;
}

async function detailAction(event) {
  const aiButton=event.target.closest("[data-local-classify]");
  if(aiButton) {
    aiButton.disabled=true;aiButton.textContent="正在识别…";
    try {
      const response=await workbenchMutation(`/v1/local/documents/${aiButton.dataset.localClassify}/classify`,{});
      const result=await response.json();
      if(!response.ok)throw new Error("分类未完成，可继续人工处理。");
      showToast(["accepted","review_required"].includes(result.outcome)?"AI 结果已保存，请查看分类或复核事项。":"AI 未完成识别；可选择人工分类。不会自动重试。");
      await refreshCase();await loadLocalAI();
    } catch(error){showToast(error.message);aiButton.disabled=false;aiButton.textContent="AI 分类（付费）";}
  }
  const manualButton = event.target.closest("[data-local-manual]");
  if (manualButton) {
    manualButton.disabled = true;
    try {
      const response = await workbenchMutation(`/v1/local/documents/${manualButton.dataset.localManual}/manual`, {});
      if (!response.ok) throw new Error("暂时无法转为人工复核；请确认没有正在执行的分类，且任务尚未完成。");
      await refreshCase();
    } catch(error) { showToast(error.message); manualButton.disabled=false; }
  }
  if (event.target.closest("[data-refresh-case]")) await refreshCase();
  if (event.target.closest("[data-invite]")) await issueInvitation(event.target.closest("[data-invite]"));
  if (event.target.closest("[data-renew-invite]")) {
    const button = event.target.closest("[data-renew-invite]");
    if (window.confirm("重新生成后，旧链接将不能继续使用。确认生成新的客户提交链接？"))
      await issueInvitation(button, button.dataset.renewInvite);
  }
  if (event.target.closest("[data-copy-link]")) await copyInvitationLink(event.target.closest("[data-copy-link]").dataset.copyLink);
  if (event.target.closest("[data-preview]")) await previewDocument(event.target.closest("[data-preview]"));
  if (event.target.closest("[data-review-action]")) await resolveReview(event.target.closest("[data-review-action]"));
  if (event.target.closest("[data-escalate-review]")) {
    const button = event.target.closest("[data-escalate-review]");
    button.disabled = true;
    try {
      const response = await workbenchMutation(`/v1/workbench/reviews/${encodeURIComponent(button.closest("[data-review-document]").dataset.reviewDocument)}/escalate`,
        { idempotencyKey: crypto.randomUUID() });
      if (!response.ok) throw new Error("暂时无法转交，请刷新后重试。资料不会自动计入清单。");
      showToast("已转交主管，资料仍待复核"); await refreshCase();
    } catch (failure) { showToast(failure.message); button.disabled = false; }
  }
  if (event.target.closest("[data-publish-question]")) await publishQuestion(event.target.closest("[data-publish-question]"));
  if (event.target.closest("[data-resolve-question]")) await resolveQuestion(event.target.closest("[data-resolve-question]"));
  if (event.target.closest("[data-complete-case]")) await completeCase(event.target.closest("[data-complete-case]"));
  if (event.target.closest("[data-acknowledge-duplicates]")) {
    const button = event.target.closest("[data-acknowledge-duplicates]"); button.disabled = true;
    try {
      const response = await workbenchMutation(`/v1/workbench/cases/${encodeURIComponent(state.selectedCaseId)}/acknowledge-duplicates`,
        { idempotencyKey: crypto.randomUUID() });
      if (!response.ok) throw new Error("当前仍有其他待处理事项，请刷新后确认；文件没有被删除。");
      showToast("已确认重复文件不重复计数，原件保留"); await refreshCase();
    } catch (failure) { showToast(failure.message); button.disabled = false; }
  }
  if (event.target.closest("[data-task-action]")) await transitionTask(event.target.closest("[data-task-action]"));
}

function detailChange(event) {
  if (!event.target.matches("#question-issue")) return;
  applyQuestionSuggestion(event.target);
}

function reviewCard(file, documentTypes) {
  return `<article class="review-card" data-review-document="${escapeHtml(file.id)}"><div class="review-heading"><div><strong>${escapeHtml(file.filename)}</strong><p>${!file.documentTypeCode ? "尚未确定资料类型" : file.classificationNotice ? "低置信度或类型冲突候选（未确认）" : "系统建议类型"}：${escapeHtml(file.documentTypeName || "未知类型")}</p>${file.classificationNotice ? `<p class="permission-note">${escapeHtml(file.classificationNotice)}</p>` : ""}</div>${file.previewAvailable ? `<button class="button secondary" data-preview="${escapeHtml(file.id)}" type="button">查看原件</button>` : ""}</div><ul class="review-context">${(file.reviewExplanation || []).map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>${file.supervisorReviewRequested ? '<p class="permission-note">已转交主管确认是否接受；你仍可按实际原因排除，不计入清单并保留原件。</p>' : ""}
    ${file.canResolveReview ? `<div class="review-actions">${file.documentTypeCode ? '<button class="button primary" data-review-action="confirm" type="button">确认分类正确</button>' : ""}<label>改为<select data-review-type><option value="">请选择正确类型</option>${documentTypes.map((type) => `<option value="${escapeHtml(type.code)}" ${!file.classificationNotice && type.code === file.documentTypeCode ? "selected" : ""}>${escapeHtml(type.name)}</option>`).join("")}</select></label><button class="button secondary" data-review-action="reclassify" type="button">保存新分类</button><button class="button secondary" data-review-action="request_information" type="button">请客户补充</button></div>` : ""}
    ${file.canExclude ? `<details class="review-correction"><summary>从本次资料收集排除（保留原件）</summary><p>排除后不计入清单。误排除可在“已提交文件”中恢复待复核，不会直接接受。</p><div class="review-actions"><label>排除原因<select data-exclusion-reason><option value="">请选择原因</option><option value="wrong_subject">错客户</option><option value="wrong_period">错期间</option><option value="irrelevant_or_unknown">无关／未知资料</option></select></label><label>处理说明<input data-review-rationale maxlength="500" placeholder="说明与本次收集不符的原因"></label><button class="button secondary" data-review-action="exclude" type="button">确认排除，保留原件</button></div></details>` : ""}<p class="inline-error" data-review-error hidden></p></article>`;
}

function restoreExclusionControl(file) {
  return `<details class="review-correction" data-review-document="${escapeHtml(file.id)}"><summary>误排除了？恢复待复核</summary><p>原件仍保留。恢复后需重新核对，不会直接计入清单，也不会清除原排除记录。</p><label>纠错说明<input data-review-rationale maxlength="500" placeholder="为什么需要撤销这次排除"></label><button class="button secondary" data-review-action="reopen" type="button">撤销排除，恢复待复核</button><p class="inline-error" data-review-error hidden></p></details>`;
}

function questionComposer(issues) {
  const suggestions = issues.map((issue) => ({ issue, ...questionSuggestion(issue.label) }));
  return `<section class="detail-section" id="question-compose-section"><header><div><p class="overline">客户需要补交时</p><h2>${LOCAL_PERSISTENCE ? "记录待补交事项" : "把问题发布到客户页面"}</h2><p class="section-help">${LOCAL_PERSISTENCE ? "此记录保存在本机，不会发送给客户；收到补交文件后在上方上传，再关闭问题。" : "系统已准备好建议文字；确认内容清楚后发布，客户就能看到并向本次资料收集补交。"}</p></div></header><div class="question-compose"><label class="field"><span>需要客户处理的事项</span><select id="question-issue">${suggestions.map(({ issue, title, message }) => `<option value="${escapeHtml(issue.id)}" data-title="${escapeHtml(title)}" data-message="${escapeHtml(message)}">${escapeHtml(issue.label)}</option>`).join("")}</select></label><label class="field"><span>客户看到的标题</span><input id="question-title" maxlength="160" value="${escapeHtml(suggestions[0]?.title || "请补交资料")}"></label><label class="field"><span>需要客户做什么</span><textarea id="question-message" maxlength="2000">${escapeHtml(suggestions[0]?.message || "请根据资料清单补交仍缺少的虚构测试资料。")}</textarea></label><button class="button primary" data-publish-question type="button">${LOCAL_PERSISTENCE ? "保存补交事项" : "发布给客户"}</button><p class="inline-error" id="question-error" hidden></p></div></section>`;
}

function completionPanel(item) {
  if (item.status === "completed") return '<section class="completion-panel complete"><span>✓</span><div><strong>本次资料收集已完成</strong><p>下一项工作已经建立在下方。</p></div></section>';
  if (item.completion.canComplete) return '<section class="completion-panel ready"><div><p class="overline">可以完成</p><h2>资料与问题均已处理</h2><p>完成后系统会建立有截止日期和完成标准的下一任务。</p></div><button class="button primary" data-complete-case type="button">完成资料收集</button></section>';
  return `<section class="completion-panel blocked"><div><p class="overline">完成前还需要</p><h2>继续处理 ${item.completion.blockers.length} 项</h2><ul>${item.completion.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul></div></section>`;
}

function taskPanel(task) {
  const action = task.status === "open" ? "start" : task.status === "in_progress" ? "complete" : task.status === "waiting" ? "resume" : "";
  return `<section class="detail-section task-section"><header><div><p class="overline">下一任务</p><h2>${escapeHtml(task.name)}</h2></div><span>${taskStatusText(task.status)}</span></header><dl><div><dt>负责人</dt><dd>${escapeHtml(task.assignee || "待认领")}</dd></div><div><dt>截止日期</dt><dd>${task.dueAt ? formatDate(task.dueAt) : "未设置"}</dd></div><div><dt>操作说明</dt><dd>${escapeHtml(task.instructions)}</dd></div><div><dt>完成标准</dt><dd>${escapeHtml(task.completionCriteria)}</dd></div></dl>${action ? `<button class="button primary" data-task-action="${action}" data-task-id="${escapeHtml(task.id)}" type="button">${action === "start" ? "开始任务" : action === "resume" ? "继续任务" : "完成任务"}</button>` : ""}</section>`;
}

async function previewDocument(button) {
  button.disabled = true;
  try {
    const response = await workbenchMutation(`/v1/workbench/documents/${encodeURIComponent(button.dataset.preview)}/preview`, {});
    if (!response.ok) throw new Error("暂时无法打开原件，请稍后重试。");
    const result = await response.json();
    window.open(result.url, "_blank", "noopener,noreferrer");
  } catch (failure) { showToast(failure.message); }
  finally { button.disabled = false; }
}

async function resolveReview(button) {
  const card = button.closest("[data-review-document]");
  const action = button.dataset.reviewAction;
  const payload = {
    action,
    rationale: action === "confirm" ? "员工确认本次资料分类正确。"
      : action === "reclassify" ? "员工选择并保存本次资料分类。"
      : action === "request_information" ? "员工查看原件后需要客户补充资料或说明。"
      : "",
  };
  const error = card.querySelector("[data-review-error]");
  error.hidden = true;
  if (action === "reclassify") payload.documentTypeCode = card.querySelector("[data-review-type]").value;
  if (["exclude", "reopen"].includes(action)) {
    const note = card.querySelector("[data-review-rationale]").value.trim();
    const reason = action === "exclude" ? card.querySelector("[data-exclusion-reason]").value : null;
    if (note.length < 4 || (action === "exclude" && !reason)) {
      error.textContent = "请选择排除原因（如适用），并填写至少4个字的处理说明。"; error.hidden = false; return;
    }
    if (reason) payload.exclusionReason = reason;
    const labels = { wrong_subject: "错客户", wrong_period: "错期间", irrelevant_or_unknown: "无关／未知资料" };
    payload.rationale = action === "exclude" ? `员工核对原件后按“${labels[reason]}”排除，保留原件。说明：${note}` : `员工撤销排除并恢复为待人工复核，不直接计入清单。说明：${note}`;
    if (!window.confirm(action === "exclude" ? `确认按“${labels[reason]}”排除这份文件？原件保留，不计入清单，可恢复待复核。` : "确认撤销这份文件的排除？它将恢复为待人工复核，不会直接计入清单。")) return;
  }
  // Retry an uncertain response using the same command; changed decisions get a new key.
  const fingerprint = JSON.stringify(payload);
  if (button.dataset.reviewFingerprint !== fingerprint) {
    button.dataset.reviewFingerprint = fingerprint; button.dataset.reviewKey = crypto.randomUUID();
  }
  payload.idempotencyKey = button.dataset.reviewKey;
  const buttons = [...card.querySelectorAll("button")]; buttons.forEach((item) => { item.disabled = true; });
  try {
    const response = await workbenchMutation(`/v1/workbench/reviews/${encodeURIComponent(card.dataset.reviewDocument)}`, payload);
    const result = await response.json();
    if (!response.ok) throw new Error(reviewError(result.reason || result.error));
    showToast(action === "request_information" ? "已标记需补充，请在下方记录补交事项" : action === "exclude" ? "已排除，原件保留且不计入清单" : action === "reopen" ? "已恢复待复核，尚未计入清单" : "处理结果已保存");
    await refreshCase();
    if (action === "request_information") $("#question-compose-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (failure) { error.textContent = failure.message; error.hidden = false; buttons.forEach((item) => { item.disabled = false; }); }
}

async function publishQuestion(button) {
  const issueId = $("#question-issue")?.value || "";
  const title = $("#question-title")?.value.trim() || "";
  const message = $("#question-message")?.value.trim() || "";
  const error = $("#question-error");
  error.hidden = true;
  if (title.length < 3 || message.length < 12) {
    error.textContent = "请填写清楚的问题标题和至少12个字的补交说明。"; error.hidden = false; return;
  }
  button.disabled = true;
  try {
    const response = await workbenchMutation(`/v1/workbench/cases/${encodeURIComponent(state.selectedCaseId)}/questions`,
      { issueId, title, message, idempotencyKey: crypto.randomUUID() });
    const result = await response.json();
    if (!response.ok) throw new Error(questionError(result.reason || result.error));
    showToast(LOCAL_PERSISTENCE ? "补交事项已保存在本机，未发送给客户" : "问题已发布到客户提交页面");
    await refreshCase();
  } catch (failure) { error.textContent = failure.message; error.hidden = false; button.disabled = false; }
}

async function resolveQuestion(button) {
  button.disabled = true;
  try {
    const response = await workbenchMutation(`/v1/workbench/questions/${encodeURIComponent(button.dataset.resolveQuestion)}/resolve`,
      { idempotencyKey: crypto.randomUUID() });
    const result = await response.json();
    if (!response.ok) throw new Error(questionError(result.reason || result.error));
    showToast("客户问题已关闭"); await refreshCase();
  } catch (failure) { showToast(failure.message); button.disabled = false; }
}

async function completeCase(button) {
  button.disabled = true; button.textContent = "正在完成";
  try {
    const response = await workbenchMutation(`/v1/workbench/cases/${encodeURIComponent(state.selectedCaseId)}/complete`,
      { idempotencyKey: crypto.randomUUID() });
    const result = await response.json();
    if (!response.ok) throw new Error(completionError(result.reason || result.error));
    showToast("资料收集已完成，下一任务已建立"); await refreshCase();
  } catch (failure) { showToast(failure.message); button.disabled = false; button.textContent = "完成资料收集"; }
}

async function transitionTask(button) {
  button.disabled = true;
  try {
    const response = await workbenchMutation(`/v1/workbench/tasks/${encodeURIComponent(button.dataset.taskId)}/transitions`,
      { action: button.dataset.taskAction, idempotencyKey: crypto.randomUUID() });
    const result = await response.json();
    if (!response.ok) throw new Error(taskError(result.reason || result.error));
    showToast(button.dataset.taskAction === "complete" ? "下一任务已完成" : "下一任务状态已更新");
    await refreshCase();
  } catch (failure) { showToast(failure.message); button.disabled = false; }
}

async function workbenchMutation(path, body) {
  return await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.session.csrfToken }, body: JSON.stringify(body) });
}

async function refreshCase() {
  state.cases = null; state.today = null;
  await Promise.all([openCase(state.selectedCaseId), loadCases(true), loadToday(true)]);
}

async function issueInvitation(button, replaceInvitationId) {
  const storageKey = `dop.m46.invitation.${state.selectedCaseId}`;
  let idempotencyKey = localStorage.getItem(storageKey);
  if (!idempotencyKey || (replaceInvitationId && button.dataset.pendingRequestKey !== idempotencyKey)) {
    idempotencyKey = crypto.randomUUID(); localStorage.setItem(storageKey, idempotencyKey);
    button.dataset.pendingRequestKey = idempotencyKey;
  }
  button.disabled = true; button.textContent = "正在生成";
  try {
    const response = await fetch(`/v1/workbench/cases/${encodeURIComponent(state.selectedCaseId)}/invitations`, {
      method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.session.csrfToken },
      body: JSON.stringify({ idempotencyKey, ...(replaceInvitationId ? { replaceInvitationId } : {}) }),
    });
    const result = await response.json();
    if (!response.ok && result.canRenew && result.invitationId) {
      $("#invitation-result").innerHTML = `<div class="link-result"><div><strong>旧链接已不可继续使用</strong><p>可能已到期、被撤销、次数耗尽或无法安全恢复。重新生成会停用旧链接，并保留审计记录。</p></div><button class="button secondary" data-renew-invite="${escapeHtml(result.invitationId)}" type="button">确认后重新生成链接</button></div>`;
      button.disabled = false; button.textContent = "检查已有链接"; return;
    }
    if (!response.ok) throw new Error(invitationError(result.reason));
    $("#invitation-result").innerHTML = `<div class="link-result"><div><strong>${result.outcome === "duplicate" ? "已找回原客户提交链接" : "客户提交链接已生成"}</strong><p>有效至 ${escapeHtml(new Date(result.validUntil).toLocaleString("zh-CN"))}；剩余 ${result.remainingSubmissions ?? 20} 次提交。找回不会延长有效期。仅可用于虚构测试。</p></div><div><button class="button secondary" data-copy-link="${escapeHtml(result.submissionUrl)}" type="button">复制链接</button><a class="button primary" href="${escapeHtml(result.submissionUrl)}" target="_blank" rel="noopener noreferrer">打开客户页面</a></div></div>`;
    button.hidden = true;
  } catch (failure) { $("#invitation-result").innerHTML = `<p class="error inline-error">${escapeHtml(failure.message)}</p>`; button.disabled = false; button.textContent = "重新生成"; }
}

async function copyInvitationLink(link) {
  try { await navigator.clipboard.writeText(link); showToast("链接已复制"); }
  catch { showToast("无法自动复制，请打开客户页面后从地址栏复制"); }
}

async function openClientDialog() {
  try {
    if (!state.setup) {
      const response = await fetch("/v1/workbench/setup");
      if (!response.ok) throw new Error("暂时无法读取服务方式。");
      state.setup = await response.json();
    }
    const saved = readDraft();
    state.draft = saved || { idempotencyKey: crypto.randomUUID(), customerName: "", contactName: "", serviceOptionId: "", periodMonth: "", periodYear: String(new Date().getFullYear()), quarter: "", requirements: [] };
    state.step = 1; renderServiceOptions(); applyDraft(); $("#draft-notice").hidden = !saved; updateStep(); $("#client-dialog").showModal(); $("#customer-name").focus();
  } catch (failure) { showToast(failure.message); }
}

function closeClientDialog() { saveDraftFromForm(); $("#client-dialog").close(); }

function renderServiceOptions() {
  $("#service-options").innerHTML = state.setup.serviceOptions.map((option) => `<label class="service-card"><input type="radio" name="service" value="${escapeHtml(option.id)}"><span><strong>${escapeHtml(option.name)}</strong><small>${option.frequency === "monthly" ? "按月收集" : "按季度收集"}</small><p>${escapeHtml(option.description)}</p></span></label>`).join("");
  $$('input[name="service"]').forEach((input) => input.addEventListener("change", () => { selectService(input.value); saveDraftFromForm(); }));
}

function selectService(id) {
  state.draft.serviceOptionId = id;
  const option = selectedService();
  if (!option) return;
  state.draft.requirements = option.requirements.map((item) => ({ ...item, selected: true }));
  $("#monthly-period").hidden = option.frequency !== "monthly"; $("#quarterly-period").hidden = option.frequency !== "quarterly";
}

function applyDraft() {
  $("#customer-name").value = state.draft.customerName || ""; $("#contact-name").value = state.draft.contactName || "";
  $("#period-month").value = state.draft.periodMonth || ""; $("#period-year").value = state.draft.periodYear || String(new Date().getFullYear());
  $$('input[name="quarter"]').forEach((input) => { input.checked = input.value === state.draft.quarter; });
  const selected = $(`input[name="service"][value="${cssEscape(state.draft.serviceOptionId || "")}"]`);
  if (selected) { selected.checked = true; const preserved = state.draft.requirements; selectService(selected.value); if (preserved?.length) state.draft.requirements = preserved; }
}

function saveDraftFromForm() {
  if (!state.draft) return;
  state.draft.customerName = $("#customer-name").value.trim(); state.draft.contactName = $("#contact-name").value.trim();
  state.draft.periodMonth = $("#period-month").value; state.draft.periodYear = $("#period-year").value; state.draft.quarter = $('input[name="quarter"]:checked')?.value || "";
  localStorage.setItem(DRAFT_KEY, JSON.stringify(state.draft));
}

function readDraft() { try { const value = JSON.parse(localStorage.getItem(DRAFT_KEY)); return value && typeof value.idempotencyKey === "string" ? value : null; } catch { return null; } }

function nextStep() {
  const error = validateStep(state.step); if (error) return showFormError(error);
  saveDraftFromForm(); state.step += 1; if (state.step === 3) updatePeriodPicker(); if (state.step === 4) renderRequirements(); updateStep();
}
function previousStep() { saveDraftFromForm(); state.step = Math.max(1, state.step - 1); updateStep(); }
function updateStep() {
  $$(".form-step").forEach((section) => { section.hidden = Number(section.dataset.step) !== state.step; });
  $$('[data-step-dot]').forEach((item) => { item.classList.toggle("is-current", Number(item.dataset.stepDot) === state.step); item.classList.toggle("is-done", Number(item.dataset.stepDot) < state.step); });
  $("#step-back").hidden = state.step === 1; $("#step-next").hidden = state.step === 4; $("#create-client-case").hidden = state.step !== 4; hideFormError();
}

function validateStep(step) {
  if (step === 1 && ($("#customer-name").value.trim().length < 2 || $("#customer-name").value.trim().length > 160)) return "请输入客户名称。";
  if (step === 2 && !$('input[name="service"]:checked')) return "请选择一种服务方式。";
  if (step === 3) { const option = selectedService(); if (option?.frequency === "monthly" && !$("#period-month").value) return "请选择月份。"; if (option?.frequency === "quarterly" && (!$("#period-year").value || !$('input[name="quarter"]:checked'))) return "请选择年份和季度。"; }
  return "";
}

function updatePeriodPicker() { const option = selectedService(); $("#monthly-period").hidden = option?.frequency !== "monthly"; $("#quarterly-period").hidden = option?.frequency !== "quarterly"; }

function renderRequirements() {
  const option = selectedService();
  if (!state.draft.requirements?.length) state.draft.requirements = option.requirements.map((item) => ({ ...item, selected: true }));
  $("#requirements").innerHTML = state.draft.requirements.map((item, index) => `<div class="requirement-edit"><label><input type="checkbox" data-requirement-selected="${index}" ${item.selected !== false ? "checked" : ""}><span>${escapeHtml(item.name)}</span></label><label>至少 <input type="number" min="1" max="100" value="${Number(item.minimumCount)}" data-requirement-count="${index}"> 份</label></div>`).join("");
  $$('[data-requirement-selected]').forEach((input) => input.addEventListener("change", () => { state.draft.requirements[Number(input.dataset.requirementSelected)].selected = input.checked; updateSummary(); saveDraftFromForm(); }));
  $$('[data-requirement-count]').forEach((input) => input.addEventListener("input", () => { state.draft.requirements[Number(input.dataset.requirementCount)].minimumCount = Number(input.value); updateSummary(); saveDraftFromForm(); }));
  updateSummary();
}

function updateSummary() { const selected = state.draft.requirements.filter((item) => item.selected !== false); const total = selected.reduce((sum, item) => sum + Number(item.minimumCount || 0), 0); $("#creation-summary").innerHTML = `<strong>即将创建</strong><p>${escapeHtml(state.draft.customerName)} · ${escapeHtml(selectedService()?.name || "")} · ${escapeHtml(periodLabel())}</p><p>共 ${selected.length} 项资料要求，至少 ${total} 份资料。</p>`; }

async function createClientCase(event) {
  event.preventDefault(); hideFormError(); saveDraftFromForm();
  const requirements = state.draft.requirements.filter((item) => item.selected !== false);
  if (!requirements.length) return showFormError("请至少保留一项资料要求。");
  if (requirements.some((item) => !Number.isInteger(item.minimumCount) || item.minimumCount < 1 || item.minimumCount > 100)) return showFormError("每项资料的最低份数必须在 1 到 100 之间。");
  const button = $("#create-client-case"); button.disabled = true; button.textContent = "正在创建，请勿关闭";
  const period = periodDates();
  try {
    const response = await fetch("/v1/workbench/client-cases", { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.session.csrfToken }, body: JSON.stringify({
      customerName: state.draft.customerName, contactName: state.draft.contactName || null, serviceOptionId: state.draft.serviceOptionId,
      periodStart: period.start, periodEnd: period.end, idempotencyKey: state.draft.idempotencyKey,
      requirements: requirements.map((item) => ({ code: item.code, minimumCount: item.minimumCount, maximumCount: item.maximumCount })),
    }) });
    const result = await response.json();
    if (!response.ok) throw new Error(createError(result.reason));
    localStorage.removeItem(DRAFT_KEY); state.draft = null; $("#client-dialog").close(); state.cases = null; await loadCases(true); showToast("客户和资料收集已创建"); await openCase(result.caseId);
  } catch (failure) { showFormError(`${failure.message} 你可以保留当前内容并重新尝试。`); }
  finally { button.disabled = false; button.textContent = "创建客户和资料收集"; }
}

function selectedService() { return state.setup?.serviceOptions.find((option) => option.id === state.draft?.serviceOptionId); }
function periodDates() { const option = selectedService(); if (option.frequency === "monthly") { const [year, month] = state.draft.periodMonth.split("-").map(Number); return { start: `${year}-${pad(month)}-01`, end: isoDate(new Date(Date.UTC(year, month, 0))) }; } const year = Number(state.draft.periodYear); const quarter = Number(state.draft.quarter); const month = (quarter - 1) * 3; return { start: `${year}-${pad(month + 1)}-01`, end: isoDate(new Date(Date.UTC(year, month + 3, 0))) }; }
function periodLabel() { const option = selectedService(); return option?.frequency === "monthly" ? state.draft.periodMonth : `${state.draft.periodYear} 年第 ${state.draft.quarter} 季度`; }
function periodText(start, end) { if (!start || !end) return "期间待确认"; return `${start} 至 ${end}`; }
function caseListStatus(item) { return ({ completed: "资料收集已完成", review: `待确认 ${item.checklist.reviewCount} 份`, processing: "新资料正在处理", missing: `仍缺 ${item.checklist.missingCount} 项`, issues: `还有 ${item.checklist.attentionCount} 个问题`, ready: "资料齐全，可以完成" })[item.nextAction] || "查看下一步"; }
function detailStatus(item, reviewFiles) {
  if (item.status === "completed" && item.nextTask?.status === "completed") return { title: "资料收集和下一任务均已完成", description: "所有状态已经保存，当前无需继续操作。" };
  if (item.status === "completed" && item.nextTask) return { title: "资料收集已完成，请处理下一任务", description: "查看下方任务的负责人、截止日期、操作说明和完成标准。" };
  if (reviewFiles.length) return { title: `先确认 ${reviewFiles.length} 份资料`, description: "打开原件，确认或修改分类；确认后清单会自动更新。" };
  if (item.openQuestions.length) return { title: "等待客户补交", description: "客户问题已发布。收到补交并确认资料后，再关闭问题。" };
  if (item.files.some((file) => file.status === "processing")) return LOCAL_PERSISTENCE ? { title: "文件已保存，等待分类", description: "请在下方选择 AI 分类或人工分类；只有点击 AI 分类时才会调用。" } : { title: "等待新资料处理完成", description: "稍后点击“刷新最新状态”；需要人工确认时会显示在本页和今日待办。" };
  if (item.checklist.missingCount > 0) return { title: `请客户继续提交 ${item.checklist.missingCount} 项资料`, description: "生成或继续使用客户提交链接；客户可查看缺少项目并分批上传。" };
  if (item.completion.canComplete) return { title: "资料齐全，可以完成本次收集", description: "检查下方清单后点击“完成资料收集”，系统会建立下一任务。" };
  return { title: "继续处理下方未完成事项", description: item.completion.blockers[0] || "刷新状态后查看下一步。" };
}
function questionSuggestion(label) {
  if (label.includes("确认资料分类")) return { title: "请补充资料说明", message: "请说明这份虚构测试资料的用途，或补交一份能够清楚识别类型和期间的文件。" };
  if (label.includes("未提交") || label.includes("仍有资料")) return { title: "请补交资料清单中仍缺少的项目", message: "请查看本页资料清单，并补交仍显示“缺少”的纯虚构测试资料。每批最多上传5个文件。" };
  return { title: "请补交或说明这份资料", message: "请根据会计人员的问题，补交一份清晰、属于当前客户和期间的纯虚构测试资料。" };
}
function applyQuestionSuggestion(select) { const option = select.selectedOptions[0]; if (!option) return; $("#question-title").value = option.dataset.title || ""; $("#question-message").value = option.dataset.message || ""; }
function statusText(status) { if (LOCAL_PERSISTENCE && status === "processing") return "已保存 · 待分类"; return ({ processing: "处理中", automatically_accepted: "已接受", awaiting_human_review: "需要人工确认", excluded: "未计入清单", processing_failed: "处理遇到问题" })[status] || "处理中"; }
function invitationError(reason) { return ({ active_invitation_already_exists: "这个客户已经有一个仍有效的提交链接。", synthetic_scope_required: "安全检查未通过，无法为此客户生成链接。", case_not_receiving: "这项资料收集当前不接受新提交。" })[reason] || "暂时无法生成客户链接。"; }
function createError(reason) { return ({ idempotency_key_reused: "这次操作内容已变化，请关闭后重新开始。", synthetic_uat_required: "当前环境不允许创建这类客户。", service_template_not_found: "所选服务方式已更新，请重新选择。", monthly_period_invalid: "所选月份无效。", quarterly_period_invalid: "所选季度无效。" })[reason] || "创建没有完成。"; }
function reviewError(reason) { return ({ manager_required: "这项接受或重开决定仍需主管处理；待复核的错客户、错期间或无关资料可直接排除。", case_closed: "本次资料收集已关闭，不能直接修改文件决定。请联系负责人处理。", document_not_reopenable: "文件已不处于排除状态，请刷新查看。", exclusion_reason_required: "请选择明确的排除原因。", review_already_resolved: "这份资料已经被其他人处理，请刷新查看。", system_retry_in_progress: "系统仍在自动重试，暂时不需要人工处理。", current_type_missing: "系统尚未给出可确认的分类，请选择正确分类。", document_type_required: "请选择正确的资料类型。" })[reason] || "处理没有完成，请刷新后重试。"; }
function questionError(reason) { return ({ synthetic_scope_required: "安全边界未通过，只能向纯虚构资料收集发布问题。", issue_not_actionable: "关联问题已经处理，请刷新查看。", question_not_published: "这个问题已经关闭。", manager_required: "当前账号没有发布客户问题的权限。" })[reason] || "客户问题没有保存，请稍后重试。"; }
function completionError(reason) { return ({ completeness_not_complete: "资料清单尚未齐全。", open_issues_remaining: "仍有客户问题或处理事项未完成。", documents_still_processing: "仍有资料正在处理或等待确认。", manager_required: "当前资料收集不允许普通员工完成。" })[reason] || "暂时无法完成这项资料收集。"; }
function taskError(reason) { return ({ task_not_owned: "这项任务未分配给当前账号。", transition_not_allowed: "任务当前状态不允许这个操作。" })[reason] || "任务状态没有更新。"; }
function taskStatusText(status) { return ({ open: "待开始", waiting: "等待中", in_progress: "进行中", completed: "已完成", cancelled: "已取消" })[status] || status; }
function formatDate(value) { try { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)); } catch { return value; } }
function showFormError(message) { $("#client-form-error").textContent = message; $("#client-form-error").hidden = false; }
function hideFormError() { $("#client-form-error").hidden = true; }
function showToast(message) { let toast = $("#toast"); if (!toast) { toast = document.createElement("div"); toast.id = "toast"; toast.className = "toast"; toast.setAttribute("role", "status"); document.body.append(toast); } toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2600); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function cssEscape(value) { return window.CSS?.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, ""); }
function pad(value) { return String(value).padStart(2, "0"); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

void bootstrap();

function localUploadPanel(item) {
  if (["completed", "cancelled"].includes(item.status)) return "";
  return `<section class="detail-section"><header><h2>上传本地文件</h2><span>纯虚构资料</span></header>
    <p>支持 PDF、PNG、JPEG，每次一份，最大 20 MB。文件保存成功后即可打开原件。</p>
    <form data-local-upload="${escapeHtml(item.id)}" class="local-upload-form">
      <label class="field" for="local-document"><span>选择一份文件</span><input id="local-document" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" required></label>
      <button class="button primary" type="submit">保存到本机</button>
      <p data-local-upload-result role="status" aria-live="polite"></p>
    </form></section>`;
}
async function uploadLocalDocument(event) {
  const form = event.target.closest("[data-local-upload]");
  if (!form || !LOCAL_PERSISTENCE) return;
  event.preventDefault();
  const file = form.querySelector('input[type="file"]').files[0];
  const notice = form.querySelector("[data-local-upload-result]");
  if (!file) { notice.textContent = "请先选择文件。"; return; }
  if (!file.size || file.size > 20 * 1024 * 1024) { notice.textContent = "请选择非空且不超过 20 MB 的文件。"; return; }
  const type = ({pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg"})[file.name.split(".").pop().toLowerCase()];
  if (!type) { notice.textContent = "仅支持 PDF、PNG 和 JPEG。"; return; }
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true; button.textContent = "正在保存…"; notice.textContent = "正在保存文件与记录，请稍候。";
  try {
    const response = await fetch(`/v1/local/cases/${encodeURIComponent(form.dataset.localUpload)}/documents`, {
      method:"POST", headers:{"content-type":type,"x-dop-filename":encodeURIComponent(file.name),"x-dop-csrf":state.session.csrfToken},body:file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(({file_signature_mismatch:"文件内容与扩展名不一致，请选择有效文件。",document_storage_unavailable:"文件暂未保存成功，请检查本机磁盘后重试。",case_closed:"本次资料收集已关闭。",session_required:"登录已过期，请重新登录。"})[result.error || result.reason] || "未能确认保存成功，请刷新检查后重试；相同文件不会重复记录。");
    await openCase(form.dataset.localUpload);
    const updated = $("[data-local-upload-result]");
    if (updated) updated.textContent = result.outcome === "duplicate" ? "这份文件已经保存，无需重复上传。" : "文件和记录已保存到本机。可查看原件并进行分类。";
    state.cases = null;
  } catch (error) { notice.textContent = error.message; }
  finally { button.disabled = false; button.textContent = "保存到本机"; }
}

async function loadLocalAI() {
  let panel=$("#local-ai-settings");
  if(!panel) {
    panel=document.createElement("details"); panel.id="local-ai-settings";panel.className="sidebar-note";
    panel.innerHTML=`<summary>本机 AI 设置</summary><p data-ai-status>正在读取…</p>
      <form id="local-ai-form"><label>API 密钥（留空保留原值）<input name="apiKey" type="password" autocomplete="off"></label>
      <label><input name="enabled" type="checkbox">启用付费 AI，仅在点击分类时调用</label>
      <label>累计预算上限（USD）<input name="budgetUsd" type="number" min="0" max="100" step="0.5" value="3"></label>
      <label>累计分类尝试上限<input name="maxCalls" type="number" min="0" max="200" value="6"></label>
      <p>选中的文件会发送至 OpenAI。每次预留最多 USD 0.50；不自动重试。没有密钥也可人工处理。额度用完后，只有你主动提高累计上限才可继续调用；历史记录不会清零。</p>
      <button class="button secondary" type="submit">保存本机设置</button></form>`;
    $(".sidebar").append(panel);
    panel.querySelector("form").addEventListener("submit",async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector("button");button.disabled=true;
      try {
        const response=await workbenchMutation("/v1/local/ai",{apiKey:form.elements.apiKey.value,enabled:form.elements.enabled.checked,
          budgetUsd:Number(form.elements.budgetUsd.value),maxCalls:Number(form.elements.maxCalls.value)});
        if(!response.ok)throw Error("设置未保存，请检查预算和次数。");
        form.elements.apiKey.value="";await loadLocalAI();showToast("本机设置已保存，登录密码保持不变。");
      } catch(error){showToast(error.message);}finally{button.disabled=false;}
    });
  }
  try {
    const response=await fetch("/v1/local/ai");if(!response.ok)return;
    const data=await response.json();panel.querySelector("[data-ai-status]").textContent=`${data.model} · ${!data.enabled||!data.keyConfigured?"未启用，可人工处理":data.callsUsed>=data.maxCalls||data.reservedUsd+0.5>data.budgetUsd?"额度已用完，可人工处理":"已启用"} · 已用 ${data.callsUsed}/${data.maxCalls} 次 · 已预留 USD ${data.reservedUsd}/${data.budgetUsd}`;
    panel.querySelector('[name="enabled"]').checked=data.enabled;
    if(data.budgetUsd)panel.querySelector('[name="budgetUsd"]').value=data.budgetUsd;
    if(data.maxCalls)panel.querySelector('[name="maxCalls"]').value=data.maxCalls;
  }catch{}
}
