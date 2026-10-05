BEGIN;

ALTER TABLE document_review_decisions
    DROP CONSTRAINT document_review_decisions_action_check,
    ADD CONSTRAINT document_review_decisions_action_check
        CHECK (action IN ('confirm', 'reclassify', 'request_information', 'reopen'));

CREATE TABLE issue_operator_transitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id),
    issue_id uuid NOT NULL REFERENCES issues(id),
    actor_id uuid NOT NULL REFERENCES actors(id),
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    action text NOT NULL CHECK (action IN (
        'assign_to_me', 'wait_internal', 'wait_external', 'resolve', 'reopen', 'close'
    )),
    previous_status text NOT NULL,
    resulting_status text NOT NULL,
    previous_assigned_actor_id uuid REFERENCES actors(id),
    resulting_assigned_actor_id uuid REFERENCES actors(id),
    note text NOT NULL CHECK (char_length(note) BETWEEN 12 AND 1000),
    event_id uuid NOT NULL REFERENCES workflow_events(id),
    transitioned_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX issue_operator_transitions_issue_idx
    ON issue_operator_transitions (organization_id, issue_id, transitioned_at DESC);

ALTER TABLE issue_operator_transitions
    ADD CONSTRAINT issue_operator_transitions_org_id_pair UNIQUE (organization_id, id),
    ADD CONSTRAINT issue_operator_transitions_issue_same_org_fk
        FOREIGN KEY (organization_id, issue_id)
        REFERENCES issues (organization_id, id),
    ADD CONSTRAINT issue_operator_transitions_actor_same_org_fk
        FOREIGN KEY (organization_id, actor_id)
        REFERENCES actors (organization_id, id),
    ADD CONSTRAINT issue_operator_transitions_previous_actor_same_org_fk
        FOREIGN KEY (organization_id, previous_assigned_actor_id)
        REFERENCES actors (organization_id, id),
    ADD CONSTRAINT issue_operator_transitions_resulting_actor_same_org_fk
        FOREIGN KEY (organization_id, resulting_assigned_actor_id)
        REFERENCES actors (organization_id, id),
    ADD CONSTRAINT issue_operator_transitions_event_same_org_fk
        FOREIGN KEY (organization_id, event_id)
        REFERENCES workflow_events (organization_id, id);

ALTER TABLE issue_operator_transitions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON TABLE issue_operator_transitions TO dop_app;

CREATE POLICY dop_tenant_isolation ON issue_operator_transitions
    FOR ALL TO dop_app
    USING (organization_id = public.dop_current_organization_id())
    WITH CHECK (organization_id = public.dop_current_organization_id());

COMMIT;
