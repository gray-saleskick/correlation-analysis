"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import type {
  Application,
  AppSubmission,
  CallResultRecord,
  LoadSourceType,
  LoadHistorySourceData,
} from "@/lib/types";
import { parseFileToRows } from "@/lib/csvUtils";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";
import type { UploadTabProps } from "../_tab-types";

export default function CallResultsUploadTab({ app, onSave, remapState, onRemapComplete }: UploadTabProps) {
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

  // Pre-fill from re-map state
  useEffect(() => {
    if (remapState?.sourceData?.csv_rows && remapState.sourceData.csv_rows.length > 0) {
      const rows = remapState.sourceData.csv_rows;
      const headers = Object.keys(rows[0] ?? {});
      setParsed({ headers, rows, rowCount: rows.length });
      if (remapState.sourceData.csv_mapping) {
        for (const m of remapState.sourceData.csv_mapping) {
          if (m.target === "email") setEmailCol(m.file_column);
          else if (m.target === "booking_date") setBookingDateCol(m.file_column);
          else if (m.target === "close_date") setCloseDateCol(m.file_column);
          else if (m.target === "booked" || m.target === "booking.booked") setBookedCol(m.file_column);
          else if (m.target === "showed" || m.target === "booking.showed") setShowedCol(m.file_column);
          else if (m.target === "closed" || m.target === "booking.closed") setClosedCol(m.file_column);
        }
      }
    }
  }, [remapState]);

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

    const preSnapshot = captureDataSnapshot(app);
    let updated: Application = { ...app, call_results: mergedRecords, submissions: updatedSubs };
    updated = addLoadHistoryEntry(
      updated,
      "csv-call-results",
      `Imported ${dedupedNew.length} call results from CSV`,
      dedupedNew.length,
      preSnapshot,
      parsed ? {
        csv_rows: parsed.rows,
        csv_mapping: [
          { file_column: emailCol, target: "email" },
          ...(bookingDateCol ? [{ file_column: bookingDateCol, target: "booking_date" }] : []),
          ...(closeDateCol ? [{ file_column: closeDateCol, target: "close_date" }] : []),
          ...(bookedCol ? [{ file_column: bookedCol, target: "booking.booked" }] : []),
          ...(showedCol ? [{ file_column: showedCol, target: "booking.showed" }] : []),
          ...(closedCol ? [{ file_column: closedCol, target: "booking.closed" }] : []),
        ],
      } : undefined
    );
    onSave(updated);
    setParsed(null);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
    if (remapState && onRemapComplete) onRemapComplete();
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
