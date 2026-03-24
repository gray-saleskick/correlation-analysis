"use client";

import { useState, useEffect } from "react";
import type {
  Application,
  ApplicationQuestion,
  WebhookConfig,
  WebhookFieldMapping,
  PendingWebhookSubmission,
  CalculatedField,
} from "@/lib/types";
import {
  flattenPayload,
  parseTypeformPayload,
  applyFieldMapping,
  mergeWebhookData,
  computeFieldSignature,
} from "@/lib/webhookUtils";
import { autoDetectTarget } from "@/lib/csvUtils";
import { captureDataSnapshot, addLoadHistoryEntry } from "@/lib/loadHistory";
import { uid } from "../_utils";
import type { WebhooksTabProps } from "../_tab-types";

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

export default function WebhooksTab({
  app,
  onSave,
  clientId,
}: WebhooksTabProps) {
  const config = app.webhook_config;
  const pending = (app.pending_webhook_submissions ?? []).filter(p => p.status === "pending");
  const [creating, setCreating] = useState(false);
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingEdits, setMappingEdits] = useState<WebhookFieldMapping[]>(config?.field_mapping ?? []);
  const [processingPendingId, setProcessingPendingId] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
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
      const mappedSourceFields = new Set(mappingEdits.map(m => m.source_field));
      const preSnapshot = captureDataSnapshot(app);
      let updated = { ...app };

      // Helper: flatten a pending item's payload
      const flattenPending = (item: PendingWebhookSubmission): {
        flat: Record<string, string>;
        submittedAt?: string;
      } => {
        if (config.source === "typeform") {
          const parsed = parseTypeformPayload(item.raw_payload);
          if (parsed) return { flat: parsed.fields, submittedAt: parsed.meta.submitted_at };
        }
        return { flat: flattenPayload(item.raw_payload) };
      };

      // Process all pending submissions whose fields are covered by the mapping
      const remaining: PendingWebhookSubmission[] = [];
      const allPending = (app.pending_webhook_submissions ?? []).filter(p => p.status === "pending");
      const knownSigFields = new Set(
        config.last_field_signature ? config.last_field_signature.split("|") : []
      );

      for (const p of allPending) {
        const { flat, submittedAt } = flattenPending(p);
        const fields = Object.keys(flat);
        const allFieldsMapped = fields.every(f => mappedSourceFields.has(f));

        if (allFieldsMapped) {
          const mapped = applyFieldMapping(flat, mappingEdits, config.calculated_fields);
          if (submittedAt && !mapped.submitted_at) {
            mapped.submitted_at = submittedAt;
          }
          updated = mergeWebhookData(updated, mapped);
          for (const f of fields) knownSigFields.add(f);
        } else {
          remaining.push(p);
        }
      }

      const cumulativeSignature = computeFieldSignature(Array.from(knownSigFields));
      updated.webhook_config = {
        ...config,
        field_mapping: mappingEdits,
        last_field_signature: cumulativeSignature,
      };
      updated.pending_webhook_submissions = remaining;

      // Add load history entry if any pending items were processed
      const processedCount = allPending.length - remaining.length;
      if (processedCount > 0) {
        updated = addLoadHistoryEntry(
          updated,
          "webhook-batch",
          `Saved mapping and processed ${processedCount} pending webhook submission${processedCount > 1 ? "s" : ""}`,
          processedCount,
          preSnapshot,
          { webhook_field_mapping: mappingEdits, webhook_pending_ids: allPending.filter(p => !remaining.includes(p)).map(p => p.id) }
        );
      }

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
      const preSnapshot = captureDataSnapshot(app);
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

      // Add load history entry
      const totalProcessed = processedIds.size;
      updated = addLoadHistoryEntry(
        updated,
        "webhook-batch",
        `Accepted and processed ${totalProcessed} pending webhook submission${totalProcessed > 1 ? "s" : ""}`,
        totalProcessed,
        preSnapshot,
        { webhook_field_mapping: newMappings, webhook_pending_ids: Array.from(processedIds) }
      );

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
              onClick={() => {
                navigator.clipboard.writeText(webhookUrl);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors flex-shrink-0 ${
                copiedUrl
                  ? "bg-emerald-600/30 text-emerald-300"
                  : "bg-white/[0.08] text-slate-300 hover:bg-white/[0.12]"
              }`}
            >
              {copiedUrl ? "✓ Copied!" : "Copy"}
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
            {mappingEdits.map((m) => {
              // Build set of targets already used by OTHER rows
              const usedTargets = new Set(
                mappingEdits
                  .filter(o => o.source_field !== m.source_field && o.target !== "skip" && o.target !== "")
                  .map(o => o.target)
              );
              return (
                <div key={m.source_field} className="grid grid-cols-[1fr,24px,1fr] gap-2 items-center px-3 py-2 bg-white/[0.02] rounded-lg">
                  <span className="text-xs text-slate-300 truncate" title={m.source_field}>{m.source_field}</span>
                  <span className="text-xs text-slate-500 text-center">→</span>
                  <select
                    value={m.target}
                    onChange={(e) => updateMappingTarget(m.source_field, e.target.value)}
                    className="w-full bg-white/[0.06] border border-white/[0.1] rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500/50"
                  >
                    {allTargets.map((t) => (
                      <option
                        key={t.value}
                        value={t.value}
                        disabled={usedTargets.has(t.value)}
                      >
                        {t.label}{usedTargets.has(t.value) ? " (assigned)" : ""}
                      </option>
                    ))}
                    <option disabled>──────────</option>
                    <option value="__create_new__">+ Create New Question</option>
                  </select>
                </div>
              );
            })}
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
