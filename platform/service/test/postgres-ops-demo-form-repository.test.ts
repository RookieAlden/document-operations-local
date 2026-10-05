import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { formatOpsClientIssueDisplayName, PostgresOpsDemoFormRepository } from "../src/adapters/postgres/postgres-ops-demo-form-repository.js";

describe("PostgresOpsDemoFormRepository client-question labels", () => {
  it("turns a missing requirement into an operator-readable label", () => {
    expect(formatOpsClientIssueDisplayName("completeness_missing", null, {
      completenessException: { displayName: "Bank Statement", documentTypeCode: "bank_statement" },
    })).toBe("仍缺少：Bank Statement");
  });

  it("distinguishes document review and duplicate issues without exposing issue keys", () => {
    expect(formatOpsClientIssueDisplayName("document_classification_review", "invoice.pdf", {}))
      .toBe("资料分类需要人工复核：invoice.pdf");
    expect(formatOpsClientIssueDisplayName("completeness_duplicate", "invoice.pdf", {}))
      .toBe("发现重复资料：invoice.pdf");
  });

  it("uses a safe generic label when no public-facing context exists", () => {
    expect(formatOpsClientIssueDisplayName("internal_new_rule", null, { secret: "not-for-ui" }))
      .toBe("待处理的资料问题");
  });

  it("serializes tenant-scoped snapshot reads on one transaction client", async () => {
    let activeQueries=0;let maximumConcurrentQueries=0;
    const client={
      query:async(sql:string)=>{
        activeQueries+=1;maximumConcurrentQueries=Math.max(maximumConcurrentQueries,activeQueries);
        await new Promise((resolve)=>setTimeout(resolve,1));activeQueries-=1;
        return sql.includes("dop_set_organization_context")?{rows:[{id:"organization-id"}]}:{rows:[]};
      },
      release:()=>undefined,
    };
    const repository=new PostgresOpsDemoFormRepository({connect:async()=>client} as unknown as Pool);
    const snapshot=await repository.getSnapshot("uat-accounting-firm",new Date("2026-08-20T08:00:00Z"));
    expect(maximumConcurrentQueries).toBe(1);
    expect(snapshot).toMatchObject({entries:[],invitations:[],eligibleCases:[],issues:[],clientQuestions:[]});
  });

  it("offers only Cases that satisfy the same explicit synthetic boundary as invitation issuance", async () => {
    const seenSql:string[]=[];
    const client={
      query:async(sql:string)=>{
        seenSql.push(sql);
        if(sql.includes("dop_set_organization_context"))return {rows:[{id:"organization-id"}]};
        if(sql.includes("FROM cases c JOIN subjects s")&&sql.includes("LEFT JOIN submissions"))return {rows:[
          {id:"blue-peak",case_key:"uat|blue-peak|2026-Q2",subject_display_name:"Blue Peak Consulting Limited",
            status:"review_required",period_key:"2026-Q2",submission_count:3},
        ]};
        return {rows:[]};
      },
      release:()=>undefined,
    };
    const repository=new PostgresOpsDemoFormRepository({connect:async()=>client} as unknown as Pool);
    const snapshot=await repository.getSnapshot("uat-accounting-firm",new Date("2026-08-21T04:00:00Z"));

    expect(snapshot.eligibleCases.map((item)=>item.id)).toEqual(["blue-peak"]);
    const eligibleCaseSql=seenSql.find((sql)=>sql.includes("LEFT JOIN submissions"));
    expect(eligibleCaseSql).toContain(`s.attributes @> '{"synthetic":true}'::jsonb`);
    expect(eligibleCaseSql).toContain(`c.config_snapshot @> '{"synthetic_only":true}'::jsonb`);
  });
});
