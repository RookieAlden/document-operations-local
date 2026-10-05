import type { Pool, PoolClient } from "pg";
import type {
  OpsDemoFormEntry,
  OpsDemoFormInvitation,
  OpsDemoFormEligibleCase,
  OpsDemoFormIssue,
  OpsClientPortalQuestion,
  OpsClientPortalQuestionMutationResult,
  OpsDemoFormMutationResult,
  OpsDemoFormRepository,
  OpsDemoFormSnapshot,
} from "../../ports/ops-demo-form-repository.js";

export class PostgresOpsDemoFormRepository implements OpsDemoFormRepository {
  constructor(private readonly pool: Pool) {}

  async getSnapshot(organizationKey: string, now: Date): Promise<OpsDemoFormSnapshot> {
    return await this.transaction(organizationKey, async (client) => {
      const entries = await client.query<{
          id:string; entry_key:string; version:number; connector_key:string; provider_form_id:string;
          status:"active"|"disabled"; allowed_mime_types:string[]; maximum_files_per_submission:number;
          maximum_declared_bytes:string|number; require_declared_bytes:boolean;
        }>(`SELECT id,entry_key,version,connector_key,provider_form_id,status,allowed_mime_types,
              maximum_files_per_submission,maximum_declared_bytes,require_declared_bytes
	             FROM demo_form_entry_versions ORDER BY created_at DESC`);
      const invitations = await client.query<{
          id:string; entry_version_id:string; case_id:string; case_key:string; subject_display_name:string;
          period_key:string; status:"active"|"revoked"|"exhausted"; used_submissions:number;
          maximum_submissions:number; valid_until:Date|string; created_at:Date|string;
        }>(`SELECT invitation.id,invitation.entry_version_id,invitation.case_id,c.case_key,
              s.display_name AS subject_display_name,invitation.period_key,invitation.status,
              invitation.used_submissions,invitation.maximum_submissions,invitation.valid_until,invitation.created_at
             FROM demo_case_invitations invitation
             JOIN cases c ON c.organization_id=invitation.organization_id AND c.id=invitation.case_id
             JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
	            ORDER BY invitation.created_at DESC LIMIT 100`);
      const cases = await client.query<{
          id:string; case_key:string; subject_display_name:string; status:string; period_key:string; submission_count:number;
        }>(`SELECT c.id,c.case_key,s.display_name AS subject_display_name,c.status,
              regexp_replace(c.case_key,'^.*\\|','') AS period_key,count(submission.id)::integer AS submission_count
             FROM cases c JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
             LEFT JOIN submissions submission ON submission.organization_id=c.organization_id AND submission.case_id=c.id
            WHERE s.status='active' AND s.attributes @> '{"synthetic":true}'::jsonb
              AND c.config_snapshot @> '{"synthetic_only":true}'::jsonb
              AND c.status IN ('not_started','waiting_for_documents','review_required','ready','in_progress')
	            GROUP BY c.id,s.display_name ORDER BY c.created_at DESC LIMIT 100`);
      const issues = await client.query<{
          id:string; case_id:string; issue_key:string; issue_type:string; status:string; document_filename:string|null;
          details:unknown;
        }>(`SELECT issue.id,issue.case_id,issue.issue_key,issue.issue_type,issue.status,
              document.original_filename AS document_filename,issue.details
             FROM issues issue
             JOIN cases c ON c.organization_id=issue.organization_id AND c.id=issue.case_id
             JOIN subjects s ON s.organization_id=c.organization_id AND s.id=c.subject_id
             LEFT JOIN documents document ON document.organization_id=issue.organization_id AND document.id=issue.document_id
            WHERE s.attributes @> '{"synthetic":true}'::jsonb
              AND issue.status IN ('open','assigned','waiting_external','waiting_internal','reopened')
	            ORDER BY issue.opened_at DESC LIMIT 200`);
      const clientQuestions = await client.query<{
          id:string; case_id:string; issue_id:string; version:number; status:"published"|"resolved"|"withdrawn";
          public_title:string; public_body:string; published_at:Date|string; concluded_at:Date|string|null;
        }>(`SELECT id,case_id,issue_id,version,status,public_title,public_body,published_at,concluded_at
	             FROM client_portal_question_versions ORDER BY published_at DESC LIMIT 200`);
      return {
        generatedAt: now.toISOString(),
        entries: entries.rows.map((row): OpsDemoFormEntry => ({
          id:row.id,entryKey:row.entry_key,version:row.version,connectorKey:row.connector_key,
          providerFormId:row.provider_form_id,status:row.status,allowedMimeTypes:row.allowed_mime_types,
          maximumFilesPerSubmission:row.maximum_files_per_submission,
          maximumDeclaredBytes:Number(row.maximum_declared_bytes),requireDeclaredBytes:row.require_declared_bytes,
        })),
        invitations: invitations.rows.map((row): OpsDemoFormInvitation => ({
          id:row.id,entryVersionId:row.entry_version_id,caseId:row.case_id,caseKey:row.case_key,
          subjectDisplayName:row.subject_display_name,periodKey:row.period_key,status:row.status,
          usedSubmissions:row.used_submissions,maximumSubmissions:row.maximum_submissions,
          validUntil:new Date(row.valid_until).toISOString(),createdAt:new Date(row.created_at).toISOString(),
        })),
        eligibleCases: cases.rows.map((row): OpsDemoFormEligibleCase => ({
          id:row.id,caseKey:row.case_key,subjectDisplayName:row.subject_display_name,status:row.status,
          periodKey:row.period_key,submissionCount:row.submission_count,
        })),
        issues: issues.rows.map((row): OpsDemoFormIssue => ({
          id:row.id,caseId:row.case_id,issueKey:row.issue_key,issueType:row.issue_type,status:row.status,
          documentFilename:row.document_filename,displayName:formatOpsClientIssueDisplayName(row.issue_type,row.document_filename,row.details),
        })),
        clientQuestions: clientQuestions.rows.map((row): OpsClientPortalQuestion => ({
          id:row.id,caseId:row.case_id,issueId:row.issue_id,version:row.version,status:row.status,
          publicTitle:row.public_title,publicBody:row.public_body,publishedAt:new Date(row.published_at).toISOString(),
          concludedAt:row.concluded_at?new Date(row.concluded_at).toISOString():null,
        })),
      };
    });
  }

  async issueInvitation(organizationKey: string, request: Parameters<OpsDemoFormRepository["issueInvitation"]>[1]): Promise<OpsDemoFormMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result=await client.query<{result:OpsDemoFormMutationResult}>(
        "SELECT dop_issue_demo_case_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS result",
        [request.actorId,request.entryVersionId,request.caseId,request.invitationTokenSha256,request.periodKey,
          request.allowInitial,request.allowSupplement,request.maximumSubmissions,request.validFrom,request.validUntil,
          request.reason,request.idempotencyKey,request.correlationId,request.now],
      );
      return result.rows[0]?.result ?? {outcome:"conflict",reason:"invalid_request"};
    });
  }

  async revokeInvitation(organizationKey: string, request: Parameters<OpsDemoFormRepository["revokeInvitation"]>[1]): Promise<OpsDemoFormMutationResult> {
    return await this.transaction(organizationKey, async (client) => {
      const result=await client.query<{result:OpsDemoFormMutationResult}>(
        "SELECT dop_revoke_demo_case_invitation($1,$2,$3,$4,$5,$6) AS result",
        [request.actorId,request.invitationId,request.reason,request.idempotencyKey,request.correlationId,request.now],
      );
      return result.rows[0]?.result ?? {outcome:"conflict",reason:"invalid_request"};
    });
  }

  async publishClientQuestion(organizationKey:string,request:Parameters<OpsDemoFormRepository["publishClientQuestion"]>[1]):Promise<OpsClientPortalQuestionMutationResult>{
    return await this.transaction(organizationKey,async(client)=>{
      const result=await client.query<{result:OpsClientPortalQuestionMutationResult}>(
        "SELECT dop_workbench_publish_client_question($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
        [request.actorId,request.caseId,request.issueId,request.publicTitle,request.publicBody,request.reason,
          request.idempotencyKey,request.correlationId,request.now],
      );
      return result.rows[0]?.result??{outcome:"conflict",reason:"invalid_request"};
    });
  }

  async transitionClientQuestion(organizationKey:string,request:Parameters<OpsDemoFormRepository["transitionClientQuestion"]>[1]):Promise<OpsClientPortalQuestionMutationResult>{
    return await this.transaction(organizationKey,async(client)=>{
      const result=request.action==="resolve"
        ?await client.query<{result:OpsClientPortalQuestionMutationResult}>(
          "SELECT dop_workbench_resolve_client_question($1,$2,$3,$4,$5,$6) AS result",
          [request.actorId,request.questionId,request.reason,request.idempotencyKey,request.correlationId,request.now],
        )
        :await client.query<{result:OpsClientPortalQuestionMutationResult}>(
          "SELECT dop_transition_client_portal_question($1,$2,$3,$4,$5,$6,$7) AS result",
          [request.actorId,request.questionId,request.action,request.reason,request.idempotencyKey,request.correlationId,request.now],
        );
      return result.rows[0]?.result??{outcome:"conflict",reason:"invalid_request"};
    });
  }

  private async transaction<T>(organizationKey:string,operation:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");const org=await client.query<{id:string|null}>(
      "SELECT dop_set_organization_context($1) AS id",[organizationKey]);
      if(!org.rows[0]?.id)throw new Error("organization_not_found");
      const result=await operation(client);await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  }
}

export function formatOpsClientIssueDisplayName(issueType:string,documentFilename:string|null,details:unknown):string {
  const exception=readObject(readObject(details)?.completenessException);
  const requirementName=readText(exception?.displayName)??readText(exception?.documentTypeCode)??readText(exception?.requirementCode);
  const documentName=documentFilename??"未命名资料";
  switch(issueType){
    case "completeness_missing": return `仍缺少：${requirementName??"清单要求的资料"}`;
    case "completeness_duplicate": return `发现重复资料：${documentName}`;
    case "completeness_excess": return `资料数量超出清单要求：${documentName}`;
    case "completeness_review_required": return `资料需要确认后才能计入清单：${documentName}`;
    case "completeness_unmatched": return `资料尚未归入清单：${documentName}`;
    case "document_classification_review": return `资料分类需要人工复核：${documentName}`;
    case "document_information_request": return `需要提交者补充说明或资料：${documentName}`;
    default: return documentFilename?`待处理资料：${documentName}`:"待处理的资料问题";
  }
}

function readObject(value:unknown):Record<string,unknown>|null {
  return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;
}

function readText(value:unknown):string|null {
  return typeof value==="string"&&value.trim().length>0?value.trim():null;
}
