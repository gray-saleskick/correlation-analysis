"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type {
  Application,
  ApplicationQuestion,
  AppSubmission,
  BookingRecord,
  FinancialRecord,
  CallResultRecord,
  FilterCondition,
  FilterFieldType,
  FilterOperator,
  SavedCorrelationFilter,
  ChatMessage,
  DataChat,
} from "@/lib/types";
import { pct, CORRELATABLE_TYPES, evaluateCondition } from "../_utils";
import type { CorrelationTabProps } from "../_tab-types";

function CorrelationTab({ app, onSave, clientName, clientId }: CorrelationTabProps) {
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
        body: JSON.stringify({ context: "data", messages: updatedMessages, systemContext: buildDataContext() }),
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
    setNarrativeGenerating(true);
    setNarrativeError(null);
    setShowRegenConfirm(false);
    try {
      const res = await fetch(`/api/clients/${clientId}/applications/${app.id}/generate-narrative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
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

      // Choices are defined but nothing matched — exclude from correlation
      return [];
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

export default CorrelationTab;
