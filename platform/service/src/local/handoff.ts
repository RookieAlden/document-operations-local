import type { OpsCaseDetail } from "../ports/ops-read-repository.js";
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
export function handoffHtml(detail: OpsCaseDetail): string {
  const {case: item, documents, issues, handoffTask} = detail;
  const status: Record<string,string>={accepted:"AI 分类接受",human_confirmed:"人工确认",review_required:"待复核",incoming_saved:"待分类",excluded:"已排除",failed_recoverable:"分类失败，可人工处理",failed_manual:"需人工处理",duplicate_skipped:"重复，不计数"};
  const issueType: Record<string,string>={completeness_missing:"缺少资料",completeness_review_required:"完整性复核",document_classification_review:"分类复核",classification_failed:"分类调用失败"};
  const issueStatus: Record<string,string>={open:"未处理",resolved:"已解决",dismissed:"已关闭",in_progress:"处理中"};
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(item.subjectName)} · 交接清单</title><link rel="stylesheet" href="/workbench/app.css"></head>
  <body class="handoff-export"><main class="content"><p>本地资料运营 · 虚构资料</p><h1>${item.status === "completed" ? "交接清单" : "当前清单（尚未完成交接）"}</h1>
  <h2>${escape(item.subjectName)}</h2><p>${escape(item.periodStart)} — ${escape(item.periodEnd)}</p><p>导出时间：${escape(detail.generatedAt)} · 任务编号：${escape(item.id)}</p>
  <p>可使用浏览器“打印 → 保存为 PDF”导出；本清单不包含原件内容。</p>
  <h2>资料要求</h2><table><thead><tr><th>类型</th><th>最低份数</th><th>已接受</th><th>缺少</th></tr></thead><tbody>${item.requirements.map(r=>`<tr><td>${escape(r.displayName)}</td><td>${r.minimumCount}</td><td>${r.acceptedCount}</td><td>${r.missingCount}</td></tr>`).join("")}</tbody></table>
  <h2>文件与处理结果</h2><table><thead><tr><th>文件</th><th>类型</th><th>状态</th></tr></thead><tbody>${documents.map(d=>`<tr><td>${escape(d.filename)}</td><td>${escape(d.documentTypeName ?? "未确定")}</td><td>${escape(status[d.status] ?? d.status)}</td></tr>`).join("")}</tbody></table>
  <h2>异常记录</h2><ul>${issues.map(i=>`<li>${escape(issueType[i.issueType] ?? i.issueType)} · ${escape(i.filename)} · ${escape(issueStatus[i.status] ?? i.status)}</li>`).join("") || "<li>无异常记录</li>"}</ul>
  <h2>交接任务</h2>${handoffTask ? `<p>${escape(handoffTask.name)}</p><p>负责人：${escape(handoffTask.assignedActorName)} · 截止：${escape(handoffTask.dueAt)}</p><p>${escape(handoffTask.instructions)}</p><p>完成标准：${escape(handoffTask.completionCriteria)}</p>` : "<p>尚未交接</p>"}
  </main></body></html>`;
}
