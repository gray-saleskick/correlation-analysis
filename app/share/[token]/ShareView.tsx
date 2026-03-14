"use client";

import { useState, useEffect, useMemo } from "react";

interface ShareData {
  clientName: string;
  companyDescription?: string;
  app: {
    id: string;
    title: string;
    questions: { title: string; type: string }[];
    submissions: { respondent_email?: string; answers: { question_title: string; value: string }[]; submitted_at?: string; grade?: { final_grade?: number; answer_grade?: number } }[];
    bookings: { email: string; booking_date?: string; booked: boolean; showed: boolean; closed: boolean }[];
    financial_records: { email: string; credit_score?: number; estimated_income?: number; credit_access?: number; access_to_funding?: number; financial_grade?: number }[];
    call_results: { email: string; called: boolean; answered: boolean; booked: boolean }[];
    grade_mappings?: { total_grade?: string; application_grade?: string };
    narrative_analysis?: string;
    narrative_generated_at?: string;
    audit_analysis?: string;
    audit_generated_at?: string;
    grading_audit_analysis?: string;
    grading_audit_generated_at?: string;
  };
}

function pct(n: number, d: number): string {
  if (!d) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

export default function ShareView({ token }: { token: string }) {
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/share/${token}`);
        const json = await res.json();
        if (json.success) {
          setData(json);
        } else {
          setError(json.error || "Share link not found");
        }
      } catch {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token]);

  const stats = useMemo(() => {
    if (!data) return null;
    const subs = data.app.submissions ?? [];
    const bks = data.app.bookings ?? [];
    const bkMap = new Map(bks.map(b => [b.email.toLowerCase(), b]));
    const totalSubs = subs.length;
    const booked = subs.filter(s => s.respondent_email && bkMap.has(s.respondent_email.toLowerCase())).length;
    const showed = subs.filter(s => { const b = s.respondent_email ? bkMap.get(s.respondent_email.toLowerCase()) : undefined; return b?.showed; }).length;
    const closed = subs.filter(s => { const b = s.respondent_email ? bkMap.get(s.respondent_email.toLowerCase()) : undefined; return b?.closed; }).length;
    return { totalSubs, booked, showed, closed };
  }, [data]);

  // Build question correlations for the share view
  const questionCorrelations = useMemo(() => {
    if (!data) return [];
    const subs = data.app.submissions ?? [];
    const bks = data.app.bookings ?? [];
    const bkMap = new Map(bks.map(b => [b.email.toLowerCase(), b]));
    const questions = data.app.questions ?? [];

    return questions.map(q => {
      const answerMap = new Map<string, { count: number; bookedCount: number; showedCount: number; closedCount: number }>();
      for (const sub of subs) {
        const ans = sub.answers?.find(a => a.question_title === q.title);
        if (!ans || !ans.value) continue;
        const email = sub.respondent_email?.toLowerCase() ?? "";
        const booking = email ? bkMap.get(email) : undefined;
        if (!answerMap.has(ans.value)) answerMap.set(ans.value, { count: 0, bookedCount: 0, showedCount: 0, closedCount: 0 });
        const entry = answerMap.get(ans.value)!;
        entry.count++;
        if (booking) entry.bookedCount++;
        if (booking?.showed) entry.showedCount++;
        if (booking?.closed) entry.closedCount++;
      }
      const statsList = Array.from(answerMap.entries()).map(([answer, s]) => ({ answer, ...s })).sort((a, b) => b.count - a.count);
      return { questionTitle: q.title, questionType: q.type, stats: statsList };
    }).filter(q => q.stats.length > 0);
  }, [data]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-sm animate-pulse">Loading...</div>
      </div>
    );
  }

  if (error || !data || !stats) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-300 text-sm mb-2">{error || "Share link not found"}</p>
          <p className="text-slate-500 text-xs">This link may have been disabled or is invalid.</p>
        </div>
      </div>
    );
  }

  const hasBookingData = stats.booked > 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="border-b border-white/[0.08] bg-white/[0.04] backdrop-blur px-6 py-3 flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="SalesKick" className="h-8 w-auto rounded-lg" />
        <div>
          <span className="font-semibold text-slate-300 text-sm">{data.clientName}</span>
          <span className="text-slate-500 text-sm mx-2">·</span>
          <span className="text-slate-400 text-sm">{data.app.title}</span>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Overview Stats */}
        <div>
          <h2 className="text-sm font-bold text-slate-200 mb-4">Correlation Analysis Overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Submissions", value: stats.totalSubs },
              { label: "Booked", value: stats.booked, pct: pct(stats.booked, stats.totalSubs) },
              { label: "Showed", value: stats.showed, pct: pct(stats.showed, stats.booked) },
              { label: "Closed", value: stats.closed, pct: pct(stats.closed, stats.showed) },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-indigo-400 tabular-nums">{s.value}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">{s.label}</p>
                {s.pct && <p className="text-[10px] text-slate-500 mt-0.5">{s.pct}</p>}
              </div>
            ))}
          </div>
        </div>

        {/* Question Correlations */}
        {questionCorrelations.length > 0 && (
          <div className="space-y-6">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">Answer Breakdown</h3>
            {questionCorrelations.map(qc => (
              <div key={qc.questionTitle} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-300 mb-3">{qc.questionTitle}</p>
                <div className="space-y-1.5">
                  {qc.stats.slice(0, 10).map(s => {
                    const appsPct = stats.totalSubs > 0 ? Math.round(s.count / stats.totalSubs * 100) : 0;
                    return (
                      <div key={s.answer} className="grid items-center gap-2" style={{ gridTemplateColumns: hasBookingData ? "minmax(0,2.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" : "minmax(0,2.5fr) minmax(0,1fr)" }}>
                        <span className="text-[11px] text-slate-300 truncate">{s.answer}</span>
                        <div className="flex items-center gap-1">
                          <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                            <div className="h-full bg-white/[0.12] rounded-full" style={{ width: `${Math.max(appsPct > 0 ? 4 : 0, appsPct)}%` }} />
                          </div>
                          <span className="text-[10px] text-slate-400 w-8 text-right tabular-nums">{appsPct}%</span>
                        </div>
                        {hasBookingData && (
                          <>
                            <div className="flex items-center gap-1">
                              <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                                <div className="h-full bg-indigo-300 rounded-full" style={{ width: `${stats.booked ? Math.max(s.bookedCount > 0 ? 4 : 0, Math.round(s.bookedCount / stats.booked * 100)) : 0}%` }} />
                              </div>
                              <span className="text-[10px] text-indigo-400 w-8 text-right tabular-nums">{stats.booked ? Math.round(s.bookedCount / stats.booked * 100) : 0}%</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                                <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${s.bookedCount ? Math.round(s.showedCount / s.bookedCount * 100) : 0}%` }} />
                              </div>
                              <span className="text-[10px] text-emerald-400 w-8 text-right tabular-nums">{pct(s.showedCount, s.bookedCount)}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="flex-1 h-3 bg-white/[0.06] rounded-full overflow-hidden">
                                <div className="h-full bg-green-500 rounded-full" style={{ width: `${s.showedCount ? Math.round(s.closedCount / s.showedCount * 100) : 0}%` }} />
                              </div>
                              <span className="text-[10px] text-green-500 w-8 text-right tabular-nums">{pct(s.closedCount, s.showedCount)}</span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                {hasBookingData && (
                  <div className="grid gap-2 mt-2 pt-2 border-t border-white/[0.06] text-[9px] font-bold uppercase tracking-wider text-slate-500" style={{ gridTemplateColumns: "minmax(0,2.5fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" }}>
                    <span></span>
                    <span className="text-center">Apps</span>
                    <span className="text-center">Booked</span>
                    <span className="text-center">Showed</span>
                    <span className="text-center">Closed</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Reports */}
        {data.app.audit_analysis && (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Application Audit</h3>
            <div className="text-xs text-slate-300 whitespace-pre-line leading-relaxed" dangerouslySetInnerHTML={{
              __html: data.app.audit_analysis.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
            }} />
          </div>
        )}

        {data.app.grading_audit_analysis && (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Grading Audit</h3>
            <div className="text-xs text-slate-300 whitespace-pre-line leading-relaxed" dangerouslySetInnerHTML={{
              __html: data.app.grading_audit_analysis.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
            }} />
          </div>
        )}

        {data.app.narrative_analysis && (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300 mb-3">Lead Analysis</h3>
            <div className="text-xs text-slate-300 whitespace-pre-line leading-relaxed" dangerouslySetInnerHTML={{
              __html: data.app.narrative_analysis.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-200 font-semibold">$1</strong>')
            }} />
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-8 pb-4 border-t border-white/[0.06]">
          <p className="text-[10px] text-slate-600">Powered by SalesKick Correlation Analysis</p>
        </div>
      </div>
    </div>
  );
}
