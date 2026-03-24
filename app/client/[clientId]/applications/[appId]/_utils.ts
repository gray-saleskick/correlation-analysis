import type {
  AppSubmission,
  AppSubmissionAnswer,
  BookingRecord,
  CallResultRecord,
  FinancialRecord,
  FilterCondition,
  FilterFieldType,
  LoadSourceType,
  TypeformQuestionType,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export type TabId = "questions" | "submissions" | "financial" | "call_results" | "correlation" | "webhooks";

export const BASE_TABS: { id: TabId; label: string }[] = [
  { id: "questions", label: "Questions" },
  { id: "submissions", label: "Submissions" },
  { id: "financial", label: "Financial Data" },
  { id: "call_results", label: "Call Results" },
  { id: "correlation", label: "Correlation Analysis" },
];

export const ALL_QUESTION_TYPES: { value: TypeformQuestionType; label: string }[] = [
  { value: "short_text", label: "Short Text" },
  { value: "long_text", label: "Long Text" },
  { value: "multiple_choice", label: "Multiple Choice" },
  { value: "dropdown", label: "Dropdown" },
  { value: "yes_no", label: "Yes / No" },
  { value: "email", label: "Email" },
  { value: "phone_number", label: "Phone Number" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "full_name", label: "Full Name" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "rating", label: "Rating" },
  { value: "opinion_scale", label: "Opinion Scale" },
  { value: "ranking", label: "Ranking" },
  { value: "file_upload", label: "File Upload" },
  { value: "statement", label: "Statement" },
  { value: "picture_choice", label: "Picture Choice" },
  { value: "website", label: "Website" },
];

export const CORRELATABLE_TYPES: TypeformQuestionType[] = [
  "multiple_choice", "dropdown", "yes_no", "picture_choice",
  "rating", "opinion_scale",
];

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/** Merge answers: keep existing answer values, fill in missing ones from new answers */
export function mergeAnswers(existing: AppSubmissionAnswer[], incoming: AppSubmissionAnswer[]): AppSubmissionAnswer[] {
  const merged = [...existing];
  for (const newAns of incoming) {
    const idx = merged.findIndex(
      (a) => a.question_ref === newAns.question_ref || a.question_title.toLowerCase() === newAns.question_title.toLowerCase()
    );
    if (idx >= 0) {
      // Only fill if existing answer is missing/empty
      if (!merged[idx].value && newAns.value) {
        merged[idx] = { ...merged[idx], value: newAns.value };
      }
    } else {
      // New answer for a question not in existing
      merged.push(newAns);
    }
  }
  return merged;
}

/** Evaluate a single filter condition against a submission */
export function evaluateCondition(
  cond: FilterCondition,
  sub: AppSubmission,
  financialByEmail: Map<string, FinancialRecord>,
  bookingByEmail: Map<string, CallResultRecord | BookingRecord>,
): boolean {
  const email = sub.respondent_email?.toLowerCase();
  let rawValue: string | number | boolean | undefined | null;

  switch (cond.field) {
    case "question_answer": {
      const ans = sub.answers.find(
        (a) => a.question_title.toLowerCase() === cond.questionTitle?.toLowerCase()
      );
      rawValue = ans?.value;
      break;
    }
    case "final_grade": rawValue = sub.grade?.final_grade; break;
    case "answer_grade": rawValue = sub.grade?.answer_grade; break;
    case "credit_score": { const f = email ? financialByEmail.get(email) : undefined; rawValue = f?.credit_score; break; }
    case "estimated_income": { const f = email ? financialByEmail.get(email) : undefined; rawValue = f?.estimated_income; break; }
    case "credit_access": { const f = email ? financialByEmail.get(email) : undefined; rawValue = f?.credit_access; break; }
    case "access_to_funding": { const f = email ? financialByEmail.get(email) : undefined; rawValue = f?.access_to_funding; break; }
    case "financial_grade": { const f = email ? financialByEmail.get(email) : undefined; rawValue = f?.financial_grade; break; }
    case "booked": { rawValue = !!(email && bookingByEmail.has(email)); break; }
    case "showed": { const b = email ? bookingByEmail.get(email) : undefined; rawValue = b?.showed ?? false; break; }
    case "closed": { const b = email ? bookingByEmail.get(email) : undefined; rawValue = b?.closed ?? false; break; }
  }

  switch (cond.operator) {
    case "equals": return String(rawValue ?? "").toLowerCase() === String(cond.value).toLowerCase();
    case "not_equals": return String(rawValue ?? "").toLowerCase() !== String(cond.value).toLowerCase();
    case "contains": return String(rawValue ?? "").toLowerCase().includes(String(cond.value).toLowerCase());
    case "not_contains": return !String(rawValue ?? "").toLowerCase().includes(String(cond.value).toLowerCase());
    case "gte": return Number(rawValue) >= Number(cond.value);
    case "lte": return Number(rawValue) <= Number(cond.value);
    case "between": { const [lo, hi] = cond.value as [number, number]; const n = Number(rawValue); return n >= lo && n <= hi; }
    case "is": return Boolean(rawValue) === (cond.value === true || cond.value === "true" || cond.value === "Yes");
    default: return true;
  }
}

export const FILTER_FIELD_LABELS: Record<FilterFieldType, string> = {
  question_answer: "Question Answer",
  credit_score: "Credit Score",
  estimated_income: "Income",
  credit_access: "Credit Access",
  access_to_funding: "Funding",
  financial_grade: "Financial Grade",
  final_grade: "Final Grade",
  answer_grade: "Application Grade",
  booked: "Booked",
  showed: "Showed",
  closed: "Closed",
};

// ─────────────────────────────────────────────────────────────────────────────
// Load History Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function getSourceBadge(sourceType: LoadSourceType): { label: string; color: string } {
  switch (sourceType) {
    case "csv-submissions": return { label: "CSV", color: "bg-emerald-500/20 text-emerald-400" };
    case "csv-financial": return { label: "Financial", color: "bg-blue-500/20 text-blue-400" };
    case "csv-call-results": return { label: "Calls", color: "bg-purple-500/20 text-purple-400" };
    case "typeform-sync": return { label: "Typeform", color: "bg-cyan-500/20 text-cyan-400" };
    case "webhook-batch": return { label: "Webhook", color: "bg-amber-500/20 text-amber-400" };
    case "webhook-auto": return { label: "Auto", color: "bg-orange-500/20 text-orange-400" };
    default: return { label: "Unknown", color: "bg-slate-500/20 text-slate-400" };
  }
}
