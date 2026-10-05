BEGIN;

CREATE TABLE document_review_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    document_id uuid NOT NULL REFERENCES documents(id),
    actor_id uuid NOT NULL REFERENCES actors(id),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN ('confirm', 'reclassify', 'request_information')),
    previous_document_type_id uuid REFERENCES document_types(id),
    decided_document_type_id uuid REFERENCES document_types(id),
    previous_status text NOT NULL,
    resulting_status text NOT NULL,
    rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 12 AND 1000),
    related_issue_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    decided_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX document_review_decisions_document_idx
    ON document_review_decisions (organization_id, document_id, decided_at DESC);

ALTER TABLE workflow_events
    ADD CONSTRAINT workflow_events_org_id_pair UNIQUE (organization_id, id);

ALTER TABLE document_review_decisions
    ADD CONSTRAINT document_review_decisions_org_id_pair UNIQUE (organization_id, id),
    ADD CONSTRAINT document_review_decisions_document_same_org_fk
        FOREIGN KEY (organization_id, document_id)
        REFERENCES documents (organization_id, id),
    ADD CONSTRAINT document_review_decisions_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id)
        REFERENCES actors (organization_id, id),
    ADD CONSTRAINT document_review_decisions_previous_type_same_org_fk
        FOREIGN KEY (organization_id, previous_document_type_id)
        REFERENCES document_types (organization_id, id),
    ADD CONSTRAINT document_review_decisions_decided_type_same_org_fk
        FOREIGN KEY (organization_id, decided_document_type_id)
        REFERENCES document_types (organization_id, id),
    ADD CONSTRAINT document_review_decisions_event_same_org_fk
        FOREIGN KEY (organization_id, event_id)
        REFERENCES workflow_events (organization_id, id);

ALTER TABLE document_review_decisions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE document_review_decisions TO dop_app;

CREATE POLICY dop_tenant_isolation ON document_review_decisions
    FOR ALL TO dop_app
    USING (organization_id = public.dop_current_organization_id())
    WITH CHECK (organization_id = public.dop_current_organization_id());

COMMIT;
