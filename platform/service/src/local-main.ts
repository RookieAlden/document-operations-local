/** Explicit local entry. Does not import cloud runtime config, workers, or providers. */
import { createServer } from "node:http";
import { timingSafeEqual, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { aiStatus, saveAISettings, localClassifier } from "./local/ai.js";
import { loadPersonalSettings } from "./local/settings.js";
import { handoffHtml } from "./local/handoff.js";
import { validLocalLogin } from "./local/fixed-login.js";
import { LocalFileStore, localKey } from "./local/file-store.js";
import { loadLocalConfig, LOCAL_ORGANIZATION } from "./local/config.js";
import { PostgresOpsReadRepository } from "./adapters/postgres/postgres-ops-read-repository.js";
import { PostgresOpsIdentityRepository } from "./adapters/postgres/postgres-ops-identity-repository.js";
import { PostgresOpsSessionRepository } from "./adapters/postgres/postgres-ops-session-repository.js";
import { PostgresOpsTrialRepository } from "./adapters/postgres/postgres-ops-trial-repository.js";
import { PostgresOpsDocumentPreviewRepository } from "./adapters/postgres/postgres-ops-document-preview-repository.js";
import { PostgresWorkbenchRepository } from "./adapters/postgres/postgres-workbench-repository.js";
import { PostgresOpsReviewRepository } from "./adapters/postgres/postgres-ops-review-repository.js";
import { ResolveDocumentReview } from "./application/resolve-document-review.js";
import { OpsSessionAuthorizer } from "./http/ops-session-authorizer.js";
import { OpsRouter } from "./http/ops-router.js";
import { PostgresOpsTaskRepository } from "./adapters/postgres/postgres-ops-task-repository.js";
import { PostgresOpsDemoFormRepository } from "./adapters/postgres/postgres-ops-demo-form-repository.js";
import { PostgresOpsIssueRepository } from "./adapters/postgres/postgres-ops-issue-repository.js";
import { TransitionTask } from "./application/transition-task.js";
import { TransitionIssue } from "./application/transition-issue.js";
import { csrfToken, safeEqual } from "./http/ops-session-security.js";
import { WorkbenchRouter } from "./http/workbench-router.js";

const home = process.env.DOP_LOCAL_HOME;
if (!home) throw new Error("DOP_LOCAL_HOME required; cloud configuration is never used");
const config = await loadLocalConfig(home);
const personal = await loadPersonalSettings(config.configHome);
const origin = `http://127.0.0.1:${config.appPort}`;
const pool = new Pool({ host: "127.0.0.1", port: config.databasePort, user: "dop_local_app",
  password: config.databasePassword, database: "dop_local_stage1", max: 5, connectionTimeoutMillis: 5000 });
const role = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls) throw new Error("unsafe_local_runtime_role");
const marker = await pool.query("SELECT value FROM dop_local_installation WHERE key='marker'");
if (marker.rows[0]?.value !== config.marker) throw new Error("local_database_marker_mismatch");
const root = fileURLToPath(new URL("../../", import.meta.url));
const reader = new PostgresOpsReadRepository(pool);
const identityStore = new PostgresOpsIdentityRepository(pool);
// This single local owner uses both consoles; public/cloud identity rules stay unchanged.
const identity = {
  async findActiveByExternalSubject(org:string,subject:string) {
    const actor=await identityStore.findActiveByExternalSubject(org,subject);
    return actor ? {...actor,platformConsoleAccess:true} : null;
  },
  async findActiveById(org:string,id:string) {
    const actor=await identityStore.findActiveById(org,id);
    return actor ? {...actor,platformConsoleAccess:true} : null;
  },
};
const sessions = new PostgresOpsSessionRepository(pool);
const authorizer = new OpsSessionAuthorizer({ organizationKey: LOCAL_ORGANIZATION,
  sessionSecret: config.sessionSecret, identityRepository: identity, sessionRepository: sessions });
const reviewHandler = new ResolveDocumentReview(new PostgresOpsReviewRepository(pool));
const taskRepository = new PostgresOpsTaskRepository(pool);
const taskHandler = new TransitionTask(taskRepository);
const trialRepository = new PostgresOpsTrialRepository(pool);
const demoFormRepository = new PostgresOpsDemoFormRepository(pool);
const store = new LocalFileStore(join(home, "originals"));
const signature = (id: string, expires: string) => createHmac("sha256", config.sessionSecret).update(`${id}|${expires}`).digest("hex");
const previewBroker = { createPreview: async (reference:string) => {
  const id=localKey(reference).documentId,expires=String(Date.now()+60000);
  return {url:`/v1/local/documents/${id}/original?expires=${expires}&signature=${signature(id,expires)}`,expiresAt:new Date(Number(expires)).toISOString()};
} };
const classifier=localClassifier(pool,store,config.configHome);
const ops = new OpsRouter({ repository: reader, identityRepository: identity, sessionRepository: sessions,
  sessionAuthorizer: authorizer, identityAuthenticator: { authenticate: async ({ email, password }) => {
    return validLocalLogin(personal.login, email, password) ? { outcome: "authenticated", externalSubjectId: "local-stage1-employee" }
      : { outcome: "invalid_credentials" };
  } }, organizationKey: LOCAL_ORGANIZATION, sessionSecret: config.sessionSecret,
  reviewHandler, taskRepository, taskHandler,
  previewBroker, previewRepository:new PostgresOpsDocumentPreviewRepository(pool),
  issueHandler: new TransitionIssue(new PostgresOpsIssueRepository(pool)),
  trialRepository: new PostgresOpsTrialRepository(pool), uploadBroker: store,
  staticDirectory: join(root, "public/ops"), secureCookie: false, localLoginUsername: personal.login.username });

const workbench = new WorkbenchRouter({ sessionAuthorizer: authorizer, caseRepository: reader,
  workbenchRepository: new PostgresWorkbenchRepository(pool),
  reviewHandler, taskRepository, taskHandler, trialRepository, demoFormRepository,
  previewRepository: new PostgresOpsDocumentPreviewRepository(pool),
  previewBroker: { createPreview: async reference => {
    const id = localKey(reference).documentId, expires = String(Date.now() + 60_000);
    return { url: `/v1/local/documents/${id}/original?expires=${expires}&signature=${signature(id, expires)}`,
      expiresAt: new Date(Number(expires)).toISOString() };
  } }, organizationKey: LOCAL_ORGANIZATION, sessionSecret: config.sessionSecret,
  staticDirectory: join(root, "public/workbench"), clientPortalOrigin: origin,
  secureCookie: false, localPersistenceOnly: true });

const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  const json = (status: number, value: unknown) => { response.statusCode = status;
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
  // Loopback binding alone does not prevent hostile websites targeting localhost.
  if (request.headers.host !== `127.0.0.1:${config.appPort}`) return json(403, { error: "local_host_required" });
  if (!["GET", "HEAD"].includes(request.method ?? "") && request.headers.origin !== origin)
    return json(403, { error: "local_origin_required" });
  delete request.headers["x-forwarded-host"]; delete request.headers["x-forwarded-proto"];
  try {
    const path = new URL(request.url ?? "/", origin).pathname;
    if (request.method === "GET" && path === "/health") return json(200, { status: "ok", environment: "LOCAL", mode: config.marker });
    if (request.method === "GET" && ["/", "/workbench", "/workbench/"].includes(path)) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      const html = (await readFile(join(root, "public/workbench/index.html"), "utf8"))
        .replace('<form id="login-form" novalidate>', '<form id="login-form" method="post" autocomplete="on" novalidate>')
        .replace('<span>工作邮箱</span>', '<span>账号</span>')
        .replace('name="email" type="email"', 'name="username" type="text" autocapitalize="none" spellcheck="false"')
        .replace('name="rememberDevice" type="checkbox"', 'name="rememberUsername" type="checkbox" checked')
        .replace('在这台设备上保持登录 30 天', '记住账号')
        .replace("<body>", '<body data-local-persistence="true">')
        .replace("高级设置在独立运营台中管理", '<a href="/ops">打开资料运营台</a>')
        .replace("当前为 UAT 虚构资料环境", "本地资料工作台 · 仅使用虚构资料")
        .replace("从客户开户开始，完成资料收集。", "从新建客户到完成资料交接。")
        .replace("这里仅提供会计人员的日常工作，不展示系统配置和技术后台。", "资料保存在本机，可查看原件、复核、处理缺件并导出清单。");
      return void response.end(html);
    }
    if (request.method === "GET" && ["/ops","/ops/"].includes(path)) {
      if (!await authorizer.authorize(request.headers.cookie)) {
        response.statusCode=302;response.setHeader("location","/workbench");return void response.end();
      }
      response.setHeader("content-type","text/html; charset=utf-8");
      response.setHeader("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
      const html=(await readFile(join(root,"public/ops/index.html"),"utf8"))
        .replace("<body>",'<body data-local-persistence="true">')
        .replace('<nav class="nav-list"', '<a href="/workbench">← 员工工作台 / 新建客户 / 上传</a><nav class="nav-list"');
      return void response.end(html);
    }
    if (request.method === "GET" && path === "/ops/favicon.svg") {
      response.setHeader("content-type", "image/svg+xml");
      return void response.end(await readFile(join(root, "public/ops/favicon.svg")));
    }
    if (path === "/v1/ops/session" && ["POST", "DELETE"].includes(request.method ?? "")) {
      await ops.handle(request, response); return;
    }
    const upload = /^\/v1\/(?:local|ops)\/cases\/([0-9a-f-]{36})\/documents$/.exec(path);
    if (request.method === "POST" && upload) { await ops.uploadDocument(request, response, upload[1]!); return; }
    const original = /^\/v1\/local\/documents\/([0-9a-f-]{36})\/original$/.exec(path);
    if (request.method === "GET" && original) {
      const session = await authorizer.authorize(request.headers.cookie);
      if (!session) return json(401, { error: "session_required" });
      const previewUrl = new URL(request.url!, origin);
      const expires = previewUrl.searchParams.get("expires") ?? "", supplied = previewUrl.searchParams.get("signature") ?? "";
      if (!/^\d{13}$/.test(expires) || Number(expires) < Date.now() || Number(expires) > Date.now() + 60_000
          || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(signature(original[1]!, expires))))
        return json(403, { error: "preview_expired_or_invalid" });
      const client = await pool.connect();
      let doc;
      try {
        await client.query("BEGIN");
        await client.query("SELECT dop_set_organization_context($1)", [LOCAL_ORGANIZATION]);
        doc = (await client.query("SELECT case_id, incoming_storage_ref, original_filename, detected_mime_type FROM documents WHERE id=$1", [original[1]])).rows[0];
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      if (!doc || !await reader.getCaseDetail(LOCAL_ORGANIZATION, doc.case_id, new Date(), session.actorId))
        return json(404, { error: "original_not_found" });
      let bytes;
      try { bytes = await store.read(doc.incoming_storage_ref); }
      catch { return json(409, { error: "original_missing_or_changed" }); }
      response.setHeader("content-type", doc.detected_mime_type);
      response.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`);
      response.setHeader("content-security-policy", "default-src 'none'; object-src 'self'; frame-src 'self'; frame-ancestors 'self'");
      response.setHeader("content-length", bytes.length);
      return void response.end(bytes);
    }
    const aiMatch=/^\/v1\/local\/documents\/([0-9a-f-]{36})\/classify$/.exec(path);
    if (path==="/v1/local/ai" || aiMatch) {
      const session=await authorizer.authorize(request.headers.cookie);
      if(!session)return json(401,{error:"session_required"});
      if(request.method==="GET" && !aiMatch) return json(200,await aiStatus(config.configHome));
      if(request.method!=="POST")return json(405,{error:"method_not_allowed"});
      if(!safeEqual(String(request.headers["x-dop-csrf"]??""),csrfToken(session.cookieValue,config.sessionSecret)))return json(403,{error:"csrf_required"});
      if(aiMatch) {
        const result=await classifier.execute({documentId:aiMatch[1]!,workerId:"local-on-demand"});
        return json(200,result);
      }
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of request) { size+=chunk.length;if(size>4096)return json(413,{error:"body_too_large"});chunks.push(chunk); }
      try { return json(200,await saveAISettings(config.configHome,JSON.parse(Buffer.concat(chunks).toString()))); }
      catch { return json(400,{error:"invalid_ai_settings"}); }
    }
    const exportMatch = /^\/v1\/local\/cases\/([0-9a-f-]{36})\/export$/.exec(path);
    if (request.method === "GET" && exportMatch) {
      const session=await authorizer.authorize(request.headers.cookie);
      if (!session) return json(401,{error:"session_required"});
      const detail=await reader.getCaseDetail(LOCAL_ORGANIZATION,exportMatch[1]!,new Date(),session.actorId);
      if (!detail) return json(404,{error:"case_not_found"});
      response.setHeader("content-type","text/html; charset=utf-8");
      response.setHeader("content-security-policy","default-src 'none'; style-src 'self'; frame-ancestors 'none'");
      return void response.end(handoffHtml(detail));
    }
    const manual = /^\/v1\/local\/documents\/([0-9a-f-]{36})\/manual$/.exec(path);
    if (request.method === "POST" && manual) {
      const session = await authorizer.authorize(request.headers.cookie);
      if (!session) return json(401, {error:"session_required"});
      if (!safeEqual(String(request.headers["x-dop-csrf"] ?? ""), csrfToken(session.cookieValue, config.sessionSecret)))
        return json(403, {error:"csrf_required"});
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query("SELECT dop_set_organization_context($1)",[LOCAL_ORGANIZATION]);
        const result=(await client.query("SELECT dop_local_prepare_manual($1,$2) result",[session.actorId,manual[1]])).rows[0].result;
        await client.query("COMMIT");
        return json(result.outcome==="conflict"?409:result.outcome==="not_found"?404:200,result);
      } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    // Remote client submission remains outside this local release.
    if (path.endsWith("/invitations")) return json(404,{error:"remote_submission_unavailable_locally"});
    if ((path.startsWith("/v1/workbench/") || path.startsWith("/workbench/")) && await workbench.handle(request,response)) return;
    const opsRead = request.method === "GET" && (path.startsWith("/ops/") || path==="/ops" ||
      ["/v1/ops/overview","/v1/ops/tasks"].includes(path) || /^\/v1\/ops\/cases\/[0-9a-f-]{36}$/.test(path));
    const opsWrite = request.method === "POST" && /^\/v1\/ops\/(reviews\/[0-9a-f-]{36}|issues\/[0-9a-f-]{36}\/transitions|tasks\/[0-9a-f-]{36}\/transitions|documents\/[0-9a-f-]{36}\/preview|cases\/[0-9a-f-]{36}\/complete|issues\/batch-transitions)$/.test(path);
    if ((opsRead || opsWrite) && await ops.handle(request,response)) return;
    json(404, { error: "not_available_in_local_release" });
  } catch (error) {
    console.error(JSON.stringify({ event: "local_request_failed", name: error instanceof Error ? error.name : "Error" }));
    json(500, { error: "local_request_failed" });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
await new Promise<void>((yes, no) => { server.once("error", no); server.listen(config.appPort, "127.0.0.1", yes); });
console.log(`Local workbench ready: ${origin}/workbench`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true;
  const closeRemaining = setTimeout(() => server.closeAllConnections(), 2000);
  closeRemaining.unref();
  await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
  clearTimeout(closeRemaining);
  await pool.end();
}
process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
