"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ClientProfile } from "@/lib/types";

export default function ClientDetailPage({ initialProfile }: { initialProfile: ClientProfile }) {
  const [profile, setProfile] = useState(initialProfile);
  const [newAppTitle, setNewAppTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(initialProfile.company_description ?? "");
  const [savingDesc, setSavingDesc] = useState(false);
  const router = useRouter();

  async function saveDescription() {
    setSavingDesc(true);
    try {
      const res = await fetch(`/api/clients/${profile.clientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_description: descDraft }),
      });
      if (res.ok) {
        setProfile((p) => ({ ...p, company_description: descDraft }));
        setEditingDesc(false);
      }
    } finally {
      setSavingDesc(false);
    }
  }

  async function createApp() {
    if (!newAppTitle.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/clients/${profile.clientId}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newAppTitle.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setProfile((p) => ({
          ...p,
          applications: [...p.applications, data.application],
        }));
        setNewAppTitle("");
        router.push(`/client/${profile.clientId}/applications/${data.application.id}`);
      }
    } finally {
      setCreating(false);
    }
  }

  async function deleteApp(appId: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clients/${profile.clientId}/applications/${appId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setProfile((p) => ({
          ...p,
          applications: p.applications.filter((a) => a.id !== appId),
        }));
        setDeleteTarget(null);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6 bg-white/[0.02] rounded-lg px-3 py-2">
        <Link href="/" className="text-xs text-slate-300 hover:text-indigo-400 transition-colors">Clients</Link>
        <span className="text-slate-400">/</span>
        <span className="text-xs text-slate-300 font-medium">{profile.clientName}</span>
      </div>

      <div className="mb-8">
        <h1 className="text-xl font-bold text-slate-200">{profile.clientName}</h1>
        <p className="text-sm text-slate-300 mt-1">
          Manage applications and their correlation data.
        </p>

        {/* Company Description */}
        <div className="mt-4">
          {editingDesc ? (
            <div className="space-y-2">
              <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-300">Company Description</label>
              <textarea
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                maxLength={2000}
                rows={4}
                placeholder="Describe what this company does, who they serve, what they sell, price point, target audience, etc. This context is used by AI features for better analysis."
                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveDescription}
                  disabled={savingDesc}
                  className="px-3 py-1.5 text-xs font-semibold bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
                >
                  {savingDesc ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => { setEditingDesc(false); setDescDraft(profile.company_description ?? ""); }}
                  className="px-3 py-1.5 text-xs font-semibold border border-white/[0.08] text-slate-300 rounded-lg hover:bg-white/[0.04] transition-colors"
                >
                  Cancel
                </button>
                <span className="text-[10px] text-slate-400 ml-auto">{descDraft.length}/2000</span>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setEditingDesc(true)}
              className="group flex items-start gap-2 text-left w-full"
            >
              {profile.company_description ? (
                <p className="text-xs text-slate-300 leading-relaxed line-clamp-2 group-hover:text-slate-200 transition-colors">
                  {profile.company_description}
                </p>
              ) : (
                <p className="text-xs text-slate-400 italic group-hover:text-slate-300 transition-colors">
                  + Add company description for AI context…
                </p>
              )}
              <svg className="w-3 h-3 text-slate-400 group-hover:text-indigo-400 mt-0.5 shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Create application */}
      <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 mb-6 shadow-sm shadow-black/10">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">New Application</p>
        <div className="flex gap-3">
          <input
            value={newAppTitle}
            onChange={(e) => setNewAppTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createApp()}
            placeholder="Application name (e.g. Main Application Form)…"
            className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition-colors"
          />
          <button
            onClick={createApp}
            disabled={!newAppTitle.trim() || creating}
            className="px-4 py-2 bg-indigo-500 text-white text-sm font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      {/* Applications list */}
      {profile.applications.length === 0 ? (
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-6 py-12 text-center shadow-sm shadow-black/10">
          <p className="text-slate-300 text-sm">No applications yet.</p>
          <p className="text-slate-400 text-xs mt-1">Create an application to start uploading data.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {profile.applications.map((app) => {
            const subCount = app.submissions?.length ?? 0;
            const finCount = app.financial_records?.length ?? 0;
            const callCount = app.call_results?.length ?? 0;
            const hasData = subCount > 0 || finCount > 0 || callCount > 0;

            return (
              <Link
                key={app.id}
                href={`/client/${profile.clientId}/applications/${app.id}`}
                prefetch={true}
                className="block bg-white/[0.04] border border-white/[0.08] rounded-xl px-5 py-4 hover:bg-white/[0.06] hover:border-white/[0.15] transition-all group shadow-sm shadow-black/10"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-200 group-hover:text-indigo-400 transition-colors">
                      {app.title}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-slate-300">
                        {subCount} submission{subCount !== 1 ? "s" : ""}
                      </span>
                      {finCount > 0 && (
                        <span className="text-[11px] text-slate-300">
                          {finCount} financial
                        </span>
                      )}
                      {callCount > 0 && (
                        <span className="text-[11px] text-slate-300">
                          {callCount} call results
                        </span>
                      )}
                      {hasData && (
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">
                          ready
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(app.id); }}
                      className="text-slate-400 hover:text-red-400 hover:bg-red-400/10 p-1.5 rounded-lg transition-all"
                      title="Delete application"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                    <svg className="w-4 h-4 text-slate-400 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (() => {
        const targetApp = profile.applications.find(a => a.id === deleteTarget);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
            <div className="relative bg-slate-900 border border-white/[0.1] rounded-2xl w-full max-w-sm mx-4 p-6 shadow-2xl">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-5 h-5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h3 className="text-sm font-bold text-slate-200">Delete Application</h3>
              </div>
              <p className="text-[11px] text-slate-300 mb-4">
                Are you sure you want to delete &ldquo;{targetApp?.title}&rdquo; and all its data? This cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="flex-1 px-4 py-2 text-xs font-semibold border border-white/[0.08] rounded-lg text-slate-300 hover:bg-white/[0.04] transition-colors"
                >Cancel</button>
                <button
                  onClick={() => deleteApp(deleteTarget)}
                  disabled={deleting}
                  className="flex-1 px-4 py-2 text-xs font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-40 transition-colors"
                >{deleting ? "Deleting…" : "Delete"}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
