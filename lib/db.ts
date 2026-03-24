import { supabase } from "./supabase";
import type {
  Application,
  ApplicationQuestion,
  AppSubmission,
  AppSubmissionAnswer,
  AppSubmissionGrade,
  AppSubmissionFinancial,
  CallResultRecord,
  ChatMessage,
  DataChat,
  CalculatedField,
  ClientProfile,
  FinancialRecord,
  LoadHistoryEntry,
  LoadHistoryDataSnapshot,
  LoadHistorySourceData,
  PendingWebhookSubmission,
  SavedColumnMapping,
  SavedCorrelationFilter,
  WebhookConfig,
  WebhookFieldMapping,
} from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,60}$/.test(id);
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── Aggregate Stats ──────────────────────────────────────────────────────

export interface AggregateStats {
  totalClients: number;
  totalApplications: number;
  totalSubmissions: number;
  totalCallResults: number;
  totalFinancialRecords: number;
  totalQuestions: number;
  totalAuditsGenerated: number;
  totalGradingAuditsGenerated: number;
  totalBookings: number;
  totalShows: number;
  totalCloses: number;
}

export async function getAggregateStats(): Promise<AggregateStats> {
  const empty: AggregateStats = {
    totalClients: 0,
    totalApplications: 0,
    totalSubmissions: 0,
    totalCallResults: 0,
    totalFinancialRecords: 0,
    totalQuestions: 0,
    totalAuditsGenerated: 0,
    totalGradingAuditsGenerated: 0,
    totalBookings: 0,
    totalShows: 0,
    totalCloses: 0,
  };

  // Parallel count queries across proper relational tables
  const [
    clientsRes,
    appsRes,
    subsRes,
    callRes,
    finRes,
    questionsRes,
    auditsRes,
    gradingAuditsRes,
    bookedRes,
    showedRes,
    closedRes,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select("*", { count: "exact", head: true })
      .neq("client_id", "__users__"),
    supabase.from("applications").select("*", { count: "exact", head: true }),
    supabase.from("submissions").select("*", { count: "exact", head: true }),
    supabase.from("call_results").select("*", { count: "exact", head: true }),
    supabase
      .from("financial_records")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("application_questions")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("applications")
      .select("*", { count: "exact", head: true })
      .not("audit_analysis", "is", null),
    supabase
      .from("applications")
      .select("*", { count: "exact", head: true })
      .not("grading_audit_analysis", "is", null),
    supabase
      .from("call_results")
      .select("*", { count: "exact", head: true })
      .eq("booked", true),
    supabase
      .from("call_results")
      .select("*", { count: "exact", head: true })
      .eq("showed", true),
    supabase
      .from("call_results")
      .select("*", { count: "exact", head: true })
      .eq("closed", true),
  ]);

  return {
    totalClients: clientsRes.count ?? 0,
    totalApplications: appsRes.count ?? 0,
    totalSubmissions: subsRes.count ?? 0,
    totalCallResults: callRes.count ?? 0,
    totalFinancialRecords: finRes.count ?? 0,
    totalQuestions: questionsRes.count ?? 0,
    totalAuditsGenerated: auditsRes.count ?? 0,
    totalGradingAuditsGenerated: gradingAuditsRes.count ?? 0,
    totalBookings: bookedRes.count ?? 0,
    totalShows: showedRes.count ?? 0,
    totalCloses: closedRes.count ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function listClients(): Promise<
  {
    clientId: string;
    clientName: string;
    created_at: string;
    appCount: number;
  }[]
> {
  // Fetch clients with an application count subquery
  const { data, error } = await supabase
    .from("clients")
    .select("client_id, client_name, created_at, applications(count)")
    .neq("client_id", "__users__")
    .order("client_name", { ascending: true });

  if (error) {
    console.error("listClients error:", error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => {
    // Supabase returns aggregated counts as [{count: N}]
    const appsArr = row.applications as { count: number }[] | undefined;
    const appCount = appsArr?.[0]?.count ?? 0;
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string) ?? "",
      created_at: (row.created_at as string) ?? "",
      appCount,
    };
  });
}

export async function readClient(
  clientId: string
): Promise<{
  clientId: string;
  clientName: string;
  company_description?: string;
  created_at: string;
} | null> {
  if (!isValidId(clientId)) return null;

  const { data, error } = await supabase
    .from("clients")
    .select("client_id, client_name, company_description, created_at")
    .eq("client_id", clientId)
    .single();

  if (error || !data) return null;

  return {
    clientId: data.client_id,
    clientName: data.client_name ?? "",
    company_description: data.company_description ?? undefined,
    created_at: data.created_at ?? "",
  };
}

export async function createClient(
  name: string
): Promise<ClientProfile> {
  const baseId =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "client";

  let finalId = baseId;
  let counter = 1;
  while (true) {
    const { data } = await supabase
      .from("clients")
      .select("client_id")
      .eq("client_id", finalId)
      .single();
    if (!data) break;
    finalId = `${baseId}-${counter++}`;
    if (counter > 1000) throw new Error("Too many client name collisions");
  }

  const now = isoNow();
  const { error } = await supabase.from("clients").insert({
    client_id: finalId,
    client_name: name,
    created_at: now,
    updated_at: now,
  });

  if (error) {
    console.error("createClient error:", error.message);
    throw new Error("Failed to create client");
  }

  return {
    clientId: finalId,
    clientName: name,
    created_at: now,
    updated_at: now,
    applications: [],
  };
}

export async function updateClient(
  clientId: string,
  fields: { client_name?: string; company_description?: string }
): Promise<void> {
  if (!isValidId(clientId)) throw new Error("Invalid clientId");

  const { error } = await supabase
    .from("clients")
    .update({ ...fields, updated_at: isoNow() })
    .eq("client_id", clientId);

  if (error) {
    console.error(`updateClient ${clientId} error:`, error.message);
    throw new Error("Failed to update client");
  }
}

export async function deleteClient(clientId: string): Promise<boolean> {
  if (!isValidId(clientId)) return false;

  const { error, count } = await supabase
    .from("clients")
    .delete({ count: "exact" })
    .eq("client_id", clientId);

  if (error) {
    console.error(`deleteClient ${clientId} error:`, error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function listApplications(
  clientId: string
): Promise<
  {
    id: string;
    title: string;
    source: string;
    added_at: string;
    share_enabled: boolean;
  }[]
> {
  const { data, error } = await supabase
    .from("applications")
    .select("id, title, source, added_at, share_enabled")
    .eq("client_id", clientId)
    .order("added_at", { ascending: true });

  if (error) {
    console.error("listApplications error:", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source,
    added_at: r.added_at,
    share_enabled: r.share_enabled ?? false,
  }));
}

/**
 * Assemble the full Application object from relational tables.
 * Uses Promise.all for parallel queries.
 */
export async function readApplicationFull(
  appId: string
): Promise<Application | null> {
  // 1. Fetch the application row
  const { data: appRow, error: appError } = await supabase
    .from("applications")
    .select("*")
    .eq("id", appId)
    .single();

  if (appError || !appRow) return null;

  // 2. Parallel fetch all child tables
  const [
    questionsRes,
    submissionsRes,
    answersRes,
    financialRes,
    callResultsRes,
    webhookConfigRes,
    fieldMappingsRes,
    calcFieldsRes,
    pendingWebhooksRes,
    filtersRes,
    narrativeChatRes,
    auditChatRes,
    gradingAuditChatRes,
    dataChatsRes,
    dataChatMsgsRes,
    loadHistoryRes,
    uploadMappingsRes,
  ] = await Promise.all([
    supabase
      .from("application_questions")
      .select("*")
      .eq("application_id", appId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("submissions")
      .select("*")
      .eq("application_id", appId)
      .order("submitted_at", { ascending: true }),
    supabase
      .from("submission_answers")
      .select("*")
      .in(
        "submission_id",
        // We need submission IDs — use a subquery approach:
        // First collect them after submissionsRes resolves, but since we're
        // in Promise.all we need all sub IDs. We'll filter after.
        // Actually, we can't reference submissionsRes here.
        // Instead, we'll fetch ALL answers for this app's submissions
        // by using a join approach via Supabase's filter.
        [] // placeholder — we'll re-fetch below
      ),
    supabase
      .from("financial_records")
      .select("*")
      .eq("application_id", appId),
    supabase
      .from("call_results")
      .select("*")
      .eq("application_id", appId),
    supabase
      .from("webhook_configs")
      .select("*")
      .eq("application_id", appId)
      .maybeSingle(),
    supabase
      .from("webhook_field_mappings")
      .select("*")
      .eq("webhook_config_id", appId),
    supabase
      .from("webhook_calculated_fields")
      .select("*")
      .eq("webhook_config_id", appId),
    supabase
      .from("pending_webhook_submissions")
      .select("*")
      .eq("application_id", appId)
      .order("received_at", { ascending: true }),
    supabase
      .from("saved_correlation_filters")
      .select("*")
      .eq("application_id", appId),
    supabase
      .from("chat_messages")
      .select("*")
      .eq("application_id", appId)
      .eq("chat_type", "narrative")
      .order("created_at", { ascending: true }),
    supabase
      .from("chat_messages")
      .select("*")
      .eq("application_id", appId)
      .eq("chat_type", "audit")
      .order("created_at", { ascending: true }),
    supabase
      .from("chat_messages")
      .select("*")
      .eq("application_id", appId)
      .eq("chat_type", "grading_audit")
      .order("created_at", { ascending: true }),
    supabase
      .from("data_chats")
      .select("*")
      .eq("application_id", appId)
      .order("created_at", { ascending: true }),
    supabase
      .from("data_chat_messages")
      .select("*")
      .order("created_at", { ascending: true }),
    supabase
      .from("load_history")
      .select("*")
      .eq("application_id", appId)
      .order("timestamp", { ascending: true }),
    supabase
      .from("upload_mappings")
      .select("*")
      .eq("application_id", appId),
  ]);

  // 3. Fetch submission answers now that we have submission IDs
  const submissionIds = (submissionsRes.data ?? []).map(
    (s: Record<string, unknown>) => s.id as string
  );
  let allAnswers: Record<string, unknown>[] = [];
  if (submissionIds.length > 0) {
    // Batch in chunks of 500 to avoid URL length limits
    const chunks: string[][] = [];
    for (let i = 0; i < submissionIds.length; i += 500) {
      chunks.push(submissionIds.slice(i, i + 500));
    }
    const answerResults = await Promise.all(
      chunks.map((chunk) =>
        supabase
          .from("submission_answers")
          .select("*")
          .in("submission_id", chunk)
      )
    );
    for (const res of answerResults) {
      if (res.data) allAnswers.push(...res.data);
    }
  }

  // 4. Group answers by submission_id
  const answersBySubmission = new Map<string, AppSubmissionAnswer[]>();
  for (const a of allAnswers) {
    const subId = a.submission_id as string;
    if (!answersBySubmission.has(subId)) {
      answersBySubmission.set(subId, []);
    }
    answersBySubmission.get(subId)!.push({
      question_ref: a.question_ref as string,
      question_title: a.question_title as string,
      value: (a.value as string) ?? null,
    });
  }

  // 5. Assemble questions
  const questions: ApplicationQuestion[] = (questionsRes.data ?? []).map(
    (q: Record<string, unknown>) => ({
      id: q.id as string,
      ref: (q.ref as string) ?? undefined,
      title: q.title as string,
      type: q.type as ApplicationQuestion["type"],
      required: (q.required as boolean) ?? false,
      choices: (q.choices as ApplicationQuestion["choices"]) ?? undefined,
      allow_multiple_selection:
        (q.allow_multiple_selection as boolean) ?? undefined,
      order: (q.sort_order as number) ?? 0,
      grading_prompt_template:
        (q.grading_prompt_template as string) ?? undefined,
      grading_prompt: (q.grading_prompt as string) ?? undefined,
      drop_off_rate: (q.drop_off_rate as number) ?? undefined,
    })
  );

  // 6. Assemble submissions with nested answers, grade, financial
  const submissions: AppSubmission[] = (submissionsRes.data ?? []).map(
    (s: Record<string, unknown>) => {
      const subId = s.id as string;
      const answers = answersBySubmission.get(subId) ?? [];

      const grade: AppSubmissionGrade | undefined =
        s.final_grade != null ||
        s.answer_grade != null ||
        s.financial_grade != null ||
        s.was_disqualified ||
        s.was_spam ||
        s.grade_details
          ? {
              final_grade: (s.final_grade as number) ?? undefined,
              answer_grade: (s.answer_grade as number) ?? undefined,
              financial_grade: (s.financial_grade as number) ?? undefined,
              was_disqualified: (s.was_disqualified as boolean) ?? undefined,
              was_spam: (s.was_spam as boolean) ?? undefined,
              details: (s.grade_details as string) ?? undefined,
            }
          : undefined;

      const financial: AppSubmissionFinancial | undefined =
        s.fin_credit_score != null ||
        s.fin_estimated_income != null ||
        s.fin_available_credit != null ||
        s.fin_available_funding != null
          ? {
              credit_score: (s.fin_credit_score as number) ?? undefined,
              estimated_income: (s.fin_estimated_income as number) ?? undefined,
              available_credit:
                (s.fin_available_credit as number) ?? undefined,
              available_funding:
                (s.fin_available_funding as number) ?? undefined,
            }
          : undefined;

      return {
        id: subId,
        submitted_at: (s.submitted_at as string) ?? "",
        booking_date: (s.booking_date as string) ?? undefined,
        respondent_email: (s.respondent_email as string) ?? undefined,
        respondent_name: (s.respondent_name as string) ?? undefined,
        respondent_phone: (s.respondent_phone as string) ?? undefined,
        source: (s.source as AppSubmission["source"]) ?? undefined,
        answers,
        grade,
        financial,
      };
    }
  );

  // 7. Assemble financial records
  const financialRecords: FinancialRecord[] = (financialRes.data ?? []).map(
    (r: Record<string, unknown>) => ({
      email: r.email as string,
      financial_grade: (r.financial_grade as number) ?? undefined,
      credit_score: (r.credit_score as number) ?? undefined,
      estimated_income: (r.estimated_income as number) ?? undefined,
      credit_access: (r.credit_access as number) ?? undefined,
      access_to_funding: (r.access_to_funding as number) ?? undefined,
    })
  );

  // 8. Assemble call results
  const callResults: CallResultRecord[] = (callResultsRes.data ?? []).map(
    (r: Record<string, unknown>) => ({
      email: r.email as string,
      booking_date: (r.booking_date as string) ?? undefined,
      close_date: (r.close_date as string) ?? undefined,
      booked: (r.booked as boolean) ?? false,
      showed: (r.showed as boolean) ?? false,
      closed: (r.closed as boolean) ?? false,
    })
  );

  // 9. Assemble webhook config
  let webhookConfig: WebhookConfig | undefined;
  if (webhookConfigRes.data) {
    const wc = webhookConfigRes.data;
    const fieldMapping: WebhookFieldMapping[] = (
      fieldMappingsRes.data ?? []
    ).map((fm: Record<string, unknown>) => ({
      source_field: fm.source_field as string,
      target: fm.target as string,
    }));

    const calculatedFields: CalculatedField[] = (
      calcFieldsRes.data ?? []
    ).map((cf: Record<string, unknown>) => ({
      id: cf.id as string,
      name: cf.name as string,
      type: cf.type as CalculatedField["type"],
      expression: cf.expression as string,
      source_fields: (cf.source_fields as string[]) ?? [],
      target: cf.target as string,
    }));

    webhookConfig = {
      enabled: (wc.enabled as boolean) ?? true,
      token: wc.token as string,
      source: wc.source as WebhookConfig["source"],
      field_mapping: fieldMapping,
      calculated_fields:
        calculatedFields.length > 0 ? calculatedFields : undefined,
      last_received_at: (wc.last_received_at as string) ?? undefined,
      last_field_signature: (wc.last_field_signature as string) ?? undefined,
      created_at: (wc.created_at as string) ?? "",
    };
  }

  // 10. Assemble pending webhook submissions
  const pendingWebhookSubmissions: PendingWebhookSubmission[] = (
    pendingWebhooksRes.data ?? []
  ).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    received_at: (p.received_at as string) ?? "",
    raw_payload: (p.raw_payload as Record<string, unknown>) ?? {},
    source: (p.source as string) ?? "",
    status: (p.status as PendingWebhookSubmission["status"]) ?? "pending",
    reason: (p.reason as string) ?? undefined,
  }));

  // 11. Assemble saved correlation filters
  const savedCorrelationFilters: SavedCorrelationFilter[] = (
    filtersRes.data ?? []
  ).map((f: Record<string, unknown>) => ({
    id: f.id as string,
    name: f.name as string,
    conditions: (f.conditions as SavedCorrelationFilter["conditions"]) ?? [],
    dateRange: (f.date_range as SavedCorrelationFilter["dateRange"]) ?? undefined,
  }));

  // 12. Assemble chat messages
  const narrativeChat: ChatMessage[] = (narrativeChatRes.data ?? []).map(
    (m: Record<string, unknown>) => ({
      role: m.role as ChatMessage["role"],
      content: m.content as string,
    })
  );

  const auditChat: ChatMessage[] = (auditChatRes.data ?? []).map(
    (m: Record<string, unknown>) => ({
      role: m.role as ChatMessage["role"],
      content: m.content as string,
    })
  );

  const gradingAuditChat: ChatMessage[] = (gradingAuditChatRes.data ?? []).map(
    (m: Record<string, unknown>) => ({
      role: m.role as ChatMessage["role"],
      content: m.content as string,
    })
  );

  // 13. Assemble data chats with nested messages
  const dataChatIds = (dataChatsRes.data ?? []).map(
    (dc: Record<string, unknown>) => dc.id as string
  );
  const dataChatMsgMap = new Map<string, ChatMessage[]>();
  for (const msg of dataChatMsgsRes.data ?? []) {
    const chatId = msg.chat_id as string;
    if (!dataChatIds.includes(chatId)) continue; // filter to this app
    if (!dataChatMsgMap.has(chatId)) dataChatMsgMap.set(chatId, []);
    dataChatMsgMap.get(chatId)!.push({
      role: msg.role as ChatMessage["role"],
      content: msg.content as string,
    });
  }

  const dataChats: DataChat[] = (dataChatsRes.data ?? []).map(
    (dc: Record<string, unknown>) => ({
      id: dc.id as string,
      title: dc.title as string,
      messages: dataChatMsgMap.get(dc.id as string) ?? [],
      created_at: (dc.created_at as string) ?? "",
    })
  );

  // 14. Assemble load history
  const loadHistory: LoadHistoryEntry[] = (loadHistoryRes.data ?? []).map(
    (lh: Record<string, unknown>) => ({
      id: lh.id as string,
      timestamp: (lh.timestamp as string) ?? "",
      source_type: lh.source_type as LoadHistoryEntry["source_type"],
      description: (lh.description as string) ?? "",
      record_count: (lh.record_count as number) ?? 0,
      pre_load_snapshot:
        (lh.pre_load_snapshot as LoadHistoryDataSnapshot) ?? {},
      source_data: (lh.source_data as LoadHistorySourceData) ?? undefined,
    })
  );

  // 15. Assemble upload mappings
  const uploadMappingsRaw = uploadMappingsRes.data ?? [];
  let uploadMappings: Application["upload_mappings"] | undefined;
  if (uploadMappingsRaw.length > 0) {
    uploadMappings = {};
    for (const um of uploadMappingsRaw) {
      const uploadType = um.upload_type as string;
      const mapping: SavedColumnMapping = {
        upload_type: uploadType as SavedColumnMapping["upload_type"],
        entries: (um.entries as SavedColumnMapping["entries"]) ?? [],
        saved_at: (um.saved_at as string) ?? "",
      };
      if (uploadType === "submissions") uploadMappings.submissions = mapping;
      else if (uploadType === "financial") uploadMappings.financial = mapping;
      else if (uploadType === "call_results")
        uploadMappings.call_results = mapping;
    }
  }

  // 16. Final assembly
  const app: Application = {
    id: appRow.id,
    title: appRow.title,
    source: appRow.source ?? "manual",
    added_at: appRow.added_at ?? "",
    questions,
    submissions: submissions.length > 0 ? submissions : undefined,
    financial_records:
      financialRecords.length > 0 ? financialRecords : undefined,
    call_results: callResults.length > 0 ? callResults : undefined,
    upload_mappings: uploadMappings,
    grade_mappings: appRow.grade_mappings ?? undefined,
    hidden_correlation_questions:
      appRow.hidden_correlation_questions ?? undefined,
    correlation_answer_order: appRow.correlation_answer_order ?? undefined,
    saved_correlation_filters:
      savedCorrelationFilters.length > 0
        ? savedCorrelationFilters
        : undefined,
    typeform_pat: appRow.typeform_pat ?? undefined,
    typeform_form_id: appRow.typeform_form_id ?? undefined,
    narrative_analysis: appRow.narrative_analysis ?? undefined,
    narrative_generated_at: appRow.narrative_generated_at ?? undefined,
    audit_analysis: appRow.audit_analysis ?? undefined,
    audit_generated_at: appRow.audit_generated_at ?? undefined,
    audit_client_notes: appRow.audit_client_notes ?? undefined,
    narrative_chat: narrativeChat.length > 0 ? narrativeChat : undefined,
    audit_chat: auditChat.length > 0 ? auditChat : undefined,
    grading_audit_analysis: appRow.grading_audit_analysis ?? undefined,
    grading_audit_generated_at:
      appRow.grading_audit_generated_at ?? undefined,
    grading_audit_client_notes:
      appRow.grading_audit_client_notes ?? undefined,
    grading_audit_chat:
      gradingAuditChat.length > 0 ? gradingAuditChat : undefined,
    data_chats: dataChats.length > 0 ? dataChats : undefined,
    share_token: appRow.share_token ?? undefined,
    share_enabled: appRow.share_enabled ?? undefined,
    webhook_config: webhookConfig,
    pending_webhook_submissions:
      pendingWebhookSubmissions.length > 0
        ? pendingWebhookSubmissions
        : undefined,
    load_history: loadHistory.length > 0 ? loadHistory : undefined,
  };

  return app;
}

export async function createApplication(
  clientId: string,
  title: string
): Promise<Application> {
  const id = uid();
  const now = isoNow();

  const { error } = await supabase.from("applications").insert({
    id,
    client_id: clientId,
    title,
    source: "manual",
    added_at: now,
    created_at: now,
    updated_at: now,
  });

  if (error) {
    console.error("createApplication error:", error.message);
    throw new Error("Failed to create application");
  }

  return {
    id,
    title,
    source: "manual",
    added_at: now,
    questions: [],
  };
}

export async function updateApplicationFields(
  appId: string,
  fields: Partial<
    Pick<
      Application,
      | "title"
      | "typeform_pat"
      | "typeform_form_id"
      | "share_token"
      | "share_enabled"
      | "narrative_analysis"
      | "narrative_generated_at"
      | "audit_analysis"
      | "audit_generated_at"
      | "audit_client_notes"
      | "grading_audit_analysis"
      | "grading_audit_generated_at"
      | "grading_audit_client_notes"
      | "hidden_correlation_questions"
      | "correlation_answer_order"
      | "grade_mappings"
    >
  > & {
    upload_mappings?: Application["upload_mappings"];
  }
): Promise<void> {
  // Separate upload_mappings — those go to their own table
  const { upload_mappings, ...appFields } = fields;

  if (Object.keys(appFields).length > 0) {
    const { error } = await supabase
      .from("applications")
      .update({ ...appFields, updated_at: isoNow() })
      .eq("id", appId);

    if (error) {
      console.error(`updateApplicationFields ${appId} error:`, error.message);
      throw new Error("Failed to update application");
    }
  }

  // Handle upload_mappings separately
  if (upload_mappings !== undefined) {
    // Delete existing
    await supabase
      .from("upload_mappings")
      .delete()
      .eq("application_id", appId);

    const rows: {
      application_id: string;
      upload_type: string;
      entries: unknown;
      saved_at: string;
    }[] = [];
    if (upload_mappings?.submissions) {
      rows.push({
        application_id: appId,
        upload_type: "submissions",
        entries: upload_mappings.submissions.entries,
        saved_at: upload_mappings.submissions.saved_at,
      });
    }
    if (upload_mappings?.financial) {
      rows.push({
        application_id: appId,
        upload_type: "financial",
        entries: upload_mappings.financial.entries,
        saved_at: upload_mappings.financial.saved_at,
      });
    }
    if (upload_mappings?.call_results) {
      rows.push({
        application_id: appId,
        upload_type: "call_results",
        entries: upload_mappings.call_results.entries,
        saved_at: upload_mappings.call_results.saved_at,
      });
    }
    if (rows.length > 0) {
      await supabase.from("upload_mappings").insert(rows);
    }
  }
}

export async function deleteApplication(appId: string): Promise<boolean> {
  const { error, count } = await supabase
    .from("applications")
    .delete({ count: "exact" })
    .eq("id", appId);

  if (error) {
    console.error(`deleteApplication ${appId} error:`, error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBMISSION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function bulkUpsertSubmissions(
  appId: string,
  submissions: AppSubmission[]
): Promise<void> {
  if (submissions.length === 0) return;

  // Process in batches to avoid payload limits
  const BATCH_SIZE = 200;

  for (let i = 0; i < submissions.length; i += BATCH_SIZE) {
    const batch = submissions.slice(i, i + BATCH_SIZE);

    // Upsert submission rows
    const submissionRows = batch.map((s) => ({
      id: s.id,
      application_id: appId,
      submitted_at: s.submitted_at || null,
      booking_date: s.booking_date || null,
      respondent_email: s.respondent_email || null,
      respondent_name: s.respondent_name || null,
      respondent_phone: s.respondent_phone || null,
      source: s.source || null,
      // Flatten grade
      final_grade: s.grade?.final_grade ?? null,
      answer_grade: s.grade?.answer_grade ?? null,
      financial_grade: s.grade?.financial_grade ?? null,
      was_disqualified: s.grade?.was_disqualified ?? false,
      was_spam: s.grade?.was_spam ?? false,
      grade_details: s.grade?.details ?? null,
      // Flatten financial
      fin_credit_score: s.financial?.credit_score ?? null,
      fin_estimated_income: s.financial?.estimated_income ?? null,
      fin_available_credit: s.financial?.available_credit ?? null,
      fin_available_funding: s.financial?.available_funding ?? null,
    }));

    const { error: upsertError } = await supabase
      .from("submissions")
      .upsert(submissionRows, { onConflict: "id" });

    if (upsertError) {
      console.error("bulkUpsertSubmissions upsert error:", upsertError.message);
      throw new Error("Failed to upsert submissions");
    }

    // Delete existing answers for these submissions, then insert new ones
    const batchIds = batch.map((s) => s.id);

    // Delete in chunks
    for (let j = 0; j < batchIds.length; j += 500) {
      const chunk = batchIds.slice(j, j + 500);
      await supabase
        .from("submission_answers")
        .delete()
        .in("submission_id", chunk);
    }

    // Collect all answer rows
    const answerRows: {
      submission_id: string;
      question_ref: string;
      question_title: string;
      value: string | null;
    }[] = [];

    for (const s of batch) {
      for (const a of s.answers) {
        answerRows.push({
          submission_id: s.id,
          question_ref: a.question_ref,
          question_title: a.question_title,
          value: a.value,
        });
      }
    }

    // Insert answers in batches
    for (let j = 0; j < answerRows.length; j += 500) {
      const chunk = answerRows.slice(j, j + 500);
      const { error: ansError } = await supabase
        .from("submission_answers")
        .insert(chunk);

      if (ansError) {
        console.error(
          "bulkUpsertSubmissions answers error:",
          ansError.message
        );
        throw new Error("Failed to insert submission answers");
      }
    }
  }
}

export async function deleteAllSubmissions(appId: string): Promise<void> {
  // Cascade will handle submission_answers
  const { error } = await supabase
    .from("submissions")
    .delete()
    .eq("application_id", appId);

  if (error) {
    console.error("deleteAllSubmissions error:", error.message);
    throw new Error("Failed to delete submissions");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL / CALL RESULT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function replaceFinancialRecords(
  appId: string,
  records: FinancialRecord[]
): Promise<void> {
  // Delete existing
  await supabase
    .from("financial_records")
    .delete()
    .eq("application_id", appId);

  if (records.length === 0) return;

  const rows = records.map((r) => ({
    application_id: appId,
    email: r.email,
    financial_grade: r.financial_grade ?? null,
    credit_score: r.credit_score ?? null,
    estimated_income: r.estimated_income ?? null,
    credit_access: r.credit_access ?? null,
    access_to_funding: r.access_to_funding ?? null,
  }));

  // Insert in batches
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("financial_records").insert(chunk);
    if (error) {
      console.error("replaceFinancialRecords error:", error.message);
      throw new Error("Failed to insert financial records");
    }
  }
}

export async function replaceCallResults(
  appId: string,
  records: CallResultRecord[]
): Promise<void> {
  // Delete existing
  await supabase.from("call_results").delete().eq("application_id", appId);

  if (records.length === 0) return;

  const rows = records.map((r) => ({
    application_id: appId,
    email: r.email,
    booking_date: r.booking_date ?? null,
    close_date: r.close_date ?? null,
    booked: r.booked ?? false,
    showed: r.showed ?? false,
    closed: r.closed ?? false,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("call_results").insert(chunk);
    if (error) {
      console.error("replaceCallResults error:", error.message);
      throw new Error("Failed to insert call results");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// QUESTION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function replaceQuestions(
  appId: string,
  questions: ApplicationQuestion[]
): Promise<void> {
  // Delete existing
  await supabase
    .from("application_questions")
    .delete()
    .eq("application_id", appId);

  if (questions.length === 0) return;

  const rows = questions.map((q) => ({
    id: q.id,
    application_id: appId,
    ref: q.ref ?? null,
    title: q.title,
    type: q.type,
    required: q.required ?? false,
    choices: q.choices ?? null,
    allow_multiple_selection: q.allow_multiple_selection ?? false,
    sort_order: q.order ?? 0,
    grading_prompt_template: q.grading_prompt_template ?? null,
    grading_prompt: q.grading_prompt ?? null,
    drop_off_rate: q.drop_off_rate ?? null,
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("application_questions")
      .insert(chunk);
    if (error) {
      console.error("replaceQuestions error:", error.message);
      throw new Error("Failed to insert questions");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function findAppByWebhookToken(
  token: string
): Promise<{
  clientId: string;
  appId: string;
  app: Application;
} | null> {
  const { data, error } = await supabase
    .from("webhook_configs")
    .select("application_id, applications!inner(client_id)")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return null;

  const appId = data.application_id as string;
  const clientId = (
    data.applications as unknown as { client_id: string }
  ).client_id;

  const app = await readApplicationFull(appId);
  if (!app) return null;

  return { clientId, appId, app };
}

export async function upsertWebhookConfig(
  appId: string,
  config: WebhookConfig
): Promise<void> {
  // Upsert the webhook_configs row
  const { error: wcError } = await supabase
    .from("webhook_configs")
    .upsert(
      {
        application_id: appId,
        enabled: config.enabled,
        token: config.token,
        source: config.source,
        last_received_at: config.last_received_at ?? null,
        last_field_signature: config.last_field_signature ?? null,
        created_at: config.created_at,
      },
      { onConflict: "application_id" }
    );

  if (wcError) {
    console.error("upsertWebhookConfig error:", wcError.message);
    throw new Error("Failed to upsert webhook config");
  }

  // Replace field mappings
  await supabase
    .from("webhook_field_mappings")
    .delete()
    .eq("webhook_config_id", appId);

  if (config.field_mapping.length > 0) {
    const fmRows = config.field_mapping.map((fm) => ({
      webhook_config_id: appId,
      source_field: fm.source_field,
      target: fm.target,
    }));
    const { error: fmError } = await supabase
      .from("webhook_field_mappings")
      .insert(fmRows);
    if (fmError) {
      console.error("upsertWebhookConfig field_mappings error:", fmError.message);
      throw new Error("Failed to insert field mappings");
    }
  }

  // Replace calculated fields
  await supabase
    .from("webhook_calculated_fields")
    .delete()
    .eq("webhook_config_id", appId);

  if (config.calculated_fields && config.calculated_fields.length > 0) {
    const cfRows = config.calculated_fields.map((cf) => ({
      id: cf.id,
      webhook_config_id: appId,
      name: cf.name,
      type: cf.type,
      expression: cf.expression,
      source_fields: cf.source_fields,
      target: cf.target,
    }));
    const { error: cfError } = await supabase
      .from("webhook_calculated_fields")
      .insert(cfRows);
    if (cfError) {
      console.error(
        "upsertWebhookConfig calculated_fields error:",
        cfError.message
      );
      throw new Error("Failed to insert calculated fields");
    }
  }
}

export async function insertPendingWebhook(
  appId: string,
  submission: PendingWebhookSubmission
): Promise<void> {
  const { error } = await supabase
    .from("pending_webhook_submissions")
    .insert({
      id: submission.id,
      application_id: appId,
      received_at: submission.received_at,
      raw_payload: submission.raw_payload,
      source: submission.source,
      status: submission.status,
      reason: submission.reason ?? null,
    });

  if (error) {
    console.error("insertPendingWebhook error:", error.message);
    throw new Error("Failed to insert pending webhook submission");
  }

  // Cap at 50 — delete oldest beyond limit
  const { data: allPending } = await supabase
    .from("pending_webhook_submissions")
    .select("id, received_at")
    .eq("application_id", appId)
    .order("received_at", { ascending: true });

  if (allPending && allPending.length > 50) {
    const toDelete = allPending.slice(0, allPending.length - 50);
    const deleteIds = toDelete.map((p) => p.id);
    await supabase
      .from("pending_webhook_submissions")
      .delete()
      .in("id", deleteIds);
  }
}

export async function deletePendingWebhooks(
  appId: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  const { error } = await supabase
    .from("pending_webhook_submissions")
    .delete()
    .eq("application_id", appId)
    .in("id", ids);

  if (error) {
    console.error("deletePendingWebhooks error:", error.message);
    throw new Error("Failed to delete pending webhooks");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function getChatMessages(
  appId: string,
  chatType: "narrative" | "audit" | "grading_audit"
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("application_id", appId)
    .eq("chat_type", chatType)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("getChatMessages error:", error.message);
    return [];
  }

  return (data ?? []).map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content as string,
  }));
}

export async function appendChatMessage(
  appId: string,
  chatType: "narrative" | "audit" | "grading_audit",
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const { error } = await supabase.from("chat_messages").insert({
    application_id: appId,
    chat_type: chatType,
    role,
    content,
  });

  if (error) {
    console.error("appendChatMessage error:", error.message);
    throw new Error("Failed to append chat message");
  }
}

export async function getDataChats(appId: string): Promise<DataChat[]> {
  const { data: chats, error } = await supabase
    .from("data_chats")
    .select("id, title, created_at")
    .eq("application_id", appId)
    .order("created_at", { ascending: true });

  if (error || !chats || chats.length === 0) return [];

  const chatIds = chats.map((c) => c.id);

  // Fetch all messages for these chats
  const { data: msgs } = await supabase
    .from("data_chat_messages")
    .select("chat_id, role, content")
    .in("chat_id", chatIds)
    .order("created_at", { ascending: true });

  const msgMap = new Map<string, ChatMessage[]>();
  for (const m of msgs ?? []) {
    const cid = m.chat_id as string;
    if (!msgMap.has(cid)) msgMap.set(cid, []);
    msgMap.get(cid)!.push({
      role: m.role as ChatMessage["role"],
      content: m.content as string,
    });
  }

  return chats.map((c) => ({
    id: c.id,
    title: c.title,
    messages: msgMap.get(c.id) ?? [],
    created_at: c.created_at ?? "",
  }));
}

export async function createDataChat(
  appId: string,
  title: string
): Promise<DataChat> {
  const id = uid();
  const now = isoNow();

  const { error } = await supabase.from("data_chats").insert({
    id,
    application_id: appId,
    title,
    created_at: now,
  });

  if (error) {
    console.error("createDataChat error:", error.message);
    throw new Error("Failed to create data chat");
  }

  return { id, title, messages: [], created_at: now };
}

export async function appendDataChatMessage(
  chatId: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  const { error } = await supabase.from("data_chat_messages").insert({
    chat_id: chatId,
    role,
    content,
  });

  if (error) {
    console.error("appendDataChatMessage error:", error.message);
    throw new Error("Failed to append data chat message");
  }
}

export async function deleteDataChat(chatId: string): Promise<void> {
  // Cascade deletes data_chat_messages
  const { error } = await supabase
    .from("data_chats")
    .delete()
    .eq("id", chatId);

  if (error) {
    console.error("deleteDataChat error:", error.message);
    throw new Error("Failed to delete data chat");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD HISTORY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function getLoadHistory(
  appId: string
): Promise<LoadHistoryEntry[]> {
  const { data, error } = await supabase
    .from("load_history")
    .select("*")
    .eq("application_id", appId)
    .order("timestamp", { ascending: true });

  if (error) {
    console.error("getLoadHistory error:", error.message);
    return [];
  }

  return (data ?? []).map((lh) => ({
    id: lh.id as string,
    timestamp: (lh.timestamp as string) ?? "",
    source_type: lh.source_type as LoadHistoryEntry["source_type"],
    description: (lh.description as string) ?? "",
    record_count: (lh.record_count as number) ?? 0,
    pre_load_snapshot: (lh.pre_load_snapshot as LoadHistoryDataSnapshot) ?? {},
    source_data: (lh.source_data as LoadHistorySourceData) ?? undefined,
  }));
}

export async function insertLoadHistory(
  appId: string,
  entry: LoadHistoryEntry
): Promise<void> {
  const { error } = await supabase.from("load_history").insert({
    id: entry.id,
    application_id: appId,
    timestamp: entry.timestamp,
    source_type: entry.source_type,
    description: entry.description,
    record_count: entry.record_count,
    pre_load_snapshot: entry.pre_load_snapshot,
    source_data: entry.source_data ?? null,
  });

  if (error) {
    console.error("insertLoadHistory error:", error.message);
    throw new Error("Failed to insert load history entry");
  }

  // Enforce max 15 entries — delete oldest if over
  const { data: allEntries } = await supabase
    .from("load_history")
    .select("id, timestamp")
    .eq("application_id", appId)
    .order("timestamp", { ascending: true });

  if (allEntries && allEntries.length > 15) {
    const toDelete = allEntries.slice(0, allEntries.length - 15);
    const deleteIds = toDelete.map((e) => e.id);
    await supabase.from("load_history").delete().in("id", deleteIds);
  }
}

export async function undoLoadHistory(
  appId: string,
  entryId: string
): Promise<LoadHistoryDataSnapshot | null> {
  // Read the entry to get its snapshot
  const { data: entry, error } = await supabase
    .from("load_history")
    .select("id, timestamp, pre_load_snapshot")
    .eq("id", entryId)
    .eq("application_id", appId)
    .single();

  if (error || !entry) return null;

  const snapshot = entry.pre_load_snapshot as LoadHistoryDataSnapshot;

  // Delete this entry and all entries that came after it
  const { data: allEntries } = await supabase
    .from("load_history")
    .select("id, timestamp")
    .eq("application_id", appId)
    .gte("timestamp", entry.timestamp)
    .order("timestamp", { ascending: true });

  if (allEntries && allEntries.length > 0) {
    const deleteIds = allEntries.map((e) => e.id);
    await supabase.from("load_history").delete().in("id", deleteIds);
  }

  return snapshot;
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function getSavedFilters(
  appId: string
): Promise<SavedCorrelationFilter[]> {
  const { data, error } = await supabase
    .from("saved_correlation_filters")
    .select("*")
    .eq("application_id", appId);

  if (error) {
    console.error("getSavedFilters error:", error.message);
    return [];
  }

  return (data ?? []).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    conditions: (f.conditions as SavedCorrelationFilter["conditions"]) ?? [],
    dateRange:
      (f.date_range as SavedCorrelationFilter["dateRange"]) ?? undefined,
  }));
}

export async function upsertSavedFilter(
  appId: string,
  filter: SavedCorrelationFilter
): Promise<void> {
  const { error } = await supabase.from("saved_correlation_filters").upsert(
    {
      id: filter.id,
      application_id: appId,
      name: filter.name,
      conditions: filter.conditions,
      date_range: filter.dateRange ?? null,
    },
    { onConflict: "id" }
  );

  if (error) {
    console.error("upsertSavedFilter error:", error.message);
    throw new Error("Failed to upsert saved filter");
  }
}

export async function deleteSavedFilter(filterId: string): Promise<void> {
  const { error } = await supabase
    .from("saved_correlation_filters")
    .delete()
    .eq("id", filterId);

  if (error) {
    console.error("deleteSavedFilter error:", error.message);
    throw new Error("Failed to delete saved filter");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

export async function getUserByEmail(
  email: string
): Promise<{
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: string;
} | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, password_hash, name, created_at")
    .eq("email", email)
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: data.id,
    email: data.email,
    password_hash: data.password_hash,
    name: data.name ?? null,
    created_at: data.created_at ?? "",
  };
}

export async function createUser(
  email: string,
  passwordHash: string,
  name?: string
): Promise<{ id: string; email: string; name: string | null }> {
  const { data, error } = await supabase
    .from("users")
    .insert({
      email,
      password_hash: passwordHash,
      name: name ?? null,
    })
    .select("id, email, name")
    .single();

  if (error) {
    console.error("createUser error:", error.message);
    throw new Error("Failed to create user");
  }

  return {
    id: data.id,
    email: data.email,
    name: data.name ?? null,
  };
}

export async function updateUserPassword(
  userId: string,
  newHash: string
): Promise<void> {
  const { error } = await supabase
    .from("users")
    .update({ password_hash: newHash })
    .eq("id", userId);

  if (error) {
    console.error("updateUserPassword error:", error.message);
    throw new Error("Failed to update user password");
  }
}

export async function listUsers(): Promise<
  { id: string; email: string; name: string | null; created_at: string }[]
> {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, name, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("listUsers error:", error.message);
    return [];
  }

  return (data ?? []).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    created_at: u.created_at ?? "",
  }));
}

export async function deleteUser(userId: string): Promise<boolean> {
  const { error, count } = await supabase
    .from("users")
    .delete({ count: "exact" })
    .eq("id", userId);

  if (error) {
    console.error("deleteUser error:", error.message);
    return false;
  }
  return (count ?? 0) > 0;
}
