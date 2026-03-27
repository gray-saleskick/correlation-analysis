import { NextRequest, NextResponse } from "next/server";
import {
  readApplicationFull,
  updateApplicationFields,
  deleteApplication,
  moveApplication,
  replaceQuestions,
  bulkUpsertSubmissions,
  replaceFinancialRecords,
  replaceCallResults,
  upsertWebhookConfig,
  insertPendingWebhook,
  deletePendingWebhooks,
  upsertSavedFilter,
  deleteSavedFilter,
  getSavedFilters,
  insertLoadHistory,
  appendChatMessage,
  getChatMessages,
  createDataChat,
  appendDataChatMessage,
  deleteDataChat,
} from "@/lib/db";
import type { Application } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Maximum request body size (10MB) for application data
const MAX_BODY_SIZE = 10 * 1024 * 1024;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const app = await readApplicationFull(appId);
    if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });

    return NextResponse.json({ success: true, application: app });
  } catch (err) {
    console.error(`GET app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    // Check content length
    const contentLength = parseInt(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }

    const body = (await req.json()) as { application: Application };
    if (!body.application) {
      return NextResponse.json({ error: "Missing application data" }, { status: 400 });
    }

    // Preserve the original ID
    const application = { ...body.application, id: appId };

    // Validate title length if present
    if (application.title && application.title.length > 200) {
      return NextResponse.json({ error: "Title must be under 200 characters" }, { status: 400 });
    }

    // ── Bridge: decompose full Application object into relational writes ──

    // 1. Update scalar fields on the applications table
    await updateApplicationFields(appId, {
      title: application.title,
      typeform_pat: application.typeform_pat,
      typeform_form_id: application.typeform_form_id,
      share_token: application.share_token,
      share_enabled: application.share_enabled,
      narrative_analysis: application.narrative_analysis,
      narrative_generated_at: application.narrative_generated_at,
      audit_analysis: application.audit_analysis,
      audit_generated_at: application.audit_generated_at,
      audit_client_notes: application.audit_client_notes,
      grading_audit_analysis: application.grading_audit_analysis,
      grading_audit_generated_at: application.grading_audit_generated_at,
      grading_audit_client_notes: application.grading_audit_client_notes,
      hidden_correlation_questions: application.hidden_correlation_questions,
      correlation_answer_order: application.correlation_answer_order,
      grade_mappings: application.grade_mappings,
      upload_mappings: application.upload_mappings,
    });

    // 2. Replace child data when present
    if (application.questions) {
      await replaceQuestions(appId, application.questions);
    }

    if (application.submissions) {
      await bulkUpsertSubmissions(appId, application.submissions);
    }

    if (application.financial_records) {
      await replaceFinancialRecords(appId, application.financial_records);
    }

    if (application.call_results) {
      await replaceCallResults(appId, application.call_results);
    }

    if (application.webhook_config) {
      await upsertWebhookConfig(appId, application.webhook_config);
    }

    // 3. Handle saved correlation filters
    if (application.saved_correlation_filters) {
      // Get existing filters to determine what to delete
      const existing = await getSavedFilters(appId);
      const newIds = new Set(application.saved_correlation_filters.map((f) => f.id));
      // Delete removed filters
      for (const ef of existing) {
        if (!newIds.has(ef.id)) {
          await deleteSavedFilter(ef.id);
        }
      }
      // Upsert current filters
      for (const f of application.saved_correlation_filters) {
        await upsertSavedFilter(appId, f);
      }
    }

    // 4. Handle load history entries
    if (application.load_history) {
      // Load history is append-only from the client's perspective during the bridge.
      // The client sends the full array; we only insert entries that don't exist yet.
      const existingHistory = await (await import("@/lib/db")).getLoadHistory(appId);
      const existingIds = new Set(existingHistory.map((e) => e.id));
      for (const entry of application.load_history) {
        if (!existingIds.has(entry.id)) {
          await insertLoadHistory(appId, entry);
        }
      }
    }

    // 5. Handle pending webhook submissions
    if (application.pending_webhook_submissions) {
      // Client sends the full array. Insert any new ones.
      // Note: deletions of processed pending webhooks happen via other routes.
      for (const pw of application.pending_webhook_submissions) {
        try {
          await insertPendingWebhook(appId, pw);
        } catch {
          // Ignore duplicates — insertPendingWebhook will fail on existing IDs
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`PUT app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { appId } = await params;
  try {
    const body = await req.json();
    const { new_client_id } = body as { new_client_id?: string };

    if (!new_client_id?.trim()) {
      return NextResponse.json({ error: "new_client_id is required" }, { status: 400 });
    }

    const moved = await moveApplication(appId, new_client_id.trim());
    if (!moved) {
      return NextResponse.json({ error: "Failed to move application" }, { status: 500 });
    }

    return NextResponse.json({ success: true, new_client_id: new_client_id.trim() });
  } catch (err) {
    console.error(`PATCH (move) app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const deleted = await deleteApplication(appId);
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`DELETE app ${appId} error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
