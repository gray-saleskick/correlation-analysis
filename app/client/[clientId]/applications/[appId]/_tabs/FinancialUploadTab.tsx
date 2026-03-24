"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import type {
  Application,
  AppSubmission,
  FinancialRecord,
} from "@/lib/types";
import {
  parseFileToRows,
  buildInitialMapping,
  parseDollarAmount,
} from "@/lib/csvUtils";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";
import type { UploadTabProps } from "../_tab-types";

export default function FinancialUploadTab({ app, onSave, remapState, onRemapComplete }: UploadTabProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: Record<string, string>[]; rowCount: number } | null>(null);
  const [mapping, setMapping] = useState<{ file_column: string; target: string }[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"append" | "replace">("append");

  // Pre-fill from re-map state
  useEffect(() => {
    if (remapState?.sourceData?.csv_rows && remapState.sourceData.csv_rows.length > 0) {
      const rows = remapState.sourceData.csv_rows;
      const headers = Object.keys(rows[0] ?? {});
      setParsed({ headers, rows, rowCount: rows.length });
      if (remapState.sourceData.csv_mapping) {
        setMapping(remapState.sourceData.csv_mapping.map(m => ({ file_column: m.file_column, target: m.target })));
      } else {
        setMapping(buildInitialMapping(headers));
      }
    }
  }, [remapState]);

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
    // Build mapping with financial-specific overrides
    const initial = buildInitialMapping(result.headers);
    setMapping(initial.map((m) => {
      // Remap grade.financial → financial.grade in financial context
      if (m.target === "grade.financial") return { ...m, target: "financial.grade" };
      return m;
    }));
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

    const preSnapshot = captureDataSnapshot(app);
    let updated: Application = { ...app, financial_records: mergedRecords, submissions: updatedSubs };
    updated = addLoadHistoryEntry(
      updated,
      "csv-financial",
      `Imported ${dedupedNew.length} financial records from CSV`,
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
