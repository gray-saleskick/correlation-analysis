"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AggregateStats } from "@/lib/store";

interface ClientSummary {
  clientId: string;
  clientName: string;
  created_at: string;
  appCount: number;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export default function HomeClient({ initialClients, stats }: { initialClients: ClientSummary[]; stats: AggregateStats }) {
  const [clients, setClients] = useState(initialClients);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const router = useRouter();

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSearch, setSettingsSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ClientSummary | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  // API key state
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("anthropic_api_key") ?? "";
    return "";
  });
  const [apiKeySaved, setApiKeySaved] = useState(false);

  const filtered = search.trim()
    ? clients.filter((c) => c.clientName.toLowerCase().includes(search.trim().toLowerCase()))
    : clients;

  const settingsFiltered = settingsSearch.trim()
    ? clients.filter((c) => c.clientName.toLowerCase().includes(settingsSearch.trim().toLowerCase()))
    : [];

  async function createClient() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: newName.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setClients((prev) => [
          ...prev,
          {
            clientId: data.client.clientId,
            clientName: data.client.clientName,
            created_at: data.client.created_at,
            appCount: 0,
          },
        ].sort((a, b) => a.clientName.localeCompare(b.clientName)));
        setNewName("");
        router.push(`/client/${data.client.clientId}`);
      }
    } finally {
      setCreating(false);
    }
  }

  async function deleteClient(clientId: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: "DELETE" });
      if (res.ok) {
        setClients((prev) => prev.filter((c) => c.clientId !== clientId));
        setDeleteTarget(null);
        setConfirmText("");
        setSettingsSearch("");
      }
    } finally {
      setDeleting(false);
    }
  }

  function openSettings() {
    setSettingsSearch("");
    setDeleteTarget(null);
    setConfirmText("");
    setSettingsOpen(true);
  }

  function saveApiKey() {
    localStorage.setItem("anthropic_api_key", apiKey);
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  }

  const statCards = [
    { label: "Clients", value: stats.totalClients, color: "text-indigo-400", bg: "bg-indigo-400/10", border: "border-indigo-400/20" },
    { label: "Applications", value: stats.totalApplications, color: "text-indigo-400", bg: "bg-indigo-400/10", border: "border-indigo-400/20" },
    { label: "Submissions Processed", value: stats.totalSubmissions, color: "text-sky-400", bg: "bg-sky-400/10", border: "border-sky-400/20" },
    { label: "Call Results Tracked", value: stats.totalCallResults, color: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/20" },
    { label: "Financial Records", value: stats.totalFinancialRecords, color: "text-violet-400", bg: "bg-violet-400/10", border: "border-violet-400/20" },
    { label: "Deals Closed", value: stats.totalCloses, color: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/20" },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">

      {/* ── Stats Dashboard ── */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Dashboard</h1>
            <p className="text-sm text-slate-400 mt-1">Platform overview across all clients</p>
          </div>
          <button
            onClick={openSettings}
            className="p-2.5 rounded-xl border border-white/[0.08] text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] hover:border-white/[0.15] transition-all"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {statCards.map((card) => (
            <div
              key={card.label}
              className={`${card.bg} border ${card.border} rounded-xl px-5 py-4 transition-all hover:scale-[1.02]`}
            >
              <p className={`text-2xl font-bold ${card.color} tabular-nums tracking-tight`}>
                {formatNumber(card.value)}
              </p>
              <p className="text-[11px] text-slate-400 mt-1 font-medium uppercase tracking-wider">
                {card.label}
              </p>
            </div>
          ))}
        </div>

        {/* Secondary stats row */}
        {(stats.totalBookings > 0 || stats.totalAuditsGenerated > 0) && (
          <div className="flex flex-wrap gap-4 mt-4 px-1">
            {stats.totalBookings > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-xs text-slate-400">
                  <span className="text-slate-300 font-semibold">{formatNumber(stats.totalBookings)}</span> bookings tracked
                </span>
              </div>
            )}
            {stats.totalShows > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                <span className="text-xs text-slate-400">
                  <span className="text-slate-300 font-semibold">{formatNumber(stats.totalShows)}</span> shows recorded
                </span>
              </div>
            )}
            {stats.totalAuditsGenerated > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                <span className="text-xs text-slate-400">
                  <span className="text-slate-300 font-semibold">{formatNumber(stats.totalAuditsGenerated)}</span> AI audits generated
                </span>
              </div>
            )}
            {stats.totalQuestions > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                <span className="text-xs text-slate-400">
                  <span className="text-slate-300 font-semibold">{formatNumber(stats.totalQuestions)}</span> questions analyzed
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Clients Section ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-slate-300 uppercase tracking-widest">Clients</h2>
          <span className="text-xs text-slate-500">{clients.length} total</span>
        </div>

        {/* Create new client */}
        <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 mb-4">
          <div className="flex gap-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createClient()}
              placeholder="New client name…"
              className="flex-1 bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
            />
            <button
              onClick={createClient}
              disabled={!newName.trim() || creating}
              className="px-4 py-2 bg-indigo-500 text-white text-sm font-semibold rounded-lg hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </div>

        {/* Search */}
        {clients.length > 3 && (
          <div className="mb-4">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search clients…"
              className="w-full bg-white/[0.05] border border-white/[0.1] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent"
            />
          </div>
        )}

        {/* Client list */}
        {filtered.length === 0 ? (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-6 py-12 text-center">
            <p className="text-slate-300 text-sm">{search.trim() ? "No matching clients." : "No clients yet."}</p>
            {!search.trim() && <p className="text-slate-400 text-xs mt-1">Create your first client above.</p>}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((c) => (
              <a
                key={c.clientId}
                href={`/client/${c.clientId}`}
                className="block bg-white/[0.04] border border-white/[0.08] rounded-xl px-5 py-4 hover:bg-white/[0.06] hover:border-white/[0.15] transition-all group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-300 group-hover:text-indigo-400 transition-colors">
                      {c.clientName}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {c.appCount} application{c.appCount !== 1 ? "s" : ""} · Created {new Date(c.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <svg className="w-4 h-4 text-slate-500 group-hover:text-indigo-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSettingsOpen(false)} />
          <div className="relative bg-slate-900 border border-white/[0.1] rounded-2xl w-full max-w-md mx-4 shadow-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="px-6 pt-5 pb-4 border-b border-white/[0.08] flex items-center justify-between shrink-0">
              <h2 className="text-sm font-bold text-slate-200">Settings</h2>
              <button onClick={() => setSettingsOpen(false)} className="text-slate-300 hover:text-slate-200 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-4 space-y-6 overflow-y-auto flex-1">
              {/* API Key Section */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300 mb-2">Anthropic API Key</p>
                <p className="text-[11px] text-slate-300 mb-2">Used for AI grading prompts. Stored locally in your browser.</p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-…"
                    className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent font-mono"
                  />
                  <button
                    onClick={saveApiKey}
                    disabled={!apiKey.trim()}
                    className="px-3 py-2 text-xs font-semibold bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors shrink-0"
                  >
                    {apiKeySaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
              </div>

              {/* Delete Client Section */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-2">Delete a Client</p>
                <p className="text-[11px] text-slate-300 mb-2">Search for a client to permanently delete them and all their data.</p>

                {!deleteTarget ? (
                  <>
                    <input
                      value={settingsSearch}
                      onChange={(e) => setSettingsSearch(e.target.value)}
                      placeholder="Search by client name…"
                      className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-red-400/50 focus:border-transparent mb-2"
                    />
                    {settingsSearch.trim() && settingsFiltered.length === 0 && (
                      <p className="text-[11px] text-slate-400 italic">No matching clients.</p>
                    )}
                    {settingsFiltered.length > 0 && (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {settingsFiltered.map((c) => (
                          <button
                            key={c.clientId}
                            onClick={() => { setDeleteTarget(c); setConfirmText(""); }}
                            className="w-full text-left px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg hover:bg-red-500/10 hover:border-red-500/20 transition-all text-xs text-slate-300 hover:text-red-400"
                          >
                            {c.clientName}
                            <span className="text-slate-400 ml-2">({c.appCount} app{c.appCount !== 1 ? "s" : ""})</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-xs font-semibold text-red-400">
                        Permanently delete &ldquo;{deleteTarget.clientName}&rdquo;?
                      </p>
                    </div>
                    <p className="text-[11px] text-slate-300">
                      This will delete {deleteTarget.appCount} application{deleteTarget.appCount !== 1 ? "s" : ""} and all associated data. This cannot be undone.
                    </p>
                    <p className="text-[11px] text-slate-300">
                      Type <span className="font-mono font-semibold text-red-400">{deleteTarget.clientName}</span> to confirm:
                    </p>
                    <input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={deleteTarget.clientName}
                      className="w-full bg-white/[0.05] border border-red-500/20 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-red-400/50 focus:border-transparent"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setDeleteTarget(null); setConfirmText(""); }}
                        className="flex-1 px-3 py-2 text-xs font-semibold border border-white/[0.08] rounded-lg text-slate-300 hover:bg-white/[0.04] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => deleteClient(deleteTarget.clientId)}
                        disabled={confirmText !== deleteTarget.clientName || deleting}
                        className="flex-1 px-3 py-2 text-xs font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {deleting ? "Deleting…" : "Delete Forever"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
