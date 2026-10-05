BEGIN;

ALTER TABLE public.document_review_decisions
    ADD COLUMN exclusion_reason text;

-- Every exclusion written before M40.1 used the only then-supported path:
-- wrong subject. The immutable rationale and event remain unchanged.
UPDATE public.document_review_decisions
   SET exclusion_reason = 'wrong_subject'
 WHERE action = 'exclude';

ALTER TABLE public.document_review_decisions
    ADD CONSTRAINT document_review_decisions_exclusion_reason_check CHECK (
        (action = 'exclude' AND exclusion_reason IN ('wrong_subject','wrong_period','irrelevant_or_unknown'))
        OR (action <> 'exclude' AND exclusion_reason IS NULL)
    );

COMMENT ON COLUMN public.document_review_decisions.exclusion_reason IS
    'Governed exclusion category. Required only for exclude: wrong subject, wrong period, or irrelevant/unknown material.';

-- Keep completeness evidence aligned with the governed exclusion reason while
-- retaining the original object and decision history.
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
        $$WHEN status = 'excluded' THEN 'document_excluded_wrong_subject'$$,
        $$WHEN status = 'excluded' THEN CASE review_reason
                   WHEN 'operator_excluded_wrong_subject' THEN 'document_excluded_wrong_subject'
                   WHEN 'operator_excluded_wrong_period' THEN 'document_excluded_wrong_period'
                   ELSE 'document_excluded_irrelevant_or_unknown'
               END$$
    );
    IF revised = definition
       OR position($$document_excluded_wrong_period$$ IN revised) = 0
       OR position($$document_excluded_irrelevant_or_unknown$$ IN revised) = 0 THEN
        RAISE EXCEPTION 'M40.1 exclusion reason completeness rewrite precondition failed';
    END IF;
    EXECUTE revised;
END;
$migration$;

REVOKE ALL ON FUNCTION public.dop_recompute_submission_completeness(uuid,timestamptz) FROM PUBLIC;

COMMIT;
