import { describe, expect, it } from "vitest";
import { FormConnector } from "../src/connectors/forms/form-connector.js";

function connector(): FormConnector {
  return new FormConnector({
    connectorId: "fillout-dev-v1",
    providerFormId: "m7-synthetic-form",
    environment: "DEV",
    organizationKey: "dev-accounting-firm",
    workflowTemplateKey: "accounting.monthly.document_collection",
    subjectKey: "dev-client-001",
    subjectDisplayName: "Kauri Coast Cafe Limited",
    timezone: "Pacific/Auckland",
    sourceType: "fillout",
  });
}

function input(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    provider_form_id: "m7-synthetic-form",
    provider_submission_id: "submission-001",
    received_at: "2026-08-07T08:00:00Z",
    period: "2026-07",
    files: [{
      source_file_id: "file-001",
      original_filename: "synthetic.pdf",
      download_url: "https://example.invalid/synthetic.pdf",
    }],
  };
}

describe("form connector mapping", () => {
  it("injects trusted scope and derives the canonical Case key", () => {
    const result = connector().map(input());
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        environment: "DEV",
        organization_key: "dev-accounting-firm",
        workflow_template_key: "accounting.monthly.document_collection",
        case_key: "dev-accounting-firm|accounting.monthly.document_collection|dev-client-001|2026-07",
        subject: {
          subject_key: "dev-client-001",
          display_name: "Kauri Coast Cafe Limited",
        },
        data_classification: { mode: "synthetic_only" },
      }),
    });
  });

  it("requires and pins a production admission policy for PROD mapping", () => {
    expect(() => new FormConnector({
      ...connector().profile,
      environment: "PROD",
    })).toThrow("PROD form connector requires a production admission policy key");
    const production = new FormConnector({
      ...connector().profile,
      environment: "PROD",
      productionAdmissionPolicyKey: "prod.blue-peak.2026-q3",
    });
    expect(production.map(input())).toEqual({
      ok: true,
      value: expect.objectContaining({
        environment: "PROD",
        data_classification: {
          mode: "real_data",
          production_admission_policy_key: "prod.blue-peak.2026-q3",
        },
      }),
    });
  });

  it("requires a governed UAT scope and never trusts the profile or claimed period", () => {
    const governed = new FormConnector({
      ...connector().profile,
      environment: "UAT",
      demoGovernanceRequired: true,
    });
    expect(governed.map({ ...input(), demo_invitation_token: "i".repeat(43) })).toEqual({
      ok: false,
      errors: [expect.objectContaining({ instancePath: "/demo_invitation_token" })],
    });
    const scope = {
      organizationKey: "uat-synthetic-operations",
      workflowTemplateKey: "accounting.monthly.document_collection",
      subjectKey: "rimu-demo-client-001",
      subjectDisplayName: "Rimu Retail Limited (Synthetic)",
      caseKey: "uat-synthetic-operations|accounting.monthly.document_collection|rimu-demo-client-001|2026-07",
      period: "2026-07",
      timezone: "Pacific/Auckland",
    };
    const mapped = governed.map({ ...input(), demo_invitation_token: "i".repeat(43) }, scope);
    expect(mapped).toEqual({ ok: true, value: expect.objectContaining({
      environment: "UAT",
      organization_key: scope.organizationKey,
      case_key: scope.caseKey,
      subject: { subject_key: scope.subjectKey, display_name: scope.subjectDisplayName },
      business_context: { period: scope.period, timezone: scope.timezone },
      data_classification: { mode: "synthetic_only" },
    }) });
    expect(governed.map({ ...input(), period: "2026-08", demo_invitation_token: "i".repeat(43) }, scope))
      .toEqual({ ok: false, errors: [expect.objectContaining({ instancePath: "/period" })] });
  });

  it("rejects invalid periods, non-HTTPS files, and unrecognized properties", () => {
    const invalidPeriod = connector().map({ ...input(), period: "2026-W31" });
    expect(invalidPeriod.ok).toBe(false);

    const invalidFile = input();
    invalidFile.files = [{
      source_file_id: "file-001",
      original_filename: "synthetic.pdf",
      download_url: "http://example.invalid/synthetic.pdf",
    }];
    expect(connector().map(invalidFile).ok).toBe(false);
    expect(connector().map({ ...input(), subject_key: "attacker-client" }).ok).toBe(false);
  });

  it("maps the documented native Fillout webhook payload by exact question names", () => {
    const result = connector().map({
      submissionId: "fillout-native-001",
      submissionTime: "2026-08-07T09:45:00Z",
      lastUpdatedAt: "2026-08-07T09:45:00Z",
      questions: [{
        id: "period-question",
        name: "Accounting period (YYYY-MM)",
        type: "ShortAnswer",
        value: "2026-07",
      }, {
        id: "files-question",
        name: "Accounting documents (PDF, JPG or PNG)",
        type: "FileUpload",
        value: [{
          id: "fillout-file-001",
          name: "synthetic-bank-statement.pdf",
          url: "https://files.fillout.com/synthetic-bank-statement.pdf",
          mimeType: "application/pdf",
          size: 3055,
        }],
      }],
      calculations: [],
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({ submission_id: "fillout-native-001" }),
        files: [{
          source_file_id: "files-question:0",
          original_filename: "synthetic-bank-statement.pdf",
          download_url: "https://files.fillout.com/synthetic-bank-statement.pdf",
          declared_mime_type: "application/pdf",
          declared_size_bytes: 3055,
        }],
      }),
    });
  });

  it("maps the native Fillout webhook envelope used by Make JSON pass-through", () => {
    const result = connector().map({
      formId: "m7-synthetic-form",
      formName: "Accounting Document Intake DEV",
      submission: {
        submissionId: "fillout-envelope-001",
        submissionTime: "2026-08-07T09:45:00Z",
        questions: [{
          id: "period-question",
          name: "Accounting period (YYYY-MM)",
          value: "2026-07",
        }, {
          id: "files-question",
          name: "Accounting documents (PDF, JPG or PNG)",
          value: [{
            name: "synthetic.pdf",
            url: "https://files.fillout.com/synthetic.pdf",
            size: 3055,
          }],
        }],
      },
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({ submission_id: "fillout-envelope-001" }),
        files: [expect.objectContaining({
          original_filename: "synthetic.pdf",
          declared_mime_type: "application/pdf",
        })],
      }),
    });
    expect(connector().map({
      formId: "legacy-form",
      submission: {
        submissionId: "fillout-envelope-002",
        submissionTime: "2026-08-07T09:45:00Z",
        questions: [],
      },
    }).ok).toBe(false);
  });

  it("uses governed Fillout URL parameters for invitation and period instead of visible fields", () => {
    const governed = new FormConnector({
      ...connector().profile,
      providerFormId: "m45-1-synthetic-form",
      environment: "UAT",
      demoGovernanceRequired: true,
    });
    const scope = {
      organizationKey: "uat-accounting-firm",
      workflowTemplateKey: "accounting.monthly.document_collection",
      subjectKey: "rimu-demo-client-001",
      subjectDisplayName: "Rimu Retail Limited (Synthetic)",
      caseKey: "uat-accounting-firm|accounting.monthly.document_collection|rimu-demo-client-001|2026-08",
      period: "2026-08",
      timezone: "Pacific/Auckland",
    };
    const payload = {
      formId: "m45-1-synthetic-form",
      submission: {
        submissionId: "fillout-m45-1-001",
        submissionTime: "2026-08-18T01:45:00Z",
        questions: [{
          id: "files-question",
          name: "Accounting documents (PDF, JPG or PNG)",
          value: [{ name: "synthetic.pdf", url: "https://files.fillout.com/synthetic.pdf" }],
        }, {
          id: "untrusted-visible-period",
          name: "Accounting period (YYYY-MM)",
          value: "1999-01",
        }],
        urlParameters: [{ id: "period-param", name: "period", value: "2026-08" }, {
          id: "invitation-param",
          name: "dop_invitation",
          value: "i".repeat(43),
        }],
      },
    };

    expect(governed.inspect(payload)).toEqual({ ok: true, value: expect.objectContaining({
      claimedPeriod: "2026-08",
      invitationToken: "i".repeat(43),
    }) });
    expect(governed.map(payload, scope)).toEqual({ ok: true, value: expect.objectContaining({
      case_key: scope.caseKey,
      business_context: { period: "2026-08", timezone: "Pacific/Auckland" },
    }) });
    expect(governed.inspect({
      ...payload,
      submission: { ...payload.submission, urlParameters: [] },
    })).toEqual({ ok: false, errors: [expect.objectContaining({ instancePath: "/urlParameters" })] });
  });

  it("accepts a governed quarterly period without trusting a visible period field", () => {
    const governed = new FormConnector({
      ...connector().profile,
      providerFormId: "m45-1-synthetic-form",
      environment: "UAT",
      demoGovernanceRequired: true,
    });
    const inspected = governed.inspect({
      formId: "m45-1-synthetic-form",
      submission: {
        submissionId: "fillout-m45-1-quarterly-001",
        submissionTime: "2026-08-18T01:45:00Z",
        questions: [{
          id: "files-question",
          name: "Accounting documents (PDF, JPG or PNG)",
          value: [{ name: "synthetic.pdf", url: "https://files.fillout.com/synthetic.pdf" }],
        }],
        urlParameters: [{ id: "period-param", name: "period", value: "2026-Q2" }, {
          id: "invitation-param",
          name: "dop_invitation",
          value: "i".repeat(43),
        }],
      },
    });
    expect(inspected).toEqual({ ok: true, value: expect.objectContaining({ claimedPeriod: "2026-Q2" }) });
  });

  it("accepts the bounded opaque period key used by clean trial Cases and still compares it exactly", () => {
    const governed = new FormConnector({
      ...connector().profile,
      providerFormId: "m45-1-synthetic-form",
      environment: "UAT",
      demoGovernanceRequired: true,
    });
    const trialPeriod = "2027-Q2-trial-202608180425";
    const payload = {
      formId: "m45-1-synthetic-form",
      submission: {
        submissionId: "fillout-m45-1-trial-001",
        submissionTime: "2026-08-18T04:32:00Z",
        questions: [{
          id: "files-question",
          name: "Accounting documents (PDF, JPG or PNG)",
          value: [{ name: "synthetic.pdf", url: "https://files.fillout.com/synthetic.pdf" }],
        }],
        urlParameters: [{ id: "period-param", name: "period", value: trialPeriod }, {
          id: "invitation-param",
          name: "dop_invitation",
          value: "i".repeat(43),
        }],
      },
    };
    const scope = {
      organizationKey: "uat-accounting-firm",
      workflowTemplateKey: "accounting.quarterly.document_collection",
      subjectKey: "blue-peak-synthetic",
      subjectDisplayName: "Blue Peak Consulting Limited",
      caseKey: `uat-accounting-firm|accounting.quarterly.document_collection|blue-peak-synthetic|${trialPeriod}`,
      period: trialPeriod,
      timezone: "Pacific/Auckland",
    };

    expect(governed.inspect(payload)).toEqual({ ok: true, value: expect.objectContaining({ claimedPeriod: trialPeriod }) });
    expect(governed.map(payload, scope)).toEqual({ ok: true, value: expect.objectContaining({
      case_key: scope.caseKey,
      business_context: { period: trialPeriod, timezone: "Pacific/Auckland" },
    }) });
    expect(governed.inspect({
      ...payload,
      submission: {
        ...payload.submission,
        urlParameters: [{ id: "period-param", name: "period", value: "2027 Q2/trial" }, {
          id: "invitation-param", name: "dop_invitation", value: "i".repeat(43),
        }],
      },
    })).toEqual({ ok: false, errors: [expect.objectContaining({ instancePath: "/urlParameters" })] });
  });

  it("fails closed when native Fillout field names or file URLs drift", () => {
    const missingPeriod = connector().map({
      submissionId: "fillout-native-002",
      submissionTime: "2026-08-07T09:45:00Z",
      questions: [{ id: "period", name: "Month", value: "2026-07" }],
    });
    expect(missingPeriod.ok).toBe(false);

    const unsafeFile = connector().map({
      submissionId: "fillout-native-003",
      submissionTime: "2026-08-07T09:45:00Z",
      questions: [{ id: "period", name: "Accounting period (YYYY-MM)", value: "2026-07" }, {
        id: "files",
        name: "Accounting documents (PDF, JPG or PNG)",
        value: [{ name: "unsafe.pdf", url: "http://example.invalid/unsafe.pdf" }],
      }],
    });
    expect(unsafeFile.ok).toBe(false);
  });

  it("maps the explicit Make bridge payload without losing multiple Fillout files", () => {
    const result = connector().map({
      connector_bridge_version: "fillout-make-v1",
      provider_form_id: "m7-synthetic-form",
      provider_submission_id: "fillout-make-001",
      received_at: "2026-08-07T09:45:00Z",
      period: "2026-07",
      provider_files: [{
        id: "fillout-file-001",
        name: "synthetic-bank-statement.pdf",
        url: "https://files.fillout.com/synthetic-bank-statement.pdf",
        type: "application/pdf",
        size: 3055,
      }, {
        name: "synthetic-receipt.jpg",
        url: "https://files.fillout.com/synthetic-receipt.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1440,
      }],
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({ submission_id: "fillout-make-001" }),
        files: [{
          source_file_id: "fillout-file-001",
          original_filename: "synthetic-bank-statement.pdf",
          download_url: "https://files.fillout.com/synthetic-bank-statement.pdf",
          declared_mime_type: "application/pdf",
          declared_size_bytes: 3055,
        }, {
          source_file_id: "fillout-make-001:1",
          original_filename: "synthetic-receipt.jpg",
          download_url: "https://files.fillout.com/synthetic-receipt.jpg",
          declared_mime_type: "image/jpeg",
          declared_size_bytes: 1440,
        }],
      }),
    });
  });

  it("fails closed when the Make bridge adds scope overrides or unsafe files", () => {
    const bridge = {
      connector_bridge_version: "fillout-make-v1",
      provider_form_id: "m7-synthetic-form",
      provider_submission_id: "fillout-make-002",
      received_at: "2026-08-07T09:45:00Z",
      period: "2026-07",
      provider_files: [{ name: "unsafe.pdf", url: "http://example.invalid/unsafe.pdf" }],
    };
    expect(connector().map(bridge).ok).toBe(false);
    expect(connector().map({ ...bridge, organization_key: "other-tenant" }).ok).toBe(false);
  });
});
