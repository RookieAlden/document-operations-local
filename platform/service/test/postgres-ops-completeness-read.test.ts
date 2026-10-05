import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresOpsReadRepository } from "../src/adapters/postgres/postgres-ops-read-repository.js";

class CompletenessReadClient {
  statements:string[]=[];

  async query(text:string):Promise<{rowCount:number;rows:Array<Record<string,unknown>>}> {
    const sql=text.replace(/\s+/g," ").trim();
    this.statements.push(sql);
    if(sql.startsWith("SELECT dop_set_organization_context($1) AS id")) return result([{id:"org-1"}]);
    if(sql.startsWith("SELECT id FROM actors")) return result([{id:"actor-1"}]);
    if(sql.includes("FROM cases c")&&sql.includes("latest_completeness")) return result([{
      id:"case-1",subject_key:"synthetic-client",subject_name:"Synthetic Client",period_start:"2026-08-01",
      period_end:"2026-08-31",status:"review_required",risk_status:"normal",due_at:null,
      accepted_requirement_count:1,required_requirement_count:2,document_count:2,open_issue_count:0,
      requirements:[{requirementCode:"bank.minimum",documentTypeCode:"bank_statement",displayName:"Bank statement",
        minimumCount:2,maximumCount:2,acceptedCount:1,missingCount:1,reviewCount:0,duplicateCount:1,excessCount:0,status:"missing"}],
      completeness_id:"assessment-1",completeness_status:"review_required",completeness_algorithm_version:"1.0",
      completeness_input_hash:"a".repeat(64),completeness_matched_document_count:1,
      completeness_missing_requirement_count:1,completeness_duplicate_document_count:1,
      completeness_excess_document_count:0,completeness_review_required_document_count:0,
      completeness_unmatched_document_count:0,completeness_active_submission_count:0,
      completeness_created_at:"2026-08-09T10:00:00.000Z",
    }]);
    if(sql.startsWith("WITH ranked AS")&&sql.includes("latest_match.match_status")) return result([{
      id:"document-1",original_filename:"synthetic-bank.pdf",declared_mime_type:"application/pdf",
      detected_mime_type:"application/pdf",size_bytes:128,status:"accepted",document_type_code:"bank_statement",
      document_type_name:"Bank statement",confidence:"0.99",review_reason:null,
      created_at:"2026-08-09T09:00:00.000Z",updated_at:"2026-08-09T10:00:00.000Z",preview_available:true,
      content_group_size:2,content_group_position:2,filename_group_size:1,filename_group_position:1,
      attempt_number:1,attempt_status:"succeeded",attempt_error_code:null,
      attempt_started_at:"2026-08-09T09:30:00.000Z",attempt_completed_at:"2026-08-09T09:31:00.000Z",
      active_error_code:null,active_error_class:null,active_error_status:null,retry_count:null,next_retry_at:null,error_opened_at:null,
      match_status:"duplicate",match_requirement_code:"bank.minimum",match_duplicate_kind:"same_content",
      match_is_excess:false,match_counts_toward_minimum:false,match_reason_code:"same_content_duplicate",
    }]);
    if(sql.includes("FROM issues i")) return result([]);
    if(sql.includes("FROM missing_document_request_drafts draft")) return result([{
      id:"draft-1",assessment_id:"assessment-1",draft_version:1,status:"draft",
      recipient_snapshot:{resolutionStatus:"unresolved",displayName:null,email:null},
      subject_line:"Synthetic Client｜资料补充清单｜2026-08-01 至 2026-08-31",
      body_text:"Synthetic Client，您好：\n\n仍需 Bank statement。",
      requested_items:[{requirementCode:"bank.minimum",documentTypeCode:"bank_statement",displayName:"Bank statement",missingCount:1}],
      source_issue_count:1,content_hash:"b".repeat(64),delivery_mode:"disabled",external_call_count:0,
      created_at:"2026-08-09T10:00:00.000Z",
    }]);
    if(sql.includes("FROM subject_message_recipient_allowlist allowlist")) return result([{
      id:"allowlist-1",actor_id:"customer-1",display_name:"Synthetic Contact",
      email:"contact@example.invalid",source:"canonical_primary_contact",
      approved_at:"2026-08-09T10:00:00.000Z",
    }]);
    if(sql.includes("FROM missing_document_request_revisions revision")&&sql.includes("LEFT JOIN actors creator")) return result([{
      id:"revision-1",revision:1,status:"in_review",
      recipient_snapshot:{resolutionStatus:"ready",actorId:"customer-1",displayName:"Synthetic Contact",email:"contact@example.invalid"},
      subject_line:"Synthetic Client｜资料补充清单｜2026-08-01 至 2026-08-31",
      body_text:"Synthetic Client，您好：\n\n仍需 Bank statement。",
      content_hash:"c".repeat(64),change_reason:"Prepare the governed synthetic internal request revision.",
      created_by_actor_id:"actor-1",created_by_name:"DEV Manager",
      submitted_by_actor_id:"actor-1",submitted_by_name:"DEV Manager",
      submitted_at:"2026-08-09T10:01:00.000Z",reviewed_by_name:null,reviewed_at:null,review_reason:null,
      delivery_mode:"disabled",external_call_count:0,created_at:"2026-08-09T10:00:00.000Z",
    }]);
    if(sql.includes("FROM missing_document_request_review_decisions decision")) return result([{
      id:"decision-1",revision_id:"revision-1",action:"submitted",actor_name:"DEV Manager",
      reason:"Submit the governed synthetic request for independent review.",content_hash:"c".repeat(64),
      decided_at:"2026-08-09T10:01:00.000Z",
    }]);
    if(sql.startsWith("SELECT id, event_type")) return result([]);
    return result([]);
  }

  release():void {}
}

describe("PostgresOpsReadRepository completeness evidence",()=>{
  it("returns the latest immutable Case assessment and per-Document match",async()=>{
    const client=new CompletenessReadClient();
    const pool={connect:async()=>client} as unknown as Pool;
    const detail=await new PostgresOpsReadRepository(pool).getCaseDetail(
      "dev-accounting-firm","00000000-0000-4000-8000-000000000001",new Date("2026-08-09T10:01:00.000Z"),"actor-1",
    );
    expect(detail?.case).toMatchObject({
      acceptedRequirementCount:1,requiredRequirementCount:2,
      completeness:{status:"review_required",duplicateDocumentCount:1,missingRequirementCount:1,algorithmVersion:"1.0"},
      requirements:[{maximumCount:2,missingCount:1,duplicateCount:1,status:"missing"}],
    });
    expect(detail?.documents[0]).toMatchObject({
      relation:{kind:"same_content",position:2,total:2},
      requirementMatch:{status:"duplicate",requirementCode:"bank.minimum",duplicateKind:"same_content",countsTowardMinimum:false},
    });
    expect(detail?.missingDocumentRequestDraft).toMatchObject({
      status:"draft",version:1,deliveryMode:"disabled",externalCallCount:0,
      recipient:{resolutionStatus:"unresolved"},
      requestedItems:[{displayName:"Bank statement",missingCount:1}],
      recipientPolicy:{mode:"allowlist_only",candidates:[{actorId:"customer-1",email:"contact@example.invalid"}]},
      revisions:[{id:"revision-1",status:"in_review",deliveryMode:"disabled",externalCallCount:0}],
      reviewDecisions:[{revisionId:"revision-1",action:"submitted",actorName:"DEV Manager"}],
    });
    expect(client.statements.some((sql)=>sql.includes("case_completeness_assessments"))).toBe(true);
    expect(client.statements.at(-1)).toBe("COMMIT");
  });
});

function result(rows:Array<Record<string,unknown>>):{rowCount:number;rows:Array<Record<string,unknown>>} {
  return {rowCount:rows.length,rows};
}
