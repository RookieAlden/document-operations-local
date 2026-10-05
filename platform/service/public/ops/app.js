const LOCAL_PERSISTENCE = document.body.dataset.localPersistence === "true";
const state = {
  overview: null, caseDetail: null, tasks: null, access: null, retention: null, demoForm: null, sessions: null, onboarding: null, configurations: null, casePlans: null, workPackages: null, classificationProfile: null, classifierReleases: null, sourceConnectors: null, releaseReadiness: null, uatBlueprints: null, health: null, view: "today", loading: false,
  reviewSubmitting: false, issueSubmitting: false, selectedIssueIds: new Set(), batchFormOpen: false,
  accessSubmitting: false, sessionSubmitting: false, onboardingSubmitting: false, configurationSubmitting: false, casePlanSubmitting: false, workPackageSubmitting: false, classificationProfileSubmitting: false, classifierReleaseSubmitting: false, sourceConnectorSubmitting: false, releaseReadinessSubmitting: false, missingRequestSubmitting: false,
  trialSubmitting: false, uploadSubmitting: false, completionSubmitting: false, taskSubmitting: false, taskAction: null, retentionSubmitting:false, demoFormSubmitting:false,
};

const $ = (selector) => document.querySelector(selector);
const bootView = $("#boot-view");
const bootStatus = $("#boot-status");
const bootMessage = $("#boot-message");
const bootRetry = $("#boot-retry");
const loginView = $("#login-view");
const appShell = $("#app-shell");
const loginForm = $("#login-form");
const loginEmail = $("#login-email");
const loginPassword = $("#login-password");
const loginRemember = $("#login-remember");
const loginError = $("#login-error");
const loadingState = $("#loading-state");
const notice = $("#notice");

const viewCopy = {
  today: ["今日工作", "先处理阻断、逾期和需要人工判断的资料。"],
  tasks: ["任务", "领取并推进 Case 完成后产生的内部工作；主管可以改派或重开。"],
  trial: ["我的试运行", "创建干净 Case、上传纯虚构资料，并亲自走到完成与下一任务。"],
  cases: ["全部 Case", "按客户、期间和资料清单查看收集进度。"],
  "case-detail": ["Case 工作台", "在一个上下文内核对资料清单、文件关系、重试证据和开放问题。"],
  review: ["人工复核", "查看 AI 证据与异常原因，最终判断仍由人负责。"],
  system: ["系统状态", "确认数据边界、运行健康和最近业务事件。"],
  onboarding: ["工作对象开户", "从版本化工作包建立对象与第一份可审阅配置草稿。"],
  "work-packages": ["Work Package", "以结构化草稿、差异和虚构 dry-run 管理可复用资料任务。"],
  "classification-profile": ["分类体系", "版本化管理资料语言、抽取字段、判断阈值与人工复核边界。"],
  "classifier-releases": ["模型发布", "把 Prompt、模型、严格输出 Schema 与分类体系作为一个可评估、可追溯的运行版本。"],
  "source-connectors": ["资料来源", "统一治理资料入口的能力、凭证引用、离线 Adapter 重放、审批、暂停与撤销。"],
  "release-readiness": ["发布准备", "固定 DEV→UAT 候选、前置证据与回滚指针；准备与批准都不会执行部署。"],
  configuration: ["客户与工作配置", "以版本化草稿管理客户档案、资料要求与工作流定义。"],
  "case-plans": ["Case 计划", "先预览未来期间与截止规则，再由主管批准创建。"],
  retention: ["数据生命周期", "预览到期资料、设置Legal Hold、执行去敏并核对删除与恢复证据。"],
  "demo-form": ["销售演示入口", "为指定的纯虚构 UAT Case 生成受限 Fillout 上传与补交链接。"],
  access: ["人员与访问", "由 Canonical Actor 控制角色、状态和可追责身份。"],
};

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const button = loginForm.querySelector("button");
  button.disabled = true;
  button.textContent = "正在验证…";
  try {
    const response = await fetch("/v1/ops/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: loginEmail.value,
        password: loginPassword.value,
        rememberDevice: loginRemember.checked,
      }),
    });
    if (!response.ok) {
      const message = response.status === 429
        ? "尝试次数过多，请在一分钟后再试。"
        : response.status === 403
          ? "身份已验证，但尚未获准进入这个组织。请联系 DEV 管理员。"
          : response.status === 503
            ? "身份服务暂时不可用，请稍后重试。"
            : "邮箱或密码不正确。";
      throw new Error(message);
    }
    loginPassword.value = "";
    await enterApp();
  } catch (error) {
    loginError.textContent = error instanceof Error ? error.message : "无法登录运营台。";
    loginError.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "验证身份并进入";
  }
});

$("#logout-button").addEventListener("click", async () => {
  await fetch("/v1/ops/session", { method: "DELETE" }).catch(() => undefined);
  if (LOCAL_PERSISTENCE) { location.href="/workbench"; return; }
  appShell.hidden = true;
  loginView.hidden = false;
  loginEmail.focus();
});

$("#refresh-button").addEventListener("click", () => loadOverview(true));
$("#trial-form").addEventListener("submit", handleTrialSubmit);
$("#trial-configuration").addEventListener("change", fillTrialDefaults);
$("#trial-case-list").addEventListener("click", handleCaseOpen);
$("#case-search").addEventListener("input", renderCases);
$("#case-status-filter").addEventListener("change", renderCases);
$("#priority-cases").addEventListener("click", handleCaseOpen);
$("#cases-table-region").addEventListener("click", handleCaseOpen);
$("#case-detail-back").addEventListener("click", () => switchView("cases"));
$("#case-detail-content").addEventListener("click", handleCaseDetailClick);
$("#case-detail-content").addEventListener("change", handleIssueSelection);
$("#case-detail-content").addEventListener("submit", handleCaseDetailSubmit);
$("#recent-documents-list").addEventListener("click", handleDocumentClick);
$("#review-queue").addEventListener("click", handleReviewClick);
$("#review-queue").addEventListener("submit", handleReviewSubmit);
$("#decision-history-list").addEventListener("click", handleReviewClick);
$("#decision-history-list").addEventListener("submit", handleReviewSubmit);
$("#issue-list").addEventListener("click", handleIssueClick);
$("#issue-list").addEventListener("submit", handleIssueSubmit);
$("#issue-list").addEventListener("change", handleIssueSelection);
$("#issue-batch-actions").addEventListener("click", handleBatchClick);
$("#issue-batch-actions").addEventListener("submit", handleBatchSubmit);
$("#tasks-view").addEventListener("click", handleTaskClick);
$("#tasks-view").addEventListener("submit", handleTaskSubmit);
$("#task-scope-filter").addEventListener("change", renderTasks);
$("#task-status-filter").addEventListener("change", renderTasks);
$("#task-due-filter").addEventListener("change", renderTasks);
$("#invitation-form").addEventListener("submit", handleInvitationSubmit);
$("#access-members").addEventListener("submit", handleActorAccessSubmit);
$("#access-invitations").addEventListener("submit", handleInvitationCancel);
$("#session-list").addEventListener("submit", handleSessionRevoke);
$("#session-revoke-others-form").addEventListener("submit", handleOtherSessionsRevoke);
$("#session-cleanup-form").addEventListener("submit", handleSessionCleanup);
$("#onboarding-form").addEventListener("submit", handleOnboardingSubmit);
$("#onboarding-packages").addEventListener("click", handlePackageSelection);
$("#configuration-list").addEventListener("submit", handleConfigurationSubmit);
$("#case-plans-view").addEventListener("submit", handleCasePlanSubmit);
$("#work-packages-view").addEventListener("submit", handleWorkPackageSubmit);
$("#work-packages-view").addEventListener("click", handleWorkPackageClick);
$("#classification-profile-view").addEventListener("submit", handleClassificationProfileSubmit);
$("#classification-profile-view").addEventListener("click", handleClassificationProfileClick);
$("#classifier-releases-view").addEventListener("submit", handleClassifierReleaseSubmit);
$("#source-connectors-view").addEventListener("submit", handleSourceConnectorSubmit);
$("#release-readiness-view").addEventListener("submit", handleReleaseReadinessSubmit);
$("#retention-view").addEventListener("submit", handleRetentionSubmit);
$("#demo-form-view").addEventListener("submit", handleDemoFormSubmit);
$("#demo-form-view").addEventListener("click", handleDemoFormClick);
$("#demo-form-view").addEventListener("change", handleDemoFormChange);

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-go-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.goView)));
bootRetry.addEventListener("click", bootstrap);

async function bootstrap() {
  bootView.hidden = false;
  loginView.hidden = true;
  appShell.hidden = true;
  bootRetry.hidden = true;
  bootStatus.textContent = "正在连接运营台…";
  bootMessage.textContent = "正在确认本设备的安全会话；短暂冷启动会自动重试。";

  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch("/v1/ops/overview");
      if (response.status === 401 || response.ok) break;
    } catch {
      response = undefined;
    }
    bootStatus.textContent = "服务正在启动…";
    bootMessage.textContent = `第 ${attempt + 1} 次连接暂未成功，正在自动重试。`;
    await delay(600 * (attempt + 1));
  }

  if (response?.status === 401) {
    if (LOCAL_PERSISTENCE) { location.href="/workbench"; return; }
    bootView.hidden = true;
    loginView.hidden = false;
    loginEmail.focus();
    return;
  }
  if (!response?.ok) {
    bootStatus.textContent = "暂时无法读取运营数据";
    bootMessage.textContent = "你的已保存会话没有被清除。请重新连接；只有服务明确确认会话无效时才会要求登录。";
    bootRetry.hidden = false;
    return;
  }
  bootView.hidden = true;
  loginView.hidden = true;
  appShell.hidden = false;
  state.overview = await response.json();
  await loadHealth();
  loadingState.hidden = true;
  renderAll();
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function enterApp() {
  loginView.hidden = true;
  appShell.hidden = false;
  await loadOverview(false);
  $("#main-content").focus();
}

async function loadOverview(announce) {
  if (state.loading) return;
  state.loading = true;
  loadingState.hidden = false;
  document.querySelectorAll(".view").forEach((view) => { view.hidden = true; });
  const button = $("#refresh-button");
  button.disabled = true;
  button.textContent = "刷新中…";
  hideNotice();
  try {
    const [overviewResponse] = await Promise.all([fetch("/v1/ops/overview"), loadHealth()]);
    if (overviewResponse.status === 401) {
      appShell.hidden = true;
      loginView.hidden = false;
      showLoginError("会话已过期或身份已被撤销，请重新登录。 ");
      return;
    }
    if (!overviewResponse.ok) throw new Error("无法读取运营数据。请确认 Intake 服务和数据库连接正常。 ");
    state.overview = await overviewResponse.json();
    state.selectedIssueIds.clear();
    state.batchFormOpen = false;
    renderAll();
    if (announce) showNotice("数据已刷新。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "刷新失败。", true);
    document.querySelector(`#${state.view}-view`).hidden = false;
  } finally {
    state.loading = false;
    loadingState.hidden = true;
    button.disabled = false;
    button.textContent = "刷新数据";
  }
}

async function loadHealth() {
  try {
    const response = await fetch("/health");
    state.health = response.ok ? await response.json() : null;
  } catch { state.health = null; }
  applyRuntimeEnvironment();
}

function runtimeEnvironment() {
  const value = typeof state.health?.environment === "string" ? state.health.environment.toUpperCase() : "";
  return LOCAL_PERSISTENCE ? "本地" : ["DEV", "UAT", "PROD"].includes(value) ? value : "受控环境";
}

function applyRuntimeEnvironment() {
  const environment = runtimeEnvironment();
  document.title = `资料运营台 · ${environment}`;
  $("#login-environment").textContent = `${environment} · Synthetic only`;
  $("#brand-environment").textContent = `${environment} · 通用分类工作流`;
}

function renderAll() {
  if (!state.overview) return;
  const o = state.overview;
  $("#nav-attention-count").value = String(o.summary.reviewDocumentCount + o.summary.overdueCaseCount + o.summary.openIssueCount);
  $("#nav-task-count").value = String(state.tasks?.tasks.filter((item) => !["completed", "cancelled"].includes(item.status)
    && (item.assignedActorId === o.operator.id || item.assignedActorId === null)).length ?? 0);
  $("#nav-case-count").value = String(o.cases.length);
  $("#nav-review-count").value = String(o.reviewQueue.length);
  $("#nav-system-count").value = String(o.summary.manualErrorCount + o.summary.overdueRetryCount);
  $("#last-updated").textContent = `更新于 ${formatTime(o.generatedAt)}`;
  $("#operator-name").textContent = o.operator?.displayName ?? "未识别";
  const isAdmin = o.operator?.actorType === "admin";
  const isConfigurationReader = ["manager", "admin"].includes(o.operator?.actorType);
  $("#trial-nav").hidden = !isConfigurationReader;
  $("#nav-trial-count").value = String(o.cases.filter((item) => !["completed", "cancelled"].includes(item.status)).length);
  $("#onboarding-nav").hidden = !isAdmin;
  $("#work-packages-nav").hidden = !isConfigurationReader;
  $("#classification-profile-nav").hidden = !isConfigurationReader;
  $("#classifier-releases-nav").hidden = !isConfigurationReader;
  $("#source-connectors-nav").hidden = !isConfigurationReader;
  $("#configuration-nav").hidden = !isConfigurationReader;
  $("#case-plans-nav").hidden = !isConfigurationReader;
  $("#release-readiness-nav").hidden = !isConfigurationReader;
  $("#retention-nav").hidden = !isConfigurationReader;
  $("#demo-form-nav").hidden = !isConfigurationReader;
  $("#access-nav").hidden = !isAdmin;
  $("#nav-onboarding-count").value = String(state.onboarding?.recentOnboardings.length ?? 0);
  $("#nav-work-packages-count").value = String(new Set(state.workPackages?.versions.filter((item) => item.packageStatus === "active").map((item) => item.packageId) ?? []).size);
  $("#nav-classification-profile-count").value = String(state.classificationProfile?.versions.find((item) => item.isCurrentPublished)?.definition.labels.length ?? 0);
  $("#nav-classifier-releases-count").value = String(state.classifierReleases?.versions.find((item) => item.isCurrentPublished)?.version ?? 0);
  $("#nav-source-connectors-count").value = String(new Set(state.sourceConnectors?.versions.map((item) => item.connectorId) ?? []).size);
  $("#nav-configuration-count").value = String(state.configurations?.releases.filter((item) => item.isCurrentPublished).length ?? 0);
  $("#nav-case-plans-count").value = String(state.casePlans?.versions.filter((item) => item.isCurrentPublished).length ?? 0);
  $("#nav-release-readiness-count").value = String(state.releaseReadiness?.manifests.filter((item) => item.status === "in_review" || item.status === "draft").length ?? 0);
  $("#nav-retention-count").value = String((state.retention?.activeHolds.length??0)+(state.retention?.recentRuns.filter((item)=>["queued","processing","failed"].includes(item.status)).length??0));
  $("#nav-demo-form-count").value = String(state.demoForm?.invitations.filter((item) => item.status === "active").length ?? 0);
  $("#nav-access-count").value = String(state.access?.members.filter((item) => item.status === "active").length ?? 0);
  if (!isAdmin && state.view === "access") state.view = "today";
  if (!isAdmin && state.view === "onboarding") state.view = "today";
  if (!isConfigurationReader && state.view === "trial") state.view = "today";
  if (!isConfigurationReader && state.view === "work-packages") state.view = "today";
  if (!isConfigurationReader && state.view === "classification-profile") state.view = "today";
  if (!isConfigurationReader && state.view === "classifier-releases") state.view = "today";
  if (!isConfigurationReader && state.view === "source-connectors") state.view = "today";
  if (!isConfigurationReader && state.view === "configuration") state.view = "today";
  if (!isConfigurationReader && state.view === "case-plans") state.view = "today";
  if (!isConfigurationReader && state.view === "release-readiness") state.view = "today";
  if (!isConfigurationReader && state.view === "retention") state.view = "today";
  if (!isConfigurationReader && state.view === "demo-form") state.view = "today";
  const environment = runtimeEnvironment();
  $("#view-context").textContent = `${weekday(o.generatedAt)} · ${state.health?.status === "ok" ? `${environment} 运行正常` : `${environment} 状态待确认`}`;
  renderSummary();
  renderPriorityCases();
  renderTodayReviews();
  renderIssues();
  renderCases();
  renderRecentDocuments();
  renderReviewQueue();
  renderDecisionHistory();
  renderSystem();
  renderTrial();
  if (state.tasks) renderTasks();
  switchView(state.view);
}

function switchView(view) {
  if (!(view in viewCopy)) return;
  if (view === "access" && state.overview?.operator?.actorType !== "admin") return;
  if (view === "onboarding" && state.overview?.operator?.actorType !== "admin") return;
  if (view === "trial" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "work-packages" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "classification-profile" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "classifier-releases" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "source-connectors" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "configuration" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "case-plans" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "release-readiness" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "retention" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  if (view === "demo-form" && !["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  state.view = view;
  if (view !== "case-detail") state.caseDetail = null;
  if (!["today", "case-detail"].includes(view)) {
    state.selectedIssueIds.clear();
    state.batchFormOpen = false;
  }
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.view === view || (view === "case-detail" && item.dataset.view === "cases")));
  document.querySelectorAll(".view").forEach((item) => { item.hidden = item.id !== `${view}-view`; });
  $("#view-title").textContent = viewCopy[view][0];
  $("#view-description").textContent = viewCopy[view][1];
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "access") loadAccess();
  if (view === "tasks") loadTasks();
  if (view === "system") loadSessions();
  if (view === "onboarding") loadOnboarding();
  if (view === "trial") {
    if (!state.configurations) loadConfigurations();
    else renderTrial();
  }
  if (view === "work-packages") loadWorkPackages();
  if (view === "classification-profile") loadClassificationProfile();
  if (view === "classifier-releases") loadClassifierReleases();
  if (view === "source-connectors") loadSourceConnectors();
  if (view === "configuration") loadConfigurations();
  if (view === "case-plans") loadCasePlans();
  if (view === "release-readiness") loadReleaseReadiness();
  if (view === "retention") loadRetention();
  if (view === "demo-form") loadDemoForm();
}

function renderSummary() {
  const s = state.overview.summary;
  const items = [
    [s.activeCaseCount, "进行中的 Case", ""],
    [s.overdueCaseCount, "已经逾期", "is-alert"],
    [s.reviewDocumentCount, "等待人工判断", "is-review"],
    [s.openIssueCount, "开放问题", s.openIssueCount ? "is-alert" : ""],
  ];
  replaceChildren($("#attention-summary"), items.map(([value, label, className]) => el("div", { className: `summary-item ${className}`.trim() }, [
    el("strong", { text: String(value) }), el("span", { text: label }),
  ])));
}

function renderPriorityCases() {
  const priority = state.overview.cases.filter((item) => item.riskStatus !== "normal" || item.openIssueCount > 0 || item.status === "review_required");
  const list = priority.length ? priority.slice(0, 6) : state.overview.cases.slice(0, 4);
  replaceChildren($("#priority-cases"), list.length ? list.map(caseRow) : [emptyState("还没有 Case", "Canonical Intake 接受第一份资料后，Case 会出现在这里。")]);
}

function caseRow(item) {
  return el("article", { className: "case-row" }, [
    el("div", { className: "case-primary" }, [el("strong", { text: item.subjectName }), el("span", { text: period(item) })]),
    requirementProgress(item),
    el("div", { className: "case-due" }, [el("span", { text: "截止" }), el("strong", { text: item.dueAt ? formatDate(item.dueAt) : "未设置" })]),
    statusLabel(item.riskStatus !== "normal" ? item.riskStatus : item.status),
    openCaseButton(item.id),
  ]);
}

function requirementProgress(item) {
  const box = el("div", { className: "case-progress" });
  box.append(el("div", { className: "case-progress-meta" }, [
    el("span", { text: `资料清单 ${item.acceptedRequirementCount}/${item.requiredRequirementCount}` }),
    el("span", { text: `${item.documentCount} 个文件` }),
  ]));
  const rail = el("div", { className: "requirement-rail", attrs: { "aria-label": requirementAria(item) } });
  for (const requirement of item.requirements) {
    for (let index = 0; index < Math.max(requirement.minimumCount, 1); index += 1) {
      const complete = index < requirement.acceptedCount;
      const review = !complete && requirement.reviewCount > 0;
      const tick = el("span", {
        className: `requirement-tick ${complete ? "is-complete" : review ? "is-review" : "is-missing"}`,
        attrs: { title: `${requirement.displayName}：${complete ? "已满足" : review ? "待复核" : "缺少"}`, "aria-hidden": "true" },
      });
      rail.append(tick);
    }
  }
  box.append(rail);
  return box;
}

function renderTodayReviews() {
  const items = state.overview.reviewQueue.slice(0, 5);
  replaceChildren($("#today-review-list"), items.length ? items.map(reviewRow) : [emptyState("没有待人工判断的资料", "新出现的低置信度、冲突或质量问题会进入这里。")]);
}

function reviewRow(item) {
  return el("article", { className: "review-row" }, [
    el("div", { className: "row-title" }, [el("strong", { text: item.filename }), el("span", { text: `${item.subjectName} · ${period(item)}` })]),
    statusLabel(item.status),
    el("div", { className: "confidence" }, [el("span", { text: "AI 置信度" }), document.createTextNode(item.confidence === null ? "—" : `${Math.round(item.confidence * 100)}%`)]),
  ]);
}

function renderIssues() {
  const items = state.overview.issues;
  replaceChildren($("#issue-list"), items.length ? items.map(issueRow) : [emptyState("没有开放问题", "当前没有需要路由或升级的问题。")]);
  renderBatchToolbar($("#issue-batch-actions"));
}

function issueRow(item) {
  const selectable = ["open", "reopened", "assigned", "waiting_internal", "waiting_external"].includes(item.status);
  return el("article", { className: `issue-detail ${state.selectedIssueIds.has(item.id) ? "is-selected" : ""}`, attrs: { "data-issue-id": item.id } }, [
    ...(selectable ? [el("label", { className: "issue-select" }, [
      el("input", { attrs: { type: "checkbox", "data-issue-select": item.id, ...(state.selectedIssueIds.has(item.id) ? { checked: "" } : {}) } }),
      el("span", { text: "选择此问题" }),
    ])] : []),
    el("div", { className: "issue-heading" }, [
      el("div", { className: "row-title" }, [el("strong", { text: issueName(item) }), el("span", { text: `${item.subjectName}${item.filename ? ` · ${item.filename}` : ""}` })]),
      statusLabel(item.status),
    ]),
    el("div", { className: "issue-meta" }, [
      el("span", { text: `级别：${statusText(item.severity)}` }),
      el("span", { text: `负责人：${item.assignedActorName ?? "未分配"}` }),
    ]),
    issueActions(item),
  ]);
}

function issueActions(item) {
  const region = el("div", { className: "issue-actions", attrs: { "data-issue-actions": item.id } });
  const buttons = el("div", { className: "review-action-buttons" });
  const manager = ["manager", "admin"].includes(state.overview.operator.actorType);
  if (["open", "reopened", "assigned", "waiting_internal", "waiting_external"].includes(item.status)
      && item.assignedActorId !== state.overview.operator.id) {
    buttons.append(issueActionButton("分配给我", "assign_to_me", "button-secondary"));
  }
  if (["assigned", "waiting_external", "waiting_internal", "reopened"].includes(item.status)) {
    buttons.append(issueActionButton("等待内部", "wait_internal", "button-quiet"));
    buttons.append(issueActionButton("等待客户", "wait_external", "button-quiet"));
    buttons.append(issueActionButton("标记解决", "resolve", "button-primary-inline"));
  }
  if (manager && ["resolved", "closed"].includes(item.status)) buttons.append(issueActionButton("重新打开", "reopen", "button-secondary"));
  if (manager && item.status === "resolved") buttons.append(issueActionButton("关闭", "close", "button-quiet"));
  if (buttons.children.length) region.append(buttons);
  return region;
}

function issueActionButton(label, action, className) {
  return el("button", { className: `button button-small ${className}`, text: label, attrs: { type: "button", "data-issue-action": action } });
}

function renderCases() {
  if (!state.overview) return;
  const query = $("#case-search").value.trim().toLocaleLowerCase();
  const filter = $("#case-status-filter").value;
  const cases = state.overview.cases.filter((item) => {
    const matchesQuery = !query || `${item.subjectName} ${item.subjectKey} ${period(item)}`.toLocaleLowerCase().includes(query);
    const matchesStatus = filter === "all" || (filter === "attention" ? item.riskStatus !== "normal" || item.openIssueCount > 0 : item.status === filter);
    return matchesQuery && matchesStatus;
  });
  const region = $("#cases-table-region");
  if (!cases.length) return replaceChildren(region, [emptyState("没有符合条件的 Case", "调整客户、期间或状态筛选后再试。")]);
  const table = el("table", { className: "case-table" });
  table.append(el("thead", {}, [el("tr", {}, ["客户与期间", "资料清单", "状态", "截止", "问题", "操作"].map((text) => el("th", { text, attrs: { scope: "col" } })))]));
  const body = el("tbody");
  for (const item of cases) {
    const client = el("td", { className: "table-client", attrs: { "data-label": "客户与期间" } }, [el("strong", { text: item.subjectName }), el("span", { text: period(item) })]);
    const progress = el("td", { className: "requirement-cell", attrs: { "data-label": "资料清单" } }, [requirementProgress(item)]);
    body.append(el("tr", {}, [
      client,
      progress,
      el("td", { attrs: { "data-label": "状态" } }, [statusLabel(item.riskStatus !== "normal" ? item.riskStatus : item.status)]),
      el("td", { text: item.dueAt ? formatDate(item.dueAt) : "未设置", attrs: { "data-label": "截止" } }),
      el("td", { text: item.openIssueCount ? `${item.openIssueCount} 个开放` : "无", attrs: { "data-label": "问题" } }),
      el("td", { attrs: { "data-label": "操作" } }, [openCaseButton(item.id)]),
    ]));
  }
  table.append(body);
  replaceChildren(region, [table]);
}

function openCaseButton(caseId) {
  return el("button", { className: "button button-quiet button-small", text: "打开 Case", attrs: { type: "button", "data-open-case": caseId } });
}

function handleCaseOpen(event) {
  const button = event.target.closest("[data-open-case]");
  if (button) openCase(button.dataset.openCase);
}

async function openCase(caseId) {
  state.view = "case-detail";
  state.caseDetail = null;
  state.selectedIssueIds.clear();
  state.batchFormOpen = false;
  switchView("case-detail");
  replaceChildren($("#case-detail-content"), [emptyState("正在读取 Case…", "正在汇总资料、问题和业务事件。")]);
  try {
    const response = await fetch(`/v1/ops/cases/${encodeURIComponent(caseId)}`);
    if (response.status === 401) {
      appShell.hidden = true;
      loginView.hidden = false;
      showLoginError("会话已过期或身份已被撤销，请重新登录。 ");
      return;
    }
    if (!response.ok) throw new Error(response.status === 404 ? "这个 Case 已不存在或不属于当前组织。" : "Case 详情暂时不可用。");
    state.caseDetail = await response.json();
    renderCaseDetail();
  } catch (error) {
    replaceChildren($("#case-detail-content"), [emptyState("无法打开 Case", error instanceof Error ? error.message : "请稍后重试。")]);
  }
}

function renderCaseDetail() {
  const detail = state.caseDetail;
  if (!detail) return;
  const item = detail.case;
  $("#view-title").textContent = item.subjectName;
  $("#view-description").textContent = `${period(item)} · ${item.subjectKey}`;
  const summary = el("section", { className: "case-detail-summary", attrs: { "aria-label": "Case 摘要" } }, [
    detailStat("资料清单", `${item.acceptedRequirementCount}/${item.requiredRequirementCount}`, "最低要求的已接受份数"),
    detailStat("文件", String(item.documentCount), "保留所有版本与重复项"),
    detailStat("开放问题", String(item.openIssueCount), item.openIssueCount ? "需要继续流转" : "当前没有阻断"),
    detailStat("截止", item.dueAt ? formatDate(item.dueAt) : "未设置", statusText(item.riskStatus)),
  ]);
  const upload = caseUploadPanel(item);
  const completeness = completenessPanel(item.completeness);
  const missingRequestDraft = missingRequestDraftPanel(detail.missingDocumentRequestDraft);
  const reminders = reminderPanel(detail.reminders ?? []);
  const requirements = el("section", { className: "work-section", attrs: { "aria-labelledby": "case-requirements-title" } }, [
    sectionHeading("case-requirements-title", "资料清单", "按固定要求版本计算缺件、待复核、重复与超量。"),
    el("div", { className: "requirement-list" }, item.requirements.length ? item.requirements.map(requirementDetail) : [emptyState("没有配置资料要求", "请检查该 Case 使用的配置包版本。")]),
  ]);
  const documents = el("section", { className: "work-section", attrs: { "aria-labelledby": "case-documents-title" } }, [
    sectionHeading("case-documents-title", "资料与处理证据", "同内容文件与同名版本会明确标识；开放重试不会被隐藏。"),
    el("div", { className: "case-document-list" }, detail.documents.length ? detail.documents.map(caseDocument) : [emptyState("还没有资料", "新资料进入 Canonical Intake 后会显示在这里。")]),
  ]);
  const issueBatch = el("div", { attrs: { id: "case-issue-batch-actions" } });
  const issues = el("section", { className: "work-section", attrs: { "aria-labelledby": "case-issues-title" } }, [
    sectionHeading("case-issues-title", "Case 问题", "可逐项处理；安全批量操作只允许“分派给我”。"),
    issueBatch,
    el("div", { attrs: { id: "case-issue-list" } }, detail.issues.length ? detail.issues.map(issueRow) : [emptyState("没有问题", "这个 Case 当前不需要问题流转。")]),
  ]);
  const completion = caseCompletionPanel(detail);
  const activity = el("section", { className: "work-section", attrs: { "aria-labelledby": "case-activity-title" } }, [
    sectionHeading("case-activity-title", "最近业务事件", "只显示与这个 Case、其文件或问题相关的 Canonical 事件。"),
    el("div", {}, detail.recentActivity.length ? detail.recentActivity.map(activityRow) : [emptyState("还没有业务事件", "该 Case 的业务事件会按时间倒序出现。")]),
  ]);
  replaceChildren($("#case-detail-content"), [summary, upload, completeness, ...(LOCAL_PERSISTENCE ? [] : [missingRequestDraft, reminders]), requirements, documents, issues, completion, activity]);
  renderBatchToolbar(issueBatch);
}

function caseUploadPanel(item) {
  const section = el("section", { className: "work-section upload-section", attrs: { "aria-labelledby": "case-upload-title" } });
  section.append(sectionHeading("case-upload-title", item.documentCount ? "补交纯虚构资料" : "上传第一批纯虚构资料",
    "支持 PDF、JPG、PNG，单个文件不超过 20MB。原件私有保存成功后才进入 AI 分类。"));
  if (["completed", "cancelled"].includes(item.status)) {
    section.append(emptyState("这个 Case 已关闭", "已完成或已取消的 Case 不再接受资料。"));
    return section;
  }
  const form = el("form", { className: "upload-form", attrs: { "data-case-upload": item.id } });
  form.append(el("label", { className: "upload-picker" }, [
    el("span", { text: "选择文件" }),
    el("input", { attrs: { name: "documents", type: "file", accept: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png", multiple: "", required: "" } }),
    el("small", { text: "请确认文件中没有真实客户、真实账号、真实联系方式或其他真实个人信息。" }),
  ]));
  form.append(el("div", { className: "upload-actions" }, [
    el("button", { className: "button button-primary-inline", text: "保存并开始处理", attrs: { type: "submit" } }),
    el("button", { className: "button button-secondary", text: "刷新处理状态", attrs: { type: "button", "data-refresh-case": item.id } }),
    el("span", { text: "外部发送保持关闭" }),
  ]));
  form.append(el("div", { className: "upload-progress", attrs: { "data-upload-progress": "", "aria-live": "polite" } }));
  section.append(form);
  return section;
}

function caseCompletionPanel(detail) {
  const section = el("section", { className: "work-section completion-section", attrs: { "aria-labelledby": "case-completion-title" } });
  section.append(sectionHeading("case-completion-title", "完成与下一任务", "只有最新完整性结论通过、资料停止处理且开放问题清零后才能完成。"));
  if (detail.handoffTask) {
    section.append(el("div", { className: "handoff-result" }, [
      el("div", {}, [statusLabel("completed"), el("strong", { text: "Case 已完成，下一任务已建立" })]),
      el("dl", { className: "handoff-facts" }, [
        evidence("任务类型", detail.handoffTask.taskType),
        evidence("负责人", detail.handoffTask.assignedActorName ?? "未分派"),
        evidence("任务状态", statusText(detail.handoffTask.status)),
        evidence("到期", detail.handoffTask.dueAt ? formatDateTime(detail.handoffTask.dueAt) : "未设置"),
        evidence("外部执行", "关闭"),
      ]),
      el("small", { text: `任务 ${shortId(detail.handoffTask.id)} · ${formatDateTime(detail.handoffTask.createdAt)}` }),
    ]));
    return section;
  }
  const blockers = [];
  if (detail.case.completeness?.status !== "complete") blockers.push("最新完整性结论尚未通过");
  if (detail.case.openIssueCount > 0) blockers.push(`还有 ${detail.case.openIssueCount} 个开放问题`);
  if (detail.documents.some((item) => !["accepted", "human_confirmed", "archived", "duplicate_skipped", "excluded"].includes(item.status))) blockers.push("仍有资料正在处理或等待复核");
  if (blockers.length) {
    section.append(el("div", { className: "completion-blocked" }, [
      el("strong", { text: "暂时不能完成" }),
      el("ul", {}, blockers.map((text) => el("li", { text }))),
    ]));
    return section;
  }
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) {
    section.append(emptyState("等待主管完成", "资料已满足条件；请由主管或管理员完成 Case 并建立下一任务。"));
    return section;
  }
  const completionReason = el("textarea", { attrs: {
    name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2",
  } });
  completionReason.value = "纯虚构资料清单已满足，开放问题已处理，确认进入下一工作环节。";
  section.append(el("form", { className: "completion-form", attrs: { "data-case-complete": detail.case.id } }, [
    el("div", {}, [el("strong", { text: "完成条件已经满足" }), el("p", { text: "完成和下一任务会在同一数据库事务中提交；重复点击不会创建第二个任务。" })]),
    el("label", {}, [el("span", { text: "完成依据" }), completionReason]),
    el("button", { className: "button button-primary-inline", text: "完成 Case 并创建下一任务", attrs: { type: "submit" } }),
  ]));
  return section;
}

function detailStat(label, value, description) {
  return el("div", {}, [el("span", { text: label }), el("strong", { text: value }), el("small", { text: description })]);
}

function reminderPanel(items) {
  const section = el("section", { className: "work-section reminder-section", attrs: { "aria-labelledby": "case-reminder-title" } });
  section.append(sectionHeading("case-reminder-title", "提醒、到期与升级", "系统按 Case 时区和工作日窗口生成；每个窗口幂等，批准也不等于发送。"));
  if (!items.length) {
    section.append(emptyState("还没有提醒窗口", "只有已确认缺件且到达配置时间的纯虚构 Case 才会生成提醒。"));
    return section;
  }
  const canManage = ["manager", "admin"].includes(state.overview?.operator?.actorType);
  const list = el("div", { className: "reminder-list" });
  for (const item of items) {
    const policy = item.policy ?? {};
    const article = el("article", { className: `reminder-card reminder-${item.status}` }, [
      el("div", { className: "reminder-heading" }, [
        el("div", {}, [statusLabel(item.status), el("strong", { text: reminderKindText(item.kind) })]),
        el("span", { className: "delivery-lock", text: "DELIVERY DISABLED" }),
      ]),
      el("p", { className: "reminder-trigger", text: item.triggerReason }),
      el("dl", { className: "reminder-facts" }, [
        evidence("计划窗口", formatDateTime(item.scheduledAt)),
        evidence("序号", String(item.sequenceNumber)),
        evidence("收件人", `${item.recipient.displayName ?? "虚构联系人"} · ${item.recipient.address}`),
        evidence("工作日", policy.workweek === "monday_friday_with_exceptions" ? "周一至周五 + 例外日" : "按配置"),
        evidence("时区", policy.timezone ?? "继承 Case"),
        evidence("升级", `${policy.escalationBusinessDays ?? "-"} 个工作日${policy.escalationDefaultApplied ? "（安全缺省）" : ""}`),
      ]),
      el("div", { className: "reminder-content" }, [
        el("strong", { text: item.content.subjectLine }),
        el("pre", { text: item.content.bodyText }),
        el("small", { text: `内容 ${item.contentHash.slice(0, 12)}… · 外部调用 ${item.externalCallCount}` }),
      ]),
    ]);
    if (item.escalation) article.append(el("div", { className: "reminder-escalation" }, [
      el("strong", { text: `已升级给 ${item.escalation.ownerName}` }),
      el("span", { text: `${statusText(item.escalation.status)} · ${formatDateTime(item.escalation.openedAt)}` }),
    ]));
    if (item.stopReason) article.append(el("p", { className: "reminder-stop", text: `停止原因：${reminderStopText(item.stopReason)}` }));
    if (item.decision) article.append(el("div", { className: "reminder-decision" }, [
      el("strong", { text: item.decision.action === "approve" ? "提醒草稿已批准" : "提醒草稿已拒绝" }),
      el("span", { text: `${item.decision.actorName} · ${formatDateTime(item.decision.decidedAt)}` }),
      el("p", { text: item.decision.reason }),
    ]));
    if (canManage && item.status === "pending_approval") {
      const form = el("form", { className: "reminder-decision-form", attrs: {
        "data-reminder-decision": item.id, "data-idempotency-key": crypto.randomUUID(),
      } }, [
        el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "",
          placeholder: "记录批准或拒绝依据；批准后仍不会发送。" } }),
        el("div", { className: "reminder-actions" }, [
          el("button", { className: "button button-primary-inline", text: "批准草稿", attrs: { type: "submit", name: "action", value: "approve" } }),
          el("button", { className: "button button-secondary", text: "拒绝草稿", attrs: { type: "submit", name: "action", value: "reject" } }),
        ]),
      ]);
      article.append(form);
    }
    list.append(article);
  }
  section.append(list);
  return section;
}

function reminderKindText(value) {
  return ({ initial: "首次缺件提醒", follow_up: "后续缺件提醒", overdue: "逾期提醒", escalation: "内部升级" })[value] ?? "提醒";
}

function reminderStopText(value) {
  return ({ case_ready: "资料已齐", case_terminal: "Case 已完成或取消", contact_revoked_or_unavailable: "联系人已撤销或不可用" })[value] ?? value;
}

function sectionHeading(id, title, description) {
  return el("div", { className: "section-heading" }, [el("div", {}, [el("h2", { text: title, attrs: { id } }), el("p", { text: description })])]);
}

function completenessPanel(item) {
  const section = el("section", { className: "work-section completeness-section", attrs: { "aria-labelledby": "case-completeness-title" } });
  section.append(sectionHeading("case-completeness-title", "完整性结论", "只在一次完整 Submission 全部进入终态后计算；后续人工决定会产生新快照。"));
  if (!item) {
    section.append(emptyState("等待首个完整提交", "当该 Case 某次提交的所有资料都完成分类或进入人工处理后，系统会生成第一份可审计结论。"));
    return section;
  }
  const nextAction = ({
    pending: "还有提交正在处理，当前结论不是最终状态。",
    review_required: "先处理待复核、未匹配、重复或超量资料。",
    incomplete: "已确认存在缺件，下一步是发起补件流转。",
    complete: "所有最低要求均已由唯一且可接受的资料满足。",
  })[item.status];
  section.append(el("div", { className: `completeness-ledger completeness-${item.status}` }, [
    el("div", { className: "completeness-conclusion" }, [
      el("div", {}, [statusLabel(item.status), el("strong", { text: completenessTitle(item.status) })]),
      el("p", { text: nextAction }),
      el("small", { text: `引擎 v${item.algorithmVersion} · ${formatDateTime(item.createdAt)} · 输入 ${item.inputHash.slice(0, 12)}…` }),
    ]),
    el("dl", { className: "completeness-counts" }, [
      evidence("缺少份数", String(item.missingRequirementCount)),
      evidence("待人工确认", String(item.reviewRequiredDocumentCount)),
      evidence("同内容重复", String(item.duplicateDocumentCount)),
      evidence("超出最高数", String(item.excessDocumentCount)),
      evidence("未归属资料", String(item.unmatchedDocumentCount)),
      evidence("活动提交", String(item.activeSubmissionCount)),
    ]),
  ]));
  return section;
}

function completenessTitle(status) {
  return ({ pending: "结论待更新", review_required: "需要运营处理", incomplete: "资料未齐", complete: "资料已齐" })[status] ?? "完整性未知";
}

function missingRequestDraftPanel(item) {
  const section = el("section", { className: "work-section request-draft-section", attrs: { "aria-labelledby": "missing-request-draft-title" } });
  section.append(sectionHeading("missing-request-draft-title", "补件请求审阅", "修订、批准、合成投递与结果核对均保留记录；真实邮箱连接仍固定关闭。"));
  if (!item) {
    section.append(emptyState("当前没有补件草稿", "资料没有确认缺件，或完整性引擎尚未生成可用快照。"));
    return section;
  }
  const latest = item.revisions?.[0] ?? null;
  const currentRecipient = latest?.recipient ?? item.recipient;
  const recipientText = currentRecipient.resolutionStatus === "ready"
    ? `${currentRecipient.displayName ?? "已确认联系人"}${currentRecipient.email ? ` · ${currentRecipient.email}` : ""}`
    : "联系人尚未确认";
  const subjectLine = latest?.subjectLine ?? item.subjectLine;
  const bodyText = latest?.bodyText ?? item.bodyText;
  const contentHash = latest?.contentHash ?? item.contentHash;
  const currentStatus = latest?.status ?? item.status;
  section.append(el("div", { className: "request-draft-ledger" }, [
    el("div", { className: "request-draft-boundary" }, [
      el("div", {}, [statusLabel(currentStatus), el("strong", { text: "仅内部审阅" })]),
      el("p", { text: "真实外部发送固定关闭。批准后可建立计划；主管还能授权仅面向 .invalid 地址的 UAT 合成投递。" }),
      el("dl", { className: "request-draft-meta" }, [
        evidence("收件人", recipientText),
        evidence("来源问题", `${item.sourceIssueCount} 项`),
        evidence("版本", `草稿 v${item.version}${latest ? ` · 修订 r${latest.revision}` : ""}`),
        evidence("外部调用", String(item.externalCallCount)),
      ]),
      el("div", { className: "request-policy-line" }, [
        el("span", { text: "收件人政策" }),
        el("strong", { text: `仅受治理名单 · ${item.recipientPolicy?.candidates?.length ?? 0} 位可选联系人` }),
        el("small", { text: "名单当前只接受有效的 Canonical 客户联系人；审批时会再次校验。" }),
      ]),
    ]),
    el("div", { className: "request-draft-content" }, [
      el("span", { text: "主题" }),
      el("strong", { text: subjectLine }),
      el("div", { className: "request-draft-items" }, item.requestedItems.map((entry) => el("div", {}, [
        el("span", { text: entry.displayName }),
        el("strong", { text: `还缺 ${entry.missingCount} 份` }),
      ]))),
      el("span", { text: "草稿正文" }),
      el("pre", { text: bodyText }),
      el("small", { text: `${formatDateTime(latest?.createdAt ?? item.createdAt)} · 内容 ${contentHash.slice(0, 12)}… · delivery disabled` }),
    ]),
  ]));
  const canReview = ["manager", "admin"].includes(state.overview?.operator?.actorType);
  if (canReview && latest) section.append(missingRequestWorkflow(item, latest));
  if (latest?.status === "approved") section.append(missingRequestDeliveryReadiness(item, latest, canReview));
  section.append(missingRequestHistory(item));
  return section;
}

function missingRequestDeliveryReadiness(item, latest, canManage) {
  const plan = (item.deliveryPlans ?? []).find((candidate) => candidate.revisionId === latest.id) ?? null;
  const evaluation = plan
    ? (item.deliveryEvaluations ?? []).find((candidate) => candidate.deliveryJobId === plan.id) ?? null
    : null;
  const region = el("section", { className: "delivery-readiness", attrs: { "aria-label": "投递准备" } });
  const synthetic = plan?.runtimeExecution === "synthetic";
  region.append(el("div", { className: "delivery-readiness-heading" }, [
    el("div", {}, [el("strong", { text: synthetic ? "UAT 合成投递" : "投递准备（不可外发）" }),
      el("p", { text: synthetic ? "只运行无网络合成服务商；地址固定为 .invalid，Microsoft 与真实外发仍关闭。" : "固定已批准内容和安全收件人；授权前不会建立发送尝试。" })]),
    el("span", { className: "delivery-lock", text: synthetic ? "SYNTHETIC ONLY" : "RUNTIME DISABLED" }),
  ]));
  if (!plan) {
    region.append(el("div", { className: "delivery-empty" }, [
      el("strong", { text: "尚未建立投递计划" }),
      el("p", { text: "计划只固定精确修订，并把虚构联系人映射为 .invalid DEV 安全别名；不产生发送资格。" }),
    ]));
    if (canManage) region.append(deliveryReadinessForm("plan", latest.id,
      "建立投递计划（不会发送）", "说明为何要为这份已批准修订建立 DEV 投递计划。"));
    return region;
  }
  region.append(el("dl", { className: "delivery-readiness-facts" }, [
    evidence("计划状态", statusText(plan.status)),
    evidence("收件人", `${plan.recipient.displayName ?? "DEV 联系人"} · ${plan.recipient.address ?? "已隐藏"}`),
    evidence("运行状态", synthetic ? "UAT 合成运行" : "关闭"),
    evidence("服务商", plan.providerConfigured ? "合成（无网络）" : "未配置"),
    evidence("故障场景", plan.scenario ?? "未授权"),
    evidence("发送尝试", String(plan.attemptCount)),
    evidence("外部调用", String(plan.externalCallCount)),
  ]));
  if (plan.lastErrorCode) region.append(el("p", { className: "delivery-audit-line", text: `最近结果：${plan.lastErrorCode}` }));
  if (plan.attempts?.length) {
    region.append(el("div", { className: "delivery-evaluation" }, [
      el("strong", { text: "发送尝试" }),
      el("div", {}, plan.attempts.map((attempt) => el("p", { text:
        `#${attempt.attemptNumber} · ${statusText(attempt.status)} · ${attempt.errorCode ?? attempt.providerMessageId?.slice(0, 28) ?? "无错误"} · 外部调用 ${attempt.externalCallCount}` }))),
    ]));
  }
  if (plan.receipts?.length) {
    region.append(el("div", { className: "delivery-evaluation" }, [
      el("strong", { text: "回执（摘要证据）" }),
      el("div", {}, plan.receipts.map((receipt) => el("p", { text:
        `${statusText(receipt.receiptType)} · ${formatDateTime(receipt.receivedAt)} · SHA-256 ${receipt.payloadHash.slice(0, 12)}…` }))),
    ]));
  }
  region.append(el("p", { className: "delivery-audit-line", text: `${plan.createdByName ?? "系统"} · ${formatDateTime(plan.createdAt)} · 内容 ${plan.contentHash.slice(0, 12)}…` }));
  if (evaluation) {
    const result = evaluation.result ?? {};
    region.append(el("div", { className: "delivery-evaluation" }, [
      el("div", {}, [el("strong", { text: "发送合同演练通过" }), statusLabel(evaluation.status)]),
      el("p", { text: "数据库唯一发送键、租约要求、可恢复失败与回执幂等已通过静态合同检查。" }),
      el("dl", { className: "delivery-evaluation-facts" }, [
        evidence("合同版本", evaluation.contractVersion),
        evidence("发送键", result.sendKeyUnique === true ? "唯一" : "待确认"),
        evidence("延迟 Worker", result.lateWorkerCannotCommit === true ? "不可提交" : "待确认"),
        evidence("回执内容", result.receiptPayload === "sha256_digest_only" ? "仅 SHA-256 摘要" : "待确认"),
        evidence("尝试 / 回执", `${result.attemptRows ?? 0} / ${result.receiptRows ?? 0}`),
        evidence("外部调用", String(evaluation.externalCallCount)),
      ]),
      el("small", { text: `${evaluation.runByName ?? "系统"} · ${formatDateTime(evaluation.createdAt)} · ${evaluation.definitionHash.slice(0, 12)}…` }),
    ]));
  } else if (canManage) {
    region.append(deliveryReadinessForm("evaluate", plan.id,
      "运行发送合同演练", "说明为何要验证发送锁、失败恢复和回执幂等设计。"));
  }
  if (evaluation && canManage && plan.status === "planned") {
    region.append(deliveryAuthorizationForm(plan.id));
  }
  if (canManage && plan.status === "outcome_unknown") {
    region.append(deliveryReconciliationForm(plan.id));
  }
  return region;
}

function deliveryAuthorizationForm(id) {
  const form = el("form", { className: "delivery-readiness-form", attrs: {
    "data-delivery-authorization": id, "data-idempotency-key": crypto.randomUUID(),
  } });
  const scenario = el("select", { attrs: { name: "scenario", required: "", "aria-label": "合成故障场景" } }, [
    ["success", "成功并送达"], ["rate_limited_once", "首次 429 后重试"],
    ["server_error_once", "首次 5xx 后重试"], ["timeout_unknown", "超时 / 结果未知"],
    ["crash_after_claim", "租约后进程中断"], ["bounced", "接受后退信"],
    ["receipt_replay", "回执重放"],
  ].map(([value, text]) => el("option", { text, attrs: { value } })));
  form.append(el("strong", { text: "主管授权 UAT 合成投递" }), scenario,
    el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "",
      placeholder: "说明这次纯虚构投递要验证的结果；不会连接真实邮箱。" } }),
    el("button", { className: "button button-primary-inline", text: "授权合成投递", attrs: { type: "submit" } }));
  return form;
}

function deliveryReconciliationForm(id) {
  const form = el("form", { className: "delivery-readiness-form", attrs: {
    "data-delivery-reconciliation": id, "data-idempotency-key": crypto.randomUUID(),
  } });
  const action = el("select", { attrs: { name: "action", required: "", "aria-label": "未知结果处理" } }, [
    ["remain_unknown", "证据不足：保持未知并人工处理"],
    ["proved_not_sent_retry", "已有未发送证据：允许重试"],
    ["confirmed_sent", "已有发送证据：确认已接受"],
  ].map(([value, text]) => el("option", { text, attrs: { value } })));
  form.append(el("strong", { text: "结果未知：禁止自动重发" }), action,
    el("input", { attrs: { name: "providerMessageId", placeholder: "确认已发送时填写 synthetic:… 证据编号" } }),
    el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "",
      placeholder: "记录核对证据与处理理由；可能重复发送必须另行明确授权。" } }),
    el("button", { className: "button button-secondary", text: "记录核对结论", attrs: { type: "submit" } }));
  return form;
}

function deliveryReadinessForm(kind, id, buttonText, placeholder) {
  const form = el("form", { className: "delivery-readiness-form", attrs: {
    [kind === "plan" ? "data-delivery-plan" : "data-delivery-evaluation"]: id,
    "data-idempotency-key": crypto.randomUUID(),
  } });
  form.append(el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "", placeholder } }),
    el("button", { className: "button button-secondary", text: buttonText, attrs: { type: "submit" } }));
  return form;
}

function missingRequestWorkflow(item, latest) {
  const region = el("div", { className: "request-review-workflow" });
  if (["draft", "changes_requested", "rejected"].includes(latest.status)) {
    region.append(missingRequestEditor(item, latest));
    if (latest.status === "draft" && latest.recipient.resolutionStatus === "ready") {
      region.append(missingRequestTransitionForm(latest, [
        ["submit_review", "送交独立复核", "button-primary-inline"],
      ], "说明联系人、主题和正文已核对，可以冻结内容并送交另一位主管。"));
    }
  } else if (latest.status === "in_review") {
    const operatorId = state.overview?.operator?.id;
    const independent = operatorId !== latest.createdByActorId && operatorId !== latest.submittedByActorId;
    if (independent) {
      region.append(missingRequestTransitionForm(latest, [
        ["approve", "批准内部草稿", "button-primary-inline"],
        ["return_to_draft", "退回修订", "button-secondary"],
        ["reject", "拒绝本次草稿", "button-quiet"],
      ], "记录独立复核依据。批准后仍然不会发送。"));
    } else {
      region.append(el("div", { className: "request-review-waiting" }, [
        el("strong", { text: "等待另一位主管复核" }),
        el("p", { text: "提交者和修订者不能批准自己的内容；外部发送仍保持关闭。" }),
      ]));
    }
  } else if (latest.status === "approved") {
    region.append(el("div", { className: "request-review-approved" }, [
      el("strong", { text: "内部草稿已批准" }),
      el("p", { text: `${latest.reviewedByName ?? "主管"} · ${latest.reviewedAt ? formatDateTime(latest.reviewedAt) : "时间待记录"}。批准不等于发送，delivery 仍为 disabled。` }),
    ]));
  }
  return region;
}

function missingRequestEditor(item, latest) {
  const form = el("form", { className: "request-revision-form", attrs: {
    "data-missing-request-save": item.id, "data-idempotency-key": crypto.randomUUID(),
  } });
  const recipientId = `missing-request-recipient-${item.id}`;
  const subjectId = `missing-request-subject-${item.id}`;
  const bodyId = `missing-request-body-${item.id}`;
  const reasonId = `missing-request-change-reason-${item.id}`;
  const select = el("select", { attrs: { id: recipientId, name: "recipientActorId", required: "" } });
  for (const candidate of item.recipientPolicy.candidates) {
    const option = el("option", { text: `${candidate.displayName} · ${candidate.email}`, attrs: { value: candidate.actorId } });
    if (candidate.actorId === latest.recipient.actorId) option.selected = true;
    select.append(option);
  }
  if (!item.recipientPolicy.candidates.length) {
    select.append(el("option", { text: "没有可用的受治理联系人", attrs: { value: "" } }));
    select.disabled = true;
  }
  form.append(el("div", { className: "request-editor-heading" }, [
    el("strong", { text: latest.status === "draft" ? "建立新修订" : "按复核意见建立新修订" }),
    el("p", { text: "保存会追加不可变修订，不覆盖历史内容。" }),
  ]));
  form.append(el("div", { className: "request-editor-field" }, [
    el("label", { text: "受治理收件人", attrs: { for: recipientId } }), select,
    el("small", { text: "只能选择当前工作对象的有效收件人名单。" }),
  ]));
  form.append(el("div", { className: "request-editor-field request-editor-wide" }, [
    el("label", { text: "主题", attrs: { for: subjectId } }),
    el("input", { attrs: { id: subjectId, name: "subjectLine", required: "", maxlength: "300", value: latest.subjectLine } }),
  ]));
  form.append(el("div", { className: "request-editor-field request-editor-wide" }, [
    el("label", { text: "正文", attrs: { for: bodyId } }),
    el("textarea", { text: latest.bodyText, attrs: { id: bodyId, name: "bodyText", required: "", minlength: "20", maxlength: "10000", rows: "8" } }),
  ]));
  form.append(el("div", { className: "request-editor-field request-editor-wide" }, [
    el("label", { text: "修订原因", attrs: { for: reasonId } }),
    el("textarea", { attrs: { id: reasonId, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明修改了什么，以及依据。" } }),
  ]));
  form.append(el("div", { className: "request-review-actions request-editor-wide" }, [
    el("button", { className: "button button-secondary", text: "保存为新修订", attrs: {
      type: "submit", ...(item.recipientPolicy.candidates.length ? {} : { disabled: "" }),
    } }),
    el("span", { text: "不会发送，也不会创建 Notification" }),
  ]));
  return form;
}

function missingRequestTransitionForm(latest, actions, placeholder) {
  const form = el("form", { className: "request-transition-form", attrs: {
    "data-missing-request-transition": latest.id, "data-idempotency-key": crypto.randomUUID(),
  } });
  const reasonId = `missing-request-review-reason-${latest.id}`;
  form.append(el("label", { text: "复核记录", attrs: { for: reasonId } }));
  form.append(el("textarea", { attrs: { id: reasonId, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder } }));
  form.append(el("div", { className: "request-review-actions" }, actions.map(([value, label, className]) =>
    el("button", { className: `button ${className}`, text: label, attrs: { type: "submit", name: "action", value } }))));
  return form;
}

function missingRequestHistory(item) {
  const details = el("details", { className: "request-review-history" });
  details.append(el("summary", { text: `修订与决定记录（${item.revisions.length} 个修订 · ${item.reviewDecisions.length} 个决定）` }));
  const list = el("div", { className: "request-history-list" });
  for (const revision of item.revisions) {
    list.append(el("article", { className: "request-history-row" }, [
      el("div", {}, [el("strong", { text: `r${revision.revision} · ${statusText(revision.status)}` }), el("span", { text: `${revision.createdByName ?? "系统"} · ${formatDateTime(revision.createdAt)}` })]),
      el("p", { text: revision.changeReason }),
      el("code", { text: revision.contentHash.slice(0, 16) }),
    ]));
  }
  for (const decision of item.reviewDecisions) {
    list.append(el("article", { className: "request-history-row is-decision" }, [
      el("div", {}, [el("strong", { text: missingRequestActionText(decision.action) }), el("span", { text: `${decision.actorName} · ${formatDateTime(decision.decidedAt)}` })]),
      el("p", { text: decision.reason }),
      el("code", { text: decision.contentHash.slice(0, 16) }),
    ]));
  }
  details.append(list.children.length ? list : emptyState("还没有审阅记录", "首次修订或提交后会出现在这里。"));
  return details;
}

function missingRequestActionText(action) {
  return ({ submitted: "已送交独立复核", returned: "已退回修订", approved: "已批准内部草稿", rejected: "已拒绝本次草稿" })[action] ?? action;
}

function requirementDetail(item) {
  const accepted = Math.min(item.acceptedCount, item.minimumCount);
  return el("article", { className: "requirement-detail" }, [
    el("div", { className: "requirement-name" }, [
      el("div", { className: "row-title" }, [el("strong", { text: item.displayName }), el("span", { text: item.documentTypeCode })]),
      statusLabel(item.status),
    ]),
    el("div", { className: "requirement-counts" }, [
      el("span", { text: `最低 ${item.minimumCount}` }),
      ...(item.maximumCount === null ? [] : [el("span", { text: `最高 ${item.maximumCount}` })]),
      el("span", { text: `唯一已接受 ${item.acceptedCount}` }),
      ...(item.missingCount ? [el("span", { className: "is-missing", text: `缺少 ${item.missingCount}` })] : []),
      ...(item.reviewCount ? [el("span", { className: "is-review", text: `待复核 ${item.reviewCount}` })] : []),
      ...(item.duplicateCount ? [el("span", { className: "is-review", text: `重复 ${item.duplicateCount}` })] : []),
      ...(item.excessCount ? [el("span", { className: "is-review", text: `超量 ${item.excessCount}` })] : []),
    ]),
    el("div", { className: "requirement-meter", attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(item.minimumCount), "aria-valuenow": String(accepted) } }, [
      el("span", { attrs: { style: `width:${item.minimumCount ? Math.round(accepted / item.minimumCount * 100) : 100}%` } }),
    ]),
  ]);
}

function caseDocument(item) {
  return el("article", { className: "case-document", attrs: { "data-document-id": item.id } }, [
    el("div", { className: "document-heading" }, [
      el("div", { className: "row-title" }, [el("strong", { text: item.filename }), el("span", { text: `${formatBytes(item.sizeBytes)} · ${item.detectedMimeType ?? item.declaredMimeType ?? "类型未知"}` })]),
      item.previewAvailable ? previewButton(item.id) : el("span", { className: "preview-unavailable", text: "原件尚未保存" }),
    ]),
    el("dl", { className: "document-evidence" }, [
      evidence("分类", item.documentTypeName ?? "未分类"),
      evidence("当前状态", statusText(item.status)),
      evidence("AI 置信度", item.confidence === null ? "无" : `${Math.round(item.confidence * 100)}%`),
      evidence("文件关系", relationText(item.relation)),
      evidence("资料清单匹配", requirementMatchText(item.requirementMatch)),
      evidence("最近尝试", attemptText(item.latestAttempt)),
      evidence("重试 / 错误", activeErrorText(item.activeError)),
    ]),
    ...(item.reviewReason ? [el("p", { className: "document-reason", text: `判断依据：${reasonText(item.reviewReason)}` })] : []),
  ]);
}

function requirementMatchText(match) {
  if (!match) return "尚未生成完整性快照";
  if (match.status === "excluded") return "已从当前 Case 排除，不计入资料清单";
  if (match.status === "review_required") return `${match.requirementCode ?? "未归属"} · 待人工确认`;
  if (match.status === "duplicate") return `${match.requirementCode ?? "未归属"} · 同内容重复，不计数`;
  if (match.status === "unmatched") return "当前 Case 清单不要求此类资料";
  if (match.status === "processing") return "资料尚未进入终态";
  if (match.isExcess) return `${match.requirementCode} · 超出最高数，不计数`;
  return `${match.requirementCode} · ${match.countsTowardMinimum ? "计入最低数量" : "已匹配"}`;
}

function relationText(relation) {
  if (relation.kind === "same_content") return `同内容文件 ${relation.position}/${relation.total}`;
  if (relation.kind === "same_filename") return `同名版本 ${relation.position}/${relation.total}`;
  return "唯一文件";
}

function attemptText(attempt) {
  if (!attempt) return "尚未分类";
  const error = attempt.errorCode ? ` · ${attempt.errorCode}` : "";
  return `第 ${attempt.attemptNumber} 次 · ${statusText(attempt.status)}${error}`;
}

function activeErrorText(error) {
  if (!error) return "没有开放错误";
  const retry = error.nextRetryAt ? ` · 下次 ${formatDateTime(error.nextRetryAt)}` : "";
  return `${error.errorCode} · ${statusText(error.status)}${retry}`;
}

function activityRow(item) {
  return el("article", { className: "activity-row" }, [
    el("div", { className: "row-title" }, [el("strong", { text: eventText(item.eventType) }), el("span", { text: `${item.aggregateType} · ${shortId(item.aggregateId)}` })]),
    el("span", { text: formatDateTime(item.occurredAt) }),
  ]);
}

function handleCaseDetailClick(event) {
  const refresh = event.target.closest("[data-refresh-case]");
  if (refresh) return openCase(refresh.dataset.refreshCase);
  if (event.target.closest("[data-preview-document]")) return handleDocumentClick(event);
  if (event.target.closest("[data-issue-action]") || event.target.closest("[data-issue-cancel]")) return handleIssueClick(event);
  if (event.target.closest("[data-batch-open]") || event.target.closest("[data-batch-cancel]")) return handleBatchClick(event);
}

function handleCaseDetailSubmit(event) {
  if (event.target.closest("[data-case-upload]")) return handleCaseUploadSubmit(event);
  if (event.target.closest("[data-case-complete]")) return handleCaseCompletionSubmit(event);
  if (event.target.closest("[data-missing-request-save], [data-missing-request-transition], [data-delivery-plan], [data-delivery-evaluation], [data-delivery-authorization], [data-delivery-reconciliation]")) {
    return handleMissingRequestSubmit(event);
  }
  if (event.target.closest("[data-reminder-decision]")) return handleReminderDecisionSubmit(event);
  if (event.target.closest("[data-issue-form]")) return handleIssueSubmit(event);
  if (event.target.closest("[data-batch-form]")) return handleBatchSubmit(event);
}

async function handleReminderDecisionSubmit(event) {
  const form = event.target.closest("[data-reminder-decision]");
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity() || !state.overview?.csrfToken || !state.caseDetail?.case.id) return;
  const action = event.submitter?.value;
  const reason = String(new FormData(form).get("reason") ?? "");
  const controls = form.querySelectorAll("button,textarea");
  controls.forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(`/v1/ops/reminders/${encodeURIComponent(form.dataset.reminderDecision)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({ action, reason, idempotencyKey: form.dataset.idempotencyKey }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(({
      manager_required: "只有主管或管理员可以决定提醒草稿。",
      reminder_not_found: "提醒不存在或不属于当前组织。",
      reminder_not_pending: "提醒状态已经变化，请刷新后查看。",
      reminder_safety_boundary_invalid: "提醒的 .invalid 或外发关闭边界不完整，已拒绝批准。",
      idempotency_key_reused: "操作编号已用于不同内容，请刷新后重试。",
    })[result.error] ?? ({
      manager_required: "只有主管或管理员可以决定提醒草稿。",
      reminder_not_found: "提醒不存在或不属于当前组织。",
      reminder_not_pending: "提醒状态已经变化，请刷新后查看。",
      reminder_safety_boundary_invalid: "提醒的安全边界不完整，已拒绝批准。",
      idempotency_key_reused: "操作编号已用于不同内容，请刷新后重试。",
    })[result.reason] ?? "提醒决定没有保存。");
    const caseId = state.caseDetail.case.id;
    await openCase(caseId);
    showNotice(result.outcome === "duplicate" ? "这项提醒决定此前已记录，没有重复写入。"
      : action === "approve" ? "提醒草稿已批准；外部发送仍为 0。" : "提醒草稿已拒绝并保留审计记录。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "提醒决定没有保存。", true);
    controls.forEach((control) => { control.disabled = false; });
  }
}

async function handleCaseUploadSubmit(event) {
  const form = event.target.closest("[data-case-upload]");
  if (!form || state.uploadSubmitting) return;
  event.preventDefault();
  if (!form.reportValidity() || !state.overview?.csrfToken) return;
  const files = [...form.elements.documents.files];
  if (!files.length) return;
  if (files.some((file) => file.size > 20 * 1024 * 1024)) return showNotice("单个文件不能超过 20MB。", true);
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
  if (files.some((file) => !allowed.has(file.type))) return showNotice("只支持 PDF、JPG 和 PNG。", true);
  const progress = form.querySelector("[data-upload-progress]");
  state.uploadSubmitting = true;
  form.querySelectorAll("button,input").forEach((control) => { control.disabled = true; });
  let completed = 0;
  try {
    for (const [index, file] of files.entries()) {
      progress.textContent = `正在保存 ${index + 1}/${files.length}：${file.name}`;
      const response = await fetch(`/v1/ops/cases/${encodeURIComponent(form.dataset.caseUpload)}/documents`, {
        method: "POST",
        headers: { "content-type": file.type, "x-dop-filename": encodeURIComponent(file.name), "x-dop-csrf": state.overview.csrfToken },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(uploadError(result));
      completed += 1;
      progress.textContent = result.outcome === "duplicate"
        ? `${file.name} 已存在，本次没有重复计入。`
        : `${file.name} 已私有保存，正在等待 AI 分类。`;
    }
    await loadOverview(false);
    await openCase(form.dataset.caseUpload);
    showNotice(`已处理 ${completed} 个文件；原件保存完成，AI 分类将在后台继续。`, false);
  } catch (error) {
    progress.textContent = `已完成 ${completed}/${files.length}；其余文件未继续上传。`;
    showNotice(error instanceof Error ? error.message : "资料没有上传。", true);
    form.querySelectorAll("button,input").forEach((control) => { control.disabled = false; });
  } finally { state.uploadSubmitting = false; }
}

function uploadError(result) {
  return ({
    invalid_upload_metadata: "文件名称或类型无效。",
    document_too_large: "文件超过 20MB 上限。",
    empty_document: "文件内容为空。",
    file_signature_mismatch: "文件内容与扩展名或 MIME 类型不一致。",
    document_storage_unavailable: "私有原件存储暂时不可用，请稍后重试同一文件。",
    document_upload_not_configured: "DEV 上传通道尚未完成配置。",
  })[result.error] ?? ({ case_closed: "这个 Case 已关闭，不能继续上传。", case_not_found: "Case 不存在或不属于当前组织。" })[result.reason]
    ?? "资料没有上传；系统没有把它计入 Case。";
}

async function handleCaseCompletionSubmit(event) {
  const form = event.target.closest("[data-case-complete]");
  if (!form) return;
  event.preventDefault();
  if (state.completionSubmitting) return;
  if (!form.reportValidity() || !state.overview?.csrfToken) return;
  state.completionSubmitting = true;
  form.querySelectorAll("button,textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(`/v1/ops/cases/${encodeURIComponent(form.dataset.caseComplete)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({ reason: String(form.elements.reason?.value ?? ""), assignedActorId: null, idempotencyKey: crypto.randomUUID() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(completionError(result));
    await loadOverview(false);
    await openCase(form.dataset.caseComplete);
    showNotice(result.outcome === "duplicate" ? "这个 Case 已经完成，没有重复创建任务。" : "Case 已完成，并且只创建了一项下一任务。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Case 没有完成。", true);
    form.querySelectorAll("button,textarea").forEach((control) => { control.disabled = false; });
  } finally { state.completionSubmitting = false; }
}

function completionError(result) {
  const messages = {
    session_required: "会话已过期，请重新登录后再完成 Case。",
    manager_required: "只有主管或管理员可以完成 Case。",
    request_verification_failed: "请求安全校验失败，请刷新页面后重试。",
    invalid_identifier: "Case 标识无效，请返回列表重新打开。",
    case_completion_not_configured: "结案通道尚未完成配置。",
    content_type_must_be_application_json: "结案请求格式无效，请刷新页面后重试。",
    invalid_json: "结案请求内容无效，请刷新页面后重试。",
    invalid_completion_request: "完成依据或操作编号无效，请刷新页面后重试。",
    invalid_completion_reason: "完成依据必须为 12–1000 个字符。",
    invalid_completion_idempotency_key: "结案操作编号无效，请刷新页面后重试。",
    invalid_completion_assignee: "下一任务负责人标识无效，请重新选择。",
    completeness_not_complete: "最新完整性结论尚未通过，请刷新并处理缺件或复核。",
    open_issues_remaining: "仍有开放问题，请先解决或关闭。",
    documents_still_processing: "仍有资料在处理或等待人工判断。",
    assignee_invalid: "下一任务负责人无效或已停用。",
    case_not_ready: "当前 Case 状态不允许完成。",
    case_not_found: "Case 不存在或不属于当前组织。",
    case_completion_failed: "结案事务没有完成；系统已记录安全错误代码，请稍后重试。",
  };
  return messages[result.error] ?? messages[result.reason] ?? "Case 没有完成；数据库未写入部分结果。";
}

async function handleMissingRequestSubmit(event) {
  const form = event.target.closest("[data-missing-request-save], [data-missing-request-transition], [data-delivery-plan], [data-delivery-evaluation], [data-delivery-authorization], [data-delivery-reconciliation]");
  if (!form || state.missingRequestSubmitting) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (!state.overview?.csrfToken || !state.caseDetail?.case.id) {
    return showNotice("会话安全信息缺失，请刷新后重试。", true);
  }
  const data = new FormData(form);
  const isSave = Boolean(form.dataset.missingRequestSave);
  const isPlan = Boolean(form.dataset.deliveryPlan);
  const isEvaluation = Boolean(form.dataset.deliveryEvaluation);
  const isAuthorization = Boolean(form.dataset.deliveryAuthorization);
  const isReconciliation = Boolean(form.dataset.deliveryReconciliation);
  const action = isSave ? "save" : isPlan ? "plan_delivery" : isEvaluation ? "evaluate_delivery"
    : isAuthorization ? "authorize_synthetic" : isReconciliation ? "reconcile_unknown" : event.submitter?.value;
  const path = isSave ? `/v1/ops/missing-request-drafts/${encodeURIComponent(form.dataset.missingRequestSave)}/revisions`
    : isPlan ? `/v1/ops/missing-request-revisions/${encodeURIComponent(form.dataset.deliveryPlan)}/delivery-plans`
    : isEvaluation ? `/v1/ops/delivery-jobs/${encodeURIComponent(form.dataset.deliveryEvaluation)}/evaluations`
    : isAuthorization ? `/v1/ops/delivery-jobs/${encodeURIComponent(form.dataset.deliveryAuthorization)}/synthetic-authorizations`
    : isReconciliation ? `/v1/ops/delivery-jobs/${encodeURIComponent(form.dataset.deliveryReconciliation)}/unknown-reconciliations`
    : `/v1/ops/missing-request-revisions/${encodeURIComponent(form.dataset.missingRequestTransition)}/transitions`;
  const body = isSave ? {
    recipientActorId: String(data.get("recipientActorId") ?? ""),
    subjectLine: String(data.get("subjectLine") ?? ""),
    bodyText: String(data.get("bodyText") ?? ""),
    reason: String(data.get("reason") ?? ""),
    idempotencyKey: form.dataset.idempotencyKey,
  } : isAuthorization ? {
    scenario: String(data.get("scenario") ?? ""), reason: String(data.get("reason") ?? ""),
    idempotencyKey: form.dataset.idempotencyKey,
  } : isReconciliation ? {
    action: String(data.get("action") ?? ""), providerMessageId: String(data.get("providerMessageId") ?? ""),
    reason: String(data.get("reason") ?? ""), idempotencyKey: form.dataset.idempotencyKey,
  } : isPlan || isEvaluation ? {
    reason: String(data.get("reason") ?? ""), idempotencyKey: form.dataset.idempotencyKey,
  } : {
    action,
    reason: String(data.get("reason") ?? ""),
    idempotencyKey: form.dataset.idempotencyKey,
  };
  const controls = form.querySelectorAll("button, input, select, textarea");
  controls.forEach((control) => { control.disabled = true; });
  state.missingRequestSubmitting = true;
  hideNotice();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (!response.ok) throw new Error(missingRequestError(result));
    const caseId = state.caseDetail.case.id;
    await openCase(caseId);
    showNotice(missingRequestSuccess(action, result.outcome === "duplicate"), false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "补件草稿审阅操作没有保存。", true);
    controls.forEach((control) => { control.disabled = false; });
  } finally {
    state.missingRequestSubmitting = false;
  }
}

function missingRequestError(result) {
  return ({
    invalid_request: "字段不完整或审阅说明不足。",
    request_draft_not_found: "补件草稿不存在或不属于当前组织。",
    request_draft_not_current: "完整性证据已经变化，请刷新后处理最新草稿。",
    recipient_not_allowlisted: "所选联系人不在当前受治理收件人名单中。",
    recipient_not_available: "联系人已停用、缺少邮箱或治理状态已变化。",
    approved_revision_required: "只能为已批准的精确修订建立投递计划。",
    source_delivery_boundary_invalid: "已批准修订的外发安全边界不符合 DEV 规则。",
    recipient_snapshot_drift: "收件人邮箱与批准时快照不一致，请重新修订与批准。",
    dev_recipient_not_allowlisted: "联系人没有 synthetic 标记或未映射为 DEV .invalid 安全别名。",
    delivery_job_not_found: "投递计划不存在或不属于当前组织。",
    delivery_boundary_invalid: "投递计划已不符合运行关闭的安全边界。",
    passing_contract_evaluation_required: "必须先通过发送合同演练。",
    synthetic_runtime_disabled: "UAT 合成运行开关已关闭或安全边界发生变化。",
    unsafe_recipient: "收件地址不是 .invalid 合成安全地址。",
    delivery_not_authorizable: "该计划已经授权、处理或不再允许执行。",
    outcome_unknown_required: "只有结果未知的投递才能执行这项核对。",
    provider_proof_required: "确认已发送必须提供合成服务商证据编号。",
    revision_not_editable: "当前修订正在复核或已经批准，不能继续覆盖。",
    revision_not_current: "已有更新修订，请刷新。",
    transition_not_allowed: "当前状态不允许这项审阅操作。",
    independent_reviewer_required: "修订者或提交者不能批准自己的草稿，请由另一位主管复核。",
    idempotency_key_reused: "这次操作编号已用于不同内容，请刷新后重试。",
  })[result.reason] ?? "补件草稿审阅操作没有保存；没有发生部分写入。";
}

function missingRequestSuccess(action, duplicate) {
  if (duplicate) return "这项审阅操作此前已成功记录，本次没有重复写入。";
  return ({
    save: "新修订已追加；历史内容仍完整保留，外部发送保持关闭。",
    submit_review: "内容已冻结并送交独立复核；尚未发送。",
    return_to_draft: "已退回修订并记录原因；尚未发送。",
    approve: "内部草稿已批准；delivery 仍为 disabled，不会发送。",
    reject: "本次草稿已拒绝并保留审计记录。",
    plan_delivery: "DEV 投递计划已建立；运行关闭、服务商未配置、发送尝试和外部调用均为 0。",
    evaluate_delivery: "发送合同演练已通过；没有建立发送尝试、回执或外部调用。",
    authorize_synthetic: "UAT 合成投递已授权；Automation 将在 .invalid 地址上执行，真实外发保持关闭。",
    reconcile_unknown: "结果未知的人工核对结论已保存；系统没有自动重发。",
  })[action] ?? "补件草稿审阅操作已记录。";
}

function handleIssueSelection(event) {
  const input = event.target.closest("[data-issue-select]");
  if (!input) return;
  if (input.checked) state.selectedIssueIds.add(input.dataset.issueSelect);
  else state.selectedIssueIds.delete(input.dataset.issueSelect);
  input.closest(".issue-detail")?.classList.toggle("is-selected", input.checked);
  const target = state.view === "case-detail" ? $("#case-issue-batch-actions") : $("#issue-batch-actions");
  if (target) renderBatchToolbar(target);
}

function renderBatchToolbar(target) {
  if (!target) return;
  const count = state.selectedIssueIds.size;
  if (!count) return replaceChildren(target, []);
  if (state.batchFormOpen) {
    const noteId = `batch-note-${state.view}`;
    return replaceChildren(target, [el("form", { className: "batch-issue-form", attrs: { "data-batch-form": "", "data-idempotency-key": crypto.randomUUID() } }, [
      el("div", {}, [el("strong", { text: `确认分派 ${count} 个问题给我` }), el("p", { text: "系统会逐项校验并为每一项写入独立审计事件；已失效的项目不会阻断其他项目。" })]),
      el("label", { text: "批量分派说明", attrs: { for: noteId } }),
      el("textarea", { attrs: { id: noteId, name: "note", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "例如：今日由我统一核对这些纯虚构资料问题。" } }),
      el("div", { className: "review-form-buttons" }, [
        el("button", { className: "button button-primary-inline button-small", text: "确认分派", attrs: { type: "submit" } }),
        el("button", { className: "button button-quiet button-small", text: "取消", attrs: { type: "button", "data-batch-cancel": "" } }),
      ]),
    ])]);
  }
  replaceChildren(target, [el("div", { className: "batch-issue-toolbar" }, [
    el("span", { text: `已选 ${count} 项` }),
    el("button", { className: "button button-secondary button-small", text: "批量分派给我", attrs: { type: "button", "data-batch-open": "" } }),
  ])]);
}

function handleBatchClick(event) {
  if (event.target.closest("[data-batch-open]")) state.batchFormOpen = true;
  else if (event.target.closest("[data-batch-cancel]")) state.batchFormOpen = false;
  else return;
  const target = state.view === "case-detail" ? $("#case-issue-batch-actions") : $("#issue-batch-actions");
  renderBatchToolbar(target);
  if (state.batchFormOpen) target.querySelector("textarea")?.focus();
}

async function handleBatchSubmit(event) {
  const form = event.target.closest("[data-batch-form]");
  if (!form || state.issueSubmitting) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const issueIds = [...state.selectedIssueIds];
  if (!issueIds.length) return;
  state.issueSubmitting = true;
  form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch("/v1/ops/issues/batch-transitions", {
      method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({ action: "assign_to_me", issueIds, note: String(new FormData(form).get("note") ?? ""), idempotencyKey: form.dataset.idempotencyKey }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(issueTransitionError(result));
    const activeCaseId = state.caseDetail?.case.id;
    await loadOverview(false);
    if (activeCaseId) await openCase(activeCaseId);
    const failed = result.requestedCount - result.completedCount;
    showNotice(failed ? `已分派 ${result.completedCount} 项；${failed} 项因状态已变化而跳过。` : `已分派 ${result.completedCount} 项，并逐项写入审计事件。`, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "批量分派没有完成。", true);
    form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = false; });
  } finally { state.issueSubmitting = false; }
}

function renderRecentDocuments() {
  const target = $("#recent-documents-list");
  const items = state.overview.recentDocuments ?? [];
  replaceChildren(target, items.length ? items.map((item) => el("article", { className: "document-row" }, [
    el("div", { className: "row-title" }, [
      el("strong", { text: item.filename }),
      el("span", { text: `${item.subjectName} · ${formatDateTime(item.updatedAt)}` }),
    ]),
    el("span", { text: item.documentTypeName ?? "未分类" }),
    statusLabel(item.status),
    item.previewAvailable ? previewButton(item.id) : el("span", { className: "preview-unavailable", text: "原件尚未保存" }),
  ])) : [emptyState("还没有资料", "Canonical Intake 接收资料后会显示在这里。")]);
}

function handleDocumentClick(event) {
  const button = event.target.closest("[data-preview-document]");
  if (button) openPreview(button.dataset.previewDocument, button);
}

function renderReviewQueue() {
  const target = $("#review-queue");
  const items = state.overview.reviewQueue;
  if (!items.length) return replaceChildren(target, [emptyState("人工复核队列为空", "当规则要求人工确认，或 AI 发现质量与期间冲突时，资料会进入此队列。")]);
  replaceChildren(target, items.map((item) => el("article", { className: "review-detail", attrs: { "data-document-id": item.id } }, [
    el("div", { className: "review-detail-heading" }, [
      el("div", {}, [el("h3", { text: item.filename }), el("p", { text: `${item.subjectName} · ${period(item)} · 更新于 ${formatDateTime(item.updatedAt)}` })]),
      previewButton(item.id),
    ]),
    el("dl", { className: "evidence-list" }, [
      evidence("分类", item.documentTypeName ?? "未确定"),
      evidence("AI 置信度", item.confidence === null ? "无" : `${Math.round(item.confidence * 100)}%`),
      evidence("当前状态", statusText(item.status)),
      evidence("复核原因", reasonText(item.reviewReason)),
    ]),
    reviewActions(item),
  ])));
}

function renderDecisionHistory() {
  const target = $("#decision-history-list");
  const items = state.overview.recentReviewDecisions ?? [];
  replaceChildren(target, items.length ? items.map((item) => el("article", {
    className: "decision-row", attrs: { "data-document-id": item.documentId },
  }, [
    el("div", { className: "row-title" }, [
      el("strong", { text: item.filename }),
      el("span", { text: `${item.subjectName} · ${item.actorName} · ${formatDateTime(item.decidedAt)}` }),
    ]),
    el("div", { className: "decision-result" }, [statusLabel(item.documentStatus), el("span", { text: item.documentTypeName ?? "未分类" })]),
    ...(item.exclusionReason ? [el("p", { className: "decision-rationale", text: `排除类型：${exclusionReasonText(item.exclusionReason)}` })] : []),
    el("p", { className: "decision-rationale", text: item.rationale }),
    el("div", { className: "decision-actions" }, [
      previewButton(item.documentId),
      ...(["manager", "admin"].includes(state.overview.operator.actorType) && ["human_confirmed", "excluded"].includes(item.documentStatus)
        ? [actionButton("主管重新打开", "reopen", "button-secondary")] : []),
    ]),
    el("div", { className: "review-actions", attrs: { "data-review-actions": item.documentId } }),
  ])) : [emptyState("还没有人工决定", "第一条确认、改分类或补充要求会出现在这里。")]);
}

function previewButton(documentId) {
  return el("button", { className: "button button-quiet button-small", text: "安全查看原件", attrs: {
    type: "button", "data-preview-document": documentId,
  } });
}

function reviewActions(item) {
  const region = el("div", { className: "review-actions", attrs: { "data-review-actions": item.id } });
  if (item.status === "failed_recoverable") {
    region.append(el("p", { className: "review-action-note", text: "系统仍在重试。为避免与 Worker 竞争，人工操作暂时锁定。" }));
    return region;
  }
  const buttons = el("div", { className: "review-action-buttons" });
  if (item.documentTypeCode) buttons.append(actionButton("确认当前分类", "confirm", "button-primary-inline"));
  if (item.availableDocumentTypes?.length) buttons.append(actionButton("修改分类", "reclassify", "button-secondary"));
  buttons.append(actionButton("标记需补充", "request_information", "button-quiet"));
  if (["manager", "admin"].includes(state.overview.operator.actorType)) {
    buttons.append(actionButton("不属于当前客户 / 排除", "exclude", "button-danger"));
  }
  region.append(buttons);
  return region;
}

function actionButton(label, action, className) {
  return el("button", { className: `button ${className}`, text: label, attrs: { type: "button", "data-review-action": action } });
}

function handleReviewClick(event) {
  const previewNode = event.target.closest("[data-preview-document]");
  if (previewNode) {
    openPreview(previewNode.dataset.previewDocument, previewNode);
    return;
  }
  const actionButtonNode = event.target.closest("[data-review-action]");
  if (actionButtonNode) {
    const article = actionButtonNode.closest("[data-document-id]");
    const item = reviewItem(article?.dataset.documentId) ?? decisionItem(article?.dataset.documentId);
    if (article && item) openReviewForm(article, item, actionButtonNode.dataset.reviewAction);
    return;
  }
  const cancelButton = event.target.closest("[data-review-cancel]");
  if (cancelButton) {
    const article = cancelButton.closest("[data-document-id]");
    const item = reviewItem(article?.dataset.documentId) ?? decisionItem(article?.dataset.documentId);
    if (article && item) article.querySelector("[data-review-form]").replaceWith(reviewActions(item));
  }
}

function openReviewForm(article, item, action) {
  if (!["confirm", "reclassify", "request_information", "exclude", "reopen"].includes(action)) return;
  const region = article.querySelector("[data-review-actions]");
  const form = el("form", { className: "review-decision-form", attrs: {
    "data-review-form": action,
    "data-idempotency-key": crypto.randomUUID(),
  } });
  const copy = {
    confirm: ["确认当前分类", `将 ${item.documentTypeName ?? "当前分类"} 标记为人工确认，并解决该文件的开放问题。`, "确认并记录"],
    reclassify: ["修改分类", "只能选择当前 Case 配置中允许的资料类型。AI 原结果仍保留在审计记录中。", "保存新分类"],
    request_information: ["标记需补充", "该文件会继续留在复核队列，关联问题转为“等待客户”。此动作不会自动发送邮件。", "记录补充要求"],
    exclude: ["从当前 Case 排除此文件", "原件和 AI 结果会永久保留，但不再计入当前客户的资料清单。关联问题将被解决，操作会写入不可变审计记录。", "确认排除并记录"],
    reopen: ["主管重新打开", "原决定会永久保留；该资料将重新进入人工复核，并生成高优先级纠错问题。", "重新打开并记录"],
  }[action];
  form.append(el("div", { className: "review-form-heading" }, [el("strong", { text: copy[0] }), el("p", { text: copy[1] })]));
  if (action === "reclassify") {
    const selectId = `document-type-${item.id}`;
    const label = el("label", { text: "决定后的资料类型", attrs: { for: selectId } });
    const select = el("select", { attrs: { id: selectId, name: "documentTypeCode", required: "" } });
    for (const option of item.availableDocumentTypes) {
      const node = el("option", { text: option.displayName, attrs: { value: option.code } });
      if (option.code === item.documentTypeCode) node.selected = true;
      select.append(node);
    }
    form.append(el("div", { className: "review-field" }, [label, select]));
  }
  if (action === "exclude") {
    const reasonId = `exclusion-reason-${item.id}`;
    const select = el("select", { attrs: { id: reasonId, name: "exclusionReason", required: "" } });
    select.append(
      el("option", { text: "请选择排除类型", attrs: { value: "" } }),
      el("option", { text: "错客户 / 不属于当前主体", attrs: { value: "wrong_subject" } }),
      el("option", { text: "错期间 / 不属于当前申报期间", attrs: { value: "wrong_period" } }),
      el("option", { text: "无关或未知资料", attrs: { value: "irrelevant_or_unknown" } }),
    );
    form.append(el("div", { className: "review-field" }, [
      el("label", { text: "排除类型", attrs: { for: reasonId } }), select,
      el("span", { className: "field-help", text: "该类型会进入资料状态、决定记录和不可变事件。" }),
    ]));
  }
  const rationaleId = `rationale-${item.id}`;
  form.append(el("div", { className: "review-field" }, [
    el("label", { text: action === "request_information" ? "需要补充什么，以及原因" : action === "exclude" ? "排除原因" : "判断依据", attrs: { for: rationaleId } }),
    el("textarea", { attrs: { id: rationaleId, name: "rationale", required: "", minlength: "12", maxlength: "1000", rows: "3", placeholder: rationalePlaceholder(action) } }),
    el("span", { className: "field-help", text: "至少 12 个字符；将进入永久审计记录。" }),
  ]));
  form.append(el("div", { className: "review-form-buttons" }, [
    el("button", { className: `button ${action === "exclude" ? "button-danger" : "button-primary-inline"}`, text: copy[2], attrs: { type: "submit" } }),
    el("button", { className: "button button-quiet", text: "取消", attrs: { type: "button", "data-review-cancel": "" } }),
  ]));
  region.replaceWith(form);
  form.querySelector(action === "reclassify" ? "select" : "textarea").focus();
}

async function handleReviewSubmit(event) {
  const form = event.target.closest("[data-review-form]");
  if (!form) return;
  event.preventDefault();
  if (state.reviewSubmitting) return;
  if (!form.reportValidity()) return;
  const article = form.closest("[data-document-id]");
  const documentId = article?.dataset.documentId;
  if (!documentId || !state.overview?.csrfToken) return showNotice("会话安全信息缺失，请刷新后重试。", true);
  const data = new FormData(form);
  const action = form.dataset.reviewForm;
  const submitButton = form.querySelector("button[type='submit']");
  const originalLabel = submitButton.textContent;
  state.reviewSubmitting = true;
  form.querySelectorAll("button, select, textarea").forEach((control) => { control.disabled = true; });
  submitButton.textContent = "正在记录…";
  hideNotice();
  try {
    const response = await fetch(`/v1/ops/reviews/${encodeURIComponent(documentId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({
        action,
        rationale: String(data.get("rationale") ?? ""),
        idempotencyKey: form.dataset.idempotencyKey,
        ...(action === "reclassify" ? { documentTypeCode: String(data.get("documentTypeCode") ?? "") } : {}),
        ...(action === "exclude" ? { exclusionReason: String(data.get("exclusionReason") ?? "") } : {}),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (!response.ok) throw new Error(reviewError(result));
    await loadOverview(false);
    switchView("review");
    showNotice(actionSuccess(action, result.outcome === "duplicate"), false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "复核决定未保存，请重试。", true);
    form.querySelectorAll("button, select, textarea").forEach((control) => { control.disabled = false; });
    submitButton.textContent = originalLabel;
  } finally {
    state.reviewSubmitting = false;
  }
}

function reviewItem(documentId) { return state.overview?.reviewQueue.find((item) => item.id === documentId); }
function decisionItem(documentId) { return state.overview?.recentReviewDecisions?.find((item) => item.documentId === documentId); }
function rationalePlaceholder(action) {
  return action === "confirm" ? "例如：客户名称、期间和账户尾号与文件内容一致。"
    : action === "reclassify" ? "例如：标题和交易明细表明这是发票，而不是银行流水。"
    : action === "exclude" ? "例如：文件抬头为其他公司，不属于当前客户；保留原件但从本 Case 排除。"
    : action === "reopen" ? "例如：复查发现期间判断依据不足，需要重新核对原件。"
    : "例如：缺少完整期间页面，请客户重新提供 7 月完整文件。";
}
function reviewError(result) {
  return ({
    idempotency_key_reused: "这次操作编号已用于不同决定，请刷新后重试。",
    review_already_resolved: "该资料已被其他操作处理，请刷新队列。",
    current_type_missing: "当前没有可确认的分类，请使用“修改分类”。",
    system_retry_in_progress: "系统仍在重试该资料，请稍后再处理。",
    manager_required: "只有主管或管理员可以执行此操作。",
    exclusion_reason_required: "请选择错客户、错期间或无关/未知资料。",
    document_not_reopenable: "只有已人工确认或已排除的资料可以由主管重新打开。",
  })[result.reason ?? result.error] ?? "复核决定未保存。数据没有发生部分更新，请稍后重试。";
}
function exclusionReasonText(value) {
  return ({ wrong_subject: "错客户", wrong_period: "错期间", irrelevant_or_unknown: "无关或未知资料" })[value]
    ?? value.replaceAll("_", " ");
}
function actionSuccess(action, duplicate) {
  if (duplicate) return "该决定此前已成功记录，本次没有重复写入。";
  return action === "confirm" ? "已确认分类并写入审计记录。"
    : action === "reclassify" ? "新分类已保存，AI 原结果仍保留。"
    : action === "exclude" ? "文件已从当前 Case 安全排除；原件、AI 结果和审计记录均已保留。"
    : action === "reopen" ? "原决定已保留；资料已重新进入人工复核。"
    : "补充要求已记录；尚未向客户发送消息。";
}

async function openPreview(documentId, button) {
  if (!documentId || !state.overview?.csrfToken) return showNotice("会话安全信息缺失，请刷新后重试。", true);
  const previewWindow = window.open("about:blank", "_blank");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在签发…";
  try {
    const response = await fetch(`/v1/ops/documents/${encodeURIComponent(documentId)}/preview`, {
      method: "POST", headers: { "x-dop-csrf": state.overview.csrfToken },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(response.status === 409 ? "原件尚未完成私有保存。" : "暂时无法签发原件访问链接。");
    if (previewWindow) previewWindow.location.replace(result.url);
    else window.location.assign(result.url);
    showNotice("已签发 60 秒原件访问链接；链接不会永久保存。", false);
  } catch (error) {
    previewWindow?.close();
    showNotice(error instanceof Error ? error.message : "无法查看原件。", true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function handleIssueClick(event) {
  const cancel = event.target.closest("[data-issue-cancel]");
  if (cancel) {
    const article = cancel.closest("[data-issue-id]");
    const item = issueItem(article?.dataset.issueId);
    if (article && item) article.querySelector("[data-issue-form]")?.replaceWith(issueActions(item));
    return;
  }
  const button = event.target.closest("[data-issue-action]");
  if (!button) return;
  const article = button.closest("[data-issue-id]");
  const item = issueItem(article?.dataset.issueId);
  if (!article || !item) return;
  const region = article.querySelector("[data-issue-actions]");
  const action = button.dataset.issueAction;
  const form = el("form", { className: "issue-transition-form", attrs: {
    "data-issue-form": action, "data-idempotency-key": crypto.randomUUID(),
  } });
  const noteId = `issue-note-${item.id}`;
  form.append(el("label", { text: issueActionText(action), attrs: { for: noteId } }));
  form.append(el("textarea", { attrs: { id: noteId, name: "note", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "记录判断依据、责任边界或下一步。" } }));
  form.append(el("div", { className: "review-form-buttons" }, [
    el("button", { className: "button button-primary-inline button-small", text: "保存状态", attrs: { type: "submit" } }),
    el("button", { className: "button button-quiet button-small", text: "取消", attrs: { type: "button", "data-issue-cancel": "" } }),
  ]));
  region.replaceWith(form);
  form.querySelector("textarea").focus();
}

$("#issue-list").addEventListener("click", (event) => {
  const cancel = event.target.closest("[data-issue-cancel]");
  if (!cancel) return;
  const article = cancel.closest("[data-issue-id]");
  const item = issueItem(article?.dataset.issueId);
  if (article && item) article.querySelector("[data-issue-form]").replaceWith(issueActions(item));
});

async function handleIssueSubmit(event) {
  const form = event.target.closest("[data-issue-form]");
  if (!form || state.issueSubmitting) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const article = form.closest("[data-issue-id]");
  const issueId = article?.dataset.issueId;
  const note = String(new FormData(form).get("note") ?? "");
  state.issueSubmitting = true;
  form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(`/v1/ops/issues/${encodeURIComponent(issueId)}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({ action: form.dataset.issueForm, note, idempotencyKey: form.dataset.idempotencyKey }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(issueTransitionError(result));
    const activeCaseId = state.caseDetail?.case.id;
    await loadOverview(false);
    if (activeCaseId) await openCase(activeCaseId);
    showNotice(result.outcome === "duplicate" ? "该状态变更此前已记录。" : "问题状态已更新并写入审计事件。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "问题状态没有更新。", true);
    form.querySelectorAll("button, textarea").forEach((control) => { control.disabled = false; });
  } finally { state.issueSubmitting = false; }
}

function issueItem(issueId) {
  return state.caseDetail?.issues.find((item) => item.id === issueId)
    ?? state.overview?.issues.find((item) => item.id === issueId);
}

function issueActionText(action) {
  return ({ assign_to_me: "分配给我", wait_internal: "转为等待内部", wait_external: "转为等待客户",
    resolve: "标记已经解决", reopen: "主管重新打开", close: "主管关闭问题" })[action] ?? "更新问题";
}
function issueTransitionError(result) {
  return ({ transition_not_allowed: "当前状态不能执行这次流转，请刷新后重试。", manager_required: "只有主管或管理员可以重新打开或关闭问题。",
    idempotency_key_reused: "操作编号已用于不同状态变更，请刷新。" })[result.reason] ?? "问题状态没有更新。";
}

async function loadOnboarding() {
  if (state.overview?.operator?.actorType !== "admin") return;
  try {
    const response = await fetch("/v1/ops/onboarding");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (response.status === 403) throw new Error("只有管理员可以查看工作对象开户。");
    if (!response.ok) throw new Error("暂时无法读取版本化工作包。");
    state.onboarding = await response.json();
    $("#nav-onboarding-count").value = String(state.onboarding.recentOnboardings.length);
    renderOnboarding();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "工作对象开户加载失败。", true);
  }
}

function renderOnboarding() {
  const snapshot = state.onboarding;
  if (!snapshot) return;
  replaceChildren($("#onboarding-packages"), snapshot.packages.length
    ? snapshot.packages.map(onboardingPackage)
    : [emptyState("还没有可用工作包", "先发布一个通用工作包版本，再建立工作对象。")]);
  const packageSelect = $("#onboarding-package");
  const selectedPackage = packageSelect.value;
  replaceChildren(packageSelect, snapshot.packages.map((item) => {
    const option = el("option", { text: `${item.displayName} · v${item.version}`, attrs: { value: item.id } });
    if (item.id === selectedPackage) option.selected = true;
    return option;
  }));
  const contactSelect = $("#onboarding-contact");
  const selectedContact = contactSelect.value;
  replaceChildren(contactSelect, [el("option", { text: "暂不设置", attrs: { value: "" } }), ...snapshot.customerContacts.map((person) => {
    const option = el("option", { text: `${person.displayName}${person.email ? ` · ${person.email}` : ""}`, attrs: { value: person.id } });
    if (person.id === selectedContact) option.selected = true;
    return option;
  })]);
  replaceChildren($("#recent-onboardings"), snapshot.recentOnboardings.length
    ? snapshot.recentOnboardings.map(onboardingRow)
    : [emptyState("还没有开户记录", "从上方工作包建立的第一份纯虚构对象会显示在这里。")]);
}

function onboardingPackage(item) {
  const article = el("article", { className: "onboarding-package" });
  article.append(el("div", { className: "onboarding-package-heading" }, [
    el("div", {}, [el("span", { text: item.packageKey }), el("h3", { text: item.displayName })]),
    el("strong", { text: `v${item.version}` }),
  ]));
  article.append(el("p", { text: item.description }));
  article.append(el("dl", { className: "onboarding-package-meta" }, [
    evidence("工作流", item.workflowTemplateName),
    evidence("资料分类要求", `${item.requirements.length} 项`),
    evidence("适用包", item.industryPackage ?? "通用"),
  ]));
  article.append(el("button", { className: "text-button", text: "使用这个版本", attrs: { type: "button", "data-package-select": item.id } }));
  return article;
}

function onboardingRow(item) {
  return el("article", { className: "onboarding-row" }, [
    el("div", { className: "row-title" }, [el("strong", { text: item.subjectName }), el("span", { text: item.subjectKey })]),
    el("div", {}, [el("strong", { text: `${item.packageName} · v${item.packageVersion}` }), el("span", { text: `配置 ${statusText(item.configurationStatus)}` })]),
    el("div", {}, [el("strong", { text: item.createdByName }), el("span", { text: formatDateTime(item.createdAt) })]),
    statusLabel(item.configurationStatus),
  ]);
}

function handlePackageSelection(event) {
  const button = event.target.closest("[data-package-select]");
  if (!button) return;
  $("#onboarding-package").value = button.dataset.packageSelect;
  $("#onboarding-form-title").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#onboarding-key").focus({ preventScroll: true });
}

async function handleOnboardingSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.onboardingSubmitting || !form.reportValidity()) return;
  if (!state.overview?.csrfToken) return showNotice("会话安全信息缺失，请刷新后重试。", true);
  const data = new FormData(form);
  let attributes;
  try {
    attributes = JSON.parse(String(data.get("attributes") ?? "{}"));
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) throw new Error("invalid");
  } catch {
    return showNotice("对象属性必须是有效的 JSON 对象。", true);
  }
  state.onboardingSubmitting = true;
  form.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch("/v1/ops/onboarding/subjects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({
        packageVersionId: String(data.get("packageVersionId") ?? ""),
        subjectKey: String(data.get("subjectKey") ?? ""),
        displayName: String(data.get("displayName") ?? ""),
        subjectType: String(data.get("subjectType") ?? ""),
        primaryContactActorId: String(data.get("primaryContactActorId") ?? "") || null,
        attributes,
        reason: String(data.get("reason") ?? ""),
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(onboardingError(result));
    form.reset();
    await loadOnboarding();
    state.configurations = null;
    showNotice(result.outcome === "duplicate"
      ? "该开户操作此前已经成功完成，本次没有重复创建。"
      : "工作对象与配置草稿已创建；尚未发布、创建 Case 或发送消息。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "工作对象没有创建。", true);
  } finally {
    state.onboardingSubmitting = false;
    form.querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function onboardingError(result) {
  return ({ package_version_not_found: "该工作包版本不存在或不再可用。", package_not_active: "该工作包已经停用。",
    subject_key_exists: "对象键已经存在，请使用新的唯一键。", primary_contact_invalid: "主要联系人无效或已停用。",
    package_blueprint_invalid: "工作包结构不完整，请先修复包版本。", idempotency_key_reused: "操作编号已用于不同开户请求，请刷新。",
    invalid_request: "请检查开户字段，并填写至少 12 个字符的理由。" })[result.reason]
    ?? (result.error === "admin_required" ? "只有管理员可以建立工作对象。" : "工作对象没有创建。 ");
}

function renderTrial() {
  if (!state.overview || !["manager", "admin"].includes(state.overview.operator?.actorType)) return;
  const select = $("#trial-configuration");
  const published = state.configurations?.releases.filter((item) => item.isCurrentPublished) ?? [];
  const selected = select.value;
  replaceChildren(select, published.length ? published.map((item) => {
    const option = el("option", { text: `${item.subjectName} · 配置 ${item.releaseNumber}`, attrs: { value: item.id } });
    if (item.id === selected) option.selected = true;
    return option;
  }) : [el("option", { text: state.configurations ? "没有已发布配置" : "正在读取已发布配置…", attrs: { value: "" } })]);
  $("#trial-form").querySelector("button").disabled = !published.length;
  if (published.length && !selected) fillTrialDefaults();
  const active = state.overview.cases.filter((item) => !["completed", "cancelled"].includes(item.status)).slice(0, 8);
  replaceChildren($("#trial-case-list"), active.length ? active.map(caseRow)
    : [emptyState("没有进行中的 Case", "先从上方已发布配置创建一轮试运行。")]);
}

function fillTrialDefaults() {
  const release = state.configurations?.releases.find((item) => item.id === $("#trial-configuration").value);
  if (!release) return;
  const defaults = nextPeriodDefaults(release);
  const instant = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  $("#trial-period-key").value = `${defaults.periodKey}-trial-${instant}`;
  $("#trial-period-start").value = defaults.periodStart;
  $("#trial-period-end").value = defaults.periodEnd;
  $("#trial-due-at").value = defaults.dueAt;
}

async function handleTrialSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.trialSubmitting || !form.reportValidity() || !state.overview?.csrfToken) return;
  const data = new FormData(form);
  const dueAt = new Date(String(data.get("dueAt") ?? ""));
  if (Number.isNaN(dueAt.getTime())) return showNotice("请填写有效的试运行截止时间。", true);
  state.trialSubmitting = true;
  form.querySelectorAll("button,input,select,textarea").forEach((control) => { control.disabled = true; });
  try {
    const releaseId = String(data.get("releaseId") ?? "");
    const response = await fetch(`/v1/ops/configurations/${encodeURIComponent(releaseId)}/cases`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({
        periodKey: String(data.get("periodKey") ?? "").trim(),
        periodStart: String(data.get("periodStart") ?? ""),
        periodEnd: String(data.get("periodEnd") ?? ""),
        dueAt: dueAt.toISOString(), timezone: String(data.get("timezone") ?? "").trim(),
        externalReference: "synthetic-owner-trial",
        reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(configurationError(result));
    await loadOverview(false);
    const release = state.configurations?.releases.find((item) => item.id === releaseId);
    const created = result.caseId ? state.overview.cases.find((item) => item.id === result.caseId)
      : state.overview.cases.find((item) => item.subjectKey === release?.subjectKey && item.periodStart === String(data.get("periodStart") ?? ""));
    showNotice(result.outcome === "duplicate" ? "这轮试运行此前已经建立，本次没有重复创建。" : "干净试运行 Case 已建立；现在可以上传纯虚构资料。", false);
    if (result.caseId ?? created?.id) await openCase(result.caseId ?? created.id);
    else renderTrial();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "试运行 Case 没有创建。", true);
  } finally {
    state.trialSubmitting = false;
    form.querySelectorAll("button,input,select,textarea").forEach((control) => { control.disabled = false; });
  }
}

async function loadConfigurations() {
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const response = await fetch("/v1/ops/configurations");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (response.status === 403) throw new Error("当前身份不能查看客户与工作配置。");
    if (!response.ok) throw new Error("暂时无法读取版本化配置。");
    state.configurations = await response.json();
    $("#nav-configuration-count").value = String(state.configurations.releases.filter((item) => item.isCurrentPublished).length);
    renderConfigurations();
    renderTrial();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "客户与配置加载失败。", true);
  }
}

function renderConfigurations() {
  const snapshot = state.configurations;
  if (!snapshot) return;
  $("#configuration-readonly").hidden = snapshot.canManage;
  const groups = new Map();
  for (const release of snapshot.releases) {
    if (!groups.has(release.subjectId)) groups.set(release.subjectId, []);
    groups.get(release.subjectId).push(release);
  }
  replaceChildren($("#configuration-list"), groups.size ? [...groups.values()].map(configurationSubject) : [
    emptyState("还没有配置版本", "先导入一个已发布基准，之后所有变更都会保留版本记录。"),
  ]);
}

function configurationSubject(releases) {
  releases.sort((left, right) => right.releaseNumber - left.releaseNumber);
  const current = releases.find((item) => item.isCurrentPublished) ?? releases[0];
  const section = el("section", { className: "configuration-subject" });
  section.append(el("div", { className: "configuration-subject-heading" }, [
    el("div", {}, [el("span", { text: current.subjectKey }), el("h2", { text: current.subjectName })]),
    el("div", { className: "configuration-current" }, [
      el("span", { text: "当前发布" }),
      el("strong", { text: current.isCurrentPublished ? `版本 ${current.releaseNumber}` : "待建立" }),
    ]),
  ]));
  section.append(el("div", { className: "configuration-release-list" }, releases.map(configurationRelease)));
  return section;
}

function configurationRelease(item) {
  const article = el("article", { className: `configuration-release configuration-${item.status}` });
  const status = ({ draft: "草稿", in_review: "待发布复核", published: item.isCurrentPublished ? "当前发布" : "历史发布" })[item.status];
  article.append(el("div", { className: "configuration-release-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `版本 ${item.releaseNumber} · 修订 ${item.revision}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: status }),
      ]),
      el("p", { text: `${item.workflowTemplateName} · ${item.requirementSetName}` }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: item.createdByName ? `${item.createdByName} · ${formatDateTime(item.createdAt)}` : `基准导入 · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.definitionHash.slice(0, 12) }),
    ]),
  ]));
  article.append(el("div", { className: "configuration-signal-grid" }, [
    configurationSignal("差异", item.diff.join("；")),
    configurationSignal("完整性校验", item.validationErrors.length ? item.validationErrors.join("；") : "已通过"),
    configurationSignal("固定版本", item.producedWorkflowVersion ? `工作流 v${item.producedWorkflowVersion} · 要求 v${item.producedRequirementVersion}` : "发布时生成"),
  ]));
  if (item.status === "draft" && state.configurations.canManage) article.append(configurationDraftForm(item));
  else if (item.status === "in_review" && state.configurations.canManage) article.append(configurationTransitionForm(item));
  else if (item.status === "published" && state.configurations.canManage) article.append(configurationCloneForm(item));
  if (item.status === "published" && item.isCurrentPublished && state.configurations.canCreateCases) {
    article.append(configurationCaseForm(item));
  }
  return article;
}

function configurationSignal(label, value) {
  return el("div", {}, [el("span", { text: label }), el("strong", { text: value })]);
}

function configurationDraftForm(item) {
  const manifest = item.manifest;
  const form = el("form", { className: "configuration-editor", attrs: { "data-config-save": item.id } });
  const nameId = `config-name-${item.id}`;
  const statusId = `config-status-${item.id}`;
  const contactId = `config-contact-${item.id}`;
  const name = el("input", { attrs: { id: nameId, name: "displayName", required: "", minlength: "2", maxlength: "160", value: manifest.subject.displayName } });
  const status = el("select", { attrs: { id: statusId, name: "status" } });
  for (const [value, label] of [["active", "有效"], ["paused", "暂停"], ["offboarding", "移交中"], ["closed", "关闭"]]) {
    const option = el("option", { text: label, attrs: { value } });
    if (value === manifest.subject.status) option.selected = true;
    status.append(option);
  }
  const contact = el("select", { attrs: { id: contactId, name: "primaryContactActorId" } });
  contact.append(el("option", { text: "不设置", attrs: { value: "" } }));
  for (const person of state.configurations.customerContacts) {
    const option = el("option", { text: `${person.displayName}${person.email ? ` · ${person.email}` : ""}`, attrs: { value: person.id } });
    if (person.id === manifest.subject.primaryContactActorId) option.selected = true;
    contact.append(option);
  }
  form.append(configurationField("客户名称", nameId, name));
  form.append(configurationField("客户状态", statusId, status));
  form.append(configurationField("主要联系人", contactId, contact));
  form.append(configurationJsonField("客户属性 JSON", `config-attributes-${item.id}`, "attributes", manifest.subject.attributes));
  form.append(configurationJsonField("工作流定义 JSON", `config-workflow-${item.id}`, "workflow", manifest.workflow));
  form.append(configurationJsonField("资料要求 JSON", `config-requirements-${item.id}`, "requirements", manifest.requirements, "configuration-json-wide"));
  const reasonId = `config-reason-${item.id}`;
  form.append(configurationField("保存理由", reasonId, el("textarea", { attrs: { id: reasonId, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "记录本次配置调整的业务依据。" } }), "configuration-reason"));
  form.append(el("div", { className: "configuration-form-actions" }, [
    el("button", { className: "button button-secondary", text: "保存新修订", attrs: { type: "submit", value: "save" } }),
    el("button", { className: "button button-primary-inline", text: "保存并送审", attrs: { type: "submit", value: "save_and_review" } }),
  ]));
  return form;
}

function configurationField(label, id, control, className = "") {
  return el("div", { className: `configuration-field ${className}`.trim() }, [el("label", { text: label, attrs: { for: id } }), control]);
}
function configurationJsonField(label, id, name, value, className = "") {
  return configurationField(label, id, el("textarea", { text: JSON.stringify(value, null, 2), attrs: { id, name, required: "", rows: name === "requirements" ? "12" : "7", spellcheck: "false" } }), className);
}

function configurationTransitionForm(item) {
  const form = el("form", { className: "configuration-action-form", attrs: { "data-config-transition": item.id } });
  const reasonId = `transition-reason-${item.id}`;
  form.append(configurationField("发布或退回理由", reasonId, el("input", { attrs: { id: reasonId, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "记录复核结论与发布依据" } })));
  form.append(el("div", { className: "configuration-form-actions" }, [
    el("button", { className: "button button-quiet", text: "退回草稿", attrs: { type: "submit", name: "action", value: "return_to_draft" } }),
    el("button", { className: "button button-primary-inline", text: "发布版本", attrs: { type: "submit", name: "action", value: "publish" } }),
  ]));
  return form;
}

function configurationCloneForm(item) {
  const form = el("form", { className: "configuration-action-form", attrs: { "data-config-clone": item.id } });
  const reasonId = `clone-reason-${item.id}`;
  form.append(configurationField(item.isCurrentPublished ? "变更理由" : "回滚理由", reasonId, el("input", { attrs: { id: reasonId, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: item.isCurrentPublished ? "说明下一版需要调整什么" : "说明为何要以此历史版本建立回滚草稿" } })));
  form.append(el("div", { className: "configuration-form-actions" }, [
    el("button", { className: "button button-secondary", text: item.isCurrentPublished ? "创建变更草稿" : "建立回滚草稿", attrs: { type: "submit" } }),
  ]));
  return form;
}

function configurationCaseForm(item) {
  const defaults = nextPeriodDefaults(item);
  const details = el("details", { className: "configuration-case-creator" });
  details.append(el("summary", { text: "从当前版本创建未来 Case" }));
  const form = el("form", { className: "configuration-case-form", attrs: { "data-config-case": item.id } });
  const prefix = `case-${item.id}`;
  form.append(configurationField("期间键", `${prefix}-key`, el("input", { attrs: { id: `${prefix}-key`, name: "periodKey", required: "", maxlength: "80", value: defaults.periodKey, pattern: "[A-Za-z0-9][A-Za-z0-9._-]{0,79}" } })));
  form.append(configurationField("期间开始", `${prefix}-start`, el("input", { attrs: { id: `${prefix}-start`, name: "periodStart", type: "date", required: "", value: defaults.periodStart } })));
  form.append(configurationField("期间结束", `${prefix}-end`, el("input", { attrs: { id: `${prefix}-end`, name: "periodEnd", type: "date", required: "", value: defaults.periodEnd } })));
  form.append(configurationField("截止时间（本地）", `${prefix}-due`, el("input", { attrs: { id: `${prefix}-due`, name: "dueAt", type: "datetime-local", required: "", value: defaults.dueAt } })));
  form.append(configurationField("时区", `${prefix}-timezone`, el("input", { attrs: { id: `${prefix}-timezone`, name: "timezone", required: "", maxlength: "80", value: "Pacific/Auckland" } })));
  form.append(configurationField("外部参考（可选）", `${prefix}-reference`, el("input", { attrs: { id: `${prefix}-reference`, name: "externalReference", maxlength: "200", placeholder: "仅保存参考值，不触发外部发送" } })));
  form.append(configurationField("创建理由", `${prefix}-reason`, el("textarea", { attrs: { id: `${prefix}-reason`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "记录为何要从这个已发布版本建立未来 Case。" } }), "configuration-case-reason"));
  form.append(el("div", { className: "configuration-case-actions" }, [
    el("button", { className: "button button-primary-inline", text: "创建并固定版本", attrs: { type: "submit" } }),
    el("span", { text: "现有 Case 不变；不会自动发送消息。" }),
  ]));
  details.append(form);
  return details;
}

function nextPeriodDefaults(configuration) {
  const explicitCadence = Number(configuration.manifest.workflow.cadenceMonths);
  const cadenceMonths = Number.isInteger(explicitCadence) && explicitCadence >= 1 && explicitCadence <= 12
    ? explicitCadence : configuration.manifest.workflow.frequency === "quarterly" ? 3 : 1;
  const existingCases = state.overview?.cases.filter((item) => item.subjectKey === configuration.subjectKey && item.periodEnd)
    .sort((left, right) => right.periodEnd.localeCompare(left.periodEnd)) ?? [];
  let start;
  if (existingCases[0]) {
    start = new Date(`${existingCases[0].periodEnd}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() + 1);
  } else {
    const source = new Date(state.overview?.generatedAt ?? Date.now());
    const nextMonth = cadenceMonths === 3
      ? Math.floor(source.getUTCMonth() / 3) * 3 + 3
      : source.getUTCMonth() + 1;
    start = new Date(Date.UTC(source.getUTCFullYear(), nextMonth, 1));
  }
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + cadenceMonths, 0));
  const due = new Date(end);
  due.setUTCDate(due.getUTCDate() + 7);
  const day = (value) => value.toISOString().slice(0, 10);
  const periodKey = cadenceMonths === 3
    ? `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`
    : day(start).slice(0, 7);
  return { periodKey, periodStart: day(start), periodEnd: day(end), dueAt: `${day(due)}T17:00` };
}

async function handleConfigurationSubmit(event) {
  event.preventDefault();
  const form = event.target.closest("form");
  if (!form || state.configurationSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  const reason = String(data.get("reason") ?? "");
  if (form.dataset.configCase) {
    const dueAt = new Date(String(data.get("dueAt") ?? ""));
    if (Number.isNaN(dueAt.getTime())) return showNotice("请填写有效的 Case 截止时间。", true);
    const created = await submitConfiguration(`/v1/ops/configurations/${encodeURIComponent(form.dataset.configCase)}/cases`, {
      periodKey: String(data.get("periodKey") ?? "").trim(),
      periodStart: String(data.get("periodStart") ?? ""),
      periodEnd: String(data.get("periodEnd") ?? ""),
      dueAt: dueAt.toISOString(),
      timezone: String(data.get("timezone") ?? "").trim(),
      externalReference: String(data.get("externalReference") ?? "").trim() || null,
      reason,
      idempotencyKey: crypto.randomUUID(),
    }, "未来 Case 已创建并固定当前配置、工作流与要求版本；未发送消息。", false);
    if (created) {
      await loadOverview(false);
      await loadConfigurations();
    }
    return;
  }
  if (form.dataset.configClone) {
    return submitConfiguration(`/v1/ops/configurations/${encodeURIComponent(form.dataset.configClone)}/clone`, { reason, idempotencyKey: crypto.randomUUID() }, "配置草稿已创建；历史发布版保持不变。");
  }
  if (form.dataset.configTransition) {
    return submitConfiguration(`/v1/ops/configurations/${encodeURIComponent(form.dataset.configTransition)}/transitions`, { action: event.submitter?.value, reason, idempotencyKey: crypto.randomUUID() }, event.submitter?.value === "publish" ? "新配置已发布；已有 Case 未被改写。" : "配置已退回草稿。 ");
  }
  if (!form.dataset.configSave) return;
  const item = state.configurations.releases.find((release) => release.id === form.dataset.configSave);
  try {
    const manifest = {
      subject: { ...item.manifest.subject, displayName: String(data.get("displayName") ?? "").trim(), status: String(data.get("status") ?? ""), primaryContactActorId: String(data.get("primaryContactActorId") ?? "") || null, attributes: JSON.parse(String(data.get("attributes") ?? "{}")) },
      workflow: JSON.parse(String(data.get("workflow") ?? "{}")),
      requirements: JSON.parse(String(data.get("requirements") ?? "[]")),
    };
    const saved = await submitConfiguration(`/v1/ops/configurations/${encodeURIComponent(form.dataset.configSave)}/revisions`, { manifest, reason, idempotencyKey: crypto.randomUUID() }, "配置修订已保存。", false);
    if (saved && event.submitter?.value === "save_and_review") {
      await submitConfiguration(`/v1/ops/configurations/${encodeURIComponent(saved.releaseId)}/transitions`, { action: "submit_review", reason, idempotencyKey: crypto.randomUUID() }, "配置已保存并进入发布复核。 ");
    }
  } catch {
    showNotice("JSON 格式无效。请检查客户属性、工作流和资料要求。", true);
  }
}

async function submitConfiguration(path, body, successMessage, reload = true) {
  if (!state.overview?.csrfToken) { showNotice("会话安全信息缺失，请刷新后重试。", true); return null; }
  state.configurationSubmitting = true;
  $("#configuration-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(configurationError(result));
    if (reload) await loadConfigurations();
    showNotice(result.outcome === "duplicate" ? "该配置操作此前已经成功记录。" : successMessage, false);
    return result;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "配置变更没有保存。", true);
    return null;
  } finally {
    state.configurationSubmitting = false;
    $("#configuration-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function configurationError(result) {
  return ({ release_not_current: "这个版本已经有更新修订，请刷新后继续。", release_not_current_draft: "该草稿已更新或不再可编辑，请刷新。",
    transition_not_allowed: "当前版本状态不能执行这个动作。", manifest_shape_invalid: "配置结构不完整。", subject_invalid: "客户档案字段无效。",
    requirements_count_invalid: "资料要求需要 1–100 项。", requirements_duplicate: "资料要求代码或资料类型不能重复。",
    requirement_invalid: "资料要求字段无效。", requirement_count_invalid: "资料数量范围无效。", document_type_not_found: "资料类型不存在或未启用。",
    primary_contact_invalid: "主要联系人不存在、已停用或不是客户联系人。", idempotency_key_reused: "操作编号已用于其他配置变更，请刷新。",
    release_not_current_published: "只能从该对象当前已发布的配置创建 Case，请刷新。", published_configuration_incomplete: "已发布配置缺少固定版本，不能创建 Case。",
    subject_not_active: "工作对象不是有效状态，不能创建 Case。", published_prompt_not_found: "当前没有可用的已发布分类 Prompt。",
    case_already_exists: "该对象与期间的 Case 已经存在。",
    invalid_request: "请填写至少 12 个字符的业务理由并检查配置。" })[result.reason]
    ?? (result.error === "admin_required" ? "只有管理员可以修改或发布配置。"
      : result.error === "manager_required" ? "只有主管或管理员可以创建 Case。" : "配置变更没有保存。 ");
}

async function loadWorkPackages() {
  try {
    const response = await fetch("/v1/ops/work-packages");
    if (response.status === 403) { state.view = "today"; switchView("today"); return; }
    if (!response.ok) throw new Error("无法读取 Work Package。 ");
    state.workPackages = await response.json();
    renderWorkPackages();
    $("#nav-work-packages-count").value = String(new Set(state.workPackages.versions.filter((item) => item.packageStatus === "active").map((item) => item.packageId)).size);
  } catch (error) { showNotice(error instanceof Error ? error.message : "Work Package 读取失败。", true); }
}

function renderWorkPackages() {
  const snapshot = state.workPackages;
  if (!snapshot) return;
  $("#work-package-readonly").hidden = snapshot.canManage;
  $("#work-package-create-section").hidden = !snapshot.canManage;
  const workflowSelect = $("#work-package-workflow");
  const selectedWorkflow = workflowSelect.value;
  replaceChildren(workflowSelect, snapshot.workflowTemplates.map((item) => el("option", {
    text: `${item.displayName} · ${item.templateKey}`, attrs: { value: item.id },
  })));
  if (selectedWorkflow && snapshot.workflowTemplates.some((item) => item.id === selectedWorkflow)) workflowSelect.value = selectedWorkflow;
  const createRequirements = $("#work-package-create-requirements");
  if (!createRequirements.children.length && snapshot.documentTypes.length) {
    createRequirements.append(workPackageRequirementRow(null, "create"));
  }
  const groups = new Map();
  for (const item of snapshot.versions) {
    const versions = groups.get(item.packageId) ?? [];
    versions.push(item);
    groups.set(item.packageId, versions);
  }
  replaceChildren($("#work-package-version-list"), groups.size
    ? [...groups.values()].map(workPackageSection)
    : [emptyState("还没有 Work Package", "管理员可以从结构化草稿和纯虚构 dry-run 开始建立第一个通用工作包。")]);
  replaceChildren($("#work-package-dry-run-list"), snapshot.dryRuns.length
    ? snapshot.dryRuns.map(workPackageDryRunRow)
    : [emptyState("还没有 dry-run", "保存草稿后，用一个明确标记为 synthetic 的工作对象运行发布前校验。")]);
}

function workPackageSection(versions) {
  const latest = versions[0];
  const current = versions.find((item) => item.isCurrentPublished);
  const section = el("section", { className: "work-package" });
  section.append(el("div", { className: "work-package-heading" }, [
    el("div", {}, [
      el("span", { text: latest.packageKey }),
      el("h3", { text: latest.displayName }),
      el("p", { text: latest.description }),
    ]),
    el("div", { className: "work-package-current" }, [
      el("span", { text: latest.packageStatus === "retired" ? "目录状态" : "当前发布" }),
      el("strong", { text: latest.packageStatus === "retired" ? "已停用" : current ? `v${current.version} · rev ${current.revision}` : "尚未发布" }),
    ]),
  ]));
  section.append(el("div", { className: "work-package-version-stack" }, versions.map(workPackageVersionRow)));
  return section;
}

function workPackageVersionRow(item) {
  const status = statusText(item.status);
  const article = el("article", { className: "work-package-version" });
  article.append(el("div", { className: "work-package-version-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `v${item.version} · rev ${item.revision}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: status }),
        ...(item.isCurrentPublished ? [el("span", { className: "configuration-status status-published", text: "开户当前版" })] : []),
        ...(item.hasPassingDryRun ? [el("span", { className: "configuration-status status-published", text: "dry-run 通过" })] : []),
      ]),
      el("p", { text: `${item.workflowTemplateName} · ${item.industryPackage ?? "未限定分类域"} · ${item.blueprint.requirements.length} 项资料要求` }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: `${item.createdByName ?? "系统种子"} · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.definitionHash.slice(0, 12) }),
    ]),
  ]));
  article.append(el("div", { className: "work-package-definition-summary" }, [
    workPackageFact("对象默认", statusText(item.blueprint.subjectDefaults.status)),
    workPackageFact("处理频率", String(item.blueprint.workflow.frequency ?? "未设置")),
    workPackageFact("发布边界", "DEV · synthetic · 外发需批准"),
    workPackageFact("修订理由", item.reason),
  ]));
  if (!item.isCurrentPublished && item.differencesFromPublished.length) {
    const details = el("details", { className: "work-package-diff" });
    details.append(el("summary", { text: `与当前发布版比较 · ${item.differencesFromPublished.length} 处变化` }));
    details.append(el("div", { className: "work-package-diff-list" }, item.differencesFromPublished.slice(0, 40).map(workPackageDiffRow)));
    article.append(details);
  }
  if (item.isLatestRevision && item.status === "draft" && state.workPackages.canManage) {
    article.append(workPackageEditor(item));
    article.append(workPackageDryRunForm(item));
    article.append(workPackageSubmitReviewForm(item));
  }
  if (item.isLatestRevision && item.status === "in_review" && state.workPackages.canManage) {
    article.append(workPackageDryRunForm(item));
    article.append(workPackageTransitionForm(item));
  }
  if (item.isLatestRevision && item.isCurrentPublished && item.packageStatus === "active" && state.workPackages.canManage) {
    article.append(workPackageCloneForm(item));
    article.append(workPackageRetireForm(item));
  }
  return article;
}

function workPackageFact(label, value) {
  return el("div", {}, [el("span", { text: label }), el("strong", { text: value })]);
}

function workPackageDiffRow(item) {
  return el("div", { className: `work-package-diff-row diff-${item.kind}` }, [
    el("code", { text: item.path }),
    el("span", { text: `${workPackageValue(item.before)} → ${workPackageValue(item.after)}` }),
  ]);
}

function workPackageValue(value) {
  if (value === undefined) return "（无）";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function workPackageEditor(item) {
  const details = el("details", { className: "work-package-editor" });
  details.append(el("summary", { text: "编辑结构化草稿" }));
  const form = el("form", { className: "work-package-form", attrs: {
    "data-work-package-save": item.id,
    "data-base-workflow": JSON.stringify(item.blueprint.workflow),
    "data-base-attributes": JSON.stringify(item.blueprint.subjectDefaults.attributes),
  } });
  form.append(
    workPackageField("名称", `work-package-name-${item.id}`, el("input", { attrs: { id: `work-package-name-${item.id}`, name: "displayName", required: "", minlength: "2", maxlength: "160", value: item.displayName } })),
    workPackageField("分类域", `work-package-industry-${item.id}`, el("input", { attrs: { id: `work-package-industry-${item.id}`, name: "industryPackage", maxlength: "120", value: item.industryPackage ?? "" } })),
    workPackageField("用途说明", `work-package-description-${item.id}`, el("textarea", { text: item.description, attrs: { id: `work-package-description-${item.id}`, name: "description", required: "", minlength: "12", maxlength: "1000", rows: "3" } }), "work-package-field-wide"),
  );
  const workflow = el("select", { attrs: { id: `work-package-workflow-${item.id}`, name: "workflowTemplateId", required: "" } }, state.workPackages.workflowTemplates.map((candidate) => el("option", { text: `${candidate.displayName} · ${candidate.templateKey}`, attrs: { value: candidate.id } })));
  workflow.value = item.workflowTemplateId;
  const subjectStatus = el("select", { attrs: { id: `work-package-status-${item.id}`, name: "subjectStatus" } }, [
    el("option", { text: "启用", attrs: { value: "active" } }), el("option", { text: "暂停", attrs: { value: "paused" } }),
  ]);
  subjectStatus.value = item.blueprint.subjectDefaults.status;
  form.append(
    workPackageField("工作流模板", `work-package-workflow-${item.id}`, workflow),
    workPackageField("处理频率", `work-package-frequency-${item.id}`, el("input", { attrs: { id: `work-package-frequency-${item.id}`, name: "frequency", required: "", minlength: "2", maxlength: "80", value: String(item.blueprint.workflow.frequency ?? "") } })),
    workPackageField("对象默认状态", `work-package-status-${item.id}`, subjectStatus),
    el("div", { className: "work-package-locks work-package-field-wide" }, [el("span", { text: "环境 DEV" }), el("span", { text: "仅 synthetic" }), el("span", { text: "外部消息需批准" }), el("span", { text: "收件人仅 allowlist" })]),
  );
  const fieldset = el("fieldset", { className: "work-package-requirements work-package-field-wide" }, [
    el("legend", { text: "资料要求" }), el("p", { text: "每种资料类型只能出现一次；删除只影响这个未发布草稿。" }),
    el("div", { attrs: { id: `work-package-requirements-${item.id}` } }, item.blueprint.requirements.map((requirement) => workPackageRequirementRow(requirement, item.id))),
    el("button", { className: "button button-secondary button-small", text: "添加资料要求", attrs: { type: "button", "data-add-work-package-requirement": item.id } }),
  ]);
  form.append(fieldset);
  form.append(workPackageField("保存理由", `work-package-save-reason-${item.id}`, el("textarea", { attrs: { id: `work-package-save-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "3", placeholder: "说明本次定义变化及其影响。" } }), "work-package-field-wide"));
  form.append(el("div", { className: "work-package-actions" }, [el("button", { className: "button button-primary-inline", text: "保存为新修订", attrs: { type: "submit" } }), el("span", { text: "旧修订不会覆盖" })]));
  details.append(form);
  return details;
}

function workPackageDryRunForm(item) {
  const details = el("details", { className: "work-package-dry-run-form" });
  details.append(el("summary", { text: item.hasPassingDryRun ? "重新运行虚构样本 dry-run" : "运行发布前虚构样本 dry-run" }));
  const form = el("form", { className: "work-package-sample-form", attrs: { "data-work-package-dry-run": item.id } });
  form.append(
    workPackageField("虚构对象键", `work-package-sample-key-${item.id}`, el("input", { attrs: { id: `work-package-sample-key-${item.id}`, name: "subjectKey", required: "", minlength: "3", maxlength: "80", pattern: "[a-z0-9][a-z0-9-]{2,79}", value: "m17-synthetic-sample" } })),
    workPackageField("虚构对象名称", `work-package-sample-name-${item.id}`, el("input", { attrs: { id: `work-package-sample-name-${item.id}`, name: "displayName", required: "", minlength: "2", maxlength: "160", value: "M17 Synthetic Sample Limited" } })),
    workPackageField("对象类型", `work-package-sample-type-${item.id}`, el("input", { attrs: { id: `work-package-sample-type-${item.id}`, name: "subjectType", required: "", minlength: "2", maxlength: "80", value: "synthetic_subject" } })),
    workPackageField("运行理由", `work-package-sample-reason-${item.id}`, el("textarea", { attrs: { id: `work-package-sample-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明本次 dry-run 要证明的定义边界。" } }), "work-package-field-wide"),
  );
  form.append(el("div", { className: "work-package-actions" }, [el("button", { className: "button button-primary-inline", text: "运行 dry-run", attrs: { type: "submit" } }), el("span", { text: "不开户 · 不创建配置 · 不创建 Case" })]));
  details.append(form);
  return details;
}

function workPackageTransitionForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-work-package-transition": item.id } });
  form.append(workPackageField("复核结论", `work-package-transition-reason-${item.id}`, el("textarea", { attrs: { id: `work-package-transition-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "记录发布或退回的依据。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-secondary", text: "退回草稿", attrs: { type: "submit", name: "action", value: "return_to_draft" } }),
    el("button", { className: "button button-primary-inline", text: "发布工作包", attrs: { type: "submit", name: "action", value: "publish", ...(item.hasPassingDryRun ? {} : { disabled: "" }) } }),
  ]));
  return form;
}

function workPackageSubmitReviewForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-work-package-transition": item.id } });
  form.append(workPackageField("送审理由", `work-package-review-reason-${item.id}`, el("textarea", { attrs: { id: `work-package-review-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明 dry-run 已证明什么，以及复核人应重点检查什么。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-primary-inline", text: "提交发布复核", attrs: { type: "submit", name: "action", value: "submit_review", ...(item.hasPassingDryRun ? {} : { disabled: "" }) } }),
    ...(!item.hasPassingDryRun ? [el("span", { text: "需要先通过当前定义的 dry-run" })] : []),
  ]));
  return form;
}

function workPackageCloneForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-work-package-clone": item.id } });
  form.append(workPackageField("下一版理由", `work-package-clone-reason-${item.id}`, el("input", { attrs: { id: `work-package-clone-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "说明下一版需要调整什么。" } })));
  form.append(el("div", { className: "work-package-actions" }, [el("button", { className: "button button-secondary", text: "建立下一版草稿", attrs: { type: "submit" } })]));
  return form;
}

function workPackageRetireForm(item) {
  const details = el("details", { className: "work-package-retire" });
  details.append(el("summary", { text: "停用这个工作包" }));
  const form = el("form", { className: "work-package-action-form", attrs: { "data-work-package-retire": item.packageId } });
  form.append(workPackageField("停用理由", `work-package-retire-reason-${item.id}`, el("textarea", { attrs: { id: `work-package-retire-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明为何不再允许新对象使用这个工作包。" } })));
  form.append(el("div", { className: "work-package-actions" }, [el("button", { className: "button button-secondary", text: "确认停用", attrs: { type: "submit" } }), el("span", { text: "已有对象与历史版本不受影响" })]));
  details.append(form);
  return details;
}

function workPackageRequirementRow(requirement, scope) {
  const prefix = `work-package-requirement-${scope}-${crypto.randomUUID()}`;
  const select = el("select", { attrs: { name: "documentTypeCode", required: "" } }, state.workPackages.documentTypes.map((item) => el("option", { text: `${item.displayName} · ${item.code}`, attrs: { value: item.code } })));
  if (requirement) select.value = requirement.documentTypeCode;
  const acceptanceRule = requirement?.acceptanceRule ?? {};
  return el("div", { className: "work-package-requirement-row", attrs: { "data-acceptance-rule": JSON.stringify(acceptanceRule) } }, [
    workPackageField("要求键", `${prefix}-code`, el("input", { attrs: { id: `${prefix}-code`, name: "code", required: "", minlength: "2", maxlength: "120", value: requirement?.code ?? "document.minimum" } })),
    workPackageField("资料类型", `${prefix}-type`, select),
    workPackageField("最低数量", `${prefix}-minimum`, el("input", { attrs: { id: `${prefix}-minimum`, name: "minimumCount", type: "number", required: "", min: "0", max: "1000", value: String(requirement?.minimumCount ?? 1) } })),
    workPackageField("最高数量", `${prefix}-maximum`, el("input", { attrs: { id: `${prefix}-maximum`, name: "maximumCount", type: "number", min: "0", max: "1000", value: requirement?.maximumCount ?? "", placeholder: "不限" } })),
    workPackageField("验收说明", `${prefix}-notes`, el("input", { attrs: { id: `${prefix}-notes`, name: "notes", maxlength: "500", value: String(acceptanceRule.notes ?? ""), placeholder: "例如完整期间、禁止截图" } })),
    el("button", { className: "text-button work-package-remove-requirement", text: "移除", attrs: { type: "button", "data-remove-work-package-requirement": "" } }),
  ]);
}

function workPackageField(label, id, control, className = "") {
  return el("div", { className: `work-package-field ${className}`.trim() }, [el("label", { text: label, attrs: { for: id } }), control]);
}

function workPackageDryRunRow(item) {
  const passed = item.status === "passed";
  return el("article", { className: "work-package-dry-run-row" }, [
    el("div", {}, [el("strong", { text: String(item.result.subjectName ?? "虚构样本") }), el("span", { text: `${item.runByName} · ${formatDateTime(item.createdAt)} · ${item.reason}` })]),
    el("div", {}, [el("span", { className: `configuration-status ${passed ? "status-published" : "status-draft"}`, text: passed ? "通过" : "失败" }), el("span", { text: `${item.result.requirementCount ?? 0} 项要求 · 不持久化对象/Case` })]),
  ]);
}

function handleWorkPackageClick(event) {
  const add = event.target.closest("[data-add-work-package-requirement]");
  if (add) {
    const scope = add.dataset.addWorkPackageRequirement;
    const target = scope === "create" ? $("#work-package-create-requirements") : $(`#work-package-requirements-${CSS.escape(scope)}`);
    target?.append(workPackageRequirementRow(null, scope));
    return;
  }
  const remove = event.target.closest("[data-remove-work-package-requirement]");
  if (remove) {
    const list = remove.closest("fieldset").querySelectorAll(".work-package-requirement-row");
    if (list.length <= 1) { showNotice("工作包至少需要一项资料要求。", true); return; }
    remove.closest(".work-package-requirement-row")?.remove();
  }
}

async function handleWorkPackageSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form || state.workPackageSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  try {
    if (form.id === "work-package-create-form") {
      const payload = workPackageDefinitionFromForm(form, data);
      const result = await submitWorkPackage("/v1/ops/work-packages", {
        packageKey: String(data.get("packageKey") ?? "").trim().toLowerCase(), ...payload,
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "工作包草稿已建立；尚未发布或进入开户目录。", false);
      if (result) { form.reset(); $("#work-package-create-requirements").replaceChildren(workPackageRequirementRow(null, "create")); }
      return;
    }
    if (form.dataset.workPackageSave) {
      const payload = workPackageDefinitionFromForm(form, data);
      return submitWorkPackage(`/v1/ops/work-packages/${encodeURIComponent(form.dataset.workPackageSave)}/revisions`, {
        ...payload, reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "工作包新修订已保存；旧修订保持不变。", false);
    }
    if (form.dataset.workPackageDryRun) {
      return submitWorkPackage(`/v1/ops/work-packages/${encodeURIComponent(form.dataset.workPackageDryRun)}/dry-runs`, {
        syntheticSample: { subjectKey: String(data.get("subjectKey") ?? "").trim().toLowerCase(), displayName: String(data.get("displayName") ?? "").trim(), subjectType: String(data.get("subjectType") ?? "").trim(), attributes: { synthetic: true, dry_run: true } },
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "虚构样本 dry-run 已完成；没有创建对象、配置或 Case。 ");
    }
    if (form.dataset.workPackageTransition) {
      const action = event.submitter?.value;
      return submitWorkPackage(`/v1/ops/work-packages/${encodeURIComponent(form.dataset.workPackageTransition)}/transitions`, {
        action, reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, action === "publish" ? "工作包已发布并成为新的开户当前版。" : action === "submit_review" ? "工作包已进入发布复核；定义保持固定。" : "工作包已退回草稿；历史复核记录保持不变。 ");
    }
    if (form.dataset.workPackageClone) {
      return submitWorkPackage(`/v1/ops/work-packages/${encodeURIComponent(form.dataset.workPackageClone)}/clone`, {
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "下一版草稿已建立；当前发布版继续可用。 ");
    }
    if (form.dataset.workPackageRetire) {
      return submitWorkPackage(`/v1/ops/work-packages/${encodeURIComponent(form.dataset.workPackageRetire)}/retire`, {
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "工作包已停用；历史对象与版本未被改写。 ");
    }
  } catch (error) { showNotice(error instanceof Error ? error.message : "Work Package 操作失败。", true); }
}

function workPackageDefinitionFromForm(form, data) {
  const requirements = [...form.querySelectorAll(".work-package-requirement-row")].map((row) => {
    const base = JSON.parse(row.dataset.acceptanceRule || "{}");
    const notes = row.querySelector('[name="notes"]').value.trim();
    const maximum = row.querySelector('[name="maximumCount"]').value;
    return {
      code: row.querySelector('[name="code"]').value.trim(),
      documentTypeCode: row.querySelector('[name="documentTypeCode"]').value,
      minimumCount: Number(row.querySelector('[name="minimumCount"]').value),
      maximumCount: maximum === "" ? null : Number(maximum),
      acceptanceRule: { ...base, ...(notes ? { notes } : {}) },
    };
  });
  const documentCodes = new Set(requirements.map((item) => item.documentTypeCode));
  const requirementCodes = new Set(requirements.map((item) => item.code.toLowerCase()));
  if (documentCodes.size !== requirements.length || requirementCodes.size !== requirements.length) throw new Error("要求键和资料类型都不能重复。 ");
  for (const requirement of requirements) if (requirement.maximumCount !== null && requirement.maximumCount < requirement.minimumCount) throw new Error("最高数量不能小于最低数量。 ");
  const baseWorkflow = JSON.parse(form.dataset.baseWorkflow || "{}");
  const baseAttributes = JSON.parse(form.dataset.baseAttributes || "{}");
  return {
    displayName: String(data.get("displayName") ?? "").trim(),
    description: String(data.get("description") ?? "").trim(),
    industryPackage: String(data.get("industryPackage") ?? "").trim().toLowerCase() || null,
    workflowTemplateId: String(data.get("workflowTemplateId") ?? ""),
    blueprint: {
      subjectDefaults: { status: String(data.get("subjectStatus") ?? "active"), attributes: { ...baseAttributes, synthetic: true, case_generation_enabled: true } },
      workflow: { ...baseWorkflow, frequency: String(data.get("frequency") ?? "").trim(), environment: "DEV", external_messages_require_approval: true, dev_recipient_policy: "allowlist_only" },
      requirements,
    },
  };
}

async function submitWorkPackage(path, body, message, resetReason = true) {
  state.workPackageSubmitting = true;
  $("#work-packages-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(workPackageError(result));
    showNotice(message, false);
    await Promise.all([loadWorkPackages(), loadOnboarding()]);
    state.view = "work-packages";
    switchView("work-packages");
    return result;
  } finally {
    state.workPackageSubmitting = false;
    $("#work-packages-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function workPackageError(result) {
  return ({
    invalid_request: "字段或理由不符合工作包规则。", package_key_exists: "工作包键已经存在。",
    package_blueprint_invalid: "工作包结构不完整。", package_safety_boundary_invalid: "DEV、synthetic、审批或 allowlist 安全边界被改变。",
    workflow_template_not_found: "所选工作流模板不可用。", document_type_not_found: "资料类型已经停用或不存在。",
    requirements_duplicate: "要求键或资料类型重复。", requirement_invalid: "资料要求字段无效。", requirement_count_invalid: "资料数量范围无效。",
    package_not_active: "工作包已经停用。", draft_not_current: "该草稿已有更新修订，请刷新。", version_not_current: "该版本已有后续修订，请刷新。",
    definition_unchanged: "定义没有变化，无需建立新修订。", source_not_current_published: "只能从当前发布版建立下一版。",
    open_draft_exists: "已有未完成草稿或复核版本。", passing_dry_run_required: "当前定义必须先通过虚构样本 dry-run。",
    invalid_transition: "当前状态不允许这个操作。", package_version_not_found: "工作包版本不存在。", package_not_found: "工作包不存在。",
    idempotency_key_reused: "请求标识已被不同操作使用，请刷新后重试。",
  })[result.reason] ?? "Work Package 操作未完成，请刷新后重试。";
}

async function loadClassificationProfile() {
  try {
    const response = await fetch("/v1/ops/classification-profile");
    if (response.status === 403) { state.view = "today"; switchView("today"); return; }
    if (!response.ok) throw new Error("无法读取分类体系。 ");
    state.classificationProfile = await response.json();
    renderClassificationProfile();
    $("#nav-classification-profile-count").value = String(
      state.classificationProfile.versions.find((item) => item.isCurrentPublished)?.definition.labels.length ?? 0,
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "分类体系读取失败。", true);
  }
}

function renderClassificationProfile() {
  const snapshot = state.classificationProfile;
  if (!snapshot) return;
  $("#classification-profile-readonly").hidden = snapshot.canManage;
  replaceChildren($("#classification-profile-version-list"), snapshot.versions.length
    ? snapshot.versions.map(classificationProfileVersionRow)
    : [emptyState("还没有分类体系", "迁移会从当前资料类型目录建立第一份受治理的发布版本。")]);
  replaceChildren($("#classification-profile-evaluation-list"), snapshot.evaluationRuns.length
    ? snapshot.evaluationRuns.map(classificationProfileEvaluationRow)
    : [emptyState("还没有政策评估", "从当前发布版建立草稿后，运行无模型调用的虚构政策评估。")]);
}

function classificationProfileVersionRow(item) {
  const article = el("article", { className: "classification-version" });
  article.append(el("div", { className: "classification-version-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `v${item.version} · rev ${item.revision}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: statusText(item.status) }),
        ...(item.isCurrentPublished ? [el("span", { className: "configuration-status status-published", text: "运行时当前版" })] : []),
        ...(item.hasPassingEvaluation ? [el("span", { className: "configuration-status status-published", text: "评估通过" })] : []),
      ]),
      el("h3", { text: item.profileDisplayName }),
      el("p", { text: item.profileDescription }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: `${item.createdByName ?? "系统基线"} · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.definitionHash.slice(0, 12) }),
    ]),
  ]));
  article.append(el("div", { className: "classification-facts" }, [
    classificationFact("标签", `${item.definition.labels.length} 个`),
    classificationFact("抽取字段", `${item.definition.labels.reduce((sum, label) => sum + label.extractionFields.length, 0)} 个`),
    classificationFact("虚构评估", `${item.definition.evaluationCases.length} 例`),
    classificationFact("安全路由", "未知/歧义 → 人工复核"),
  ]));
  if (!item.isCurrentPublished && item.differencesFromPublished.length) {
    const differences = el("details", { className: "work-package-diff" });
    differences.append(el("summary", { text: `与当前发布版比较 · ${item.differencesFromPublished.length} 处变化` }));
    differences.append(el("div", { className: "work-package-diff-list" },
      item.differencesFromPublished.slice(0, 60).map(workPackageDiffRow)));
    article.append(differences);
  }
  const catalogue = el("details", { className: "classification-catalogue" });
  catalogue.append(el("summary", { text: `查看 ${item.definition.labels.length} 个标签与规则` }));
  catalogue.append(el("div", { className: "classification-label-read-list" }, item.definition.labels.map(classificationLabelReadRow)));
  article.append(catalogue);
  if (item.isLatestRevision && item.status === "draft" && state.classificationProfile.canManage) {
    article.append(classificationProfileEditor(item));
    article.append(classificationProfileEvaluationForm(item));
    article.append(classificationProfileSubmitReviewForm(item));
  }
  if (item.isLatestRevision && item.status === "in_review" && state.classificationProfile.canManage) {
    article.append(classificationProfileEvaluationForm(item));
    article.append(classificationProfileTransitionForm(item));
  }
  if (item.isLatestRevision && item.isCurrentPublished && state.classificationProfile.canManage) {
    article.append(classificationProfileCloneForm(item));
  }
  return article;
}

function classificationFact(label, value) {
  return el("div", {}, [el("span", { text: label }), el("strong", { text: value })]);
}

function classificationLabelReadRow(label) {
  return el("article", { className: "classification-label-read" }, [
    el("div", {}, [el("strong", { text: label.displayName }), el("code", { text: label.code }), el("p", { text: label.description })]),
    el("div", {}, [
      el("span", { text: `阈值 ${Number(label.policy.minimumConfidence).toFixed(2)}` }),
      el("span", { text: label.policy.alwaysHumanConfirm ? "始终人工确认" : "规则通过可接受" }),
      el("span", { text: `${label.extractionFields.length} 个抽取字段` }),
    ]),
  ]);
}

function classificationProfileEditor(item) {
  const details = el("details", { className: "classification-editor" });
  details.append(el("summary", { text: "编辑结构化分类草稿" }));
  const form = el("form", { className: "classification-form", attrs: { "data-classification-save": item.id } });
  form.append(el("div", { className: "work-package-locks classification-span" }, [
    el("span", { text: "环境 DEV" }), el("span", { text: "未知 → 人工复核" }),
    el("span", { text: "歧义 → 人工复核" }), el("span", { text: "评估不调用模型" }),
  ]));
  form.append(el("fieldset", { className: "classification-fieldset classification-span" }, [
    el("legend", { text: "标签与抽取字段" }),
    el("p", { text: "已发布标签代码保持稳定；可以增加新标签或调整名称、说明、字段和判断规则。" }),
    el("div", { className: "classification-label-editor-list" }, item.definition.labels.map((label) => classificationLabelEditorRow(label, true))),
    el("button", { className: "button button-secondary button-small", text: "添加新标签", attrs: { type: "button", "data-add-classification-label": "" } }),
  ]));
  form.append(el("fieldset", { className: "classification-fieldset classification-span" }, [
    el("legend", { text: "虚构评估集" }),
    el("p", { text: "至少覆盖一个正常接受、一个规则复核，以及一个未知或歧义输入。" }),
    el("div", { className: "classification-case-editor-list" }, item.definition.evaluationCases.map(classificationCaseEditorRow)),
    el("button", { className: "button button-secondary button-small", text: "添加评估例", attrs: { type: "button", "data-add-classification-case": "" } }),
  ]));
  form.append(workPackageField("保存理由", `classification-save-reason-${item.id}`,
    el("textarea", { attrs: { id: `classification-save-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "3", placeholder: "说明标签、字段或阈值为何改变，以及预期影响。" } }), "classification-span"));
  form.append(el("div", { className: "work-package-actions classification-span" }, [
    el("button", { className: "button button-primary-inline", text: "保存为新修订", attrs: { type: "submit" } }),
    el("span", { text: "旧定义与历史分类尝试不会改写" }),
  ]));
  details.append(form);
  return details;
}

function classificationLabelEditorRow(label = null, locked = false) {
  const rowId = crypto.randomUUID();
  const policy = label?.policy ?? {
    minimumConfidence: 0.85, alwaysHumanConfirm: false, manualOnConflict: true,
    rejectOnQualityFlags: [...state.classificationProfile.qualityFlags],
    rejectOnConflictFlags: [...state.classificationProfile.conflictFlags],
  };
  const row = el("article", { className: "classification-label-editor", attrs: { "data-classification-label": "" } });
  row.append(el("div", { className: "classification-label-editor-heading" }, [
    el("strong", { text: label?.displayName ?? "新标签" }),
    el("span", { text: locked ? "稳定代码" : "尚未发布" }),
    ...(!locked ? [el("button", { className: "text-button", text: "移除标签", attrs: { type: "button", "data-remove-classification-label": "" } })] : []),
  ]));
  row.append(el("div", { className: "classification-label-grid" }, [
    classificationControl("标签代码", `${rowId}-code`, "code", label?.code ?? "", { required: "", pattern: "[a-z0-9][a-z0-9._-]{2,119}", ...(locked ? { readonly: "" } : {}) }),
    classificationControl("显示名称", `${rowId}-name`, "displayName", label?.displayName ?? "", { required: "", minlength: "2", maxlength: "160" }),
    classificationControl("允许 MIME（逗号分隔）", `${rowId}-mime`, "allowedMimeTypes", (label?.allowedMimeTypes ?? ["application/pdf", "image/jpeg", "image/png"]).join(", "), { required: "" }),
    classificationControl("最低置信度", `${rowId}-confidence`, "minimumConfidence", String(policy.minimumConfidence), { required: "", type: "number", min: "0", max: "1", step: "0.01" }),
    workPackageField("用途与边界", `${rowId}-description`, el("textarea", { text: label?.description ?? "", attrs: { id: `${rowId}-description`, name: "description", required: "", minlength: "12", maxlength: "1000", rows: "2" } }), "classification-wide"),
    classificationCheckbox("始终要求人工确认", "alwaysHumanConfirm", policy.alwaysHumanConfirm),
    classificationCheckbox("出现冲突标记时人工复核", "manualOnConflict", policy.manualOnConflict),
    classificationControl("拒绝质量标记（逗号分隔）", `${rowId}-quality`, "rejectOnQualityFlags", policy.rejectOnQualityFlags.join(", "), {}),
    classificationControl("拒绝冲突标记（逗号分隔）", `${rowId}-conflict`, "rejectOnConflictFlags", policy.rejectOnConflictFlags.join(", "), {}),
  ]));
  row.append(el("fieldset", { className: "classification-extraction-fields" }, [
    el("legend", { text: "抽取字段" }),
    el("div", { className: "classification-extraction-list" }, (label?.extractionFields ?? []).map(classificationExtractionFieldRow)),
    el("button", { className: "button button-secondary button-small", text: "添加抽取字段", attrs: { type: "button", "data-add-classification-field": "" } }),
  ]));
  return row;
}

function classificationExtractionFieldRow(field = null) {
  const rowId = crypto.randomUUID();
  const select = el("select", { attrs: { id: `${rowId}-type`, name: "valueType" } }, [
    ["string", "文本"], ["number", "数字"], ["date", "日期"], ["boolean", "是/否"],
  ].map(([value, text]) => el("option", { text, attrs: { value } })));
  select.value = field?.valueType ?? "string";
  return el("div", { className: "classification-extraction-row", attrs: { "data-classification-field": "" } }, [
    classificationControl("字段键", `${rowId}-key`, "key", field?.key ?? "", { required: "", pattern: "[a-z][a-z0-9_]{1,79}" }),
    classificationControl("显示名称", `${rowId}-name`, "displayName", field?.displayName ?? "", { required: "", minlength: "2" }),
    workPackageField("值类型", `${rowId}-type`, select),
    classificationCheckbox("必填", "required", field?.required === true),
    el("button", { className: "text-button", text: "移除", attrs: { type: "button", "data-remove-classification-field": "" } }),
  ]);
}

function classificationCaseEditorRow(item = null) {
  const rowId = crypto.randomUUID();
  const route = el("select", { attrs: { id: `${rowId}-route`, name: "expectedRoute" } }, [
    el("option", { text: "接受", attrs: { value: "accepted" } }),
    el("option", { text: "人工复核", attrs: { value: "review_required" } }),
  ]);
  route.value = item?.expectedRoute ?? "review_required";
  return el("article", { className: "classification-case-editor", attrs: { "data-classification-case": "" } }, [
    el("div", { className: "classification-case-grid" }, [
      classificationControl("评估键", `${rowId}-key`, "caseKey", item?.caseKey ?? "", { required: "", pattern: "[a-z0-9][a-z0-9._-]{2,119}" }),
      classificationControl("名称", `${rowId}-name`, "displayName", item?.displayName ?? "", { required: "", minlength: "2" }),
      classificationControl("虚构文件名", `${rowId}-file`, "filename", item?.filename ?? "synthetic-sample.pdf", { required: "" }),
      classificationControl("MIME", `${rowId}-mime`, "mimeType", item?.mimeType ?? "application/pdf", { required: "" }),
      classificationControl("预测标签（未知填 __unknown__）", `${rowId}-prediction`, "predictedLabelCode", item?.predictedLabelCode ?? "__unknown__", { required: "" }),
      classificationControl("歧义标签（逗号分隔）", `${rowId}-ambiguous`, "ambiguousLabelCodes", (item?.ambiguousLabelCodes ?? []).join(", "), {}),
      classificationControl("置信度", `${rowId}-confidence`, "confidence", String(item?.confidence ?? 0.5), { required: "", type: "number", min: "0", max: "1", step: "0.01" }),
      workPackageField("期望路由", `${rowId}-route`, route),
      classificationControl("质量标记（逗号分隔）", `${rowId}-quality`, "qualityFlags", (item?.qualityFlags ?? []).join(", "), {}),
      classificationControl("冲突标记（逗号分隔）", `${rowId}-conflict`, "conflictFlags", (item?.conflictFlags ?? []).join(", "), {}),
    ]),
    el("button", { className: "text-button classification-remove-case", text: "移除评估例", attrs: { type: "button", "data-remove-classification-case": "" } }),
  ]);
}

function classificationControl(label, id, name, value, attributes) {
  return workPackageField(label, id, el("input", { attrs: { id, name, value, ...attributes } }));
}

function classificationCheckbox(label, name, checked) {
  return el("label", { className: "classification-checkbox" }, [
    el("input", { attrs: { type: "checkbox", name, ...(checked ? { checked: "" } : {}) } }),
    el("span", { text: label }),
  ]);
}

function classificationProfileEvaluationForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-classification-evaluate": item.id } });
  form.append(workPackageField("评估理由", `classification-evaluate-reason-${item.id}`,
    el("textarea", { attrs: { id: `classification-evaluate-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明这次虚构评估要验证哪些路由边界。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-primary-inline", text: "运行政策评估", attrs: { type: "submit" } }),
    el("span", { text: "无模型调用 · 不持久化资料 · 不外发" }),
  ]));
  return form;
}

function classificationProfileSubmitReviewForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-classification-transition": item.id } });
  form.append(workPackageField("送审理由", `classification-review-reason-${item.id}`,
    el("textarea", { attrs: { id: `classification-review-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明评估覆盖与复核重点。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-primary-inline", text: "提交发布复核", attrs: { type: "submit", name: "action", value: "submit_review", ...(item.hasPassingEvaluation ? {} : { disabled: "" }) } }),
    ...(!item.hasPassingEvaluation ? [el("span", { text: "需要先通过当前定义的全部评估例" })] : []),
  ]));
  return form;
}

function classificationProfileTransitionForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-classification-transition": item.id } });
  form.append(workPackageField("复核结论", `classification-transition-reason-${item.id}`,
    el("textarea", { attrs: { id: `classification-transition-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "记录发布或退回依据。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-secondary", text: "退回草稿", attrs: { type: "submit", name: "action", value: "return_to_draft" } }),
    el("button", { className: "button button-primary-inline", text: "发布分类体系", attrs: { type: "submit", name: "action", value: "publish", ...(item.hasPassingEvaluation ? {} : { disabled: "" }) } }),
  ]));
  return form;
}

function classificationProfileCloneForm(item) {
  const form = el("form", { className: "work-package-action-form", attrs: { "data-classification-clone": item.id } });
  form.append(workPackageField("下一版理由", `classification-clone-reason-${item.id}`,
    el("input", { attrs: { id: `classification-clone-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "说明下一版计划扩展的类别或规则。" } })));
  form.append(el("div", { className: "work-package-actions" }, [
    el("button", { className: "button button-secondary", text: "建立下一版草稿", attrs: { type: "submit" } }),
  ]));
  return form;
}

function classificationProfileEvaluationRow(item) {
  const result = item.result ?? {};
  return el("article", { className: "classification-evaluation-row" }, [
    el("div", {}, [
      el("strong", { text: item.status === "passed" ? "全部评估通过" : "评估存在失败" }),
      el("span", { text: `${item.runByName} · ${formatDateTime(item.createdAt)} · ${item.reason}` }),
    ]),
    el("div", {}, [
      el("span", { className: `configuration-status ${item.status === "passed" ? "status-published" : "status-draft"}`, text: item.status === "passed" ? "通过" : "失败" }),
      el("span", { text: `${result.passedCases ?? 0}/${result.totalCases ?? 0} 例 · 无模型调用` }),
    ]),
  ]);
}

function handleClassificationProfileClick(event) {
  const addLabel = event.target.closest("[data-add-classification-label]");
  if (addLabel) {
    addLabel.parentElement.querySelector(".classification-label-editor-list")?.append(classificationLabelEditorRow());
    return;
  }
  const removeLabel = event.target.closest("[data-remove-classification-label]");
  if (removeLabel) { removeLabel.closest("[data-classification-label]")?.remove(); return; }
  const addField = event.target.closest("[data-add-classification-field]");
  if (addField) {
    addField.parentElement.querySelector(".classification-extraction-list")?.append(classificationExtractionFieldRow());
    return;
  }
  const removeField = event.target.closest("[data-remove-classification-field]");
  if (removeField) { removeField.closest("[data-classification-field]")?.remove(); return; }
  const addCase = event.target.closest("[data-add-classification-case]");
  if (addCase) {
    addCase.parentElement.querySelector(".classification-case-editor-list")?.append(classificationCaseEditorRow());
    return;
  }
  const removeCase = event.target.closest("[data-remove-classification-case]");
  if (removeCase) {
    const cases = removeCase.closest(".classification-case-editor-list")?.querySelectorAll("[data-classification-case]") ?? [];
    if (cases.length <= 3) { showNotice("分类体系至少需要三个虚构评估例。", true); return; }
    removeCase.closest("[data-classification-case]")?.remove();
  }
}

async function handleClassificationProfileSubmit(event) {
  event.preventDefault();
  if (state.classificationProfileSubmitting) return;
  const form = event.target;
  const data = new FormData(form);
  try {
    if (form.dataset.classificationSave) {
      return submitClassificationProfile(`/v1/ops/classification-profile/${encodeURIComponent(form.dataset.classificationSave)}/revisions`, {
        definition: classificationDefinitionFromForm(form), reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "分类体系新修订已保存；运行时发布版没有改变。");
    }
    if (form.dataset.classificationEvaluate) {
      return submitClassificationProfile(`/v1/ops/classification-profile/${encodeURIComponent(form.dataset.classificationEvaluate)}/evaluations`, {
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "虚构政策评估已完成；没有调用模型或创建资料。");
    }
    if (form.dataset.classificationTransition) {
      const action = event.submitter?.value;
      return submitClassificationProfile(`/v1/ops/classification-profile/${encodeURIComponent(form.dataset.classificationTransition)}/transitions`, {
        action, reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, action === "publish" ? "分类体系已发布，未来分类将记录这个准确版本。" : action === "submit_review" ? "分类体系已进入发布复核。" : "分类体系已退回草稿。");
    }
    if (form.dataset.classificationClone) {
      return submitClassificationProfile(`/v1/ops/classification-profile/${encodeURIComponent(form.dataset.classificationClone)}/clone`, {
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "下一版分类体系草稿已建立；当前发布版继续运行。");
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "分类体系操作失败。", true);
  }
}

function classificationDefinitionFromForm(form) {
  const labels = [...form.querySelectorAll("[data-classification-label]")].map((row) => ({
    code: row.querySelector('[name="code"]').value.trim().toLowerCase(),
    displayName: row.querySelector('[name="displayName"]').value.trim(),
    description: row.querySelector('[name="description"]').value.trim(),
    allowedMimeTypes: commaList(row.querySelector('[name="allowedMimeTypes"]').value),
    extractionFields: [...row.querySelectorAll("[data-classification-field]")].map((field) => ({
      key: field.querySelector('[name="key"]').value.trim().toLowerCase(),
      displayName: field.querySelector('[name="displayName"]').value.trim(),
      valueType: field.querySelector('[name="valueType"]').value,
      required: field.querySelector('[name="required"]').checked,
    })),
    policy: {
      minimumConfidence: Number(row.querySelector('[name="minimumConfidence"]').value),
      alwaysHumanConfirm: row.querySelector('[name="alwaysHumanConfirm"]').checked,
      manualOnConflict: row.querySelector('[name="manualOnConflict"]').checked,
      rejectOnQualityFlags: commaList(row.querySelector('[name="rejectOnQualityFlags"]').value),
      rejectOnConflictFlags: commaList(row.querySelector('[name="rejectOnConflictFlags"]').value),
    },
  }));
  const evaluationCases = [...form.querySelectorAll("[data-classification-case]")].map((row) => ({
    caseKey: row.querySelector('[name="caseKey"]').value.trim().toLowerCase(),
    displayName: row.querySelector('[name="displayName"]').value.trim(), synthetic: true,
    filename: row.querySelector('[name="filename"]').value.trim(),
    mimeType: row.querySelector('[name="mimeType"]').value.trim().toLowerCase(),
    predictedLabelCode: row.querySelector('[name="predictedLabelCode"]').value.trim().toLowerCase(),
    ambiguousLabelCodes: commaList(row.querySelector('[name="ambiguousLabelCodes"]').value),
    confidence: Number(row.querySelector('[name="confidence"]').value),
    qualityFlags: commaList(row.querySelector('[name="qualityFlags"]').value),
    conflictFlags: commaList(row.querySelector('[name="conflictFlags"]').value),
    expectedRoute: row.querySelector('[name="expectedRoute"]').value,
  }));
  if (new Set(labels.map((item) => item.code)).size !== labels.length) throw new Error("标签代码不能重复。");
  if (new Set(evaluationCases.map((item) => item.caseKey)).size !== evaluationCases.length) throw new Error("评估键不能重复。");
  return { schemaVersion: "1.0", environment: "DEV", unknownDocumentRoute: "review_required",
    ambiguityRoute: "review_required", labels, evaluationCases };
}

function commaList(value) {
  return [...new Set(String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function submitClassificationProfile(path, body, message) {
  state.classificationProfileSubmitting = true;
  $("#classification-profile-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(classificationProfileError(result));
    showNotice(message, false);
    await Promise.all([loadClassificationProfile(), loadWorkPackages()]);
    state.view = "classification-profile";
    switchView("classification-profile");
    return result;
  } finally {
    state.classificationProfileSubmitting = false;
    $("#classification-profile-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function classificationProfileError(result) {
  return ({
    invalid_request: "字段或理由不符合分类体系规则。", classification_profile_definition_invalid: "定义结构或固定 DEV 安全路由被改变。",
    classification_profile_duplicate_key: "标签代码或评估键重复。", classification_label_invalid: "标签名称、说明或判断规则无效。",
    classification_label_mime_invalid: "允许的 MIME 格式无效。", classification_extraction_field_duplicate: "同一标签的抽取字段键不能重复。",
    classification_extraction_field_invalid: "抽取字段的键、名称、类型或必填设置无效。", classification_quality_flag_invalid: "存在不受支持的质量标记。",
    classification_conflict_flag_invalid: "存在不受支持的冲突标记。", active_document_type_missing: "不能删除已经发布并被使用的标签；可以保留后调整规则。",
    classification_evaluation_case_invalid: "虚构评估例字段无效。", classification_evaluation_coverage_missing: "评估集必须覆盖接受、规则复核和未知/歧义三类路径。",
    classification_profile_version_not_found: "分类体系版本不存在。", source_not_current_published: "只能从当前运行时发布版建立下一版。",
    open_draft_exists: "已有未完成的分类体系草稿或复核版本。", version_not_current: "该版本已有后续修订，请刷新。",
    passing_evaluation_required: "当前定义必须先通过全部虚构政策评估。", invalid_transition: "当前状态不允许这个操作。",
    idempotency_key_reused: "请求标识已被不同操作使用，请刷新后重试。",
  })[result.reason] ?? "分类体系操作未完成，请刷新后重试。";
}

async function loadClassifierReleases() {
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const response = await fetch("/v1/ops/classifier-releases");
    if (response.status === 403) { state.view = "today"; switchView("today"); return; }
    if (!response.ok) throw new Error("无法读取分类器发布版本。 ");
    state.classifierReleases = await response.json();
    renderClassifierReleases();
    $("#nav-classifier-releases-count").value = String(
      state.classifierReleases.versions.find((item) => item.isCurrentPublished)?.version ?? 0,
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "分类器发布版本读取失败。", true);
  }
}

function renderClassifierReleases() {
  const snapshot = state.classifierReleases;
  if (!snapshot) return;
  $("#classifier-releases-readonly").hidden = snapshot.canManage;
  replaceChildren($("#classifier-release-version-list"), snapshot.versions.length
    ? snapshot.versions.map(classifierReleaseVersionRow)
    : [emptyState("还没有分类器发布", "迁移会从当前 Prompt 和分类体系建立第一份运行基线。")]);
  replaceChildren($("#classifier-release-evaluation-list"), snapshot.evaluationRuns.length
    ? snapshot.evaluationRuns.map(classifierReleaseEvaluationRow)
    : [emptyState("还没有发布评估", "从当前发布版建立草稿后，先做兼容性检查，再运行真实模型虚构资料评估。")]);
}

function classifierReleaseVersionRow(item) {
  const article = el("article", { className: "classification-version" });
  article.append(el("div", { className: "classification-version-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `v${item.version} · rev ${item.revision}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: statusText(item.status) }),
        ...(item.isCurrentPublished ? [el("span", { className: "configuration-status status-published", text: "未来 Case 当前版" })] : []),
        ...(item.hasPassingCompatibilityEvaluation ? [el("span", { className: "configuration-status status-published", text: "兼容通过" })] : []),
        ...(item.hasPassingProviderEvaluation ? [el("span", { className: "configuration-status status-published", text: "模型通过" })] : []),
      ]),
      el("h3", { text: item.releaseDisplayName }),
      el("p", { text: item.releaseDescription }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: `${item.createdByName ?? "系统基线"} · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.definitionHash.slice(0, 12) }),
    ]),
  ]));
  article.append(el("dl", { className: "classifier-release-facts" }, [
    evidence("模型", item.definition.model),
    evidence("Prompt", `${item.definition.promptKey} · ${item.definition.promptInstructionHash.slice(0, 12)}`),
    evidence("输出 Schema", `${item.definition.responseSchemaVersion} · ${item.definition.responseSchemaHash.slice(0, 12)}`),
    evidence("分类体系", `${shortId(item.definition.classificationProfileVersionId)} · ${item.definition.classificationProfileDefinitionHash.slice(0, 12)}`),
    evidence("请求策略", `${item.definition.requestPolicy.reasoningEffort} · ${item.definition.requestPolicy.maxOutputTokens} tokens · store=false`),
    evidence("虚构评估例", String(item.definition.providerEvaluationCases.length)),
  ]));
  if (item.differencesFromPublished.length) article.append(el("details", { className: "configuration-diff" }, [
    el("summary", { text: `相对当前发布版有 ${item.differencesFromPublished.length} 项差异` }),
    el("ul", {}, item.differencesFromPublished.slice(0, 30).map((difference) => el("li", { text: difference.path }))),
  ]));
  if (!state.classifierReleases.canManage || !item.isLatestRevision) return article;
  if (item.status === "published" && item.isCurrentPublished) article.append(classifierReleaseReasonForm(item, "clone", "建立下一版草稿", "说明为什么需要新的分类器版本。"));
  if (item.status === "draft") {
    article.append(classifierReleaseEditor(item));
    article.append(classifierReleaseReasonForm(item, "evaluate-compatibility", "运行兼容性检查", "确认 Prompt、Schema 与分类体系引用准确一致。"));
    article.append(classifierReleaseReasonForm(item, "evaluate-provider", "运行真实模型虚构评估", "使用三个纯虚构文本样例验证当前完整发布定义。"));
    if (item.hasPassingCompatibilityEvaluation && item.hasPassingProviderEvaluation) {
      article.append(classifierReleaseReasonForm(item, "submit_review", "送交发布复核", "说明评估证据充分且可以进入发布复核。"));
    }
  }
  if (item.status === "in_review") {
    article.append(classifierReleaseReasonForm(item, "publish", "发布给未来 Case", "说明为什么批准这个完整分类器版本。"));
    article.append(classifierReleaseReasonForm(item, "return_to_draft", "退回草稿", "说明需要修订的内容。"));
  }
  return article;
}

function classifierReleaseEditor(item) {
  const definition = item.definition;
  const form = el("form", { className: "classification-editor classifier-release-editor", attrs: { "data-classifier-release-save": item.id } });
  form.append(el("div", { className: "classification-editor-heading" }, [
    el("div", {}, [el("h4", { text: "编制完整运行定义" }), el("p", { text: "分类体系与输出 Schema 只读固定；修改 Prompt 或模型后必须重新完成两类评估。" })]),
  ]));
  form.append(el("div", { className: "classifier-release-grid" }, [
    releaseInput("模型", "model", definition.model, "text", true),
    releaseInput("推理强度", "reasoningEffort", definition.requestPolicy.reasoningEffort, "select", true, ["low", "medium", "high"]),
    releaseInput("最大输出 tokens", "maxOutputTokens", String(definition.requestPolicy.maxOutputTokens), "number", true),
    releaseInput("Prompt 键", "promptKey", definition.promptKey, "text", true),
  ]));
  const prompt = el("textarea", { attrs: { name: "promptInstructions", rows: "16", minlength: "100", maxlength: "20000", required: "" } });
  prompt.value = definition.promptInstructions;
  form.append(el("label", { className: "classification-editor-field classification-editor-field-wide" }, [
    el("span", { text: "系统 Prompt" }), prompt,
    el("small", { text: `当前哈希 ${definition.promptInstructionHash}` }),
  ]));
  form.append(el("div", { className: "classifier-release-locks" }, [
    el("span", { text: `环境 ${definition.environment}` }), el("span", { text: "store=false" }),
    el("span", { text: `Schema ${definition.responseSchemaHash.slice(0, 12)}` }),
    el("span", { text: `分类体系 ${definition.classificationProfileDefinitionHash.slice(0, 12)}` }),
  ]));
  form.append(el("fieldset", { className: "classifier-release-cases" }, [
    el("legend", { text: "真实模型虚构资料评估例" }),
    el("p", { text: "只保存虚构测试文本；评估结果保存标签、置信度、模型、响应 ID 与 token 数，不保存模型原始输出。" }),
    ...definition.providerEvaluationCases.map((testCase, index) => classifierReleaseCaseEditor(testCase, index)),
  ]));
  const reason = el("textarea", { attrs: { name: "reason", rows: "3", minlength: "12", maxlength: "1000", required: "", placeholder: "说明本次 Prompt、模型或评估集修订的原因。" } });
  form.append(el("label", { className: "classification-editor-field classification-editor-field-wide" }, [el("span", { text: "修订理由" }), reason]));
  form.append(el("div", { className: "configuration-form-actions" }, [
    el("button", { className: "button button-primary-inline", text: "保存新修订", attrs: { type: "submit" } }),
    el("span", { text: "追加记录 · 不改变当前发布版" }),
  ]));
  return form;
}

function classifierReleaseCaseEditor(testCase, index) {
  const fieldset = el("fieldset", { className: "classifier-release-case", attrs: { "data-classifier-release-case": "" } });
  fieldset.append(el("legend", { text: `样例 ${index + 1} · ${testCase.displayName}` }));
  fieldset.append(el("div", { className: "classifier-release-grid" }, [
    releaseInput("评估键", "caseKey", testCase.caseKey, "text", true),
    releaseInput("显示名称", "displayName", testCase.displayName, "text", true),
    releaseInput("文件名", "filename", testCase.filename, "text", true),
    releaseInput("预期标签代码", "expectedLabelCode", testCase.expectedLabelCode, "text", true),
    releaseInput("最低置信度", "minimumConfidence", String(testCase.minimumConfidence), "number", true),
  ]));
  const input = el("textarea", { attrs: { name: "inputText", rows: "5", minlength: "30", maxlength: "5000", required: "" } });
  input.value = testCase.inputText;
  fieldset.append(el("label", { className: "classification-editor-field classification-editor-field-wide" }, [el("span", { text: "纯虚构资料文本" }), input]));
  return fieldset;
}

function releaseInput(label, name, value, kind, required, options = []) {
  let control;
  if (kind === "select") {
    control = el("select", { attrs: { name, ...(required ? { required: "" } : {}) } }, options.map((option) => el("option", { text: option, attrs: { value: option } })));
    control.value = value;
  } else {
    control = el("input", { attrs: { name, type: kind, ...(required ? { required: "" } : {}),
      ...(kind === "number" ? { min: name === "maxOutputTokens" ? "256" : "0", max: name === "maxOutputTokens" ? "4000" : "1", step: name === "maxOutputTokens" ? "1" : "0.01" } : {}) } });
    control.value = value;
  }
  return el("label", { className: "classification-editor-field" }, [el("span", { text: label }), control]);
}

function classifierReleaseReasonForm(item, action, buttonText, placeholder) {
  const form = el("form", { className: "configuration-transition-form", attrs: {
    [`data-classifier-release-${action === "clone" ? "clone" : action.startsWith("evaluate-") ? "evaluate" : "transition"}`]: item.id,
    ...(action.startsWith("evaluate-") ? { "data-evaluation-kind": action.replace("evaluate-", "") } : {}),
  } });
  const reason = el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "", placeholder } });
  form.append(reason, el("button", { className: `button ${action === "publish" ? "button-primary-inline" : "button-secondary"}`, text: buttonText,
    attrs: { type: "submit", ...(action !== "clone" && !action.startsWith("evaluate-") ? { value: action } : {}) } }));
  return form;
}

function classifierReleaseEvaluationRow(item) {
  const result = item.result ?? {};
  return el("article", { className: "classification-evaluation" }, [
    el("div", { className: "classification-evaluation-heading" }, [
      el("div", {}, [el("strong", { text: item.evaluationKind === "provider" ? "真实模型虚构评估" : "兼容性检查" }),
        el("span", { className: `configuration-status status-${item.status}`, text: statusText(item.status) })]),
      el("time", { text: formatDateTime(item.completedAt ?? item.createdAt) }),
    ]),
    el("p", { text: `${item.runByName} · ${item.reason}` }),
    el("dl", { className: "classifier-release-facts" }, [
      evidence("定义哈希", item.definitionHash.slice(0, 16)),
      evidence("通过样例", result.totalCases === undefined ? "不适用" : `${result.passedCases ?? 0}/${result.totalCases}`),
      evidence("模型调用", classifierReleaseProviderCallCount(result)),
      evidence("解析模型", Array.isArray(result.resolvedModels) ? result.resolvedModels.join(", ") : "不适用"),
      evidence("Token", result.inputTokens === undefined ? "不适用" : `${result.inputTokens ?? "未知"} in · ${result.outputTokens ?? "未知"} out`),
      evidence("数据副作用", result.persistedDocuments === false && result.externalDelivery === "disabled" ? "无 Document · 无外发" : "待确认"),
      ...(item.status === "failed" && typeof result.errorCode === "string" ? [evidence("失败代码", result.errorCode)] : []),
    ]),
  ]);
}

function classifierReleaseProviderCallCount(result) {
  if (typeof result.providerCallCount === "number") return String(result.providerCallCount);
  if (result.providerCallCountKnown === false && typeof result.providerCallUpperBound === "number") {
    return `未知（上限 ${result.providerCallUpperBound}）`;
  }
  return result.providerCallCountKnown === false ? "未知" : "不适用";
}

async function handleClassifierReleaseSubmit(event) {
  event.preventDefault();
  if (state.classifierReleaseSubmitting) return;
  const form = event.target;
  const data = new FormData(form);
  try {
    if (form.dataset.classifierReleaseSave) {
      const item = state.classifierReleases.versions.find((version) => version.id === form.dataset.classifierReleaseSave);
      if (!item) throw new Error("分类器草稿已更新，请刷新。 ");
      const promptInstructions = String(data.get("promptInstructions") ?? "");
      const providerEvaluationCases = [...form.querySelectorAll("[data-classifier-release-case]")].map((row) => ({
        caseKey: row.querySelector('[name="caseKey"]').value.trim().toLowerCase(),
        displayName: row.querySelector('[name="displayName"]').value.trim(), synthetic: true,
        inputText: row.querySelector('[name="inputText"]').value.trim(),
        filename: row.querySelector('[name="filename"]').value.trim(), mimeType: "text/plain",
        expectedLabelCode: row.querySelector('[name="expectedLabelCode"]').value.trim().toLowerCase(),
        minimumConfidence: Number(row.querySelector('[name="minimumConfidence"]').value),
      }));
      const definition = { ...item.definition,
        model: String(data.get("model") ?? "").trim(), promptKey: String(data.get("promptKey") ?? "").trim().toLowerCase(),
        promptInstructions, promptInstructionHash: await sha256(promptInstructions),
        requestPolicy: { store: false, reasoningEffort: String(data.get("reasoningEffort")), maxOutputTokens: Number(data.get("maxOutputTokens")) },
        providerEvaluationCases,
      };
      return submitClassifierRelease(`/v1/ops/classifier-releases/${encodeURIComponent(item.id)}/revisions`, {
        definition, reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "分类器新修订已保存；当前发布版和历史 Case 都没有改变。");
    }
    const reason = String(data.get("reason") ?? "").trim();
    if (form.dataset.classifierReleaseClone) return submitClassifierRelease(
      `/v1/ops/classifier-releases/${encodeURIComponent(form.dataset.classifierReleaseClone)}/clone`,
      { reason, idempotencyKey: crypto.randomUUID() }, "下一版分类器草稿已建立；当前发布版继续运行。");
    if (form.dataset.classifierReleaseEvaluate) return submitClassifierRelease(
      `/v1/ops/classifier-releases/${encodeURIComponent(form.dataset.classifierReleaseEvaluate)}/evaluations`,
      { evaluationKind: form.dataset.evaluationKind, reason, idempotencyKey: crypto.randomUUID() },
      form.dataset.evaluationKind === "provider" ? "真实模型虚构评估已排队，Classification Worker 将异步执行。" : "兼容性检查已完成。无模型调用、无资料副作用。");
    if (form.dataset.classifierReleaseTransition) {
      const action = event.submitter?.value;
      return submitClassifierRelease(`/v1/ops/classifier-releases/${encodeURIComponent(form.dataset.classifierReleaseTransition)}/transitions`,
        { action, reason, idempotencyKey: crypto.randomUUID() },
        action === "publish" ? "分类器已发布；只影响未来创建的 Case。" : action === "submit_review" ? "分类器已进入发布复核。" : "分类器已退回草稿。");
    }
  } catch (error) { showNotice(error instanceof Error ? error.message : "分类器发布操作失败。", true); }
}

async function submitClassifierRelease(path, body, message) {
  state.classifierReleaseSubmitting = true;
  $("#classifier-releases-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(classifierReleaseError(result));
    showNotice(message, false);
    await loadClassifierReleases();
    state.view = "classifier-releases";
    switchView("classifier-releases");
    return result;
  } finally {
    state.classifierReleaseSubmitting = false;
    $("#classifier-releases-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function classifierReleaseError(result) {
  return ({
    invalid_request: "字段或理由不符合分类器发布规则。", classifier_release_definition_invalid: "完整运行定义结构或固定 DEV 安全边界无效。",
    prompt_hash_mismatch: "Prompt 内容与哈希不一致。", classification_profile_release_mismatch: "分类体系版本或哈希不是准确的已发布版本。",
    classifier_release_duplicate_case: "虚构模型评估键不能重复。", classifier_release_evaluation_case_invalid: "虚构模型评估例字段或预期标签无效。",
    classifier_release_version_not_found: "分类器发布版本不存在。", source_not_current_published: "只能从未来 Case 当前版建立下一版。",
    version_not_current: "该版本已有后续修订，请刷新。", passing_evaluations_required: "当前定义必须同时通过兼容性检查与真实模型虚构评估。",
    invalid_transition: "当前状态不允许这个操作。", idempotency_key_reused: "请求标识已被不同操作使用，请刷新后重试。",
  })[result.reason] ?? "分类器发布操作未完成，请刷新后重试。";
}

async function loadSourceConnectors() {
  if (!["manager","admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const response=await fetch("/v1/ops/source-connectors");
    if (response.status===403) { state.view="today"; switchView("today"); return; }
    if (!response.ok) throw new Error("无法读取资料来源目录。 ");
    state.sourceConnectors=await response.json(); renderSourceConnectors();
    $("#nav-source-connectors-count").value=String(new Set(state.sourceConnectors.versions.map((item)=>item.connectorId)).size);
  } catch(error) { showNotice(error instanceof Error?error.message:"资料来源读取失败。",true); }
}

function renderSourceConnectors() {
  const snapshot=state.sourceConnectors; if (!snapshot) return;
  $("#source-connectors-readonly").hidden=snapshot.canManage;
  $("#source-connector-create-section").hidden=!snapshot.canManage;
  replaceChildren($("#source-connector-version-list"),snapshot.versions.length
    ?snapshot.versions.map(sourceConnectorVersionRow)
    :[emptyState("还没有资料来源","管理员可以先登记一个只使用纯虚构样例的连接器草稿。")]);
  replaceChildren($("#source-connector-test-list"),snapshot.testRuns.length
    ?snapshot.testRuns.map(sourceConnectorTestRow)
    :[emptyState("还没有 Adapter 重放","离线重放不会解析凭证、连接外部服务或写入 Document。")]);
}

function sourceConnectorVersionRow(item) {
  const article=el("article",{className:"classification-version"});
  article.append(el("div",{className:"classification-version-heading"},[
    el("div",{},[
      el("div",{className:"configuration-version-line"},[
        el("strong",{text:`v${item.version} · rev ${item.revision}`}),
        el("span",{className:`configuration-status status-${item.status}`,text:statusText(item.status)}),
        ...(item.isActiveVersion?[el("span",{className:"configuration-status status-published",text:"当前可绑定"})]:[]),
        ...(item.hasPassingTest?[el("span",{className:"configuration-status status-published",text:"契约通过"})]:[]),
      ]), el("h3",{text:item.displayName}), el("p",{text:item.description}),
    ]),
    el("div",{className:"configuration-audit"},[
      el("span",{text:`${item.createdByName??"系统基线"} · ${formatDateTime(item.createdAt)}`}),
      el("code",{text:item.definitionHash.slice(0,12)}),
    ]),
  ]));
  const definition=item.definition;
  const enforcement=item.enforcementProfile??{};
  article.append(el("dl",{className:"classifier-release-facts"},[
    evidence("绑定键",item.connectorKey),evidence("类型 / 传输",`${sourceConnectorTypeText(definition.connectorType)} · ${sourceConnectorTransportText(definition.transport)}`),
    evidence("能力",definition.capabilities.join(" · ")),evidence("凭证",sourceConnectorCredentialText(definition.credentialReference)),
    evidence("每次文件上限",String(enforcement.maxFilesPerSubmission??definition.dataBoundary.maxFilesPerSubmission??100)),
    evidence("单文件上限",formatBytes(enforcement.maxFileBytes??definition.dataBoundary.maxFileBytes)),
    evidence("策略来源",enforcement.policySource==="legacy_safe_default"?"兼容安全默认":"Connector Definition"),
    evidence("安全边界","Synthetic only · runtime disabled"),evidence("Case Plan 引用",String(item.referencedByPlanCount)),
  ]));
  if (item.differencesFromActive.length) article.append(el("details",{className:"configuration-diff"},[
    el("summary",{text:`相对当前可绑定版有 ${item.differencesFromActive.length} 项差异`}),
    el("ul",{},item.differencesFromActive.slice(0,30).map((difference)=>el("li",{text:difference.path}))),
  ]));
  if (!state.sourceConnectors.canManage || !item.isLatestRevision || !item.isCurrentVersion) return article;
  if (item.status==="draft") {
    article.append(sourceConnectorEditor(item));
    article.append(sourceConnectorReasonForm(item,"test","运行离线 Adapter 重放","转换纯虚构样例并验证哈希与安全边界；不会联网。"));
    if (item.hasPassingTest) article.append(sourceConnectorReasonForm(item,"submit_review","送交复核","说明当前定义和测试证据为何足以进入复核。"));
  }
  if (item.status==="in_review") {
    article.append(sourceConnectorReasonForm(item,"approve","批准定义","确认定义、引用和安全边界已复核。"));
    article.append(sourceConnectorReasonForm(item,"return_to_draft","退回草稿","说明需要修订的字段。"));
  }
  if (item.status==="approved") {
    article.append(sourceConnectorReasonForm(item,"activate","治理启用","允许未来配置引用；runtime execution 仍固定关闭。"));
    article.append(sourceConnectorReasonForm(item,"revoke","撤销连接器","记录不可逆撤销的原因。"));
  }
  if (item.status==="active") {
    article.append(sourceConnectorReasonForm(item,"suspend","紧急暂停","立即停止未来配置继续选择该绑定。"));
    article.append(sourceConnectorReasonForm(item,"revoke","撤销连接器","记录不可逆撤销的原因。"));
  }
  if (item.status==="suspended") {
    article.append(sourceConnectorReasonForm(item,"reactivate","重新启用","说明复核通过且可以恢复未来配置引用。"));
    article.append(sourceConnectorReasonForm(item,"revoke","撤销连接器","记录不可逆撤销的原因。"));
  }
  return article;
}

function sourceConnectorEditor(item) {
  const d=item.definition; const form=el("form",{className:"source-connector-form source-connector-editor",attrs:{"data-source-connector-save":item.id}});
  form.append(el("div",{className:"classification-editor-heading"},[
    el("div",{},[el("h4",{text:"修订连接器定义"}),el("p",{text:"只保存 Secret Reference；安全边界固定，保存后旧测试证据自动失效。"})]),
  ]));
  const grid=el("div",{className:"source-connector-grid"});
  grid.append(sourceConnectorControl("类型","connectorType",d.connectorType,"select",["manual_upload","form","email","sharepoint","api","sftp","object_storage"]));
  grid.append(sourceConnectorControl("传输方式","transport",d.transport,"select",["operator","push","pull"]));
  grid.append(sourceConnectorControl("凭证提供方","credentialProvider",d.credentialReference.provider,"select",["none","railway","supabase","external_vault"]));
  grid.append(sourceConnectorControl("Secret Reference","credentialReference",d.credentialReference.reference??"","text"));
  grid.append(sourceConnectorControl("能力（逗号分隔）","capabilities",d.capabilities.join(","),"text",[],true));
  grid.append(sourceConnectorControl("每次最多文件","maxFilesPerSubmission",String(d.dataBoundary.maxFilesPerSubmission??item.enforcementProfile?.maxFilesPerSubmission??100),"number"));
  grid.append(sourceConnectorControl("允许 MIME（逗号分隔）","allowedMimeTypes",d.dataBoundary.allowedMimeTypes.join(","),"text",[],true));
  const fixture=d.testFixtures[0];
  grid.append(sourceConnectorControl("虚构样例键","fixtureKey",fixture.fixtureKey,"text"));
  grid.append(sourceConnectorControl("虚构文件名","fixtureFilename",fixture.filename,"text"));
  grid.append(sourceConnectorControl("虚构样例说明","fixtureSummary",fixture.payloadSummary,"textarea",[],true));
  grid.append(sourceConnectorControl("修订理由","reason","","textarea",[],true));
  form.append(grid,el("div",{className:"configuration-form-actions"},[
    el("button",{className:"button button-primary-inline",text:"保存新修订",attrs:{type:"submit"}}),el("span",{text:"追加记录 · 不覆盖历史"}),
  ]));
  return form;
}

function sourceConnectorControl(label,name,value,kind,options=[],wide=false) {
  let control;
  if (kind==="select") { control=el("select",{attrs:{name,required:""}},options.map((option)=>el("option",{text:sourceConnectorOptionText(option),attrs:{value:option}}))); control.value=value; }
  else if (kind==="textarea") { control=el("textarea",{attrs:{name,required:"",rows:"2",minlength:name==="reason"?"12":"3",maxlength:"1000"}}); control.value=value; }
  else { control=el("input",{attrs:{name,type:kind==="number"?"number":"text",value,...(kind==="number"?{min:"1",max:"100"}:{}),...(name!=="credentialReference"?{required:""}:{})}}); }
  return el("label",{className:wide?"source-connector-wide":""},[el("span",{text:label}),control]);
}

function sourceConnectorReasonForm(item,action,buttonText,placeholder) {
  const form=el("form",{className:"configuration-transition-form",attrs:{
    [action==="test"?"data-source-connector-test":"data-source-connector-transition"]:item.id,
  }});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder}}),
    el("button",{className:`button ${action==="activate"||action==="approve"?"button-primary-inline":"button-secondary"}`,text:buttonText,
      attrs:{type:"submit",...(action!=="test"?{value:action}:{})}}));
  return form;
}

function sourceConnectorTestRow(item) {
  const result=item.result??{};
  const adapterReplay=item.adapterContractVersion==="1.0";
  return el("article",{className:"classification-evaluation"},[
    el("div",{className:"classification-evaluation-heading"},[
      el("div",{},[el("strong",{text:adapterReplay?"离线 Adapter 重放":"历史定义契约测试"}),el("span",{className:`configuration-status status-${item.status}`,text:statusText(item.status)})]),
      el("time",{text:formatDateTime(item.createdAt)}),
    ]), el("p",{text:`${item.runByName??"系统基线"} · ${item.reason}`}),
    el("dl",{className:"classifier-release-facts"},[
      evidence("Adapter",result.adapterKey??"历史检查"),evidence("合同",adapterReplay?"v1.0":"历史"),
      evidence("定义哈希",item.definitionHash.slice(0,16)),evidence("重放哈希",item.replayHash?.slice(0,16)??"未生成"),
      evidence("通过样例",`${result.passedCount??result.fixtureCount??0}/${result.fixtureCount??0}`),
      evidence("外部调用",String(result.externalCallCount??0)),evidence("凭证解析",result.credentialResolution==="not_attempted"?"未尝试":"仅检查引用"),
      evidence("Document 写入",result.persistedDocuments===false?"0":"待确认"),evidence("运行边界",result.runtimeExecution==="disabled"?"disabled":"待确认"),
    ]),
  ]);
}

async function handleSourceConnectorSubmit(event) {
  event.preventDefault(); if (state.sourceConnectorSubmitting) return;
  const form=event.target; if (!form.reportValidity()) return; const data=new FormData(form);
  try {
    if (form.id==="source-connector-create-form") {
      const connectorKey=String(data.get("connectorKey")??"").trim().toLowerCase();
      const definition=sourceConnectorDefinitionFromForm(data,connectorKey);
      return submitSourceConnector("/v1/ops/source-connectors",{
        connectorKey,displayName:String(data.get("displayName")??"").trim(),description:String(data.get("description")??"").trim(),
        definition,reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"连接器草稿已登记；没有读取凭证、联网或接收资料。",()=>form.reset());
    }
    if (form.dataset.sourceConnectorSave) {
      const item=state.sourceConnectors.versions.find((version)=>version.id===form.dataset.sourceConnectorSave);
      if (!item) throw new Error("连接器草稿已更新，请刷新。 ");
      return submitSourceConnector(`/v1/ops/source-connectors/${encodeURIComponent(item.id)}/revisions`,{
        definition:sourceConnectorDefinitionFromForm(data,item.connectorKey,item.definition),reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"连接器新修订已保存；旧版本与测试历史均已保留。");
    }
    const reason=String(data.get("reason")??"").trim();
    if (form.dataset.sourceConnectorTest) return submitSourceConnector(`/v1/ops/source-connectors/${encodeURIComponent(form.dataset.sourceConnectorTest)}/tests`,
      {reason,idempotencyKey:crypto.randomUUID()},"离线 Adapter 重放已通过：Canonical 转换与幂等哈希稳定，外部调用 0、凭证解析 0、Document 写入 0。");
    if (form.dataset.sourceConnectorTransition) {
      const action=event.submitter?.value;
      const messages={submit_review:"连接器已送交复核。",return_to_draft:"连接器已退回草稿。",approve:"连接器定义已批准。",
        activate:"连接器已治理启用；runtime execution 仍为 disabled。",suspend:"连接器已紧急暂停。",reactivate:"连接器已重新治理启用。",revoke:"连接器已撤销并保留全部历史。"};
      return submitSourceConnector(`/v1/ops/source-connectors/${encodeURIComponent(form.dataset.sourceConnectorTransition)}/transitions`,
        {action,reason,idempotencyKey:crypto.randomUUID()},messages[action]??"连接器状态已更新。");
    }
  } catch(error) { showNotice(error instanceof Error?error.message:"资料来源操作失败。",true); }
}

function sourceConnectorDefinitionFromForm(data,connectorKey,existing=null) {
  const provider=String(data.get("credentialProvider")??"none");
  const allowedMimeTypes=csvValues(data.get("allowedMimeTypes"));
  const fixtureFilename=String(data.get("fixtureFilename")??"synthetic-source-document.pdf").trim();
  return {schemaVersion:"1.0",environment:"DEV",connectorKey,
    connectorType:String(data.get("connectorType")??"manual_upload"),transport:String(data.get("transport")??"operator"),
    capabilities:csvValues(data.get("capabilities")),
    credentialReference:{mode:provider==="none"?"none":"secret_reference",provider,reference:provider==="none"?null:String(data.get("credentialReference")??"").trim()},
    dataBoundary:{syntheticOnly:true,externalDelivery:"disabled",
      maxFilesPerSubmission:Number(data.get("maxFilesPerSubmission")??existing?.dataBoundary?.maxFilesPerSubmission??20),
      maxFileBytes:existing?.dataBoundary?.maxFileBytes??26_214_400,allowedMimeTypes},
    activationPolicy:{explicitApprovalRequired:true,emergencySuspendEnabled:true,runtimeExecution:"disabled"},
    testFixtures:[{fixtureKey:String(data.get("fixtureKey")??"baseline.synthetic").trim().toLowerCase(),displayName:"纯虚构资料入口样例",synthetic:true,
      filename:fixtureFilename,mimeType:allowedMimeTypes[0]??"application/pdf",payloadSummary:String(data.get("fixtureSummary")??"").trim()}],
  };
}

function csvValues(value) { return [...new Set(String(value??"").split(",").map((item)=>item.trim()).filter(Boolean))]; }
async function submitSourceConnector(path,body,message,afterSuccess) {
  state.sourceConnectorSubmitting=true; $("#source-connectors-view").querySelectorAll("button,input,select,textarea").forEach((control)=>{control.disabled=true;});
  try {
    const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-dop-csrf":state.overview.csrfToken},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({})); if (!response.ok) throw new Error(sourceConnectorError(result));
    afterSuccess?.(); showNotice(message,false); await loadSourceConnectors(); state.view="source-connectors"; switchView("source-connectors"); return result;
  } finally { state.sourceConnectorSubmitting=false; $("#source-connectors-view").querySelectorAll("button,input,select,textarea").forEach((control)=>{control.disabled=false;}); }
}

function sourceConnectorError(result) {
  return ({invalid_request:"字段或理由不符合连接器规则。",source_connector_definition_invalid:"连接器定义结构无效。",
    source_connector_transport_invalid:"人工上传必须使用人工传输；外部连接器必须使用推送或拉取。",
    source_connector_capabilities_invalid:"能力值无效或重复。",source_connector_file_count_policy_required:"必须声明每次最多文件数。",
    source_connector_file_count_policy_invalid:"每次最多文件数必须为 1–100。",source_connector_documents_capability_required:"所有资料连接器都必须具备 documents 能力。",
    source_connector_webhook_capability_required:"表单入口必须具备 webhook 能力。",source_connector_webhook_capability_invalid:"webhook 能力只能用于 push 传输。",
    source_connector_attachment_capability_required:"邮箱入口必须具备 attachments 能力。",source_connector_polling_capability_required:"pull 传输必须具备 polling 能力。",
    source_connector_polling_capability_invalid:"只有 pull 传输可以声明 polling 能力。",source_connector_credential_reference_invalid:"Secret Reference 格式无效；请勿填写密钥值。",
    source_connector_credential_reference_required:"外部连接器必须只填写受支持的 Secret Reference。",source_connector_safety_boundary_invalid:"Synthetic、外发或运行禁用边界被改变。",
    source_connector_mime_type_invalid:"允许的 MIME 格式无效。",source_connector_fixture_invalid:"纯虚构测试样例字段无效。",
    source_connector_duplicate_fixture:"虚构样例键不能重复。",connector_key_exists:"该连接器键已经登记。",connector_key_immutable:"连接器键不可修改。",
    source_connector_version_not_found:"连接器版本不存在。",version_not_current:"该版本已有后续修订，请刷新。",version_not_current_draft:"只能修改当前草稿。",
    adapter_documents_capability_required:"离线重放要求 documents 能力。",adapter_webhook_capability_required:"表单 Adapter 重放要求 webhook 能力。",
    adapter_attachments_capability_required:"邮箱 Adapter 重放要求 attachments 能力。",adapter_polling_capability_required:"拉取型 Adapter 重放要求 polling 能力。",
    adapter_fixture_mime_not_allowed:"虚构样例 MIME 不在允许清单。",adapter_fixture_size_exceeded:"虚构样例超过文件大小边界。",
    adapter_fixture_not_synthetic:"Adapter 重放只接受纯虚构样例。",adapter_definition_boundary_invalid:"Adapter 定义的安全边界无效。",
    adapter_replay_evidence_invalid:"离线重放证据未通过数据库校验。",adapter_replay_fixture_invalid:"离线重放样例证据无效。",
    passing_test_required:"当前定义必须先通过离线 Adapter 重放。",invalid_transition:"当前状态不允许这个操作。",idempotency_key_reused:"请求标识已被不同操作使用，请刷新后重试。"})[result.reason]
    ?? (result.error==="admin_required"?"只有管理员可以管理资料来源。":"资料来源操作未完成，请刷新后重试。");
}
function sourceConnectorTypeText(value) { return ({manual_upload:"人工上传",form:"表单",email:"邮箱",sharepoint:"SharePoint",api:"API",sftp:"SFTP",object_storage:"对象存储"})[value]??value; }
function sourceConnectorTransportText(value) { return ({operator:"人工",push:"推送",pull:"拉取"})[value]??value; }
function sourceConnectorOptionText(value) { return sourceConnectorTypeText(value)==value?sourceConnectorTransportText(value)==value?({none:"无需凭证",railway:"Railway Secret",supabase:"Supabase Secret",external_vault:"外部 Vault"})[value]??value:sourceConnectorTransportText(value):sourceConnectorTypeText(value); }
function sourceConnectorCredentialText(value) { return value.mode==="none"?"无需凭证":`${sourceConnectorOptionText(value.provider)} · ${value.reference}`; }

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function loadCasePlans() {
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const response = await fetch("/v1/ops/case-plans");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (response.status === 403) throw new Error("当前身份不能查看 Case 计划。");
    if (!response.ok) throw new Error("暂时无法读取 Case 计划。");
    state.casePlans = await response.json();
    $("#nav-case-plans-count").value = String(state.casePlans.versions.filter((item) => item.isCurrentPublished).length);
    renderCasePlans();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Case 计划加载失败。", true);
  }
}

function renderCasePlans() {
  const snapshot = state.casePlans;
  if (!snapshot) return;
  $("#case-plan-readonly").hidden = snapshot.canManage;
  $("#case-plan-create-section").hidden = !snapshot.canManage;
  const subjectSelect = $("#case-plan-subject");
  replaceChildren(subjectSelect, snapshot.eligibleSubjects.map((item) => el("option", {
    text: `${item.subjectName} · 当前配置 v${item.configurationReleaseNumber}`,
    attrs: { value: item.id },
  })));
  replaceChildren($("#case-plan-source-connector"), snapshot.eligibleSourceConnectors.map(casePlanSourceConnectorOption));
  const anchor = $("#case-plan-anchor");
  if (!anchor.value) {
    const current = new Date(state.overview?.generatedAt ?? Date.now());
    anchor.value = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  }
  const groups = new Map();
  for (const version of snapshot.versions) {
    if (!groups.has(version.planId)) groups.set(version.planId, []);
    groups.get(version.planId).push(version);
  }
  replaceChildren($("#case-plan-version-list"), groups.size
    ? [...groups.values()].map(casePlanSection)
    : [emptyState("还没有 Case 计划", snapshot.canManage
      ? "选择一个已有发布配置的工作对象，建立第一份计划草稿。"
      : "管理员发布第一份计划后，主管可以在这里预览并批准。")]);
  replaceChildren($("#case-plan-preview-list"), snapshot.previews.length
    ? snapshot.previews.map(casePlanPreviewRow)
    : [emptyState("还没有待批准预览", "从当前发布的计划生成固定预览；预览本身不会创建 Case。")]);
}

function casePlanSection(versions) {
  versions.sort((left, right) => right.version - left.version || right.revision - left.revision);
  const latestByVersion = [];
  const seen = new Set();
  for (const item of versions) {
    if (seen.has(item.version)) continue;
    seen.add(item.version);
    latestByVersion.push(item);
  }
  const current = versions.find((item) => item.isCurrentPublished) ?? latestByVersion[0];
  const section = el("section", { className: "case-plan" });
  section.append(el("div", { className: "case-plan-heading" }, [
    el("div", {}, [el("span", { text: `${current.subjectKey} · ${current.planKey}` }), el("h3", { text: current.planName }), el("p", { text: current.subjectName })]),
    el("div", { className: "case-plan-current" }, [el("span", { text: "当前发布" }), el("strong", { text: current.isCurrentPublished ? `版本 ${current.version}` : "待建立" })]),
  ]));
  section.append(el("div", { className: "case-plan-version-stack" }, latestByVersion.map(casePlanVersionRow)));
  return section;
}

function casePlanVersionRow(item) {
  const definition = item.definition;
  const article = el("article", { className: "case-plan-version" });
  const status = item.status === "published" ? item.isCurrentPublished ? "当前发布" : "历史发布" : statusText(item.status);
  article.append(el("div", { className: "case-plan-version-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `版本 ${item.version} · 修订 ${item.revision}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: status }),
      ]),
      el("p", { text: item.reason }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: `${item.createdByName} · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.definitionHash.slice(0, 12) }),
    ]),
  ]));
  article.append(el("dl", { className: "case-plan-facts" }, [
    evidence("周期", `${definition.cadence.intervalMonths} 个月 · 从 ${definition.cadence.anchorDate} 起`),
    evidence("截止", `${definition.dueRule.basis === "period_end" ? "期间结束" : "期间开始"}${signedDays(definition.dueRule.offsetDays)} · ${definition.dueRule.localTime}`),
    evidence("资料来源", `${sourceTypeText(definition.sourceBinding.type)} · ${definition.sourceBinding.bindingKey}`),
    evidence("固定连接器", `${item.sourceConnectorDisplayName} · v${item.sourceConnectorVersion}/rev${item.sourceConnectorRevision} · ${item.sourceConnectorDefinitionHash.slice(0, 12)}`),
    evidence("安全边界", item.validationErrors.length ? item.validationErrors.join("；") : "已通过 · 外部发送关闭"),
  ]));
  if (item.status === "draft" && state.casePlans.canManage) article.append(casePlanDraftForm(item));
  if (item.status === "in_review" && state.casePlans.canManage) article.append(casePlanTransitionForm(item));
  if (item.status === "published" && state.casePlans.canManage) article.append(casePlanCloneForm(item));
  if (item.status === "published" && item.isCurrentPublished && state.casePlans.canPreview) article.append(casePlanPreviewForm(item));
  return article;
}

function casePlanDraftForm(item) {
  const form = el("form", { className: "case-plan-form case-plan-edit-form", attrs: { "data-case-plan-save": item.id } });
  appendCasePlanDefinitionFields(form, item.definition, `case-plan-edit-${item.id}`);
  form.append(casePlanField("保存理由", `case-plan-edit-reason-${item.id}`, el("textarea", {
    attrs: { id: `case-plan-edit-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明本次周期、截止或资料来源调整。" },
  }), "case-plan-field-wide"));
  form.append(el("div", { className: "case-plan-actions" }, [
    el("button", { className: "button button-secondary", text: "保存新修订", attrs: { type: "submit", value: "save" } }),
    el("button", { className: "button button-primary-inline", text: "保存并送审", attrs: { type: "submit", value: "save_and_review" } }),
  ]));
  return form;
}

function appendCasePlanDefinitionFields(form, definition, prefix) {
  form.append(casePlanField("每隔几个月", `${prefix}-interval`, el("input", { attrs: { id: `${prefix}-interval`, name: "intervalMonths", type: "number", required: "", min: "1", max: "12", value: String(definition.cadence.intervalMonths) } })));
  form.append(casePlanField("首个期间开始", `${prefix}-anchor`, el("input", { attrs: { id: `${prefix}-anchor`, name: "anchorDate", type: "date", required: "", value: definition.cadence.anchorDate } })));
  form.append(casePlanField("时区", `${prefix}-timezone`, el("input", { attrs: { id: `${prefix}-timezone`, name: "timezone", required: "", maxlength: "80", value: definition.timezone } })));
  const basis = el("select", { attrs: { id: `${prefix}-basis`, name: "dueBasis" } });
  for (const [value, label] of [["period_end", "期间结束"], ["period_start", "期间开始"]]) {
    const option = el("option", { text: label, attrs: { value } });
    if (value === definition.dueRule.basis) option.selected = true;
    basis.append(option);
  }
  form.append(casePlanField("截止日基准", `${prefix}-basis`, basis));
  form.append(casePlanField("基准后天数", `${prefix}-offset`, el("input", { attrs: { id: `${prefix}-offset`, name: "offsetDays", type: "number", required: "", min: "-31", max: "365", value: String(definition.dueRule.offsetDays) } })));
  form.append(casePlanField("本地截止时间", `${prefix}-time`, el("input", { attrs: { id: `${prefix}-time`, name: "localTime", type: "time", required: "", value: definition.dueRule.localTime } })));
  form.append(casePlanField("默认预览数量", `${prefix}-count`, el("input", { attrs: { id: `${prefix}-count`, name: "defaultPreviewCount", type: "number", required: "", min: "1", max: "12", value: String(definition.defaultPreviewCount) } })));
  const sourceConnector = el("select", { attrs: { id: `${prefix}-source-connector`, name: "bindingKey", required: "" } },
    state.casePlans.eligibleSourceConnectors.map((item) => casePlanSourceConnectorOption(item, definition.sourceBinding.bindingKey)));
  if (!state.casePlans.eligibleSourceConnectors.some((item) => item.connectorKey === definition.sourceBinding.bindingKey)) {
    sourceConnector.prepend(el("option", { text: `已停用 · ${definition.sourceBinding.bindingKey}`, attrs: { value: "", disabled: "", selected: "" } }));
  }
  form.append(casePlanField("已启用资料来源版本", `${prefix}-source-connector`, sourceConnector, "case-plan-field-wide"));
  form.append(casePlanField("来源元数据 JSON", `${prefix}-metadata`, el("textarea", {
    text: JSON.stringify(definition.sourceBinding.metadata, null, 2), attrs: { id: `${prefix}-metadata`, name: "sourceMetadata", required: "", rows: "4", spellcheck: "false" },
  }), "case-plan-field-wide"));
}

function casePlanTransitionForm(item) {
  const form = el("form", { className: "case-plan-action-form", attrs: { "data-case-plan-transition": item.id } });
  form.append(casePlanField("发布或退回理由", `case-plan-transition-${item.id}`, el("input", { attrs: { id: `case-plan-transition-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "记录复核结论与发布依据" } }), "case-plan-field-wide"));
  form.append(el("div", { className: "case-plan-actions" }, [
    el("button", { className: "button button-quiet", text: "退回草稿", attrs: { type: "submit", name: "action", value: "return_to_draft" } }),
    el("button", { className: "button button-primary-inline", text: "发布计划", attrs: { type: "submit", name: "action", value: "publish" } }),
  ]));
  return form;
}

function casePlanCloneForm(item) {
  const form = el("form", { className: "case-plan-action-form", attrs: { "data-case-plan-clone": item.id } });
  form.append(casePlanField(item.isCurrentPublished ? "下一版理由" : "回滚理由", `case-plan-clone-${item.id}`, el("input", { attrs: { id: `case-plan-clone-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "说明为什么要建立新的计划草稿" } }), "case-plan-field-wide"));
  form.append(el("div", { className: "case-plan-actions" }, [el("button", { className: "button button-secondary", text: item.isCurrentPublished ? "创建下一版草稿" : "以此版本建立回滚草稿", attrs: { type: "submit" } })]));
  return form;
}

function casePlanPreviewForm(item) {
  const details = el("details", { className: "case-plan-preview-creator" });
  details.append(el("summary", { text: "预览下一批 Case" }));
  const form = el("form", { className: "case-plan-action-form", attrs: { "data-case-plan-preview": item.id } });
  form.append(casePlanField("候选数量", `case-plan-preview-count-${item.id}`, el("input", { attrs: { id: `case-plan-preview-count-${item.id}`, name: "candidateCount", type: "number", required: "", min: "1", max: "12", value: String(item.definition.defaultPreviewCount) } })));
  form.append(casePlanField("从该日之后开始（可选）", `case-plan-preview-start-${item.id}`, el("input", { attrs: { id: `case-plan-preview-start-${item.id}`, name: "startOn", type: "date" } })));
  form.append(casePlanField("预览理由", `case-plan-preview-reason-${item.id}`, el("textarea", { attrs: { id: `case-plan-preview-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "说明这批未来期间为何需要进入人工批准。" } }), "case-plan-field-wide"));
  form.append(el("div", { className: "case-plan-actions" }, [
    el("button", { className: "button button-primary-inline", text: "生成固定预览", attrs: { type: "submit" } }),
    el("span", { text: "此步骤不创建 Case。" }),
  ]));
  details.append(form);
  return details;
}

function casePlanPreviewRow(item) {
  const article = el("article", { className: "case-plan-preview" });
  article.append(el("div", { className: "case-plan-preview-heading" }, [
    el("div", {}, [el("strong", { text: `${item.subjectName} · ${item.planName}` }), el("span", { text: `计划 v${item.planVersion} · 配置 v${item.configurationReleaseNumber} · ${item.candidates.length} 个候选` })]),
    statusLabel(item.approval ? "approved" : "previewed"),
  ]));
  article.append(el("div", { className: "case-plan-candidates" }, item.candidates.map(casePlanCandidateRow)));
  article.append(el("dl", { className: "case-plan-facts" }, [
    evidence("固定资料来源", `${item.sourceConnectorDisplayName} · ${item.sourceConnectorKey}`),
    evidence("固定版本", `v${item.sourceConnectorVersion}/rev${item.sourceConnectorRevision} · ${item.sourceConnectorDefinitionHash.slice(0, 12)}`),
  ]));
  article.append(el("div", { className: "case-plan-preview-audit" }, [
    el("span", { text: `${item.createdByName} 预览 · ${formatDateTime(item.createdAt)}` }),
    el("code", { text: item.candidatesHash.slice(0, 12) }),
  ]));
  if (item.approval) {
    article.append(el("div", { className: "case-plan-approved" }, [
      el("strong", { text: `已批准并创建 ${item.approval.generatedCaseIds.length} 个 Case` }),
      el("span", { text: `${item.approval.approvedByName} · ${formatDateTime(item.approval.approvedAt)} · ${item.approval.reason}` }),
    ]));
  } else if (state.casePlans.canPreview) {
    const form = el("form", { className: "case-plan-approval-form", attrs: { "data-case-plan-approve": item.id } });
    form.append(casePlanField("批准理由", `case-plan-approve-${item.id}`, el("textarea", { attrs: { id: `case-plan-approve-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2", placeholder: "确认期间、截止时间、配置版本和资料来源均正确。" } }), "case-plan-field-wide"));
    form.append(el("div", { className: "case-plan-actions" }, [
      el("button", { className: "button button-primary-inline", text: `批准并创建 ${item.candidates.length} 个 Case`, attrs: { type: "submit" } }),
      el("span", { text: "整批原子创建；如有漂移则全部不创建。" }),
    ]));
    article.append(form);
  }
  return article;
}

function casePlanCandidateRow(item) {
  return el("div", { className: "case-plan-candidate" }, [
    el("div", {}, [el("strong", { text: item.periodKey }), el("span", { text: `${item.periodStart} – ${item.periodEnd}` })]),
    el("div", {}, [el("span", { text: "截止" }), el("strong", { text: formatDateTime(item.dueAt) })]),
    el("div", {}, [el("span", { text: "资料来源" }), el("strong", { text: `${sourceTypeText(item.sourceBinding.type)} · ${item.sourceBinding.bindingKey}` })]),
    el("span", { className: "configuration-status status-published", text: "外发关闭" }),
  ]);
}

function casePlanField(label, id, control, className = "") {
  return el("div", { className: `case-plan-field ${className}`.trim() }, [el("label", { text: label, attrs: { for: id } }), control]);
}

async function handleCasePlanSubmit(event) {
  event.preventDefault();
  const form = event.target.closest("form");
  if (!form || state.casePlanSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  const reason = String(data.get("reason") ?? "").trim();
  try {
    if (form.id === "case-plan-create-form") {
      const result = await submitCasePlan("/v1/ops/case-plans", {
        subjectId: String(data.get("subjectId") ?? ""), planKey: String(data.get("planKey") ?? "").trim(),
        displayName: String(data.get("displayName") ?? "").trim(), definition: casePlanDefinitionFromForm(data),
        reason, idempotencyKey: crypto.randomUUID(),
      }, "计划草稿已创建；尚未创建任何 Case。", false);
      if (result) form.reset();
      return;
    }
    if (form.dataset.casePlanSave) {
      const saved = await submitCasePlan(`/v1/ops/case-plans/${encodeURIComponent(form.dataset.casePlanSave)}/revisions`, {
        definition: casePlanDefinitionFromForm(data), reason, idempotencyKey: crypto.randomUUID(),
      }, "计划修订已保存。", false);
      if (saved && event.submitter?.value === "save_and_review") {
        await submitCasePlan(`/v1/ops/case-plans/${encodeURIComponent(saved.versionId)}/transitions`, {
          action: "submit_review", reason, idempotencyKey: crypto.randomUUID(),
        }, "计划已保存并进入发布复核。");
      } else if (saved) await loadCasePlans();
      return;
    }
    if (form.dataset.casePlanTransition) {
      return submitCasePlan(`/v1/ops/case-plans/${encodeURIComponent(form.dataset.casePlanTransition)}/transitions`, {
        action: event.submitter?.value, reason, idempotencyKey: crypto.randomUUID(),
      }, event.submitter?.value === "publish" ? "计划已发布；现在可以生成固定预览。" : "计划已退回草稿。");
    }
    if (form.dataset.casePlanClone) {
      return submitCasePlan(`/v1/ops/case-plans/${encodeURIComponent(form.dataset.casePlanClone)}/clone`, {
        reason, idempotencyKey: crypto.randomUUID(),
      }, "新的计划草稿已创建；历史版本保持不变。");
    }
    if (form.dataset.casePlanPreview) {
      return submitCasePlan(`/v1/ops/case-plans/${encodeURIComponent(form.dataset.casePlanPreview)}/previews`, {
        candidateCount: Number(data.get("candidateCount")), startOn: String(data.get("startOn") ?? "") || null,
        reason, idempotencyKey: crypto.randomUUID(),
      }, "固定预览已生成；尚未创建 Case。");
    }
    if (form.dataset.casePlanApprove) {
      return submitCasePlan(`/v1/ops/case-plan-previews/${encodeURIComponent(form.dataset.casePlanApprove)}/approve`, {
        reason, idempotencyKey: crypto.randomUUID(),
      }, "预览已批准，Case 已按固定版本原子创建。", true);
    }
  } catch {
    showNotice("计划字段或来源元数据 JSON 无效，请检查后重试。", true);
  }
}

function casePlanDefinitionFromForm(data) {
  const connector = state.casePlans?.eligibleSourceConnectors.find((item) => item.connectorKey === String(data.get("bindingKey") ?? ""));
  if (!connector) throw new Error("source_connector_not_active");
  return {
    cadence: { mode: "calendar_months", intervalMonths: Number(data.get("intervalMonths")), anchorDate: String(data.get("anchorDate") ?? "") },
    timezone: String(data.get("timezone") ?? "").trim(),
    dueRule: { basis: String(data.get("dueBasis") ?? "period_end"), offsetDays: Number(data.get("offsetDays")), localTime: String(data.get("localTime") ?? "") },
    defaultPreviewCount: Number(data.get("defaultPreviewCount")),
    sourceBinding: { type: connector.sourceType, bindingKey: connector.connectorKey, metadata: JSON.parse(String(data.get("sourceMetadata") ?? "{}")) },
    externalDelivery: "disabled",
  };
}

async function submitCasePlan(path, body, successMessage, refreshOverview = false) {
  if (!state.overview?.csrfToken) { showNotice("会话安全信息缺失，请刷新后重试。", true); return null; }
  state.casePlanSubmitting = true;
  $("#case-plans-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  hideNotice();
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(casePlanError(result));
    if (refreshOverview) await loadOverview(false);
    await loadCasePlans();
    state.view = "case-plans";
    switchView("case-plans");
    showNotice(result.outcome === "duplicate" ? "该计划操作此前已经成功记录。" : successMessage, false);
    return result;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Case 计划操作没有保存。", true);
    return null;
  } finally {
    state.casePlanSubmitting = false;
    $("#case-plans-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function casePlanError(result) {
  return ({ definition_shape_invalid: "计划结构不完整。", definition_number_invalid: "周期、截止偏移或预览数量无效。",
    definition_schedule_invalid: "期间算法、截止时间或时区无效。", definition_source_invalid: "资料来源绑定无效；外部发送必须保持关闭。",
    definition_anchor_invalid: "首个期间开始必须是有效月份的第一天。", subject_not_found: "工作对象不存在或不是有效状态。",
    published_configuration_required: "该对象需要先发布工作配置。", plan_key_exists: "计划键已经存在，请使用新的唯一键。",
    version_not_current: "这个计划版本已经有更新修订，请刷新。", version_not_current_draft: "该草稿已更新或不再可编辑。",
    transition_not_allowed: "当前计划状态不能执行这个动作。", newer_version_already_published: "已有更新的计划发布版。",
    open_version_exists: "该计划已有未完成的草稿或待复核版本。", plan_not_active: "该计划不是有效状态。",
    plan_version_not_current_published: "只能从当前发布的计划生成预览。", preview_horizon_unavailable: "无法在安全范围内计算足够的未来期间。",
    preview_already_approved: "这个预览已经批准，不能重复创建 Case。", preview_integrity_failed: "预览完整性校验失败，请重新生成。",
    preview_stale_plan: "计划版本已变化，请重新生成预览。", preview_stale_configuration: "客户配置已变化，请重新生成预览。",
    preview_stale_case: "候选期间已存在 Case 或安全边界已变化，请重新生成预览。", subject_not_active: "工作对象不是有效状态。",
    published_configuration_incomplete: "当前发布配置缺少固定版本。", published_prompt_not_found: "当前没有可用的分类 Prompt。",
    source_connector_not_active: "资料来源已暂停、撤销或版本已漂移；请选择当前已启用版本并重新保存。",
    source_connector_version_mismatch: "资料来源版本已变化，请刷新后重新选择。",
    idempotency_key_reused: "操作编号已用于其他计划操作，请刷新。", invalid_request: "请检查字段并填写至少 12 个字符的理由。" })[result.reason]
    ?? (result.error === "admin_required" ? "只有管理员可以修改或发布计划。"
      : result.error === "manager_required" ? "只有主管或管理员可以预览和批准。" : "Case 计划操作没有保存。");
}

function signedDays(value) { return value === 0 ? "当天" : value > 0 ? `后 ${value} 天` : `前 ${Math.abs(value)} 天`; }
function sourceTypeText(value) { return ({ manual_upload: "受控人工上传", form_connector: "表单连接器", email: "邮箱", sharepoint: "SharePoint", api: "API", sftp: "SFTP", object_storage: "对象存储" })[value] ?? value; }
function casePlanSourceConnectorOption(item, selectedKey = null) {
  return el("option", {
    text: `${item.displayName} · ${sourceTypeText(item.sourceType)} · v${item.version}/rev${item.revision} · ${item.definitionHash.slice(0, 12)}`,
    attrs: { value: item.connectorKey, ...(selectedKey === item.connectorKey ? { selected: "" } : {}) },
  });
}

async function loadReleaseReadiness() {
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const [response,blueprintResponse] = await Promise.all([fetch("/v1/ops/release-readiness"),fetch("/v1/ops/uat-blueprints")]);
    if (response.status === 403 || blueprintResponse.status === 403) { state.view = "today"; switchView("today"); return; }
    if (!response.ok || !blueprintResponse.ok) throw new Error("无法读取发布准备与 UAT 蓝图登记簿。 ");
    [state.releaseReadiness,state.uatBlueprints] = await Promise.all([response.json(),blueprintResponse.json()]);
    renderReleaseReadiness();
    $("#nav-release-readiness-count").value = String(state.releaseReadiness.manifests.filter((item) => ["draft", "in_review"].includes(item.status)).length);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "发布准备读取失败。", true);
  }
}

function renderReleaseReadiness() {
  const snapshot = state.releaseReadiness; if (!snapshot) return;
  $("#release-readiness-readonly").hidden = snapshot.canManage;
  $("#release-manifest-create-section").hidden = !snapshot.canManage;
  replaceChildren($("#release-manifest-list"), snapshot.manifests.length
    ? snapshot.manifests.map(releaseManifestRow)
    : [emptyState("还没有发布 Manifest", "管理员可以冻结第一个 DEV→UAT 候选；这不会创建目标环境。")]);
  renderUatBlueprints();
}

function renderUatBlueprints() {
  const snapshot=state.uatBlueprints; if (!snapshot) return;
  const hasCurrentAuthorization=Boolean(snapshot.currentAuthorization);
  $("#release-manifest-create-section").hidden=!state.releaseReadiness?.canManage||hasCurrentAuthorization;
  $("#uat-blueprint-form").hidden=!snapshot.canManage||hasCurrentAuthorization;
  $("#uat-blueprint-readonly").hidden=snapshot.canManage&&!hasCurrentAuthorization;
  if (hasCurrentAuthorization) $("#uat-blueprint-readonly").textContent="M39 当前授权链已由受控编译操作冻结；此页只读展示，M40 创建仍需新的明确批准。";
  renderUatCurrentAuthorization(snapshot.currentAuthorization);
  const select=$("#uat-release-manifest");
  const ownerDisplay=$("#uat-runtime-owner-display");
  if (ownerDisplay) ownerDisplay.value=state.overview?.operator?.displayName??"当前管理员";
  const selected=select.value;
  replaceChildren(select,[el("option",{text:"暂不绑定（dry-run 将阻断）",attrs:{value:""}}),
    ...snapshot.releaseManifests.map((item)=>el("option",{text:`${item.manifestKey} · v${item.version} · ${statusText(item.status)}`,
      attrs:{value:item.id,...(item.id===selected?{selected:""}:{})}}))]);
  replaceChildren($("#uat-blueprint-list"),snapshot.blueprints.length?snapshot.blueprints.map(uatBlueprintRow):[
    emptyState("还没有 UAT 蓝图","管理员可以先保存一份带待审批项的蓝图；dry-run 会把这些项列为阻断。")]);
  replaceChildren($("#uat-provisioning-package-list"),snapshot.provisioningPackages?.length
    ? snapshot.provisioningPackages.map(uatProvisioningPackageRow)
    : [emptyState("还没有 Provisioning Package","蓝图 dry-run 通过后，管理员可以编译一份不可执行的部署包。")]);
  replaceChildren($("#uat-activation-approval-list"),snapshot.activationApprovalPacks?.length
    ? snapshot.activationApprovalPacks.map(uatActivationApprovalPackRow)
    : [emptyState("还没有激活审批包","部署合同验证通过后，管理员可以编译一份仍为 NO-GO 的审批证据清单。")]);
  replaceChildren($("#uat-final-authorization-list"),snapshot.finalAuthorizationRequests?.length
    ? snapshot.finalAuthorizationRequests.map(uatFinalAuthorizationRequestRow)
    : [emptyState("还没有最终授权申请草稿","激活审批包完成一次缺口评估后，管理员可以冻结不可提交、不可执行的申请材料。")]);
}

function renderUatCurrentAuthorization(authorization) {
  const section=$("#uat-current-authorization"),content=$("#uat-current-authorization-content");
  section.hidden=!authorization;
  if (!authorization) return;
  const policy=authorization.currentPolicy,cost=authorization.costPlan??{},effects=authorization.actualEffects??{};
  const currentRequest=state.uatBlueprints?.finalAuthorizationRequests?.find((item)=>item.definition?.schemaVersion==="2.0"&&item.status==="draft");
  const blockers=currentRequest?.latestEvaluation?.blockerCount??2;
  replaceChildren(content,[
    el("dl",{className:"uat-authorization-state"},[
      evidence("月度绝对上限",`$${policy.monthlyBudgetLimitUsd}`),evidence("预计月费",`$${cost.estimatedMonthlyCostUsd??33}`),
      evidence("资料边界",policy.realDataApproved?"真实资料已批准":"仅纯虚构"),
      el("div",{className:"is-blocked"},[el("dt",{text:"资源创建授权"}),el("dd",{text:policy.resourceCreationAuthorized?"已授权":"未授权"})]),
      evidence("持久数据区域",policy.dataRegion),evidence("无状态计算区域",policy.computeRegion),
      evidence("保留期限",`${policy.retentionDays} 天`),evidence("剩余门槛",`${blockers} 项`),
    ]),
    el("div",{className:"uat-authorization-detail"},[
      el("p",{text:`M39 已批准预算但没有创建资源。实际效果：环境 ${effects.environmentsCreated??0}、服务 ${effects.servicesCreated??0}、数据库 ${effects.databasesCreated??0}、Secret 值解析 ${effects.secretValuesResolved??0}、外部调用 ${effects.externalCalls??0}。进入 M40 前仍需最长 24 小时执行窗口和你的明确创建批准。`}),
      el("code",{text:`v${authorization.version} · ${authorization.bundleHash.slice(0,16)}`}),
    ]),
  ]);
  $("#uat-blueprint-gate").querySelector("strong").textContent="预算已批准 · 资源仍未创建";
  $("#uat-blueprint-gate").querySelector("span").textContent=`预算 $${policy.monthlyBudgetLimitUsd} 已批准 · 创建授权 false · 环境 0 · 服务 0 · 外部调用 0`;
  $("#uat-package-gate").querySelector("span").textContent=`预计 $${cost.estimatedMonthlyCostUsd??33}/月 · 10 步全部 disabled · M39 新增月费 $0`;
  $("#uat-approval-gate").querySelector("span").textContent=`预算与纯虚构范围已冻结 · ${blockers} 项 M40 门槛 · Provider 调用 0`;
}

function uatBlueprintRow(item) {
  const definition=item.definition;
  const article=el("article",{className:"release-manifest uat-blueprint"});
  article.append(el("div",{className:"release-manifest-heading"},[
    el("div",{},[el("div",{className:"configuration-version-line"},[
      el("strong",{text:`${item.blueprintKey} · v${item.version}`}),
      el("span",{className:`configuration-status status-${item.status}`,text:statusText(item.status)}),
    ]),el("h3",{text:"隔离 UAT · 不可执行蓝图"}),el("p",{text:item.reason})]),
    el("div",{className:"configuration-audit"},[el("span",{text:`${item.createdByName??"未知操作者"} · ${formatDateTime(item.createdAt)}`}),
      el("code",{text:item.definitionHash.slice(0,16)})]),
  ]));
  article.append(el("dl",{className:"release-facts"},[
    evidence("Release Manifest",item.releaseManifestLabel??"未绑定（阻断）"),evidence("拓扑","3 个隔离服务 · 均未创建"),
    evidence("数据","仅纯虚构 · DEV 不复制"),evidence("Secret",`${definition.secretReferences.length} 个引用 · 0 个值`),
    evidence("区域 / 保留",`${definition.decisions.dataRegion.region} · ${definition.decisions.privacyRetention.retentionDays} 天`),
    evidence("真实资料","进入前重新审批"),evidence("UAT 额外预算",`$${definition.decisions.budget.monthlyLimitUsd} · ${uatResourcePolicyText(definition.decisions.budget.paidResourceProvisioning)}`),
    evidence("迁移",`${definition.migration.migrations.length} 组 · 不执行`),evidence("入口 / 运行","关闭 / 关闭"),
    evidence("回滚",`未暴露目标移除 · ${definition.rollback.maxMinutes} 分钟上限`),evidence("计划哈希",item.deploymentPlanHash.slice(0,16)),
  ]));
  article.append(el("div",{className:"release-approval-register"},Object.entries(definition.decisions).map(([key,value])=>
    el("div",{},[el("span",{text:uatDecisionText(key)}),statusLabel(value.status),el("code",{text:value.reference??"尚未提供"})]))));
  article.append(el("details",{className:"configuration-diff"},[
    el("summary",{text:`查看 ${item.deploymentPlan.length} 步无密钥部署计划`}),
    el("ol",{className:"uat-plan-list"},item.deploymentPlan.map((step)=>el("li",{},[
      el("strong",{text:uatPlanActionText(step.action)}),el("span",{text:"执行：关闭"})]))),
  ]));
  article.append(uatDryRunEvidence(item.latestDryRun));
  if (item.status==="draft"&&definition.schemaVersion==="1.0") article.append(uatDryRunForm(item.id));
  const alreadyCompiled=state.uatBlueprints?.provisioningPackages?.some((candidate)=>candidate.blueprintId===item.id);
  if (state.uatBlueprints?.canManage && item.status==="draft" && item.latestDryRun?.status==="passed" && !alreadyCompiled) {
    article.append(uatPackageCompileForm(item.id));
  }
  return article;
}

function uatPackageCompileForm(blueprintId) {
  const form=el("form",{className:"configuration-transition-form release-action-form uat-package-action",attrs:{"data-uat-package-compile-blueprint-id":blueprintId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明为何基于这份已通过蓝图编译不可执行部署包。"}}),
    el("button",{className:"button button-primary-inline",text:"编译 NO-GO 部署包",attrs:{type:"submit"}}));
  return form;
}

function uatProvisioningPackageRow(item) {
  const definition=item.definition;
  const article=el("article",{className:"release-manifest uat-provisioning-package"});
  article.append(el("div",{className:"release-manifest-heading"},[
    el("div",{},[el("div",{className:"configuration-version-line"},[
      el("strong",{text:`${item.packageKey} · v${item.version}`}),
      el("span",{className:"configuration-status status-draft",text:"已编译"}),
      el("span",{className:"configuration-status status-blocked",text:"NO-GO"}),
    ]),el("h3",{text:"Sydney UAT · 不可执行部署合同"}),el("p",{text:item.reason})]),
    el("div",{className:"configuration-audit"},[el("span",{text:`${item.compiledByName??"未知操作者"} · ${formatDateTime(item.createdAt)}`}),
      el("code",{text:item.definitionHash.slice(0,16)})]),
  ]));
  article.append(el("dl",{className:"release-facts"},[
    evidence("来源蓝图",item.blueprintLabel),evidence("区域",definition.region),
    evidence("Railway","环境 0 · 服务 0 · 域名 0"),evidence("Supabase","项目 0 · 数据库 0 · Bucket 0"),
    evidence("资料边界","仅纯虚构 · 真实资料需重批"),evidence("保留 / 清理","30 天 · 调度未创建"),
    evidence("额外预算",`$${definition.budget.monthlyLimitUsd} · ${uatResourcePolicyText(definition.budget.paidResourceProvisioning)}`),evidence("Secret",`${definition.railwayPlan.secretReferences.length} 个引用 · 0 个值`),
    evidence("迁移",`${definition.migration.migrations.join(" · ")} · 不执行`),evidence("授权","false · 重新审批后才可变化"),
    evidence("Runbook 哈希",item.runbookHash.slice(0,16)),
  ]));
  article.append(el("details",{className:"configuration-diff"},[
    el("summary",{text:`查看 ${definition.runbook.length} 步禁用 Runbook`}),
    el("ol",{className:"uat-plan-list"},definition.runbook.map((step)=>el("li",{},[
      el("strong",{text:uatPackageActionText(step.action)}),el("span",{text:"执行：关闭"})]))),
  ]));
  article.append(uatPackageDryRunEvidence(item.latestDryRun));
  if (item.status==="compiled"&&definition.schemaVersion==="1.0") article.append(uatPackageDryRunForm(item.id));
  const alreadyPrepared=state.uatBlueprints?.activationApprovalPacks?.some((candidate)=>candidate.provisioningPackageId===item.id);
  if (state.uatBlueprints?.canManage && item.status==="compiled" && item.latestDryRun?.status==="passed" && !alreadyPrepared) {
    article.append(uatActivationCompileForm(item.id));
  }
  return article;
}

function uatActivationCompileForm(packageId) {
  const form=el("form",{className:"configuration-transition-form release-action-form uat-package-action",attrs:{"data-uat-activation-compile-package-id":packageId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明为何创建首次客户与预算激活审批清单；此操作不授权部署。"}}),
    el("button",{className:"button button-primary-inline",text:"编译激活审批包",attrs:{type:"submit"}}));
  return form;
}

function uatActivationApprovalPackRow(item) {
  const definition=item.definition;
  const decisionMap=new Map((item.latestDecisions??[]).map((decision)=>[decision.decisionKey,decision]));
  const evaluation=item.latestEvaluation;
  const article=el("article",{className:"release-manifest uat-activation-approval"});
  article.append(el("div",{className:"release-manifest-heading"},[
    el("div",{},[el("div",{className:"configuration-version-line"},[
      el("strong",{text:`${item.approvalPackKey} · v${item.version}`}),
      el("span",{className:"configuration-status status-draft",text:"审批收集中"}),
      el("span",{className:"configuration-status status-blocked",text:"NO-GO"}),
    ]),el("h3",{text:"Sydney UAT · 激活前置审批"}),el("p",{text:item.reason})]),
    el("div",{className:"configuration-audit"},[el("span",{text:`${item.compiledByName??"未知操作者"} · ${formatDateTime(item.createdAt)}`}),
      el("code",{text:item.definitionHash.slice(0,16)})]),
  ]));
  article.append(el("dl",{className:"release-facts"},[
    evidence("来源部署包",item.provisioningPackageLabel),evidence("目标",`${definition.target.region} · ${definition.target.retentionDays} 天`),
    evidence("当前预算",`$${definition.currentPolicy.monthlyBudgetUsd} · ${uatResourcePolicyText(definition.currentPolicy.paidResourceProvisioning)}`),evidence("当前资料","仅纯虚构 · 真实资料需重批"),
    evidence("Provider 动作","关闭"),evidence("Provisioning 授权","false"),
    evidence("最终授权","独立阶段 · 尚未申请"),evidence("运行责任人",shortId(definition.inheritedEvidence.runtimeOwnerActorId)),
  ]));
  article.append(el("div",{className:"uat-approval-register"},definition.requiredDecisions.map((key)=>{
    const decision=decisionMap.get(key);
    return el("div",{},[el("span",{text:uatActivationDecisionText(key)}),
      decision?statusLabel(decision.status):statusLabel("pending"),
      el("code",{text:decision?.evidence?.reference??"尚未提供"}),
      el("small",{text:decision?`${decision.decidedByName??"未知操作者"} · v${decision.version}`:"缺少明确审批"})]);
  })));
  article.append(uatActivationEvaluationEvidence(evaluation));
  if (item.status==="draft"&&definition.schemaVersion==="1.0") {
    article.append(uatActivationEvaluationForm(item.id));
    if (state.uatBlueprints?.canManage) article.append(el("details",{className:"configuration-diff uat-approval-entry"},[
      el("summary",{text:"登记或修订一项明确审批"}),
      el("div",{className:"uat-decision-form-list"},definition.requiredDecisions.map((key)=>uatActivationDecisionForm(item.id,key))),
    ]));
    const alreadyCompiled=state.uatBlueprints?.finalAuthorizationRequests?.some((candidate)=>candidate.approvalPackId===item.id);
    if (state.uatBlueprints?.canManage && item.latestEvaluation && !alreadyCompiled) article.append(uatFinalAuthorizationCompileForm(item.id));
  }
  return article;
}

function uatFinalAuthorizationCompileForm(approvalPackId) {
  const form=el("form",{className:"configuration-transition-form release-action-form uat-final-compile",attrs:{"data-uat-final-compile-pack-id":approvalPackId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明为何冻结当前审批快照与执行前变更清单；这不是提交或授权。"}}),
    el("button",{className:"button button-primary-inline",text:"编译最终授权申请草稿",attrs:{type:"submit"}}));
  return form;
}

function uatFinalAuthorizationRequestRow(item) {
  const definition=item.definition,policy=definition.proposedPolicy,run=item.latestEvaluation;
  const article=el("article",{className:"release-manifest uat-final-authorization"});
  article.append(el("div",{className:"release-manifest-heading"},[
    el("div",{},[el("div",{className:"configuration-version-line"},[
      el("strong",{text:`${item.requestKey} · v${item.version}`}),
      el("span",{className:"configuration-status status-draft",text:"未提交"}),
      el("span",{className:"configuration-status status-blocked",text:"NO-GO"}),
    ]),el("h3",{text:"执行前变更审查"}),el("p",{text:item.reason})]),
    el("div",{className:"configuration-audit"},[el("span",{text:`${item.compiledByName??"未知操作者"} · ${formatDateTime(item.createdAt)}`}),
      el("code",{text:item.definitionHash.slice(0,16)})]),
  ]));
  article.append(el("dl",{className:"release-facts"},[
    evidence("来源审批包",item.approvalPackLabel),evidence("审批快照",`${definition.sourceApprovalPack.evaluationStatus} · ${definition.sourceApprovalPack.blockerCount} 项阻断`),
    evidence("目标",`${definition.target.region} · ${definition.target.retentionDays} 天`),evidence("客户确认",policy.customerConfirmed?"已冻结":policy.customerConfirmationRequiredForSyntheticUat===false?"纯虚构 UAT 不要求":"缺少"),
    evidence("预算 / 成本",policy.monthlyBudgetUsd===null?"缺少正数预算":`$${policy.monthlyBudgetUsd} / $${policy.estimatedMonthlyCostUsd}`),
    evidence("资料范围",policy.dataMode===null?"尚未决定":policy.dataMode==="real_data"?"真实资料 · 已明确许可":"仅纯虚构"),
    evidence("执行窗口",policy.windowStartsAt?`${formatDateTime(policy.windowStartsAt)} → ${formatDateTime(policy.windowEndsAt)}`:"尚未决定"),
    evidence("申请 / 授权","未提交 / false"),evidence("执行器","不存在"),evidence("变更集哈希",item.changeSetHash.slice(0,16)),
  ]));
  article.append(el("div",{className:"uat-change-diff"},[
    el("div",{},[el("span",{text:"当前政策"}),el("strong",{text:`$${definition.currentPolicy.monthlyBudgetUsd} · 仅纯虚构 · ${uatResourcePolicyText(definition.currentPolicy.paidResourceProvisioning)}`})]),
    el("div",{},[el("span",{text:"拟议政策"}),el("strong",{text:policy.monthlyBudgetUsd===null?"未形成 · 审批缺失":`$${policy.monthlyBudgetUsd} · ${policy.dataMode}`})]),
    el("div",{},[el("span",{text:"差异结论"}),el("strong",{text:run?.status==="ready"?"可准备提交，仍未授权":`${run?.blockerCount??definition.sourceApprovalPack.blockerCount} 项未解决`})]),
  ]));
  article.append(el("details",{className:"configuration-diff"},[
    el("summary",{text:`查看 ${definition.changeSet.length} 步禁用变更集`}),
    el("ol",{className:"uat-plan-list"},definition.changeSet.map((step)=>el("li",{},[
      el("strong",{text:uatFinalActionText(step.action)}),el("span",{text:"执行：关闭"})]))),
  ]));
  article.append(uatFinalAuthorizationEvaluationEvidence(run));
  if (item.status==="draft"&&definition.schemaVersion==="1.0") article.append(uatFinalAuthorizationEvaluationForm(item.id));
  return article;
}

function uatFinalAuthorizationEvaluationEvidence(run) {
  if (!run) return el("div",{className:"release-run-empty"},[el("strong",{text:"尚未运行执行前审查"}),
    el("p",{text:"审查只对比审批快照和禁用变更集，不提交申请、不授予权限。"})]);
  return el("div",{className:`release-run ${run.status==="ready"?"is-passed":"is-blocked"}`},[
    el("div",{className:"release-run-heading"},[el("strong",{text:run.status==="ready"?"材料可准备提交 · 当前仍 NO-GO":`执行前审查有 ${run.blockerCount} 项阻断`}),
      el("span",{text:`${run.runByName??"未知操作者"} · ${formatDateTime(run.createdAt)}`})]),
    el("div",{className:"release-check-list"},run.checks.map((check)=>el("div",{},[
      statusLabel(check.status),el("strong",{text:uatFinalCheckText(check.code)}),
      el("span",{text:check.status==="passed"?"证据匹配":check.code==="bounded_execution_window"?"需要最长24小时的执行窗口":check.code==="explicit_creation_authorization"?"需要你明确批准进入M40":"必须先更新审批证据"})]))),
  ]);
}

function uatFinalAuthorizationEvaluationForm(requestId) {
  const form=el("form",{className:"configuration-transition-form release-action-form",attrs:{"data-uat-final-evaluate-request-id":requestId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明本次变更差异、审批快照和零副作用审查范围。"}}),
    el("button",{className:"button button-secondary",text:"运行执行前变更审查",attrs:{type:"submit"}}));
  return form;
}

function uatActivationEvaluationEvidence(run) {
  if (!run) return el("div",{className:"release-run-empty"},[el("strong",{text:"尚未评估审批缺口"}),
    el("p",{text:"评估只生成阻断证据；无论结果如何，执行决定都保持 NO-GO。"})]);
  return el("div",{className:`release-run ${run.status==="passed"?"is-passed":"is-blocked"}`},[
    el("div",{className:"release-run-heading"},[el("strong",{text:run.status==="passed"?"审批齐全 · 可申请最终授权":`当前 ${run.blockerCount} 项阻断 · NO-GO`}),
      el("span",{text:`${run.runByName??"未知操作者"} · ${formatDateTime(run.createdAt)}`})]),
    el("div",{className:"release-check-list"},run.checks.map((check)=>el("div",{},[
      statusLabel(check.status),el("strong",{text:uatActivationCheckText(check.code)}),
      el("span",{text:check.status==="passed"?"证据匹配":"待明确批准"})]))),
  ]);
}

function uatActivationEvaluationForm(approvalPackId) {
  const form=el("form",{className:"configuration-transition-form release-action-form",attrs:{"data-uat-activation-evaluate-pack-id":approvalPackId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明本次审批缺口复核范围；不会执行 Provider 动作。"}}),
    el("button",{className:"button button-secondary",text:"重新评估审批缺口",attrs:{type:"submit"}}));
  return form;
}

function uatActivationDecisionForm(approvalPackId,key) {
  const form=el("form",{className:"uat-decision-form",attrs:{"data-uat-activation-decision-pack-id":approvalPackId,"data-uat-activation-decision-key":key}});
  form.append(el("strong",{text:uatActivationDecisionText(key)}),
    el("label",{},[el("span",{text:"结论"}),el("select",{attrs:{name:"status"}},[
      el("option",{text:"批准",attrs:{value:"approved"}}),el("option",{text:"拒绝",attrs:{value:"rejected"}})])]),
    el("label",{},[el("span",{text:"证据引用"}),el("input",{attrs:{name:"reference",required:"",maxlength:"300",placeholder:"decision://uat/..."}})]));
  if (key==="customer_confirmation") form.append(el("label",{},[el("span",{text:"客户确认时间"}),el("input",{attrs:{name:"confirmedAt",type:"datetime-local"}})]));
  if (key==="budget_and_cost") form.append(
    el("label",{},[el("span",{text:"批准月限额 USD"}),el("input",{attrs:{name:"approvedMonthlyLimitUsd",type:"number",min:"0.01",max:"1000",step:"0.01"}})]),
    el("label",{},[el("span",{text:"Provider 月估算 USD"}),el("input",{attrs:{name:"estimatedMonthlyCostUsd",type:"number",min:"0.01",max:"1000",step:"0.01"}})]));
  if (key==="data_scope") form.append(el("label",{},[el("span",{text:"资料范围"}),el("select",{attrs:{name:"mode"}},[
    el("option",{text:"仅纯虚构",attrs:{value:"synthetic_only"}}),el("option",{text:"真实资料（需明确重批）",attrs:{value:"real_data"}})])]));
  if (key==="provisioning_window") form.append(
    el("label",{},[el("span",{text:"开始时间"}),el("input",{attrs:{name:"startsAt",type:"datetime-local"}})]),
    el("label",{},[el("span",{text:"结束时间（最长24小时）"}),el("input",{attrs:{name:"endsAt",type:"datetime-local"}})]));
  form.append(el("label",{className:"uat-decision-reason"},[el("span",{text:"审批理由"}),el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:""}})]),
    el("button",{className:"button button-secondary",text:"记录不可变审批",attrs:{type:"submit"}}));
  return form;
}

function uatPackageDryRunEvidence(run) {
  if (!run) return el("div",{className:"release-run-empty"},[el("strong",{text:"部署包尚未 dry-run"}),
    el("p",{text:"检查只验证合同完整性与零副作用；通过后的执行决定仍是 NO-GO。"})]);
  return el("div",{className:"release-run is-passed"},[
    el("div",{className:"release-run-heading"},[el("strong",{text:"合同检查通过 · 执行仍为 NO-GO"}),
      el("span",{text:`${run.runByName??"未知操作者"} · ${formatDateTime(run.createdAt)}`})]),
    el("div",{className:"release-check-list"},run.checks.map((check)=>el("div",{},[
      statusLabel(check.status),el("strong",{text:uatPackageCheckText(check.code)}),el("span",{text:"证据匹配"})]))),
  ]);
}

function uatPackageDryRunForm(packageId) {
  const form=el("form",{className:"configuration-transition-form release-action-form",attrs:{"data-uat-package-id":packageId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明本次要验证的零预算门禁、禁用步骤和零副作用边界。"}}),
    el("button",{className:"button button-secondary",text:"验证部署合同",attrs:{type:"submit"}}));
  return form;
}

function uatDryRunEvidence(run) {
  if (!run) return el("div",{className:"release-run-empty"},[el("strong",{text:"尚未 dry-run"}),
    el("p",{text:"运行后只会生成检查证据，不会连接 Railway、Supabase 或任何外部系统。"})]);
  return el("div",{className:`release-run ${run.status==="passed"?"is-passed":"is-blocked"}`},[
    el("div",{className:"release-run-heading"},[el("strong",{text:run.status==="passed"?"最新 dry-run 通过":`最新 dry-run 有 ${run.blockerCount} 个阻断`}),
      el("span",{text:`${run.runByName??"未知操作者"} · ${formatDateTime(run.createdAt)}`})]),
    el("div",{className:"release-check-list"},run.checks.map((check)=>el("div",{},[
      statusLabel(check.status),el("strong",{text:uatCheckText(check.code)}),
      el("span",{text:check.status==="passed"?"计划证据匹配":"需要审批或绑定后重试"})]))),
  ]);
}

function uatDryRunForm(blueprintId) {
  const form=el("form",{className:"configuration-transition-form release-action-form",attrs:{"data-uat-blueprint-id":blueprintId}});
  form.append(el("textarea",{attrs:{name:"reason",rows:"2",minlength:"12",maxlength:"1000",required:"",placeholder:"说明本次 dry-run 要核对的治理输入和计划版本。"}}),
    el("button",{className:"button button-secondary",text:"运行零副作用 dry-run",attrs:{type:"submit"}}));
  return form;
}

function releaseManifestRow(item) {
  const article = el("article", { className: "release-manifest" });
  article.append(el("div", { className: "release-manifest-heading" }, [
    el("div", {}, [
      el("div", { className: "configuration-version-line" }, [
        el("strong", { text: `${item.manifestKey} · v${item.version}` }),
        el("span", { className: `configuration-status status-${item.status}`, text: statusText(item.status) }),
      ]),
      el("h3", { text: `${item.sourceEnvironment} → ${item.targetEnvironment}` }),
      el("p", { text: item.reason }),
    ]),
    el("div", { className: "configuration-audit" }, [
      el("span", { text: `${item.createdByName ?? "未知操作者"} · ${formatDateTime(item.createdAt)}` }),
      el("code", { text: item.manifestHash.slice(0, 16) }),
    ]),
  ]));
  const declarations = item.readinessDeclarations;
  article.append(el("dl", { className: "release-facts" }, [
    evidence("目标创建", statusText(declarations.targetProvisioning)),
    evidence("数据边界", declarations.dataBoundary === "synthetic_only" ? "仅纯虚构" : declarations.dataBoundary),
    evidence("运行", declarations.runtimeExecution),
    evidence("外部入口", declarations.externalIngress),
    evidence("外部发送", declarations.externalDelivery),
    evidence("固定组件", `${item.components.length} 个版本`),
    evidence("回滚指针", item.rollbackManifestId ? shortId(item.rollbackManifestId) : "首版，无前序"),
    evidence("Secret", `${declarations.secretReferences.length} 个引用 · 0 个值`),
  ]));
  article.append(el("div", { className: "release-approval-register" }, Object.entries(declarations.approvals).map(([key, value]) =>
    el("div", {}, [el("span", { text: releaseApprovalText(key) }), statusLabel(value.status),
      el("code", { text: value.reference ?? "无需引用" })]))));
  if (item.components.length) article.append(el("details", { className: "configuration-diff" }, [
    el("summary", { text: `查看 ${item.components.length} 个固定组件` }),
    el("div", { className: "release-component-list" }, item.components.map((component) => el("div", {}, [
      el("strong", { text: `${releaseComponentText(component.componentType)} · ${component.componentKey}` }),
      el("span", { text: `${component.versionLabel} · ${statusText(component.lifecycleStatus)}` }),
      el("code", { text: component.definitionHash.slice(0, 16) }),
    ]))),
  ]));
  article.append(releaseReadinessEvidence(item));
  const canManage = state.releaseReadiness.canManage;
  const canApprove = state.releaseReadiness.canApprove;
  if (item.status === "draft") {
    article.append(releaseManifestActionForm(item.id, "evaluate", "重新评估", "比对当前 DEV 组件、前置声明和冻结哈希。"));
    if (canManage && item.latestRun?.status === "passed" && !item.latestRun.driftDetected) {
      article.append(releaseManifestActionForm(item.id, "submit", "提交独立复核", "确认最新检查已通过，并将候选提交给另一名主管或管理员。"));
    }
  }
  if (item.status === "in_review" && canApprove) {
    article.append(releaseManifestActionForm(item.id, "approve", "批准准备证据", "确认当前组件无漂移且准备证据充分；这不授权部署。"));
    article.append(releaseManifestActionForm(item.id, "reject", "拒绝并记录", "说明阻断发布准备的具体证据。"));
  }
  return article;
}

function releaseReadinessEvidence(item) {
  const run = item.latestRun;
  if (!run) return el("div", { className: "release-run-empty" }, [el("strong", { text: "尚未评估" }), el("p", { text: "先运行准备检查；检查不会连接 UAT 或外部系统。" })]);
  return el("div", { className: `release-run ${run.status === "passed" ? "is-passed" : "is-blocked"}` }, [
    el("div", { className: "release-run-heading" }, [
      el("strong", { text: run.status === "passed" ? "最新准备检查通过" : `最新检查有 ${run.blockerCount} 个阻断` }),
      el("span", { text: `${run.runByName ?? "未知操作者"} · ${formatDateTime(run.createdAt)}` }),
    ]),
    el("div", { className: "release-check-list" }, run.checks.map((check) => el("div", {}, [
      statusLabel(check.status), el("strong", { text: releaseCheckText(check.code) }),
      el("span", { text: check.status === "passed" ? "证据匹配" : "需要处理后重新评估" }),
    ]))),
  ]);
}

function releaseManifestActionForm(manifestId, action, buttonText, placeholder) {
  const form = el("form", { className: "configuration-transition-form release-action-form", attrs: { "data-release-action": action, "data-release-manifest-id": manifestId } });
  form.append(el("textarea", { attrs: { name: "reason", rows: "2", minlength: "12", maxlength: "1000", required: "", placeholder } }),
    el("button", { className: `button ${["submit", "approve"].includes(action) ? "button-primary-inline" : "button-secondary"}`, text: buttonText, attrs: { type: "submit" } }));
  return form;
}

async function handleReleaseReadinessSubmit(event) {
  event.preventDefault(); if (state.releaseReadinessSubmitting) return;
  const form = event.target; if (!form.reportValidity()) return;
  const data = new FormData(form);
  try {
    if (form.dataset.uatFinalEvaluateRequestId) {
      return submitReleaseReadiness(`/v1/ops/uat-final-authorization-requests/${encodeURIComponent(form.dataset.uatFinalEvaluateRequestId)}/evaluations`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"执行前变更审查已记录；申请仍未提交，授权与执行均为 false。");
    }
    if (form.dataset.uatFinalCompilePackId) {
      return submitReleaseReadiness(`/v1/ops/uat-activation-approval-packs/${encodeURIComponent(form.dataset.uatFinalCompilePackId)}/final-authorization-requests`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"最终授权申请草稿已冻结；不能提交、不能批准、不能执行，Provider 调用为 0。");
    }
    if (form.dataset.uatActivationDecisionPackId) {
      const decisionKey=form.dataset.uatActivationDecisionKey;
      const status=String(data.get("status")??"");
      const evidence=uatActivationEvidenceFromForm(decisionKey,status,data);
      if (!evidence) throw new Error("请完整填写该审批所需证据；批准预算必须大于 $0 且估算不得超过限额，执行窗口最长 24 小时。");
      return submitReleaseReadiness(`/v1/ops/uat-activation-approval-packs/${encodeURIComponent(form.dataset.uatActivationDecisionPackId)}/decisions`,{
        decisionKey,status,evidence,reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"审批证据已追加记录；系统仍保持 NO-GO，需重新评估且之后仍需独立最终授权。",()=>form.reset());
    }
    if (form.dataset.uatActivationEvaluatePackId) {
      return submitReleaseReadiness(`/v1/ops/uat-activation-approval-packs/${encodeURIComponent(form.dataset.uatActivationEvaluatePackId)}/evaluations`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"审批缺口已重新评估；执行决定仍为 NO-GO，Provider 调用与资源变更均为 0。");
    }
    if (form.dataset.uatActivationCompilePackageId) {
      return submitReleaseReadiness(`/v1/ops/uat-provisioning-packages/${encodeURIComponent(form.dataset.uatActivationCompilePackageId)}/activation-approval-packs`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"UAT 激活审批包已编译；4 项决定均未被代填，执行仍为 NO-GO。");
    }
    if (form.dataset.uatPackageCompileBlueprintId) {
      return submitReleaseReadiness(`/v1/ops/uat-blueprints/${encodeURIComponent(form.dataset.uatPackageCompileBlueprintId)}/provisioning-packages`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"UAT 部署包已编译；执行决定为 NO-GO，创建和外部调用仍为 0。");
    }
    if (form.dataset.uatPackageId) {
      return submitReleaseReadiness(`/v1/ops/uat-provisioning-packages/${encodeURIComponent(form.dataset.uatPackageId)}/dry-runs`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"部署合同检查通过；NO-GO 门禁保持有效，资源变更为 0。");
    }
    if (form.id === "uat-blueprint-form") {
      const definition=uatBlueprintDefinitionFromForm(data);
      return submitReleaseReadiness("/v1/ops/uat-blueprints",{
        blueprintKey:String(data.get("blueprintKey")??"").trim().toLowerCase(),
        releaseManifestId:String(data.get("releaseManifestId")??"").trim()||null,definition,
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"UAT 蓝图已保存；环境、服务、数据库、域名和运行实例仍为 0。",()=>{
        form.reset(); form.elements.blueprintKey.value="uat-isolated"; form.elements.uatMonthlyLimitUsd.value="0";
      });
    }
    if (form.dataset.uatBlueprintId) {
      return submitReleaseReadiness(`/v1/ops/uat-blueprints/${encodeURIComponent(form.dataset.uatBlueprintId)}/dry-runs`,{
        reason:String(data.get("reason")??"").trim(),idempotencyKey:crypto.randomUUID(),
      },"UAT dry-run 已记录；只生成检查证据，外部调用和资源变更均为 0。");
    }
    if (form.id === "release-manifest-form") {
      const declarations = releaseDeclarationsFromForm(data);
      return submitReleaseReadiness("/v1/ops/release-manifests", {
        manifestKey: String(data.get("manifestKey") ?? "").trim().toLowerCase(), declarations,
        reason: String(data.get("reason") ?? "").trim(), idempotencyKey: crypto.randomUUID(),
      }, "Manifest 草稿已冻结；UAT 仍未创建，运行、入口与外发仍关闭。", () => {
        form.reset(); form.elements.manifestKey.value = "dev-to-uat"; form.elements.monthlyLimitUsd.value = "0";
      });
    }
    const manifestId = form.dataset.releaseManifestId;
    const action = form.dataset.releaseAction;
    const reason = String(data.get("reason") ?? "").trim();
    const paths = {
      evaluate: `/v1/ops/release-manifests/${encodeURIComponent(manifestId)}/evaluations`,
      submit: `/v1/ops/release-manifests/${encodeURIComponent(manifestId)}/submit`,
      approve: `/v1/ops/release-manifests/${encodeURIComponent(manifestId)}/decisions`,
      reject: `/v1/ops/release-manifests/${encodeURIComponent(manifestId)}/decisions`,
    };
    const messages = {
      evaluate: "准备检查已完成；没有创建目标环境或发起外部调用。",
      submit: "Manifest 已提交独立复核；这不是部署授权。",
      approve: "准备证据已独立批准；UAT 仍未创建，部署仍未执行。",
      reject: "准备证据已拒绝并保留审计记录。",
    };
    if (!paths[action]) throw new Error("不支持的发布准备操作。 ");
    return submitReleaseReadiness(paths[action], {
      ...(action === "approve" || action === "reject" ? { action } : {}), reason, idempotencyKey: crypto.randomUUID(),
    }, messages[action]);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "发布准备操作失败。", true);
  }
}

function uatActivationEvidenceFromForm(key,status,data) {
  const reference=String(data.get("reference")??"").trim();
  if (!reference) return null;
  if (status==="rejected") return {reference};
  if (key==="customer_confirmation") {
    const value=String(data.get("confirmedAt")??"");
    return value?{reference,confirmedAt:new Date(value).toISOString()}:null;
  }
  if (key==="budget_and_cost") {
    const approved=Number(data.get("approvedMonthlyLimitUsd")),estimated=Number(data.get("estimatedMonthlyCostUsd"));
    return approved>0&&estimated>0&&estimated<=approved?{reference,currency:"USD",approvedMonthlyLimitUsd:approved,estimatedMonthlyCostUsd:estimated}:null;
  }
  if (key==="data_scope") {
    const mode=String(data.get("mode")??"");
    return {reference,mode,region:"Sydney",retentionDays:30,realDataApproved:mode==="real_data"};
  }
  if (key==="provisioning_window") {
    const starts=String(data.get("startsAt")??""),ends=String(data.get("endsAt")??"");
    if (!starts||!ends) return null;
    const startsAt=new Date(starts),endsAt=new Date(ends);
    if (Number.isNaN(startsAt.valueOf())||Number.isNaN(endsAt.valueOf())||endsAt<=startsAt||endsAt-startsAt>86_400_000) return null;
    return {reference,startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString()};
  }
  return null;
}

function uatBlueprintDefinitionFromForm(data) {
  const decision=(key)=>{
    const status=String(data.get(`${key}Status`)??"pending");
    const reference=String(data.get(`${key}Reference`)??"").trim()||null;
    if (status==="approved"&&!reference) throw new Error("已批准的 UAT 前置项必须填写决策记录引用。 ");
    return {status,reference};
  };
  const variableNames=String(data.get("variableNames")??"").split("\n").map((item)=>item.trim()).filter(Boolean);
  if (variableNames.length<5 || variableNames.some((item)=>!/^[A-Z][A-Z0-9_]{2,79}$/.test(item))) {
    throw new Error("变量目录至少需要 5 个合法的大写变量名。 ");
  }
  const secretReferences=String(data.get("uatSecretReferences")??"").split("\n").map((item)=>item.trim()).filter(Boolean).map((line)=>{
    const separator=line.indexOf("=");
    const variableName=separator>0?line.slice(0,separator).trim():"";
    const reference=separator>0?line.slice(separator+1).trim():"";
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(variableName)||!/^[a-z][a-z0-9+.-]*:\/\/[^?#\s]{3,240}$/i.test(reference)) {
      throw new Error("Secret 引用必须使用 VARIABLE=scheme://location，不能包含密钥值。 ");
    }
    return {variableName,reference};
  });
  return {schemaVersion:"1.0",sourceEnvironment:"DEV",targetEnvironment:"UAT",provisioningMode:"dry_run_only",
    targetProvisioning:"not_started",dataBoundary:"synthetic_only",dataCopy:"none",runtimeExecution:"disabled",
    externalIngress:"disabled",externalDelivery:"disabled",secretMaterialization:"disabled",
    topology:{provider:"railway",isolation:"dedicated_environment",database:"dedicated_supabase_project",
      storage:"dedicated_private_bucket",services:[
        {key:"intake",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
        {key:"preservation",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
        {key:"classification",plannedExposure:"internal_only",replicas:1,runtimeState:"disabled"},
      ]},
    decisions:{dataRegion:{...decision("uatDataRegion"),region:"Sydney"},
      privacyRetention:{...decision("uatPrivacyRetention"),retentionDays:30,realDataRequiresReapproval:true},
      budget:{...decision("uatBudget"),monthlyLimitUsd:0,paidResourceProvisioning:"prohibited"},
      runtimeOwner:{...decision("uatRuntimeOwner"),actorId:"00000000-0000-4000-8000-000000000000"}},
    variableNames,secretReferences,migration:{strategy:"ordered_sql",seedMode:"synthetic_only",migrations:["001..028"],
      verificationScripts:["032_zero_budget_uat_decision_lock_regression.sql"]},
    acceptance:{healthCheck:"required",errorLogs:"zero_required",syntheticJourney:"required",realData:"prohibited"},
    rollback:{strategy:"remove_unexposed_target",preserveAuditEvidence:true,maxMinutes:30}};
}

function releaseDeclarationsFromForm(data) {
  const declaration = (key, includeBudget = false) => {
    const status = String(data.get(`${key}Status`) ?? "pending");
    const reference = String(data.get(`${key}Reference`) ?? "").trim() || null;
    if (status === "approved" && !reference) throw new Error("已批准的前置项必须填写审批记录引用。 ");
    return { status, reference, ...(includeBudget && status === "approved" ? { monthlyLimitUsd: Number(data.get("monthlyLimitUsd")) } : {}) };
  };
  const secretReferences = String(data.get("secretReferences") ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
  if (secretReferences.some((item) => !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(item))) {
    throw new Error("密钥只能填写 scheme://location 形式的位置引用，不能填写密钥值。 ");
  }
  return { schemaVersion: "1.0", sourceEnvironment: "DEV", targetEnvironment: "UAT",
    targetProvisioning: "not_started", runtimeExecution: "disabled", externalDelivery: "disabled",
    externalIngress: "disabled", dataBoundary: "synthetic_only",
    approvals: { dataRegion: declaration("dataRegion"), privacyRetention: declaration("privacyRetention"),
      budget: declaration("budget", true), sharedMailbox: declaration("sharedMailbox") }, secretReferences };
}

async function submitReleaseReadiness(path, body, successMessage, afterSuccess) {
  if (!state.overview?.csrfToken) return showNotice("会话安全信息缺失，请刷新后重试。", true);
  state.releaseReadinessSubmitting = true;
  $("#release-readiness-view").querySelectorAll("button,input,select,textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(releaseReadinessError(result));
    afterSuccess?.(); await loadReleaseReadiness(); state.view = "release-readiness"; switchView("release-readiness");
    showNotice(result.outcome === "duplicate" ? "这个操作此前已安全记录。" : successMessage, false);
    return result;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "发布准备操作没有保存。", true);
    return null;
  } finally {
    state.releaseReadinessSubmitting = false;
    $("#release-readiness-view").querySelectorAll("button,input,select,textarea").forEach((control) => { control.disabled = false; });
  }
}

function releaseReadinessError(result) {
  return ({ invalid_request: "字段、审批引用或理由不符合发布准备规则。", release_components_unavailable: "当前没有足够的已发布或已启用组件可固定。",
    release_declarations_invalid: "DEV→UAT安全声明结构无效。", release_declarations_unknown_field: "准备声明包含未支持字段。",
    release_approval_declaration_invalid: "审批状态或字段结构无效。", release_approval_reference_required: "已批准项需要有效记录引用；不需要项不能附带引用。",
    release_budget_limit_invalid: "已批准预算必须包含有效的每月美元上限。", release_secret_reference_invalid: "Secret只能填写受限的位置引用。",
    release_manifest_unchanged: "当前组件与声明已由既有Manifest准确固定，无需建立重复版本。",
    manifest_not_evaluable: "该Manifest已拒绝或被替代，不能再次评估。", manifest_not_draft: "只有草稿可以评估或提交。",
    fresh_passing_readiness_required: "必须先取得最新通过且无漂移的准备检查。",
    independent_reviewer_required: "创建者或提交者不能批准自己的Manifest，请由另一名主管或管理员复核。",
    manifest_not_in_review: "只有待复核Manifest可以批准或拒绝。", manifest_not_found: "Manifest不存在或不属于当前组织。",
    uat_blueprint_definition_invalid: "UAT 蓝图缺少固定的安全边界。", uat_blueprint_unknown_field: "UAT 蓝图包含未支持字段。",
    uat_blueprint_topology_invalid: "UAT 必须保持隔离的三服务拓扑。", uat_blueprint_service_invalid: "服务计划必须为单副本、内部可见且运行关闭。",
    uat_blueprint_decision_invalid: "UAT 决策状态或引用无效。", uat_blueprint_budget_invalid: "已批准预算必须包含有效的月度上限。",
    uat_blueprint_variable_catalog_invalid: "变量名目录不完整或格式错误。", uat_blueprint_secret_reference_invalid: "Secret 只能保存变量名与位置引用，不能保存值。",
    uat_blueprint_migration_invalid: "迁移与验证计划不完整。", uat_blueprint_acceptance_invalid: "验收边界必须包含健康、零错误、纯虚构旅程和禁止真实资料。",
    uat_blueprint_rollback_invalid: "回滚计划必须移除未暴露目标并保留审计证据。", release_manifest_reference_invalid: "所选 Release Manifest 不存在或不属于当前组织。",
    uat_blueprint_unchanged: "相同蓝图定义已存在，无需创建重复版本。", uat_blueprint_not_found: "UAT 蓝图不存在或不属于当前组织。",
    uat_blueprint_not_current: "旧蓝图已被新版本替代，不能再次 dry-run。", idempotency_key_reused: "操作编号已用于不同请求，请刷新。",
  })[result.reason] ?? (result.error === "admin_required" ? "只有管理员可以冻结或提交 Manifest。" : "发布准备操作未完成，请刷新后重试。");
}

async function loadRetention(){
  if(!["manager","admin"].includes(state.overview?.operator?.actorType))return;
  try{const response=await fetch("/v1/ops/retention");
    if(response.status===401)throw new Error("会话已过期，请重新登录。");
    if(response.status===403)throw new Error("当前身份不能查看数据生命周期。");
    if(!response.ok)throw new Error("暂时无法读取数据生命周期状态。");
    state.retention=await response.json();renderRetention();
  }catch(error){showNotice(error instanceof Error?error.message:"数据生命周期加载失败。",true);}
}

function renderRetention(){
  if(!state.retention)return;const policy=state.retention.policy;const isAdmin=state.overview?.operator?.actorType==="admin";
  replaceChildren($("#retention-policy-summary"),policy?[el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:`${policy.retentionDays}天 · Case完成/取消起算`}),
      el("small",{text:`策略 ${policy.policyVersion} · Hold: 主管/管理员 · 仅纯虚构`})]),
    statusLabel(policy.executionEnabled?"ready":"blocked"),el("span",{text:`RPO ${policy.rpoHours}h`}),el("span",{text:`RTO ${policy.rtoHours}h`}),
  ])]:[emptyState("尚无保留政策","迁移应用后才能建立UAT策略。")]);
  const policyForm=$("#retention-policy-form");policyForm.hidden=!isAdmin||policy?.executionEnabled===true;
  if(policy){policyForm.elements.rpoHours.value=String(policy.rpoHours);policyForm.elements.rtoHours.value=String(policy.rtoHours);}
  const holdSelect=$("#retention-hold-form").elements.caseId;
  replaceChildren(holdSelect,state.overview.cases.filter((item)=>!item.contentDeletedAt).map((item)=>el("option",{text:`${item.subjectName} · ${period(item)}`,attrs:{value:item.id}})));
  const due=$("#retention-hold-form").elements.reviewDueAt;if(!due.value){const date=new Date();date.setUTCDate(date.getUTCDate()+30);due.value=date.toISOString().slice(0,10);}
  replaceChildren($("#retention-hold-list"),state.retention.activeHolds.length?state.retention.activeHolds.map((item)=>el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:`${item.subjectName} · ${item.caseKey}`}),el("small",{text:item.reason})]),
    statusLabel(item.reviewState==="pending_review"?"attention":"blocked"),
    el("span",{text:item.reviewState==="pending_review"?"已到期，等待主管/管理员明确解除":`复核 ${formatDate(item.reviewDueAt)}`}),el("span",{text:item.approvedBy}),
  ])):[emptyState("没有有效Legal Hold","到期Case会按策略进入dry-run候选。")]);
  replaceChildren($("#retention-run-list"),state.retention.recentRuns.length?state.retention.recentRuns.map((item)=>el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:`${item.mode==="dry_run"?"预览":"执行"} · ${item.status}`}),
      el("small",{text:`候选 ${item.candidateCases} Case / ${item.candidateDocuments} 文件 / ${item.candidateObjects} 对象`})]),
    statusLabel(item.status),el("span",{text:`删除 ${item.deletedObjects}+${item.notFoundObjects}`}),el("span",{text:`去敏 ${item.redactedCases} · 失败 ${item.failedObjects}`}),
  ])):[emptyState("还没有运行记录","先执行一次dry-run，确认删除数保持0。")]);
  replaceChildren($("#retention-proof-list"),state.retention.deletionProofs.length?state.retention.deletionProofs.map((item)=>el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:`删除证明 · ${item.caseKey}`}),el("small",{className:"retention-proof-hash",text:item.proofHash})]),
    statusLabel("completed"),el("span",{text:`${item.documentCount} 文件`}),el("span",{text:formatDate(item.deletedAt)}),
  ])):[emptyState("尚无删除证明","执行成功后只在这里保留最小证明。")]);
  replaceChildren($("#retention-drill-list"),state.retention.restoreDrills.length?state.retention.restoreDrills.map((item)=>el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:`恢复演练 · ${item.caseKey}`}),el("small",{text:`backup/restored digest ${item.backupDigest===item.restoredDigest?"一致":"不一致"}`})]),
    statusLabel(item.status),el("span",{text:`${item.restoreTarget==="isolated_pglite_postgresql"?"隔离PostgreSQL":"历史非隔离"} · ${item.actualRtoSeconds}s`}),
    el("span",{text:`迁移 ${item.sourceMigrationVersion??"—"} · 表 ${item.restoredTableCount} · FK ${item.restoredRelationshipCount} · RLS ${item.restoredRlsPolicyCount}`}),
    el("span",{text:`归档/目标清除 ${formatDate(item.artifactPurgedAt)}`}),
  ])):[emptyState("尚无恢复演练","正式执行删除前必须完成加密逻辑备份恢复验证。")]);
  replaceChildren($("#retention-reconciliation-list"),state.retention.storageReconciliations.length?state.retention.storageReconciliations.map((item)=>el("article",{className:"retention-record"},[
    el("div",{},[el("strong",{text:"Storage孤儿文件对账"}),el("small",{text:`数据库引用 ${item.databaseReferenceCount} · Storage对象 ${item.storageObjectCount}`})]),
    statusLabel(item.status),el("span",{text:`孤儿 ${item.orphanObjectCount}`}),el("span",{text:`缺失 ${item.missingObjectCount}`}),
  ])):[emptyState("尚无Storage对账","正式执行删除前必须完成一次只读对象对账。")]);
  const apply=$("#retention-run-form button[value='apply']");apply.disabled=!isAdmin||!policy?.executionEnabled;
  $("#nav-retention-count").value=String(state.retention.activeHolds.length+state.retention.recentRuns.filter((item)=>["queued","processing","failed"].includes(item.status)).length);
}

async function handleRetentionSubmit(event){
  event.preventDefault();const form=event.target;if(state.retentionSubmitting||!form.reportValidity())return;
  const data=new FormData(form);let path;let body;let success;
  if(form.id==="retention-policy-form"){
    path="/v1/ops/retention/policy-confirmations";body={retentionDays:30,anchor:"case_terminal_at",
      holdApproverRoles:["manager","admin"],rpoHours:Number(data.get("rpoHours")),rtoHours:Number(data.get("rtoHours")),
      reason:String(data.get("reason")??""),idempotencyKey:crypto.randomUUID()};success="保留与恢复政策已确认，执行闸门已开启。";
  }else if(form.id==="retention-hold-form"){
    path=`/v1/ops/cases/${encodeURIComponent(String(data.get("caseId")??""))}/legal-holds`;body={action:String(data.get("action")??""),
      reviewDueAt:new Date(`${String(data.get("reviewDueAt"))}T23:59:59Z`).toISOString(),reason:String(data.get("reason")??""),idempotencyKey:crypto.randomUUID()};success="Legal Hold决定已记录。";
  }else{
    path="/v1/ops/retention/runs";body={mode:event.submitter?.value,reason:String(data.get("reason")??""),idempotencyKey:crypto.randomUUID()};
    success=body.mode==="dry_run"?"候选预览已完成；删除对象数为0。":"清理运行已进入受治理队列。";
  }
  await submitRetention(path,body,success);
}

async function submitRetention(path,body,success){
  if(!state.overview?.csrfToken)return showNotice("会话安全信息缺失，请刷新后重试。",true);
  state.retentionSubmitting=true;$("#retention-view").querySelectorAll("button,input,select,textarea").forEach((c)=>{c.disabled=true;});hideNotice();
  try{const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-dop-csrf":state.overview.csrfToken},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(retentionError(result));
    await loadRetention();showNotice(result.outcome==="duplicate"?"该操作此前已经记录。":success,false);
  }catch(error){showNotice(error instanceof Error?error.message:"数据生命周期操作未完成。",true);}
  finally{state.retentionSubmitting=false;$("#retention-view").querySelectorAll("button,input,select,textarea").forEach((c)=>{c.disabled=false;});renderRetention();}
}
function retentionError(result){return ({execution_not_enabled:"必须先确认保留起算点、Hold批准人、RPO和RTO。",active_hold_exists:"该Case已有有效Legal Hold。",
  active_hold_not_found:"该Case没有可解除的Legal Hold。",invalid_review_due_at:"复核日期必须在未来一年内。",idempotency_key_reused:"操作编号已用于不同请求。",
  policy_not_configured:"UAT保留政策尚未建立。",case_not_available:"Case不存在或内容已删除。"})[result.reason]
  ??(result.error==="admin_required"?"只有管理员可以确认政策或执行清理。":result.error==="manager_required"?"需要主管或管理员权限。":"数据生命周期操作未完成，请刷新后重试。");}

async function loadDemoForm() {
  if (!["manager", "admin"].includes(state.overview?.operator?.actorType)) return;
  try {
    const response = await fetch("/v1/ops/demo-form");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (response.status === 403) throw new Error("当前身份不能管理销售演示入口。");
    if (!response.ok) throw new Error("受控销售演示入口尚未就绪。");
    state.demoForm = await response.json();
    renderDemoForm();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "销售演示入口加载失败。", true);
  }
}

function renderDemoForm() {
  if (!state.demoForm) return;
  const activeEntry = state.demoForm.entries.find((item) => item.status === "active");
  const form = $("#demo-form-invitation-form");
  const caseSelect = form.elements.caseId;
  replaceChildren(caseSelect, state.demoForm.eligibleCases.map((item) => el("option", {
    text: `${item.subjectDisplayName} · ${item.periodKey} · ${item.submissionCount ? `已有 ${item.submissionCount} 次提交` : "待首次提交"}`,
    attrs: { value: item.id },
  })));
  form.querySelectorAll("button,input,select,textarea").forEach((control) => {
    control.disabled = !activeEntry || state.demoForm.eligibleCases.length === 0 || state.demoFormSubmitting;
  });
  const questionForm = $("#client-question-form");
  const previousCaseId = questionForm.elements.caseId.value;
  const questionCases = state.demoForm.eligibleCases.filter((item) => state.demoForm.issues.some((issue) => issue.caseId === item.id));
  replaceChildren(questionForm.elements.caseId, questionCases.map((item) => el("option", {
    text: `${item.subjectDisplayName} · ${item.periodKey}`, attrs: { value: item.id },
  })));
  if (questionCases.some((item) => item.id === previousCaseId)) questionForm.elements.caseId.value = previousCaseId;
  renderClientQuestionIssueOptions();
  replaceChildren($("#demo-form-entry-summary"), activeEntry ? [el("article", { className: "demo-form-entry" }, [
    el("div", {}, [el("strong", { text: `Fillout 演示入口 · v${activeEntry.version}` }), el("span", { text: `服务端锁定 · ${activeEntry.connectorKey}` })]),
    statusLabel(activeEntry.status),
    el("span", { text: `单次最多 ${activeEntry.maximumFilesPerSubmission} 个文件` }),
    el("span", { text: activeEntry.allowedMimeTypes.map(demoMimeText).join(" / ") }),
  ])] : [emptyState("入口尚未启用", "只有已配置并通过安全验证的 UAT Fillout 入口才能发放邀请。")]);

  replaceChildren($("#demo-form-invitation-list"), state.demoForm.invitations.length
    ? state.demoForm.invitations.map((item) => el("article", { className: "demo-form-invitation" }, [
      el("div", {}, [el("strong", { text: `${item.subjectDisplayName} · ${item.periodKey}` }), el("span", { text: `${item.usedSubmissions}/${item.maximumSubmissions} 次提交 · 到期 ${formatDateTime(item.validUntil)}` })]),
      statusLabel(item.status),
      ...(item.status === "active" ? [el("form", { className: "demo-form-revoke", attrs: { "data-invitation-id": item.id } }, [
        el("input", { attrs: { name: "reason", required: "", minlength: "12", maxlength: "1000", value: "演示完成后撤销未使用的Case上传链接。", "aria-label": "撤销理由" } }),
        el("button", { className: "button button-quiet", text: "撤销邀请", attrs: { type: "submit" } }),
      ])] : []),
    ]))
    : [emptyState("尚无演示邀请", "选择一个纯虚构 Case 生成第一条链接。")]);
  replaceChildren($("#client-question-list"), state.demoForm.clientQuestions.length
    ? state.demoForm.clientQuestions.map((item) => el("article", { className: "demo-form-client-question" }, [
      el("div", {}, [el("strong", { text: `${item.publicTitle} · v${item.version}` }),
        el("span", { text: `${item.publicBody} · 发布于 ${formatDateTime(item.publishedAt)}` })]),
      statusLabel(item.status),
      ...(item.status === "published" ? [el("form", { className: "client-question-transition", attrs: { "data-question-id": item.id } }, [
        el("select", { attrs: { name: "action", "aria-label": "客户问题处理动作" } }, [
          el("option", { text: "标记已解决", attrs: { value: "resolve" } }),
          el("option", { text: "撤回问题", attrs: { value: "withdraw" } }),
        ]),
        el("input", { attrs: { name: "reason", required: "", minlength: "12", maxlength: "1000", value: "资料已补交并完成复核，结束客户可见问题。", "aria-label": "处理理由" } }),
        el("button", { className: "button button-quiet", text: "确认处理", attrs: { type: "submit" } }),
      ])] : []),
    ])) : [emptyState("没有客户可见问题", "只有明确发布的内容才会出现在提交者入口。")]);
  $("#nav-demo-form-count").value = String(state.demoForm.invitations.filter((item) => item.status === "active").length);
}

function renderClientQuestionIssueOptions() {
  const form = $("#client-question-form");
  const caseId = form.elements.caseId.value;
  const available = state.demoForm?.issues.filter((item) => item.caseId === caseId) ?? [];
  replaceChildren(form.elements.issueId, available.map((item) => el("option", {
    text: `${item.displayName} · ${statusText(item.status)}`,
    attrs: { value: item.id },
  })));
  form.querySelectorAll("button,input,select,textarea").forEach((control) => {
    control.disabled = state.demoFormSubmitting || (control.name === "caseId"
      ? form.elements.caseId.options.length === 0 : available.length === 0);
  });
}

function handleDemoFormChange(event) {
  if (event.target.matches("#client-question-form select[name=caseId]")) renderClientQuestionIssueOptions();
}

async function handleDemoFormSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (state.demoFormSubmitting || !form.reportValidity() || !state.overview?.csrfToken || !state.demoForm) return;
  const activeEntry = state.demoForm.entries.find((item) => item.status === "active");
  let path;
  let body;
  let successMessage;
  if (form.id === "demo-form-invitation-form") {
    if (!activeEntry) return showNotice("没有可用的受控 Fillout 入口。", true);
    const data = new FormData(form);
    const selectedCase = state.demoForm.eligibleCases.find((item) => item.id === data.get("caseId"));
    if (!selectedCase) return showNotice("请选择可用的纯虚构 Case。", true);
    path = "/v1/ops/demo-form/invitations";
    body = { entryVersionId: activeEntry.id, caseId: selectedCase.id, periodKey: selectedCase.periodKey,
      validDays: Number(data.get("validDays")), maximumSubmissions: Number(data.get("maximumSubmissions")),
      reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID() };
    successMessage = "受限链接已生成；它只能进入所选纯虚构 UAT Case。";
  } else if (form.id === "client-question-form") {
    const data = new FormData(form);
    path = "/v1/ops/client-portal/questions";
    body = { caseId: String(data.get("caseId") ?? ""), issueId: String(data.get("issueId") ?? ""),
      publicTitle: String(data.get("publicTitle") ?? ""), publicBody: String(data.get("publicBody") ?? ""),
      reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID() };
    successMessage = "客户可见问题已发布；入口只显示本次明确填写的标题和说明。";
  } else if (form.classList.contains("client-question-transition")) {
    const data = new FormData(form);
    path = `/v1/ops/client-portal/questions/${encodeURIComponent(form.dataset.questionId)}/transitions`;
    body = { action: String(data.get("action") ?? ""), reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID() };
    successMessage = body.action === "resolve" ? "客户可见问题已解决。" : "客户可见问题已撤回。";
  } else if (form.classList.contains("demo-form-revoke")) {
    const data = new FormData(form);
    path = `/v1/ops/demo-form/invitations/${encodeURIComponent(form.dataset.invitationId)}/revoke`;
    body = { reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID() };
    successMessage = "邀请已撤销，原链接不再能提交资料。";
  } else return;
  await submitDemoForm(path, body, successMessage, form.id === "demo-form-invitation-form");
}

async function submitDemoForm(path, body, successMessage, revealLink) {
  state.demoFormSubmitting = true;
  $("#demo-form-view").querySelectorAll("button,input,select,textarea").forEach((control) => { control.disabled = true; });
  hideNotice();
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(demoFormError(result));
    if (revealLink && result.submissionUrl) renderIssuedDemoLink(result.submissionUrl);
    await loadDemoForm();
    showNotice(result.outcome === "duplicate" ? "该操作此前已记录。" : successMessage, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "演示入口操作未完成。", true);
  } finally {
    state.demoFormSubmitting = false;
    if (state.demoForm) renderDemoForm();
    $("#demo-form-issued-link").querySelectorAll("button").forEach((control) => { control.disabled = false; });
  }
}

function renderIssuedDemoLink(submissionUrl) {
  const region = $("#demo-form-issued-link");
  region.hidden = false;
  replaceChildren(region, [
    el("strong", { text: "请现在复制：客户资料入口只在本次显示" }),
    el("p", { text: "外部测试者无需进入运营台，可查看清单、状态、问题并打开Fillout补交。只允许完全虚构资料。" }),
    el("input", { attrs: { type: "text", readonly: "", value: submissionUrl, "aria-label": "受限客户资料入口" } }),
    el("div", { className: "demo-form-link-actions" }, [
      el("button", { className: "button button-secondary", text: "复制链接", attrs: { type: "button", "data-demo-action": "copy" } }),
      el("a", { className: "button button-primary-inline", text: "打开客户入口", attrs: { href: submissionUrl, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" } }),
      el("button", { className: "text-button", text: "隐藏链接", attrs: { type: "button", "data-demo-action": "hide" } }),
    ]),
  ]);
}

async function handleDemoFormClick(event) {
  const action = event.target.closest("[data-demo-action]")?.dataset.demoAction;
  if (!action) return;
  if (action === "hide") {
    $("#demo-form-issued-link").replaceChildren();
    $("#demo-form-issued-link").hidden = true;
    return;
  }
  if (action === "copy") {
    const value = $("#demo-form-issued-link input")?.value;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); showNotice("受限演示链接已复制。", false); }
    catch { showNotice("浏览器没有允许复制，请手动选中链接。", true); }
  }
}

function demoMimeText(value) {
  return ({ "application/pdf": "PDF", "image/jpeg": "JPEG", "image/png": "PNG" })[value] ?? value;
}

function demoFormError(result) {
  return ({ active_invitation_exists: "该 Case 已有有效邀请；请先使用或撤销它。", case_not_synthetic: "该 Case 未通过纯虚构边界校验。",
    case_not_available: "Case 不存在或当前状态不允许收件。", entry_not_active: "Fillout 演示入口当前未启用。",
    connector_not_active: "受控 Form Connector 当前未启用。", period_mismatch: "所选期间与 Case 不一致。",
    idempotency_key_reused: "操作编号已用于不同请求，请刷新。", invitation_not_active: "邀请已失效或已撤销。",
    issue_not_found: "关联Issue不存在或不属于所选Case。", issue_not_actionable: "关联Issue已经结束，不能发布给提交者。",
    synthetic_scope_required: "该Case未通过纯虚构边界校验。", question_not_published: "客户问题已经结束，不能重复处理。" })[result.reason]
    ?? (result.error === "manager_required" ? "只有主管或管理员可以管理演示入口。" : result.error === "request_verification_failed" ? "安全校验失败，请刷新后重试。" : "演示入口操作未完成。");
}

function releaseApprovalText(value) { return ({ dataRegion: "数据区域", privacyRetention: "隐私与保留", budget: "预算", sharedMailbox: "共享邮箱" })[value] ?? value; }
function releaseComponentText(value) { return ({ work_package: "Work Package", work_configuration: "工作配置", case_plan: "Case 计划", classification_profile: "分类体系", classifier_release: "模型发布", source_connector: "资料来源" })[value] ?? value; }
function releaseCheckText(value) { return ({ component_snapshot_present: "固定组件", no_component_drift: "组件漂移", component_coverage: "组件覆盖",
  classifier_profile_alignment: "模型与分类体系", connector_safety_boundary: "资料来源安全边界", target_not_provisioned: "目标环境未创建",
  external_capabilities_disabled: "运行、入口与外发", synthetic_data_boundary: "纯虚构数据边界", data_region_approval: "数据区域审批",
  privacy_retention_approval: "隐私与保留审批", budget_approval: "预算审批", shared_mailbox_boundary: "共享邮箱边界",
  secret_references_only: "仅密钥位置引用" })[value] ?? value.replaceAll("_", " "); }
function uatDecisionText(value) { return ({dataRegion:"数据区域",privacyRetention:"隐私与保留",budget:"月度预算",runtimeOwner:"运行责任人"})[value]??value; }
function uatResourcePolicyText(value) { return value==="planned_after_explicit_creation_approval"?"仅计划，创建需再次批准":"付费资源禁止"; }
function uatPlanActionText(value) { return ({verify_governance_inputs:"核对治理输入",prepare_isolated_data_plane:"准备隔离数据平面",
  apply_ordered_migrations:"顺序应用迁移",register_secret_references:"登记 Secret 引用",prepare_three_services:"准备三个服务",
  configure_cost_controls:"配置费用控制",configure_thirty_day_retention:"配置30天保留",
  run_synthetic_acceptance:"运行纯虚构验收",record_go_no_go:"记录 Go / No-Go",rollback_unexposed_target_if_required:"必要时回滚未暴露目标"})[value]??value; }
function uatCheckText(value) { return ({approved_release_manifest:"已批准 Release Manifest",data_region_decision:"数据区域决定",
  privacy_retention_decision:"隐私与保留决定",budget_decision:"预算决定",runtime_owner_decision:"运行责任人",
  zero_budget_paid_resources_prohibited:"零预算与付费资源禁令",approved_budget_creation_gate:"已批准预算与独立创建闸门",real_data_reapproval_gate:"真实资料重新审批闸门",
  isolated_topology:"隔离拓扑",synthetic_data_only:"仅纯虚构数据",external_capabilities_disabled:"外部能力关闭",
  secret_references_only:"仅 Secret 引用",ordered_migration_plan:"顺序迁移与验证",acceptance_and_rollback:"验收与回滚",
  zero_side_effects:"零副作用"})[value]??value.replaceAll("_"," "); }
function uatPackageActionText(value) { return ({verify_approved_blueprint:"核对已批准蓝图",verify_zero_budget_gate:"核对零预算门禁",verify_budget_and_creation_gate:"核对预算与创建闸门",
  verify_provider_quotes:"核对 Provider 价格",
  quote_provider_cost:"评估 Provider 成本",create_railway_environment:"创建 Railway 环境",create_supabase_data_plane:"创建 Supabase 数据平面",
  apply_ordered_migrations:"顺序应用迁移",register_secret_references:"登记 Secret 引用",configure_thirty_day_cleanup:"配置 30 天清理",
  run_synthetic_acceptance:"运行纯虚构验收",rollback_unexposed_target:"回滚未暴露目标"})[value]??value.replaceAll("_"," "); }
function uatPackageCheckText(value) { return ({approved_blueprint_bound:"已通过蓝图绑定",zero_budget_gate_active:"零预算门禁有效",approved_budget_creation_gate:"预算已批准、创建仍受阻",
  all_provider_actions_disabled:"Provider 动作全部关闭",sydney_synthetic_boundary:"Sydney 与纯虚构边界",
  thirty_day_cleanup_contract:"30 天清理合同",secret_references_only:"仅 Secret 引用",
  rollback_contract_present:"回滚合同完整",zero_side_effects:"零副作用"})[value]??value.replaceAll("_"," "); }
function uatActivationDecisionText(value) { return ({customer_confirmation:"首次客户确认",budget_and_cost:"正数预算与成本证据",
  data_scope:"资料范围与真实资料许可",provisioning_window:"执行窗口",explicit_creation_authorization:"M40 资源创建明确批准"})[value]??value.replaceAll("_"," "); }
function uatActivationCheckText(value) { return ({source_package_current_and_verified:"来源部署包当前且已验证",
  zero_budget_gate_active:"当前零预算门禁",customer_confirmation:"首次客户确认",budget_and_cost:"预算与 Provider 成本",
  data_scope:"资料范围与真实资料许可",provisioning_window:"执行窗口",explicit_creation_authorization:"M40 资源创建明确批准",final_authorization_separate:"最终授权保持独立",
  zero_side_effects:"零副作用"})[value]??value.replaceAll("_"," "); }
function uatFinalActionText(value) { return ({verify_activation_approval_evidence:"核对激活审批证据",
  verify_provider_quote_and_budget:"核对Provider报价与预算",review_m33_to_proposed_change_diff:"审阅M33至拟议状态差异",
  create_railway_uat_environment:"创建Railway UAT环境",create_supabase_sydney_project:"创建Supabase Sydney项目",
  apply_ordered_migrations:"顺序应用迁移",materialize_secret_references:"解析Secret引用",
  configure_thirty_day_retention:"配置30天清理",run_synthetic_acceptance:"运行纯虚构验收",
  rollback_unexposed_target:"回滚未暴露目标"})[value]??value.replaceAll("_"," "); }
function uatFinalCheckText(value) { return ({activation_snapshot_current:"激活审批快照无漂移",
  customer_confirmation_frozen:"首次客户确认已冻结",positive_budget_covers_cost:"正数预算覆盖Provider成本",
  data_scope_explicit:"资料范围明确",bounded_execution_window:"执行窗口有界",explicit_creation_authorization:"M40 资源创建明确批准",
  all_change_steps_disabled:"变更步骤全部关闭",risk_controls_locked:"风险控制已锁定",
  request_not_submitted:"申请保持未提交",zero_side_effects:"零副作用"})[value]??value.replaceAll("_"," "); }

async function loadAccess() {
  if (state.overview?.operator?.actorType !== "admin") return;
  try {
    const response = await fetch("/v1/ops/access");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (response.status === 403) throw new Error("当前身份不再具有管理员权限。");
    if (!response.ok) throw new Error("暂时无法读取人员与访问数据。");
    state.access = await response.json();
    $("#nav-access-count").value = String(state.access.members.filter((item) => item.status === "active").length);
    renderAccess();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "人员与访问数据加载失败。", true);
  }
}

function renderAccess() {
  if (!state.access) return;
  replaceChildren($("#access-members"), state.access.members.length ? state.access.members.map(accessMemberRow) : [
    emptyState("还没有运营人员", "至少需要一名有效管理员才能管理这个组织。"),
  ]);
  replaceChildren($("#access-invitations"), state.access.invitations.length ? state.access.invitations.map(invitationRow) : [
    emptyState("还没有邀请草稿", "创建草稿只记录拟开通人员，不会发送邮件。"),
  ]);
}

function accessMemberRow(item) {
  const form = el("form", { className: "access-member", attrs: { "data-access-actor": item.id } });
  form.append(el("div", { className: "access-person" }, [
    el("strong", { text: item.displayName }),
    el("span", { text: item.email ?? "未记录邮箱" }),
    el("small", { text: item.externalIdentityLinked ? "已关联 Supabase Auth" : "尚未关联登录身份" }),
  ]));
  const select = el("select", { attrs: { name: "actorType", "aria-label": `${item.displayName}的角色` } });
  for (const [value, label] of [["staff", "员工"], ["manager", "主管"], ["admin", "管理员"]]) {
    const option = el("option", { text: label, attrs: { value } });
    if (value === item.actorType) option.selected = true;
    select.append(option);
  }
  form.append(el("div", { className: "access-role" }, [select, statusLabel(item.status)]));
  form.append(el("div", { className: "access-reason" }, [
    el("label", { text: "变更理由", attrs: { for: `access-reason-${item.id}` } }),
    el("input", { attrs: { id: `access-reason-${item.id}`, name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "记录权限变更的业务依据" } }),
  ]));
  form.append(el("div", { className: "access-actions" }, [
    el("button", { className: "button button-secondary button-small", text: "保存角色", attrs: { type: "submit", name: "action", value: "change_role" } }),
    el("button", { className: `button ${item.status === "active" ? "button-quiet" : "button-primary-inline"} button-small`,
      text: item.status === "active" ? "停用" : "恢复", attrs: { type: "submit", name: "action", value: item.status === "active" ? "deactivate" : "reactivate" } }),
  ]));
  return form;
}

function invitationRow(item) {
  const row = el("article", { className: "access-invitation" }, [
    el("div", { className: "access-person" }, [el("strong", { text: item.displayName }), el("span", { text: item.email }), el("small", { text: `${roleText(item.actorType)} · 由 ${item.createdByName} 创建` })]),
    statusLabel(item.status),
    el("p", { text: item.reason }),
  ]);
  if (item.status === "draft") {
    row.append(el("form", { className: "invitation-cancel", attrs: { "data-cancel-invitation": item.id } }, [
      el("input", { attrs: { name: "reason", required: "", minlength: "12", maxlength: "1000", placeholder: "记录取消理由" } }),
      el("button", { className: "button button-quiet button-small", text: "取消草稿", attrs: { type: "submit" } }),
    ]));
  }
  return row;
}

async function handleInvitationSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.accessSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  await submitAccess("/v1/ops/access/invitations", {
    email: String(data.get("email") ?? ""), displayName: String(data.get("displayName") ?? ""),
    actorType: String(data.get("actorType") ?? ""), reason: String(data.get("reason") ?? ""),
    idempotencyKey: crypto.randomUUID(),
  }, "邀请草稿已创建；没有发送任何邮件。", () => form.reset());
}

async function handleActorAccessSubmit(event) {
  event.preventDefault();
  const form = event.target.closest("[data-access-actor]");
  if (!form || state.accessSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  const action = event.submitter?.value;
  await submitAccess(`/v1/ops/access/actors/${encodeURIComponent(form.dataset.accessActor)}`, {
    action, actorType: String(data.get("actorType") ?? ""), reason: String(data.get("reason") ?? ""),
    idempotencyKey: crypto.randomUUID(),
  }, action === "deactivate" ? "账号已停用；其现有会话立即失效。" : action === "reactivate" ? "账号已恢复。" : "角色已更新并写入审计记录。");
}

async function handleInvitationCancel(event) {
  event.preventDefault();
  const form = event.target.closest("[data-cancel-invitation]");
  if (!form || state.accessSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  await submitAccess(`/v1/ops/access/invitations/${encodeURIComponent(form.dataset.cancelInvitation)}/cancel`, {
    reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID(),
  }, "邀请草稿已取消；没有发送任何邮件。");
}

async function submitAccess(path, body, successMessage, afterSuccess) {
  if (!state.overview?.csrfToken) return showNotice("会话安全信息缺失，请刷新后重试。", true);
  state.accessSubmitting = true;
  $("#access-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = true; });
  hideNotice();
  try {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(accessError(result));
    afterSuccess?.();
    await loadOverview(false);
    if (state.overview?.operator?.actorType === "admin") { state.view = "access"; await loadAccess(); switchView("access"); }
    showNotice(result.outcome === "duplicate" ? "该变更此前已经成功记录。" : successMessage, false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "访问变更没有保存。", true);
  } finally {
    state.accessSubmitting = false;
    $("#access-view").querySelectorAll("button, input, select, textarea").forEach((control) => { control.disabled = false; });
  }
}

function accessError(result) {
  return ({ last_admin_required: "组织必须保留至少一名有效管理员，不能执行本次变更。",
    access_unchanged: "角色或状态没有变化。", idempotency_key_reused: "操作编号已用于不同变更，请刷新后重试。",
    email_already_registered: "该邮箱已经属于现有人员。", invitation_already_exists: "该邮箱已有待处理邀请草稿。",
    invitation_not_cancellable: "该邀请已不再是可取消的草稿。", invalid_request: "请检查人员、角色和至少 12 个字符的理由。" })[result.reason]
    ?? (result.error === "admin_required" ? "只有管理员可以管理人员与访问。" : "访问变更没有保存。");
}
function roleText(value) { return ({ staff: "员工", manager: "主管", admin: "管理员" })[value] ?? value; }

async function loadSessions() {
  try {
    const response = await fetch("/v1/ops/sessions");
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (!response.ok) throw new Error("暂时无法读取会话与设备。");
    state.sessions = await response.json();
    renderSessions();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "会话数据加载失败。", true);
  }
}

function renderSessions() {
  if (!state.sessions) return;
  const active = state.sessions.sessions.filter((item) => item.status === "active");
  $("#session-scope-copy").textContent = state.sessions.canManageAll
    ? "管理员可查看组织范围；当前有 " + active.length + " 个活动会话。"
    : "只显示你的会话；当前有 " + active.length + " 个活动会话。";
  const ownOtherActive = active.filter((item) => item.actorId === state.overview?.operator?.id && !item.isCurrent).length;
  $("#session-revoke-others-form").hidden = ownOtherActive === 0;
  $("#session-cleanup-form").hidden = !state.sessions.canManageAll;
  replaceChildren($("#session-list"), state.sessions.sessions.length
    ? state.sessions.sessions.map(sessionRow)
    : [emptyState("没有会话记录", "重新登录后会在这里看到当前会话。")]);
}

function sessionRow(item) {
  const row = el("article", { className: "session-row" + (item.isCurrent ? " is-current" : "") });
  row.append(el("div", { className: "session-person" }, [
    el("strong", { text: item.actorDisplayName }),
    el("span", { text: roleText(item.actorType) + " · " + (item.sessionMode === "remembered_device" ? "个人设备 30 天" : "标准会话") }),
  ]));
  row.append(el("dl", { className: "session-times" }, [
    evidence("最近活动", formatDateTime(item.lastSeenAt)),
    evidence("到期", formatDateTime(item.expiresAt)),
  ]));
  row.append(el("div", { className: "session-state" }, [
    statusLabel(item.isCurrent ? "current_device" : item.status),
    item.status !== "active" && item.revokeReason
      ? el("small", { text: sessionRevokeReasonText(item.revokeReason) })
      : el("small", { text: item.isCurrent ? "当前浏览器正在使用" : "创建于 " + formatDateTime(item.issuedAt) }),
  ]));
  if (item.status === "active" && !item.isCurrent) {
    row.append(el("form", { className: "session-revoke-form", attrs: { "data-session-revoke": item.id } }, [
      el("label", {}, [
        el("span", { text: "撤销理由" }),
        el("input", { attrs: { name: "reason", required: "", minlength: "12", maxlength: "1000", value: "撤销不再使用或无法确认的活动设备会话。" } }),
      ]),
      el("button", { className: "button button-quiet button-small", text: "撤销此会话", attrs: { type: "submit" } }),
    ]));
  } else {
    row.append(el("div", { className: "session-no-action" }, [
      el("span", { text: item.isCurrent ? "使用侧栏“退出运营台”结束本设备会话" : "无需操作" }),
    ]));
  }
  return row;
}

async function handleSessionRevoke(event) {
  event.preventDefault();
  const form = event.target.closest("[data-session-revoke]");
  if (!form || state.sessionSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  await submitSession("/v1/ops/sessions/" + encodeURIComponent(form.dataset.sessionRevoke) + "/revoke", {
    reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID(),
  }, "该会话已撤销；对应设备下次请求时必须重新登录。");
}

async function handleOtherSessionsRevoke(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.sessionSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  await submitSession("/v1/ops/sessions/revoke-others", {
    reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID(),
  }, "其他设备会话已撤销；当前设备保持登录。");
}

async function handleSessionCleanup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (state.sessionSubmitting || !form.reportValidity()) return;
  const data = new FormData(form);
  const apply = event.submitter?.value === "apply";
  const result = await submitSession("/v1/ops/sessions/cleanup", {
    retentionDays: Number(data.get("retentionDays")), apply,
    reason: String(data.get("reason") ?? ""), idempotencyKey: crypto.randomUUID(),
  }, apply ? "已结束会话记录已按保留策略清理。" : "清理候选预览已完成。", false);
  if (result) {
    $("#session-cleanup-result").textContent = apply
      ? "已删除 " + result.deletedCount + " 条；候选 " + result.candidateCount + " 条。"
      : "候选 " + result.candidateCount + " 条；预览没有删除记录。";
  }
}

async function submitSession(path, body, successMessage, reload = true) {
  if (!state.overview?.csrfToken) { showNotice("会话安全信息缺失，请刷新后重试。", true); return null; }
  state.sessionSubmitting = true;
  $("#system-view").querySelectorAll(".session-management button, .session-management input").forEach((control) => { control.disabled = true; });
  hideNotice();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(sessionError(result));
    if (reload) await loadSessions();
    showNotice(result.outcome === "duplicate" ? "该会话操作此前已经成功记录。" : successMessage, false);
    return result;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "会话操作没有保存。", true);
    return null;
  } finally {
    state.sessionSubmitting = false;
    $("#system-view").querySelectorAll(".session-management button, .session-management input").forEach((control) => { control.disabled = false; });
  }
}

function sessionError(result) {
  return ({
    session_not_found: "会话不存在或当前身份无权管理。",
    session_not_active: "该会话已经结束，请刷新列表。",
    idempotency_key_reused: "操作编号已用于其他会话变更，请刷新后重试。",
    invalid_request: "请提供至少 12 个字符的理由。",
  })[result.outcome] ?? (result.error === "admin_required"
    ? "只有管理员可以执行会话保留清理。"
    : result.error === "request_verification_failed"
      ? "安全校验失败，请刷新后重试。"
      : "会话操作没有保存。");
}

function sessionRevokeReasonText(value) {
  return ({
    logout: "操作者已退出", actor_inactive: "身份已停用", user_revoked: "由本人撤销",
    admin_revoked: "由管理员撤销", other_devices_revoked: "撤销其他设备",
  })[value] ?? "会话已结束";
}

async function loadTasks() {
  try {
    const response = await fetch("/v1/ops/tasks");
    if (response.status === 401) {
      appShell.hidden = true;
      loginView.hidden = false;
      return;
    }
    if (!response.ok) throw new Error("无法读取任务队列。");
    state.tasks = await response.json();
    state.taskAction = null;
    renderTasks();
    $("#nav-task-count").value = String(state.tasks.tasks.filter((item) => !["completed", "cancelled"].includes(item.status)
      && (item.assignedActorId === state.tasks.operatorActorId || item.assignedActorId === null)).length);
  } catch (error) {
    replaceChildren($("#task-list"), [emptyState("任务队列暂不可用", error instanceof Error ? error.message : "请稍后重试。")]);
  }
}

function renderTasks() {
  if (!state.tasks) {
    replaceChildren($("#task-list"), [emptyState("正在读取任务", "正在核对负责人、期限和最新状态。")]);
    replaceChildren($("#task-summary"), []);
    replaceChildren($("#task-history"), []);
    return;
  }
  const now = Date.now();
  const scope = $("#task-scope-filter").value;
  const status = $("#task-status-filter").value;
  const due = $("#task-due-filter").value;
  const mine = (item) => item.assignedActorId === state.tasks.operatorActorId || item.assignedActorId === null;
  const items = state.tasks.tasks.filter((item) => {
    if (scope === "mine" && !mine(item)) return false;
    if (status === "active" && ["completed", "cancelled"].includes(item.status)) return false;
    if (status !== "active" && status !== "all" && item.status !== status) return false;
    if (due === "no_due" && item.dueAt !== null) return false;
    if (due === "overdue" && (!item.dueAt || new Date(item.dueAt).getTime() >= now || ["completed", "cancelled"].includes(item.status))) return false;
    if (due === "due_soon" && (!item.dueAt || new Date(item.dueAt).getTime() < now || new Date(item.dueAt).getTime() > now + 7 * 86400000)) return false;
    return true;
  });
  const active = state.tasks.tasks.filter((item) => !["completed", "cancelled"].includes(item.status));
  const owned = active.filter((item) => item.assignedActorId === state.tasks.operatorActorId);
  const available = active.filter((item) => item.status === "open" && item.assignedActorId === null);
  const overdue = active.filter((item) => item.dueAt && new Date(item.dueAt).getTime() < now);
  replaceChildren($("#task-summary"), [
    taskSummaryItem(owned.length, "分派给我"),
    taskSummaryItem(available.length, "可领取"),
    taskSummaryItem(overdue.length, "已逾期", overdue.length ? "is-alert" : ""),
    taskSummaryItem(active.length, "团队未完成"),
  ]);
  replaceChildren($("#task-list"), items.length ? items.map(taskRow) : [emptyState("没有符合条件的任务", "调整范围、状态或期限筛选即可查看其他任务。")]);
  replaceChildren($("#task-history"), state.tasks.recentTransitions.length
    ? state.tasks.recentTransitions.map(taskHistoryRow)
    : [emptyState("还没有任务变化", "第一次领取任务后，这里会出现不可变审计记录。")]);
}

function taskSummaryItem(value, label, className = "") {
  return el("div", { className }, [el("strong", { text: String(value) }), el("span", { text: label })]);
}

function taskRow(item) {
  const isMine = item.assignedActorId === state.tasks.operatorActorId;
  const actions = [];
  if (item.status === "open" && item.assignedActorId === null) actions.push(taskActionButton("领取", "claim", "button-primary-inline"));
  if (item.status === "open" && isMine) actions.push(taskActionButton("开始处理", "start", "button-primary-inline"));
  if (item.status === "in_progress" && isMine) {
    actions.push(taskActionButton("转为等待", "wait", "button-secondary"));
    actions.push(taskActionButton("完成任务", "complete", "button-primary-inline"));
  }
  if (item.status === "waiting" && isMine) actions.push(taskActionButton("恢复处理", "resume", "button-primary-inline"));
  if (state.tasks.canManage && ["open", "waiting", "in_progress"].includes(item.status)) actions.push(taskActionButton("重新分派", "reassign", "button-quiet"));
  if (state.tasks.canManage && item.status === "completed") actions.push(taskActionButton("主管重开", "reopen", "button-secondary"));
  const article = el("article", { className: "task-row", attrs: { "data-task-id": item.id } }, [
    el("div", { className: "task-row-heading" }, [
      el("div", {}, [el("span", { className: "task-eyebrow", text: taskTypeText(item.taskType) }), el("h3", { text: item.subjectName }), el("p", { text: `${period(item)} · 任务 ${shortId(item.id)}` })]),
      statusLabel(item.status),
    ]),
    el("dl", { className: "task-facts" }, [
      evidence("负责人", item.assignedActorName ?? "未分派"),
      evidence("到期", item.dueAt ? formatDateTime(item.dueAt) : "未设置"),
      evidence("最近更新", formatDateTime(item.updatedAt)),
      evidence("外部执行", "关闭"),
    ]),
    el("div", { className: "task-actions" }, [
      el("button", { className: "text-button", text: "打开来源 Case", attrs: { type: "button", "data-task-case": item.caseId } }),
      ...actions,
    ]),
  ]);
  if (state.taskAction?.taskId === item.id) article.append(taskTransitionForm(item, state.taskAction.action));
  return article;
}

function taskActionButton(label, action, className) {
  return el("button", { className: `button button-small ${className}`, text: label, attrs: { type: "button", "data-task-action": action } });
}

function taskTransitionForm(item, action) {
  const labels = { claim: "领取任务", start: "开始处理", wait: "转为等待", resume: "恢复处理", complete: "完成任务", reassign: "重新分派", reopen: "主管重开" };
  const reasons = {
    claim: "我已确认任务范围，现在领取并负责后续处理。",
    start: "已核对来源 Case 和任务范围，现在开始处理。",
    wait: "当前需要等待内部资料或条件满足后再继续处理。",
    resume: "等待条件已经满足，现在恢复任务处理。",
    complete: "任务范围内的工作已经完成，并已核对结果。",
    reassign: "根据当前团队分工，将任务重新分派给指定负责人。",
    reopen: "主管复核发现任务仍需继续处理，因此重新打开。",
  };
  const children = [el("div", {}, [el("strong", { text: labels[action] }), el("p", { text: "提交后会原子更新任务，并追加操作者、理由和前后状态审计。" })])];
  if (["reassign", "reopen"].includes(action)) {
    const select = el("select", { attrs: { name: "assignedActorId", required: "" } }, state.tasks.assignees.map((actor) => el("option", { text: `${actor.displayName} · ${statusText(actor.actorType)}`, attrs: { value: actor.id } })));
    select.value = item.assignedActorId ?? state.tasks.operatorActorId;
    children.push(el("label", {}, [el("span", { text: "负责人" }), select]));
  }
  const textarea = el("textarea", { attrs: { name: "reason", required: "", minlength: "12", maxlength: "1000", rows: "2" } });
  textarea.value = reasons[action];
  children.push(el("label", { className: "task-reason" }, [el("span", { text: "操作理由" }), textarea]));
  children.push(el("div", { className: "task-form-actions" }, [
    el("button", { className: "button button-primary-inline button-small", text: `确认${labels[action]}`, attrs: { type: "submit" } }),
    el("button", { className: "button button-quiet button-small", text: "取消", attrs: { type: "button", "data-task-cancel": "" } }),
  ]));
  return el("form", { className: "task-transition-form", attrs: { "data-task-transition": item.id, "data-task-transition-action": action, "data-idempotency-key": crypto.randomUUID() } }, children);
}

function taskHistoryRow(item) {
  const assignment = item.previousAssignedActorName === item.resultingAssignedActorName
    ? (item.resultingAssignedActorName ?? "未分派")
    : `${item.previousAssignedActorName ?? "未分派"} → ${item.resultingAssignedActorName ?? "未分派"}`;
  return el("article", { className: "task-history-row" }, [
    el("div", {}, [el("strong", { text: `${taskActionText(item.action)} · ${item.actorName}` }), el("p", { text: item.reason })]),
    el("div", {}, [el("span", { text: `${statusText(item.previousStatus)} → ${statusText(item.resultingStatus)}` }), el("span", { text: `负责人：${assignment}` })]),
    el("div", {}, [el("time", { text: formatDateTime(item.transitionedAt) }), el("code", { text: `事件 ${shortId(item.eventId)}` })]),
  ]);
}

async function handleTaskClick(event) {
  const caseButton = event.target.closest("[data-task-case]");
  if (caseButton) return await openCase(caseButton.dataset.taskCase);
  const cancel = event.target.closest("[data-task-cancel]");
  if (cancel) { state.taskAction = null; renderTasks(); return; }
  const button = event.target.closest("[data-task-action]");
  if (!button) return;
  const row = button.closest("[data-task-id]");
  state.taskAction = { taskId: row.dataset.taskId, action: button.dataset.taskAction };
  renderTasks();
  $("#task-list").querySelector("[data-task-transition] textarea")?.focus();
}

async function handleTaskSubmit(event) {
  const form = event.target.closest("[data-task-transition]");
  if (!form || state.taskSubmitting) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  state.taskSubmitting = true;
  form.querySelectorAll("button,select,textarea").forEach((control) => { control.disabled = true; });
  // Read the named controls directly. In the embedded operations browser a
  // dynamically rendered form can be submitted while FormData still exposes
  // an empty entry set; the visible control values remain authoritative.
  const reasonControl = form.querySelector('[name="reason"]');
  const assigneeControl = form.querySelector('[name="assignedActorId"]');
  try {
    const response = await fetch(`/v1/ops/tasks/${encodeURIComponent(form.dataset.taskTransition)}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dop-csrf": state.overview.csrfToken },
      body: JSON.stringify({
        action: form.dataset.taskTransitionAction,
        assignedActorId: String(assigneeControl?.value ?? "") || null,
        reason: String(reasonControl?.value ?? ""),
        idempotencyKey: form.dataset.idempotencyKey,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("会话已过期，请重新登录。");
    if (!response.ok) throw new Error(taskTransitionError(result));
    await loadTasks();
    showNotice(result.outcome === "duplicate" ? "该任务操作此前已经成功记录，本次没有重复写入。" : "任务状态已更新，并已追加不可变审计记录。", false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "任务操作没有保存。", true);
    form.querySelectorAll("button,select,textarea").forEach((control) => { control.disabled = false; });
  } finally { state.taskSubmitting = false; }
}

function taskTransitionError(result) {
  return ({
    idempotency_key_reused: "操作编号已用于不同的任务变化，请刷新后重试。",
    transition_not_allowed: "任务状态已经变化，当前操作不再允许。",
    manager_required: "只有主管或管理员可以改派或重开任务。",
    task_not_owned: "这项任务没有分派给当前操作者。",
    task_already_assigned: "任务已被其他人领取，请刷新队列。",
    assignee_required: "请选择新的负责人。",
    assignee_invalid: "负责人已停用、不属于当前组织或角色不适合。",
  })[result.reason] ?? ({
    invalid_identifier: "任务或操作编号无效。",
    invalid_assignee: "负责人编号无效。",
    invalid_action: "不支持这项任务操作。",
    invalid_reason: "请提供 12 至 1000 个字符的操作理由。",
    request_verification_failed: "安全校验失败，请刷新后重试。",
  })[result.error] ?? "任务操作没有保存；没有发生部分写入。";
}

function taskTypeText(value) { return ({ "document_operations.next_step": "资料完成后的下一工作" })[value] ?? value.replaceAll("_", " ").replaceAll(".", " · "); }
function taskActionText(value) { return ({ claim: "领取", start: "开始", wait: "等待", resume: "恢复", complete: "完成", reassign: "改派", reopen: "重开" })[value] ?? value; }

function renderSystem() {
  const summary = state.overview.summary;
  const healthOk = state.health?.status === "ok";
  const environment = runtimeEnvironment();
  replaceChildren($("#system-status"), [
    systemItem("Intake / Ops", healthOk ? "运行正常" : "状态待确认", healthOk ? `健康检查已返回 ${environment} 环境。` : "请刷新或查看 Railway Deployment。"),
    systemItem("数据边界", "Synthetic only", `${environment} 环境只允许纯虚构资料；真实客户资料禁止进入。`),
    systemItem("处理队列", `${summary.scheduledRetryCount} 自动重试 · ${summary.manualErrorCount} 人工`, `${summary.overdueRetryCount} 个重试已到期；外部发送仍关闭。`),
  ]);
  const retryQueue = state.overview.retryQueue ?? [];
  replaceChildren($("#retry-queue"), retryQueue.length ? retryQueue.map(workflowErrorRow) : [
    emptyState("队列已清空", "当前没有待重试或需要技术人工处理的 Workflow Error。"),
  ]);
  const activity = state.overview.recentActivity;
  replaceChildren($("#activity-list"), activity.length ? activity.map((item) => el("article", { className: "activity-row" }, [
    el("div", { className: "row-title" }, [el("strong", { text: eventText(item.eventType) }), el("span", { text: `${item.aggregateType} · ${shortId(item.aggregateId)}` })]),
    el("span", { text: formatDateTime(item.occurredAt) }),
  ])) : [emptyState("还没有业务事件", "接收第一份 Canonical Submission 后会产生事件。")]);
}

function workflowErrorRow(item) {
  return el("article", { className: "workflow-error-row" }, [
    el("div", { className: "row-title" }, [
      el("strong", { text: item.filename ?? `工作项 ${shortId(item.id)}` }),
      el("span", { text: item.subjectName ?? "未关联客户资料" }),
    ]),
    el("div", { className: "workflow-error-cause" }, [
      el("strong", { text: moduleText(item.moduleId) }),
      el("code", { text: item.errorCode }),
    ]),
    el("div", { className: "workflow-error-state" }, [
      statusLabel(item.status),
      el("span", { text: `已重试 ${item.retryCount} 次 · ${statusText(item.errorClass)}` }),
    ]),
    el("div", { className: "workflow-error-next" }, [
      el("strong", { text: workflowErrorNextAction(item) }),
      el("span", { text: `发现于 ${formatDateTime(item.openedAt)}` }),
    ]),
  ]);
}

function workflowErrorNextAction(item) {
  if ([
    "project_spend_limit_exceeded",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "billing_hard_limit_reached",
    "credit_balance_exhausted",
    "insufficient_quota",
  ].includes(item.errorCode)) return "额度熔断已阻止自动重试；管理员核对限额后再恢复分类服务";
  if (["open", "waiting_manual"].includes(item.status)) return "运营人员检查输入或原件";
  if (!item.nextRetryAt || new Date(item.nextRetryAt).getTime() <= Date.now()) return "已到期，Worker 下一轮领取";
  return `${formatDateTime(item.nextRetryAt)} 自动重试`;
}

function moduleText(value) {
  return ({ "preserve-document": "文件保存", "classify-document": "AI 分类" })[value] ?? "工作流处理";
}

function statusLabel(value) {
  const tone = ["overdue", "blocked", "failed_manual", "critical", "high", "incomplete", "rejected"].includes(value) ? "is-danger"
    : ["due_soon", "review_required", "waiting_external", "waiting_manual", "medium"].includes(value) ? "is-warning"
    : ["ready", "accepted", "completed", "complete", "approved", "normal", "low"].includes(value) ? "is-success" : "is-info";
  return el("span", { className: `status-label ${tone}`, text: statusText(value) });
}

function evidence(label, value) { return el("div", {}, [el("dt", { text: label }), el("dd", { text: value })]); }
function systemItem(label, value, description) { return el("div", { className: "system-item" }, [el("span", { text: label }), el("strong", { text: value }), el("p", { text: description })]); }
function emptyState(title, description) { return el("div", { className: "empty-state" }, [el("strong", { text: title }), el("p", { text: description })]); }

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

function replaceChildren(target, children) { target.replaceChildren(...children); }
function showNotice(message, error) { notice.textContent = message; notice.hidden = false; notice.style.background = error ? "var(--red-soft)" : "var(--lichen)"; }
function hideNotice() { notice.hidden = true; notice.textContent = ""; }
function showLoginError(message) { loginError.textContent = message; loginError.hidden = false; }
function period(item) { return item.periodStart && item.periodEnd ? `${item.periodStart} – ${item.periodEnd}` : item.periodStart ?? item.periodEnd ?? "未设置期间"; }
function requirementAria(item) { return item.requirements.map((r) => `${r.displayName}：已接受 ${r.acceptedCount}，最低 ${r.minimumCount}${r.reviewCount ? `，待复核 ${r.reviewCount}` : ""}`).join("；"); }
function formatDate(value) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", timeZone: "Pacific/Auckland" }).format(new Date(value)); }
function formatTime(value) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" }).format(new Date(value)); }
function formatDateTime(value) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" }).format(new Date(value)); }
function formatBytes(value) {
  if (value === null || value === undefined) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function weekday(value) { return new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "Pacific/Auckland" }).format(new Date(value)); }
function shortId(value) { return `${value.slice(0, 8)}…`; }

function statusText(value) {
  return ({
    normal: "正常", due_soon: "临近截止", overdue: "已逾期", blocked: "已阻断",
    not_started: "未开始", waiting_for_documents: "等待资料", review_required: "需要复核", ready: "已齐备",
    in_progress: "处理中", waiting: "等待中", completed: "已完成", cancelled: "已取消", accepted: "已接受",
    failed_manual: "需要人工处理", failed_recoverable: "系统重试中", human_confirmed: "人工已确认", open: "开放", assigned: "已分配",
    waiting_external: "等待客户", waiting_internal: "等待内部", reopened: "已重新打开", closed: "已关闭", resolved: "已解决",
    succeeded: "成功", retry_scheduled: "已计划重试", waiting_manual: "等待人工", duplicate_skipped: "重复项已跳过", excluded: "已从 Case 排除",
    critical: "严重", high: "高", medium: "中", low: "低",
    validation: "输入校验", business: "业务规则", connector: "连接器", provider: "AI 提供方",
    permission: "权限", rate_limit: "速率限制", timeout: "超时", unknown: "未知原因",
    active: "有效", inactive: "已停用", paused: "暂停", offboarding: "移交中", draft: "草稿",
    staff: "员工", manager: "主管", admin: "管理员",
    in_review: "待复核", changes_requested: "需要修订", rejected: "已拒绝", superseded: "已被替代",
    published: "已发布", retired: "已停用", provisioned: "已开通", previewed: "待批准", approved: "已批准",
    suspended: "已暂停", revoked: "已撤销", expired: "已过期", current_device: "当前设备", passed: "通过", failed: "失败",
    pending: "待更新", not_required: "不需要", incomplete: "资料未齐", complete: "已齐备", missing: "缺少",
    excess: "超量", attention: "需留意", matched: "已匹配", duplicate: "重复", unmatched: "未归属", processing: "处理中",
    planned: "已规划", queued: "已排队", leased: "已取得租约", provider_accepted: "服务商已接受",
    delivered: "已送达", deferred: "已延迟", bounced: "已退信", complained: "被投诉", outcome_unknown: "结果未知",
  })[value] ?? value.replaceAll("_", " ");
}

function reasonText(value) {
  if (!value) return "未记录";
  return value.split(",").map((part) => ({
    low_confidence: "AI 置信度低于规则阈值",
    policy_requires_human_confirmation: "业务规则要求人工确认",
    quality_flags_present: "存在文件质量标记",
    conflict_flags_present: "存在客户、期间或类型冲突",
    quality_rule_matched: "命中文件质量复核规则",
    conflict_rule_matched: "命中冲突复核规则",
    operator_requested_information: "人工要求补充资料",
    operator_excluded_wrong_subject: "文件不属于当前客户，已从 Case 排除",
    operator_excluded_wrong_period: "文件不属于当前期间，已从 Case 排除",
    operator_excluded_irrelevant_or_unknown: "无关或未知资料，已从 Case 排除",
    completeness_missing: "资料清单存在缺件",
    completeness_duplicate: "同内容资料重复",
    completeness_excess: "资料数量超过上限",
    completeness_review_required: "资料需要人工确认",
    completeness_unmatched: "资料未归属到清单要求",
  })[part] ?? part.replaceAll("_", " ")).join("；");
}

function issueName(item) {
  const exception = item.completenessException;
  if (exception?.exceptionType === "missing") return `缺少 ${exception.displayName ?? exception.requirementCode ?? "资料"}（${exception.quantity} 份）`;
  return item.routingReason ? reasonText(item.routingReason) : item.issueType.replaceAll("_", " ");
}
function eventText(value) {
  return ({
    "Submission.Accepted": "已接受一批资料",
    "Document.Queued": "资料已进入处理队列",
    "Document.Stored": "原件已保存到私有存储",
    "Document.StorageFailed": "原件保存失败",
    "Document.Classified": "资料分类已完成",
    "Document.ClassificationFailed": "资料分类失败",
    "Document.ReviewRequired": "资料需要人工复核",
    "Document.HumanConfirmed": "人工确认了资料分类",
    "Document.Reclassified": "人工修改了资料分类",
    "Document.InformationRequested": "人工标记为需要补充",
    "Document.ExcludedFromCase": "主管将错客户文件从当前 Case 排除",
    "Document.ReviewReopened": "主管重新打开了人工决定",
    "Issue.StatusChanged": "人工更新了问题状态",
    "Task.Created": "已创建下一任务",
    "Task.Claimed": "操作者领取了任务",
    "Task.Started": "负责人开始处理任务",
    "Task.Waiting": "负责人将任务转为等待",
    "Task.Resumed": "负责人恢复处理任务",
    "Task.Completed": "负责人完成了任务",
    "Task.Reassigned": "主管重新分派了任务",
    "Task.Reopened": "主管重新打开了任务",
    "Issue.CompletenessOpened": "完整性引擎创建了问题",
    "Issue.CompletenessReopened": "完整性异常再次出现",
    "Issue.CompletenessResolved": "完整性异常已消失",
    "MissingDocumentRequest.DraftCreated": "系统生成了补件请求草稿",
    "MissingDocumentRequest.DraftSuperseded": "旧补件草稿已被新证据替代",
    "MissingDocumentRequest.RevisionCreated": "补件草稿生成了新修订",
    "MissingDocumentRequest.ReviewSubmitted": "补件草稿进入独立复核",
    "MissingDocumentRequest.ChangesRequested": "补件草稿被退回修订",
    "MissingDocumentRequest.Approved": "补件草稿通过内部批准",
    "MissingDocumentRequest.Rejected": "补件草稿被拒绝",
    "Identity.InvitationDrafted": "管理员创建了邀请草稿",
    "Identity.InvitationCancelled": "管理员取消了邀请草稿",
    "Actor.RoleChanged": "管理员更新了人员角色",
    "Actor.Deactivated": "管理员停用了账号",
    "Actor.Reactivated": "管理员恢复了账号",
    "Subject.Onboarded": "管理员建立了工作对象与配置草稿",
    "Case.CreatedFromConfiguration": "主管从已发布配置创建了 Case",
    "CasePlan.DraftCreated": "管理员创建了 Case 计划草稿",
    "CasePlan.DraftUpdated": "管理员更新了 Case 计划草稿",
    "CasePlan.ReviewRequested": "Case 计划进入发布复核",
    "CasePlan.ReviewReturned": "Case 计划退回草稿",
    "CasePlan.Published": "Case 计划已发布",
    "CasePlan.PreviewCreated": "主管生成了固定 Case 预览",
    "CasePlan.PreviewApproved": "主管批准了固定 Case 预览",
    "Case.CreatedFromPlan": "已批准计划创建了 Case",
    "WorkPackage.Created": "管理员创建了 Work Package 草稿",
    "WorkPackage.DraftRevised": "管理员保存了 Work Package 新修订",
    "WorkPackage.VersionCloned": "管理员建立了 Work Package 下一版",
    "WorkPackage.DryRunCompleted": "Work Package 完成虚构样本 dry-run",
    "WorkPackage.SubmittedForReview": "Work Package 进入发布复核",
    "WorkPackage.ReturnedToDraft": "Work Package 已退回草稿",
    "WorkPackage.Published": "Work Package 已发布",
    "WorkPackage.Retired": "Work Package 已停用",
  })[value] ?? value;
}

bootstrap();
