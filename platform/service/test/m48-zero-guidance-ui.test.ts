import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

async function text(path: string) { return await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"); }

describe("M48 zero-guidance product boundary", () => {
  it("renders employee exclusion and reversible correction without requiring /ops or a supervisor", async () => {
    const script = await text("../public/workbench/app.js");
    const functions = script.slice(script.indexOf("function reviewCard("), script.indexOf("function questionComposer("));
    const render = runInNewContext(`${functions}; ({reviewCard,restoreExclusionControl})`, {
      escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    });
    const file = { id: "doc", filename: "Agenda.pdf", documentTypeName: "Contractor Statement", canExclude: true,
      canResolveReview: true, reviewExplanation: [], classificationNotice: "类型尚未可靠确定（1%）；尚未计入清单。" };
    const html = render.reviewCard(file, [{ code: "invoice", name: "Invoice" }]);
    expect(html).toContain("尚未确定资料类型");
    expect(html).not.toContain('data-review-action="confirm"');
    expect(html).toContain("1%");
    for (const reason of ["wrong_subject", "wrong_period", "irrelevant_or_unknown"]) expect(html).toContain(reason);
    expect(html).toContain("请选择原因");
    expect(html).toContain("确认排除，保留原件");
    expect(html).not.toContain("由主管排除");
    expect(html).not.toContain("/ops");
    const escalated = render.reviewCard({ ...file, supervisorReviewRequested: true, canResolveReview: false }, []);
    expect(escalated).toContain('data-review-action="exclude"');
    expect(escalated).not.toContain('data-review-action="confirm"');
    expect(render.restoreExclusionControl(file)).toContain("不会直接计入清单，也不会清除原排除记录");
  });
  it("opens every upload batch in a fresh full Fillout page and refreshes on return", async () => {
    const [html, script] = await Promise.all([
      text("../public/client-portal/index.html"), text("../public/client-portal/app.js"),
    ]);
    expect(html).not.toContain("<iframe");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("PDF、JPG、JPEG和PNG");
    expect(html).toContain("不要在已经提交成功的旧页面再次提交");
    expect(script).toContain('document.addEventListener("visibilitychange", refreshAfterUpload)');
    expect(html).toContain("本页会自动更新");
  });

  it("distinguishes machine processing, human review, missing, accepted, and not-counted states", async () => {
    const [portal, workbench] = await Promise.all([
      text("../public/client-portal/app.js"), text("../public/workbench/app.js"),
    ]);
    for (const label of ["系统处理中", "待会计确认", "已接受", "需要补交", "未计入清单"]) expect(portal).toContain(label);
    expect(portal).toContain("待确认 ${item.reviewCount}");
    expect(portal).toContain("资料已经齐全，当前无需继续操作");
    expect(workbench).toContain("现在做什么");
    expect(workbench).toContain("资料齐全，可以完成本次收集");
    expect(workbench).toContain("资料收集和下一任务均已完成");
  });

  it("keeps review separate in the database client-safe projection", async () => {
    const migration = await text("../../database/migrations/061_client_portal_review_status_clarity.sql");
    expect(migration).toContain("WHEN d.status IN ('review_required','failed_manual') THEN 'in_review'");
    expect(migration).toMatch(/WHEN item\.review_count>0 THEN 'in_review'\s+WHEN item\.accepted_count>=item\.minimum_count THEN 'accepted'/);
    expect(migration).toContain("'reviewDocumentCount',reviewing_count");
    expect(migration).toContain("NOT invitation_row.synthetic_only");
    expect(migration).toContain("client_portal_access_attempts");
    expect(migration).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)/i);
  });
});
