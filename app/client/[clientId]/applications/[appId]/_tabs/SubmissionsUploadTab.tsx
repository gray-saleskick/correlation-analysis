"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import type {
  Application,
  ApplicationQuestion,
  AppSubmission,
  AppSubmissionAnswer,
  CallResultRecord,
  LoadSourceType,
  LoadHistorySourceData,
} from "@/lib/types";
import {
  parseFileToRows,
  buildInitialMapping,
  parseBoolValue,
  parseDollarAmount,
} from "@/lib/csvUtils";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";
import { uid, mergeAnswers } from "../_utils";
import type { SubmissionsTabProps } from "../_tab-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
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

// ─────────────────────────────────────────────────────────────────────────────
// SubmissionsUploadTab
// ─────────────────────────────────────────────────────────────────────────────

export default function SubmissionsUploadTab({ app, onSave, uploadType, remapState, onRemapComplete }: SubmissionsTabProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [mapping, setMapping] = useState<{ file_column: string; target: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");
  const [sourceTz, setSourceTz] = useState("UTC");
  const [targetTz, setTargetTz] = useState("US/Eastern");

  const questionTitles = app.questions.map((q) => q.title);

  // Pre-fill from re-map state
  useEffect(() => {
    if (remapState?.sourceData?.csv_rows && remapState.sourceData.csv_rows.length > 0) {
      const rows = remapState.sourceData.csv_rows;
      const headers = Object.keys(rows[0] ?? {});
      setParsed({ headers, rows, rowCount: rows.length });
      if (remapState.sourceData.csv_mapping) {
        setMapping(remapState.sourceData.csv_mapping.map(m => ({ file_column: m.file_column, target: m.target })));
      } else {
        setMapping(buildInitialMapping(headers, questionTitles));
      }
    }
  }, [remapState]);

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

    const preSnapshot = captureDataSnapshot(app);
    let updated: Application = {
      ...app,
      questions: newQuestions,
      submissions: finalSubmissions,
    };
    updated = addLoadHistoryEntry(
      updated,
      "csv-submissions",
      `Imported ${dedupedNew.length} submissions from CSV (${importMode})`,
      dedupedNew.length,
      preSnapshot,
      parsed ? {
        csv_rows: parsed.rows,
        csv_mapping: mapping.map(m => ({ file_column: m.file_column, target: m.target })),
      } : undefined
    );

    onSave(updated);
    setParsed(null);
    setMapping([]);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
    if (remapState && onRemapComplete) onRemapComplete();
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
