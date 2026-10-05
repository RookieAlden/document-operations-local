import { createHash } from "node:crypto";
import { request as httpRequest, createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClientPortalRouter } from "../src/http/client-portal-router.js";
import type { ClientPortalReadResult, ClientPortalRepository } from "../src/ports/client-portal-repository.js";

const token="portal-token-with-more-than-forty-base64url-characters-123";
const servers:Server[]=[];

class StubRepository implements ClientPortalRepository{
  reads:{tokenSha256:string;correlationId:string;now:Date}[]=[];
  result:ClientPortalReadResult={outcome:"authorized",providerFormId:"synthetic-fillout-form",periodKey:"2027-Q2",snapshot:{
    organizationName:"Harbour Ledger Studio",subjectName:"Blue Peak Consulting Limited",periodKey:"2027-Q2",
    caseStatus:"waiting_for_documents",portalStatus:"needs_action",isComplete:false,uploadAllowed:true,
    validUntil:"2026-08-27T00:00:00.000Z",remainingSubmissions:5,requiredCount:2,acceptedRequirementCount:1,
    processingDocumentCount:0,reviewDocumentCount:0,acceptedDocumentCount:1,requirements:[{code:"bank_statement",displayName:"Bank Statement",
      minimumCount:1,acceptedCount:1,missingCount:0,reviewCount:0,status:"accepted"},{code:"invoice",displayName:"Invoice",
      minimumCount:1,acceptedCount:0,missingCount:1,reviewCount:0,status:"missing"}],documents:[{filename:"synthetic-bank.pdf",
      submittedAt:"2026-08-20T01:00:00.000Z",updatedAt:"2026-08-20T01:01:00.000Z",status:"accepted",noteCode:null}],
    questions:[{title:"请补交发票",body:"请补交一份完全虚构的本期销售发票。",requestedAction:"supplement",status:"published",
      publishedAt:"2026-08-20T01:02:00.000Z"}],updatedAt:"2026-08-20T01:02:00.000Z",
  }};
  async read(tokenSha256:string,correlationId:string,now:Date){this.reads.push({tokenSha256,correlationId,now});return this.result;}
}

afterEach(async()=>{await Promise.all(servers.splice(0).map((server)=>new Promise<void>((resolve)=>server.close(()=>resolve()))));});

async function start(environment:"DEV"|"UAT"|"PROD"="UAT"){
  const repository=new StubRepository();
  const router=new ClientPortalRouter({repository,environment,staticDirectory:fileURLToPath(new URL("../public/client-portal",import.meta.url)),
    now:()=>new Date("2026-08-20T02:00:00.000Z")});
  const server=createServer(async(request,response)=>{if(!await router.handle(request,response)){response.statusCode=404;response.end();}});
  await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));servers.push(server);return {server,repository};
}

async function call(server:Server,path:string,authorization?:string){
  const address=server.address();if(!address||typeof address==="string")throw new Error("server did not bind");
  return await new Promise<{status:number;headers:Record<string,string|string[]|undefined>;text:string}>((resolve,reject)=>{
    const request=httpRequest({host:"127.0.0.1",port:address.port,path,headers:authorization?{authorization}:{}},(response)=>{
      const chunks:Buffer[]=[];response.on("data",(chunk:Buffer)=>chunks.push(chunk));response.on("end",()=>resolve({
        status:response.statusCode??0,headers:response.headers,text:Buffer.concat(chunks).toString("utf8"),
      }));
    });request.on("error",reject);request.end();
  });
}

describe("client submission portal boundary",()=>{
  it("serves a no-index, no-store, same-origin portal shell",async()=>{
    const {server}=await start();const response=await call(server,"/submit");
    expect(response.status).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toContain("noindex");expect(response.headers["content-security-policy"]).not.toContain("frame-src");
    expect(response.text).toContain("资料提交入口");expect(response.text).not.toContain("<iframe");
    expect(response.text).toContain("打开新的上传页面");expect(response.text).toContain("JPG、JPEG和PNG");
  });

  it("projects a safe UAT snapshot and builds the governed Fillout supplement URL",async()=>{
    const {server,repository}=await start();const response=await call(server,"/v1/client-portal/case",`DOP-Portal ${token}`);
    expect(response.status).toBe(200);const body=JSON.parse(response.text);
    expect(body).toMatchObject({subjectName:"Blue Peak Consulting Limited",portalStatus:"needs_action",remainingSubmissions:5});
    expect(body.submissionUrl).toBe(`https://forms.fillout.com/t/synthetic-fillout-form?dop_invitation=${token}&period=2027-Q2`);
    expect(body.questions[0]).toMatchObject({title:"请补交发票",requestedAction:"supplement"});
    expect(JSON.stringify(body)).not.toContain("routing_reason");expect(JSON.stringify(body)).not.toContain("confidence");
    expect(repository.reads[0]?.tokenSha256).toBe(createHash("sha256").update(token).digest("hex"));
    expect(response.text).not.toContain(repository.reads[0]?.tokenSha256);
  });

  it("returns one generic error for missing, blocked, or non-UAT access",async()=>{
    const missing=await start();expect((await call(missing.server,"/v1/client-portal/case")).status).toBe(401);
    missing.repository.result={outcome:"blocked",reason:"link_unavailable"};
    const blocked=await call(missing.server,"/v1/client-portal/case",`DOP-Portal ${token}`);
    expect(blocked.status).toBe(401);expect(JSON.parse(blocked.text)).toEqual({error:"link_unavailable"});
    const dev=await start("DEV");expect((await call(dev.server,"/v1/client-portal/case",`DOP-Portal ${token}`)).status).toBe(404);
    expect(dev.repository.reads).toHaveLength(0);
  });
});
