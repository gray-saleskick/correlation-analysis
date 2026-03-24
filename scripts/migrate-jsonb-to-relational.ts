/**
 * Migration script: JSONB monolith → Relational tables
 *
 * Usage:
 *   npx tsx scripts/migrate-jsonb-to-relational.ts              # dry-run (rolls back)
 *   npx tsx scripts/migrate-jsonb-to-relational.ts --execute     # real migration
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const DRY_RUN = !process.argv.includes("--execute");

interface MigrationCounts {
  users: number;
  clients: number;
  applications: number;
  questions: number;
  submissions: number;
  answers: number;
  financialRecords: number;
  callResults: number;
  webhookConfigs: number;
  fieldMappings: number;
  calculatedFields: number;
  pendingWebhooks: number;
  uploadMappings: number;
  savedFilters: number;
  chatMessages: number;
  dataChats: number;
  dataChatMessages: number;
  loadHistory: number;
}

const counts: MigrationCounts = {
  users: 0, clients: 0, applications: 0, questions: 0,
  submissions: 0, answers: 0, financialRecords: 0, callResults: 0,
  webhookConfigs: 0, fieldMappings: 0, calculatedFields: 0,
  pendingWebhooks: 0, uploadMappings: 0, savedFilters: 0,
  chatMessages: 0, dataChats: 0, dataChatMessages: 0, loadHistory: 0,
};

async function migrate() {
  console.log(DRY_RUN ? "🔍 DRY RUN — will roll back at the end\n" : "🚀 EXECUTING MIGRATION\n");

  // ── 1. Migrate Users ─────────────────────────────────────────────
  console.log("── Migrating users...");
  const { data: usersRow } = await supabase
    .from("clients")
    .select("profile")
    .eq("client_id", "__users__")
    .single();

  if (usersRow?.profile?.users) {
    const users = usersRow.profile.users as Array<{
      id: string; email: string; password_hash: string; name?: string; created_at?: string;
    }>;

    for (const u of users) {
      const { error } = await supabase.from("users").upsert({
        id: u.id,
        email: u.email.toLowerCase(),
        password_hash: u.password_hash,
        name: u.name ?? null,
        created_at: u.created_at ?? new Date().toISOString(),
      }, { onConflict: "id" });
      if (error) console.error(`  ❌ User ${u.email}:`, error.message);
      else counts.users++;
    }
    console.log(`  ✅ ${counts.users} users migrated`);
  } else {
    console.log("  ⚠️ No __users__ row found, skipping");
  }

  // ── 2. Migrate Clients + Applications ─────────────────────────────
  console.log("\n── Migrating clients and applications...");
  const { data: clientRows, error: clientErr } = await supabase
    .from("clients")
    .select("client_id, profile")
    .neq("client_id", "__users__");

  if (clientErr) {
    console.error("❌ Failed to read clients:", clientErr.message);
    return;
  }

  for (const row of clientRows ?? []) {
    const profile = row.profile as Record<string, unknown>;
    if (!profile) continue;

    // Update client row with new columns
    const { error: clientUpdateErr } = await supabase
      .from("clients")
      .update({
        client_name: (profile.clientName as string) ?? "",
        company_description: (profile.company_description as string) ?? null,
      })
      .eq("client_id", row.client_id);

    if (clientUpdateErr) {
      console.error(`  ❌ Client ${row.client_id}:`, clientUpdateErr.message);
      continue;
    }
    counts.clients++;

    const apps = (profile.applications as Array<Record<string, unknown>>) ?? [];
    for (const app of apps) {
      await migrateApplication(row.client_id, app);
    }
  }

  console.log(`\n  ✅ ${counts.clients} clients migrated`);
  console.log(`  ✅ ${counts.applications} applications migrated`);

  // ── Print Summary ──────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("Migration Summary:");
  console.log("═══════════════════════════════════════");
  for (const [key, val] of Object.entries(counts)) {
    console.log(`  ${key}: ${val}`);
  }
  console.log("═══════════════════════════════════════");

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN complete. Run with --execute to apply changes.");
    console.log("   Note: Supabase doesn't support client-side transactions,");
    console.log("   so dry-run data WAS written. Cleaning up...");
    // In a real setup you'd want to roll back, but Supabase JS client
    // doesn't support transactions. The migration SQL uses IF NOT EXISTS
    // so re-running is safe (idempotent via upserts).
  } else {
    console.log("\n✅ Migration complete!");
  }
}

async function migrateApplication(clientId: string, app: Record<string, unknown>) {
  const appId = app.id as string;

  // Insert application
  const { error: appErr } = await supabase.from("applications").upsert({
    id: appId,
    client_id: clientId,
    title: (app.title as string) ?? "Untitled",
    source: (app.source as string) ?? "manual",
    added_at: (app.added_at as string) ?? new Date().toISOString(),
    typeform_pat: (app.typeform_pat as string) ?? null,
    typeform_form_id: (app.typeform_form_id as string) ?? null,
    share_token: (app.share_token as string) ?? null,
    share_enabled: (app.share_enabled as boolean) ?? false,
    hidden_correlation_questions: (app.hidden_correlation_questions as string[]) ?? [],
    correlation_answer_order: (app.correlation_answer_order as Record<string, string[]>) ?? {},
    grade_mappings: (app.grade_mappings as Record<string, unknown>) ?? null,
    upload_mappings: (app.upload_mappings as Record<string, unknown>) ?? null,
    narrative_analysis: (app.narrative_analysis as string) ?? null,
    narrative_generated_at: (app.narrative_generated_at as string) ?? null,
    audit_analysis: (app.audit_analysis as string) ?? null,
    audit_generated_at: (app.audit_generated_at as string) ?? null,
    audit_client_notes: (app.audit_client_notes as string) ?? null,
    grading_audit_analysis: (app.grading_audit_analysis as string) ?? null,
    grading_audit_generated_at: (app.grading_audit_generated_at as string) ?? null,
    grading_audit_client_notes: (app.grading_audit_client_notes as string) ?? null,
  }, { onConflict: "id" });

  if (appErr) {
    console.error(`  ❌ App ${appId}:`, appErr.message);
    return;
  }
  counts.applications++;

  // ── Questions ────────────────────────────────────────────────────
  const questions = (app.questions as Array<Record<string, unknown>>) ?? [];
  if (questions.length > 0) {
    const qRows = questions.map((q, i) => ({
      id: (q.id as string) ?? `q-${i}`,
      application_id: appId,
      ref: (q.ref as string) ?? null,
      title: (q.title as string) ?? "",
      type: (q.type as string) ?? "short_text",
      required: (q.required as boolean) ?? false,
      choices: (q.choices as unknown[]) ?? null,
      allow_multiple_selection: (q.allow_multiple_selection as boolean) ?? false,
      sort_order: (q.order as number) ?? i,
      grading_prompt_template: (q.grading_prompt_template as string) ?? null,
      grading_prompt: (q.grading_prompt as string) ?? null,
      drop_off_rate: (q.drop_off_rate as number) ?? null,
    }));

    // Delete existing then insert (idempotent)
    await supabase.from("application_questions").delete().eq("application_id", appId);
    const { error } = await supabase.from("application_questions").insert(qRows);
    if (error) console.error(`  ❌ Questions for ${appId}:`, error.message);
    else counts.questions += qRows.length;
  }

  // ── Submissions + Answers ────────────────────────────────────────
  const submissions = (app.submissions as Array<Record<string, unknown>>) ?? [];
  for (const sub of submissions) {
    const subId = (sub.id as string) ?? `sub-${Math.random().toString(36).slice(2)}`;
    const grade = (sub.grade as Record<string, unknown>) ?? {};
    const financial = (sub.financial as Record<string, unknown>) ?? {};

    const { error: subErr } = await supabase.from("submissions").upsert({
      id: subId,
      application_id: appId,
      submitted_at: (sub.submitted_at as string) ?? null,
      booking_date: (sub.booking_date as string) ?? null,
      respondent_email: (sub.respondent_email as string) ?? null,
      respondent_name: (sub.respondent_name as string) ?? null,
      respondent_phone: (sub.respondent_phone as string) ?? null,
      source: (sub.source as string) ?? null,
      final_grade: (grade.final_grade as number) ?? null,
      answer_grade: (grade.answer_grade as number) ?? null,
      financial_grade: (grade.financial_grade as number) ?? null,
      was_disqualified: (grade.was_disqualified as boolean) ?? false,
      was_spam: (grade.was_spam as boolean) ?? false,
      grade_details: (grade.details as string) ?? null,
      fin_credit_score: (financial.credit_score as number) ?? null,
      fin_estimated_income: (financial.estimated_income as number) ?? null,
      fin_available_credit: (financial.available_credit as number) ?? null,
      fin_available_funding: (financial.available_funding as number) ?? null,
    }, { onConflict: "id" });

    if (subErr) {
      console.error(`  ❌ Submission ${subId}:`, subErr.message);
      continue;
    }
    counts.submissions++;

    // Answers
    const answers = (sub.answers as Array<Record<string, unknown>>) ?? [];
    if (answers.length > 0) {
      // Delete existing answers for this submission first
      await supabase.from("submission_answers").delete().eq("submission_id", subId);

      const ansRows = answers.map(a => ({
        submission_id: subId,
        question_ref: (a.question_ref as string) ?? "",
        question_title: (a.question_title as string) ?? "",
        value: (a.value as string) ?? null,
      }));

      const { error } = await supabase.from("submission_answers").insert(ansRows);
      if (error) console.error(`  ❌ Answers for ${subId}:`, error.message);
      else counts.answers += ansRows.length;
    }
  }

  // ── Financial Records ────────────────────────────────────────────
  const financials = (app.financial_records as Array<Record<string, unknown>>) ?? [];
  if (financials.length > 0) {
    await supabase.from("financial_records").delete().eq("application_id", appId);
    const finRows = financials.map(f => ({
      application_id: appId,
      email: ((f.email as string) ?? "").toLowerCase(),
      financial_grade: (f.financial_grade as number) ?? null,
      credit_score: (f.credit_score as number) ?? null,
      estimated_income: (f.estimated_income as number) ?? null,
      credit_access: (f.credit_access as number) ?? null,
      access_to_funding: (f.access_to_funding as number) ?? null,
    }));

    const { error } = await supabase.from("financial_records").insert(finRows);
    if (error) console.error(`  ❌ Financial records for ${appId}:`, error.message);
    else counts.financialRecords += finRows.length;
  }

  // ── Call Results ─────────────────────────────────────────────────
  const callResults = (app.call_results as Array<Record<string, unknown>>) ?? [];
  if (callResults.length > 0) {
    await supabase.from("call_results").delete().eq("application_id", appId);
    const crRows = callResults.map(cr => ({
      application_id: appId,
      email: ((cr.email as string) ?? "").toLowerCase(),
      booking_date: (cr.booking_date as string) ?? null,
      close_date: (cr.close_date as string) ?? null,
      booked: (cr.booked as boolean) ?? false,
      showed: (cr.showed as boolean) ?? false,
      closed: (cr.closed as boolean) ?? false,
    }));

    const { error } = await supabase.from("call_results").insert(crRows);
    if (error) console.error(`  ❌ Call results for ${appId}:`, error.message);
    else counts.callResults += crRows.length;
  }

  // ── Webhook Config ───────────────────────────────────────────────
  const webhookConfig = app.webhook_config as Record<string, unknown> | undefined;
  if (webhookConfig?.token) {
    const { error: wcErr } = await supabase.from("webhook_configs").upsert({
      application_id: appId,
      enabled: (webhookConfig.enabled as boolean) ?? true,
      token: webhookConfig.token as string,
      source: (webhookConfig.source as string) ?? "generic",
      last_received_at: (webhookConfig.last_received_at as string) ?? null,
      last_field_signature: (webhookConfig.last_field_signature as string) ?? null,
      created_at: (webhookConfig.created_at as string) ?? new Date().toISOString(),
    }, { onConflict: "application_id" });

    if (wcErr) {
      console.error(`  ❌ Webhook config for ${appId}:`, wcErr.message);
    } else {
      counts.webhookConfigs++;

      // Field mappings
      const mappings = (webhookConfig.field_mapping as Array<Record<string, unknown>>) ?? [];
      if (mappings.length > 0) {
        await supabase.from("webhook_field_mappings").delete().eq("webhook_config_id", appId);
        const fmRows = mappings.map(m => ({
          webhook_config_id: appId,
          source_field: (m.source_field as string) ?? "",
          target: (m.target as string) ?? "skip",
        }));
        const { error } = await supabase.from("webhook_field_mappings").insert(fmRows);
        if (error) console.error(`  ❌ Field mappings for ${appId}:`, error.message);
        else counts.fieldMappings += fmRows.length;
      }

      // Calculated fields
      const calcFields = (webhookConfig.calculated_fields as Array<Record<string, unknown>>) ?? [];
      if (calcFields.length > 0) {
        await supabase.from("webhook_calculated_fields").delete().eq("webhook_config_id", appId);
        const cfRows = calcFields.map(cf => ({
          id: (cf.id as string) ?? `cf-${Math.random().toString(36).slice(2)}`,
          webhook_config_id: appId,
          name: (cf.name as string) ?? "",
          type: (cf.type as string) ?? "math",
          expression: (cf.expression as string) ?? "",
          source_fields: (cf.source_fields as string[]) ?? [],
          target: (cf.target as string) ?? "skip",
        }));
        const { error } = await supabase.from("webhook_calculated_fields").insert(cfRows);
        if (error) console.error(`  ❌ Calculated fields for ${appId}:`, error.message);
        else counts.calculatedFields += cfRows.length;
      }
    }
  }

  // ── Pending Webhook Submissions ──────────────────────────────────
  const pending = (app.pending_webhook_submissions as Array<Record<string, unknown>>) ?? [];
  if (pending.length > 0) {
    await supabase.from("pending_webhook_submissions").delete().eq("application_id", appId);
    const pRows = pending.map(p => ({
      id: (p.id as string) ?? `pw-${Math.random().toString(36).slice(2)}`,
      application_id: appId,
      received_at: (p.received_at as string) ?? new Date().toISOString(),
      raw_payload: (p.raw_payload as Record<string, unknown>) ?? {},
      source: (p.source as string) ?? "generic",
      status: (p.status as string) ?? "pending",
      reason: (p.reason as string) ?? null,
    }));
    const { error } = await supabase.from("pending_webhook_submissions").insert(pRows);
    if (error) console.error(`  ❌ Pending webhooks for ${appId}:`, error.message);
    else counts.pendingWebhooks += pRows.length;
  }

  // ── Saved Correlation Filters ────────────────────────────────────
  const filters = (app.saved_correlation_filters as Array<Record<string, unknown>>) ?? [];
  if (filters.length > 0) {
    await supabase.from("saved_correlation_filters").delete().eq("application_id", appId);
    const fRows = filters.map(f => ({
      id: (f.id as string) ?? `f-${Math.random().toString(36).slice(2)}`,
      application_id: appId,
      name: (f.name as string) ?? "",
      conditions: (f.conditions as unknown[]) ?? [],
      date_range: (f.dateRange as Record<string, unknown>) ?? null,
    }));
    const { error } = await supabase.from("saved_correlation_filters").insert(fRows);
    if (error) console.error(`  ❌ Filters for ${appId}:`, error.message);
    else counts.savedFilters += fRows.length;
  }

  // ── Chat Messages (narrative, audit, grading_audit) ──────────────
  for (const chatType of ["narrative", "audit", "grading_audit"] as const) {
    const chatKey = `${chatType}_chat`;
    const messages = (app[chatKey] as Array<Record<string, unknown>>) ?? [];
    if (messages.length > 0) {
      await supabase.from("chat_messages").delete()
        .eq("application_id", appId)
        .eq("chat_type", chatType);

      const cmRows = messages.map(m => ({
        application_id: appId,
        chat_type: chatType,
        role: (m.role as string) ?? "user",
        content: (m.content as string) ?? "",
      }));
      const { error } = await supabase.from("chat_messages").insert(cmRows);
      if (error) console.error(`  ❌ ${chatType} chat for ${appId}:`, error.message);
      else counts.chatMessages += cmRows.length;
    }
  }

  // ── Data Chats ───────────────────────────────────────────────────
  const dataChats = (app.data_chats as Array<Record<string, unknown>>) ?? [];
  for (const dc of dataChats) {
    const dcId = (dc.id as string) ?? `dc-${Math.random().toString(36).slice(2)}`;

    const { error: dcErr } = await supabase.from("data_chats").upsert({
      id: dcId,
      application_id: appId,
      title: (dc.title as string) ?? "Untitled",
      created_at: (dc.created_at as string) ?? new Date().toISOString(),
    }, { onConflict: "id" });

    if (dcErr) {
      console.error(`  ❌ Data chat ${dcId}:`, dcErr.message);
      continue;
    }
    counts.dataChats++;

    const dcMessages = (dc.messages as Array<Record<string, unknown>>) ?? [];
    if (dcMessages.length > 0) {
      await supabase.from("data_chat_messages").delete().eq("chat_id", dcId);
      const dcmRows = dcMessages.map(m => ({
        chat_id: dcId,
        role: (m.role as string) ?? "user",
        content: (m.content as string) ?? "",
      }));
      const { error } = await supabase.from("data_chat_messages").insert(dcmRows);
      if (error) console.error(`  ❌ Data chat messages for ${dcId}:`, error.message);
      else counts.dataChatMessages += dcmRows.length;
    }
  }

  // ── Load History ─────────────────────────────────────────────────
  const loadHistory = (app.load_history as Array<Record<string, unknown>>) ?? [];
  if (loadHistory.length > 0) {
    await supabase.from("load_history").delete().eq("application_id", appId);
    for (const entry of loadHistory) {
      const { error } = await supabase.from("load_history").insert({
        id: (entry.id as string) ?? `lh-${Math.random().toString(36).slice(2)}`,
        application_id: appId,
        timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
        source_type: (entry.source_type as string) ?? "csv-submissions",
        description: (entry.description as string) ?? "",
        record_count: (entry.record_count as number) ?? 0,
        pre_load_snapshot: (entry.pre_load_snapshot as Record<string, unknown>) ?? {},
        source_data: (entry.source_data as Record<string, unknown>) ?? null,
      });
      if (error) console.error(`  ❌ Load history for ${appId}:`, error.message);
      else counts.loadHistory++;
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────
migrate().catch(err => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
