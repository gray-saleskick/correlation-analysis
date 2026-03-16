import { NextRequest, NextResponse } from "next/server";
import { readProfile, writeProfile } from "@/lib/store";
import type { Application, ApplicationQuestion, AppSubmission, AppSubmissionAnswer } from "@/lib/types";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";

export const dynamic = "force-dynamic";

// Maps Typeform field types → our TypeformQuestionType
const TYPE_MAP: Record<string, string> = {
  short_text: "short_text",
  long_text: "long_text",
  multiple_choice: "multiple_choice",
  dropdown: "dropdown",
  yes_no: "yes_no",
  email: "email",
  phone_number: "phone_number",
  number: "number",
  date: "date",
  rating: "rating",
  opinion_scale: "opinion_scale",
  ranking: "ranking",
  file_upload: "file_upload",
  statement: "statement",
  picture_choice: "picture_choice",
  website: "website",
};

type TypeformAnswer = {
  field: { id: string; type: string };
  type: string;
  text?: string;
  email?: string;
  url?: string;
  file_url?: string;
  date?: string;
  number?: number;
  boolean?: boolean;
  choice?: { label: string };
  choices?: { labels?: string[] };
  phone_number?: string;
};

function mapAnswerValue(ans: TypeformAnswer): string | null {
  switch (ans.type) {
    case "text": return ans.text ?? null;
    case "email": return ans.email ?? null;
    case "url": return ans.url ?? null;
    case "file_url": return ans.file_url ?? null;
    case "date": return ans.date ?? null;
    case "number": return ans.number != null ? String(ans.number) : null;
    case "boolean": return ans.boolean != null ? (ans.boolean ? "true" : "false") : null;
    case "choice": return ans.choice?.label ?? null;
    case "choices": return ans.choices?.labels?.join(", ") ?? null;
    case "phone_number": return ans.phone_number ?? null;
    default: return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;

  let body: { pat?: string; form_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { pat, form_id } = body;
  if (!pat || !form_id) {
    return NextResponse.json({ success: false, error: "pat and form_id are required" }, { status: 400 });
  }

  // ── Fetch form definition ────────────────────────────────────────────────────
  let formData: {
    id: string;
    title?: string;
    fields?: Array<{
      id: string;
      ref?: string;
      title: string;
      type: string;
      validations?: { required?: boolean };
      properties?: {
        choices?: Array<{ id: string; label: string }>;
        allow_multiple_selection?: boolean;
        randomize?: boolean;
      };
    }>;
  };

  try {
    const formRes = await fetch(`https://api.typeform.com/forms/${form_id}`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!formRes.ok) {
      const errText = await formRes.text().catch(() => "");
      return NextResponse.json(
        { success: false, error: `Typeform API error ${formRes.status}: ${errText.slice(0, 300)}` },
        { status: 400 }
      );
    }
    formData = await formRes.json();
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Failed to reach Typeform API: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  // ── Map questions ────────────────────────────────────────────────────────────
  const questions: ApplicationQuestion[] = (formData.fields ?? []).map((field, i) => ({
    id: field.id,
    ref: field.ref,
    title: field.title,
    type: (TYPE_MAP[field.type] ?? "short_text") as ApplicationQuestion["type"],
    required: field.validations?.required ?? false,
    choices: field.properties?.choices?.map((c) => ({ id: c.id, label: c.label })),
    allow_multiple_selection: field.properties?.allow_multiple_selection,
    order: i,
  }));

  // ── Fetch responses ──────────────────────────────────────────────────────────
  let responseItems: Array<{
    response_id: string;
    submitted_at: string;
    answers?: TypeformAnswer[];
    hidden?: Record<string, string>;
  }> = [];

  try {
    const respRes = await fetch(
      `https://api.typeform.com/forms/${form_id}/responses?page_size=1000&completed=true`,
      { headers: { Authorization: `Bearer ${pat}` } }
    );
    if (respRes.ok) {
      const respData = await respRes.json() as { items?: typeof responseItems };
      responseItems = respData.items ?? [];
    }
  } catch {
    // Responses fetch failed — still proceed with just questions
  }

  // Build field id → question lookup
  const fieldMap = new Map<string, ApplicationQuestion>(questions.map((q) => [q.id, q]));

  // ── Map submissions ──────────────────────────────────────────────────────────
  const submissions: AppSubmission[] = responseItems.map((item) => {
    const answers: AppSubmissionAnswer[] = [];
    let email: string | undefined = item.hidden?.email?.toLowerCase();

    for (const ans of item.answers ?? []) {
      const field = fieldMap.get(ans.field.id);
      if (!field) continue;
      const value = mapAnswerValue(ans);
      if (field.type === "email" && value) {
        email = value.toLowerCase();
      }
      answers.push({
        question_ref: field.id,
        question_title: field.title,
        value,
      });
    }

    return {
      id: item.response_id,
      submitted_at: item.submitted_at,
      respondent_email: email,
      source: "api" as const,
      answers,
    };
  });

  // ── Read + update profile ────────────────────────────────────────────────────
  const profile = await readProfile(clientId);
  if (!profile) {
    return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
  }

  const idx = profile.applications.findIndex((a) => a.id === appId);
  if (idx < 0) {
    return NextResponse.json({ success: false, error: "Application not found" }, { status: 404 });
  }

  const existing = profile.applications[idx];

  // Capture snapshot before merge for load history
  const preSnapshot = captureDataSnapshot(existing);

  // Merge submissions: don't duplicate by response_id
  const existingIds = new Set((existing.submissions ?? []).map((s) => s.id));
  const newSubs = submissions.filter((s) => !existingIds.has(s.id));

  let updated: Application = {
    ...existing,
    typeform_pat: pat,
    typeform_form_id: form_id,
    questions,
    submissions: [...(existing.submissions ?? []), ...newSubs],
  };

  // Add load history entry
  if (newSubs.length > 0) {
    updated = addLoadHistoryEntry(
      updated,
      "typeform-sync",
      `Synced ${newSubs.length} submissions from Typeform`,
      newSubs.length,
      preSnapshot
    );
  }

  profile.applications[idx] = updated;
  await writeProfile(clientId, profile);

  return NextResponse.json({
    success: true,
    application: updated,
    questions_count: questions.length,
    submissions_count: newSubs.length,
  });
}
