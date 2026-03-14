/**
 * Webhook processing utilities.
 * Handles payload flattening, drift detection, field mapping,
 * Typeform webhook parsing, and data merging.
 */

import type {
  Application,
  AppSubmission,
  AppSubmissionAnswer,
  CallResultRecord,
  FinancialRecord,
  WebhookFieldMapping,
  CalculatedField,
} from "./types";

// ── Payload flattening ──────────────────────────────────────────────────────

/**
 * Flatten a nested object into dot-notation keys.
 * { a: { b: 1 } } → { "a.b": "1" }
 */
export function flattenPayload(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      result[fullKey] = "";
    } else if (Array.isArray(value)) {
      // For arrays, join simple values or stringify complex ones
      if (value.every((v) => typeof v !== "object" || v === null)) {
        result[fullKey] = value.map(String).join(", ");
      } else {
        result[fullKey] = JSON.stringify(value);
      }
    } else if (typeof value === "object") {
      Object.assign(result, flattenPayload(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }

  return result;
}

// ── Drift detection ─────────────────────────────────────────────────────────

/**
 * Compute a signature from field names for drift detection.
 * Sorts alphabetically and joins with pipe.
 */
export function computeFieldSignature(fields: string[]): string {
  return [...fields].sort().join("|");
}

/**
 * Check if fields have drifted from a stored signature.
 * Returns true if drifted (or if no previous signature exists).
 */
export function hasFieldDrift(
  currentFields: string[],
  storedSignature: string | undefined
): boolean {
  if (!storedSignature) return true; // First reception
  return computeFieldSignature(currentFields) !== storedSignature;
}

// ── Typeform payload parsing ────────────────────────────────────────────────

interface TypeformAnswer {
  field: { id: string; ref: string; type: string };
  type: string;
  text?: string;
  email?: string;
  phone_number?: string;
  number?: number;
  boolean?: boolean;
  date?: string;
  url?: string;
  file_url?: string;
  choice?: { label: string };
  choices?: { labels: string[] };
}

interface TypeformField {
  id: string;
  ref: string;
  title: string;
  type: string;
}

interface TypeformWebhookPayload {
  event_type: string;
  form_response: {
    form_id: string;
    submitted_at: string;
    definition: {
      fields: TypeformField[];
    };
    answers: TypeformAnswer[];
    hidden?: Record<string, string>;
  };
}

/**
 * Parse a Typeform webhook payload into flat key-value pairs.
 * Uses question titles as keys.
 */
export function parseTypeformPayload(
  body: unknown
): { fields: Record<string, string>; meta: { submitted_at: string; form_id: string } } | null {
  try {
    const payload = body as TypeformWebhookPayload;
    if (payload.event_type !== "form_response" || !payload.form_response) {
      return null;
    }

    const { form_response } = payload;
    const fieldMap = new Map<string, string>();

    // Build ref→title lookup
    const refToTitle = new Map<string, string>();
    for (const field of form_response.definition?.fields ?? []) {
      refToTitle.set(field.ref || field.id, field.title);
    }

    for (const answer of form_response.answers ?? []) {
      const title =
        refToTitle.get(answer.field.ref) ||
        refToTitle.get(answer.field.id) ||
        answer.field.ref ||
        answer.field.id;

      let value = "";
      switch (answer.type) {
        case "text":
          value = answer.text ?? "";
          break;
        case "email":
          value = answer.email ?? "";
          break;
        case "phone_number":
          value = answer.phone_number ?? "";
          break;
        case "number":
          value = answer.number !== undefined ? String(answer.number) : "";
          break;
        case "boolean":
          value = answer.boolean !== undefined ? String(answer.boolean) : "";
          break;
        case "date":
          value = answer.date ?? "";
          break;
        case "url":
          value = answer.url ?? "";
          break;
        case "file_url":
          value = answer.file_url ?? "";
          break;
        case "choice":
          value = answer.choice?.label ?? "";
          break;
        case "choices":
          value = answer.choices?.labels?.join(", ") ?? "";
          break;
        default:
          value = answer.text ?? "";
      }

      fieldMap.set(title, value);
    }

    // Add hidden fields
    if (form_response.hidden) {
      for (const [key, val] of Object.entries(form_response.hidden)) {
        fieldMap.set(`hidden:${key}`, String(val));
      }
    }

    return {
      fields: Object.fromEntries(fieldMap),
      meta: {
        submitted_at: form_response.submitted_at,
        form_id: form_response.form_id,
      },
    };
  } catch {
    return null;
  }
}

// ── Field mapping application ───────────────────────────────────────────────

export interface MappedWebhookData {
  email?: string;
  name?: string;
  submitted_at?: string;
  booking_date?: string;
  close_date?: string;
  answers: { question_title: string; value: string }[];
  grade: {
    final_grade?: number;
    answer_grade?: number;
    financial_grade?: number;
    was_disqualified?: boolean;
    was_spam?: boolean;
    details?: string;
  };
  financial: {
    credit_score?: number;
    estimated_income?: number;
    available_credit?: number;
    available_funding?: number;
    financial_grade?: number;
  };
  call_result: {
    booked?: boolean;
    showed?: boolean;
    closed?: boolean;
    booking_date?: string;
    close_date?: string;
  };
}

function parseBool(val: string): boolean {
  const v = val.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "y" || v === "1";
}

function parseNum(val: string): number | undefined {
  const cleaned = val.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

/**
 * Apply field mapping to a flat payload, returning structured data.
 */
export function applyFieldMapping(
  payload: Record<string, string>,
  mapping: WebhookFieldMapping[],
  calculatedFields?: CalculatedField[]
): MappedWebhookData {
  const result: MappedWebhookData = {
    answers: [],
    grade: {},
    financial: {},
    call_result: {},
  };

  // Collect name parts separately to handle any ordering
  let firstName = "";
  let lastName = "";
  let fullName = "";

  for (const { source_field, target } of mapping) {
    const value = payload[source_field];
    if (value === undefined || value === "") continue;

    if (target === "skip" || target === "") continue;

    // Special fields
    if (target === "email") {
      result.email = value.trim().toLowerCase();
    } else if (target === "first_name") {
      firstName = value.trim();
    } else if (target === "last_name") {
      lastName = value.trim();
    } else if (target === "full_name") {
      fullName = value.trim();
    } else if (target === "submitted_at") {
      result.submitted_at = value;
    } else if (target === "booking_date") {
      result.booking_date = value;
      result.call_result.booking_date = value;
    } else if (target === "close_date") {
      result.close_date = value;
      result.call_result.close_date = value;
    }
    // Grade fields
    else if (target === "grade.final") {
      result.grade.final_grade = parseNum(value);
    } else if (target === "grade.answer") {
      result.grade.answer_grade = parseNum(value);
    } else if (target === "grade.financial") {
      result.grade.financial_grade = parseNum(value);
    } else if (target === "grade.disqualified") {
      result.grade.was_disqualified = parseBool(value);
    } else if (target === "grade.spam") {
      result.grade.was_spam = parseBool(value);
    } else if (target === "grade.details") {
      result.grade.details = value;
    }
    // Financial fields
    else if (target === "financial.credit_score") {
      result.financial.credit_score = parseNum(value);
    } else if (target === "financial.estimated_income") {
      result.financial.estimated_income = parseNum(value);
    } else if (target === "financial.available_credit") {
      result.financial.available_credit = parseNum(value);
    } else if (target === "financial.available_funding") {
      result.financial.available_funding = parseNum(value);
    } else if (target === "financial.grade") {
      result.financial.financial_grade = parseNum(value);
    }
    // Booking/call result fields
    else if (target === "booking.booked") {
      result.call_result.booked = parseBool(value);
    } else if (target === "booking.showed") {
      result.call_result.showed = parseBool(value);
    } else if (target === "booking.closed") {
      result.call_result.closed = parseBool(value);
    }
    // Question answers (target format: "answer:Question Title")
    else if (target.startsWith("answer:")) {
      const questionTitle = target.slice(7);
      result.answers.push({ question_title: questionTitle, value });
    }
  }

  // Compose name from parts (full_name takes priority, then first + last)
  result.name = fullName || [firstName, lastName].filter(Boolean).join(" ") || undefined;

  // Apply cascade: closed → showed → booked
  if (result.call_result.closed) {
    result.call_result.showed = true;
    result.call_result.booked = true;
  } else if (result.call_result.showed) {
    result.call_result.booked = true;
  }

  // Evaluate calculated fields
  if (calculatedFields) {
    for (const field of calculatedFields) {
      const val = evaluateCalculatedField(field, payload);
      if (val !== null) {
        // Store the result based on target
        if (field.target.startsWith("answer:")) {
          result.answers.push({
            question_title: field.target.slice(7),
            value: String(val),
          });
        }
        // Could also map to financial/grade fields if needed
      }
    }
  }

  return result;
}

// ── Calculated fields ───────────────────────────────────────────────────────

/**
 * Evaluate a calculated field against a payload.
 */
export function evaluateCalculatedField(
  field: CalculatedField,
  payload: Record<string, string>
): number | null {
  try {
    if (field.type === "date_diff_days") {
      // Expression format: "field1 - field2"
      const parts = field.expression.split("-").map((s) => s.trim());
      if (parts.length !== 2) return null;

      const date1 = new Date(payload[parts[0]] || "");
      const date2 = new Date(payload[parts[1]] || "");

      if (isNaN(date1.getTime()) || isNaN(date2.getTime())) return null;

      const diffMs = date1.getTime() - date2.getTime();
      return Math.round(diffMs / (1000 * 60 * 60 * 24));
    }

    if (field.type === "math") {
      // Simple math: replace field references with values, then evaluate
      let expr = field.expression;
      for (const srcField of field.source_fields) {
        const val = parseFloat(payload[srcField] || "0");
        if (isNaN(val)) return null;
        // Replace field name with value (escape special chars in field name)
        const escaped = srcField.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expr = expr.replace(new RegExp(escaped, "g"), String(val));
      }

      // Evaluate simple arithmetic (only +, -, *, / with numbers)
      const sanitized = expr.replace(/[^0-9+\-*/().  ]/g, "");
      if (!sanitized || sanitized !== expr.replace(/\s/g, "")) return null;

      // Use Function constructor for safe math eval
      const result = new Function(`return (${sanitized})`)() as number;
      return isNaN(result) || !isFinite(result) ? null : result;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Data merging ────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Merge webhook-mapped data into an application's existing data.
 * Matches by email — updates existing records or creates new ones.
 * Returns the updated application (does NOT save it).
 */
export function mergeWebhookData(
  app: Application,
  data: MappedWebhookData
): Application {
  const updated = { ...app };

  if (!data.email) {
    // Without email, we can't merge — just create a new submission
    const newSub: AppSubmission = {
      id: uid(),
      submitted_at: data.submitted_at || new Date().toISOString(),
      booking_date: data.booking_date,
      respondent_name: data.name,
      source: "api",
      answers: data.answers.map((a) => ({
        question_ref: a.question_title,
        question_title: a.question_title,
        value: a.value,
      })),
    };

    if (Object.values(data.grade).some((v) => v !== undefined)) {
      newSub.grade = {
        final_grade: data.grade.final_grade,
        answer_grade: data.grade.answer_grade,
        financial_grade: data.grade.financial_grade,
        was_disqualified: data.grade.was_disqualified,
        was_spam: data.grade.was_spam,
        details: data.grade.details,
      };
    }

    if (Object.values(data.financial).some((v) => v !== undefined)) {
      newSub.financial = {
        credit_score: data.financial.credit_score,
        estimated_income: data.financial.estimated_income,
        available_credit: data.financial.available_credit,
        available_funding: data.financial.available_funding,
      };
    }

    updated.submissions = [...(updated.submissions ?? []), newSub];
    return updated;
  }

  const email = data.email;

  // ── Merge submission ──────────────────────────────────────────────────
  const submissions = [...(updated.submissions ?? [])];
  const existingSubIdx = submissions.findIndex(
    (s) => s.respondent_email?.toLowerCase() === email
  );

  const answers: AppSubmissionAnswer[] = data.answers.map((a) => ({
    question_ref: a.question_title,
    question_title: a.question_title,
    value: a.value,
  }));

  if (existingSubIdx >= 0) {
    const existing = { ...submissions[existingSubIdx] };
    // Merge answers: update existing, add new
    const mergedAnswers = [...existing.answers];
    for (const newAns of answers) {
      const existingAnsIdx = mergedAnswers.findIndex(
        (a) => a.question_title === newAns.question_title
      );
      if (existingAnsIdx >= 0) {
        mergedAnswers[existingAnsIdx] = newAns;
      } else {
        mergedAnswers.push(newAns);
      }
    }
    existing.answers = mergedAnswers;

    if (data.submitted_at) existing.submitted_at = data.submitted_at;
    if (data.booking_date) existing.booking_date = data.booking_date;
    if (data.name) existing.respondent_name = data.name;

    if (Object.values(data.grade).some((v) => v !== undefined)) {
      existing.grade = { ...existing.grade, ...data.grade };
    }
    if (Object.values(data.financial).some((v) => v !== undefined)) {
      existing.financial = { ...existing.financial, ...data.financial };
    }

    submissions[existingSubIdx] = existing;
  } else {
    const newSub: AppSubmission = {
      id: uid(),
      submitted_at: data.submitted_at || new Date().toISOString(),
      booking_date: data.booking_date,
      respondent_email: email,
      respondent_name: data.name,
      source: "api",
      answers,
    };

    if (Object.values(data.grade).some((v) => v !== undefined)) {
      newSub.grade = data.grade;
    }
    if (Object.values(data.financial).some((v) => v !== undefined)) {
      newSub.financial = data.financial;
    }

    submissions.push(newSub);
  }
  updated.submissions = submissions;

  // ── Merge call results ────────────────────────────────────────────────
  const hasCallData =
    data.call_result.booked !== undefined ||
    data.call_result.showed !== undefined ||
    data.call_result.closed !== undefined ||
    data.call_result.booking_date !== undefined ||
    data.call_result.close_date !== undefined;

  if (hasCallData) {
    const callResults = [...(updated.call_results ?? [])];
    const existingCrIdx = callResults.findIndex(
      (cr) => cr.email.toLowerCase() === email
    );

    if (existingCrIdx >= 0) {
      const existing = { ...callResults[existingCrIdx] };
      if (data.call_result.booked !== undefined) existing.booked = data.call_result.booked;
      if (data.call_result.showed !== undefined) existing.showed = data.call_result.showed;
      if (data.call_result.closed !== undefined) existing.closed = data.call_result.closed;
      if (data.call_result.booking_date) existing.booking_date = data.call_result.booking_date;
      if (data.call_result.close_date) existing.close_date = data.call_result.close_date;
      callResults[existingCrIdx] = existing;
    } else {
      callResults.push({
        email,
        booked: data.call_result.booked ?? false,
        showed: data.call_result.showed ?? false,
        closed: data.call_result.closed ?? false,
        booking_date: data.call_result.booking_date,
        close_date: data.call_result.close_date,
      });
    }
    updated.call_results = callResults;
  }

  // ── Merge financial records ───────────────────────────────────────────
  const hasFinancial = Object.values(data.financial).some((v) => v !== undefined);

  if (hasFinancial) {
    const financials = [...(updated.financial_records ?? [])];
    const existingFinIdx = financials.findIndex(
      (fr) => fr.email.toLowerCase() === email
    );

    if (existingFinIdx >= 0) {
      const existing = { ...financials[existingFinIdx] };
      if (data.financial.credit_score !== undefined) existing.credit_score = data.financial.credit_score;
      if (data.financial.estimated_income !== undefined) existing.estimated_income = data.financial.estimated_income;
      if (data.financial.available_credit !== undefined) existing.credit_access = data.financial.available_credit;
      if (data.financial.available_funding !== undefined) existing.access_to_funding = data.financial.available_funding;
      if (data.financial.financial_grade !== undefined) existing.financial_grade = data.financial.financial_grade;
      financials[existingFinIdx] = existing;
    } else {
      financials.push({
        email,
        credit_score: data.financial.credit_score,
        estimated_income: data.financial.estimated_income,
        credit_access: data.financial.available_credit,
        access_to_funding: data.financial.available_funding,
        financial_grade: data.financial.financial_grade,
      });
    }
    updated.financial_records = financials;
  }

  return updated;
}
