import { Pool } from "pg";
import { resolve } from "node:path";
import { PostgresCoreRepository } from "./adapters/postgres/postgres-core-repository.js";
import { PostgresDemoFormAuthorizationRepository } from "./adapters/postgres/postgres-demo-form-authorization-repository.js";
import { PostgresOpsReadRepository } from "./adapters/postgres/postgres-ops-read-repository.js";
import { PostgresOpsReviewRepository } from "./adapters/postgres/postgres-ops-review-repository.js";
import { PostgresOpsIssueRepository } from "./adapters/postgres/postgres-ops-issue-repository.js";
import { PostgresOpsTaskRepository } from "./adapters/postgres/postgres-ops-task-repository.js";
import { PostgresOpsReminderRepository } from "./adapters/postgres/postgres-ops-reminder-repository.js";
import { PostgresOpsRetentionRepository } from "./adapters/postgres/postgres-ops-retention-repository.js";
import { PostgresOpsDemoFormRepository } from "./adapters/postgres/postgres-ops-demo-form-repository.js";
import { PostgresClientPortalRepository } from "./adapters/postgres/postgres-client-portal-repository.js";
import { PostgresOpsDocumentPreviewRepository } from "./adapters/postgres/postgres-ops-document-preview-repository.js";
import { HttpDocumentPreviewBroker } from "./adapters/http/http-document-preview-broker.js";
import { HttpDocumentUploadBroker } from "./adapters/http/http-document-upload-broker.js";
import { HttpsSourceFileMetadataResolver } from "./adapters/http/https-source-file-metadata-resolver.js";
import { SupabaseOpsIdentityAuthenticator } from "./adapters/http/supabase-ops-identity-authenticator.js";
import { PostgresOpsIdentityRepository } from "./adapters/postgres/postgres-ops-identity-repository.js";
import { PostgresOpsAccessRepository } from "./adapters/postgres/postgres-ops-access-repository.js";
import { PostgresOpsConfigurationRepository } from "./adapters/postgres/postgres-ops-configuration-repository.js";
import { PostgresOpsOnboardingRepository } from "./adapters/postgres/postgres-ops-onboarding-repository.js";
import { PostgresOpsCasePlanRepository } from "./adapters/postgres/postgres-ops-case-plan-repository.js";
import { PostgresOpsWorkPackageRepository } from "./adapters/postgres/postgres-ops-work-package-repository.js";
import { PostgresOpsClassificationProfileRepository } from "./adapters/postgres/postgres-ops-classification-profile-repository.js";
import { PostgresOpsClassifierReleaseRepository } from "./adapters/postgres/postgres-ops-classifier-release-repository.js";
import { PostgresOpsSourceConnectorRepository } from "./adapters/postgres/postgres-ops-source-connector-repository.js";
import { PostgresOpsReleaseReadinessRepository } from "./adapters/postgres/postgres-ops-release-readiness-repository.js";
import { PostgresOpsUatBlueprintRepository } from "./adapters/postgres/postgres-ops-uat-blueprint-repository.js";
import { PostgresOpsMissingRequestRepository } from "./adapters/postgres/postgres-ops-missing-request-repository.js";
import { PostgresOpsSessionRepository } from "./adapters/postgres/postgres-ops-session-repository.js";
import { PostgresOpsTrialRepository } from "./adapters/postgres/postgres-ops-trial-repository.js";
import { PostgresWorkbenchRepository } from "./adapters/postgres/postgres-workbench-repository.js";
import { ResolveDocumentReview } from "./application/resolve-document-review.js";
import { TransitionIssue } from "./application/transition-issue.js";
import { TransitionTask } from "./application/transition-task.js";
import { ReceiveSubmission } from "./application/receive-submission.js";
import { ContractValidator } from "./contracts/json-schema-validator.js";
import { createIntakeServer } from "./http/intake-server.js";
import { OpsRouter } from "./http/ops-router.js";
import { OpsSessionAuthorizer } from "./http/ops-session-authorizer.js";
import { WorkbenchRouter } from "./http/workbench-router.js";
import { FormConnector } from "./connectors/forms/form-connector.js";
import { FormConnectorRouter } from "./http/form-connector-router.js";
import { ClientPortalRouter } from "./http/client-portal-router.js";
import { loadRuntimeConfig } from "./runtime/config.js";
import { postgresPoolConfig } from "./runtime/postgres-pool-config.js";

const config = loadRuntimeConfig(process.env);
const pool = new Pool(postgresPoolConfig(config.databaseUrl, config.databaseSslCaPath, 5));
const repository = new PostgresCoreRepository(pool);
const handler = new ReceiveSubmission(new ContractValidator(), repository, {
  environment: config.environment,
  organizationKey: config.organizationKey,
});
const opsTaskRepository = new PostgresOpsTaskRepository(pool);
const opsReadRepository = new PostgresOpsReadRepository(pool);
const opsIdentityRepository = new PostgresOpsIdentityRepository(pool);
const opsSessionRepository = new PostgresOpsSessionRepository(pool);
const opsSessionAuthorizer = config.opsIdentity ? new OpsSessionAuthorizer({
  organizationKey: config.organizationKey,
  sessionSecret: config.opsIdentity.sessionSecret,
  identityRepository: opsIdentityRepository,
  sessionRepository: opsSessionRepository,
}) : undefined;
const opsRouter = config.opsIdentity ? new OpsRouter({
  repository: opsReadRepository,
  identityRepository: opsIdentityRepository,
  sessionRepository: opsSessionRepository,
  sessionAuthorizer: opsSessionAuthorizer!,
  accessRepository: new PostgresOpsAccessRepository(pool),
  configurationRepository: new PostgresOpsConfigurationRepository(pool),
  onboardingRepository: new PostgresOpsOnboardingRepository(pool),
  casePlanRepository: new PostgresOpsCasePlanRepository(pool),
  workPackageRepository: new PostgresOpsWorkPackageRepository(pool),
  classificationProfileRepository: new PostgresOpsClassificationProfileRepository(pool),
  classifierReleaseRepository: new PostgresOpsClassifierReleaseRepository(pool),
  sourceConnectorRepository: new PostgresOpsSourceConnectorRepository(pool),
  releaseReadinessRepository: new PostgresOpsReleaseReadinessRepository(pool),
  uatBlueprintRepository: new PostgresOpsUatBlueprintRepository(pool),
  missingRequestRepository: new PostgresOpsMissingRequestRepository(pool),
  reminderRepository: new PostgresOpsReminderRepository(pool),
  retentionRepository: new PostgresOpsRetentionRepository(pool),
  demoFormRepository: new PostgresOpsDemoFormRepository(pool),
  identityAuthenticator: new SupabaseOpsIdentityAuthenticator({
    projectUrl: config.opsIdentity.supabaseUrl,
    publishableKey: config.opsIdentity.publishableKey,
  }),
  reviewHandler: new ResolveDocumentReview(new PostgresOpsReviewRepository(pool)),
  issueHandler: new TransitionIssue(new PostgresOpsIssueRepository(pool)),
  taskRepository: opsTaskRepository,
  taskHandler: new TransitionTask(opsTaskRepository),
  ...(config.previewBrokerUrl && config.internalPreviewToken ? {
    previewRepository: new PostgresOpsDocumentPreviewRepository(pool),
    previewBroker: new HttpDocumentPreviewBroker({
      baseUrl: config.previewBrokerUrl,
      token: config.internalPreviewToken,
    }),
    trialRepository: new PostgresOpsTrialRepository(pool),
    uploadBroker: new HttpDocumentUploadBroker({
      baseUrl: config.previewBrokerUrl,
      token: config.internalPreviewToken,
    }),
  } : {}),
  organizationKey: config.organizationKey,
  sessionSecret: config.opsIdentity.sessionSecret,
  staticDirectory: config.opsStaticDirectory ?? resolve(process.cwd(), "public/ops"),
  ...(config.clientPortalOrigin ? { clientPortalOrigin: config.clientPortalOrigin } : {}),
  secureCookie: config.opsSecureCookie,
}) : undefined;
const workbenchRouter = config.workbenchEnabled && config.opsIdentity && opsSessionAuthorizer && config.clientPortalOrigin
  ? new WorkbenchRouter({
    sessionAuthorizer: opsSessionAuthorizer,
    caseRepository: opsReadRepository,
    workbenchRepository: new PostgresWorkbenchRepository(pool),
    reviewHandler: new ResolveDocumentReview(new PostgresOpsReviewRepository(pool)),
    demoFormRepository: new PostgresOpsDemoFormRepository(pool),
    taskRepository: opsTaskRepository,
    taskHandler: new TransitionTask(opsTaskRepository),
    ...(config.previewBrokerUrl && config.internalPreviewToken ? {
      previewRepository: new PostgresOpsDocumentPreviewRepository(pool),
      previewBroker: new HttpDocumentPreviewBroker({ baseUrl: config.previewBrokerUrl, token: config.internalPreviewToken }),
      trialRepository: new PostgresOpsTrialRepository(pool),
    } : {}),
    organizationKey: config.organizationKey,
    sessionSecret: config.opsIdentity.sessionSecret,
    staticDirectory: resolve(process.cwd(), "public/workbench"),
    clientPortalOrigin: config.clientPortalOrigin,
    secureCookie: config.opsSecureCookie,
  }) : undefined;
const clientPortalRouter = config.clientPortalOrigin ? new ClientPortalRouter({
  repository: new PostgresClientPortalRepository(pool),
  staticDirectory: resolve(process.cwd(), "public/client-portal"),
  environment: config.environment,
}) : undefined;
const connectorRouter = config.formConnector ? new FormConnectorRouter({
  connector: new FormConnector({
    ...config.formConnector,
    environment: config.environment,
    organizationKey: config.organizationKey,
    sourceType: "fillout",
  }),
  receiver: handler,
  token: config.formConnector.token,
  organizationKey: config.organizationKey,
  ...(config.formConnector.demoGovernanceRequired ? {
    authorizationRepository: new PostgresDemoFormAuthorizationRepository(pool),
  } : {}),
  ...(config.formConnector.sourceMetadataAllowedHosts ? {
    fileMetadataResolver: new HttpsSourceFileMetadataResolver({
      allowedHosts: config.formConnector.sourceMetadataAllowedHosts,
    }),
  } : {}),
}) : undefined;
const server = createIntakeServer({
  handler,
  intakeToken: config.intakeToken,
  environment: config.environment,
  releaseCommit: process.env.DOP_RELEASE_COMMIT ?? null,
  ...(opsRouter ? { opsRouter } : {}),
  ...(workbenchRouter ? { workbenchRouter } : {}),
  ...(clientPortalRouter ? { clientPortalRouter } : {}),
  ...(connectorRouter ? { connectorRouter } : {}),
});

server.listen(config.port, config.host);

async function shutdown(): Promise<void> {
  server.close();
  await pool.end();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
