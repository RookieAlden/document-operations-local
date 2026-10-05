BEGIN;

-- M36.1 gives an authorized reviewer a terminal, reversible way to exclude a
-- wrong-subject original from one Case without deleting the preserved object
-- or rewriting the AI evidence. The immutable review decision remains the
-- authoritative who/when/why record.
ALTER TABLE public.documents
    DROP CONSTRAINT documents_status_check,
    ADD CONSTRAINT documents_status_check CHECK (
        status IN (
            'reserved','downloaded','incoming_saved','classified','accepted',
            'review_required','human_confirmed','archived','failed_recoverable',
            'failed_manual','duplicate_skipped','excluded'
        )
    );

ALTER TABLE public.document_review_decisions
    DROP CONSTRAINT document_review_decisions_action_check,
    ADD CONSTRAINT document_review_decisions_action_check CHECK (
        action IN ('confirm','reclassify','request_information','exclude','reopen')
    );

ALTER TABLE public.document_requirement_matches
    DROP CONSTRAINT document_requirement_matches_match_status_check,
    ADD CONSTRAINT document_requirement_matches_match_status_check CHECK (
        match_status IN ('matched','review_required','duplicate','unmatched','processing','excluded')
    );

COMMENT ON COLUMN public.documents.status IS
    'Canonical processing state. excluded means the immutable original is retained but does not belong to this Case and cannot count toward completeness.';

-- Keep the complete, previously-reviewed M24 algorithm body and make the
-- smallest deterministic status-vocabulary extension. Assertions fail the
-- migration if an earlier migration ever changes the expected function body,
-- avoiding a silent partial rewrite.
DO $migration$
DECLARE
    definition text;
    revised text;
BEGIN
    definition := pg_get_functiondef(
        'public.dop_recompute_submission_completeness(uuid,timestamptz)'::regprocedure
    );
    revised := replace(
        definition,
        $$status IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped')$$,
        $$status IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped','excluded')$$
    );
    revised := replace(
        revised,
        $$status NOT IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped')$$,
        $$status NOT IN ('accepted','review_required','human_confirmed','archived','failed_manual','duplicate_skipped','excluded')$$
    );
    revised := replace(
        revised,
        $$PARTITION BY d.case_id, d.content_hash_sha256
                        ORDER BY d.created_at, d.id$$,
        $$PARTITION BY d.case_id, d.content_hash_sha256
                        ORDER BY CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END, d.created_at, d.id$$
    );
    revised := replace(
        revised,
        $$(status = 'duplicate_skipped'
                OR (content_hash_sha256 IS NOT NULL AND content_position > 1)) AS is_duplicate$$,
        $$(status <> 'excluded' AND (status = 'duplicate_skipped'
                OR (content_hash_sha256 IS NOT NULL AND content_position > 1))) AS is_duplicate$$
    );
    revised := replace(
        revised,
        $$WHERE ranked.status = 'duplicate_skipped'
                      OR (ranked.content_hash_sha256 IS NOT NULL AND ranked.content_position > 1)$$,
        $$WHERE ranked.status <> 'excluded'
                     AND (ranked.status = 'duplicate_skipped'
                      OR (ranked.content_hash_sha256 IS NOT NULL AND ranked.content_position > 1))$$
    );
    revised := replace(
        revised,
        $$WHEN status IN ('review_required','failed_manual') THEN 'review_required'
               WHEN is_duplicate THEN 'duplicate'$$,
        $$WHEN status = 'excluded' THEN 'excluded'
               WHEN status IN ('review_required','failed_manual') THEN 'review_required'
               WHEN is_duplicate THEN 'duplicate'$$
    );
    revised := replace(
        revised,
        $$WHEN status IN ('review_required','failed_manual') THEN 'human_confirmation_required'
               WHEN is_duplicate THEN 'same_content_duplicate'$$,
        $$WHEN status = 'excluded' THEN 'document_excluded_wrong_subject'
               WHEN status IN ('review_required','failed_manual') THEN 'human_confirmation_required'
               WHEN is_duplicate THEN 'same_content_duplicate'$$
    );
    IF revised = definition
       OR position($$'excluded'$$ IN revised) = 0
       OR position($$THEN 'excluded'$$ IN revised) = 0
       OR position($$status <> 'excluded'$$ IN revised) = 0
       OR position($$CASE WHEN d.status = 'excluded' THEN 1 ELSE 0 END$$ IN revised) = 0
       OR position($$document_excluded_wrong_subject$$ IN revised) = 0 THEN
        RAISE EXCEPTION 'M36.1 completeness function rewrite precondition failed';
    END IF;
    EXECUTE revised;

    definition := pg_get_functiondef(
        'public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure
    );
    revised := replace(
        definition,
        $$status NOT IN ('accepted','human_confirmed','archived','duplicate_skipped')$$,
        $$status NOT IN ('accepted','human_confirmed','archived','duplicate_skipped','excluded')$$
    );
    IF revised = definition OR position($$'excluded'$$ IN revised) = 0 THEN
        RAISE EXCEPTION 'M36.1 completion gate rewrite precondition failed';
    END IF;
    EXECUTE revised;
END;
$migration$;

REVOKE ALL ON FUNCTION public.dop_recompute_submission_completeness(uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dop_complete_case_and_create_handoff(uuid,uuid,uuid,text,text,timestamptz) TO dop_app;

COMMIT;
