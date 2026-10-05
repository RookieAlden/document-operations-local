BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
    default_timezone text NOT NULL DEFAULT 'Pacific/Auckland',
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    external_subject_id text NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('customer', 'staff', 'manager', 'admin', 'service')),
    display_name text NOT NULL,
    email text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, external_subject_id)
);

CREATE UNIQUE INDEX actors_org_email_unique
    ON actors (organization_id, lower(email))
    WHERE email IS NOT NULL;

CREATE TABLE subjects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    subject_key text NOT NULL,
    subject_type text NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'offboarding', 'closed')),
    primary_contact_actor_id uuid REFERENCES actors(id),
    attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, subject_key)
);

CREATE TABLE workflow_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    template_key text NOT NULL,
    display_name text NOT NULL,
    industry_package text,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, template_key)
);

CREATE TABLE workflow_template_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    workflow_template_id uuid NOT NULL REFERENCES workflow_templates(id),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    definition jsonb NOT NULL,
    definition_hash text NOT NULL,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workflow_template_id, version),
    UNIQUE (workflow_template_id, definition_hash)
);

CREATE TABLE document_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    code text NOT NULL,
    display_name text NOT NULL,
    allowed_mime_types text[] NOT NULL DEFAULT ARRAY[]::text[],
    extraction_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
    classification_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code)
);

CREATE TABLE requirement_sets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    set_key text NOT NULL,
    display_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, set_key)
);

CREATE TABLE requirement_set_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    requirement_set_id uuid NOT NULL REFERENCES requirement_sets(id),
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    effective_from timestamptz,
    effective_to timestamptz,
    definition_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requirement_set_id, version),
    UNIQUE (requirement_set_id, definition_hash),
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);

CREATE TABLE requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    requirement_set_version_id uuid NOT NULL REFERENCES requirement_set_versions(id),
    requirement_code text NOT NULL,
    document_type_id uuid NOT NULL REFERENCES document_types(id),
    minimum_count integer NOT NULL DEFAULT 1 CHECK (minimum_count >= 0),
    maximum_count integer CHECK (maximum_count IS NULL OR maximum_count >= minimum_count),
    acceptance_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requirement_set_version_id, requirement_code),
    UNIQUE (requirement_set_version_id, document_type_id)
);

CREATE TABLE prompt_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    prompt_key text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    provider text NOT NULL,
    model text NOT NULL,
    schema_version text NOT NULL,
    instruction_hash text NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, prompt_key, version),
    UNIQUE (organization_id, prompt_key, instruction_hash)
);

CREATE TABLE cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_key text NOT NULL,
    subject_id uuid NOT NULL REFERENCES subjects(id),
    workflow_template_version_id uuid NOT NULL REFERENCES workflow_template_versions(id),
    requirement_set_version_id uuid NOT NULL REFERENCES requirement_set_versions(id),
    prompt_version_id uuid REFERENCES prompt_versions(id),
    external_reference text,
    period_start date,
    period_end date,
    timezone text NOT NULL,
    status text NOT NULL DEFAULT 'not_started' CHECK (
        status IN ('not_started', 'waiting_for_documents', 'review_required', 'ready', 'in_progress', 'completed', 'cancelled')
    ),
    risk_status text CHECK (risk_status IS NULL OR risk_status IN ('normal', 'due_soon', 'overdue', 'blocked')),
    due_at timestamptz,
    config_snapshot jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (organization_id, case_key),
    CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE TABLE submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_id uuid NOT NULL REFERENCES cases(id),
    submission_key text NOT NULL,
    source text NOT NULL,
    source_submission_id text NOT NULL,
    status text NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'validating', 'accepted', 'processing', 'finalizing', 'completed', 'rejected', 'failed_recoverable', 'failed_manual')
    ),
    expected_document_count integer CHECK (expected_document_count IS NULL OR expected_document_count >= 0),
    terminal_document_count integer NOT NULL DEFAULT 0 CHECK (terminal_document_count >= 0),
    raw_payload_reference text,
    received_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, submission_key),
    UNIQUE (organization_id, source, source_submission_id),
    CHECK (expected_document_count IS NULL OR terminal_document_count <= expected_document_count)
);

CREATE TABLE documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_id uuid NOT NULL REFERENCES cases(id),
    submission_id uuid NOT NULL REFERENCES submissions(id),
    idempotency_key text NOT NULL,
    source_file_id text,
    original_filename text NOT NULL,
    declared_mime_type text,
    detected_mime_type text,
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
    content_hash_sha256 text,
    incoming_storage_ref text,
    archive_storage_ref text,
    accepted_document_type_id uuid REFERENCES document_types(id),
    status text NOT NULL DEFAULT 'reserved' CHECK (
        status IN ('reserved', 'downloaded', 'incoming_saved', 'classified', 'accepted', 'review_required', 'human_confirmed', 'archived', 'failed_recoverable', 'failed_manual', 'duplicate_skipped')
    ),
    classification_summary jsonb,
    review_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX documents_case_status_idx ON documents (organization_id, case_id, status);
CREATE INDEX documents_submission_status_idx ON documents (organization_id, submission_id, status);
CREATE INDEX documents_hash_idx ON documents (organization_id, content_hash_sha256) WHERE content_hash_sha256 IS NOT NULL;

CREATE TABLE classification_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    document_id uuid NOT NULL REFERENCES documents(id),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    prompt_version_id uuid NOT NULL REFERENCES prompt_versions(id),
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL CHECK (status IN ('succeeded', 'failed_recoverable', 'failed_manual')),
    predicted_document_type_code text,
    confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    result jsonb,
    raw_response_reference text,
    error_code text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    UNIQUE (document_id, attempt_number)
);

CREATE TABLE issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_id uuid NOT NULL REFERENCES cases(id),
    document_id uuid REFERENCES documents(id),
    issue_key text NOT NULL,
    issue_type text NOT NULL,
    severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'waiting_external', 'waiting_internal', 'resolved', 'closed', 'reopened')),
    assigned_actor_id uuid REFERENCES actors(id),
    routing_reason text,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    due_at timestamptz,
    opened_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    closed_at timestamptz,
    UNIQUE (organization_id, issue_key)
);

CREATE INDEX issues_case_status_idx ON issues (organization_id, case_id, status);

CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_id uuid NOT NULL REFERENCES cases(id),
    issue_id uuid REFERENCES issues(id),
    document_id uuid REFERENCES documents(id),
    task_key text NOT NULL,
    task_type text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'in_progress', 'completed', 'cancelled')),
    assigned_actor_id uuid REFERENCES actors(id),
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    due_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (organization_id, task_key)
);

CREATE INDEX tasks_assignee_status_idx ON tasks (organization_id, assigned_actor_id, status);

CREATE TABLE approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    approval_key text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    action text NOT NULL,
    content_hash text NOT NULL,
    content_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
    requested_by_actor_id uuid REFERENCES actors(id),
    decided_by_actor_id uuid REFERENCES actors(id),
    requested_at timestamptz,
    decided_at timestamptz,
    decision_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, approval_key, version),
    UNIQUE (organization_id, resource_type, resource_id, action, content_hash)
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    case_id uuid REFERENCES cases(id),
    issue_id uuid REFERENCES issues(id),
    approval_id uuid REFERENCES approvals(id),
    notification_key text NOT NULL,
    send_key text,
    channel text NOT NULL CHECK (channel IN ('email', 'teams', 'webhook', 'in_app')),
    purpose text NOT NULL,
    recipient_reference text NOT NULL,
    recipient_snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    content_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (
        status IN ('draft', 'pending_approval', 'approved', 'sending', 'sent', 'rejected', 'cancelled', 'failed_recoverable', 'failed_manual')
    ),
    send_lock_owner text,
    send_lock_expires_at timestamptz,
    provider_message_id text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, notification_key)
);

CREATE UNIQUE INDEX notifications_send_key_unique
    ON notifications (organization_id, send_key)
    WHERE send_key IS NOT NULL;

CREATE TABLE idempotency_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'processing', 'completed', 'failed_recoverable', 'failed_manual', 'released')),
    lease_owner text,
    lease_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    resource_type text,
    resource_id uuid,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (organization_id, scope, idempotency_key),
    CHECK ((status <> 'processing') OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX idempotency_expired_lease_idx
    ON idempotency_reservations (organization_id, lease_expires_at)
    WHERE status = 'processing';

CREATE TABLE workflow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    module_id text NOT NULL,
    module_version text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('DEV', 'UAT', 'PROD', 'LEGACY-DEMO')),
    correlation_id uuid NOT NULL,
    causation_id uuid,
    aggregate_type text,
    aggregate_id uuid,
    status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed_recoverable', 'failed_manual')),
    input_reference text,
    output_reference text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    metrics jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX workflow_runs_correlation_idx ON workflow_runs (organization_id, correlation_id, started_at);

CREATE TABLE workflow_errors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    workflow_run_id uuid REFERENCES workflow_runs(id),
    aggregate_type text,
    aggregate_id uuid,
    error_code text NOT NULL,
    error_class text NOT NULL CHECK (error_class IN ('validation', 'business', 'connector', 'provider', 'permission', 'rate_limit', 'timeout', 'unknown')),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retry_scheduled', 'waiting_manual', 'resolved', 'closed')),
    retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    next_retry_at timestamptz,
    safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
    sensitive_detail_reference text,
    opened_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolution jsonb
);

CREATE INDEX workflow_errors_open_idx ON workflow_errors (organization_id, status, opened_at);

CREATE TABLE workflow_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    idempotency_key text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL CHECK (event_version > 0),
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    causation_id uuid,
    actor_id uuid REFERENCES actors(id),
    producer text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX workflow_events_aggregate_idx
    ON workflow_events (organization_id, aggregate_type, aggregate_id, occurred_at);
CREATE INDEX workflow_events_correlation_idx
    ON workflow_events (organization_id, correlation_id, occurred_at);

CREATE TABLE connector_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    environment text NOT NULL CHECK (environment IN ('DEV', 'UAT', 'PROD', 'LEGACY-DEMO')),
    connector_type text NOT NULL,
    connector_key text NOT NULL,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    secret_reference text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, environment, connector_key)
);

-- Tenant-bound reference protection. UUID primary keys are globally unique, but
-- these composite constraints also prove that every related record belongs to
-- the same organization. This prevents a connector or orchestration mapping
-- error from creating a valid cross-tenant foreign-key relationship.
ALTER TABLE actors ADD CONSTRAINT actors_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE subjects ADD CONSTRAINT subjects_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE workflow_templates ADD CONSTRAINT workflow_templates_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE workflow_template_versions ADD CONSTRAINT workflow_template_versions_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE document_types ADD CONSTRAINT document_types_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE requirement_sets ADD CONSTRAINT requirement_sets_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE requirement_set_versions ADD CONSTRAINT requirement_set_versions_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE prompt_versions ADD CONSTRAINT prompt_versions_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE cases ADD CONSTRAINT cases_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE submissions ADD CONSTRAINT submissions_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE documents ADD CONSTRAINT documents_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE approvals ADD CONSTRAINT approvals_org_id_pair UNIQUE (organization_id, id);
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_org_id_pair UNIQUE (organization_id, id);

ALTER TABLE subjects
    ADD CONSTRAINT subjects_primary_contact_same_org_fk
    FOREIGN KEY (organization_id, primary_contact_actor_id)
    REFERENCES actors (organization_id, id);

ALTER TABLE workflow_template_versions
    ADD CONSTRAINT workflow_template_versions_template_same_org_fk
    FOREIGN KEY (organization_id, workflow_template_id)
    REFERENCES workflow_templates (organization_id, id);

ALTER TABLE requirement_set_versions
    ADD CONSTRAINT requirement_set_versions_set_same_org_fk
    FOREIGN KEY (organization_id, requirement_set_id)
    REFERENCES requirement_sets (organization_id, id);

ALTER TABLE requirements
    ADD CONSTRAINT requirements_set_version_same_org_fk
    FOREIGN KEY (organization_id, requirement_set_version_id)
    REFERENCES requirement_set_versions (organization_id, id),
    ADD CONSTRAINT requirements_document_type_same_org_fk
    FOREIGN KEY (organization_id, document_type_id)
    REFERENCES document_types (organization_id, id);

ALTER TABLE cases
    ADD CONSTRAINT cases_subject_same_org_fk
    FOREIGN KEY (organization_id, subject_id)
    REFERENCES subjects (organization_id, id),
    ADD CONSTRAINT cases_template_version_same_org_fk
    FOREIGN KEY (organization_id, workflow_template_version_id)
    REFERENCES workflow_template_versions (organization_id, id),
    ADD CONSTRAINT cases_requirement_version_same_org_fk
    FOREIGN KEY (organization_id, requirement_set_version_id)
    REFERENCES requirement_set_versions (organization_id, id),
    ADD CONSTRAINT cases_prompt_version_same_org_fk
    FOREIGN KEY (organization_id, prompt_version_id)
    REFERENCES prompt_versions (organization_id, id);

ALTER TABLE submissions
    ADD CONSTRAINT submissions_case_same_org_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES cases (organization_id, id);

ALTER TABLE documents
    ADD CONSTRAINT documents_case_same_org_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES cases (organization_id, id),
    ADD CONSTRAINT documents_submission_same_org_fk
    FOREIGN KEY (organization_id, submission_id)
    REFERENCES submissions (organization_id, id),
    ADD CONSTRAINT documents_type_same_org_fk
    FOREIGN KEY (organization_id, accepted_document_type_id)
    REFERENCES document_types (organization_id, id);

ALTER TABLE classification_attempts
    ADD CONSTRAINT classification_attempts_document_same_org_fk
    FOREIGN KEY (organization_id, document_id)
    REFERENCES documents (organization_id, id),
    ADD CONSTRAINT classification_attempts_prompt_same_org_fk
    FOREIGN KEY (organization_id, prompt_version_id)
    REFERENCES prompt_versions (organization_id, id);

ALTER TABLE issues
    ADD CONSTRAINT issues_case_same_org_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES cases (organization_id, id),
    ADD CONSTRAINT issues_document_same_org_fk
    FOREIGN KEY (organization_id, document_id)
    REFERENCES documents (organization_id, id),
    ADD CONSTRAINT issues_actor_same_org_fk
    FOREIGN KEY (organization_id, assigned_actor_id)
    REFERENCES actors (organization_id, id);

ALTER TABLE tasks
    ADD CONSTRAINT tasks_case_same_org_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES cases (organization_id, id),
    ADD CONSTRAINT tasks_issue_same_org_fk
    FOREIGN KEY (organization_id, issue_id)
    REFERENCES issues (organization_id, id),
    ADD CONSTRAINT tasks_document_same_org_fk
    FOREIGN KEY (organization_id, document_id)
    REFERENCES documents (organization_id, id),
    ADD CONSTRAINT tasks_actor_same_org_fk
    FOREIGN KEY (organization_id, assigned_actor_id)
    REFERENCES actors (organization_id, id);

ALTER TABLE approvals
    ADD CONSTRAINT approvals_requester_same_org_fk
    FOREIGN KEY (organization_id, requested_by_actor_id)
    REFERENCES actors (organization_id, id),
    ADD CONSTRAINT approvals_decider_same_org_fk
    FOREIGN KEY (organization_id, decided_by_actor_id)
    REFERENCES actors (organization_id, id);

ALTER TABLE notifications
    ADD CONSTRAINT notifications_case_same_org_fk
    FOREIGN KEY (organization_id, case_id)
    REFERENCES cases (organization_id, id),
    ADD CONSTRAINT notifications_issue_same_org_fk
    FOREIGN KEY (organization_id, issue_id)
    REFERENCES issues (organization_id, id),
    ADD CONSTRAINT notifications_approval_same_org_fk
    FOREIGN KEY (organization_id, approval_id)
    REFERENCES approvals (organization_id, id);

ALTER TABLE workflow_errors
    ADD CONSTRAINT workflow_errors_run_same_org_fk
    FOREIGN KEY (organization_id, workflow_run_id)
    REFERENCES workflow_runs (organization_id, id);

ALTER TABLE workflow_events
    ADD CONSTRAINT workflow_events_actor_same_org_fk
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES actors (organization_id, id);

COMMIT;
