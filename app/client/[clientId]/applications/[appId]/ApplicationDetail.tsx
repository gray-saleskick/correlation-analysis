"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Application, LoadSourceType, LoadHistorySourceData } from "@/lib/types";
import Link from "next/link";
import dynamic from "next/dynamic";
import { hasWebhookAccess } from "@/lib/featureFlags";
import { undoLoadHistoryEntry } from "@/lib/loadHistory";
import { TabId, BASE_TABS, formatTimeAgo, getSourceBadge } from "./_utils";
import TabSkeleton from "./_tabs/TabSkeleton";

// ── Lazy-loaded tab components ────────────────────────────────────────────────
const QuestionsTab = dynamic(() => import("./_tabs/QuestionsTab"), { loading: () => <TabSkeleton /> });
const SubmissionsUploadTab = dynamic(() => import("./_tabs/SubmissionsUploadTab"), { loading: () => <TabSkeleton /> });
const FinancialUploadTab = dynamic(() => import("./_tabs/FinancialUploadTab"), { loading: () => <TabSkeleton /> });
const CallResultsUploadTab = dynamic(() => import("./_tabs/CallResultsUploadTab"), { loading: () => <TabSkeleton /> });
const WebhooksTab = dynamic(() => import("./_tabs/WebhooksTab"), { loading: () => <TabSkeleton /> });
const CorrelationTab = dynamic(() => import("./_tabs/CorrelationTab"), { loading: () => <TabSkeleton /> });

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
  const [showLoadHistory, setShowLoadHistory] = useState(false);
  const [remapState, setRemapState] = useState<{
    sourceType: LoadSourceType;
    sourceData: LoadHistorySourceData;
    entryTimestamp: string;
  } | null>(null);
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLoadHistory(true)}
            disabled={(app.load_history?.length ?? 0) === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-30 disabled:cursor-not-allowed border-white/[0.08] text-slate-400 hover:bg-white/[0.04] hover:text-slate-300"
            title={`Load History (${app.load_history?.length ?? 0} entries)`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            History
            {(app.load_history?.length ?? 0) > 0 && (
              <span className="text-[10px] bg-white/[0.08] text-slate-300 rounded-full px-1.5 py-0.5">
                {app.load_history!.length}
              </span>
            )}
          </button>
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

      {remapState && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span className="text-xs font-semibold text-amber-400">
                Re-mapping load from {new Date(remapState.entryTimestamp).toLocaleString()}
              </span>
            </div>
            <button
              onClick={() => setRemapState(null)}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel Re-map
            </button>
          </div>
          <p className="text-[11px] text-amber-400/70 mt-1">Adjust your column mappings below and re-import. The previous load has been undone.</p>
        </div>
      )}

      {activeTab === "questions" && <QuestionsTab app={app} onSave={saveApp} clientId={clientId} companyDescription={companyDescription} />}
      {activeTab === "submissions" && <SubmissionsUploadTab app={app} onSave={saveApp} uploadType="submissions" remapState={remapState?.sourceType === "csv-submissions" ? remapState : null} onRemapComplete={() => setRemapState(null)} />}
      {activeTab === "financial" && <FinancialUploadTab app={app} onSave={saveApp} remapState={remapState?.sourceType === "csv-financial" ? remapState : null} onRemapComplete={() => setRemapState(null)} />}
      {activeTab === "call_results" && <CallResultsUploadTab app={app} onSave={saveApp} remapState={remapState?.sourceType === "csv-call-results" ? remapState : null} onRemapComplete={() => setRemapState(null)} />}
      {activeTab === "webhooks" && <WebhooksTab app={app} onSave={saveApp} clientId={clientId} />}
      {activeTab === "correlation" && <CorrelationTab app={app} onSave={saveApp} clientName={clientName} clientId={clientId} />}

      {/* Load History Slide-Over */}
      {showLoadHistory && (
        <div className="fixed inset-0 z-[55] flex justify-end">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowLoadHistory(false)} />
          <div className="relative w-full max-w-md bg-slate-900 border-l border-white/[0.1] shadow-2xl overflow-y-auto">
            <div className="sticky top-0 bg-slate-900/95 backdrop-blur-sm border-b border-white/[0.08] p-4 flex items-center justify-between z-10">
              <h2 className="text-sm font-bold text-slate-200">Load History</h2>
              <button onClick={() => setShowLoadHistory(false)} className="text-slate-400 hover:text-slate-200 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4 space-y-3">
              {(app.load_history ?? []).length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-8">No load history yet.</p>
              ) : (
                [...(app.load_history ?? [])].reverse().map((entry, i) => {
                  const isLatest = i === 0;
                  const sourceBadge = getSourceBadge(entry.source_type);
                  const hasSourceData = !!entry.source_data && (
                    (entry.source_data.csv_rows && entry.source_data.csv_rows.length > 0) ||
                    (entry.source_data.webhook_field_mapping && entry.source_data.webhook_field_mapping.length > 0)
                  );
                  const canRemap = hasSourceData && (
                    entry.source_type === "csv-submissions" ||
                    entry.source_type === "csv-financial" ||
                    entry.source_type === "csv-call-results"
                  );
                  return (
                    <div key={entry.id} className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3.5">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${sourceBadge.color}`}>
                            {sourceBadge.label}
                          </span>
                          {isLatest && (
                            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400">
                              Latest
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-500">{formatTimeAgo(entry.timestamp)}</span>
                      </div>
                      <p className="text-xs text-slate-300 mb-1">{entry.description}</p>
                      <p className="text-[10px] text-slate-500 mb-3">{entry.record_count} record{entry.record_count !== 1 ? "s" : ""}</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            showConfirm(
                              `Undo this load? This will revert to the state before "${entry.description}" and remove all subsequent loads (${i} load${i !== 1 ? "s" : ""} after this one).`,
                              () => {
                                const restored = undoLoadHistoryEntry(app, entry.id);
                                saveApp(restored);
                                setShowLoadHistory(false);
                              }
                            );
                          }}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-red-500/30 text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
                          </svg>
                          Undo
                        </button>
                        {canRemap && (
                          <button
                            onClick={() => {
                              showConfirm(
                                `Re-map this load? This will undo the load and let you re-import with different column mappings.`,
                                () => {
                                  const restored = undoLoadHistoryEntry(app, entry.id);
                                  saveApp(restored);
                                  setRemapState({
                                    sourceType: entry.source_type,
                                    sourceData: entry.source_data!,
                                    entryTimestamp: entry.timestamp,
                                  });
                                  // Switch to the appropriate tab
                                  if (entry.source_type === "csv-submissions") setActiveTab("submissions");
                                  else if (entry.source_type === "csv-financial") setActiveTab("financial");
                                  else if (entry.source_type === "csv-call-results") setActiveTab("call_results");
                                  setShowLoadHistory(false);
                                }
                              );
                            }}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-amber-500/30 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Re-map
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

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
