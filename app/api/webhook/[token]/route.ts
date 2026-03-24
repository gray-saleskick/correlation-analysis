import { NextRequest, NextResponse } from "next/server";
import {
  findAppByWebhookToken,
  updateApplicationFields,
  upsertWebhookConfig,
  insertPendingWebhook,
  bulkUpsertSubmissions,
  replaceCallResults,
  replaceFinancialRecords,
  replaceQuestions,
  insertLoadHistory,
} from "@/lib/db";

export const maxDuration = 15;
import {
  flattenPayload,
  computeFieldSignature,
  hasFieldDrift,
  parseTypeformPayload,
  applyFieldMapping,
  mergeWebhookData,
} from "@/lib/webhookUtils";
import type { PendingWebhookSubmission } from "@/lib/types";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    // Look up webhook by token
    const match = await findAppByWebhookToken(token);
    if (!match) {
      return NextResponse.json({ error: "Invalid webhook token" }, { status: 404 });
    }

    const { clientId, appId, app } = match;
    const config = app.webhook_config;

    if (!config || !config.enabled) {
      return NextResponse.json({ error: "Webhook is disabled" }, { status: 403 });
    }

    // Parse body
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Flatten payload based on source
    let flatPayload: Record<string, string>;
    let submittedAt: string | undefined;

    if (config.source === "typeform") {
      const parsed = parseTypeformPayload(body);
      if (!parsed) {
        return NextResponse.json({ error: "Invalid Typeform payload" }, { status: 400 });
      }
      flatPayload = parsed.fields;
      submittedAt = parsed.meta.submitted_at;
    } else {
      flatPayload = flattenPayload(body as Record<string, unknown>);
    }

    const incomingFields = Object.keys(flatPayload);

    // Update last_received_at
    config.last_received_at = new Date().toISOString();

    // Check if mapping exists and fields haven't drifted
    const hasMappings = config.field_mapping.length > 0;
    const drifted = hasMappings && hasFieldDrift(incomingFields, config.last_field_signature);
    const isFirstReception = !config.last_field_signature;

    // Build cumulative signature (union of known + incoming fields)
    const knownFields = config.last_field_signature
      ? new Set(config.last_field_signature.split("|"))
      : new Set<string>();
    for (const f of incomingFields) knownFields.add(f);
    const cumulativeSignature = computeFieldSignature(Array.from(knownFields));

    if (!hasMappings || drifted || isFirstReception) {
      // Buffer as pending
      const pending: PendingWebhookSubmission = {
        id: uid(),
        received_at: new Date().toISOString(),
        raw_payload: body as Record<string, unknown>,
        source: config.source,
        status: "pending",
        reason: isFirstReception
          ? "Initial reception — field mapping required"
          : !hasMappings
            ? "No field mapping configured"
            : "New fields detected — mapping review required",
      };

      await insertPendingWebhook(appId, pending);

      // Always update signature so subsequent identical payloads aren't re-flagged
      config.last_field_signature = cumulativeSignature;
      await upsertWebhookConfig(appId, config);

      return NextResponse.json(
        {
          status: "pending",
          reason: pending.reason,
          pending_id: pending.id,
          fields: incomingFields,
        },
        { status: 202 }
      );
    }

    // Capture snapshot before merge for load history
    const preSnapshot = captureDataSnapshot(app);

    // Apply mapping and merge
    const mappedData = applyFieldMapping(
      flatPayload,
      config.field_mapping,
      config.calculated_fields
    );

    // Override submitted_at from Typeform meta if available
    if (submittedAt && !mappedData.submitted_at) {
      mappedData.submitted_at = submittedAt;
    }

    let updatedApp = mergeWebhookData(app, mappedData);

    // Add load history entry
    updatedApp = addLoadHistoryEntry(
      updatedApp,
      "webhook-auto",
      `Auto-processed webhook from ${config.source}${mappedData.email ? ` (${mappedData.email})` : ""}`,
      1,
      preSnapshot
    );

    // Preserve config changes
    updatedApp.webhook_config = config;
    config.last_field_signature = cumulativeSignature;

    // Write back using relational functions
    await updateApplicationFields(appId, {
      title: updatedApp.title,
    });

    if (updatedApp.submissions) {
      await bulkUpsertSubmissions(appId, updatedApp.submissions);
    }
    if (updatedApp.financial_records) {
      await replaceFinancialRecords(appId, updatedApp.financial_records);
    }
    if (updatedApp.call_results) {
      await replaceCallResults(appId, updatedApp.call_results);
    }
    if (updatedApp.questions) {
      await replaceQuestions(appId, updatedApp.questions);
    }
    await upsertWebhookConfig(appId, config);

    // Write load history entries
    if (updatedApp.load_history) {
      for (const entry of updatedApp.load_history) {
        try {
          await insertLoadHistory(appId, entry);
        } catch {
          // Ignore duplicates
        }
      }
    }

    return NextResponse.json({
      status: "processed",
      email: mappedData.email,
      answers_count: mappedData.answers.length,
    });
  } catch (err: unknown) {
    console.error("Webhook error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Also support GET for health check / verification
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const match = await findAppByWebhookToken(token);

  if (!match) {
    return NextResponse.json({ error: "Invalid webhook token" }, { status: 404 });
  }

  return NextResponse.json({ status: "ok", webhook: "active" });
}
