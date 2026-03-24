"use client";

import { useState, useMemo, useRef } from "react";
import type {
  Application,
  ApplicationQuestion,
  AppSubmission,
  AppSubmissionAnswer,
  TypeformQuestionType,
} from "@/lib/types";
import {
  parseFileToRows,
  buildInitialMapping,
  parseDollarAmount,
} from "@/lib/csvUtils";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";
import { uid, ALL_QUESTION_TYPES, CORRELATABLE_TYPES } from "../_utils";
import type { QuestionsTabProps } from "../_tab-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
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
  allQuestions,
  onUpdate,
  onUpdateSubmissions,
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
  allQuestions: ApplicationQuestion[];
  onUpdate: (updates: Partial<ApplicationQuestion>) => void;
  onUpdateSubmissions: (updated: AppSubmission[]) => void;
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
    const values = new Set<string>();
    const isMulti = question.allow_multiple_selection === true;
    for (const sub of submissions) {
      const ans = sub.answers.find(
        (a) => a.question_ref === qRef || a.question_title.toLowerCase() === question.title.toLowerCase()
      );
      if (ans?.value) {
        if (isMulti) {
          // Split comma-delimited values into individual answers
          for (const part of ans.value.split(",")) {
            const trimmed = part.trim();
            if (trimmed) values.add(trimmed);
          }
        } else {
          values.add(ans.value.trim());
        }
      }
    }
    const choiceList = Array.from(values).sort();
    if (!choiceList.length) return;
    onUpdate({
      choices: choiceList.map((label) => ({ id: uid(), label })),
    });
  }

  // ── Per-choice submission counts & viewer ──
  const [viewingChoice, setViewingChoice] = useState<string | null>(null);

  const choiceSubmissionMap = useMemo(() => {
    if (!isChoiceType || !(question.choices?.length)) return new Map<string, { sub: AppSubmission; answerValue: string }[]>();
    const isMulti = question.allow_multiple_selection === true;
    const map = new Map<string, { sub: AppSubmission; answerValue: string }[]>();
    for (const choice of question.choices) {
      map.set(choice.label, []);
    }
    // Also track unmatched
    map.set("__unmatched__", []);
    for (const sub of submissions) {
      const ans = sub.answers.find(
        (a) => a.question_ref === qRef || a.question_title.toLowerCase() === question.title.toLowerCase()
      );
      if (!ans?.value || !ans.value.trim()) continue;
      if (isMulti) {
        const parts = ans.value.split(",").map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          const bucket = map.has(part) ? part : "__unmatched__";
          map.get(bucket)!.push({ sub, answerValue: ans.value });
        }
      } else {
        const val = ans.value.trim();
        const bucket = map.has(val) ? val : "__unmatched__";
        map.get(bucket)!.push({ sub, answerValue: ans.value });
      }
    }
    return map;
  }, [submissions, question.choices, question.title, question.allow_multiple_selection, qRef, isChoiceType]);

  const unmatchedEntries = choiceSubmissionMap.get("__unmatched__") ?? [];

  // Editing state: which submission is expanded in the full editor
  const [editingSubId, setEditingSubId] = useState<string | null>(null);
  // Local edits buffer: subId → { questionId → newValue }
  const [editBuffer, setEditBuffer] = useState<Record<string, Record<string, string>>>({});

  function updateSubmissionAnswer(subId: string, questionRef: string, questionTitle: string, newValue: string) {
    const updated = submissions.map((sub) => {
      if (sub.id !== subId) return sub;
      return {
        ...sub,
        answers: sub.answers.map((a) => {
          if (a.question_ref === questionRef || a.question_title.toLowerCase() === questionTitle.toLowerCase()) {
            return { ...a, value: newValue };
          }
          return a;
        }),
      };
    });
    onUpdateSubmissions(updated);
  }

  function saveEditBuffer(subId: string, sub: AppSubmission) {
    const edits = editBuffer[subId];
    if (!edits || Object.keys(edits).length === 0) return;
    const updated = submissions.map((s) => {
      if (s.id !== subId) return s;
      // Build new answers array: update existing answers and add new ones for questions that had no answer
      const newAnswers = [...s.answers];
      for (const [qId, newValue] of Object.entries(edits)) {
        const q = allQuestions.find((qq) => qq.id === qId);
        if (!q) continue;
        const qRefKey = q.ref ?? q.id;
        const existingIdx = newAnswers.findIndex(
          (a) => a.question_ref === qRefKey || a.question_title.toLowerCase() === q.title.toLowerCase()
        );
        if (existingIdx >= 0) {
          newAnswers[existingIdx] = { ...newAnswers[existingIdx], value: newValue };
        } else if (newValue) {
          // Add a new answer entry for this question
          newAnswers.push({ question_ref: qRefKey, question_title: q.title, value: newValue });
        }
      }
      return { ...s, answers: newAnswers };
    });
    onUpdateSubmissions(updated);
    setEditBuffer((prev) => { const next = { ...prev }; delete next[subId]; return next; });
  }

  const viewingEntries = viewingChoice ? (choiceSubmissionMap.get(viewingChoice) ?? []) : [];
  const allChoiceLabels = (question.choices ?? []).map((c) => c.label);

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

          {/* Type + Allow multiple selection */}
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
            {question.type === "multiple_choice" && (
              <label className="flex items-center gap-1.5 text-xs text-slate-300 pb-2">
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

          {/* Choices (for choice-type questions) */}
          {isChoiceType && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-300">Answer Choices</label>
                {(question.choices?.length ?? 0) > 0 ? (
                  <button
                    onClick={() => onUpdate({ choices: undefined })}
                    className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 font-medium transition-colors"
                    title="Remove all answer choices"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Remove all answers
                  </button>
                ) : totalSubs > 0 ? (
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
                ) : null}
              </div>
              <div className="space-y-1.5">
                {(question.choices ?? []).map((choice, ci) => {
                  const count = (choiceSubmissionMap.get(choice.label) ?? []).length;
                  return (
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
                    {count > 0 && (
                      <button
                        onClick={() => setViewingChoice(choice.label)}
                        className="shrink-0 min-w-[28px] h-6 bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 hover:text-indigo-300 border border-indigo-500/20 rounded-full px-1.5 text-[10px] font-bold tabular-nums transition-colors"
                        title={`${count} submission${count !== 1 ? "s" : ""} — click to view & edit`}
                      >
                        {count}
                      </button>
                    )}
                    <input
                      type="text"
                      value={choice.group ?? ""}
                      onChange={(e) => {
                        const updated = [...(question.choices ?? [])];
                        updated[ci] = { ...updated[ci], group: e.target.value || undefined };
                        onUpdate({ choices: updated });
                      }}
                      list={`groups-${question.id}`}
                      className="w-36 shrink-0 bg-white/[0.03] border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 placeholder:text-slate-600"
                      placeholder="Map to…"
                      title="Group label for correlation analysis"
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
                  );
                })}
                {/* Unmatched answers row */}
                {unmatchedEntries.length > 0 && (
                  <div className="flex items-center gap-1.5 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg px-2.5 py-1.5">
                    <span className="flex-1 text-xs text-amber-400 font-medium">Unmatched answers</span>
                    <button
                      onClick={() => setViewingChoice("__unmatched__")}
                      className="shrink-0 min-w-[28px] h-6 bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300 border border-amber-500/20 rounded-full px-1.5 text-[10px] font-bold tabular-nums transition-colors"
                      title={`${unmatchedEntries.length} submission${unmatchedEntries.length !== 1 ? "s" : ""} with answers not matching any choice — click to reassign`}
                    >
                      {unmatchedEntries.length}
                    </button>
                  </div>
                )}
                {/* Datalist for autocomplete of existing group names */}
                <datalist id={`groups-${question.id}`}>
                  {Array.from(new Set((question.choices ?? []).map(c => c.group).filter(Boolean))).map(g => (
                    <option key={g} value={g!} />
                  ))}
                </datalist>
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

      {/* ── Submission Viewer / Editor Modal ── */}
      {viewingChoice !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={() => { setViewingChoice(null); setEditingSubId(null); setEditBuffer({}); }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative bg-slate-900 border border-white/[0.1] rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08]">
              <div>
                <h3 className="text-sm font-bold text-slate-200">
                  {viewingChoice === "__unmatched__" ? "Unmatched Answers" : `"${viewingChoice}"`}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {viewingEntries.length} submission{viewingEntries.length !== 1 ? "s" : ""} &middot; {question.title}
                </p>
              </div>
              <button onClick={() => { setViewingChoice(null); setEditingSubId(null); setEditBuffer({}); }} className="text-slate-400 hover:text-slate-200 transition-colors p-1">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Entries */}
            <div className="overflow-y-auto flex-1 divide-y divide-white/[0.06]">
              {viewingEntries.length === 0 ? (
                <div className="px-5 py-8 text-center text-slate-400 text-sm">No submissions found.</div>
              ) : (
                viewingEntries.map(({ sub, answerValue }) => {
                  const isEditing = editingSubId === sub.id;
                  const subEdits = editBuffer[sub.id] ?? {};
                  return (
                    <div key={sub.id} className="px-5 py-3">
                      {/* Summary row — always visible */}
                      <div
                        className="flex items-center gap-3 cursor-pointer"
                        onClick={() => {
                          if (isEditing) {
                            // Save any pending edits when collapsing
                            saveEditBuffer(sub.id, sub);
                            setEditingSubId(null);
                          } else {
                            // Save previous edits if switching
                            if (editingSubId) saveEditBuffer(editingSubId, submissions.find((s) => s.id === editingSubId)!);
                            setEditingSubId(sub.id);
                          }
                        }}
                      >
                        <svg className={`w-3 h-3 text-slate-500 shrink-0 transition-transform ${isEditing ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-300 font-medium truncate">
                            {sub.respondent_email || sub.respondent_name || sub.id}
                          </p>
                          <p className="text-[10px] text-slate-500 mt-0.5 truncate">
                            This Q: <span className="text-slate-400">{answerValue}</span>
                          </p>
                        </div>
                        {Object.keys(subEdits).length > 0 && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">unsaved</span>
                        )}
                        <span className="text-[10px] text-slate-500">{isEditing ? "collapse" : "edit all"}</span>
                      </div>

                      {/* Expanded: full submission editor — shows ALL questions */}
                      {isEditing && (
                        <div className="mt-3 ml-6 space-y-1.5">
                          {allQuestions.map((q) => {
                            const qRefKey = q.ref ?? q.id;
                            const isCurrentQ = q.id === question.id;
                            const hasChoices = CHOICE_QUESTION_TYPES.has(q.type) && q.choices?.length;
                            // Find existing answer for this question
                            const existingAns = sub.answers.find(
                              (a) => a.question_ref === qRefKey || a.question_title.toLowerCase() === q.title.toLowerCase()
                            );
                            const currentValue = existingAns?.value ?? "";
                            // Edit buffer keyed by question id
                            const editedValue = subEdits[q.id] !== undefined ? subEdits[q.id] : currentValue;

                            return (
                              <div key={q.id} className={`flex items-start gap-2 rounded-lg px-2.5 py-2 ${isCurrentQ ? "bg-indigo-500/[0.08] border border-indigo-500/20" : "bg-white/[0.02] border border-white/[0.04]"}`}>
                                <div className="flex-1 min-w-0">
                                  <p className={`text-[10px] font-semibold uppercase tracking-wider mb-1 ${isCurrentQ ? "text-indigo-400" : "text-slate-500"}`}>
                                    {q.title}
                                    {isCurrentQ && <span className="ml-1 text-[8px] text-indigo-300">(this question)</span>}
                                    {!existingAns && <span className="ml-1 text-[8px] text-amber-400">(no answer)</span>}
                                  </p>
                                  {hasChoices ? (
                                    <select
                                      value={editedValue}
                                      onChange={(e) => {
                                        setEditBuffer((prev) => ({
                                          ...prev,
                                          [sub.id]: { ...(prev[sub.id] ?? {}), [q.id]: e.target.value },
                                        }));
                                      }}
                                      className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                                    >
                                      {editedValue && !q.choices!.some((c) => c.label === editedValue) && (
                                        <option value={editedValue}>{editedValue} (current - unmatched)</option>
                                      )}
                                      <option value="">— empty —</option>
                                      {q.choices!.map((c) => (
                                        <option key={c.id} value={c.label}>{c.label}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={editedValue}
                                      onChange={(e) => {
                                        setEditBuffer((prev) => ({
                                          ...prev,
                                          [sub.id]: { ...(prev[sub.id] ?? {}), [q.id]: e.target.value },
                                        }));
                                      }}
                                      className="w-full bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                                      placeholder="(empty)"
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                          {/* Save button */}
                          <div className="flex justify-end pt-1.5">
                            <button
                              onClick={() => {
                                saveEditBuffer(sub.id, sub);
                                setEditingSubId(null);
                              }}
                              disabled={Object.keys(subEdits).length === 0}
                              className={`px-3 py-1.5 text-[11px] font-semibold rounded-lg transition-colors ${
                                Object.keys(subEdits).length > 0
                                  ? "bg-indigo-500 text-white hover:bg-indigo-600"
                                  : "bg-white/[0.04] text-slate-500 cursor-not-allowed"
                              }`}
                            >
                              Save Changes
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {/* Footer with bulk actions */}
            {viewingEntries.length > 0 && (
              <div className="px-5 py-3 border-t border-white/[0.08] space-y-2.5">
                {/* Bulk reassign for unmatched */}
                {viewingChoice === "__unmatched__" && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-400">Reassign all (this question) to:</span>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        for (const { sub } of viewingEntries) {
                          updateSubmissionAnswer(sub.id, qRef, question.title, e.target.value);
                        }
                        setViewingChoice(null);
                        setEditingSubId(null);
                      }}
                      className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                      <option value="">— Select —</option>
                      {allChoiceLabels.map((label) => (
                        <option key={label} value={label}>{label}</option>
                      ))}
                    </select>
                  </div>
                )}
                {/* Bulk migrate to another question */}
                {viewingChoice !== "__unmatched__" && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-amber-400 font-medium">Migrate all {viewingEntries.length} to question:</span>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        const targetQ = allQuestions.find((q) => q.id === e.target.value);
                        if (!targetQ) return;
                        const targetRef = targetQ.ref ?? targetQ.id;
                        const answerValue = viewingChoice!;
                        // For each submission: set the answer on the target question, clear from current question
                        const subIds = new Set(viewingEntries.map(({ sub }) => sub.id));
                        const updated = submissions.map((sub) => {
                          if (!subIds.has(sub.id)) return sub;
                          let newAnswers = sub.answers.map((a) => {
                            // Clear from current question
                            if (a.question_ref === qRef || a.question_title.toLowerCase() === question.title.toLowerCase()) {
                              return { ...a, value: "" };
                            }
                            // Set on target question if answer already exists
                            if (a.question_ref === targetRef || a.question_title.toLowerCase() === targetQ.title.toLowerCase()) {
                              return { ...a, value: answerValue };
                            }
                            return a;
                          });
                          // If target question had no existing answer entry, add one
                          const hasTarget = newAnswers.some(
                            (a) => a.question_ref === targetRef || a.question_title.toLowerCase() === targetQ.title.toLowerCase()
                          );
                          if (!hasTarget) {
                            newAnswers.push({ question_ref: targetRef, question_title: targetQ.title, value: answerValue });
                          }
                          return { ...sub, answers: newAnswers };
                        });
                        onUpdateSubmissions(updated);
                        setViewingChoice(null);
                        setEditingSubId(null);
                        setEditBuffer({});
                      }}
                      className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 max-w-[350px]"
                    >
                      <option value="">— Select target question —</option>
                      {allQuestions
                        .filter((q) => q.id !== question.id)
                        .map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.title.length > 60 ? q.title.slice(0, 60) + "…" : q.title}
                          </option>
                        ))}
                    </select>
                    <p className="w-full text-[10px] text-slate-500">
                      Moves &ldquo;{viewingChoice}&rdquo; to the target question and clears it from this one for all {viewingEntries.length} submissions.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Questions Tab Main ─────────────────────────────────────────────────────────

export default function QuestionsTab({
  app,
  onSave,
  clientId,
  companyDescription,
}: QuestionsTabProps) {
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

    const preSnapshot = captureDataSnapshot(app);
    let updated: Application = { ...app, questions: newQuestions, submissions: [...(app.submissions ?? []), ...newSubmissions] };
    updated = addLoadHistoryEntry(
      updated,
      "csv-submissions",
      `Imported ${newSubmissions.length} submissions from CSV`,
      newSubmissions.length,
      preSnapshot,
      {
        csv_rows: csvParsed.rows,
        csv_mapping: csvMapping.map(m => ({ file_column: m.file_column, target: m.target })),
      }
    );
    onSave(updated);
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
  const [streamingAudit, setStreamingAudit] = useState<string | null>(null);

  async function generateAudit() {
    setAuditGenerating(true);
    setAuditError(null);
    setStreamingAudit("");
    setShowAuditRegenConfirm(false);
    setShowAuditNotes(false);
    setAuditCollapsed(false);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNotes: auditNotes.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setAuditError(data.error || "Failed to generate audit.");
        setStreamingAudit(null);
        return;
      }
      // Stream the response
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setStreamingAudit(text);
      }
      if (text.trim()) {
        onSave({
          ...app,
          audit_analysis: text.trim(),
          audit_generated_at: new Date().toISOString(),
          audit_client_notes: auditNotes.trim() || undefined,
        });
      } else {
        setAuditError("No audit generated. Please try again.");
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAuditGenerating(false);
      setStreamingAudit(null);
    }
  }

  // Grading Audit state
  const [gradingAuditGenerating, setGradingAuditGenerating] = useState(false);
  const [gradingAuditError, setGradingAuditError] = useState<string | null>(null);
  const [gradingAuditCollapsed, setGradingAuditCollapsed] = useState(true);
  const [showGradingAuditNotes, setShowGradingAuditNotes] = useState(false);
  const [gradingAuditNotes, setGradingAuditNotes] = useState(app.grading_audit_client_notes ?? "");
  const [showGradingAuditRegenConfirm, setShowGradingAuditRegenConfirm] = useState(false);
  const [streamingGradingAudit, setStreamingGradingAudit] = useState<string | null>(null);

  async function generateGradingAudit() {
    setGradingAuditGenerating(true);
    setGradingAuditError(null);
    setStreamingGradingAudit("");
    setShowGradingAuditRegenConfirm(false);
    setShowGradingAuditNotes(false);
    setGradingAuditCollapsed(false);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-grading-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNotes: gradingAuditNotes.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        setGradingAuditError(data.error || "Failed to generate grading audit.");
        setStreamingGradingAudit(null);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setStreamingGradingAudit(text);
      }
      if (text.trim()) {
        onSave({
          ...app,
          grading_audit_analysis: text.trim(),
          grading_audit_generated_at: new Date().toISOString(),
          grading_audit_client_notes: gradingAuditNotes.trim() || undefined,
        });
      } else {
        setGradingAuditError("No grading audit generated. Please try again.");
      }
    } catch (err) {
      setGradingAuditError(err instanceof Error ? err.message : "Network error");
    } finally {
      setGradingAuditGenerating(false);
      setStreamingGradingAudit(null);
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
              allQuestions={app.questions}
              clientId={clientId}
              appId={app.id}
              companyDescription={companyDescription}
              onUpdate={(updates) => updateQuestion(q.id, updates)}
              onUpdateSubmissions={(updated) => onSave({ ...app, submissions: updated })}
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
        (app.audit_analysis || streamingAudit !== null) ? (
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
            {(() => {
              const displayText = streamingAudit ?? app.audit_analysis;
              if (!displayText) return null;
              return (
              <div className="space-y-4">
                {displayText.split(/^## /m).filter(Boolean).map((section, i) => {
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
                {auditGenerating && (
                  <div className="flex items-center gap-2 text-xs text-indigo-400 mt-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                    Generating...
                  </div>
                )}
              </div>
              );
            })()}

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
        (app.grading_audit_analysis || streamingGradingAudit !== null) ? (
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
            {(() => {
              const displayText = streamingGradingAudit ?? app.grading_audit_analysis;
              if (!displayText) return null;
              return (
              <div className="space-y-4">
                {displayText.split(/^## /m).filter(Boolean).map((section, i) => {
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
                {gradingAuditGenerating && (
                  <div className="flex items-center gap-2 text-xs text-emerald-400 mt-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Generating...
                  </div>
                )}
              </div>
              );
            })()}

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
