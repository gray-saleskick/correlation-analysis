"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import type {
  Application,
  ApplicationQuestion,
  AppSubmission,
  AppSubmissionAnswer,
  BookingRecord,
  FinancialRecord,
  CallResultRecord,
  ColumnMappingEntry,
  TypeformQuestionType,
  FilterCondition,
  FilterFieldType,
  FilterOperator,
  SavedCorrelationFilter,
  ChatMessage,
  DataChat,
} from "@/lib/types";
import Link from "next/link";
import {
  parseFileToRows,
  buildInitialMapping,
  parseBoolValue,
  parseDollarAmount,
  extractUniqueValues,
  autoDetectTarget,
} from "@/lib/csvUtils";
import { hasWebhookAccess } from "@/lib/featureFlags";
import {
  flattenPayload,
  parseTypeformPayload,
  applyFieldMapping,
  mergeWebhookData,
  computeFieldSignature,
} from "@/lib/webhookUtils";
import type {
  WebhookConfig,
  WebhookFieldMapping,
  PendingWebhookSubmission,
  CalculatedField,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

type TabId = "questions" | "submissions" | "financial" | "call_results" | "correlation" | "webhooks";

const BASE_TABS: { id: TabId; label: string }[] = [
  { id: "questions", label: "Questions" },
  { id: "submissions", label: "Submissions" },
  { id: "financial", label: "Financial Data" },
  { id: "call_results", label: "Call Results" },
  { id: "correlation", label: "Correlation Analysis" },
];

const ALL_QUESTION_TYPES: { value: TypeformQuestionType; label: string }[] = [
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

const CORRELATABLE_TYPES: TypeformQuestionType[] = [
  "multiple_choice", "dropdown", "yes_no", "picture_choice",
  "rating", "opinion_scale",
];

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/** Merge answers: keep existing answer values, fill in missing ones from new answers */
function mergeAnswers(existing: AppSubmissionAnswer[], incoming: AppSubmissionAnswer[]): AppSubmissionAnswer[] {
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
function evaluateCondition(
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

const FILTER_FIELD_LABELS: Record<FilterFieldType, string> = {
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
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ApplicationDetail({
  clientId,
  clientName,
  companyDescription,
  initialApp,
  userEmail,
}: {
  clientId: string;
  clientName: string;
  companyDescription: string;
  initialApp: Application;
  userEmail?: string;
}) {
  const [app, setApp] = useState(initialApp);
  const [activeTab, setActiveTab] = useState<TabId>("questions");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<Application[]>([]);
  const appRef = useRef(app);
  useEffect(() => { appRef.current = app; }, [app]);

  // Custom confirmation modal
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  function showConfirm(message: string, onConfirm: () => void) {
    setConfirmModal({ message, onConfirm });
  }

  const saveApp = useCallback(async (updated: Application) => {
    setUndoStack((prev) => [...prev.slice(-49), appRef.current]);
    setApp(updated);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${updated.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application: updated }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(`Save failed (${res.status}): ${(data as { error?: string }).error ?? res.statusText}`);
      }
    } catch (err) {
      setSaveError(`Save failed: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setSaving(false);
    }
  }, [clientId]);

  const handleUndo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setApp(previous);
    setSaving(true);
    try {
      await fetch(`/api/clients/${clientId}/applications/${previous.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ application: previous }),
      });
    } finally {
      setSaving(false);
    }
  }, [undoStack, clientId]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-4 bg-white/[0.02] rounded-lg px-3 py-2">
        <Link href="/" className="text-xs text-slate-300 hover:text-indigo-400 transition-colors">Clients</Link>
        <span className="text-slate-300">/</span>
        <Link href={`/client/${clientId}`} className="text-xs text-slate-300 hover:text-indigo-400 transition-colors">{clientName}</Link>
        <span className="text-slate-300">/</span>
        <span className="text-xs text-slate-300 font-medium">{app.title}</span>
        {saving && <span className="text-[10px] text-indigo-400 ml-2">Saving…</span>}
      </div>

      {saveError && (
        <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
          <span className="text-xs text-red-400">{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-xs text-red-300 hover:text-red-200 ml-2">Dismiss</button>
        </div>
      )}

      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-bold text-slate-200">{app.title}</h1>
        <button
          onClick={handleUndo}
          disabled={undoStack.length === 0 || saving}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            undoStack.length > 0 && !saving
              ? "border-indigo-500/30 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20"
              : "border-white/[0.08] text-slate-400 hover:bg-white/[0.04] hover:text-slate-300"
          }`}
          title={`Undo (${undoStack.length} steps available)`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
          </svg>
          Undo
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/[0.08] mb-6 bg-white/[0.02] rounded-t-lg px-1">
        {(() => {
          const tabs = hasWebhookAccess(userEmail)
            ? [...BASE_TABS.slice(0, -1), { id: "webhooks" as TabId, label: "Webhooks" }, BASE_TABS[BASE_TABS.length - 1]]
            : BASE_TABS;
          return tabs.map((tab) => {
            const pendingCount = app.pending_webhook_submissions?.filter(p => p.status === "pending").length ?? 0;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? "border-indigo-400 text-indigo-400"
                    : "border-transparent text-slate-300 hover:text-slate-300"
                }`}
              >
                {tab.label}
                {tab.id === "submissions" && (app.submissions?.length ?? 0) > 0 && (
                  <span className="ml-1.5 text-[10px] bg-white/[0.08] text-slate-300 rounded-full px-1.5 py-0.5">
                    {app.submissions!.length}
                  </span>
                )}
                {tab.id === "financial" && (app.financial_records?.length ?? 0) > 0 && (
                  <span className="ml-1.5 text-[10px] bg-white/[0.08] text-slate-300 rounded-full px-1.5 py-0.5">
                    {app.financial_records!.length}
                  </span>
                )}
                {tab.id === "call_results" && (app.call_results?.length ?? 0) > 0 && (
                  <span className="ml-1.5 text-[10px] bg-white/[0.08] text-slate-300 rounded-full px-1.5 py-0.5">
                    {app.call_results!.length}
                  </span>
                )}
                {tab.id === "webhooks" && pendingCount > 0 && (
                  <span className="ml-1.5 text-[10px] bg-amber-500/20 text-amber-400 rounded-full px-1.5 py-0.5">
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          });
        })()}
      </div>

      {activeTab === "questions" && <QuestionsTab app={app} onSave={saveApp} clientId={clientId} companyDescription={companyDescription} />}
      {activeTab === "submissions" && <SubmissionsUploadTab app={app} onSave={saveApp} uploadType="submissions" />}
      {activeTab === "financial" && <FinancialUploadTab app={app} onSave={saveApp} />}
      {activeTab === "call_results" && <CallResultsUploadTab app={app} onSave={saveApp} />}
      {activeTab === "webhooks" && <WebhooksTab app={app} onSave={saveApp} clientId={clientId} />}
      {activeTab === "correlation" && <CorrelationTab app={app} onSave={saveApp} clientName={clientName} clientId={clientId} />}

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setConfirmModal(null)} />
          <div className="relative bg-slate-900 border border-white/[0.1] rounded-2xl w-full max-w-sm mx-4 p-6 shadow-2xl">
            <p className="text-sm text-slate-200 mb-4">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 px-4 py-2 text-xs font-semibold border border-white/[0.08] rounded-lg text-slate-300 hover:bg-white/[0.04] transition-colors"
              >Cancel</button>
              <button
                onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
                className="flex-1 px-4 py-2 text-xs font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Questions Tab
// ─────────────────────────────────────────────────────────────────────────────

const GRADING_PROMPT_TEMPLATES = [
  { value: "biggest-challenge", label: "Biggest Challenge" },
  { value: "most-help", label: "Most Help / Needs" },
  { value: "what-is-your-goal", label: "Goal / Motivation" },
  { value: "why-now", label: "Why Now / Urgency" },
  { value: "occupation", label: "Occupation / Income" },
  { value: "multiple-choice", label: "Multiple Choice" },
];

const CHOICE_QUESTION_TYPES = new Set<TypeformQuestionType>([
  "multiple_choice", "dropdown", "ranking", "picture_choice", "yes_no",
]);

type QuestionImportMode = "csv" | "typeform" | "json" | null;

// ── Question Card ─────────────────────────────────────────────────────────────

function QuestionCard({
  question,
  index,
  total,
  submissions,
  onUpdate,
  onRemove,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOver,
  clientId,
  appId,
  companyDescription,
}: {
  question: ApplicationQuestion;
  index: number;
  total: number;
  submissions: AppSubmission[];
  onUpdate: (updates: Partial<ApplicationQuestion>) => void;
  onRemove: () => void;
  isDragOver: boolean;
  onDragStart: (idx: number) => void;
  onDragEnd: () => void;
  onDragOver: (idx: number) => void;
  clientId: string;
  appId: string;
  companyDescription: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function generateGradingPrompt() {
    if (!question.grading_prompt_template) return;
    setGenerating(true);
    setGenError(null);
    try {
      const apiKey = typeof window !== "undefined" ? localStorage.getItem("anthropic_api_key") : null;
      const res = await fetch(`/api/clients/${clientId}/applications/${appId}/generate-grading-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          questionRef: question.ref,
          questionTitle: question.title,
          questionType: question.type,
          questionChoices: question.choices,
          templateId: question.grading_prompt_template,
          companyDescription: companyDescription || undefined,
          apiKey,
        }),
      });
      const data = await res.json();
      if (data.success && data.grading_prompt) {
        onUpdate({ grading_prompt: data.grading_prompt });
      } else {
        setGenError(data.error || "Failed to generate prompt");
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Network error");
    } finally {
      setGenerating(false);
    }
  }
  const qRef = question.ref ?? question.id;
  const totalSubs = submissions.length;
  const answeredCount = submissions.filter((sub) => {
    const ans = sub.answers.find(
      (a) => a.question_ref === qRef || a.question_title.toLowerCase() === question.title.toLowerCase()
    );
    return ans?.value != null && ans.value.trim() !== "";
  }).length;

  const isChoiceType = CHOICE_QUESTION_TYPES.has(question.type);
  const isCorrelatable = CORRELATABLE_TYPES.includes(question.type);

  function generateChoicesFromSubmissions() {
    // Collect unique raw answer values — do NOT split on commas.
    // Each unique submission answer value becomes one answer choice.
    const values = new Set<string>();
    for (const sub of submissions) {
      const ans = sub.answers.find(
        (a) => a.question_ref === qRef || a.question_title.toLowerCase() === question.title.toLowerCase()
      );
      if (ans?.value) {
        values.add(ans.value.trim());
      }
    }
    const choiceList = Array.from(values).sort();
    if (!choiceList.length) return;
    onUpdate({
      choices: choiceList.map((label) => ({ id: uid(), label })),
    });
  }

  return (
    <div
      className={`bg-white/[0.04] border rounded-lg overflow-hidden transition-colors ${isDragOver ? "border-indigo-400 border-t-2" : "border-white/[0.08]"}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        (e.currentTarget as HTMLElement).style.opacity = "0.4";
        onDragStart(index);
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = "1";
        onDragEnd();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver(index);
      }}
    >
      {/* Header row — always visible */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-white/[0.02] border-b border-white/[0.06] cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Drag handle */}
        <div
          className="shrink-0 cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-300 transition-colors"
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="5" cy="3" r="1.2" /><circle cx="11" cy="3" r="1.2" />
            <circle cx="5" cy="8" r="1.2" /><circle cx="11" cy="8" r="1.2" />
            <circle cx="5" cy="13" r="1.2" /><circle cx="11" cy="13" r="1.2" />
          </svg>
        </div>
        <span className="text-[10px] font-mono text-slate-400 shrink-0 w-5">{index + 1}.</span>
        <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-300 shrink-0">
          {question.type.replace(/_/g, " ")}
        </span>
        <span className="flex-1 text-xs text-slate-300 truncate">{question.title}</span>
        {totalSubs > 0 && (
          <span className="text-[10px] text-slate-300 shrink-0 tabular-nums" title={`${answeredCount} of ${totalSubs} submissions answered`}>
            {answeredCount}/{totalSubs}
          </span>
        )}
        {isCorrelatable && (
          <span className="text-[9px] font-semibold text-indigo-400 shrink-0">● correlatable</span>
        )}
        {/* Drop-off rate */}
        <div className="shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()} title="Question drop-off rate (%)">
          <input
            type="number"
            min={0}
            max={100}
            value={question.drop_off_rate ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Math.min(100, Math.max(0, Number(e.target.value)));
              onUpdate({ drop_off_rate: v });
            }}
            placeholder="—"
            className="w-10 bg-transparent border-b border-white/[0.08] text-[10px] text-slate-300 text-center py-0.5 focus:outline-none focus:border-indigo-400 tabular-nums placeholder:text-slate-500"
          />
          <span className="text-[9px] text-slate-400">%</span>
        </div>
        <svg className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      {/* Body — expanded only */}
      {expanded && (
        <div className="p-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-1">Question Title</label>
            <input
              key={question.id + question.title}
              defaultValue={question.title}
              onBlur={(e) => {
                const val = e.target.value.trim();
                if (val && val !== question.title) onUpdate({ title: val });
              }}
              className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
            />
          </div>

          {/* Type + Required */}
          <div className="flex items-end gap-4 flex-wrap">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-1">Type</label>
              <select
                value={question.type}
                onChange={(e) => onUpdate({ type: e.target.value as TypeformQuestionType })}
                className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                {ALL_QUESTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-300 pb-2">
              <input
                type="checkbox"
                checked={question.required}
                onChange={(e) => onUpdate({ required: e.target.checked })}
                className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20"
              />
              Required
            </label>
          </div>

          {/* Choices (for choice-type questions) */}
          {isChoiceType && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-300">Answer Choices</label>
                {totalSubs > 0 && (
                  <button
                    onClick={generateChoicesFromSubmissions}
                    className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                    title="Generate choices from unique submission answers"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Generate from submissions
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {(question.choices ?? []).map((choice, ci) => (
                  <div key={choice.id} className="flex items-center gap-1.5 group">
                    <input
                      type="text"
                      value={choice.label}
                      onChange={(e) => {
                        const updated = [...(question.choices ?? [])];
                        updated[ci] = { ...updated[ci], label: e.target.value };
                        onUpdate({ choices: updated });
                      }}
                      className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="Answer choice…"
                    />
                    <button
                      onClick={() => {
                        const updated = (question.choices ?? []).filter((_, i) => i !== ci);
                        onUpdate({ choices: updated.length ? updated : undefined });
                      }}
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 transition-all p-0.5"
                      title="Remove choice"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const updated = [...(question.choices ?? []), { id: uid(), label: "" }];
                    onUpdate({ choices: updated });
                  }}
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                >
                  + Add choice
                </button>
              </div>
              {question.type === "multiple_choice" && (
                <label className="flex items-center gap-1.5 text-xs text-slate-300 mt-1.5">
                  <input
                    type="checkbox"
                    checked={question.allow_multiple_selection ?? false}
                    onChange={(e) => onUpdate({ allow_multiple_selection: e.target.checked })}
                    className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20"
                  />
                  Allow multiple selection
                </label>
              )}
            </div>
          )}

          {/* Grading Prompt */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-1">Grading Prompt</label>
            <div className="flex items-center gap-2">
              <select
                value={question.grading_prompt_template ?? ""}
                onChange={(e) => onUpdate({ grading_prompt_template: e.target.value || undefined, grading_prompt: undefined })}
                className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="">— None —</option>
                {GRADING_PROMPT_TEMPLATES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <button
                onClick={generateGradingPrompt}
                disabled={!question.grading_prompt_template || generating}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg transition-all ${
                  !question.grading_prompt_template || generating
                    ? "bg-white/[0.04] text-slate-400 cursor-not-allowed"
                    : "bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 hover:text-indigo-300"
                }`}
              >
                {generating ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 20" /></svg>
                    Generating…
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    {question.grading_prompt ? "Regenerate" : "Generate"}
                  </>
                )}
              </button>
            </div>
            {genError && (
              <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-[11px] text-red-400">{genError}</p>
              </div>
            )}
            <div className="mt-2 border border-dashed border-white/[0.08] rounded-lg bg-white/[0.02] overflow-hidden">
              {question.grading_prompt ? (
                <div className="relative">
                  <pre className="px-4 py-3 text-[11px] text-slate-300 whitespace-pre-wrap font-sans leading-relaxed max-h-60 overflow-y-auto">{question.grading_prompt}</pre>
                  <div className="absolute top-2 right-2 flex gap-1">
                    <button
                      onClick={() => { navigator.clipboard.writeText(question.grading_prompt!); }}
                      className="px-2 py-1 text-[10px] font-semibold bg-white/[0.06] text-slate-300 hover:bg-white/[0.1] rounded transition-colors"
                      title="Copy to clipboard"
                    >Copy</button>
                    <button
                      onClick={() => onUpdate({ grading_prompt: undefined })}
                      className="px-2 py-1 text-[10px] font-semibold bg-white/[0.06] text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      title="Clear prompt"
                    >Clear</button>
                  </div>
                </div>
              ) : (
                <p className="px-4 py-3 text-[11px] text-slate-400 text-center">
                  {question.grading_prompt_template
                    ? `Template: ${GRADING_PROMPT_TEMPLATES.find((t) => t.value === question.grading_prompt_template)?.label ?? question.grading_prompt_template}. Click Generate to create the grading prompt.`
                    : "No grading prompt yet. Select a template type and click Generate."}
                </p>
              )}
            </div>
          </div>

          {/* Delete */}
          <div className="pt-1 border-t border-white/[0.06]">
            <button onClick={onRemove} className="text-xs text-red-400 hover:text-red-400 font-medium transition-colors">
              Delete Question
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Questions Tab Main ─────────────────────────────────────────────────────────

function QuestionsTab({
  app,
  onSave,
  clientId,
  companyDescription,
}: {
  app: Application;
  onSave: (a: Application) => void;
  clientId: string;
  companyDescription: string;
}) {
  const [importMode, setImportMode] = useState<QuestionImportMode>(null);

  // Typeform connection state
  const [tfPat, setTfPat] = useState(app.typeform_pat ?? "");
  const [tfFormId, setTfFormId] = useState(app.typeform_form_id ?? "");
  const [tfSyncing, setTfSyncing] = useState(false);
  const [tfError, setTfError] = useState<string | null>(null);
  const [tfSuccess, setTfSuccess] = useState<string | null>(null);

  async function syncTypeform() {
    if (!tfPat.trim() || !tfFormId.trim()) return;
    setTfSyncing(true);
    setTfError(null);
    setTfSuccess(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/typeform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pat: tfPat.trim(), form_id: tfFormId.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        onSave(data.application);
        setTfSuccess(`Synced ${data.questions_count} questions and ${data.submissions_count} new submissions.`);
        setImportMode(null);
      } else {
        setTfError(data.error || "Sync failed");
      }
    } catch (err) {
      setTfError(err instanceof Error ? err.message : "Network error");
    } finally {
      setTfSyncing(false);
    }
  }

  // CSV import state
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [csvParsed, setCsvParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [csvMapping, setCsvMapping] = useState<{ file_column: string; target: string }[]>([]);
  const [csvImporting, setCsvImporting] = useState(false);


  // JSON import state
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");

  // Manual add state
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<TypeformQuestionType>("multiple_choice");

  const questionTitles = app.questions.map((q) => q.title);
  const submissions = app.submissions ?? [];

  const SUBMISSION_TARGETS = [
    { value: "skip", label: "— Skip —" },
    { value: "email", label: "Email" },
    { value: "first_name", label: "First Name" },
    { value: "last_name", label: "Last Name" },
    { value: "full_name", label: "Full Name" },
    { value: "phone", label: "Phone" },
    { value: "submission_id", label: "Submission ID" },
    { value: "submitted_at", label: "Submitted At" },
    { value: "grade.final", label: "Final Grade" },
    { value: "grade.answer", label: "Answer Grade" },
    { value: "grade.financial", label: "Financial Grade" },
    { value: "financial.credit_score", label: "Credit Score" },
    { value: "financial.estimated_income", label: "Estimated Income" },
    { value: "financial.available_credit", label: "Available Credit" },
    { value: "financial.available_funding", label: "Available Funding" },
    ...questionTitles.map((t) => ({ value: `answer:${t}`, label: `Answer: ${t}` })),
  ];

  // Column sample values for the mapping UI
  const colSamples = useMemo(() => {
    if (!csvParsed) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const h of csvParsed.headers) {
      const vals = csvParsed.rows.map((r) => r[h]?.trim() ?? "").filter(Boolean);
      out[h] = Array.from(new Set(vals)).slice(0, 3);
    }
    return out;
  }, [csvParsed]);

  async function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await parseFileToRows(file);
    setCsvParsed(result);
    setCsvMapping(buildInitialMapping(result.headers, questionTitles));
  }

  function importCsvData() {
    if (!csvParsed) return;
    setCsvImporting(true);
    const newSubmissions: AppSubmission[] = [];
    const newQuestions: ApplicationQuestion[] = [...app.questions];

    for (const row of csvParsed.rows) {
      let email: string | undefined;
      let firstName = "", lastName = "", fullName = "", submissionId = "", submittedAt = "";
      const answers: AppSubmissionAnswer[] = [];
      const grade: AppSubmission["grade"] = {};
      const financial: AppSubmission["financial"] = {};

      for (const m of csvMapping) {
        const val = row[m.file_column]?.trim() ?? "";
        if (!val || m.target === "skip") continue;
        if (m.target === "email") email = val.toLowerCase();
        else if (m.target === "first_name") firstName = val;
        else if (m.target === "last_name") lastName = val;
        else if (m.target === "full_name") fullName = val;
        else if (m.target === "submission_id") submissionId = val;
        else if (m.target === "submitted_at") submittedAt = val;
        else if (m.target === "grade.final") grade.final_grade = parseFloat(val) || undefined;
        else if (m.target === "grade.answer") grade.answer_grade = parseFloat(val) || undefined;
        else if (m.target === "grade.financial") grade.financial_grade = parseFloat(val) || undefined;
        else if (m.target === "financial.credit_score") financial.credit_score = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.estimated_income") financial.estimated_income = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_credit") financial.available_credit = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_funding") financial.available_funding = parseDollarAmount(val) ?? undefined;
        else if (m.target.startsWith("answer:")) {
          const qTitle = m.target.slice(7);
          let existing = newQuestions.find((q) => q.title.toLowerCase() === qTitle.toLowerCase());
          if (!existing) {
            existing = { id: uid(), title: qTitle, type: "short_text", required: false, order: newQuestions.length };
            newQuestions.push(existing);
          }
          answers.push({ question_ref: existing.ref ?? existing.id, question_title: existing.title, value: val });
        }
      }

      const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || undefined;
      newSubmissions.push({
        id: submissionId || uid(),
        submitted_at: submittedAt || new Date().toISOString(),
        respondent_email: email,
        respondent_name: name,
        source: "csv",
        answers,
        grade: Object.keys(grade).length > 0 ? grade : undefined,
        financial: Object.keys(financial).length > 0 ? financial : undefined,
      });
    }

    onSave({ ...app, questions: newQuestions, submissions: [...(app.submissions ?? []), ...newSubmissions] });
    setCsvParsed(null);
    setCsvMapping([]);
    setCsvImporting(false);
    setImportMode(null);
    if (csvFileRef.current) csvFileRef.current.value = "";
  }


  function importJson() {
    setJsonError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText.trim());
    } catch {
      setJsonError("Invalid JSON — check your syntax.");
      return;
    }

    // Case 1: Typeform form JSON (has .fields[])
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "fields" in parsed) {
      const fields = (parsed as { fields: unknown[] }).fields;
      if (!Array.isArray(fields)) { setJsonError("Expected .fields to be an array."); return; }
      const allTypeSet: Set<string> = new Set(ALL_QUESTION_TYPES.map((t) => t.value));
      const newQs: ApplicationQuestion[] = fields.map((f: unknown, i) => {
        const field = f as Record<string, unknown>;
        const rawType = (field.type as string) ?? "short_text";
        const props = (field.properties as Record<string, unknown>) ?? {};
        const validations = (field.validations as Record<string, unknown>) ?? {};
        const choices = props.choices as Array<{ id: string; label: string }> | undefined;
        return {
          id: (field.id as string) ?? uid(),
          ref: field.ref as string | undefined,
          title: (field.title as string) ?? `Question ${i + 1}`,
          type: (allTypeSet.has(rawType) ? rawType as TypeformQuestionType : "short_text" as TypeformQuestionType),
          required: !!validations.required,
          choices: Array.isArray(choices) ? choices.map((c) => ({ id: c.id ?? uid(), label: c.label })) : undefined,
          order: app.questions.length + i,
        };
      });
      const existingTitles = new Set(app.questions.map((q) => q.title.toLowerCase()));
      const toAdd = newQs.filter((q) => !existingTitles.has(q.title.toLowerCase()));
      onSave({ ...app, questions: [...app.questions, ...toAdd] });
      setJsonText("");
      setImportMode(null);
      return;
    }

    // Case 2: Our Application JSON (has .questions[])
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "questions" in parsed) {
      const data = parsed as { questions?: ApplicationQuestion[]; submissions?: AppSubmission[] };
      const qs = Array.isArray(data.questions) ? data.questions : [];
      const subs = Array.isArray(data.submissions) ? data.submissions : [];
      onSave({
        ...app,
        questions: qs.length ? qs : app.questions,
        submissions: subs.length ? [...(app.submissions ?? []), ...subs] : app.submissions,
      });
      setJsonText("");
      setImportMode(null);
      return;
    }

    // Case 3: Array of submission objects (CSV-style JSON rows)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const rows = parsed as Record<string, string>[];
      const headers = Object.keys(rows[0]);
      const result = {
        headers,
        rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? "")]))),
        rowCount: rows.length,
      };
      setCsvParsed(result);
      setCsvMapping(buildInitialMapping(result.headers, questionTitles));
      setJsonText("");
      setImportMode("csv");
      return;
    }

    setJsonError("Unrecognized format. Expected Typeform form JSON, Application JSON, or an array of submission objects.");
  }

  function addQuestion() {
    if (!newTitle.trim()) return;
    const q: ApplicationQuestion = {
      id: uid(),
      title: newTitle.trim(),
      type: newType,
      required: false,
      order: app.questions.length,
    };
    onSave({ ...app, questions: [...app.questions, q] });
    setNewTitle("");
  }

  function updateQuestion(id: string, updates: Partial<ApplicationQuestion>) {
    onSave({
      ...app,
      questions: app.questions.map((q) => (q.id === id ? { ...q, ...updates } : q)),
      // Keep submission answer titles in sync when question title changes
      submissions: updates.title
        ? (app.submissions ?? []).map((sub) => ({
            ...sub,
            answers: sub.answers.map((ans) => {
              const q = app.questions.find((x) => x.id === id);
              if (!q) return ans;
              if (ans.question_ref === (q.ref ?? q.id) || ans.question_title.toLowerCase() === q.title.toLowerCase()) {
                return { ...ans, question_title: updates.title! };
              }
              return ans;
            }),
          }))
        : app.submissions,
    });
  }

  function removeQuestion(id: string) {
    onSave({ ...app, questions: app.questions.filter((q) => q.id !== id).map((q, i) => ({ ...q, order: i })) });
  }

  // Drag-and-drop reorder state
  const [qDragState, setQDragState] = useState<{ dragIdx: number; overIdx: number } | null>(null);

  function reorderQuestions(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    const qs = [...app.questions];
    const [moved] = qs.splice(fromIdx, 1);
    qs.splice(toIdx, 0, moved);
    onSave({ ...app, questions: qs.map((q, i) => ({ ...q, order: i })) });
  }

  const importModeLabels: Record<NonNullable<QuestionImportMode>, string> = {
    csv: "Upload CSV / XLSX",
    typeform: "Typeform API",
    json: "Import JSON",
  };

  const [showImport, setShowImport] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);

  // Audit state
  const [auditGenerating, setAuditGenerating] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditCollapsed, setAuditCollapsed] = useState(true);
  const [showAuditNotes, setShowAuditNotes] = useState(false);
  const [auditNotes, setAuditNotes] = useState(app.audit_client_notes ?? "");
  const [showAuditRegenConfirm, setShowAuditRegenConfirm] = useState(false);

  async function generateAudit() {
    setAuditGenerating(true);
    setAuditError(null);
    setShowAuditRegenConfirm(false);
    setShowAuditNotes(false);
    try {
      const apiKey = typeof window !== "undefined" ? localStorage.getItem("anthropic_api_key") ?? "" : "";
      if (!apiKey) { setAuditError("Add your Anthropic API key in Settings on the home page."); return; }
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, clientNotes: auditNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        onSave({
          ...app,
          audit_analysis: data.audit,
          audit_generated_at: data.generated_at,
          audit_client_notes: auditNotes.trim() || undefined,
        });
        setAuditCollapsed(false);
      } else {
        setAuditError(data.error || "Failed to generate audit.");
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAuditGenerating(false);
    }
  }

  // Grading Audit state
  const [gradingAuditGenerating, setGradingAuditGenerating] = useState(false);
  const [gradingAuditError, setGradingAuditError] = useState<string | null>(null);
  const [gradingAuditCollapsed, setGradingAuditCollapsed] = useState(true);
  const [showGradingAuditNotes, setShowGradingAuditNotes] = useState(false);
  const [gradingAuditNotes, setGradingAuditNotes] = useState(app.grading_audit_client_notes ?? "");
  const [showGradingAuditRegenConfirm, setShowGradingAuditRegenConfirm] = useState(false);

  async function generateGradingAudit() {
    setGradingAuditGenerating(true);
    setGradingAuditError(null);
    setShowGradingAuditRegenConfirm(false);
    setShowGradingAuditNotes(false);
    try {
      const apiKey = typeof window !== "undefined" ? localStorage.getItem("anthropic_api_key") ?? "" : "";
      if (!apiKey) { setGradingAuditError("Add your Anthropic API key in Settings on the home page."); return; }
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-grading-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, clientNotes: gradingAuditNotes.trim() || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        onSave({
          ...app,
          grading_audit_analysis: data.audit,
          grading_audit_generated_at: data.generated_at,
          grading_audit_client_notes: gradingAuditNotes.trim() || undefined,
        });
        setGradingAuditCollapsed(false);
      } else {
        setGradingAuditError(data.error || "Failed to generate grading audit.");
      }
    } catch (err) {
      setGradingAuditError(err instanceof Error ? err.message : "Network error");
    } finally {
      setGradingAuditGenerating(false);
    }
  }

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-slate-400">Questions</p>
          <span className="text-xs text-slate-300">{app.questions.length} questions</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowImport(!showImport); if (showManualAdd) setShowManualAdd(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
              showImport ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Import
          </button>
          <button
            onClick={() => { setShowManualAdd(!showManualAdd); if (showImport) setShowImport(false); }}
            className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${
              showManualAdd ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04] hover:text-slate-300"
            }`}
            title="Add question manually"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Import Sources (collapsed by default) ── */}
      {showImport && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {(["csv", "typeform", "json"] as NonNullable<QuestionImportMode>[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setImportMode(importMode === mode ? null : mode)}
                className={`px-4 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  importMode === mode
                    ? "bg-indigo-500 text-white border-indigo-500"
                    : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
                }`}
              >
                {importModeLabels[mode]}
              </button>
            ))}
          </div>

          {/* CSV Panel */}
          {importMode === "csv" && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <p className="text-xs text-slate-300">
                Upload a submissions CSV/XLSX. Columns mapped to <strong>Answer:</strong> fields will auto-create questions and import all submissions in one step.
              </p>
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleCsvFile}
                className="text-sm text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-500/10 file:text-indigo-400 hover:file:bg-indigo-500/20"
              />

              {csvParsed && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[11px] text-slate-300">{csvParsed.rowCount} rows · map each column to its target field</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setCsvParsed(null); setCsvMapping([]); }}
                        className="text-xs text-slate-300 hover:text-slate-300 font-semibold"
                      >
                        Clear
                      </button>
                      <button
                        onClick={importCsvData}
                        disabled={csvImporting}
                        className="px-4 py-1.5 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                      >
                        {csvImporting ? "Importing…" : `Import ${csvParsed.rowCount} rows`}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
                    {csvMapping.map((m, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <div className="w-5/12 min-w-0 pt-1.5">
                          <p className="text-xs text-slate-300 font-medium truncate" title={m.file_column}>{m.file_column}</p>
                          {colSamples[m.file_column]?.length > 0 && (
                            <p className="text-[10px] text-slate-400 truncate mt-0.5">
                              {colSamples[m.file_column].join(" · ")}
                            </p>
                          )}
                        </div>
                        <svg className="w-4 h-4 text-slate-400 shrink-0 mt-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                        <select
                          value={m.target}
                          onChange={(e) => setCsvMapping((prev) => prev.map((x, j) => j === i ? { ...x, target: e.target.value } : x))}
                          className={`flex-1 border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                            m.target === "skip" ? "border-white/[0.06] text-slate-400" : "border-indigo-500/30 text-slate-400 bg-indigo-500/10"
                          }`}
                        >
                          {SUBMISSION_TARGETS.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                          {m.target.startsWith("answer:") && !SUBMISSION_TARGETS.find((t) => t.value === m.target) && (
                            <option value={m.target}>Answer: {m.target.slice(7)}</option>
                          )}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Typeform Panel */}
          {importMode === "typeform" && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <p className="text-xs text-slate-300">
                Enter your Typeform Personal Access Token and Form ID to pull questions and submissions directly from Typeform.
              </p>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-1">Personal Access Token (PAT)</label>
                  <input
                    type="password"
                    value={tfPat}
                    onChange={(e) => setTfPat(e.target.value)}
                    placeholder="tfp_…"
                    className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-300 mb-1">Form ID</label>
                  <input
                    value={tfFormId}
                    onChange={(e) => setTfFormId(e.target.value)}
                    placeholder="abc123XY"
                    className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={syncTypeform}
                  disabled={tfSyncing || !tfPat.trim() || !tfFormId.trim()}
                  className="px-4 py-2 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                >
                  {tfSyncing ? "Syncing…" : "Sync from Typeform"}
                </button>
                {tfError && (
                  <p className="text-xs font-medium text-red-400">{tfError}</p>
                )}
                {tfSuccess && (
                  <p className="text-xs font-medium text-emerald-400">{tfSuccess}</p>
                )}
              </div>
              <p className="text-[10px] text-slate-400">PAT and Form ID are saved on this application for future syncs.</p>
            </div>
          )}

          {/* JSON Panel */}
          {importMode === "json" && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <p className="text-xs text-slate-300">
                Paste Typeform form JSON (with <code className="text-[11px] bg-white/[0.06] px-1 rounded">.fields[]</code>),
                Application JSON (with <code className="text-[11px] bg-white/[0.06] px-1 rounded">.questions[]</code>),
                or an array of submission objects.
              </p>
              <textarea
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setJsonError(""); }}
                rows={8}
                placeholder={`{"fields": [...]}  or  {"questions": [...], "submissions": [...]}  or  [{...}, ...]`}
                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
              {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
              <button
                onClick={importJson}
                disabled={!jsonText.trim()}
                className="px-4 py-2 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
              >
                Import
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Manual Add (collapsed by default) ── */}
      {showManualAdd && (
        <div className="flex gap-3">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addQuestion()}
            placeholder="Question title…"
            className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as TypeformQuestionType)}
            className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            {ALL_QUESTION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <button
            onClick={addQuestion}
            disabled={!newTitle.trim()}
            className="px-4 py-2 bg-indigo-500 text-white text-sm font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            Add
          </button>
        </div>
      )}

      {/* ── Question Cards ── */}
      {app.questions.length === 0 ? (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-6 py-12 text-center">
          <p className="text-slate-300 text-sm">No questions defined yet.</p>
          <p className="text-slate-400 text-xs mt-1">Upload a CSV, sync from Typeform, paste JSON, or add questions manually above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {app.questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              question={q}
              index={i}
              total={app.questions.length}
              submissions={submissions}
              clientId={clientId}
              appId={app.id}
              companyDescription={companyDescription}
              onUpdate={(updates) => updateQuestion(q.id, updates)}
              onRemove={() => removeQuestion(q.id)}
              isDragOver={qDragState != null && qDragState.overIdx === i && qDragState.dragIdx !== i}
              onDragStart={(idx) => setQDragState({ dragIdx: idx, overIdx: idx })}
              onDragEnd={() => {
                if (qDragState && qDragState.dragIdx !== qDragState.overIdx) {
                  reorderQuestions(qDragState.dragIdx, qDragState.overIdx);
                }
                setQDragState(null);
              }}
              onDragOver={(idx) => {
                if (qDragState && qDragState.overIdx !== idx) {
                  setQDragState({ ...qDragState, overIdx: idx });
                }
              }}
            />
          ))}
        </div>
      )}

      {/* ── Application Audit ── */}
      {app.questions.length > 0 && (
        app.audit_analysis ? (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-6 space-y-4">
            {/* Audit Header */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setAuditCollapsed(v => !v)}
                className="flex items-center gap-3 group"
              >
                <svg className={`w-3 h-3 text-slate-400 transition-transform ${auditCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h3 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">Application Audit</h3>
                {app.audit_generated_at && (
                  <span className="text-[10px] text-slate-400">
                    Generated {new Date(app.audit_generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </button>
              <div className="relative">
                {showAuditRegenConfirm ? (
                  <div className="flex items-center gap-2 bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-1.5">
                    <span className="text-[10px] text-slate-300">Regenerate?</span>
                    <button
                      onClick={generateAudit}
                      disabled={auditGenerating}
                      className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setShowAuditRegenConfirm(false)}
                      className="text-[10px] text-slate-400 hover:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAuditRegenConfirm(true)}
                    className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded hover:bg-white/[0.05]"
                    title="Regenerate audit"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Collapsible audit body */}
            {!auditCollapsed && <>
            {auditGenerating ? (
              <div className="space-y-3 animate-pulse">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-4 w-40 bg-white/[0.06] rounded" />
                    <div className="h-3 w-full bg-white/[0.04] rounded" />
                    <div className="h-3 w-3/4 bg-white/[0.04] rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {app.audit_analysis.split(/^## /m).filter(Boolean).map((section, i) => {
                  const lines = section.split("\n");
                  const title = lines[0]?.trim();
                  const body = lines.slice(1).join("\n").trim();
                  return (
                    <div key={i}>
                      {title && (
                        <div className="flex items-center gap-2 mb-2">
                          <div className="h-px flex-1 bg-white/[0.06]" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400/80">{title}</span>
                          <div className="h-px flex-1 bg-white/[0.06]" />
                        </div>
                      )}
                      {body && (
                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">
                          {body.split("\n").map((line, li) => {
                            const trimmed = line.trim();
                            if (!trimmed) return <br key={li} />;
                            // Handle ### sub-headers (question-by-question audit)
                            if (trimmed.startsWith("### ")) {
                              return (
                                <p key={li} className="text-[11px] font-bold text-slate-200 mt-3 mb-1">
                                  {trimmed.slice(4)}
                                </p>
                              );
                            }
                            if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
                              const content = trimmed.slice(2);
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-indigo-400/60 mt-0.5 shrink-0">•</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            if (/^\d+\.\s/.test(trimmed)) {
                              const num = trimmed.match(/^(\d+)\.\s/)?.[1];
                              const content = trimmed.replace(/^\d+\.\s/, "");
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-indigo-400/60 mt-0.5 shrink-0 text-[10px] font-mono">{num}.</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            return (
                              <p key={li} className="mb-1" dangerouslySetInnerHTML={{
                                __html: trimmed
                                  .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                              }} />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {auditError && (
              <p className="text-xs text-red-400 mt-2">{auditError}</p>
            )}
            </>}
          </div>
        ) : (
          /* Generate audit button + notes */
          <div className="space-y-3">
            {showAuditNotes ? (
              <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-300">Pre-Audit Notes</p>
                  <button onClick={() => setShowAuditNotes(false)} className="text-slate-400 hover:text-slate-300 text-xs">Cancel</button>
                </div>
                <textarea
                  value={auditNotes}
                  onChange={(e) => setAuditNotes(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any specific concerns, goals, or context for this audit? (optional)"
                  className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={generateAudit}
                    disabled={auditGenerating}
                    className="px-4 py-2 text-xs font-semibold bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                  >
                    {auditGenerating ? "Generating…" : "Generate Audit"}
                  </button>
                  <span className="text-[10px] text-slate-400 ml-auto">{auditNotes.length}/1000</span>
                </div>
                {auditError && <p className="text-xs text-red-400">{auditError}</p>}
              </div>
            ) : (
              <button
                onClick={() => setShowAuditNotes(true)}
                disabled={auditGenerating}
                className="w-full bg-white/[0.03] border border-dashed border-white/[0.1] rounded-xl p-4 text-center cursor-pointer hover:bg-white/[0.05] hover:border-white/[0.15] transition-all group disabled:opacity-50 disabled:cursor-wait"
              >
                {auditGenerating ? (
                  <div className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
                      <path d="M12 2a10 10 0 019.75 7.75" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span className="text-sm text-slate-400">Running application audit…</span>
                  </div>
                ) : (
                  <div>
                    <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">🔍 Run Application Audit</span>
                    <p className="text-[10px] text-slate-500 mt-1">AI-powered evaluation of your question set, sequence, drop-off, and qualification effectiveness</p>
                  </div>
                )}
              </button>
            )}
          </div>
        )
      )}

      {/* ── Grading Audit ── */}
      {app.questions.length > 0 && (
        app.grading_audit_analysis ? (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-6 space-y-4">
            {/* Grading Audit Header */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setGradingAuditCollapsed(v => !v)}
                className="flex items-center gap-3 group"
              >
                <svg className={`w-3 h-3 text-slate-400 transition-transform ${gradingAuditCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h3 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">Grading Audit</h3>
                {app.grading_audit_generated_at && (
                  <span className="text-[10px] text-slate-400">
                    Generated {new Date(app.grading_audit_generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </button>
              <div className="relative">
                {showGradingAuditRegenConfirm ? (
                  <div className="flex items-center gap-2 bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-1.5">
                    <span className="text-[10px] text-slate-300">Regenerate?</span>
                    <button
                      onClick={generateGradingAudit}
                      disabled={gradingAuditGenerating}
                      className="text-[10px] font-semibold text-emerald-400 hover:text-emerald-300"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setShowGradingAuditRegenConfirm(false)}
                      className="text-[10px] text-slate-400 hover:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowGradingAuditRegenConfirm(true)}
                    className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded hover:bg-white/[0.05]"
                    title="Regenerate grading audit"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Collapsible grading audit body */}
            {!gradingAuditCollapsed && <>
            {gradingAuditGenerating ? (
              <div className="space-y-3 animate-pulse">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-4 w-40 bg-white/[0.06] rounded" />
                    <div className="h-3 w-full bg-white/[0.04] rounded" />
                    <div className="h-3 w-3/4 bg-white/[0.04] rounded" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                {app.grading_audit_analysis.split(/^## /m).filter(Boolean).map((section, i) => {
                  const lines = section.split("\n");
                  const title = lines[0]?.trim();
                  const body = lines.slice(1).join("\n").trim();
                  return (
                    <div key={i}>
                      {title && (
                        <div className="flex items-center gap-2 mb-2">
                          <div className="h-px flex-1 bg-white/[0.06]" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/80">{title}</span>
                          <div className="h-px flex-1 bg-white/[0.06]" />
                        </div>
                      )}
                      {body && (
                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">
                          {body.split("\n").map((line, li) => {
                            const trimmed = line.trim();
                            if (!trimmed) return <br key={li} />;
                            if (trimmed.startsWith("### ")) {
                              return (
                                <p key={li} className="text-[11px] font-bold text-slate-200 mt-3 mb-1">
                                  {trimmed.slice(4)}
                                </p>
                              );
                            }
                            if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
                              const content = trimmed.slice(2);
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-emerald-400/60 mt-0.5 shrink-0">•</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            if (/^\d+\.\s/.test(trimmed)) {
                              const num = trimmed.match(/^(\d+)\.\s/)?.[1];
                              const content = trimmed.replace(/^\d+\.\s/, "");
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-emerald-400/60 mt-0.5 shrink-0 text-[10px] font-mono">{num}.</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            return (
                              <p key={li} className="mb-1" dangerouslySetInnerHTML={{
                                __html: trimmed
                                  .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                              }} />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {gradingAuditError && (
              <p className="text-xs text-red-400 mt-2">{gradingAuditError}</p>
            )}
            </>}
          </div>
        ) : (
          /* Generate grading audit button + notes */
          <div className="space-y-3">
            {showGradingAuditNotes ? (
              <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-300">Pre-Audit Notes</p>
                  <button onClick={() => setShowGradingAuditNotes(false)} className="text-slate-400 hover:text-slate-300 text-xs">Cancel</button>
                </div>
                <textarea
                  value={gradingAuditNotes}
                  onChange={(e) => setGradingAuditNotes(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="Any context about recent grading changes, specific thresholds to evaluate, or concerns? (optional)"
                  className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-y"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={generateGradingAudit}
                    disabled={gradingAuditGenerating}
                    className="px-4 py-2 text-xs font-semibold bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-40 transition-colors"
                  >
                    {gradingAuditGenerating ? "Generating…" : "Generate Grading Audit"}
                  </button>
                  <span className="text-[10px] text-slate-400 ml-auto">{gradingAuditNotes.length}/1000</span>
                </div>
                {gradingAuditError && <p className="text-xs text-red-400">{gradingAuditError}</p>}
              </div>
            ) : (
              <button
                onClick={() => setShowGradingAuditNotes(true)}
                disabled={gradingAuditGenerating}
                className="w-full bg-white/[0.03] border border-dashed border-white/[0.1] rounded-xl p-4 text-center cursor-pointer hover:bg-white/[0.05] hover:border-white/[0.15] transition-all group disabled:opacity-50 disabled:cursor-wait"
              >
                {gradingAuditGenerating ? (
                  <div className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin text-emerald-400" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
                      <path d="M12 2a10 10 0 019.75 7.75" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span className="text-sm text-slate-400">Running grading audit…</span>
                  </div>
                ) : (
                  <div>
                    <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">📊 Run Grading Audit</span>
                    <p className="text-[10px] text-slate-500 mt-1">Evaluate whether your grading rubric is correctly calibrated against actual show and close outcomes</p>
                  </div>
                )}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Upload Tab (Submissions)
// ─────────────────────────────────────────────────────────────────────────────

const TIMEZONE_OPTIONS = [
  { value: "UTC", label: "UTC", offset: 0 },
  { value: "US/Eastern", label: "Eastern (ET)", offset: -5 },
  { value: "US/Central", label: "Central (CT)", offset: -6 },
  { value: "US/Mountain", label: "Mountain (MT)", offset: -7 },
  { value: "US/Pacific", label: "Pacific (PT)", offset: -8 },
] as const;

/** Convert a date string from one timezone offset to another, return date-only YYYY-MM-DD */
function convertTimezone(dateStr: string, fromTz: string, toTz: string): string {
  if (!dateStr) return dateStr;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    if (fromTz !== toTz) {
      const fromOffset = TIMEZONE_OPTIONS.find(t => t.value === fromTz)?.offset ?? 0;
      const toOffset = TIMEZONE_OPTIONS.find(t => t.value === toTz)?.offset ?? 0;
      d.setHours(d.getHours() + (toOffset - fromOffset));
    }
    // Return date-only format: YYYY-MM-DD
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return dateStr;
  }
}

function SubmissionsUploadTab({ app, onSave, uploadType }: { app: Application; onSave: (a: Application) => void; uploadType: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [mapping, setMapping] = useState<{ file_column: string; target: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");
  const [sourceTz, setSourceTz] = useState("UTC");
  const [targetTz, setTargetTz] = useState("US/Eastern");

  const questionTitles = app.questions.map((q) => q.title);

  // All possible submission targets
  const SUBMISSION_TARGETS = [
    { value: "skip", label: "— Skip —" },
    { value: "email", label: "Email" },
    { value: "first_name", label: "First Name" },
    { value: "last_name", label: "Last Name" },
    { value: "full_name", label: "Full Name" },
    { value: "phone", label: "Phone" },
    { value: "submission_id", label: "Submission ID" },
    { value: "submitted_at", label: "Submitted At" },
    { value: "grade.final", label: "Final Grade" },
    { value: "grade.answer", label: "Answer Grade" },
    { value: "grade.financial", label: "Financial Grade" },
    { value: "grade.disqualified", label: "Was Disqualified" },
    { value: "grade.spam", label: "Was Spam" },
    { value: "grade.details", label: "Grade Details" },
    { value: "financial.credit_score", label: "Credit Score" },
    { value: "financial.estimated_income", label: "Estimated Income" },
    { value: "financial.available_credit", label: "Available Credit" },
    { value: "financial.available_funding", label: "Available Funding" },
    ...questionTitles.map((t) => ({ value: `answer:${t}`, label: `Answer: ${t}` })),
  ];

  // Column samples for mapping hints
  const colSamples = useMemo(() => {
    if (!parsed) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const h of parsed.headers) {
      const vals = parsed.rows.map((r) => r[h]?.trim() ?? "").filter(Boolean);
      out[h] = Array.from(new Set(vals)).slice(0, 3);
    }
    return out;
  }, [parsed]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await parseFileToRows(file);
    setParsed(result);
    const initialMapping = buildInitialMapping(result.headers, questionTitles);
    setMapping(initialMapping);
  }

  function updateMapping(idx: number, target: string) {
    setMapping((prev) => prev.map((m, i) => (i === idx ? { ...m, target } : m)));
  }

  function importData() {
    if (!parsed) return;
    setImporting(true);

    const newSubmissions: AppSubmission[] = [];
    const newQuestions: ApplicationQuestion[] = [...app.questions];

    for (const row of parsed.rows) {
      let email: string | undefined;
      let firstName = "";
      let lastName = "";
      let fullName = "";
      let submissionId = "";
      let submittedAt = "";
      const answers: AppSubmissionAnswer[] = [];
      const grade: AppSubmission["grade"] = {};
      const financial: AppSubmission["financial"] = {};

      for (const m of mapping) {
        const val = row[m.file_column]?.trim() ?? "";
        if (!val || m.target === "skip") continue;

        if (m.target === "email") email = val.toLowerCase();
        else if (m.target === "first_name") firstName = val;
        else if (m.target === "last_name") lastName = val;
        else if (m.target === "full_name") fullName = val;
        else if (m.target === "submission_id") submissionId = val;
        else if (m.target === "submitted_at") submittedAt = convertTimezone(val, sourceTz, targetTz);
        else if (m.target === "grade.final") grade.final_grade = parseFloat(val) || undefined;
        else if (m.target === "grade.answer") grade.answer_grade = parseFloat(val) || undefined;
        else if (m.target === "grade.financial") grade.financial_grade = parseFloat(val) || undefined;
        else if (m.target === "grade.disqualified") grade.was_disqualified = parseBoolValue(val);
        else if (m.target === "grade.spam") grade.was_spam = parseBoolValue(val);
        else if (m.target === "grade.details") grade.details = val;
        else if (m.target === "financial.credit_score") financial.credit_score = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.estimated_income") financial.estimated_income = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_credit") financial.available_credit = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_funding") financial.available_funding = parseDollarAmount(val) ?? undefined;
        else if (m.target.startsWith("answer:")) {
          const qTitle = m.target.slice(7);
          // Auto-create question if not exists
          let existing = newQuestions.find((q) => q.title.toLowerCase() === qTitle.toLowerCase());
          if (!existing) {
            existing = {
              id: uid(),
              title: qTitle,
              type: "short_text",
              required: false,
              order: newQuestions.length,
            };
            newQuestions.push(existing);
          }
          answers.push({
            question_ref: existing.ref ?? existing.id,
            question_title: existing.title,
            value: val,
          });
        }
      }

      const name = fullName || [firstName, lastName].filter(Boolean).join(" ") || undefined;

      newSubmissions.push({
        id: submissionId || uid(),
        submitted_at: submittedAt || new Date().toISOString(),
        respondent_email: email,
        respondent_name: name,
        source: "csv",
        answers,
        grade: Object.keys(grade).length > 0 ? grade : undefined,
        financial: Object.keys(financial).length > 0 ? financial : undefined,
      });
    }

    // De-dupe new submissions by email (last row wins)
    const dedupedNew: AppSubmission[] = [];
    const seenEmails = new Set<string>();
    for (let j = newSubmissions.length - 1; j >= 0; j--) {
      const key = (newSubmissions[j].respondent_email ?? "").toLowerCase();
      if (key && seenEmails.has(key)) continue;
      if (key) seenEmails.add(key);
      dedupedNew.unshift(newSubmissions[j]);
    }

    let finalSubmissions: AppSubmission[];

    if (importMode === "replace") {
      // Replace: new records overwrite existing by email, keep non-overlapping existing
      const newEmailSet = new Set(dedupedNew.map((s) => (s.respondent_email ?? "").toLowerCase()).filter(Boolean));
      const kept = (app.submissions ?? []).filter((s) => {
        const e = (s.respondent_email ?? "").toLowerCase();
        return !e || !newEmailSet.has(e);
      });
      finalSubmissions = [...kept, ...dedupedNew];
    } else {
      // Append: only add new emails, merge missing data into existing records
      const existingByEmail = new Map<string, number>();
      const existingSubs = [...(app.submissions ?? [])];
      for (let i = 0; i < existingSubs.length; i++) {
        const e = (existingSubs[i].respondent_email ?? "").toLowerCase();
        if (e) existingByEmail.set(e, i);
      }
      const toAdd: AppSubmission[] = [];
      for (const newSub of dedupedNew) {
        const key = (newSub.respondent_email ?? "").toLowerCase();
        if (key && existingByEmail.has(key)) {
          // Merge missing data into existing record
          const idx = existingByEmail.get(key)!;
          const existing = existingSubs[idx];
          existingSubs[idx] = {
            ...existing,
            respondent_name: existing.respondent_name || newSub.respondent_name,
            booking_date: existing.booking_date || newSub.booking_date,
            grade: {
              ...existing.grade,
              final_grade: existing.grade?.final_grade ?? newSub.grade?.final_grade,
              answer_grade: existing.grade?.answer_grade ?? newSub.grade?.answer_grade,
              financial_grade: existing.grade?.financial_grade ?? newSub.grade?.financial_grade,
              was_disqualified: existing.grade?.was_disqualified ?? newSub.grade?.was_disqualified,
              was_spam: existing.grade?.was_spam ?? newSub.grade?.was_spam,
              details: existing.grade?.details ?? newSub.grade?.details,
            },
            financial: {
              ...existing.financial,
              credit_score: existing.financial?.credit_score ?? newSub.financial?.credit_score,
              estimated_income: existing.financial?.estimated_income ?? newSub.financial?.estimated_income,
              available_credit: existing.financial?.available_credit ?? newSub.financial?.available_credit,
              available_funding: existing.financial?.available_funding ?? newSub.financial?.available_funding,
            },
            answers: mergeAnswers(existing.answers, newSub.answers),
          };
        } else {
          toAdd.push(newSub);
        }
      }
      finalSubmissions = [...existingSubs, ...toAdd];
    }

    const updated: Application = {
      ...app,
      questions: newQuestions,
      submissions: finalSubmissions,
    };

    onSave(updated);
    setParsed(null);
    setMapping([]);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function clearSubmissions() {
    if (!confirm(`Clear all ${app.submissions?.length ?? 0} submissions?`)) return;
    onSave({ ...app, submissions: [] });
  }

  const submissions = app.submissions ?? [];
  const [searchQuery, setSearchQuery] = useState("");
  type SubFilter = "linked" | "unlinked" | "booked" | "showed" | "closed";
  const [subFilters, setSubFilters] = useState<Set<SubFilter>>(new Set());
  function toggleSubFilter(f: SubFilter) {
    setSubFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) { next.delete(f); } else {
        next.add(f);
        if (f === "linked") next.delete("unlinked");
        if (f === "unlinked") next.delete("linked");
        if (f === "booked" || f === "showed" || f === "closed") {
          for (const x of ["booked", "showed", "closed"] as SubFilter[]) { if (x !== f) next.delete(x); }
        }
      }
      return next;
    });
  }

  const filteredSubmissions = useMemo(() => {
    let list = submissions;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) =>
        (s.respondent_email ?? "").toLowerCase().includes(q) ||
        (s.respondent_name ?? "").toLowerCase().includes(q) ||
        s.answers.some((a) => (a.value ?? "").toLowerCase().includes(q))
      );
    }
    if (subFilters.size > 0) {
      list = list.filter((s) => {
        const emailKey = (s.respondent_email ?? "").trim().toLowerCase();
        const cr = (app.call_results ?? []).find((r) => r.email.toLowerCase() === emailKey);
        const bk = (app.bookings ?? []).find((b) => b.email.toLowerCase() === emailKey);
        const isLinked = !!(cr || bk || (app.financial_records ?? []).some((f) => f.email.toLowerCase() === emailKey));
        const booked = cr?.booked ?? false;
        const showed = cr?.showed ?? bk?.showed ?? false;
        const closed = cr?.closed ?? bk?.closed ?? false;
        if (subFilters.has("linked") && !isLinked) return false;
        if (subFilters.has("unlinked") && isLinked) return false;
        if (subFilters.has("booked") && !booked) return false;
        if (subFilters.has("showed") && !showed) return false;
        if (subFilters.has("closed") && !closed) return false;
        return true;
      });
    }
    // Sort newest first
    return [...list].sort((a, b) => {
      const da = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
      const db = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
      return db - da;
    });
  }, [submissions, searchQuery, subFilters, app.call_results, app.bookings, app.financial_records]);

  const [showUpload, setShowUpload] = useState(false);
  const [showAddSubModal, setShowAddSubModal] = useState(false);
  const [newSubFields, setNewSubFields] = useState<{ name: string; email: string; answers: Record<string, string> }>({ name: "", email: "", answers: {} });

  function openAddSubModal() {
    setNewSubFields({ name: "", email: "", answers: {} });
    setShowAddSubModal(true);
  }

  function createSubmissionFromModal() {
    const newSub: AppSubmission = {
      id: uid(),
      submitted_at: new Date().toISOString(),
      respondent_name: newSubFields.name || undefined,
      respondent_email: newSubFields.email || undefined,
      answers: app.questions.map((q) => ({
        question_ref: q.ref ?? q.id,
        question_title: q.title,
        value: newSubFields.answers[q.id] || null,
      })),
    };
    onSave({ ...app, submissions: [newSub, ...(app.submissions ?? [])] });
    setShowAddSubModal(false);
  }

  const [showNormalizeTz, setShowNormalizeTz] = useState(false);
  const [normFromTz, setNormFromTz] = useState("UTC");
  const [normToTz, setNormToTz] = useState("US/Eastern");

  function normalizeDates() {
    if (!confirm(`Convert all ${submissions.length} submission dates from ${TIMEZONE_OPTIONS.find(t => t.value === normFromTz)?.label} to ${TIMEZONE_OPTIONS.find(t => t.value === normToTz)?.label}?`)) return;
    const updated = submissions.map(s => ({
      ...s,
      submitted_at: convertTimezone(s.submitted_at, normFromTz, normToTz),
    }));
    onSave({ ...app, submissions: updated });
    setShowNormalizeTz(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-slate-400">Submission Data</p>
          <span className="text-xs text-slate-300">{submissions.length} submissions</span>
        </div>
        <div className="flex items-center gap-2">
          {submissions.length > 0 && (
            <button
              onClick={() => setShowNormalizeTz(!showNormalizeTz)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
                showNormalizeTz ? "bg-amber-500/10 border-amber-500/20 text-amber-500" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
              }`}
              title="Convert submission dates between timezones"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Normalize Dates
            </button>
          )}
          <button
            onClick={() => setShowUpload(!showUpload)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
              showUpload ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Import
          </button>
          <button
            onClick={openAddSubModal}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:bg-white/[0.04] hover:text-slate-300 transition-colors"
            title="Add submission manually"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {/* Normalize dates panel */}
      {showNormalizeTz && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-5">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-500 mb-3">Normalize Submission Dates</p>
          <p className="text-[11px] text-amber-700 mb-3">Convert all existing submission dates from one timezone to another. This updates the stored dates permanently.</p>
          <div className="flex items-center gap-2 mb-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-amber-700 mb-1 font-semibold">From</p>
              <select
                value={normFromTz}
                onChange={(e) => setNormFromTz(e.target.value)}
                className="w-full border border-amber-500/20 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-amber-300"
              >
                {TIMEZONE_OPTIONS.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>
            <svg className="w-4 h-4 text-amber-400 shrink-0 mt-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-amber-700 mb-1 font-semibold">To</p>
              <select
                value={normToTz}
                onChange={(e) => setNormToTz(e.target.value)}
                className="w-full border border-amber-500/20 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-amber-300"
              >
                {TIMEZONE_OPTIONS.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-amber-500">Will update {submissions.length} submission dates</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowNormalizeTz(false)} className="px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-300 transition-colors">Cancel</button>
              <button
                onClick={normalizeDates}
                disabled={normFromTz === normToTz}
                className="px-4 py-1.5 bg-amber-500 text-white text-[11px] font-semibold rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
              >Convert Dates</button>
            </div>
          </div>
        </div>
      )}

      {/* File upload (hidden by default) */}
      {showUpload && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Upload CSV / XLSX</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFile}
            className="text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-500/10 file:text-indigo-400 hover:file:bg-indigo-500/20"
          />
        </div>
      )}

      {/* Column mapping */}
      {parsed && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-300">Column Mapping</p>
              <p className="text-[11px] text-slate-300 mt-0.5">{parsed.rowCount} rows found · Map each column to its target field</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center bg-white/[0.06] rounded-lg p-0.5">
                <button onClick={() => setImportMode("append")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "append" ? "bg-white/[0.04] text-indigo-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Append</button>
                <button onClick={() => setImportMode("replace")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "replace" ? "bg-white/[0.04] text-red-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Replace</button>
              </div>
              <button onClick={() => { setParsed(null); setMapping([]); }} className="text-xs text-slate-300 hover:text-slate-300 font-semibold transition-colors">
                Cancel
              </button>
              <button
                onClick={importData}
                disabled={importing}
                className="px-4 py-2 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
              >
                {importing ? "Importing…" : `Import ${parsed.rowCount} rows`}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-slate-300 mb-3">
            {importMode === "append"
              ? "Append: adds new records only. Existing records with matching emails will have missing fields filled in."
              : "Replace: overwrites existing records with matching emails. Non-matching records are kept."}
          </p>

          {/* Timezone settings — show when submitted_at is mapped */}
          {mapping.some(m => m.target === "submitted_at") && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500 mb-2">Date Timezone Conversion</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-amber-700 mb-1">Source timezone</p>
                  <select
                    value={sourceTz}
                    onChange={(e) => setSourceTz(e.target.value)}
                    className="w-full border border-amber-500/20 rounded px-2 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-amber-300"
                  >
                    {TIMEZONE_OPTIONS.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
                <svg className="w-4 h-4 text-amber-400 shrink-0 mt-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-amber-700 mb-1">Convert to</p>
                  <select
                    value={targetTz}
                    onChange={(e) => setTargetTz(e.target.value)}
                    className="w-full border border-amber-500/20 rounded px-2 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-amber-300"
                  >
                    {TIMEZONE_OPTIONS.map(tz => (
                      <option key={tz.value} value={tz.value}>{tz.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[10px] text-amber-500 mt-1.5">
                Dates will be converted from {TIMEZONE_OPTIONS.find(t => t.value === sourceTz)?.label} to {TIMEZONE_OPTIONS.find(t => t.value === targetTz)?.label} during import.
              </p>
            </div>
          )}

          <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
            {mapping.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
                <div className="min-w-0 pt-1.5">
                  <p className="text-sm text-slate-300 font-medium truncate" title={m.file_column}>{m.file_column}</p>
                  {colSamples[m.file_column]?.length > 0 && (
                    <p className="text-[10px] text-slate-400 truncate mt-0.5">{colSamples[m.file_column].join(" · ")}</p>
                  )}
                </div>
                <svg className="w-4 h-4 text-slate-400 shrink-0 mt-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <select
                  value={m.target}
                  onChange={(e) => updateMapping(i, e.target.value)}
                  className={`w-full border rounded-lg px-2 py-1.5 text-sm truncate focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                    m.target === "skip" ? "border-white/[0.06] text-slate-400" : "border-indigo-500/30 text-slate-400 bg-indigo-500/10"
                  }`}
                >
                  {SUBMISSION_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                  {/* Allow custom answer mapping */}
                  {m.target.startsWith("answer:") && !SUBMISSION_TARGETS.find((t) => t.value === m.target) && (
                    <option value={m.target}>Answer: {m.target.slice(7)}</option>
                  )}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search + Submissions accordion list */}
      {submissions.length > 0 && !parsed && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by email, name, or answer…"
                className="w-full border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-white/[0.04] placeholder:text-slate-400"
              />
              {(searchQuery || subFilters.size > 0) && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-300">{filteredSubmissions.length} of {submissions.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(["linked", "unlinked", "booked", "showed", "closed"] as SubFilter[]).map((f) => (
                <button key={f} onClick={() => toggleSubFilter(f)}
                  className={`px-2 py-1 text-[10px] font-semibold rounded-md border transition-colors capitalize ${
                    subFilters.has(f) ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:text-slate-300 hover:border-white/[0.15]"
                  }`}
                >{f}</button>
              ))}
            </div>
          </div>
          {filteredSubmissions.map((sub) => {
            const emailKey = (sub.respondent_email ?? "").trim().toLowerCase();
            const callRecord = (app.call_results ?? []).find((r) => r.email.toLowerCase() === emailKey);
            const booking = (app.bookings ?? []).find((b) => b.email.toLowerCase() === emailKey);
            const booked = (callRecord as CallResultRecord | undefined)?.booked ?? false;
            const showed = callRecord?.showed ?? booking?.showed;
            const closed = callRecord?.closed ?? booking?.closed;

            function updateSub(updater: (s: AppSubmission) => AppSubmission) {
              onSave({
                ...app,
                submissions: (app.submissions ?? []).map((s) => s.id === sub.id ? updater({ ...s }) : s),
              });
            }

            function setNumericField(field: "final_grade" | "answer_grade" | "financial_grade", raw: string) {
              const n = parseFloat(raw.replace(/[,$\s]/g, ""));
              updateSub((s) => ({ ...s, grade: { ...(s.grade ?? {}), [field]: isNaN(n) ? undefined : n } }));
            }

            function setFinancialField(field: "credit_score" | "estimated_income" | "available_credit" | "available_funding", raw: string) {
              const n = parseFloat(raw.replace(/[,$\s]/g, ""));
              updateSub((s) => ({ ...s, financial: { ...(s.financial ?? {}), [field]: isNaN(n) ? undefined : n } }));
            }

            function setAnswerValue(q: ApplicationQuestion, val: string) {
              updateSub((s) => {
                const qRef = q.ref ?? q.id;
                const answers = [...s.answers];
                const idx = answers.findIndex((a) => a.question_ref === qRef || a.question_title.toLowerCase() === q.title.toLowerCase());
                const payload: AppSubmissionAnswer = { question_ref: qRef, question_title: q.title, value: val || null };
                if (idx >= 0) answers[idx] = payload; else answers.push(payload);
                return { ...s, answers };
              });
            }

            return (
              <details key={sub.id} className="border border-white/[0.08] rounded-lg bg-white/[0.04]">
                <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center gap-2 hover:bg-white/[0.02] transition-colors rounded-t-lg">
                  <span className="text-xs text-slate-300 truncate flex-1">
                    {sub.respondent_name && sub.respondent_email
                      ? <>{sub.respondent_name} <span className="text-slate-300 font-normal">— {sub.respondent_email}</span></>
                      : sub.respondent_name ?? sub.respondent_email ?? "(no email)"}
                  </span>
                  <span className="text-[11px] text-slate-300 shrink-0">
                    {sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""}
                  </span>
                  {sub.grade?.final_grade != null && (
                    <span className="text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full px-1.5 py-0.5 shrink-0">
                      {sub.grade.final_grade.toFixed(1)}
                    </span>
                  )}
                  {sub.grade?.answer_grade != null && (
                    <span className="text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-full px-1.5 py-0.5 shrink-0">
                      {sub.grade.answer_grade.toFixed(1)}
                    </span>
                  )}
                  {sub.grade?.financial_grade != null && (
                    <span className="text-[10px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-full px-1.5 py-0.5 shrink-0">
                      {sub.grade.financial_grade.toFixed(1)}
                    </span>
                  )}
                  {booked && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 shrink-0">booked</span>}
                  {showed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 shrink-0">showed</span>}
                  {closed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 shrink-0">closed</span>}
                </summary>
                <div className="border-t border-white/[0.06] p-3 space-y-3">
                  {/* Basic fields */}
                  <div className="grid md:grid-cols-5 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Email</label>
                      <input
                        defaultValue={sub.respondent_email ?? ""}
                        onBlur={(e) => updateSub((s) => ({ ...s, respondent_email: e.target.value || undefined }))}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Submitted At</label>
                      <input
                        defaultValue={sub.submitted_at}
                        onBlur={(e) => updateSub((s) => ({ ...s, submitted_at: e.target.value }))}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Booking Date</label>
                      <input
                        defaultValue={sub.booking_date ?? ""}
                        onBlur={(e) => updateSub((s) => ({ ...s, booking_date: e.target.value || undefined }))}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Final Grade</label>
                      <input
                        defaultValue={sub.grade?.final_grade ?? ""}
                        onBlur={(e) => setNumericField("final_grade", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Answer Grade</label>
                      <input
                        defaultValue={sub.grade?.answer_grade ?? ""}
                        onBlur={(e) => setNumericField("answer_grade", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                  </div>
                  {/* Financial fields */}
                  <div className="grid md:grid-cols-5 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Financial Grade</label>
                      <input
                        defaultValue={sub.grade?.financial_grade ?? ""}
                        onBlur={(e) => setNumericField("financial_grade", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Credit Score</label>
                      <input
                        defaultValue={sub.financial?.credit_score ?? ""}
                        onBlur={(e) => setFinancialField("credit_score", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Est. Income</label>
                      <input
                        defaultValue={sub.financial?.estimated_income ?? ""}
                        onBlur={(e) => setFinancialField("estimated_income", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Credit Access</label>
                      <input
                        defaultValue={sub.financial?.available_credit ?? ""}
                        onBlur={(e) => setFinancialField("available_credit", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Funding Access</label>
                      <input
                        defaultValue={sub.financial?.available_funding ?? ""}
                        onBlur={(e) => setFinancialField("available_funding", e.target.value)}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                  </div>
                  {/* Answers */}
                  {app.questions.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-slate-400">Answers</h3>
                      {app.questions.map((q) => {
                        const ans = sub.answers.find((a) => a.question_ref === (q.ref ?? q.id) || a.question_title.toLowerCase() === q.title.toLowerCase());
                        return (
                          <div key={q.id} className="grid md:grid-cols-[240px,1fr] gap-2 items-start">
                            <label className="text-xs text-slate-300 pt-1.5">{q.title}</label>
                            <input
                              defaultValue={ans?.value ?? ""}
                              onBlur={(e) => setAnswerValue(q, e.target.value)}
                              className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="pt-3 mt-3 border-t border-white/[0.06] flex justify-end">
                    <button
                      onClick={() => {
                        if (!confirm(`Delete submission for ${sub.respondent_email ?? sub.respondent_name ?? "this record"}?`)) return;
                        onSave({ ...app, submissions: (app.submissions ?? []).filter((s) => s.id !== sub.id) });
                      }}
                      className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors"
                    >Delete submission</button>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Clear All — muted, at bottom */}
      {submissions.length > 0 && !parsed && (
        <button onClick={clearSubmissions} className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors">
          Clear all submissions
        </button>
      )}

      {/* Add Submission Modal */}
      {showAddSubModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4" onClick={() => setShowAddSubModal(false)}>
          <div className="bg-slate-900 border border-white/[0.08] rounded-xl w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200">New Submission</h3>
              <button onClick={() => setShowAddSubModal(false)} className="text-slate-400 hover:text-slate-300 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Name</label>
                  <input
                    value={newSubFields.name}
                    onChange={(e) => setNewSubFields((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Full name…"
                    className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Email</label>
                  <input
                    value={newSubFields.email}
                    onChange={(e) => setNewSubFields((p) => ({ ...p, email: e.target.value }))}
                    placeholder="email@example.com"
                    className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                  />
                </div>
              </div>
              {app.questions.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-300 mt-2">Answers</p>
                  {app.questions.map((q) => (
                    <div key={q.id}>
                      <label className="block text-[11px] text-slate-300 mb-1">{q.title}</label>
                      {q.choices && q.choices.length > 0 ? (
                        <select
                          value={newSubFields.answers[q.id] ?? ""}
                          onChange={(e) => setNewSubFields((p) => ({ ...p, answers: { ...p.answers, [q.id]: e.target.value } }))}
                          className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        >
                          <option value="">— Select —</option>
                          {q.choices.map((c) => <option key={c.id} value={c.label}>{c.label}</option>)}
                        </select>
                      ) : (
                        <input
                          value={newSubFields.answers[q.id] ?? ""}
                          onChange={(e) => setNewSubFields((p) => ({ ...p, answers: { ...p.answers, [q.id]: e.target.value } }))}
                          placeholder="Answer…"
                          className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-white/[0.06] flex justify-end gap-2">
              <button onClick={() => setShowAddSubModal(false)} className="px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-300 transition-colors">Cancel</button>
              <button
                onClick={createSubmissionFromModal}
                className="px-4 py-1.5 bg-indigo-500 text-white text-[11px] font-semibold rounded-lg hover:bg-indigo-600 transition-colors"
              >Create Submission</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial Upload Tab
// ─────────────────────────────────────────────────────────────────────────────

function FinancialUploadTab({ app, onSave }: { app: Application; onSave: (a: Application) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [mapping, setMapping] = useState<{ file_column: string; target: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");

  const FIN_TARGETS = [
    { value: "skip", label: "— Skip —" },
    { value: "email", label: "Email" },
    { value: "financial.credit_score", label: "Credit Score" },
    { value: "financial.estimated_income", label: "Estimated Income" },
    { value: "financial.available_credit", label: "Available Credit / Credit Access" },
    { value: "financial.available_funding", label: "Available Funding / Access to Funding" },
    { value: "financial.grade", label: "Financial Grade" },
  ];

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await parseFileToRows(file);
    setParsed(result);
    setMapping(buildInitialMapping(result.headers));
  }

  function updateMapping(idx: number, target: string) {
    setMapping((prev) => prev.map((m, i) => (i === idx ? { ...m, target } : m)));
  }

  // Column samples for mapping hints
  const colSamples = useMemo(() => {
    if (!parsed) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const h of parsed.headers) {
      const vals = parsed.rows.map((r) => r[h]?.trim() ?? "").filter(Boolean);
      out[h] = Array.from(new Set(vals)).slice(0, 3);
    }
    return out;
  }, [parsed]);

  function syncFinRecordToSub(
    submissions: AppSubmission[],
    rec: FinancialRecord,
    prevEmail?: string
  ): AppSubmission[] {
    const matchEmail = rec.email.toLowerCase();
    const oldEmail = (prevEmail ?? rec.email).toLowerCase();
    return submissions.map((sub) => {
      const subEmail = (sub.respondent_email ?? "").toLowerCase();
      if (subEmail !== matchEmail && subEmail !== oldEmail) return sub;
      return {
        ...sub,
        financial: {
          ...(sub.financial ?? {}),
          credit_score: rec.credit_score,
          estimated_income: rec.estimated_income,
          available_credit: rec.credit_access,
          available_funding: rec.access_to_funding,
        },
        grade: {
          ...(sub.grade ?? {}),
          financial_grade: rec.financial_grade,
        },
      };
    });
  }

  function importData() {
    if (!parsed) return;
    setImporting(true);

    const newRecords: FinancialRecord[] = [];

    for (const row of parsed.rows) {
      let email = "";
      const rec: Partial<FinancialRecord> = {};

      for (const m of mapping) {
        const val = row[m.file_column]?.trim() ?? "";
        if (!val || m.target === "skip") continue;

        if (m.target === "email") email = val.toLowerCase();
        else if (m.target === "financial.credit_score") rec.credit_score = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.estimated_income") rec.estimated_income = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_credit") rec.credit_access = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.available_funding") rec.access_to_funding = parseDollarAmount(val) ?? undefined;
        else if (m.target === "financial.grade") rec.financial_grade = parseFloat(val) || undefined;
      }

      if (email) {
        newRecords.push({ email, ...rec } as FinancialRecord);
      }
    }

    // De-dupe within import (last row wins)
    const dedupedNew: FinancialRecord[] = [];
    const seenEmails = new Set<string>();
    for (let j = newRecords.length - 1; j >= 0; j--) {
      const key = newRecords[j].email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      dedupedNew.unshift(newRecords[j]);
    }

    let mergedRecords: FinancialRecord[];
    if (importMode === "replace") {
      const newEmailSet = new Set(dedupedNew.map((r) => r.email.toLowerCase()));
      const kept = (app.financial_records ?? []).filter((r) => !newEmailSet.has(r.email.toLowerCase()));
      mergedRecords = [...kept, ...dedupedNew];
    } else {
      // Append: only add new emails, fill in missing fields for existing
      const existingByEmail = new Map<string, number>();
      const existingRecords = [...(app.financial_records ?? [])];
      for (let i = 0; i < existingRecords.length; i++) {
        existingByEmail.set(existingRecords[i].email.toLowerCase(), i);
      }
      const toAdd: FinancialRecord[] = [];
      for (const newRec of dedupedNew) {
        const key = newRec.email.toLowerCase();
        if (existingByEmail.has(key)) {
          const idx = existingByEmail.get(key)!;
          const old = existingRecords[idx];
          existingRecords[idx] = {
            ...old,
            financial_grade: old.financial_grade ?? newRec.financial_grade,
            credit_score: old.credit_score ?? newRec.credit_score,
            estimated_income: old.estimated_income ?? newRec.estimated_income,
            credit_access: old.credit_access ?? newRec.credit_access,
            access_to_funding: old.access_to_funding ?? newRec.access_to_funding,
          };
        } else {
          toAdd.push(newRec);
        }
      }
      mergedRecords = [...existingRecords, ...toAdd];
    }

    let updatedSubs = app.submissions ?? [];
    for (const rec of mergedRecords.filter((r) => seenEmails.has(r.email.toLowerCase()))) {
      updatedSubs = syncFinRecordToSub(updatedSubs, rec);
    }

    onSave({ ...app, financial_records: mergedRecords, submissions: updatedSubs });
    setParsed(null);
    setMapping([]);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function updateRecord(email: string, updates: Partial<FinancialRecord>) {
    const newRecords = (app.financial_records ?? []).map((r) =>
      r.email.toLowerCase() === email.toLowerCase() ? { ...r, ...updates } : r
    );
    const updatedRec = newRecords.find((r) => r.email.toLowerCase() === (updates.email?.toLowerCase() ?? email.toLowerCase()));
    let updatedSubs = app.submissions ?? [];
    if (updatedRec) {
      updatedSubs = syncFinRecordToSub(updatedSubs, updatedRec, email);
    }
    onSave({ ...app, financial_records: newRecords, submissions: updatedSubs });
  }

  function clearRecords() {
    if (!confirm(`Clear all ${app.financial_records?.length ?? 0} financial records?`)) return;
    onSave({ ...app, financial_records: [] });
  }

  const records = app.financial_records ?? [];
  const [searchQuery, setSearchQuery] = useState("");
  type FinFilter = "linked" | "unlinked" | "booked" | "showed" | "closed";
  const [finFilters, setFinFilters] = useState<Set<FinFilter>>(new Set());
  function toggleFinFilter(f: FinFilter) {
    setFinFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) { next.delete(f); } else {
        next.add(f);
        if (f === "linked") next.delete("unlinked");
        if (f === "unlinked") next.delete("linked");
        if (f === "booked" || f === "showed" || f === "closed") {
          for (const x of ["booked", "showed", "closed"] as FinFilter[]) { if (x !== f) next.delete(x); }
        }
      }
      return next;
    });
  }

  // Build name lookup from submissions
  const nameByEmail = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of (app.submissions ?? [])) {
      if (s.respondent_email && s.respondent_name) {
        map.set(s.respondent_email.toLowerCase(), s.respondent_name);
      }
    }
    return map;
  }, [app.submissions]);

  const filteredRecords = useMemo(() => {
    let list = records;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((r) => {
        const name = nameByEmail.get(r.email.toLowerCase()) ?? "";
        return r.email.toLowerCase().includes(q) || name.toLowerCase().includes(q);
      });
    }
    if (finFilters.size > 0) {
      list = list.filter((r) => {
        const emailKey = r.email.toLowerCase();
        const linkedSub = (app.submissions ?? []).find((s) => (s.respondent_email ?? "").toLowerCase() === emailKey);
        const cr = (app.call_results ?? []).find((c) => c.email.toLowerCase() === emailKey);
        const bk = (app.bookings ?? []).find((b) => b.email.toLowerCase() === emailKey);
        const isLinked = !!linkedSub;
        const booked = cr?.booked ?? false;
        const showed = cr?.showed ?? bk?.showed ?? false;
        const closed = cr?.closed ?? bk?.closed ?? false;
        if (finFilters.has("linked") && !isLinked) return false;
        if (finFilters.has("unlinked") && isLinked) return false;
        if (finFilters.has("booked") && !booked) return false;
        if (finFilters.has("showed") && !showed) return false;
        if (finFilters.has("closed") && !closed) return false;
        return true;
      });
    }
    return [...list].sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()));
  }, [records, searchQuery, nameByEmail, finFilters, app.submissions, app.call_results, app.bookings]);

  const [showUpload, setShowUpload] = useState(false);
  const [showAddFinModal, setShowAddFinModal] = useState(false);
  const [newFinFields, setNewFinFields] = useState<{ email: string; financial_grade: string; credit_score: string; estimated_income: string; credit_access: string; funding_access: string }>({ email: "", financial_grade: "", credit_score: "", estimated_income: "", credit_access: "", funding_access: "" });

  function openAddFinModal() {
    setNewFinFields({ email: "", financial_grade: "", credit_score: "", estimated_income: "", credit_access: "", funding_access: "" });
    setShowAddFinModal(true);
  }

  function createFinFromModal() {
    const parse = (v: string) => { const n = parseFloat(v.replace(/[,$\s]/g, "")); return isNaN(n) ? undefined : n; };
    const newRec: FinancialRecord = {
      email: newFinFields.email,
      financial_grade: parse(newFinFields.financial_grade),
      credit_score: parse(newFinFields.credit_score),
      estimated_income: parse(newFinFields.estimated_income),
      credit_access: parse(newFinFields.credit_access),
      access_to_funding: parse(newFinFields.funding_access),
    };
    onSave({ ...app, financial_records: [newRec, ...(app.financial_records ?? [])] });
    setShowAddFinModal(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-slate-400">Financial Data</p>
          <span className="text-xs text-slate-300">{records.length} records</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
              showUpload ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Import
          </button>
          <button
            onClick={openAddFinModal}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:bg-white/[0.04] hover:text-slate-300 transition-colors"
            title="Add record manually"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {/* File upload (hidden by default) */}
      {showUpload && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Upload CSV / XLSX</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFile}
            className="text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-500/10 file:text-indigo-400 hover:file:bg-indigo-500/20"
          />
        </div>
      )}

      {parsed && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-300">Column Mapping</p>
              <p className="text-[11px] text-slate-300 mt-0.5">{parsed.rowCount} rows found</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center bg-white/[0.06] rounded-lg p-0.5">
                <button onClick={() => setImportMode("append")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "append" ? "bg-white/[0.04] text-indigo-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Append</button>
                <button onClick={() => setImportMode("replace")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "replace" ? "bg-white/[0.04] text-red-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Replace</button>
              </div>
              <button onClick={() => { setParsed(null); setMapping([]); }} className="text-xs text-slate-300 hover:text-slate-300 font-semibold">Cancel</button>
              <button onClick={importData} disabled={importing} className="px-4 py-2 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors">
                {importing ? "Importing…" : `Import ${parsed.rowCount} rows`}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-slate-300 mb-3">
            {importMode === "append"
              ? "Append: adds new records only. Existing records with matching emails will have missing fields filled in."
              : "Replace: overwrites existing records with matching emails. Non-matching records are kept."}
          </p>
          <div className="space-y-2">
            {mapping.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-sm">
                <div className="min-w-0">
                  <p className="text-slate-300 font-medium truncate" title={m.file_column}>{m.file_column}</p>
                  {colSamples[m.file_column]?.length > 0 && (
                    <p className="text-[10px] text-slate-300 truncate mt-0.5">{colSamples[m.file_column].join(" · ")}</p>
                  )}
                </div>
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
                <select
                  value={m.target}
                  onChange={(e) => updateMapping(i, e.target.value)}
                  className={`w-full border rounded-lg px-2 py-1.5 text-sm truncate focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                    m.target === "skip" ? "border-white/[0.06] text-slate-400" : "border-indigo-500/30 text-slate-400 bg-indigo-500/10"
                  }`}
                >
                  {FIN_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {records.length > 0 && !parsed && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by email or name…"
                className="w-full border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-white/[0.04] placeholder:text-slate-400"
              />
              {(searchQuery || finFilters.size > 0) && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-300">{filteredRecords.length} of {records.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(["linked", "unlinked", "booked", "showed", "closed"] as FinFilter[]).map((f) => (
                <button key={f} onClick={() => toggleFinFilter(f)}
                  className={`px-2 py-1 text-[10px] font-semibold rounded-md border transition-colors capitalize ${
                    finFilters.has(f) ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:text-slate-300 hover:border-white/[0.15]"
                  }`}
                >{f}</button>
              ))}
            </div>
          </div>
          {filteredRecords.map((r, i) => {
            const linkedSub = (app.submissions ?? []).find(
              (s) => (s.respondent_email ?? "").toLowerCase() === r.email.toLowerCase()
            );
            const displayName = nameByEmail.get(r.email.toLowerCase());
            return (
              <details key={i} className="border border-white/[0.08] rounded-lg bg-white/[0.04]">
                <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center gap-2 hover:bg-white/[0.02] transition-colors rounded-t-lg">
                  <span className="text-xs text-slate-300 truncate flex-1">
                    {displayName ? <>{displayName} <span className="text-slate-300 font-normal">— {r.email}</span></> : r.email || "(no email)"}
                  </span>
                  {linkedSub && (
                    <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-1.5 py-0.5 font-semibold shrink-0">linked</span>
                  )}
                  {r.financial_grade != null && (
                    <span className="text-[10px] bg-indigo-500/10 text-indigo-400 rounded px-1.5 py-0.5 font-semibold shrink-0">FG: {r.financial_grade}</span>
                  )}
                  {r.credit_score != null && (
                    <span className="text-[10px] bg-white/[0.06] text-slate-300 rounded px-1.5 py-0.5 shrink-0">CS: {r.credit_score}</span>
                  )}
                </summary>
                <div className="border-t border-white/[0.06] p-3 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                      { label: "Email", field: "email" as keyof FinancialRecord, isString: true },
                      { label: "Financial Grade", field: "financial_grade" as keyof FinancialRecord, isString: false },
                      { label: "Credit Score", field: "credit_score" as keyof FinancialRecord, isString: false },
                      { label: "Est. Income", field: "estimated_income" as keyof FinancialRecord, isString: false },
                      { label: "Credit Access", field: "credit_access" as keyof FinancialRecord, isString: false },
                      { label: "Funding Access", field: "access_to_funding" as keyof FinancialRecord, isString: false },
                    ].map(({ label, field, isString }) => (
                      <div key={field}>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">{label}</label>
                        <input
                          defaultValue={(r[field] as string | number | undefined) ?? ""}
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            if (isString) {
                              updateRecord(r.email, { [field]: raw || undefined } as Partial<FinancialRecord>);
                            } else {
                              const num = raw === "" ? undefined : Number(raw);
                              updateRecord(r.email, { [field]: isNaN(num as number) ? undefined : num } as Partial<FinancialRecord>);
                            }
                          }}
                          className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white/[0.04]"
                        />
                      </div>
                    ))}
                  </div>
                  {linkedSub && (
                    <p className="text-[10px] text-emerald-400 mt-3">
                      ✓ Synced to submission for <span className="font-semibold">{linkedSub.respondent_email}</span>
                    </p>
                  )}
                  <div className="pt-3 mt-3 border-t border-white/[0.06] flex justify-end">
                    <button
                      onClick={() => {
                        if (!confirm(`Delete financial record for ${r.email}?`)) return;
                        onSave({ ...app, financial_records: (app.financial_records ?? []).filter((_, idx) => idx !== i) });
                      }}
                      className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors"
                    >Delete record</button>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Clear All — muted, at bottom */}
      {records.length > 0 && !parsed && (
        <button onClick={clearRecords} className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors">
          Clear all financial records
        </button>
      )}

      {/* Add Financial Record Modal */}
      {showAddFinModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4" onClick={() => setShowAddFinModal(false)}>
          <div className="bg-slate-900 border border-white/[0.08] rounded-xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200">New Financial Record</h3>
              <button onClick={() => setShowAddFinModal(false)} className="text-slate-400 hover:text-slate-300 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              {[
                { label: "Email", key: "email" as const, placeholder: "email@example.com" },
                { label: "Financial Grade", key: "financial_grade" as const, placeholder: "0-100" },
                { label: "Credit Score", key: "credit_score" as const, placeholder: "300-850" },
                { label: "Est. Income", key: "estimated_income" as const, placeholder: "75000" },
                { label: "Credit Access", key: "credit_access" as const, placeholder: "25000" },
                { label: "Funding Access", key: "funding_access" as const, placeholder: "50000" },
              ].map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">{label}</label>
                  <input
                    value={newFinFields[key]}
                    onChange={(e) => setNewFinFields((p) => ({ ...p, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                  />
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-white/[0.06] flex justify-end gap-2">
              <button onClick={() => setShowAddFinModal(false)} className="px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-300 transition-colors">Cancel</button>
              <button
                onClick={createFinFromModal}
                disabled={!newFinFields.email.trim()}
                className="px-4 py-1.5 bg-indigo-500 text-white text-[11px] font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
              >Create Record</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Results Upload Tab
// ─────────────────────────────────────────────────────────────────────────────

function CallResultsUploadTab({ app, onSave }: { app: Application; onSave: (a: Application) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");

  // Column assignments
  const [emailCol, setEmailCol] = useState("");
  const [bookingDateCol, setBookingDateCol] = useState("");
  const [closeDateCol, setCloseDateCol] = useState("");
  const [bookedCol, setBookedCol] = useState("");
  const [showedCol, setShowedCol] = useState("");
  const [closedCol, setClosedCol] = useState("");

  // Value matching mode: "any" = any non-empty value, "specific" = match selected values, "email" = column contains emails
  type MatchMode = "any" | "specific" | "email";
  const [bookedMode, setBookedMode] = useState<MatchMode>("any");
  const [showedMode, setShowedMode] = useState<MatchMode>("any");
  const [closedMode, setClosedMode] = useState<MatchMode>("any");

  // Selected values that count as true
  const [bookedValues, setBookedValues] = useState<Set<string>>(new Set());
  const [showedValues, setShowedValues] = useState<Set<string>>(new Set());
  const [closedValues, setClosedValues] = useState<Set<string>>(new Set());

  // Get all unique values for a column
  const colUniqueValues = useMemo(() => {
    if (!parsed) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const h of parsed.headers) {
      const vals = parsed.rows.map((r) => r[h]?.trim() ?? "").filter(Boolean);
      out[h] = Array.from(new Set(vals)).sort();
    }
    return out;
  }, [parsed]);

  // Sample values (first 3) for column preview
  const colSamples = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [h, vals] of Object.entries(colUniqueValues)) {
      out[h] = vals.slice(0, 3);
    }
    return out;
  }, [colUniqueValues]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const result = await parseFileToRows(file);
    setParsed(result);

    // Auto-detect columns by header name
    const lowerHeaders: Record<string, string> = {};
    for (const h of result.headers) lowerHeaders[h.toLowerCase().replace(/[^a-z]/g, "")] = h;
    setEmailCol(lowerHeaders["email"] ?? lowerHeaders["prospectemail"] ?? lowerHeaders["emailaddress"] ?? "");
    setBookingDateCol(lowerHeaders["bookingdate"] ?? lowerHeaders["dateofbooking"] ?? "");
    setCloseDateCol(lowerHeaders["closedate"] ?? lowerHeaders["closeddate"] ?? lowerHeaders["close_date"] ?? "");
    setBookedMode("any");
    setShowedMode("any");
    setClosedMode("any");
    setBookedValues(new Set());
    setShowedValues(new Set());
    setClosedValues(new Set());
    // Try to auto-detect booked/showed/closed columns
    const bk = lowerHeaders["booked"] ?? lowerHeaders["booking"] ?? "";
    const sh = lowerHeaders["showed"] ?? lowerHeaders["show"] ?? lowerHeaders["attended"] ?? "";
    const cl = lowerHeaders["closed"] ?? lowerHeaders["close"] ?? lowerHeaders["sold"] ?? "";
    setBookedCol(bk);
    setShowedCol(sh);
    setClosedCol(cl);
  }

  function toggleValue(set: Set<string>, val: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    setter(next);
  }

  /** Normalize any date string to YYYY-MM-DD (date only, no timestamp) */
  function normalizeDate(raw: string): string | undefined {
    if (!raw) return undefined;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw; // keep as-is if unparseable
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function syncCallRecordToSub(
    submissions: AppSubmission[],
    rec: CallResultRecord,
    prevEmail?: string
  ): AppSubmission[] {
    const matchEmail = rec.email.toLowerCase();
    const oldEmail = (prevEmail ?? rec.email).toLowerCase();
    return submissions.map((sub) => {
      const subEmail = (sub.respondent_email ?? "").toLowerCase();
      if (subEmail !== matchEmail && subEmail !== oldEmail) return sub;
      return {
        ...sub,
        booking_date: rec.booking_date,
      };
    });
  }

  function matchesField(val: string, mode: MatchMode, selectedValues: Set<string>): boolean {
    if (!val) return false;
    if (mode === "any") return true;
    if (mode === "specific") return selectedValues.has(val);
    return false; // "email" mode handled separately
  }

  // For "email" mode: collect all emails from a column into a Set
  function buildEmailSet(col: string): Set<string> {
    if (!parsed || !col) return new Set();
    const emails = new Set<string>();
    for (const row of parsed.rows) {
      const val = (row[col]?.trim() ?? "").toLowerCase();
      if (val && val.includes("@")) emails.add(val);
    }
    return emails;
  }

  function importData() {
    if (!parsed || !emailCol) return;
    setImporting(true);

    // Pre-build email sets for columns in "email" mode
    const bookedEmails = bookedMode === "email" && bookedCol ? buildEmailSet(bookedCol) : new Set<string>();
    const showedEmails = showedMode === "email" && showedCol ? buildEmailSet(showedCol) : new Set<string>();
    const closedEmails = closedMode === "email" && closedCol ? buildEmailSet(closedCol) : new Set<string>();

    const records: CallResultRecord[] = [];

    for (const row of parsed.rows) {
      const email = (row[emailCol]?.trim() ?? "").toLowerCase();
      if (!email) continue;

      const booking_date = bookingDateCol ? normalizeDate(row[bookingDateCol]?.trim() ?? "") : undefined;
      const close_date = closeDateCol ? normalizeDate(row[closeDateCol]?.trim() ?? "") : undefined;

      let booked = false;
      let showed = false;
      let closed = false;

      if (bookedCol) {
        booked = bookedMode === "email" ? bookedEmails.has(email) : matchesField(row[bookedCol]?.trim() ?? "", bookedMode, bookedValues);
      }
      if (showedCol) {
        showed = showedMode === "email" ? showedEmails.has(email) : matchesField(row[showedCol]?.trim() ?? "", showedMode, showedValues);
      }
      if (closedCol) {
        closed = closedMode === "email" ? closedEmails.has(email) : matchesField(row[closedCol]?.trim() ?? "", closedMode, closedValues);
      }

      // Enforce cascade: closed requires showed, showed requires booked
      if (closed) showed = true;
      if (showed) booked = true;

      if (email) {
        records.push({ email, booking_date, close_date, booked, showed, closed });
      }
    }

    // Create records for emails found in booked/showed/closed email columns
    // that weren't in the main email column
    const mainEmails = new Set(records.map(r => r.email.toLowerCase()));
    const extraEmailSources: { emails: Set<string>; booked: boolean; showed: boolean; closed: boolean }[] = [];
    if (closedEmails.size > 0) extraEmailSources.push({ emails: closedEmails, booked: true, showed: true, closed: true });
    if (showedEmails.size > 0) extraEmailSources.push({ emails: showedEmails, booked: true, showed: true, closed: false });
    if (bookedEmails.size > 0) extraEmailSources.push({ emails: bookedEmails, booked: true, showed: false, closed: false });

    for (const src of extraEmailSources) {
      for (const email of Array.from(src.emails)) {
        if (mainEmails.has(email)) continue;
        // Check if already added by a previous source
        const existing = records.find(r => r.email.toLowerCase() === email);
        if (existing) {
          // Promote statuses (never demote)
          if (src.booked) existing.booked = true;
          if (src.showed) existing.showed = true;
          if (src.closed) existing.closed = true;
        } else {
          records.push({ email, booked: src.booked, showed: src.showed, closed: src.closed });
          mainEmails.add(email);
        }
      }
    }

    // De-dupe within import (last row wins)
    const dedupedNew: CallResultRecord[] = [];
    const seenEmails = new Set<string>();
    for (let j = records.length - 1; j >= 0; j--) {
      const key = records[j].email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      dedupedNew.unshift(records[j]);
    }

    let mergedRecords: CallResultRecord[];
    if (importMode === "replace") {
      const newEmailSet = new Set(dedupedNew.map((r) => r.email.toLowerCase()));
      const kept = (app.call_results ?? []).filter((r) => !newEmailSet.has(r.email.toLowerCase()));
      mergedRecords = [...kept, ...dedupedNew];
    } else {
      // Append: only add new emails, fill in missing data for existing
      const existingByEmail = new Map<string, number>();
      const existingRecords = [...(app.call_results ?? [])];
      for (let i = 0; i < existingRecords.length; i++) {
        existingByEmail.set(existingRecords[i].email.toLowerCase(), i);
      }
      const toAdd: CallResultRecord[] = [];
      for (const newRec of dedupedNew) {
        const key = newRec.email.toLowerCase();
        if (existingByEmail.has(key)) {
          const idx = existingByEmail.get(key)!;
          const old = existingRecords[idx];
          existingRecords[idx] = {
            ...old,
            booking_date: old.booking_date || newRec.booking_date,
            booked: old.booked || newRec.booked,
            showed: old.showed || newRec.showed,
            closed: old.closed || newRec.closed,
          };
        } else {
          toAdd.push(newRec);
        }
      }
      mergedRecords = [...existingRecords, ...toAdd];
    }

    let updatedSubs = app.submissions ?? [];
    for (const rec of mergedRecords.filter((r) => seenEmails.has(r.email.toLowerCase()))) {
      updatedSubs = syncCallRecordToSub(updatedSubs, rec);
    }

    onSave({ ...app, call_results: mergedRecords, submissions: updatedSubs });
    setParsed(null);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function updateRecord(email: string, updates: Partial<CallResultRecord>) {
    // Normalize booking_date if updated
    if (updates.booking_date) {
      updates = { ...updates, booking_date: normalizeDate(updates.booking_date) };
    }
    const newRecords = (app.call_results ?? []).map((r) => {
      if (r.email.toLowerCase() !== email.toLowerCase()) return r;
      const merged = { ...r, ...updates };
      // Enforce cascade: closed requires showed, showed requires booked
      if (merged.closed) merged.showed = true;
      if (merged.showed) merged.booked = true;
      if (!merged.booked) { merged.showed = false; merged.closed = false; }
      if (!merged.showed) merged.closed = false;
      return merged;
    });
    const updatedRec = newRecords.find(
      (r) => r.email.toLowerCase() === (updates.email?.toLowerCase() ?? email.toLowerCase())
    );
    let updatedSubs = app.submissions ?? [];
    if (updatedRec) {
      updatedSubs = syncCallRecordToSub(updatedSubs, updatedRec, email);
    }
    onSave({ ...app, call_results: newRecords, submissions: updatedSubs });
  }

  function clearRecords() {
    if (!confirm(`Clear all ${app.call_results?.length ?? 0} call results?`)) return;
    onSave({ ...app, call_results: [] });
  }

  const records = app.call_results ?? [];
  const [searchQuery, setSearchQuery] = useState("");
  type CrFilter = "linked" | "unlinked" | "booked" | "showed" | "closed";
  const [crFilters, setCrFilters] = useState<Set<CrFilter>>(new Set());
  function toggleCrFilter(f: CrFilter) {
    setCrFilters(prev => {
      const next = new Set(prev);
      if (next.has(f)) { next.delete(f); } else {
        next.add(f);
        if (f === "linked") next.delete("unlinked");
        if (f === "unlinked") next.delete("linked");
        if (f === "booked" || f === "showed" || f === "closed") {
          for (const x of ["booked", "showed", "closed"] as CrFilter[]) { if (x !== f) next.delete(x); }
        }
      }
      return next;
    });
  }

  // Build name lookup from submissions
  const nameByEmail = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of (app.submissions ?? [])) {
      if (s.respondent_email && s.respondent_name) {
        map.set(s.respondent_email.toLowerCase(), s.respondent_name);
      }
    }
    return map;
  }, [app.submissions]);

  const filteredRecords = useMemo(() => {
    let list = records;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((r) => {
        const name = nameByEmail.get(r.email.toLowerCase()) ?? "";
        return r.email.toLowerCase().includes(q) || name.toLowerCase().includes(q);
      });
    }
    if (crFilters.size > 0) {
      list = list.filter((r) => {
        const emailKey = r.email.toLowerCase();
        const linkedSub = (app.submissions ?? []).find((s) => (s.respondent_email ?? "").toLowerCase() === emailKey);
        const isLinked = !!linkedSub;
        if (crFilters.has("linked") && !isLinked) return false;
        if (crFilters.has("unlinked") && isLinked) return false;
        if (crFilters.has("booked") && !r.booked) return false;
        if (crFilters.has("showed") && !r.showed) return false;
        if (crFilters.has("closed") && !r.closed) return false;
        return true;
      });
    }
    const subEmails = new Set((app.submissions ?? []).map(s => (s.respondent_email ?? "").toLowerCase()).filter(Boolean));
    return [...list].sort((a, b) => {
      const aLinked = subEmails.has(a.email.toLowerCase()) ? 0 : 1;
      const bLinked = subEmails.has(b.email.toLowerCase()) ? 0 : 1;
      if (aLinked !== bLinked) return aLinked - bLinked;
      // Both in same linked group - sort by booking_date descending, then email
      const aDate = a.booking_date ?? "";
      const bDate = b.booking_date ?? "";
      if (aDate && bDate) return bDate.localeCompare(aDate);
      if (aDate) return -1;
      if (bDate) return 1;
      return a.email.toLowerCase().localeCompare(b.email.toLowerCase());
    });
  }, [records, searchQuery, nameByEmail, crFilters, app.submissions]);

  const [showUpload, setShowUpload] = useState(false);

  function addBlankRecord() {
    const newRec: CallResultRecord = { email: "", booked: false, showed: false, closed: false };
    onSave({ ...app, call_results: [newRec, ...(app.call_results ?? [])] });
  }

  const [showAddCrModal, setShowAddCrModal] = useState(false);
  const [newCrFields, setNewCrFields] = useState<{ email: string; booking_date: string; close_date: string; booked: boolean; showed: boolean; closed: boolean }>({ email: "", booking_date: "", close_date: "", booked: false, showed: false, closed: false });

  function openAddCrModal() {
    setNewCrFields({ email: "", booking_date: "", close_date: "", booked: false, showed: false, closed: false });
    setShowAddCrModal(true);
  }

  function createCrFromModal() {
    const newRec: CallResultRecord = {
      email: newCrFields.email,
      booking_date: newCrFields.booking_date || undefined,
      close_date: newCrFields.close_date || undefined,
      booked: newCrFields.booked,
      showed: newCrFields.showed,
      closed: newCrFields.closed,
    };
    onSave({ ...app, call_results: [newRec, ...(app.call_results ?? [])] });
    setShowAddCrModal(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm font-semibold text-slate-400">Call Results</p>
          <span className="text-xs text-slate-300">{records.length} records</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowUpload(!showUpload)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
              showUpload ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Import
          </button>
          <button
            onClick={openAddCrModal}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-white/[0.08] text-slate-300 hover:bg-white/[0.04] hover:text-slate-300 transition-colors"
            title="Add record manually"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {/* File upload (hidden by default) */}
      {showUpload && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Upload CSV / XLSX</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFile}
            className="text-sm text-slate-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-500/10 file:text-indigo-400 hover:file:bg-indigo-500/20"
          />
        </div>
      )}

      {parsed && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-300">Configure Import</p>
              <p className="text-[11px] text-slate-300 mt-0.5">{parsed.rowCount} rows found · {parsed.headers.length} columns</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center bg-white/[0.06] rounded-lg p-0.5">
                <button onClick={() => setImportMode("append")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "append" ? "bg-white/[0.04] text-indigo-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Append</button>
                <button onClick={() => setImportMode("replace")} className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${importMode === "replace" ? "bg-white/[0.04] text-red-400 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}>Replace</button>
              </div>
              <button onClick={() => { setParsed(null); }} className="text-xs text-slate-300 hover:text-slate-300 font-semibold">Cancel</button>
              <button onClick={importData} disabled={importing || !emailCol} className="px-4 py-2 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors">
                {importing ? "Importing…" : `Import ${parsed.rowCount} rows`}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-slate-300 -mt-2">
            {importMode === "append"
              ? "Append: adds new records only. Existing records with matching emails will have missing fields filled in."
              : "Replace: overwrites existing records with matching emails. Non-matching records are kept."}
          </p>

          {/* Email column */}
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-300 mb-2">Email Column (Required)</p>
            <select value={emailCol} onChange={(e) => setEmailCol(e.target.value)} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${emailCol ? "border-indigo-500/30 text-slate-400 bg-indigo-500/10" : "border-white/[0.08] text-slate-300"}`}>
              <option value="">— Select column —</option>
              {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            {emailCol && colSamples[emailCol] && (
              <div className="mt-2 flex flex-wrap gap-1">
                {colSamples[emailCol].map((v) => <span key={v} className="text-[10px] text-slate-300">{v}</span>)}
              </div>
            )}
          </div>

          {/* Booking Date column */}
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-300 mb-2">Booking Date Column</p>
            <select value={bookingDateCol} onChange={(e) => setBookingDateCol(e.target.value)} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${bookingDateCol ? "border-indigo-500/30 text-slate-400 bg-indigo-500/10" : "border-white/[0.08] text-slate-300"}`}>
              <option value="">— None —</option>
              {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            {bookingDateCol && colSamples[bookingDateCol] && (
              <div className="mt-2 flex flex-wrap gap-1">
                {colSamples[bookingDateCol].map((v) => <span key={v} className="text-[10px] text-slate-300">{v}</span>)}
              </div>
            )}
          </div>

          {/* Close Date column */}
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-300 mb-2">Close Date Column</p>
            <select value={closeDateCol} onChange={(e) => setCloseDateCol(e.target.value)} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${closeDateCol ? "border-indigo-500/30 text-slate-400 bg-indigo-500/10" : "border-white/[0.08] text-slate-300"}`}>
              <option value="">— None —</option>
              {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            {closeDateCol && colSamples[closeDateCol] && (
              <div className="mt-2 flex flex-wrap gap-1">
                {colSamples[closeDateCol].map((v) => <span key={v} className="text-[10px] text-slate-300">{v}</span>)}
              </div>
            )}
          </div>

          {/* Booked / Showed / Closed columns */}
          {([
            { label: "Booked", col: bookedCol, setCol: setBookedCol, mode: bookedMode, setMode: setBookedMode, values: bookedValues, setValues: setBookedValues },
            { label: "Showed", col: showedCol, setCol: setShowedCol, mode: showedMode, setMode: setShowedMode, values: showedValues, setValues: setShowedValues },
            { label: "Closed", col: closedCol, setCol: setClosedCol, mode: closedMode, setMode: setClosedMode, values: closedValues, setValues: setClosedValues },
          ] as const).map(({ label, col, setCol, mode, setMode, values, setValues }) => (
            <div key={label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-300 mb-2">{label} Column</p>
              <select value={col} onChange={(e) => { setCol(e.target.value); setValues(new Set()); }} className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 ${col ? "border-indigo-500/30 text-slate-400 bg-indigo-500/10" : "border-white/[0.08] text-slate-300"}`}>
                <option value="">— None —</option>
                {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>

              {col && colSamples[col] && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {colSamples[col].map((v) => <span key={v} className="text-[10px] text-slate-300">{v}</span>)}
                </div>
              )}

              {col && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-4 flex-wrap">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" checked={mode === "specific"} onChange={() => setMode("specific")} className="accent-indigo-600" />
                      <span className="text-xs text-slate-300">Match specific values</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" checked={mode === "any"} onChange={() => setMode("any")} className="accent-indigo-600" />
                      <span className="text-xs text-slate-300">Any non-empty value = {label}</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" checked={mode === "email"} onChange={() => setMode("email")} className="accent-indigo-600" />
                      <span className="text-xs text-slate-300">Column contains emails</span>
                    </label>
                  </div>

                  {mode === "email" && (
                    <p className="text-[11px] text-slate-300">
                      Emails found in this column will be marked as &ldquo;{label}&rdquo;.
                      {label === "Closed" && " They will also be auto-marked as Showed and Booked."}
                      {label === "Showed" && " They will also be auto-marked as Booked."}
                    </p>
                  )}

                  {mode === "specific" && colUniqueValues[col] && (
                    <div>
                      <p className="text-[11px] text-slate-300 mb-2">Select values that mean &ldquo;{label}&rdquo;:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {colUniqueValues[col].map((v) => (
                          <button
                            key={v}
                            onClick={() => toggleValue(values, v, setValues)}
                            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                              values.has(v)
                                ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400 font-semibold"
                                : "border-white/[0.08] text-slate-300 hover:border-white/[0.15] hover:bg-white/[0.04]"
                            }`}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {records.length > 0 && !parsed && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by email or name…"
                className="w-full border border-white/[0.08] rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent bg-white/[0.04] placeholder:text-slate-400"
              />
              {(searchQuery || crFilters.size > 0) && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-300">{filteredRecords.length} of {records.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(["linked", "unlinked", "booked", "showed", "closed"] as CrFilter[]).map((f) => (
                <button key={f} onClick={() => toggleCrFilter(f)}
                  className={`px-2 py-1 text-[10px] font-semibold rounded-md border transition-colors capitalize ${
                    crFilters.has(f) ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:text-slate-300 hover:border-white/[0.15]"
                  }`}
                >{f}</button>
              ))}
            </div>
          </div>
          {filteredRecords.map((r, i) => {
            const linkedSub = (app.submissions ?? []).find(
              (s) => (s.respondent_email ?? "").toLowerCase() === r.email.toLowerCase()
            );
            const displayName = nameByEmail.get(r.email.toLowerCase());
            return (
              <details key={i} className="border border-white/[0.08] rounded-lg bg-white/[0.04]">
                <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center gap-2 hover:bg-white/[0.02] transition-colors rounded-t-lg">
                  <span className="text-xs text-slate-300 truncate flex-1">
                    {displayName ? <>{displayName} <span className="text-slate-300 font-normal">— {r.email}</span></> : r.email || "(no email)"}
                  </span>
                  {linkedSub && (
                    <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-1.5 py-0.5 font-semibold shrink-0">linked</span>
                  )}
                  {r.booking_date && (
                    <span className="text-[10px] bg-white/[0.06] text-slate-300 rounded px-1.5 py-0.5 shrink-0">{r.booking_date}</span>
                  )}
                  {r.booked && <span className="text-[10px] font-semibold bg-indigo-500/10 text-indigo-400 rounded-full px-1.5 py-0.5 shrink-0">booked</span>}
                  {r.showed && <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 rounded-full px-1.5 py-0.5 shrink-0">showed</span>}
                  {r.closed && <span className="text-[10px] font-semibold bg-green-500/10 text-green-400 rounded-full px-1.5 py-0.5 shrink-0">closed</span>}
                  {r.close_date && (
                    <span className="text-[10px] bg-white/[0.06] text-slate-300 rounded px-1.5 py-0.5 shrink-0">closed {r.close_date}</span>
                  )}
                </summary>
                <div className="border-t border-white/[0.06] p-3 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Email</label>
                      <input
                        defaultValue={r.email}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val && val !== r.email) updateRecord(r.email, { email: val });
                        }}
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white/[0.04]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Booking Date</label>
                      <input
                        defaultValue={r.booking_date ?? ""}
                        onBlur={(e) => updateRecord(r.email, { booking_date: e.target.value || undefined })}
                        placeholder="YYYY-MM-DD"
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white/[0.04]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Close Date</label>
                      <input
                        defaultValue={r.close_date ?? ""}
                        onBlur={(e) => updateRecord(r.email, { close_date: e.target.value || undefined })}
                        placeholder="YYYY-MM-DD"
                        className="w-full rounded border border-white/[0.08] px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white/[0.04]"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Booked</label>
                      <label className="flex items-center gap-1.5 pt-1">
                        <input
                          type="checkbox"
                          checked={r.booked}
                          onChange={(e) => {
                            const booked = e.target.checked;
                            updateRecord(r.email, booked ? { booked } : { booked: false, showed: false, closed: false });
                          }}
                          className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20"
                        />
                        <span className="text-xs text-slate-300">Yes</span>
                      </label>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Showed</label>
                      <label className="flex items-center gap-1.5 pt-1">
                        <input
                          type="checkbox"
                          checked={r.showed}
                          disabled={!r.booked}
                          onChange={(e) => {
                            const showed = e.target.checked;
                            updateRecord(r.email, showed ? { showed, booked: true } : { showed: false, closed: false });
                          }}
                          className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20 disabled:opacity-30"
                        />
                        <span className={`text-xs ${r.booked ? "text-slate-300" : "text-slate-400"}`}>Yes</span>
                      </label>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">Closed</label>
                      <label className="flex items-center gap-1.5 pt-1">
                        <input
                          type="checkbox"
                          checked={r.closed}
                          disabled={!r.showed}
                          onChange={(e) => {
                            const closed = e.target.checked;
                            updateRecord(r.email, closed ? { closed, showed: true, booked: true } : { closed: false });
                          }}
                          className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20 disabled:opacity-30"
                        />
                        <span className={`text-xs ${r.showed ? "text-slate-300" : "text-slate-400"}`}>Yes</span>
                      </label>
                    </div>
                  </div>
                  {linkedSub && (
                    <p className="text-[10px] text-emerald-400 mt-3">
                      ✓ Synced to submission for <span className="font-semibold">{linkedSub.respondent_email}</span>
                    </p>
                  )}
                  <div className="pt-3 mt-3 border-t border-white/[0.06] flex justify-end">
                    <button
                      onClick={() => {
                        if (!confirm(`Delete call result for ${r.email}?`)) return;
                        onSave({ ...app, call_results: (app.call_results ?? []).filter((_, idx) => idx !== i) });
                      }}
                      className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors"
                    >Delete record</button>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Clear All — muted, at bottom */}
      {records.length > 0 && !parsed && (
        <button onClick={clearRecords} className="text-[11px] text-slate-300 hover:text-red-400 font-medium transition-colors">
          Clear all call results
        </button>
      )}

      {/* Add Call Result Modal */}
      {showAddCrModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] flex items-center justify-center p-4" onClick={() => setShowAddCrModal(false)}>
          <div className="bg-slate-900 border border-white/[0.08] rounded-xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-200">New Call Result</h3>
              <button onClick={() => setShowAddCrModal(false)} className="text-slate-400 hover:text-slate-300 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">Email</label>
                <input
                  value={newCrFields.email}
                  onChange={(e) => setNewCrFields((p) => ({ ...p, email: e.target.value }))}
                  placeholder="email@example.com"
                  className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Booking Date</label>
                  <input
                    value={newCrFields.booking_date}
                    onChange={(e) => setNewCrFields((p) => ({ ...p, booking_date: e.target.value }))}
                    placeholder="YYYY-MM-DD"
                    className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">Close Date</label>
                  <input
                    value={newCrFields.close_date}
                    onChange={(e) => setNewCrFields((p) => ({ ...p, close_date: e.target.value }))}
                    placeholder="YYYY-MM-DD"
                    className="w-full rounded border border-white/[0.08] px-2.5 py-1.5 text-xs text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-1 focus:ring-indigo-400 placeholder:text-slate-400"
                  />
                </div>
              </div>
              <div className="flex items-center gap-6 pt-1">
                <label className="flex items-center gap-1.5 text-xs text-slate-300">
                  <input type="checkbox" checked={newCrFields.booked} onChange={(e) => setNewCrFields((p) => ({ ...p, booked: e.target.checked, showed: e.target.checked ? p.showed : false, closed: e.target.checked ? p.closed : false }))} className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20" />
                  Booked
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-300">
                  <input type="checkbox" checked={newCrFields.showed} disabled={!newCrFields.booked} onChange={(e) => setNewCrFields((p) => ({ ...p, showed: e.target.checked, booked: e.target.checked ? true : p.booked, closed: e.target.checked ? p.closed : false }))} className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20 disabled:opacity-30" />
                  Showed
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-300">
                  <input type="checkbox" checked={newCrFields.closed} disabled={!newCrFields.showed} onChange={(e) => setNewCrFields((p) => ({ ...p, closed: e.target.checked, showed: e.target.checked ? true : p.showed, booked: e.target.checked ? true : p.booked }))} className="w-4 h-4 rounded bg-white/[0.05] border border-white/[0.15] accent-indigo-500 shadow-sm shadow-black/20 disabled:opacity-30" />
                  Closed
                </label>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-white/[0.06] flex justify-end gap-2">
              <button onClick={() => setShowAddCrModal(false)} className="px-3 py-1.5 text-[11px] font-semibold text-slate-300 hover:text-slate-300 transition-colors">Cancel</button>
              <button
                onClick={createCrFromModal}
                disabled={!newCrFields.email.trim()}
                className="px-4 py-1.5 bg-indigo-500 text-white text-[11px] font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
              >Create Record</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Webhooks Tab ──────────────────────────────────────────────────────────────

// All mapping targets for the webhook field mapping dropdown
const WEBHOOK_MAPPING_TARGETS = [
  { value: "skip", label: "— Skip —" },
  { value: "email", label: "Email" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "full_name", label: "Full Name" },
  { value: "phone", label: "Phone" },
  { value: "submission_id", label: "Submission ID" },
  { value: "submitted_at", label: "Submitted At" },
  { value: "booking_date", label: "Booking Date" },
  { value: "close_date", label: "Close Date" },
  { value: "booking.booked", label: "Booked (Yes/No)" },
  { value: "booking.showed", label: "Showed (Yes/No)" },
  { value: "booking.closed", label: "Closed (Yes/No)" },
  { value: "grade.final", label: "Final Grade" },
  { value: "grade.answer", label: "Answer Grade" },
  { value: "grade.financial", label: "Financial Grade" },
  { value: "grade.disqualified", label: "Was Disqualified" },
  { value: "grade.spam", label: "Was Spam" },
  { value: "grade.details", label: "Grade Details" },
  { value: "financial.credit_score", label: "Credit Score" },
  { value: "financial.estimated_income", label: "Estimated Income" },
  { value: "financial.available_credit", label: "Available Credit" },
  { value: "financial.available_funding", label: "Available Funding" },
  { value: "financial.grade", label: "Financial Grade (Record)" },
];

function WebhooksTab({
  app,
  onSave,
  clientId,
}: {
  app: Application;
  onSave: (a: Application) => void;
  clientId: string;
}) {
  const config = app.webhook_config;
  const pending = (app.pending_webhook_submissions ?? []).filter(p => p.status === "pending");
  const [creating, setCreating] = useState(false);
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingEdits, setMappingEdits] = useState<WebhookFieldMapping[]>(config?.field_mapping ?? []);
  const [processingPendingId, setProcessingPendingId] = useState<string | null>(null);
  const [showCalcForm, setShowCalcForm] = useState(false);
  const [newCalcName, setNewCalcName] = useState("");
  const [newCalcType, setNewCalcType] = useState<"date_diff_days" | "math">("date_diff_days");
  const [newCalcExpr, setNewCalcExpr] = useState("");
  const [newCalcTarget, setNewCalcTarget] = useState("");

  // Sync mapping edits when config changes
  useEffect(() => {
    setMappingEdits(config?.field_mapping ?? []);
  }, [config?.field_mapping]);

  const webhookUrl = config?.token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/api/webhook/${config.token}`
    : "";

  async function createWebhook(source: "typeform" | "generic") {
    setCreating(true);
    try {
      const token = crypto.randomUUID();
      const newConfig: WebhookConfig = {
        enabled: true,
        token,
        source,
        field_mapping: [],
        created_at: new Date().toISOString(),
      };
      const updated = { ...app, webhook_config: newConfig };
      onSave(updated);
    } finally {
      setCreating(false);
    }
  }

  async function toggleWebhook() {
    if (!config) return;
    const updated = {
      ...app,
      webhook_config: { ...config, enabled: !config.enabled },
    };
    onSave(updated);
  }

  async function deleteWebhook() {
    const updated = { ...app };
    delete updated.webhook_config;
    updated.pending_webhook_submissions = [];
    onSave(updated);
  }

  function updateMappingTarget(sourceField: string, target: string) {
    if (target === "__create_new__") {
      const title = window.prompt("Enter new question title:", sourceField);
      if (!title?.trim()) return;
      const trimmed = title.trim();
      // Create the question on the app if it doesn't exist
      const exists = app.questions.some(q => q.title.toLowerCase() === trimmed.toLowerCase());
      if (!exists) {
        const newQ: ApplicationQuestion = {
          id: uid(),
          title: trimmed,
          type: "short_text",
          required: false,
          order: app.questions.length,
        };
        onSave({ ...app, questions: [...app.questions, newQ] });
      }
      // Set the mapping target to this question
      setMappingEdits(prev =>
        prev.map(m => m.source_field === sourceField ? { ...m, target: `answer:${trimmed}` } : m)
      );
      return;
    }
    setMappingEdits(prev =>
      prev.map(m => m.source_field === sourceField ? { ...m, target } : m)
    );
  }

  async function saveMapping() {
    if (!config) return;
    setSavingMapping(true);
    try {
      const updated = {
        ...app,
        webhook_config: { ...config, field_mapping: mappingEdits },
      };
      onSave(updated);
    } finally {
      setSavingMapping(false);
    }
  }

  function autoDetectMappings() {
    const questionTitles = app.questions.map(q => q.title);
    setMappingEdits(prev =>
      prev.map(m => ({
        ...m,
        target: autoDetectTarget(m.source_field, questionTitles),
      }))
    );
  }

  async function acceptPending(pendingItem: PendingWebhookSubmission) {
    setProcessingPendingId(pendingItem.id);
    try {
      const questionTitles = app.questions.map(q => q.title);

      // Helper: flatten a pending item's payload
      const flattenPendingItem = (item: PendingWebhookSubmission): {
        flat: Record<string, string>;
        submittedAt?: string;
      } => {
        if (config?.source === "typeform") {
          const parsed = parseTypeformPayload(item.raw_payload);
          if (parsed) return { flat: parsed.fields, submittedAt: parsed.meta.submitted_at };
        }
        return { flat: flattenPayload(item.raw_payload) };
      };

      // Step 1: Build mapping from the clicked item (adds any new fields)
      const { flat: clickedFlat, submittedAt: clickedSubmittedAt } = flattenPendingItem(pendingItem);
      const existingSourceFields = new Set(mappingEdits.map(m => m.source_field));
      const newMappings = [...mappingEdits];
      for (const key of Object.keys(clickedFlat)) {
        if (!existingSourceFields.has(key)) {
          newMappings.push({
            source_field: key,
            target: autoDetectTarget(key, questionTitles),
          });
        }
      }

      // Step 2: Process the clicked item
      const mappedData = applyFieldMapping(clickedFlat, newMappings, config?.calculated_fields);
      if (clickedSubmittedAt && !mappedData.submitted_at) {
        mappedData.submitted_at = clickedSubmittedAt;
      }
      let updated = mergeWebhookData(app, mappedData);

      // Step 3: Build set of all mapped source fields
      const mappedSourceFields = new Set(newMappings.map(m => m.source_field));

      // Step 4: Auto-process all other pending items whose fields are covered by the mapping
      const processedIds = new Set([pendingItem.id]);
      const remainingPending: PendingWebhookSubmission[] = [];
      const allPending = updated.pending_webhook_submissions ?? [];

      for (const p of allPending) {
        if (p.id === pendingItem.id || p.status !== "pending") continue;
        const { flat, submittedAt } = flattenPendingItem(p);
        const fields = Object.keys(flat);
        const allFieldsMapped = fields.every(f => mappedSourceFields.has(f));

        if (allFieldsMapped) {
          // Process this pending item too
          const mapped = applyFieldMapping(flat, newMappings, config?.calculated_fields);
          if (submittedAt && !mapped.submitted_at) {
            mapped.submitted_at = submittedAt;
          }
          updated = mergeWebhookData(updated, mapped);
          processedIds.add(p.id);
        } else {
          remainingPending.push(p);
        }
      }

      // Step 5: Update signature cumulatively
      const knownFields = new Set(
        config?.last_field_signature ? config.last_field_signature.split("|") : []
      );
      Array.from(mappedSourceFields).forEach(f => knownFields.add(f));
      const cumulativeSignature = computeFieldSignature(Array.from(knownFields));

      updated = {
        ...updated,
        webhook_config: config
          ? { ...config, field_mapping: newMappings, last_field_signature: cumulativeSignature }
          : undefined,
        pending_webhook_submissions: remainingPending,
      };
      setMappingEdits(newMappings);
      onSave(updated);
    } finally {
      setProcessingPendingId(null);
    }
  }

  function rejectPending(pendingId: string) {
    const updatedPending = (app.pending_webhook_submissions ?? []).filter(
      p => p.id !== pendingId
    );
    const updated = { ...app, pending_webhook_submissions: updatedPending };
    onSave(updated);
  }

  function addCalculatedField() {
    if (!newCalcName || !newCalcExpr || !newCalcTarget || !config) return;
    const newField: CalculatedField = {
      id: uid(),
      name: newCalcName,
      type: newCalcType,
      expression: newCalcExpr,
      source_fields: newCalcExpr.split(/[+\-*/]/).map(s => s.trim()).filter(Boolean),
      target: newCalcTarget,
    };
    const updated = {
      ...app,
      webhook_config: {
        ...config,
        calculated_fields: [...(config.calculated_fields ?? []), newField],
      },
    };
    onSave(updated);
    setNewCalcName("");
    setNewCalcExpr("");
    setNewCalcTarget("");
    setShowCalcForm(false);
  }

  function removeCalculatedField(id: string) {
    if (!config) return;
    const updated = {
      ...app,
      webhook_config: {
        ...config,
        calculated_fields: (config.calculated_fields ?? []).filter(f => f.id !== id),
      },
    };
    onSave(updated);
  }

  // Build answer targets from existing questions
  const answerTargets = app.questions.map(q => ({
    value: `answer:${q.title}`,
    label: `Answer: ${q.title}`,
  }));
  const allTargets = [...WEBHOOK_MAPPING_TARGETS, ...answerTargets];

  // ── No webhook configured ─────────────────────────────────────────────
  if (!config) {
    return (
      <div className="space-y-6">
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-8 text-center">
          <div className="text-3xl mb-3">🔗</div>
          <h3 className="text-base font-semibold text-slate-200 mb-2">Set Up a Webhook</h3>
          <p className="text-sm text-slate-400 mb-6 max-w-md mx-auto">
            Receive data automatically from Typeform, Zapier, or any tool that can send webhooks.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => createWebhook("typeform")}
              disabled={creating}
              className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
            >
              Connect Typeform
            </button>
            <button
              onClick={() => createWebhook("generic")}
              disabled={creating}
              className="px-5 py-2.5 text-sm font-semibold rounded-lg border border-white/[0.15] text-slate-200 hover:bg-white/[0.05] transition-colors disabled:opacity-50"
            >
              Generic / Zapier Webhook
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Webhook configured ────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Section A: Status Card */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${config.enabled ? "bg-emerald-400" : "bg-slate-500"}`} />
            <h3 className="text-sm font-semibold text-slate-200">
              {config.source === "typeform" ? "Typeform" : "Generic"} Webhook
            </h3>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-white/[0.08] text-slate-300 uppercase">
              {config.source}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleWebhook}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                config.enabled
                  ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                  : "border-white/[0.1] text-slate-400 hover:bg-white/[0.05]"
              }`}
            >
              {config.enabled ? "Enabled" : "Disabled"}
            </button>
            <button
              onClick={deleteWebhook}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>

        <div className="bg-black/30 rounded-lg p-3 mb-3">
          <div className="flex items-center gap-2">
            <code className="text-xs text-slate-300 flex-1 break-all select-all">{webhookUrl}</code>
            <button
              onClick={() => navigator.clipboard.writeText(webhookUrl)}
              className="px-2 py-1 text-[10px] font-semibold rounded bg-white/[0.08] text-slate-300 hover:bg-white/[0.12] transition-colors flex-shrink-0"
            >
              Copy
            </button>
          </div>
        </div>

        <div className="flex gap-4 text-xs text-slate-400">
          {config.last_received_at && (
            <span>Last received: {new Date(config.last_received_at).toLocaleString()}</span>
          )}
          <span>Created: {new Date(config.created_at).toLocaleString()}</span>
          <span>Mappings: {config.field_mapping.length}</span>
        </div>
      </div>

      {/* Section B: Field Mapping */}
      {mappingEdits.length > 0 && (
        <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-200">Field Mapping</h3>
            <div className="flex gap-2">
              <button
                onClick={autoDetectMappings}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-white/[0.1] text-slate-300 hover:bg-white/[0.05] transition-colors"
              >
                Auto-Detect
              </button>
              <button
                onClick={saveMapping}
                disabled={savingMapping}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
              >
                {savingMapping ? "Saving..." : "Save Mapping"}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="grid grid-cols-[1fr,24px,1fr] gap-2 px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase">
              <span>Source Field</span>
              <span />
              <span>Target</span>
            </div>
            {mappingEdits.map((m) => (
              <div key={m.source_field} className="grid grid-cols-[1fr,24px,1fr] gap-2 items-center px-3 py-2 bg-white/[0.02] rounded-lg">
                <span className="text-xs text-slate-300 truncate" title={m.source_field}>{m.source_field}</span>
                <span className="text-xs text-slate-500 text-center">→</span>
                <select
                  value={m.target}
                  onChange={(e) => updateMappingTarget(m.source_field, e.target.value)}
                  className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
                >
                  {allTargets.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                  <option disabled>──────────</option>
                  <option value="__create_new__">+ Create New Question</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section C: Pending Submissions */}
      {pending.length > 0 && (
        <div className="bg-white/[0.03] border border-amber-500/20 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-amber-400 mb-4">
            Pending Submissions ({pending.length})
          </h3>
          <div className="space-y-3">
            {pending.map((p) => (
              <div key={p.id} className="bg-black/20 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <span className="text-xs text-slate-400">
                      {new Date(p.received_at).toLocaleString()}
                    </span>
                    {p.reason && (
                      <p className="text-xs text-amber-400/80 mt-1">{p.reason}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => acceptPending(p)}
                      disabled={processingPendingId === p.id}
                      className="px-3 py-1 text-xs font-semibold rounded-lg bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 transition-colors disabled:opacity-50"
                    >
                      {processingPendingId === p.id ? "Processing..." : "Accept & Map"}
                    </button>
                    <button
                      onClick={() => rejectPending(p.id)}
                      className="px-3 py-1 text-xs font-semibold rounded-lg bg-red-600/10 text-red-400 border border-red-500/30 hover:bg-red-600/20 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                <pre className="text-[10px] text-slate-400 bg-black/30 rounded p-2 max-h-32 overflow-auto">
                  {JSON.stringify(p.raw_payload, null, 2).slice(0, 1000)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section D: Calculated Fields */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-200">Calculated Fields</h3>
          <button
            onClick={() => setShowCalcForm(!showCalcForm)}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-white/[0.1] text-slate-300 hover:bg-white/[0.05] transition-colors"
          >
            {showCalcForm ? "Cancel" : "+ Add"}
          </button>
        </div>

        {showCalcForm && (
          <div className="bg-black/20 rounded-lg p-4 mb-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-1">Name</label>
                <input
                  value={newCalcName}
                  onChange={(e) => setNewCalcName(e.target.value)}
                  placeholder="e.g., Days to Close"
                  className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-1">Type</label>
                <select
                  value={newCalcType}
                  onChange={(e) => setNewCalcType(e.target.value as "date_diff_days" | "math")}
                  className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
                >
                  <option value="date_diff_days">Date Difference (Days)</option>
                  <option value="math">Math Expression</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-1">
                Expression {newCalcType === "date_diff_days" ? "(field1 - field2)" : "(field1 + field2 * 0.5)"}
              </label>
              <input
                value={newCalcExpr}
                onChange={(e) => setNewCalcExpr(e.target.value)}
                placeholder={newCalcType === "date_diff_days" ? "close_date - booking_date" : "field1 + field2"}
                className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase mb-1">Store As</label>
              <input
                value={newCalcTarget}
                onChange={(e) => setNewCalcTarget(e.target.value)}
                placeholder="answer:Days to Close"
                className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
              />
            </div>
            <button
              onClick={addCalculatedField}
              disabled={!newCalcName || !newCalcExpr || !newCalcTarget}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
            >
              Add Calculated Field
            </button>
          </div>
        )}

        {(config.calculated_fields ?? []).length > 0 ? (
          <div className="space-y-2">
            {(config.calculated_fields ?? []).map((f) => (
              <div key={f.id} className="flex items-center justify-between bg-white/[0.02] rounded-lg px-3 py-2">
                <div>
                  <span className="text-xs font-semibold text-slate-200">{f.name}</span>
                  <span className="ml-2 text-[10px] text-slate-400">
                    {f.type === "date_diff_days" ? "📅" : "🔢"} {f.expression} → {f.target}
                  </span>
                </div>
                <button
                  onClick={() => removeCalculatedField(f.id)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">No calculated fields yet. Add one to compute derived values from webhook data.</p>
        )}
      </div>
    </div>
  );
}

// Correlation Analysis Tab
// ─────────────────────────────────────────────────────────────────────────────

function CorrelationTab({ app, onSave, clientName, clientId }: { app: Application; onSave: (a: Application) => void; clientName: string; clientId: string }) {
  const submissions = app.submissions ?? [];
  const financialRecords = app.financial_records ?? [];
  const callResults = app.call_results ?? [];
  const bookings = app.bookings ?? [];

  const [hiddenQuestions, setHiddenQuestions] = useState<Set<string>>(new Set(app.hidden_correlation_questions ?? []));
  useEffect(() => { setHiddenQuestions(new Set(app.hidden_correlation_questions ?? [])); }, [app.hidden_correlation_questions]);
  const [showHiddenManager, setShowHiddenManager] = useState(false);
  const [showRawCounts, setShowRawCounts] = useState(false);
  const [drillDown, setDrillDown] = useState<
    | { type: "answer"; questionTitle: string; answer: string }
    | { type: "emails"; label: string; emails: string[] }
    | null
  >(null);
  const [viewMode, setViewMode] = useState<"modern" | "classic">("modern");
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const correlationRef = useRef<HTMLDivElement>(null);
  const [expandedFinSections, setExpandedFinSections] = useState<Set<string>>(new Set());
  function toggleFinSection(key: string) {
    setExpandedFinSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const [granularSections, setGranularSections] = useState<Set<string>>(new Set());
  function toggleGranular(key: string) {
    setGranularSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Filter state
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const [dateRangeField, setDateRangeField] = useState<"submitted_at" | "booking_date">("submitted_at");
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [showInsights, setShowInsights] = useState(false);

  // Narrative analysis state
  const [narrativeGenerating, setNarrativeGenerating] = useState(false);
  const [narrativeError, setNarrativeError] = useState<string | null>(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [narrativeCollapsed, setNarrativeCollapsed] = useState(true);

  // ── Data Chat state ─────────────────────────────────────────────────────
  const [dataChatOpen, setDataChatOpen] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(app.data_chats?.[0]?.id ?? null);
  const [dataChatInput, setDataChatInput] = useState("");
  const [dataChatLoading, setDataChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const dataChats = app.data_chats ?? [];
  const activeChat = dataChats.find(c => c.id === activeChatId) ?? null;

  function buildDataContext(): string {
    const parts: string[] = [];
    // Include generated reports
    if (app.narrative_analysis) parts.push(`=== LEAD ANALYSIS (generated ${app.narrative_generated_at ?? "unknown"}) ===\n${app.narrative_analysis}`);
    if (app.audit_analysis) parts.push(`=== APPLICATION AUDIT (generated ${app.audit_generated_at ?? "unknown"}) ===\n${app.audit_analysis}`);
    if (app.grading_audit_analysis) parts.push(`=== GRADING AUDIT (generated ${app.grading_audit_generated_at ?? "unknown"}) ===\n${app.grading_audit_analysis}`);
    // Data summary
    const subs = app.submissions ?? [];
    const bks = app.bookings ?? [];
    const fins = app.financial_records ?? [];
    const bkMap = new Map(bks.map(b => [b.email.toLowerCase(), b]));
    const bookedN = subs.filter(s => s.respondent_email && bkMap.has(s.respondent_email.toLowerCase())).length;
    const showedN = subs.filter(s => { const b = s.respondent_email ? bkMap.get(s.respondent_email.toLowerCase()) : undefined; return b?.showed; }).length;
    const closedN = subs.filter(s => { const b = s.respondent_email ? bkMap.get(s.respondent_email.toLowerCase()) : undefined; return b?.closed; }).length;
    parts.push(`=== DATA SUMMARY ===
Total submissions: ${subs.length}
Booked: ${bookedN} (${subs.length ? Math.round(bookedN / subs.length * 100) : 0}%)
Showed: ${showedN} (${bookedN ? Math.round(showedN / bookedN * 100) : 0}% of booked)
Closed: ${closedN} (${showedN ? Math.round(closedN / showedN * 100) : 0}% of showed)
Financial records: ${fins.length}
Booking records: ${bks.length}
Questions: ${(app.questions ?? []).length}`);
    // Question breakdown
    if (app.questions?.length) {
      parts.push("=== QUESTIONS ===\n" + app.questions.map(q => `• ${q.title} (${q.type})`).join("\n"));
    }
    return parts.join("\n\n");
  }

  function createNewChat() {
    const id = crypto.randomUUID();
    const newChat: DataChat = { id, title: "New Chat", messages: [], created_at: new Date().toISOString() };
    const updated = [...dataChats, newChat];
    onSave({ ...app, data_chats: updated });
    setActiveChatId(id);
    setDataChatInput("");
  }

  function deleteChat(chatId: string) {
    const updated = dataChats.filter(c => c.id !== chatId);
    onSave({ ...app, data_chats: updated.length > 0 ? updated : undefined });
    if (activeChatId === chatId) setActiveChatId(updated[0]?.id ?? null);
  }

  async function sendDataChat() {
    const input = dataChatInput.trim();
    if (!input || dataChatLoading || !activeChat) return;
    const apiKey = typeof window !== "undefined" ? localStorage.getItem("anthropic_api_key") ?? "" : "";
    const userMsg: ChatMessage = { role: "user", content: input };
    const updatedMessages = [...activeChat.messages, userMsg];
    // Optimistically update
    const updatedChats = dataChats.map(c => c.id === activeChatId ? { ...c, messages: updatedMessages } : c);
    onSave({ ...app, data_chats: updatedChats });
    setDataChatInput("");
    setDataChatLoading(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, context: "data", messages: updatedMessages, systemContext: buildDataContext() }),
      });
      const data = await res.json();
      if (data.success) {
        const withReply: ChatMessage[] = [...updatedMessages, { role: "assistant", content: data.reply }];
        // Auto-title on first exchange
        const isFirstExchange = activeChat.messages.length === 0;
        const title = isFirstExchange ? input.slice(0, 60) + (input.length > 60 ? "…" : "") : activeChat.title;
        const finalChats = dataChats.map(c => c.id === activeChatId ? { ...c, messages: withReply, title } : c);
        onSave({ ...app, data_chats: finalChats });
      }
    } catch { /* ignore */ }
    finally { setDataChatLoading(false); }
  }

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, [activeChat?.messages.length, dataChatLoading]);

  async function generateNarrative() {
    const apiKey = typeof window !== "undefined" ? localStorage.getItem("anthropic_api_key") : null;
    if (!apiKey) {
      setNarrativeError("No API key found. Add your Anthropic API key in Settings on the home page.");
      return;
    }
    setNarrativeGenerating(true);
    setNarrativeError(null);
    setShowRegenConfirm(false);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-narrative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (data.success) {
        onSave({ ...app, narrative_analysis: data.narrative, narrative_generated_at: data.generated_at });
      } else {
        setNarrativeError(data.error || "Failed to generate analysis.");
      }
    } catch (err) {
      setNarrativeError(err instanceof Error ? err.message : "Network error");
    } finally {
      setNarrativeGenerating(false);
    }
  }

  const activeFilterCount = filterConditions.length + (dateRange ? 1 : 0);
  function clearAllFilters() { setDateRange(null); setFilterConditions([]); }

  function toggleHideQuestion(title: string) {
    const next = new Set(hiddenQuestions);
    if (next.has(title)) next.delete(title); else next.add(title);
    setHiddenQuestions(next);
    onSave({ ...app, hidden_correlation_questions: Array.from(next) });
  }

  function unhideQuestion(title: string) {
    const next = new Set(hiddenQuestions);
    next.delete(title);
    setHiddenQuestions(next);
    onSave({ ...app, hidden_correlation_questions: Array.from(next) });
  }

  const [dragState, setDragState] = useState<{ questionTitle: string; dragIdx: number; overIdx: number } | null>(null);

  function handleDragReorder(questionTitle: string, stats: { answer: string }[], fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    const order = stats.map((s) => s.answer);
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, moved);
    const updated = { ...(app.correlation_answer_order ?? {}), [questionTitle]: order };
    onSave({ ...app, correlation_answer_order: updated });
  }

  function getOrderedStats(qc: { questionTitle: string; stats: { answer: string; count: number; bookedCount: number; showedCount: number; closedCount: number; grades: number[]; emails: string[]; bookedEmails: string[]; showedEmails: string[]; closedEmails: string[] }[] }) {
    const customOrder = app.correlation_answer_order?.[qc.questionTitle];
    if (!customOrder || customOrder.length === 0) return qc.stats;
    const orderMap = new Map(customOrder.map((a, i) => [a, i]));
    return [...qc.stats].sort((a, b) => {
      const ai = orderMap.get(a.answer) ?? 999;
      const bi = orderMap.get(b.answer) ?? 999;
      if (ai !== 999 || bi !== 999) return ai - bi;
      return b.count - a.count;
    });
  }

  // Dedup submissions by email (keep latest)
  const dedupedSubmissions = useMemo(() => {
    const byEmail = new Map<string, typeof submissions[0]>();
    for (const s of submissions) {
      if (!s.respondent_email) continue;
      const email = s.respondent_email.toLowerCase();
      const existing = byEmail.get(email);
      if (!existing || new Date(s.submitted_at) > new Date(existing.submitted_at)) {
        byEmail.set(email, s);
      }
    }
    const noEmail = submissions.filter(s => !s.respondent_email);
    return [...Array.from(byEmail.values()), ...noEmail];
  }, [submissions]);

  // All answer options per question (from UNFILTERED data) — used for filter dropdowns
  const allAnswersByQuestion = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const q of app.questions) {
      if (!CORRELATABLE_TYPES.includes(q.type)) continue;
      // If question has defined choices, use those as the answer list
      if (q.choices && q.choices.length > 0) {
        result.set(q.title, q.choices.map(c => c.label));
        continue;
      }
      // Otherwise, collect unique raw values from submissions
      const answers = new Set<string>();
      for (const sub of dedupedSubmissions) {
        const ans = sub.answers.find(
          (a) =>
            a.question_ref === (q.ref ?? q.id) ||
            a.question_title.toLowerCase() === q.title.toLowerCase()
        );
        if (!ans?.value) continue;
        answers.add(ans.value.trim());
      }
      if (answers.size > 0) result.set(q.title, Array.from(answers).sort());
    }
    return result;
  }, [app.questions, dedupedSubmissions]);

  const submissionEmails = useMemo(() => {
    return new Set(dedupedSubmissions.map((s) => s.respondent_email?.toLowerCase()).filter(Boolean) as string[]);
  }, [dedupedSubmissions]);

  const filteredFinancial = useMemo(() => {
    return financialRecords.filter((r) => submissionEmails.has(r.email.toLowerCase()));
  }, [financialRecords, submissionEmails]);

  const filteredCallResults = useMemo(() => {
    return callResults.filter((r) => submissionEmails.has(r.email.toLowerCase()));
  }, [callResults, submissionEmails]);

  const bookingByEmail = useMemo(() => {
    const map = new Map<string, CallResultRecord | BookingRecord>();
    for (const r of filteredCallResults) map.set(r.email.toLowerCase(), r);
    for (const b of bookings) {
      if (submissionEmails.has(b.email.toLowerCase()) && !map.has(b.email.toLowerCase())) {
        map.set(b.email.toLowerCase(), b);
      }
    }
    return map;
  }, [filteredCallResults, bookings, submissionEmails]);

  const financialByEmail = useMemo(() => {
    const map = new Map<string, FinancialRecord>();
    for (const r of filteredFinancial) map.set(r.email.toLowerCase(), r);
    return map;
  }, [filteredFinancial]);

  // ── Filtered pipeline (date + advanced conditions) ──
  const hasDateData = useMemo(() => dedupedSubmissions.some(s => s.submitted_at || s.booking_date), [dedupedSubmissions]);

  const filteredDedupedSubmissions = useMemo(() => {
    let result = dedupedSubmissions;
    if (dateRange?.start && dateRange?.end) {
      const start = new Date(dateRange.start);
      const end = new Date(dateRange.end); end.setHours(23, 59, 59, 999);
      result = result.filter(sub => {
        const dateStr = dateRangeField === "booking_date" ? (sub.booking_date || sub.submitted_at) : (sub.submitted_at || sub.booking_date);
        if (!dateStr) return false;
        const d = new Date(dateStr);
        return d >= start && d <= end;
      });
    }
    if (filterConditions.length > 0) {
      result = result.filter(sub =>
        filterConditions.every(c => evaluateCondition(c, sub, financialByEmail, bookingByEmail))
      );
    }
    return result;
  }, [dedupedSubmissions, dateRange, dateRangeField, filterConditions, financialByEmail, bookingByEmail]);

  const filteredSubmissionEmails = useMemo(() => new Set(
    filteredDedupedSubmissions.map(s => s.respondent_email?.toLowerCase()).filter(Boolean) as string[]
  ), [filteredDedupedSubmissions]);

  const filteredFinancialForAnalytics = useMemo(() =>
    financialRecords.filter(r => filteredSubmissionEmails.has(r.email.toLowerCase()))
  , [financialRecords, filteredSubmissionEmails]);

  const totalSubs = filteredDedupedSubmissions.length;
  const bookedCount = filteredDedupedSubmissions.filter((s) => s.respondent_email && bookingByEmail.has(s.respondent_email.toLowerCase())).length;
  const showedCount = filteredDedupedSubmissions.filter((s) => {
    const b = s.respondent_email ? bookingByEmail.get(s.respondent_email.toLowerCase()) : undefined;
    return b?.showed;
  }).length;
  const closedCount = filteredDedupedSubmissions.filter((s) => {
    const b = s.respondent_email ? bookingByEmail.get(s.respondent_email.toLowerCase()) : undefined;
    return b?.closed;
  }).length;

  const overallShowRate = bookedCount ? showedCount / bookedCount : 0;
  const overallCloseRate = showedCount ? closedCount / showedCount : 0;
  const [correlationRateType, setCorrelationRateType] = useState<"show" | "close">("show");

  // Compute question correlations
  // Uses defined choices as canonical answers when available; for multi-select,
  // matches raw comma-joined values against choice labels instead of blindly splitting.
  const questionCorrelations = useMemo(() => {
    const result: { questionTitle: string; questionType: string; stats: { answer: string; count: number; bookedCount: number; showedCount: number; closedCount: number; grades: number[]; emails: string[]; bookedEmails: string[]; showedEmails: string[]; closedEmails: string[] }[] }[] = [];

    // Helper: given a raw submission value and defined choices, resolve to matched choice labels.
    // For multi-select questions, a raw value like "Choice A, Choice B" is matched against known labels.
    function resolveAnswers(rawVal: string, choices: { id: string; label: string }[] | undefined, isMultiSelect: boolean): string[] {
      if (!choices || choices.length === 0) {
        // No defined choices — if multi-select, try comma-splitting
        if (isMultiSelect && rawVal.includes(",")) {
          const parts = rawVal.split(",").map(p => p.trim()).filter(Boolean);
          if (parts.length > 1) return parts;
        }
        return [rawVal];
      }

      // Try exact match first (case-insensitive)
      const exactMatch = choices.find(c => c.label.toLowerCase() === rawVal.toLowerCase());
      if (exactMatch) return [exactMatch.label];

      if (isMultiSelect) {
        // For multi-select: try to match the raw value against known choice labels.
        // Typeform joins multiple selections with ", " — but choice labels may contain commas.
        // Strategy: greedily match longest choice labels first.
        const sortedChoices = [...choices].sort((a, b) => b.label.length - a.label.length);
        const matched: string[] = [];
        let remaining = rawVal;
        for (const c of sortedChoices) {
          // Check if this choice label appears in the remaining string
          const idx = remaining.toLowerCase().indexOf(c.label.toLowerCase());
          if (idx !== -1) {
            matched.push(c.label);
            // Remove the matched portion and surrounding delimiters
            const before = remaining.slice(0, idx);
            const after = remaining.slice(idx + c.label.length);
            remaining = (before + after).replace(/^[\s,;|]+|[\s,;|]+$/g, "").replace(/[\s,;|]{2,}/g, ", ");
          }
        }
        if (matched.length > 0) return matched;
      }

      // Fallback: return the raw value as-is
      return [rawVal];
    }

    for (const q of app.questions) {
      if (!CORRELATABLE_TYPES.includes(q.type)) continue;

      const answerMap = new Map<string, { answer: string; count: number; bookedCount: number; showedCount: number; closedCount: number; grades: number[]; emails: string[]; bookedEmails: string[]; showedEmails: string[]; closedEmails: string[] }>();
      const isMultiSelect = q.allow_multiple_selection === true;

      for (const sub of filteredDedupedSubmissions) {
        const ans = sub.answers.find(
          (a) =>
            a.question_ref === (q.ref ?? q.id) ||
            a.question_title.toLowerCase() === q.title.toLowerCase()
        );
        if (!ans?.value) continue;

        const rawVal = ans.value.trim();
        const vals = resolveAnswers(rawVal, q.choices, isMultiSelect);
        const booking = sub.respondent_email ? bookingByEmail.get(sub.respondent_email.toLowerCase()) : undefined;

        for (const val of vals) {
          if (!answerMap.has(val)) {
            answerMap.set(val, { answer: val, count: 0, bookedCount: 0, showedCount: 0, closedCount: 0, grades: [], emails: [], bookedEmails: [], showedEmails: [], closedEmails: [] });
          }
          const s = answerMap.get(val)!;
          s.count++;
          const email = sub.respondent_email?.toLowerCase();
          if (email) {
            s.emails.push(email);
            if (booking) { s.bookedCount++; s.bookedEmails.push(email); }
            if (booking?.showed) { s.showedCount++; s.showedEmails.push(email); }
            if (booking?.closed) { s.closedCount++; s.closedEmails.push(email); }
          } else {
            if (booking) s.bookedCount++;
            if (booking?.showed) s.showedCount++;
            if (booking?.closed) s.closedCount++;
          }
          if (sub.grade?.final_grade != null) s.grades.push(sub.grade.final_grade);
        }
      }

      if (answerMap.size === 0) continue;
      result.push({ questionTitle: q.title, questionType: q.type, stats: Array.from(answerMap.values()).sort((a, b) => b.count - a.count) });
    }
    return result;
  }, [app.questions, filteredDedupedSubmissions, bookingByEmail]);

  // Top correlations
  const topCorrelations = useMemo(() => {
    const all: { questionTitle: string; answer: string; bookedCount: number; showRate: number; closeRate: number; lift: number }[] = [];
    for (const qc of questionCorrelations) {
      for (const s of qc.stats) {
        if (s.bookedCount < 3) continue;
        const showRate = s.bookedCount > 0 ? s.showedCount / s.bookedCount : 0;
        const closeRate = s.showedCount > 0 ? s.closedCount / s.showedCount : 0;
        const rate = correlationRateType === "close" ? closeRate : showRate;
        const overallRate = correlationRateType === "close" ? overallCloseRate : overallShowRate;
        all.push({ questionTitle: qc.questionTitle, answer: s.answer, bookedCount: s.bookedCount, showRate, closeRate, lift: rate - overallRate });
      }
    }
    const rateKey = correlationRateType === "close" ? "closeRate" : "showRate";
    const sorted = [...all].sort((a, b) => b[rateKey] - a[rateKey]);
    return { top: sorted.slice(0, 3), bottom: sorted.length >= 3 ? sorted.slice(-3).reverse() : [] };
  }, [questionCorrelations, overallShowRate, overallCloseRate, correlationRateType]);

  // Financial bucketing
  interface FinBucket { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[]; bookedEmails: string[]; showedEmails: string[]; closedEmails: string[] }

  function bucketize(items: { email: string; value: number | undefined }[], defs: { label: string; match: (v: number) => boolean }[]): FinBucket[] {
    const buckets: FinBucket[] = defs.map((d) => ({ label: d.label, count: 0, bookedCount: 0, showedCount: 0, closedCount: 0, emails: [], bookedEmails: [], showedEmails: [], closedEmails: [] }));
    for (const item of items) {
      if (item.value == null) continue;
      const email = item.email.toLowerCase();
      const booking = bookingByEmail.get(email);
      for (let i = 0; i < defs.length; i++) {
        if (defs[i].match(item.value)) {
          buckets[i].count++;
          buckets[i].emails.push(email);
          if (booking) { buckets[i].bookedCount++; buckets[i].bookedEmails.push(email); }
          if (booking?.showed) { buckets[i].showedCount++; buckets[i].showedEmails.push(email); }
          if (booking?.closed) { buckets[i].closedCount++; buckets[i].closedEmails.push(email); }
          break;
        }
      }
    }
    return buckets.filter((b) => b.count > 0);
  }

  // Credit Score — summary
  const creditScoreBuckets = useMemo(() => {
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.credit_score })), [
      { label: "< 600", match: (v) => v > 0 && v < 600 },
      { label: "600–649", match: (v) => v >= 600 && v < 650 },
      { label: "650–699", match: (v) => v >= 650 && v < 700 },
      { label: "700–749", match: (v) => v >= 700 && v < 750 },
      { label: "750+", match: (v) => v >= 750 },
    ]);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Credit Score — granular (25-point increments)
  const creditScoreBucketsGranular = useMemo(() => {
    const defs: { label: string; match: (v: number) => boolean }[] = [
      { label: "Below 600", match: (v) => v > 0 && v < 600 },
    ];
    for (let lo = 600; lo < 800; lo += 25) {
      const hi = lo + 25;
      defs.push({ label: `${lo}–${hi}`, match: (v) => v >= lo && v < hi });
    }
    defs.push({ label: "> 800", match: (v) => v >= 800 });
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.credit_score })), defs);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Income — summary
  const incomeBuckets = useMemo(() => {
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.estimated_income })), [
      { label: "< $25k", match: (v) => v < 25_000 },
      { label: "$25k–$50k", match: (v) => v >= 25_000 && v < 50_000 },
      { label: "$50k–$75k", match: (v) => v >= 50_000 && v < 75_000 },
      { label: "$75k–$100k", match: (v) => v >= 75_000 && v < 100_000 },
      { label: "$100k–$150k", match: (v) => v >= 100_000 && v < 150_000 },
      { label: "$150k+", match: (v) => v >= 150_000 },
    ]);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Income — granular ($10k increments)
  const incomeBucketsGranular = useMemo(() => {
    const defs: { label: string; match: (v: number) => boolean }[] = [
      { label: "< $10k", match: (v) => v < 10_000 },
    ];
    for (let lo = 10_000; lo < 200_000; lo += 10_000) {
      const hi = lo + 10_000;
      const loK = `$${lo / 1000}k`;
      const hiK = `$${hi / 1000}k`;
      defs.push({ label: `${loK}–${hiK}`, match: (v) => v >= lo && v < hi });
    }
    defs.push({ label: "$200k+", match: (v) => v >= 200_000 });
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.estimated_income })), defs);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Credit Access — summary
  const creditAccessBuckets = useMemo(() => {
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.credit_access })), [
      { label: "< $10k", match: (v) => v < 10_000 },
      { label: "$10k–$25k", match: (v) => v >= 10_000 && v < 25_000 },
      { label: "$25k–$50k", match: (v) => v >= 25_000 && v < 50_000 },
      { label: "$50k–$100k", match: (v) => v >= 50_000 && v < 100_000 },
      { label: "$100k+", match: (v) => v >= 100_000 },
    ]);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Credit Access — granular ($10k increments)
  const creditAccessBucketsGranular = useMemo(() => {
    const defs: { label: string; match: (v: number) => boolean }[] = [
      { label: "< $10k", match: (v) => v < 10_000 },
    ];
    for (let lo = 10_000; lo < 150_000; lo += 10_000) {
      const hi = lo + 10_000;
      const loK = `$${lo / 1000}k`;
      const hiK = `$${hi / 1000}k`;
      defs.push({ label: `${loK}–${hiK}`, match: (v) => v >= lo && v < hi });
    }
    defs.push({ label: "$150k+", match: (v) => v >= 150_000 });
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.credit_access })), defs);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Funding — summary
  const fundingBuckets = useMemo(() => {
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.access_to_funding })), [
      { label: "< $25k", match: (v) => v < 25_000 },
      { label: "$25k–$50k", match: (v) => v >= 25_000 && v < 50_000 },
      { label: "$50k–$100k", match: (v) => v >= 50_000 && v < 100_000 },
      { label: "$100k–$250k", match: (v) => v >= 100_000 && v < 250_000 },
      { label: "$250k+", match: (v) => v >= 250_000 },
    ]);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Funding — granular ($25k increments)
  const fundingBucketsGranular = useMemo(() => {
    const defs: { label: string; match: (v: number) => boolean }[] = [
      { label: "< $25k", match: (v) => v < 25_000 },
    ];
    for (let lo = 25_000; lo < 300_000; lo += 25_000) {
      const hi = lo + 25_000;
      const loK = `$${lo / 1000}k`;
      const hiK = `$${hi / 1000}k`;
      defs.push({ label: `${loK}–${hiK}`, match: (v) => v >= lo && v < hi });
    }
    defs.push({ label: "$300k+", match: (v) => v >= 300_000 });
    return bucketize(filteredFinancialForAnalytics.map((r) => ({ email: r.email, value: r.access_to_funding })), defs);
  }, [filteredFinancialForAnalytics, bookingByEmail]);

  // Days from application to booking — summary
  const daysToBookingItems = useMemo(() => {
    function toDateOnly(dateStr: string): Date {
      const d = new Date(dateStr);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    const items: { email: string; value: number }[] = [];
    for (const sub of filteredDedupedSubmissions) {
      if (!sub.booking_date || !sub.submitted_at) continue;
      const submitDate = toDateOnly(sub.submitted_at);
      const bookDate = toDateOnly(sub.booking_date);
      const days = Math.round((bookDate.getTime() - submitDate.getTime()) / (1000 * 60 * 60 * 24));
      if (days < 0) continue;
      items.push({ email: sub.respondent_email?.toLowerCase() ?? "", value: days });
    }
    return items;
  }, [filteredDedupedSubmissions]);

  const daysToBookingBuckets = useMemo(() => {
    if (daysToBookingItems.length === 0) return [];
    // Auto-bucket: 1, 2, 3, 4, 5+ days
    // Trim trailing empty buckets, but keep interior empties if later buckets have data
    const defs = [
      { label: "1 day", match: (d: number) => d >= 0 && d <= 1 },
      { label: "2 days", match: (d: number) => d === 2 },
      { label: "3 days", match: (d: number) => d === 3 },
      { label: "4 days", match: (d: number) => d === 4 },
      { label: "5+ days", match: (d: number) => d >= 5 },
    ];
    const all = bucketize(daysToBookingItems, defs);
    // Find last bucket with data and trim trailing empties
    let lastNonEmpty = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].count > 0) { lastNonEmpty = i; break; }
    }
    return lastNonEmpty >= 0 ? all.slice(0, lastNonEmpty + 1) : [];
  }, [daysToBookingItems, bookingByEmail]);

  const gradeBuckets = useMemo(() => {
    // Detect grade scale: if any grade > 10, assume 0-100 scale; else 0-4 GPA scale
    const allGrades: number[] = [];
    for (const s of filteredDedupedSubmissions) {
      if (s.grade?.final_grade != null) allGrades.push(s.grade.final_grade);
      if (s.grade?.answer_grade != null) allGrades.push(s.grade.answer_grade);
    }
    for (const r of filteredFinancialForAnalytics) {
      if (r.financial_grade != null) allGrades.push(r.financial_grade);
    }

    const maxGrade = allGrades.length > 0 ? Math.max(...allGrades) : 0;

    const GRADE_DEFS = maxGrade > 10
      ? [
          { label: "0–25", match: (v: number) => v >= 0 && v < 25 },
          { label: "25–50", match: (v: number) => v >= 25 && v < 50 },
          { label: "50–75", match: (v: number) => v >= 50 && v < 75 },
          { label: "75–100", match: (v: number) => v >= 75 && v <= 100 },
        ]
      : [
          { label: "Grade 1", match: (v: number) => v >= 0 && v < 1.5 },
          { label: "Grade 2", match: (v: number) => v >= 1.5 && v < 2.5 },
          { label: "Grade 3", match: (v: number) => v >= 2.5 && v < 3.5 },
          { label: "Grade 4", match: (v: number) => v >= 3.5 },
        ];

    const totalGradeItems = filteredDedupedSubmissions
      .map(s => ({ email: s.respondent_email?.toLowerCase() ?? "", value: s.grade?.final_grade }))
      .filter(x => x.value != null);

    const appGradeItems = filteredDedupedSubmissions
      .map(s => ({ email: s.respondent_email?.toLowerCase() ?? "", value: s.grade?.answer_grade }))
      .filter(x => x.value != null);

    const finGradeItems = filteredFinancialForAnalytics
      .map(r => ({ email: r.email.toLowerCase(), value: r.financial_grade }))
      .filter(x => x.value != null);

    return {
      totalGrade: totalGradeItems.length > 0 ? bucketize(totalGradeItems, GRADE_DEFS) : [],
      appGrade: appGradeItems.length > 0 ? bucketize(appGradeItems, GRADE_DEFS) : [],
      finGrade: finGradeItems.length > 0 ? bucketize(finGradeItems, GRADE_DEFS) : [],
      hasTotalGrade: totalGradeItems.length > 0,
      hasAppGrade: appGradeItems.length > 0,
      hasFinGrade: finGradeItems.length > 0,
    };
  }, [filteredDedupedSubmissions, filteredFinancialForAnalytics, bookingByEmail]);

  const hasBookingData = bookedCount > 0;
  const hasCreditScores = filteredFinancialForAnalytics.some((r) => r.credit_score != null);
  const hasIncome = filteredFinancialForAnalytics.some((r) => r.estimated_income != null);
  const hasCreditAccess = filteredFinancialForAnalytics.some((r) => r.credit_access != null);
  const hasFunding = filteredFinancialForAnalytics.some((r) => r.access_to_funding != null);

  // ── Share handlers ──────────────────────────────────────────────────────

  function toggleShare() {
    if (!app.share_token) {
      // Generate token and enable
      const token = crypto.randomUUID();
      onSave({ ...app, share_token: token, share_enabled: true });
    } else {
      onSave({ ...app, share_enabled: !app.share_enabled });
    }
  }

  function copyShareLink() {
    if (!app.share_token) return;
    const url = `${window.location.origin}/share/${app.share_token}`;
    navigator.clipboard.writeText(url);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }

  // ── Export handlers ──────────────────────────────────────────────────────

  function exportFilename(ext: string): string {
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}.${now.getDate()}`;
    return `${clientName} - Correlation Analysis for ${app.title} - ${dateStr}.${ext}`;
  }

  function buildExportData() {
    return {
      appTitle: app.title,
      dedupedSubmissions: filteredDedupedSubmissions,
      bookingByEmail,
      financialByEmail,
      questions: app.questions,
      questionCorrelations: questionCorrelations.filter((qc) => !hiddenQuestions.has(qc.questionTitle)),
      gradeBuckets,
      creditScoreBuckets,
      incomeBuckets,
      creditAccessBuckets,
      fundingBuckets,
      daysToBookingBuckets,
      creditScoreBucketsGranular,
      incomeBucketsGranular,
      creditAccessBucketsGranular,
      fundingBucketsGranular,
      daysToBookingBucketsGranular: [] as { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[],
      totalSubs,
      bookedCount,
      showedCount,
      closedCount,
    };
  }

  async function handlePdfExport() {
    setExportOpen(false);
    setExporting(true);
    try {
      const { exportPdf } = await import("@/lib/exportCorrelation");
      await exportPdf(buildExportData(), exportFilename("pdf"));
    } finally {
      setExporting(false);
    }
  }

  async function handleXlsxExport() {
    setExportOpen(false);
    setExporting(true);
    try {
      const { exportXlsx } = await import("@/lib/exportCorrelation");
      await exportXlsx({
        ...buildExportData(),
        exportFilename: exportFilename("xlsx"),
      });
    } finally {
      setExporting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-200">Correlation Analysis</h2>
          <p className="text-[11px] text-slate-300 mt-0.5">
            Only records with emails found in Submissions are included.
            {(financialRecords.length > filteredFinancialForAnalytics.length || callResults.length > filteredCallResults.length) && (
              <span className="block mt-0.5">
                {financialRecords.length > filteredFinancialForAnalytics.length && (
                  <span className="text-amber-500">
                    {financialRecords.length - filteredFinancialForAnalytics.length} financial records excluded
                  </span>
                )}
                {financialRecords.length > filteredFinancialForAnalytics.length && callResults.length > filteredCallResults.length && (
                  <span className="text-slate-400 mx-1">·</span>
                )}
                {callResults.length > filteredCallResults.length && (
                  <span className="text-amber-500">
                    {callResults.length - filteredCallResults.length} call results excluded
                  </span>
                )}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-white/[0.06] rounded-lg p-0.5">
            <button
              onClick={() => setShowRawCounts(false)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${!showRawCounts ? "bg-white/[0.12] text-slate-200 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}
            >%</button>
            <button
              onClick={() => setShowRawCounts(true)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${showRawCounts ? "bg-white/[0.12] text-slate-200 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}
            >#</button>
          </div>
          <div className="flex items-center bg-white/[0.06] rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("modern")}
              className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${viewMode === "modern" ? "bg-white/[0.12] text-slate-200 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}
            >Modern</button>
            <button
              onClick={() => setViewMode("classic")}
              className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${viewMode === "classic" ? "bg-white/[0.12] text-slate-200 shadow-sm" : "text-slate-300 hover:text-slate-300"}`}
            >Classic</button>

          </div>
          <button
            onClick={() => setFilterPanelOpen(true)}
            className={`flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-lg border transition-colors ${activeFilterCount > 0 ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filter
            {activeFilterCount > 0 && (
              <span className="ml-0.5 bg-indigo-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{activeFilterCount}</span>
            )}
          </button>
          {activeFilterCount > 0 && (
            <button
              onClick={clearAllFilters}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-red-400 hover:text-red-300 hover:bg-red-400/10 rounded-lg transition-colors"
              title="Clear all filters"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {/* Share button */}
          <div className="relative">
            <button
              onClick={() => setSharePopoverOpen(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-lg border transition-colors ${app.share_enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04]"}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Share
            </button>
            {sharePopoverOpen && (
              <div className="absolute right-0 top-full mt-1 bg-slate-900 border border-white/[0.1] rounded-xl shadow-2xl z-50 p-4 w-72">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] font-semibold text-slate-300">Client-Facing Link</p>
                  <button
                    onClick={toggleShare}
                    className={`relative w-9 h-5 rounded-full transition-colors ${app.share_enabled ? "bg-emerald-500" : "bg-white/[0.1]"}`}
                  >
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow ${app.share_enabled ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </div>
                {app.share_token && app.share_enabled ? (
                  <>
                    <div className="flex gap-1.5">
                      <input
                        readOnly
                        value={`${typeof window !== "undefined" ? window.location.origin : ""}/share/${app.share_token}`}
                        className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[10px] text-slate-400 font-mono truncate"
                      />
                      <button
                        onClick={copyShareLink}
                        className="px-2 py-1.5 text-[10px] font-semibold bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors shrink-0"
                      >
                        {shareCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <p className="text-[9px] text-slate-500 mt-2">Anyone with this link can view the correlation analysis (read-only). No login required.</p>
                  </>
                ) : (
                  <p className="text-[10px] text-slate-500">Enable sharing to generate a public link for this analysis.</p>
                )}
              </div>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setExportOpen(!exportOpen)}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-lg border border-white/[0.08] text-slate-300 hover:bg-white/[0.04] transition-colors disabled:opacity-50"
            >
              {exporting ? (
                <>
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
                  Exporting…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Export
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </>
              )}
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white/[0.04] border border-white/[0.08] rounded-lg shadow-lg z-50 py-1 min-w-[160px]">
                <button
                  onClick={handlePdfExport}
                  className="w-full text-left px-3 py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.04] transition-colors flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  Export PDF
                </button>
                <button
                  onClick={handleXlsxExport}
                  className="w-full text-left px-3 py-2 text-[11px] font-medium text-slate-300 hover:bg-white/[0.04] transition-colors flex items-center gap-2"
                >
                  <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Export XLSX
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Chat with Your Data ────────────────────────────────────────────── */}
      <div className="bg-white/[0.02] border border-white/[0.08] rounded-xl overflow-hidden">
        <button
          onClick={() => { setDataChatOpen(v => !v); if (!dataChatOpen && dataChats.length === 0) createNewChat(); }}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-sm font-semibold text-slate-200">Chat with Your Data</span>
            {dataChats.length > 0 && (
              <span className="text-[9px] font-bold bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full">{dataChats.length}</span>
            )}
          </div>
          <svg className={`w-4 h-4 text-slate-400 transition-transform ${dataChatOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {dataChatOpen && (
          <div className="border-t border-white/[0.06]">
            <div className="flex" style={{ height: "420px" }}>
              {/* Sidebar — chat list */}
              <div className="w-48 shrink-0 border-r border-white/[0.06] flex flex-col bg-white/[0.02]">
                <button
                  onClick={createNewChat}
                  className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-indigo-400 hover:bg-indigo-500/10 transition-colors border-b border-white/[0.06]"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  New Chat
                </button>
                <div className="flex-1 overflow-y-auto">
                  {dataChats.map(chat => (
                    <div
                      key={chat.id}
                      className={`group flex items-center gap-1 px-3 py-2 cursor-pointer transition-colors ${chat.id === activeChatId ? "bg-indigo-500/15 border-r-2 border-indigo-400" : "hover:bg-white/[0.04]"}`}
                      onClick={() => setActiveChatId(chat.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-[11px] font-medium truncate ${chat.id === activeChatId ? "text-indigo-300" : "text-slate-300"}`}>{chat.title}</p>
                        <p className="text-[9px] text-slate-500">{chat.messages.length} messages</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteChat(chat.id); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-red-400 transition-all"
                        title="Delete chat"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chat area */}
              <div className="flex-1 flex flex-col min-w-0">
                {activeChat ? (
                  <>
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                      {activeChat.messages.length === 0 && !dataChatLoading && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                          <svg className="w-8 h-8 text-slate-600 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          <p className="text-xs text-slate-500">Ask anything about your data</p>
                          <p className="text-[10px] text-slate-600 mt-1">
                            {[app.narrative_analysis && "Lead Analysis", app.audit_analysis && "Audit", app.grading_audit_analysis && "Grading Audit"].filter(Boolean).length > 0
                              ? `Context includes: ${[app.narrative_analysis && "Lead Analysis", app.audit_analysis && "Audit", app.grading_audit_analysis && "Grading Audit"].filter(Boolean).join(", ")}`
                              : "Generate reports for richer context"}
                          </p>
                        </div>
                      )}
                      {activeChat.messages.map((msg, i) => (
                        <div key={i} className={`text-xs px-3 py-2 rounded-lg ${
                          msg.role === "user"
                            ? "ml-auto max-w-[85%] bg-indigo-500/20 text-slate-200"
                            : "max-w-[90%] bg-white/[0.06] text-slate-300"
                        }`}>
                          <div className="whitespace-pre-line" dangerouslySetInnerHTML={{
                            __html: msg.content.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                          }} />
                        </div>
                      ))}
                      {dataChatLoading && (
                        <div className="bg-white/[0.06] text-slate-400 text-xs px-3 py-2 rounded-lg w-fit animate-pulse">
                          Thinking…
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                    {/* Input */}
                    <div className="border-t border-white/[0.06] px-4 py-2">
                      <div className="flex gap-2">
                        <input
                          value={dataChatInput}
                          onChange={(e) => setDataChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendDataChat()}
                          placeholder="Ask about your data…"
                          className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        />
                        <button
                          onClick={sendDataChat}
                          disabled={dataChatLoading || !dataChatInput.trim()}
                          className="px-3 py-1.5 text-xs font-semibold bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <p className="text-xs text-slate-500">Select a chat or create a new one</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {viewMode === "modern" && <div ref={correlationRef} className="space-y-8">
      {/* Overview stats — Radial Rings */}
      <section>
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300 mb-3">Overview</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Submissions", value: totalSubs, pctValue: null as number | null, color: "#818cf8", stage: null as string | null },
            { label: "Booked", value: bookedCount, pctValue: totalSubs ? bookedCount / totalSubs : 0, color: "#818cf8", stage: "Booked" },
            { label: "Showed", value: showedCount, pctValue: bookedCount ? showedCount / bookedCount : 0, color: "#34d399", stage: "Showed" },
            { label: "Closed", value: closedCount, pctValue: showedCount ? closedCount / showedCount : 0, color: "#22c55e", stage: "Closed" },
          ].map((s) => (
            <div
              key={s.label}
              className={`bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 text-center shadow-sm shadow-black/10 ${s.stage ? "cursor-pointer hover:border-white/[0.15] hover:bg-white/[0.06] transition-all" : ""}`}
              onClick={() => {
                if (!s.stage) return;
                const emails: string[] = [];
                for (const sub of filteredDedupedSubmissions) {
                  const email = sub.respondent_email?.toLowerCase();
                  if (!email) continue;
                  const bk = bookingByEmail.get(email);
                  if (!bk) continue;
                  if (s.stage === "Booked" || (s.stage === "Showed" && bk.showed) || (s.stage === "Closed" && bk.closed)) {
                    emails.push(email);
                  }
                }
                setDrillDown({ type: "emails", label: s.label, emails });
              }}
            >
              {s.pctValue !== null ? (
                <svg className="w-20 h-20 mx-auto mb-2" viewBox="0 0 80 80">
                  <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
                  <circle cx="40" cy="40" r="34" fill="none" stroke={s.color} strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={`${Math.round(s.pctValue * 213.6)} 213.6`}
                    transform="rotate(-90 40 40)"
                    className="transition-all duration-700"
                  />
                  <text x="40" y="44" textAnchor="middle" className="fill-white text-[15px] font-black">{Math.round(s.pctValue * 100)}%</text>
                </svg>
              ) : (
                <div className="w-20 h-20 mx-auto mb-2 flex flex-col items-center justify-center">
                  <span className="text-2xl font-black text-slate-200">{s.value.toLocaleString()}</span>
                  <span className="text-[8px] text-slate-300 uppercase tracking-wider font-semibold mt-0.5">{s.label}</span>
                </div>
              )}
              {s.pctValue !== null && <p className="text-[10px] text-slate-300 uppercase tracking-wider font-semibold">{s.label}</p>}
              {s.pctValue !== null && <p className="text-[10px] text-slate-300 mt-0.5">{s.value.toLocaleString()}</p>}
            </div>
          ))}
        </div>
      </section>

      {/* ── Lead Narrative Analysis ── */}
      <section>
        {app.narrative_analysis ? (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-6 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setNarrativeCollapsed(v => !v)}
                className="flex items-center gap-3 group"
              >
                <svg className={`w-3 h-3 text-slate-400 transition-transform ${narrativeCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h3 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">Lead Analysis</h3>
                {app.narrative_generated_at && (
                  <span className="text-[10px] text-slate-400">
                    Generated {new Date(app.narrative_generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </button>
              <div className="relative">
                {showRegenConfirm ? (
                  <div className="flex items-center gap-2 bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-1.5">
                    <span className="text-[10px] text-slate-300">Regenerate?</span>
                    <button
                      onClick={generateNarrative}
                      disabled={narrativeGenerating}
                      className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setShowRegenConfirm(false)}
                      className="text-[10px] text-slate-400 hover:text-slate-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowRegenConfirm(true)}
                    className="text-slate-500 hover:text-slate-300 transition-colors p-1 rounded hover:bg-white/[0.05]"
                    title="Regenerate analysis"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {/* Collapsible body */}
            {!narrativeCollapsed && <>
            {/* Generating overlay */}
            {narrativeGenerating ? (
              <div className="space-y-3 animate-pulse">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-4 w-40 bg-white/[0.06] rounded" />
                    <div className="h-3 w-full bg-white/[0.04] rounded" />
                    <div className="h-3 w-3/4 bg-white/[0.04] rounded" />
                  </div>
                ))}
              </div>
            ) : (
              /* Rendered markdown narrative */
              <div className="space-y-4">
                {app.narrative_analysis.split(/^## /m).filter(Boolean).map((section, i) => {
                  const lines = section.split("\n");
                  const title = lines[0]?.trim();
                  const body = lines.slice(1).join("\n").trim();
                  return (
                    <div key={i}>
                      {title && (
                        <div className="flex items-center gap-2 mb-2">
                          <div className="h-px flex-1 bg-white/[0.06]" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400/80">{title}</span>
                          <div className="h-px flex-1 bg-white/[0.06]" />
                        </div>
                      )}
                      {body && (
                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-line">
                          {body.split("\n").map((line, li) => {
                            const trimmed = line.trim();
                            if (!trimmed) return <br key={li} />;
                            if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
                              const content = trimmed.slice(2);
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-indigo-400/60 mt-0.5 shrink-0">•</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            if (/^\d+\.\s/.test(trimmed)) {
                              const num = trimmed.match(/^(\d+)\.\s/)?.[1];
                              const content = trimmed.replace(/^\d+\.\s/, "");
                              return (
                                <div key={li} className="flex gap-2 ml-2 mb-1">
                                  <span className="text-indigo-400/60 mt-0.5 shrink-0 text-[10px] font-mono">{num}.</span>
                                  <span dangerouslySetInnerHTML={{
                                    __html: content
                                      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                                  }} />
                                </div>
                              );
                            }
                            return (
                              <p key={li} className="mb-1" dangerouslySetInnerHTML={{
                                __html: trimmed
                                  .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
                              }} />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {narrativeError && (
              <p className="text-xs text-red-400 mt-2">{narrativeError}</p>
            )}
            </>}
          </div>
        ) : (
          /* Generate button when no narrative exists */
          <button
            onClick={generateNarrative}
            disabled={narrativeGenerating}
            className="w-full bg-white/[0.03] border border-dashed border-white/[0.1] rounded-xl p-4 text-center cursor-pointer hover:bg-white/[0.05] hover:border-white/[0.15] transition-all group disabled:opacity-50 disabled:cursor-wait"
          >
            {narrativeGenerating ? (
              <div className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
                  <path d="M12 2a10 10 0 019.75 7.75" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span className="text-sm text-slate-400">Generating lead analysis…</span>
              </div>
            ) : (
              <div>
                <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">✨ Generate Lead Analysis</span>
                <p className="text-[10px] text-slate-500 mt-1">AI-powered breakdown of your lead data, funnel, and recommendations</p>
              </div>
            )}
            {narrativeError && (
              <p className="text-xs text-red-400 mt-2">{narrativeError}</p>
            )}
          </button>
        )}
      </section>

      {/* ── Grades Section ── */}
      {(gradeBuckets.hasTotalGrade || gradeBuckets.hasAppGrade || gradeBuckets.hasFinGrade || daysToBookingBuckets.length > 0) && (
        <div className="flex items-center gap-3 pt-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Grades</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>
      )}

      {/* Grade Breakdown */}
      {(gradeBuckets.hasTotalGrade || gradeBuckets.hasAppGrade || gradeBuckets.hasFinGrade) && (
        <section>
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300 mb-3">Grade Breakdown</h3>
          <div className="space-y-4">
            {gradeBuckets.hasTotalGrade && (
              <div>
                <p className="text-[11px] font-semibold text-slate-300 mb-2">Final Grade</p>
                <BucketTable buckets={gradeBuckets.totalGrade} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
              </div>
            )}
            {gradeBuckets.hasAppGrade && (
              <div>
                <p className="text-[11px] font-semibold text-slate-300 mb-2">Application Grade</p>
                <BucketTable buckets={gradeBuckets.appGrade} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
              </div>
            )}
            {gradeBuckets.hasFinGrade && (
              <div>
                <p className="text-[11px] font-semibold text-slate-300 mb-2">Financial Grade</p>
                <BucketTable buckets={gradeBuckets.finGrade} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Days from Application to Booking — under Grades */}
      {daysToBookingBuckets.length > 0 && (
        <section>
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300 mb-3">Days from Application to Booking</h3>
          <p className="text-[10px] text-slate-300 -mt-2 mb-3">
            How long between application submission and booking date. Only includes submissions with both dates.
          </p>
          <BucketTable buckets={daysToBookingBuckets} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
        </section>
      )}

      {/* ── Application Answers Section ── */}
      {questionCorrelations.length > 0 && (
        <div className="flex items-center gap-3 pt-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Application Answers</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>
      )}

      {/* Signals — styled like the timezone normalize panel */}
      {(topCorrelations.top.length > 0 || topCorrelations.bottom.length > 0) && (
        <section>
          <button
            onClick={() => setShowInsights(!showInsights)}
            className={`flex items-center gap-2 px-4 py-2.5 text-[11px] font-semibold rounded-lg border transition-all w-full ${
              showInsights
                ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-400"
                : "border-white/[0.08] text-slate-300 hover:bg-white/[0.04] hover:border-white/[0.15]"
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Signals
            <span className={`text-[9px] font-bold rounded-full px-1.5 py-0.5 ${showInsights ? "bg-indigo-500/20 text-indigo-400" : "bg-white/[0.08] text-slate-300"}`}>
              {topCorrelations.top.length + topCorrelations.bottom.length}
            </span>
            <svg className={`w-3.5 h-3.5 ml-auto transition-transform ${showInsights ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showInsights && (
            <div className="mt-3 bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Top Correlations</h3>
                <select
                  value={correlationRateType}
                  onChange={(e) => setCorrelationRateType(e.target.value as "show" | "close")}
                  className="text-[10px] font-semibold border border-white/[0.08] rounded px-2 py-0.5 text-slate-200 bg-white/[0.05]"
                >
                  <option value="show">Show Rate</option>
                  <option value="close">Close Rate</option>
                </select>
              </div>
              {topCorrelations.top.length > 0 && (
                <div className="mb-4">
                  <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider mb-2">Positive</p>
                  <div className="grid sm:grid-cols-3 gap-3">
                    {topCorrelations.top.map((item, i) => (
                      <CorrelationCard key={i} item={item} variant="positive" overallRate={correlationRateType === "close" ? overallCloseRate : overallShowRate} rateType={correlationRateType} />
                    ))}
                  </div>
                </div>
              )}
              {topCorrelations.bottom.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-rose-400 uppercase tracking-wider mb-2">Negative</p>
                  <div className="grid sm:grid-cols-3 gap-3">
                    {topCorrelations.bottom.map((item, i) => (
                      <CorrelationCard key={i} item={item} variant="negative" overallRate={correlationRateType === "close" ? overallCloseRate : overallShowRate} rateType={correlationRateType} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Question Breakdown */}
      {questionCorrelations.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Question Breakdown</h3>
            {hiddenQuestions.size > 0 && (
              <button onClick={() => setShowHiddenManager(!showHiddenManager)} className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold transition-colors">
                {showHiddenManager ? "Done" : `${hiddenQuestions.size} hidden`}
              </button>
            )}
          </div>
          {showHiddenManager && hiddenQuestions.size > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 mb-3">
              <p className="text-[10px] font-bold uppercase text-amber-500 mb-2">Hidden Questions</p>
              <div className="space-y-1">
                {Array.from(hiddenQuestions).map((title) => (
                  <div key={title} className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-300 truncate flex-1">{title}</span>
                    <button onClick={() => unhideQuestion(title)} className="text-indigo-400 hover:text-indigo-300 font-semibold ml-2 shrink-0">Show</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-4">
            {questionCorrelations.filter((qc) => !hiddenQuestions.has(qc.questionTitle)).map((qc) => (
              <div key={qc.questionTitle} className="bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-slate-400">{qc.questionTitle}</p>
                    <p className="text-[10px] text-slate-300 mt-0.5">{qc.questionType.replace(/_/g, " ")} · {qc.stats.length} unique answers</p>
                  </div>
                  <button onClick={() => toggleHideQuestion(qc.questionTitle)} className="text-[10px] text-slate-400 hover:text-slate-300 transition-colors" title="Hide this question">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.05 6.05m3.828 3.828l4.242 4.242m0 0L17.95 17.95M3 3l18 18" />
                    </svg>
                  </button>
                </div>
                <div className="px-4 py-3">
                  {hasBookingData ? (
                    <div className="grid items-center gap-2 text-[9px] font-bold uppercase text-slate-400 mb-2" style={{ gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" }}>
                      <span>Answer</span>
                      <span className="text-center">Apps</span>
                      <span className="text-center">Booked</span>
                      <span className="text-center">Showed</span>
                      <span className="text-center">Closed</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[9px] font-bold uppercase text-slate-400 mb-2">
                      <span className="flex-1">Answer</span>
                      <span className="shrink-0 w-10 text-right">Count</span>
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {getOrderedStats(qc).map((s, si) => {
                      const isDragging = dragState?.questionTitle === qc.questionTitle && dragState.dragIdx === si;
                      const isOver = dragState?.questionTitle === qc.questionTitle && dragState.overIdx === si && dragState.dragIdx !== si;
                      const appsPct = totalSubs > 0 ? Math.round(s.count / totalSubs * 100) : 0;
                      const bookedPct = bookedCount > 0 ? Math.round(s.bookedCount / bookedCount * 100) : 0;
                      const showedPct = s.bookedCount > 0 ? Math.round(s.showedCount / s.bookedCount * 100) : 0;
                      const closedPct = s.showedCount > 0 ? Math.round(s.closedCount / s.showedCount * 100) : 0;
                      return hasBookingData ? (
                        <div
                          key={s.answer}
                          draggable
                          onDragStart={(e) => {
                            setDragState({ questionTitle: qc.questionTitle, dragIdx: si, overIdx: si });
                            e.dataTransfer.effectAllowed = "move";
                            e.currentTarget.style.opacity = "0.4";
                          }}
                          onDragEnd={(e) => {
                            e.currentTarget.style.opacity = "1";
                            if (dragState && dragState.questionTitle === qc.questionTitle) {
                              handleDragReorder(qc.questionTitle, getOrderedStats(qc), dragState.dragIdx, dragState.overIdx);
                            }
                            setDragState(null);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dragState && dragState.questionTitle === qc.questionTitle && dragState.overIdx !== si) {
                              setDragState({ ...dragState, overIdx: si });
                            }
                          }}
                          onDragEnter={(e) => e.preventDefault()}
                          className={`grid items-center gap-2 text-[11px] rounded px-1 -mx-1 py-1 transition-all select-none
                            ${isDragging ? "opacity-40 scale-95 bg-indigo-100 shadow-inner" : ""}
                            ${isOver ? "border-t-2 border-indigo-400" : "border-t-2 border-transparent"}
                            ${!isDragging ? "cursor-grab hover:bg-indigo-500/10 active:cursor-grabbing" : ""}`}
                          style={{ gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" }}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
                            </svg>
                            <span
                              className="text-slate-300 truncate hover:text-indigo-400 cursor-pointer"
                              title={`Click to view submissions — ${s.answer}`}
                              onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "answer", questionTitle: qc.questionTitle, answer: s.answer }); }}
                            >{s.answer}</span>
                          </div>
                          {/* Apps bar — % of total applications */}
                          <div
                            className="flex items-center gap-1 cursor-pointer"
                            title={`${s.count} apps (${appsPct}% of all applications) — click to view`}
                            onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "emails", label: `"${s.answer}" — All Apps`, emails: s.emails }); }}
                          >
                            <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                              <div className="h-full bg-white/[0.12] rounded-full transition-all" style={{ width: `${Math.max(appsPct > 0 ? 4 : 0, appsPct)}%` }} />
                            </div>
                            <span className="text-[10px] text-slate-300 font-medium w-8 text-right tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); setShowRawCounts(v => !v); }}>{showRawCounts ? s.count : `${appsPct}%`}</span>
                          </div>
                          {/* Booked bar — % of total bookings */}
                          <div
                            className="flex items-center gap-1 cursor-pointer"
                            title={`${s.bookedCount} booked (${bookedPct}% of all bookings) — click to view`}
                            onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "emails", label: `"${s.answer}" — Booked`, emails: s.bookedEmails }); }}
                          >
                            <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-300 rounded-full transition-all" style={{ width: `${Math.max(bookedPct > 0 ? 4 : 0, bookedPct)}%` }} />
                            </div>
                            <span className="text-[10px] text-indigo-400 font-medium w-8 text-right tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); setShowRawCounts(v => !v); }}>{showRawCounts ? s.bookedCount : `${bookedPct}%`}</span>
                          </div>
                          {/* Showed bar — showed/booked */}
                          <div
                            className="flex items-center gap-1 cursor-pointer"
                            title={`${s.showedCount} showed of ${s.bookedCount} booked (${showedPct}%) — click to view`}
                            onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "emails", label: `"${s.answer}" — Showed`, emails: s.showedEmails }); }}
                          >
                            <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${Math.max(showedPct > 0 ? 4 : 0, showedPct)}%` }} />
                            </div>
                            <span className="text-[10px] text-emerald-400 font-medium w-8 text-right tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); setShowRawCounts(v => !v); }}>{showRawCounts ? s.showedCount : `${showedPct}%`}</span>
                          </div>
                          {/* Closed bar — closed/showed */}
                          <div
                            className="flex items-center gap-1 cursor-pointer"
                            title={`${s.closedCount} closed of ${s.showedCount} showed (${closedPct}%) — click to view`}
                            onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "emails", label: `"${s.answer}" — Closed`, emails: s.closedEmails }); }}
                          >
                            <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                              <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${Math.max(closedPct > 0 ? 4 : 0, closedPct)}%` }} />
                            </div>
                            <span className="text-[10px] text-green-600 font-medium w-8 text-right tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); setShowRawCounts(v => !v); }}>{showRawCounts ? s.closedCount : `${closedPct}%`}</span>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={s.answer}
                          draggable
                          onDragStart={(e) => {
                            setDragState({ questionTitle: qc.questionTitle, dragIdx: si, overIdx: si });
                            e.dataTransfer.effectAllowed = "move";
                            e.currentTarget.style.opacity = "0.4";
                          }}
                          onDragEnd={(e) => {
                            e.currentTarget.style.opacity = "1";
                            if (dragState && dragState.questionTitle === qc.questionTitle) {
                              handleDragReorder(qc.questionTitle, getOrderedStats(qc), dragState.dragIdx, dragState.overIdx);
                            }
                            setDragState(null);
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (dragState && dragState.questionTitle === qc.questionTitle && dragState.overIdx !== si) {
                              setDragState({ ...dragState, overIdx: si });
                            }
                          }}
                          onDragEnter={(e) => e.preventDefault()}
                          className={`flex items-center gap-2 text-[11px] rounded px-1 -mx-1 py-1 transition-all select-none
                            ${isDragging ? "opacity-40 scale-95 bg-indigo-100 shadow-inner" : ""}
                            ${isOver ? "border-t-2 border-indigo-400" : "border-t-2 border-transparent"}
                            ${!isDragging ? "cursor-grab hover:bg-indigo-500/10 active:cursor-grabbing" : ""}`}
                        >
                          <svg className="w-3.5 h-3.5 text-slate-400 shrink-0 mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
                          </svg>
                          <span
                            className="text-slate-300 flex-1 truncate hover:text-indigo-400 cursor-pointer"
                            title={`Click to view submissions — ${s.answer}`}
                            onClick={(e) => { e.stopPropagation(); setDrillDown({ type: "answer", questionTitle: qc.questionTitle, answer: s.answer }); }}
                          >{s.answer}</span>
                          <span className="text-slate-300 shrink-0 w-10 text-right">{s.count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Financial Data Section ── */}
      {(hasCreditScores || hasIncome || hasCreditAccess || hasFunding) && (
        <div className="flex items-center gap-3 pt-4">
          <div className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Financial Data</span>
          <div className="h-px flex-1 bg-white/[0.08]" />
        </div>
      )}

      {/* Credit Score Distribution */}
      {hasCreditScores && creditScoreBuckets.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Credit Score Distribution</h3>
            <button onClick={() => toggleGranular("creditScore")} className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
              {granularSections.has("creditScore") ? "Show Summary" : "Show Granular"}
            </button>
          </div>
          <BucketTable buckets={granularSections.has("creditScore") ? creditScoreBucketsGranular : creditScoreBuckets} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
        </section>
      )}

      {hasIncome && incomeBuckets.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Income Distribution</h3>
            <button onClick={() => toggleGranular("income")} className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
              {granularSections.has("income") ? "Show Summary" : "Show Granular"}
            </button>
          </div>
          <BucketTable buckets={granularSections.has("income") ? incomeBucketsGranular : incomeBuckets} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
        </section>
      )}

      {hasCreditAccess && creditAccessBuckets.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Credit Access Distribution</h3>
            <button onClick={() => toggleGranular("creditAccess")} className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
              {granularSections.has("creditAccess") ? "Show Summary" : "Show Granular"}
            </button>
          </div>
          <BucketTable buckets={granularSections.has("creditAccess") ? creditAccessBucketsGranular : creditAccessBuckets} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
        </section>
      )}

      {hasFunding && fundingBuckets.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Funding Distribution</h3>
            <button onClick={() => toggleGranular("funding")} className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">
              {granularSections.has("funding") ? "Show Summary" : "Show Granular"}
            </button>
          </div>
          <BucketTable buckets={granularSections.has("funding") ? fundingBucketsGranular : fundingBuckets} totalCount={totalSubs} totalBookedCount={bookedCount} hasBookingData={hasBookingData} showRawCounts={showRawCounts} onToggleDisplay={() => setShowRawCounts(v => !v)} onBucketClick={(label, emails) => setDrillDown({ type: "emails", label, emails })} />
        </section>
      )}


            {/* Empty state */}
      {totalSubs === 0 && (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No data yet.</p>
          <p className="text-xs text-slate-300 mt-1">Upload submissions, financial data, and call results to see correlation analysis.</p>
        </div>
      )}
      </div>}

      {/* ── Classic Spreadsheet View ────────────────────────────────────── */}
      {viewMode === "classic" && totalSubs > 0 && (
        <ClassicTableView
          questionCorrelations={questionCorrelations.filter((qc) => !hiddenQuestions.has(qc.questionTitle))}
          gradeBuckets={gradeBuckets}
          creditScoreBuckets={creditScoreBuckets}
          incomeBuckets={incomeBuckets}
          creditAccessBuckets={creditAccessBuckets}
          fundingBuckets={fundingBuckets}
          daysToBookingBuckets={daysToBookingBuckets}
          totalSubs={totalSubs}
          bookedCount={bookedCount}
          showedCount={showedCount}
          closedCount={closedCount}
          hasBookingData={hasBookingData}
          showRawCounts={showRawCounts}
          onCellClick={(label, emails) => setDrillDown({ type: "emails", label, emails })}
          onAnswerClick={(questionTitle, answer) => setDrillDown({ type: "answer", questionTitle, answer })}
        />
      )}


      {/* Filter Panel Slide-over */}
      {filterPanelOpen && (
        <FilterPanel
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          dateRangeField={dateRangeField}
          onDateRangeFieldChange={setDateRangeField}
          conditions={filterConditions}
          onConditionsChange={setFilterConditions}
          hasDateData={hasDateData}
          questions={app.questions.filter(q => CORRELATABLE_TYPES.includes(q.type))}
          allAnswersByQuestion={allAnswersByQuestion}
          hasFinancialData={financialRecords.length > 0}
          hasGradeData={gradeBuckets.hasTotalGrade || gradeBuckets.hasAppGrade}
          hasCallResults={callResults.length > 0}
          savedFilters={app.saved_correlation_filters ?? []}
          onSaveFilter={(name) => {
            const filter: SavedCorrelationFilter = {
              id: Math.random().toString(36).slice(2, 10),
              name,
              conditions: filterConditions,
              dateRange: dateRange ?? undefined,
            };
            const updated = { ...app, saved_correlation_filters: [...(app.saved_correlation_filters ?? []), filter] };
            onSave(updated);
          }}
          onLoadFilter={(filter) => {
            setFilterConditions(filter.conditions);
            setDateRange(filter.dateRange ?? null);
          }}
          onDeleteFilter={(filterId) => {
            const updated = { ...app, saved_correlation_filters: (app.saved_correlation_filters ?? []).filter(f => f.id !== filterId) };
            onSave(updated);
          }}
          onClearAll={clearAllFilters}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}

      {/* Drill-down modal */}
      {drillDown && (
        <CorrelationDrillDown
          questionTitle={drillDown.type === "answer" ? drillDown.questionTitle : undefined}
          answer={drillDown.type === "answer" ? drillDown.answer : undefined}
          emails={drillDown.type === "emails" ? drillDown.emails : undefined}
          label={drillDown.type === "emails" ? drillDown.label : undefined}
          questions={app.questions}
          submissions={filteredDedupedSubmissions}
          financialByEmail={financialByEmail}
          bookingByEmail={bookingByEmail}
          onClose={() => setDrillDown(null)}
        />
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ label, count, percentage }: { label: string; count: number | string; percentage?: string }) {
  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3 text-center">
      <div className="flex items-baseline justify-center gap-2 flex-wrap">
        <span className="text-xl font-black text-slate-200">{count}</span>
        {percentage && (
          <>
            <span className="text-slate-200">·</span>
            <span className="text-xl font-black text-indigo-400">{percentage}</span>
          </>
        )}
      </div>
      <p className="text-[10px] text-slate-300 mt-0.5 uppercase tracking-wider">{label}</p>
    </div>
  );
}

function FunnelViz({ total, booked, showed, closed, showRawCounts, onToggle, onStageClick }: { total: number; booked: number; showed: number; closed: number; showRawCounts?: boolean; onToggle?: () => void; onStageClick?: (stage: string) => void }) {
  if (!total) return null;
  const stages = [
    { label: "Booked", value: booked, frac: booked / total, color: "bg-indigo-400" },
    { label: "Showed", value: showed, frac: showed / total, color: "bg-emerald-400" },
    { label: "Closed", value: closed, frac: closed / total, color: "bg-green-500" },
  ];
  return (
    <div className="space-y-1.5">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="text-[10px] text-slate-300 w-20 text-right shrink-0">{s.label}</span>
          <div
            className="flex-1 h-6 bg-white/[0.02] rounded-lg overflow-hidden relative border border-white/[0.06] cursor-pointer hover:border-white/[0.15] transition-colors"
            title={`${s.value.toLocaleString()} ${s.label.toLowerCase()} (${Math.round(s.frac * 100)}%) — click to view`}
            onClick={() => onStageClick?.(s.label)}
          >
            <div className={`absolute inset-y-0 left-0 ${s.color} rounded-lg`} style={{ width: `${Math.max(1, Math.round(s.frac * 100))}%` }} />
          </div>
          <div className="flex items-center gap-2 shrink-0 w-24">
            <span className="text-sm font-bold text-slate-400 w-12 text-right tabular-nums cursor-pointer select-none hover:underline" onClick={onToggle}>{showRawCounts ? s.value.toLocaleString() : `${Math.round(s.frac * 100)}%`}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CorrelationCard({ item, variant, overallRate, rateType }: {
  item: { questionTitle: string; answer: string; bookedCount: number; showRate: number; closeRate: number; lift: number };
  variant: "positive" | "negative";
  overallRate: number;
  rateType: "show" | "close";
}) {
  const isPos = variant === "positive";
  const rate = rateType === "close" ? item.closeRate : item.showRate;
  const label = rateType === "close" ? "close rate" : "show rate";
  return (
    <div className={`rounded-xl border p-4 ${isPos ? "border-emerald-500/20 bg-emerald-500/10" : "border-red-100 bg-red-500/10"}`}>
      <div className={`text-3xl font-black leading-none ${isPos ? "text-emerald-400" : "text-red-400"}`}>
        {Math.round(rate * 100)}%
      </div>
      <div className="flex items-center gap-1.5 mt-1 mb-3">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${isPos ? "text-emerald-500" : "text-red-400"}`}>{label}</span>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isPos ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
          {item.lift >= 0 ? "+" : ""}{Math.round(item.lift * 100)}pts vs avg
        </span>
      </div>
      <div className="mb-3">
        <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden relative" title={`${Math.round(rate * 100)}% ${label}`}>
          <div className={`h-full rounded-full ${isPos ? "bg-emerald-400" : "bg-red-400"}`} style={{ width: `${Math.round(rate * 100)}%` }} />
          <div className="absolute top-0 bottom-0 w-0.5 bg-slate-400/60" style={{ left: `${Math.round(overallRate * 100)}%` }} title={`Average: ${Math.round(overallRate * 100)}%`} />
        </div>
      </div>
      <p className="text-[9px] text-slate-300 uppercase tracking-wider truncate mb-0.5">{item.questionTitle}</p>
      <p className={`text-xs font-semibold leading-snug ${isPos ? "text-emerald-400" : "text-red-400"}`}>
        &ldquo;{item.answer.length > 50 ? item.answer.slice(0, 50) + "..." : item.answer}&rdquo;
      </p>
      <p className="text-[9px] text-slate-300 mt-1.5">{item.bookedCount} booked</p>
    </div>
  );
}

function BucketTable({ buckets, totalCount, totalBookedCount = 0, hasBookingData, showRawCounts = false, onToggleDisplay, onBucketClick }: { buckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[]; bookedEmails?: string[]; showedEmails?: string[]; closedEmails?: string[] }[]; totalCount: number; totalBookedCount?: number; hasBookingData: boolean; showRawCounts?: boolean; onToggleDisplay?: () => void; onBucketClick?: (label: string, emails: string[]) => void }) {
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const gridCols = hasBookingData ? "5rem minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" : "5rem minmax(0,1fr)";
  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3 space-y-2">
      <div className="grid gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-400 pb-1 border-b border-white/[0.06]"
        style={{ gridTemplateColumns: gridCols }}
      >
        <span>Range</span>
        <span className="text-center">{hasBookingData ? "Apps" : "Count"}</span>
        {hasBookingData && <span className="text-center">Booked</span>}
        {hasBookingData && <span className="text-center">Showed</span>}
        {hasBookingData && <span className="text-center">Closed</span>}
      </div>
      {buckets.map((b) => {
        const appsPct = totalCount > 0 ? Math.round(b.count / totalCount * 100) : 0;
        const bookedPct = totalBookedCount > 0 ? Math.round(b.bookedCount / totalBookedCount * 100) : 0;
        return (
          <div key={b.label} className="grid items-center gap-2 rounded px-1 -mx-1 py-0.5"
            style={{ gridTemplateColumns: gridCols }}
          >
            <span
              className={`text-[11px] font-medium text-slate-300 ${onBucketClick ? "cursor-pointer hover:text-indigo-400 hover:underline" : ""}`}
              title={onBucketClick ? `Click to view all ${b.count} submissions for ${b.label}` : undefined}
              onClick={() => onBucketClick?.(b.label, b.emails)}
            >{b.label}</span>
            {/* Apps bar — % of total */}
            <div
              className={`flex items-center gap-1.5 ${onBucketClick ? "cursor-pointer" : ""}`}
              title={`${b.count} apps (${appsPct}% of total)${onBucketClick ? " — click to view" : ""}`}
              onClick={() => onBucketClick?.(`${b.label} — All Apps`, b.emails)}
            >
              <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-white/[0.12] rounded-full" style={{ width: `${Math.round(b.count / maxCount * 100)}%` }} />
              </div>
              <span className="text-[10px] text-slate-300 shrink-0 w-8 text-right font-semibold tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); onToggleDisplay?.(); }}>{showRawCounts ? b.count : `${appsPct}%`}</span>
            </div>
            {hasBookingData && (
              <div
                className={`flex items-center gap-1.5 ${onBucketClick ? "cursor-pointer" : ""}`}
                title={`${b.bookedCount} booked (${bookedPct}% of all bookings)${onBucketClick ? " — click to view" : ""}`}
                onClick={() => onBucketClick?.(`${b.label} — Booked`, b.bookedEmails || [])}
              >
                <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-300 rounded-full" style={{ width: `${Math.max(bookedPct > 0 ? 4 : 0, bookedPct)}%` }} />
                </div>
                <span className="text-[10px] text-indigo-400 shrink-0 w-8 text-right font-semibold tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); onToggleDisplay?.(); }}>{showRawCounts ? b.bookedCount : `${bookedPct}%`}</span>
              </div>
            )}
            {hasBookingData && (
              <div
                className={`flex items-center gap-1.5 ${onBucketClick ? "cursor-pointer" : ""}`}
                title={`${b.showedCount} showed of ${b.bookedCount} booked${onBucketClick ? " — click to view" : ""}`}
                onClick={() => onBucketClick?.(`${b.label} — Showed`, b.showedEmails || [])}
              >
                <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${b.bookedCount ? Math.round(b.showedCount / b.bookedCount * 100) : 0}%` }} />
                </div>
                <span className="text-[10px] text-emerald-400 shrink-0 w-8 text-right font-medium tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); onToggleDisplay?.(); }}>{showRawCounts ? b.showedCount : pct(b.showedCount, b.bookedCount)}</span>
              </div>
            )}
            {hasBookingData && (
              <div
                className={`flex items-center gap-1.5 ${onBucketClick ? "cursor-pointer" : ""}`}
                title={`${b.closedCount} closed of ${b.showedCount} showed${onBucketClick ? " — click to view" : ""}`}
                onClick={() => onBucketClick?.(`${b.label} — Closed`, b.closedEmails || [])}
              >
                <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full" style={{ width: `${b.showedCount ? Math.round(b.closedCount / b.showedCount * 100) : 0}%` }} />
                </div>
                <span className="text-[10px] text-green-600 shrink-0 w-8 text-right font-medium tabular-nums cursor-pointer select-none hover:underline" onClick={(e) => { e.stopPropagation(); onToggleDisplay?.(); }}>{showRawCounts ? b.closedCount : pct(b.closedCount, b.showedCount)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Classic Spreadsheet View
// ─────────────────────────────────────────────────────────────────────────────

interface ClassicRow {
  category: string;
  answer: string;
  apps: number;
  booked: number;
  showed: number;
  closed: number;
  appsPct: number;
  bookedPct: number;
  showedPct: number;
  closedPct: number;
  completionRate: number;
  showRate: number;
  closeRate: number;
  emails: string[];
  bookedEmails?: string[];
  showedEmails?: string[];
  closedEmails?: string[];
}

function ClassicTableView({
  questionCorrelations,
  gradeBuckets,
  creditScoreBuckets,
  incomeBuckets,
  creditAccessBuckets,
  fundingBuckets,
  daysToBookingBuckets,
  totalSubs,
  bookedCount,
  showedCount: totalShowedCount,
  closedCount: totalClosedCount,
  hasBookingData,
  showRawCounts,
  onCellClick,
  onAnswerClick,
}: {
  questionCorrelations: { questionTitle: string; questionType: string; stats: { answer: string; count: number; bookedCount: number; showedCount: number; closedCount: number; grades: number[]; emails: string[]; bookedEmails: string[]; showedEmails: string[]; closedEmails: string[] }[] }[];
  gradeBuckets: { totalGrade: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[]; appGrade: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[]; finGrade: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[]; hasTotalGrade: boolean; hasAppGrade: boolean; hasFinGrade: boolean };
  creditScoreBuckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[];
  incomeBuckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[];
  creditAccessBuckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[];
  fundingBuckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[];
  daysToBookingBuckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[];
  totalSubs: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
  hasBookingData: boolean;
  showRawCounts: boolean;
  onCellClick: (label: string, emails: string[]) => void;
  onAnswerClick: (questionTitle: string, answer: string) => void;
}) {
  // Build rows from all data sources
  const rows: ClassicRow[] = useMemo(() => {
    const out: ClassicRow[] = [];

    function buildRow(category: string, answer: string, count: number, bk: number, sh: number, cl: number, emails: string[], bkEmails?: string[], shEmails?: string[], clEmails?: string[]): ClassicRow {
      return {
        category, answer,
        apps: count, booked: bk, showed: sh, closed: cl,
        appsPct: totalSubs > 0 ? count / totalSubs * 100 : 0,
        bookedPct: bookedCount > 0 ? bk / bookedCount * 100 : 0,
        showedPct: totalShowedCount > 0 ? sh / totalShowedCount * 100 : 0,
        closedPct: totalClosedCount > 0 ? cl / totalClosedCount * 100 : 0,
        completionRate: count > 0 ? bk / count * 100 : 0,
        showRate: bk > 0 ? sh / bk * 100 : 0,
        closeRate: sh > 0 ? cl / sh * 100 : 0,
        emails,
        bookedEmails: bkEmails,
        showedEmails: shEmails,
        closedEmails: clEmails,
      };
    }

    // Question correlations
    for (const qc of questionCorrelations) {
      for (const s of qc.stats) {
        out.push(buildRow(qc.questionTitle, s.answer, s.count, s.bookedCount, s.showedCount, s.closedCount, s.emails, s.bookedEmails, s.showedEmails, s.closedEmails));
      }
    }

    // Grade buckets
    function addBucketRows(label: string, buckets: { label: string; count: number; bookedCount: number; showedCount: number; closedCount: number; emails: string[] }[]) {
      for (const b of buckets) {
        out.push(buildRow(label, b.label, b.count, b.bookedCount, b.showedCount, b.closedCount, b.emails));
      }
    }

    if (gradeBuckets.hasTotalGrade) addBucketRows("Total Grade", gradeBuckets.totalGrade);
    if (gradeBuckets.hasAppGrade) addBucketRows("App Grade", gradeBuckets.appGrade);
    if (gradeBuckets.hasFinGrade) addBucketRows("Financial Grade", gradeBuckets.finGrade);
    if (creditScoreBuckets.length > 0) addBucketRows("Credit Score", creditScoreBuckets);
    if (incomeBuckets.length > 0) addBucketRows("Income", incomeBuckets);
    if (creditAccessBuckets.length > 0) addBucketRows("Credit Access", creditAccessBuckets);
    if (fundingBuckets.length > 0) addBucketRows("Funding", fundingBuckets);
    if (daysToBookingBuckets.length > 0) addBucketRows("Days to Booking", daysToBookingBuckets);

    return out;
  }, [questionCorrelations, gradeBuckets, creditScoreBuckets, incomeBuckets, creditAccessBuckets, fundingBuckets, daysToBookingBuckets, totalSubs, bookedCount]);

  // Group rows by category for visual grouping
  const categories = useMemo(() => {
    const cats: { name: string; rows: ClassicRow[] }[] = [];
    let currentCat = "";
    for (const r of rows) {
      if (r.category !== currentCat) {
        currentCat = r.category;
        cats.push({ name: currentCat, rows: [] });
      }
      cats[cats.length - 1].rows.push(r);
    }
    return cats;
  }, [rows]);

  const pctFmt = (v: number) => `${v.toFixed(1)}%`;
  const cellClass = "px-2 py-1.5 text-[11px] tabular-nums cursor-pointer hover:bg-indigo-500/10 transition-colors";
  const headerClass = "px-2 py-2 text-[9px] font-bold uppercase tracking-wider text-slate-300 whitespace-nowrap bg-[#0b1120] sticky top-0 z-10";

  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden">
      <div className="overflow-x-auto max-h-[75vh]">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className={`${headerClass} text-left min-w-[120px] sticky left-0 bg-[#0b1120] z-20`}>Category</th>
              <th className={`${headerClass} text-left min-w-[140px]`}>Answer</th>
              <th className={`${headerClass} text-center`}>Apps</th>
              {hasBookingData && <th className={`${headerClass} text-center`}>Bookings</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>Shows</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>Closes</th>}
              <th className={`${headerClass} text-center`}>% of Apps</th>
              {hasBookingData && <th className={`${headerClass} text-center`}>% of Bookings</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>% of Shows</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>% of Closes</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>Completion Rate</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>Show Rate</th>}
              {hasBookingData && <th className={`${headerClass} text-center`}>Close Rate</th>}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              cat.rows.map((r, ri) => {
                const isQuestionRow = questionCorrelations.some((qc) => qc.questionTitle === r.category);
                return (
                  <tr key={`${r.category}-${r.answer}`} className={`border-b border-white/[0.06] ${ri % 2 === 0 ? "bg-white/[0.04]" : "bg-white/[0.02]"}`}>
                    {ri === 0 ? (
                      <td rowSpan={cat.rows.length} className="px-2 py-1.5 text-[11px] font-semibold text-slate-300 align-top border-r border-white/[0.06] sticky left-0 bg-[#0d1425] z-10 min-w-[120px]">
                        <span className="block max-w-[140px]" title={r.category}>{r.category}</span>
                      </td>
                    ) : null}
                    <td
                      className={`${cellClass} text-slate-300 font-medium max-w-[200px] truncate`}
                      title={`Click to view — ${r.answer}`}
                      onClick={() => isQuestionRow ? onAnswerClick(r.category, r.answer) : onCellClick(r.answer, r.emails)}
                    >{r.answer}</td>
                    <td className={`${cellClass} text-center text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer} — Apps`, r.emails)}>{showRawCounts ? r.apps : pctFmt(r.appsPct)}</td>
                    {hasBookingData && <td className={`${cellClass} text-center text-indigo-400`} onClick={() => onCellClick(`${r.category}: ${r.answer} — Booked`, r.bookedEmails ?? r.emails)}>{showRawCounts ? r.booked : pctFmt(r.bookedPct)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center text-emerald-400`} onClick={() => onCellClick(`${r.category}: ${r.answer} — Showed`, r.showedEmails ?? r.emails)}>{showRawCounts ? r.showed : pctFmt(r.showedPct)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center text-green-400`} onClick={() => onCellClick(`${r.category}: ${r.answer} — Closed`, r.closedEmails ?? r.emails)}>{showRawCounts ? r.closed : pctFmt(r.closedPct)}</td>}
                    <td className={`${cellClass} text-center text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.appsPct)}</td>
                    {hasBookingData && <td className={`${cellClass} text-center text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.bookedPct)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.showedPct)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.closedPct)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center font-semibold text-slate-300`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.completionRate)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center font-semibold text-emerald-400`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.showRate)}</td>}
                    {hasBookingData && <td className={`${cellClass} text-center font-semibold text-green-400`} onClick={() => onCellClick(`${r.category}: ${r.answer}`, r.emails)}>{pctFmt(r.closeRate)}</td>}
                  </tr>
                );
              })
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-white/[0.06]">
        <p className="text-[10px] text-slate-300">{rows.length} rows · Click any cell to drill down</p>
      </div>
    </div>
  );
}

function CorrelationDrillDown({
  questionTitle, answer, emails, label, questions, submissions, financialByEmail, bookingByEmail, onClose,
}: {
  questionTitle?: string;
  answer?: string;
  emails?: string[];
  label?: string;
  questions: ApplicationQuestion[];
  submissions: AppSubmission[];
  financialByEmail: Map<string, FinancialRecord>;
  bookingByEmail: Map<string, CallResultRecord | BookingRecord>;
  onClose: () => void;
}) {
  const question = questionTitle ? questions.find((q) => q.title === questionTitle) : undefined;
  const isMultiSelect = question?.allow_multiple_selection === true;

  const matchingSubs = useMemo(() => {
    // Email-list mode (bucket / funnel drill-down)
    if (emails) {
      const emailSet = new Set(emails.map((e) => e.toLowerCase()));
      return submissions.filter((sub) => {
        const subEmail = (sub.respondent_email ?? "").toLowerCase();
        return subEmail && emailSet.has(subEmail);
      });
    }
    // Answer mode (question drill-down)
    return submissions.filter((sub) => {
      if (!question || !answer) return false;
      const ref = question.ref ?? question.id;
      const ans = sub.answers.find(
        (a) => a.question_ref === ref || a.question_ref === question.id || a.question_title.toLowerCase() === questionTitle!.toLowerCase()
      );
      if (!ans?.value) return false;
      const raw = ans.value.trim();
      // If the question has defined choices, use contains-matching
      // (choices may themselves contain commas, so splitting on commas breaks them)
      const hasChoices = question.choices && question.choices.length > 0;
      if (hasChoices || isMultiSelect) {
        return raw.toLowerCase().includes(answer.toLowerCase());
      }
      return raw.toLowerCase() === answer.toLowerCase();
    });
  }, [submissions, question, questionTitle, answer, isMultiSelect, emails]);

  const modalTitle = label ?? questionTitle ?? "Drill-Down";
  const modalSubtitle = answer
    ? <>Showing <span className="font-semibold text-indigo-400">{matchingSubs.length}</span> submissions where answer = <span className="font-semibold text-indigo-400">&ldquo;{answer}&rdquo;</span></>
    : <>Showing <span className="font-semibold text-indigo-400">{matchingSubs.length}</span> matching submissions</>;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-slate-900 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-200 truncate">{modalTitle}</h3>
            <p className="text-xs text-slate-300 mt-0.5">{modalSubtitle}</p>
          </div>
          <button onClick={onClose} className="text-slate-300 hover:text-slate-300 p-1 shrink-0 ml-4">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-auto divide-y divide-white/[0.06]">
          {matchingSubs.map((sub, idx) => {
            const email = sub.respondent_email?.toLowerCase() ?? "";
            const booking = email ? bookingByEmail.get(email) : undefined;
            const fin = email ? financialByEmail.get(email) : undefined;

            return (
              <details key={sub.id} className="group">
                <summary className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-white/[0.04] transition-colors list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-[10px] text-slate-400 font-mono w-5 shrink-0">{idx + 1}</span>
                  <svg className="w-3 h-3 text-slate-400 shrink-0 group-open:rotate-90 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-medium text-slate-300 truncate flex-1">{sub.respondent_name || sub.respondent_email || "(unknown)"}</span>
                  {sub.respondent_email && sub.respondent_name && (
                    <span className="text-[10px] text-slate-300 truncate max-w-[160px] shrink-0">{sub.respondent_email}</span>
                  )}
                  {sub.grade?.final_grade != null && (
                    <span className="text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full px-1.5 py-0.5 shrink-0">{sub.grade.final_grade.toFixed(1)}</span>
                  )}
                  {booking && <span className="text-[10px] font-semibold bg-indigo-500/10 text-indigo-400 rounded-full px-1.5 py-0.5 shrink-0">booked</span>}
                  {booking?.showed && <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 rounded-full px-1.5 py-0.5 shrink-0">showed</span>}
                  {booking?.closed && <span className="text-[10px] font-semibold bg-green-500/10 text-green-400 rounded-full px-1.5 py-0.5 shrink-0">closed</span>}
                </summary>
                <div className="px-5 pb-4 pt-2 bg-white/[0.02] border-t border-white/[0.06]">
                  {/* Key info row */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                    <div>
                      <span className="block text-[9px] font-bold uppercase text-slate-300">Submitted</span>
                      <span className="text-[11px] text-slate-300">{sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[9px] font-bold uppercase text-slate-300">Booking Date</span>
                      <span className="text-[11px] text-slate-300">{sub.booking_date ?? "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[9px] font-bold uppercase text-slate-300">Credit Score</span>
                      <span className="text-[11px] text-slate-300">{fin?.credit_score ?? "—"}</span>
                    </div>
                    <div>
                      <span className="block text-[9px] font-bold uppercase text-slate-300">Income</span>
                      <span className="text-[11px] text-slate-300">{fin?.estimated_income != null ? `$${fin.estimated_income.toLocaleString()}` : "—"}</span>
                    </div>
                  </div>
                  {/* Answers */}
                  <div className="space-y-1.5">
                    <span className="block text-[9px] font-bold uppercase text-slate-300">Answers</span>
                    {questions.map((q) => {
                      const ref = q.ref ?? q.id;
                      const ans = sub.answers.find((a) => a.question_ref === ref || a.question_ref === q.id || a.question_title.toLowerCase() === q.title.toLowerCase());
                      const val = ans?.value?.trim() || "";
                      return (
                        <div key={q.id} className="grid grid-cols-[200px,1fr] gap-2 text-[11px]">
                          <span className="text-slate-300 truncate" title={q.title}>{q.title}</span>
                          <span className="text-slate-400">{val || <span className="text-slate-400">—</span>}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </details>
            );
          })}
          {matchingSubs.length === 0 && (
            <div className="px-5 py-12 text-center text-slate-300 text-xs">No matching submissions found.</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/[0.08] flex items-center justify-between shrink-0 bg-white/[0.02]">
          <p className="text-[10px] text-slate-300">
            {matchingSubs.length} submissions
          </p>
          <button onClick={onClose} className="text-xs font-semibold px-4 py-1.5 bg-white/[0.08] text-slate-300 rounded hover:bg-white/[0.12] transition-colors">Close</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Panel
// ─────────────────────────────────────────────────────────────────────────────

function FilterPanel({
  dateRange,
  onDateRangeChange,
  dateRangeField,
  onDateRangeFieldChange,
  conditions,
  onConditionsChange,
  hasDateData,
  questions,
  allAnswersByQuestion,
  hasFinancialData,
  hasGradeData,
  hasCallResults,
  savedFilters,
  onSaveFilter,
  onLoadFilter,
  onDeleteFilter,
  onClearAll,
  onClose,
}: {
  dateRange: { start: string; end: string } | null;
  onDateRangeChange: (v: { start: string; end: string } | null) => void;
  dateRangeField: "submitted_at" | "booking_date";
  onDateRangeFieldChange: (v: "submitted_at" | "booking_date") => void;
  conditions: FilterCondition[];
  onConditionsChange: (v: FilterCondition[]) => void;
  hasDateData: boolean;
  questions: ApplicationQuestion[];
  allAnswersByQuestion: Map<string, string[]>;
  hasFinancialData: boolean;
  hasGradeData: boolean;
  hasCallResults: boolean;
  savedFilters: SavedCorrelationFilter[];
  onSaveFilter: (name: string) => void;
  onLoadFilter: (f: SavedCorrelationFilter) => void;
  onDeleteFilter: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const [saveName, setSaveName] = useState("");

  const addCondition = () => {
    const newCond: FilterCondition = {
      id: Math.random().toString(36).slice(2, 10),
      field: "question_answer",
      questionTitle: questions[0]?.title ?? "",
      operator: "equals",
      value: "",
    };
    onConditionsChange([...conditions, newCond]);
  };

  const updateCondition = (id: string, patch: Partial<FilterCondition>) => {
    onConditionsChange(conditions.map(c => c.id === id ? { ...c, ...patch } : c));
  };

  const removeCondition = (id: string) => {
    onConditionsChange(conditions.filter(c => c.id !== id));
  };

  // Build field options
  const fieldOptions: { value: FilterFieldType; label: string; group: string }[] = [];
  for (const q of questions) {
    fieldOptions.push({ value: "question_answer", label: q.title, group: "Questions" });
  }
  if (hasGradeData) {
    fieldOptions.push({ value: "final_grade", label: "Final Grade", group: "Grades" });
    fieldOptions.push({ value: "answer_grade", label: "Application Grade", group: "Grades" });
  }
  if (hasFinancialData) {
    fieldOptions.push({ value: "credit_score", label: "Credit Score", group: "Financial" });
    fieldOptions.push({ value: "estimated_income", label: "Income", group: "Financial" });
    fieldOptions.push({ value: "credit_access", label: "Credit Access", group: "Financial" });
    fieldOptions.push({ value: "access_to_funding", label: "Funding", group: "Financial" });
    fieldOptions.push({ value: "financial_grade", label: "Financial Grade", group: "Financial" });
  }
  if (hasCallResults) {
    fieldOptions.push({ value: "booked", label: "Booked", group: "Status" });
    fieldOptions.push({ value: "showed", label: "Showed", group: "Status" });
    fieldOptions.push({ value: "closed", label: "Closed", group: "Status" });
  }

  const getOperatorsForField = (field: FilterFieldType): { value: FilterOperator; label: string }[] => {
    if (field === "question_answer") {
      return [
        { value: "equals", label: "is" },
        { value: "not_equals", label: "is not" },
        { value: "contains", label: "contains" },
        { value: "not_contains", label: "does not contain" },
      ];
    }
    if (field === "booked" || field === "showed" || field === "closed") {
      return [{ value: "is", label: "is" }];
    }
    return [
      { value: "equals", label: "equals" },
      { value: "gte", label: "≥" },
      { value: "lte", label: "≤" },
      { value: "between", label: "between" },
    ];
  };

  const getAnswerOptions = (questionTitle: string): string[] => {
    return allAnswersByQuestion.get(questionTitle) ?? [];
  };

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[380px] max-w-[90vw] bg-slate-900 border-l border-white/[0.08] shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between shrink-0">
          <h3 className="text-sm font-bold text-slate-200">Filters</h3>
          <button onClick={onClose} className="text-slate-300 hover:text-slate-300 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 space-y-6">
          {/* Date Range */}
          {hasDateData && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Date Range</p>
                {dateRange && (
                  <button onClick={() => onDateRangeChange(null)} className="text-[10px] text-red-400 hover:text-red-400 font-semibold">Clear</button>
                )}
              </div>
              <select
                value={dateRangeField}
                onChange={(e) => onDateRangeFieldChange(e.target.value as "submitted_at" | "booking_date")}
                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300 mb-2"
              >
                <option value="submitted_at">Application Date</option>
                <option value="booking_date">Booking Date</option>
              </select>
              {/* Quick presets */}
              <div className="flex flex-wrap gap-1 mb-2">
                {[
                  { label: "Last 7 days", days: 7 },
                  { label: "Last 14 days", days: 14 },
                  { label: "Last 30 days", days: 30 },
                  { label: "Last 60 days", days: 60 },
                  { label: "Last 90 days", days: 90 },
                  { label: "This month", days: -1 },
                  { label: "Last month", days: -2 },
                  { label: "This year", days: -3 },
                ].map((preset) => {
                  const onClick = () => {
                    const today = new Date();
                    let start: string;
                    let end: string = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
                    if (preset.days > 0) {
                      const s = new Date(today);
                      s.setDate(s.getDate() - preset.days);
                      start = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
                    } else if (preset.days === -1) {
                      start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
                    } else if (preset.days === -2) {
                      const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                      const lmEnd = new Date(today.getFullYear(), today.getMonth(), 0);
                      start = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, "0")}-01`;
                      end = `${lmEnd.getFullYear()}-${String(lmEnd.getMonth() + 1).padStart(2, "0")}-${String(lmEnd.getDate()).padStart(2, "0")}`;
                    } else {
                      start = `${today.getFullYear()}-01-01`;
                    }
                    onDateRangeChange({ start, end });
                  };
                  return (
                    <button
                      key={preset.label}
                      onClick={onClick}
                      className="px-2 py-0.5 text-[10px] font-medium rounded border border-white/[0.08] text-slate-300 hover:bg-indigo-500/10 hover:border-indigo-500/30 hover:text-indigo-400 transition-colors"
                    >{preset.label}</button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateRange?.start ?? ""}
                  onChange={(e) => {
                    const start = e.target.value;
                    const end = dateRange?.end && dateRange.end >= start ? dateRange.end : start;
                    onDateRangeChange({ start, end });
                  }}
                  className="flex-1 min-w-0 bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
                <span className="text-[10px] text-slate-300 shrink-0">to</span>
                <input
                  type="date"
                  value={dateRange?.end ?? ""}
                  min={dateRange?.start ?? ""}
                  onChange={(e) => {
                    const end = e.target.value;
                    const start = dateRange?.start && dateRange.start <= end ? dateRange.start : end;
                    onDateRangeChange({ start, end });
                  }}
                  className="flex-1 min-w-0 bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
            </div>
          )}

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Conditions</p>
              <button onClick={addCondition} className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold">+ Add Condition</button>
            </div>
            {conditions.length === 0 && (
              <p className="text-[10px] text-slate-400 italic">No conditions added. Click &quot;+ Add Condition&quot; to start filtering.</p>
            )}
            <div className="space-y-3">
              {conditions.map((cond) => {
                const operators = getOperatorsForField(cond.field);
                const isBoolField = cond.field === "booked" || cond.field === "showed" || cond.field === "closed";
                const isQuestionField = cond.field === "question_answer";
                const isNumericField = !isQuestionField && !isBoolField;
                const answerOptions = isQuestionField ? getAnswerOptions(cond.questionTitle ?? "") : [];

                return (
                  <div key={cond.id} className="bg-white/[0.02] border border-white/[0.08] rounded-lg p-3 space-y-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Field selector */}
                      <select
                        value={isQuestionField ? `q:${cond.questionTitle}` : cond.field}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.startsWith("q:")) {
                            updateCondition(cond.id, { field: "question_answer", questionTitle: val.slice(2), operator: "equals" as FilterOperator, value: "" });
                          } else {
                            const f = val as FilterFieldType;
                            const isBool = f === "booked" || f === "showed" || f === "closed";
                            updateCondition(cond.id, {
                              field: f,
                              questionTitle: undefined,
                              operator: isBool ? "is" : "equals",
                              value: isBool ? true : "",
                            });
                          }
                        }}
                        className="flex-1 min-w-0 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300 truncate"
                      >
                        {questions.length > 0 && (
                          <optgroup label="Questions">
                            {questions.map(q => (
                              <option key={q.id} value={`q:${q.title}`}>{q.title}</option>
                            ))}
                          </optgroup>
                        )}
                        {hasGradeData && (
                          <optgroup label="Grades">
                            <option value="final_grade">Final Grade</option>
                            <option value="answer_grade">Application Grade</option>
                          </optgroup>
                        )}
                        {hasFinancialData && (
                          <optgroup label="Financial">
                            <option value="credit_score">Credit Score</option>
                            <option value="estimated_income">Income</option>
                            <option value="credit_access">Credit Access</option>
                            <option value="access_to_funding">Funding</option>
                            <option value="financial_grade">Financial Grade</option>
                          </optgroup>
                        )}
                        {hasCallResults && (
                          <optgroup label="Status">
                            <option value="booked">Booked</option>
                            <option value="showed">Showed</option>
                            <option value="closed">Closed</option>
                          </optgroup>
                        )}
                      </select>
                      <button onClick={() => removeCondition(cond.id)} className="text-slate-400 hover:text-red-400 transition-colors shrink-0">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>

                    <div className="flex items-center gap-2 min-w-0">
                      {/* Operator */}
                      <select
                        value={cond.operator}
                        onChange={(e) => {
                          const op = e.target.value as FilterOperator;
                          const newVal = op === "between" ? [0, 100] : (isBoolField ? true : cond.value);
                          updateCondition(cond.id, { operator: op, value: newVal as string | number | boolean | [number, number] });
                        }}
                        className="border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      >
                        {operators.map(op => (
                          <option key={op.value} value={op.value}>{op.label}</option>
                        ))}
                      </select>

                      {/* Value input */}
                      {isBoolField && (
                        <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded p-0.5">
                          <button
                            onClick={() => updateCondition(cond.id, { value: true })}
                            className={`px-3 py-1 text-[11px] font-semibold rounded transition-colors ${cond.value === true ? "bg-indigo-500 text-white" : "text-slate-300"}`}
                          >Yes</button>
                          <button
                            onClick={() => updateCondition(cond.id, { value: false })}
                            className={`px-3 py-1 text-[11px] font-semibold rounded transition-colors ${cond.value === false ? "bg-indigo-500 text-white" : "text-slate-300"}`}
                          >No</button>
                        </div>
                      )}
                      {isQuestionField && (cond.operator === "equals" || cond.operator === "not_equals") && (
                        answerOptions.length > 0 ? (
                          <select
                            value={String(cond.value)}
                            onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                            className="flex-1 min-w-0 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-indigo-300 truncate"
                          >
                            <option value="">Select answer…</option>
                            {answerOptions.map(a => (
                              <option key={a} value={a}>{a}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={String(cond.value ?? "")}
                            onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                            placeholder="Value…"
                            className="flex-1 min-w-0 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        )
                      )}
                      {isQuestionField && (cond.operator === "contains" || cond.operator === "not_contains") && (
                        <input
                          type="text"
                          value={String(cond.value ?? "")}
                          onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                          placeholder="Type text…"
                          className="flex-1 min-w-0 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                      )}
                      {isNumericField && cond.operator !== "between" && (
                        <input
                          type="number"
                          value={String(cond.value ?? "")}
                          onChange={(e) => updateCondition(cond.id, { value: e.target.value === "" ? "" : Number(e.target.value) })}
                          placeholder="Value…"
                          className="flex-1 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                        />
                      )}
                      {isNumericField && cond.operator === "between" && (
                        <div className="flex items-center gap-1.5 flex-1">
                          <input
                            type="number"
                            value={String(Array.isArray(cond.value) ? cond.value[0] : "")}
                            onChange={(e) => {
                              const arr = Array.isArray(cond.value) ? [...cond.value] : [0, 100];
                              arr[0] = Number(e.target.value);
                              updateCondition(cond.id, { value: arr as [number, number] });
                            }}
                            placeholder="Min"
                            className="flex-1 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                          <span className="text-[10px] text-slate-300">–</span>
                          <input
                            type="number"
                            value={String(Array.isArray(cond.value) ? cond.value[1] : "")}
                            onChange={(e) => {
                              const arr = Array.isArray(cond.value) ? [...cond.value] : [0, 100];
                              arr[1] = Number(e.target.value);
                              updateCondition(cond.id, { value: arr as [number, number] });
                            }}
                            placeholder="Max"
                            className="flex-1 border border-white/[0.08] rounded px-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Saved Filters */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300 mb-2">Saved Filters</p>
            {savedFilters.length === 0 && (
              <p className="text-[10px] text-slate-400 italic mb-2">No saved filters yet.</p>
            )}
            {savedFilters.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {savedFilters.map((f) => (
                  <div key={f.id} className="flex items-center justify-between bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2">
                    <span className="text-[11px] font-medium text-slate-300 truncate flex-1">{f.name}</span>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      <button onClick={() => onLoadFilter(f)} className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300">Load</button>
                      <button onClick={() => onDeleteFilter(f.id)} className="text-[10px] font-semibold text-red-400 hover:text-red-400">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(conditions.length > 0 || dateRange) && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Filter name…"
                  className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
                <button
                  onClick={() => {
                    if (saveName.trim()) {
                      onSaveFilter(saveName.trim());
                      setSaveName("");
                    }
                  }}
                  disabled={!saveName.trim()}
                  className="text-[11px] font-semibold px-3 py-1.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-40"
                >Save Current</button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.08] flex items-center justify-between shrink-0 bg-white/[0.02]">
          <button onClick={onClearAll} className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors">Clear All</button>
          <button onClick={onClose} className="text-[11px] font-semibold px-4 py-1.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors">Done</button>
        </div>
      </div>
    </div>
  );
}
