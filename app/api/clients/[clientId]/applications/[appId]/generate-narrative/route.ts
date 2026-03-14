import { NextRequest, NextResponse } from "next/server";
import { readProfile } from "@/lib/store";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Application,
  AppSubmission,
  CallResultRecord,
  FinancialRecord,
} from "@/lib/types";

export const dynamic = "force-dynamic";

// ── Data Aggregation Helpers ────────────────────────────────────────────────

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(num: number, denom: number): string {
  if (!denom) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

interface FunnelStats {
  totalSubmissions: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
  bookRate: string;
  showRate: string;
  closeRate: string;
  overallCloseRate: string;
}

function computeFunnel(
  submissions: AppSubmission[],
  callResults: CallResultRecord[]
): FunnelStats {
  const crByEmail = new Map<string, CallResultRecord>();
  for (const cr of callResults) {
    if (cr.email) crByEmail.set(cr.email.toLowerCase(), cr);
  }

  let bookedCount = 0;
  let showedCount = 0;
  let closedCount = 0;

  for (const sub of submissions) {
    const email = sub.respondent_email?.toLowerCase();
    if (!email) continue;
    const cr = crByEmail.get(email);
    if (!cr) continue;
    if (cr.booked) bookedCount++;
    if (cr.showed) showedCount++;
    if (cr.closed) closedCount++;
  }

  return {
    totalSubmissions: submissions.length,
    bookedCount,
    showedCount,
    closedCount,
    bookRate: pct(bookedCount, submissions.length),
    showRate: pct(showedCount, bookedCount),
    closeRate: pct(closedCount, showedCount),
    overallCloseRate: pct(closedCount, submissions.length),
  };
}

interface GradeDistribution {
  label: string;
  buckets: Record<string, number>;
  total: number;
}

function computeGrades(submissions: AppSubmission[]): GradeDistribution[] {
  const distributions: GradeDistribution[] = [];

  const finalGrades: Record<string, number> = {};
  const appGrades: Record<string, number> = {};
  const finGrades: Record<string, number> = {};
  let fTotal = 0, aTotal = 0, fnTotal = 0;
  let spamCount = 0;
  let dqCount = 0;

  for (const sub of submissions) {
    const g = sub.grade;
    if (g?.final_grade != null) {
      const k = String(Math.round(g.final_grade));
      finalGrades[k] = (finalGrades[k] ?? 0) + 1;
      fTotal++;
    }
    if (g?.answer_grade != null) {
      const k = String(Math.round(g.answer_grade));
      appGrades[k] = (appGrades[k] ?? 0) + 1;
      aTotal++;
    }
    if (g?.financial_grade != null) {
      const k = String(Math.round(g.financial_grade));
      finGrades[k] = (finGrades[k] ?? 0) + 1;
      fnTotal++;
    }
    if (g?.was_spam) spamCount++;
    if (g?.was_disqualified) dqCount++;
  }

  if (fTotal > 0) distributions.push({ label: "Final Grade", buckets: finalGrades, total: fTotal });
  if (aTotal > 0) distributions.push({ label: "Application Grade", buckets: appGrades, total: aTotal });
  if (fnTotal > 0) distributions.push({ label: "Financial Grade", buckets: finGrades, total: fnTotal });

  if (spamCount > 0 || dqCount > 0) {
    distributions.push({
      label: "Flagged",
      buckets: { spam: spamCount, disqualified: dqCount },
      total: submissions.length,
    });
  }

  return distributions;
}

interface QuestionSummary {
  title: string;
  type: string;
  topAnswers: { answer: string; count: number }[];
  sampleOpenEnded: string[];
  totalResponses: number;
  byGrade?: Record<string, string[]>; // grade → sample answers
}

function summarizeQuestions(app: Application): QuestionSummary[] {
  const submissions = app.submissions ?? [];
  const summaries: QuestionSummary[] = [];

  for (const q of app.questions) {
    const answerCounts = new Map<string, number>();
    const allAnswers: string[] = [];
    const byGrade: Record<string, string[]> = {};

    for (const sub of submissions) {
      const match = sub.answers.find(
        (a) =>
          a.question_ref === q.id ||
          a.question_ref === q.ref ||
          a.question_title.toLowerCase().trim() === q.title.toLowerCase().trim()
      );
      if (!match || !match.value?.trim()) continue;

      const val = match.value.trim();
      allAnswers.push(val);
      answerCounts.set(val, (answerCounts.get(val) ?? 0) + 1);

      // Group by grade for correlation
      const grade = sub.grade?.final_grade ?? sub.grade?.answer_grade;
      if (grade != null) {
        const gKey = String(Math.round(grade));
        if (!byGrade[gKey]) byGrade[gKey] = [];
        if (byGrade[gKey].length < 15) byGrade[gKey].push(val);
      }
    }

    // Top answers by frequency
    const sorted = Array.from(answerCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topAnswers = sorted.slice(0, 12).map(([answer, count]) => ({ answer, count }));

    // Random sample of open-ended for long-text/short-text
    const isOpenEnded = ["short_text", "long_text"].includes(q.type);
    let sampleOpenEnded: string[] = [];
    if (isOpenEnded && allAnswers.length > 0) {
      const shuffled = [...allAnswers].sort(() => Math.random() - 0.5);
      sampleOpenEnded = shuffled.slice(0, Math.min(50, allAnswers.length));
    }

    summaries.push({
      title: q.title,
      type: q.type,
      topAnswers,
      sampleOpenEnded,
      totalResponses: allAnswers.length,
      byGrade: Object.keys(byGrade).length > 0 ? byGrade : undefined,
    });
  }

  return summaries;
}

interface FinancialStats {
  field: string;
  min: number;
  max: number;
  avg: number;
  median: number;
  count: number;
}

function computeFinancials(records: FinancialRecord[]): FinancialStats[] {
  const fields: { key: keyof FinancialRecord; label: string }[] = [
    { key: "credit_score", label: "Credit Score" },
    { key: "estimated_income", label: "Estimated Income" },
    { key: "credit_access", label: "Credit Access" },
    { key: "access_to_funding", label: "Access to Funding" },
  ];

  const stats: FinancialStats[] = [];

  for (const { key, label } of fields) {
    const vals = records
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (vals.length === 0) continue;

    stats.push({
      field: label,
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
      median: Math.round(median(vals)),
      count: vals.length,
    });
  }

  return stats;
}

interface TimingStats {
  earliestSubmission: string | null;
  latestSubmission: string | null;
  submissionsPerWeek: { week: string; count: number }[];
  avgDaysToBooking: number | null;
}

function computeTiming(
  submissions: AppSubmission[],
  callResults: CallResultRecord[]
): TimingStats {
  const dates = submissions
    .map((s) => s.submitted_at)
    .filter(Boolean)
    .sort();

  // Submissions per week
  const weekCounts = new Map<string, number>();
  for (const d of dates) {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) continue;
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dt.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    weekCounts.set(key, (weekCounts.get(key) ?? 0) + 1);
  }

  // Average days to booking
  const crByEmail = new Map<string, CallResultRecord>();
  for (const cr of callResults) {
    if (cr.email && cr.booking_date) crByEmail.set(cr.email.toLowerCase(), cr);
  }

  const daysToBooking: number[] = [];
  for (const sub of submissions) {
    const email = sub.respondent_email?.toLowerCase();
    if (!email) continue;
    const cr = crByEmail.get(email);
    if (!cr?.booking_date || !sub.submitted_at) continue;
    const subDate = new Date(sub.submitted_at);
    const bookDate = new Date(cr.booking_date);
    if (isNaN(subDate.getTime()) || isNaN(bookDate.getTime())) continue;
    const diff = (bookDate.getTime() - subDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diff >= 0 && diff < 365) daysToBooking.push(Math.round(diff));
  }

  return {
    earliestSubmission: dates[0] ?? null,
    latestSubmission: dates[dates.length - 1] ?? null,
    submissionsPerWeek: Array.from(weekCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12) // last 12 weeks
      .map(([week, count]) => ({ week, count })),
    avgDaysToBooking: daysToBooking.length > 0
      ? Math.round(daysToBooking.reduce((s, v) => s + v, 0) / daysToBooking.length)
      : null,
  };
}

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite lead generation and sales funnel analyst. You're briefing a business owner or marketing director on their application/lead data. Be direct, specific, and actionable — like a $500/hr consultant giving a debrief.

Your output MUST be formatted in markdown with exactly these section headers (use ## for each). Skip any section entirely if there is genuinely not enough data to say anything meaningful — never fabricate or speculate without data.

## Executive Summary
2-3 sentences maximum. The single most important takeaway from this data. What is the headline story? If you had 10 seconds with the CEO, what would you tell them?

## Funnel Analysis
Analyze the conversion funnel: submissions → booked → showed → closed. Calculate and comment on:
- Drop-off rates at each stage
- Which stage has the biggest leak
- How these rates compare to typical industry benchmarks (15-25% book rate, 60-80% show rate, 20-40% close rate are common baselines)
- Revenue impact of improving the weakest stage

## Lead Quality Insights
Analyze the grade distributions. What patterns emerge?
- What percentage of leads are high quality (grade 3-4) vs low quality (grade 1-2)?
- Is the grading distribution healthy or concerning?
- Spam/disqualification rates and what they suggest about lead sources
- If grade data correlates with outcomes (do higher-graded leads actually convert better?), call that out

## Response Pattern Analysis
You MUST analyze EVERY question provided in the data — do not skip any. For each question, provide a dedicated sub-section using ### Question: "[question title]". Your analysis for each should include:

**For multiple-choice / dropdown questions:**
- Distribution breakdown: which answers dominate and what that reveals about the audience
- Conversion correlation: which answer choices lead to the highest booked/showed/closed rates — call out specific answers with their rates
- Red flag answers: any choices that correlate strongly with low grades, no-shows, or non-conversion

**For open-ended / text questions (THIS IS THE MOST IMPORTANT PART):**
- **Theme extraction**: Read through ALL provided sample responses and identify 3-5 distinct themes or categories. Name each theme and give 2-3 representative quote snippets.
- **Language signal analysis**: What specific words, phrases, or sentiments do high-converting leads use vs low-converting ones? Be very specific — quote actual words from the data.
- **Urgency & motivation signals**: Do any responses reveal urgency, desperation, confidence, or ambivalence? How do these tones correlate with outcomes?
- **Depth & effort correlation**: Do longer, more detailed responses correlate with better outcomes? Call out the pattern if visible.
- **Audience psychographic read**: What do these open-ended answers collectively tell us about who this audience is — their mindset, pain points, sophistication level, and readiness to buy?

**For ALL question types:**
- CRITICAL: If grade-by-answer data exists, explicitly compare what grade 4 leads say vs grade 1 leads. Quote specific examples side by side.
- Flag any surprising or counterintuitive patterns

## Financial Profile
If financial data exists, analyze:
- Distribution of credit scores, income levels, funding access
- What the financial profile tells us about the target audience
- Any correlation between financial health and conversion outcomes
- Whether the audience can realistically afford the product/service

## Timing & Trends
- Is submission volume growing, declining, or flat?
- Any weekly patterns (certain days produce more/better leads)?
- Speed-to-booking correlation: do faster bookings lead to better outcomes?
- Seasonal or temporal patterns worth noting

## Recommendations
Provide 3-5 specific, actionable recommendations. Each should:
- Reference specific data points that support the recommendation
- Be something the business can actually implement
- Include expected impact where possible
Examples: "Your highest-converting leads mention [X] — consider targeting this in ad copy", "Leads who book within 48hrs close at 2x the rate — implement urgency-based follow-up"

## Watch Items
Flag any concerns, red flags, or data quality issues:
- Unusually low conversion at any funnel stage
- High spam/disqualification rates suggesting targeting problems
- Missing or inconsistent data that limits analysis
- Any metric trending in a concerning direction

RULES:
- Use SPECIFIC numbers, percentages, and counts from the data provided. Never say "many" or "some" when you can say "47%" or "132 out of 280".
- Be direct and opinionated. You're being paid for your expert judgment, not hedging.
- If a section has insufficient data, skip it entirely rather than padding with generalities.
- Keep each section concise — bullets over paragraphs. Busy executives scan, they don't read essays.
- When quoting lead responses, use short representative snippets, not full responses.
- The Response Pattern Analysis section should be the LONGEST section — dedicate significant depth to each question. Other sections should be concise.
- Total output should be 800-2000 words depending on data volume. Dense and useful, not fluffy.`;

// ── API Handler ─────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const { apiKey } = body as { apiKey?: string };

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "API key is required. Add your Anthropic API key in Settings." },
        { status: 400 }
      );
    }

    const profile = await readProfile(clientId);
    if (!profile) {
      return NextResponse.json({ success: false, error: "Client not found" }, { status: 404 });
    }

    const app = profile.applications.find((a) => a.id === appId);
    if (!app) {
      return NextResponse.json({ success: false, error: "Application not found" }, { status: 404 });
    }

    const submissions = app.submissions ?? [];
    const callResults = app.call_results ?? [];
    const financialRecords = app.financial_records ?? [];

    if (submissions.length === 0) {
      return NextResponse.json(
        { success: false, error: "No submission data available. Import submissions first." },
        { status: 400 }
      );
    }

    // ── Aggregate all data ──────────────────────────────────────────────
    const funnel = computeFunnel(submissions, callResults);
    const grades = computeGrades(submissions);
    const questionSummaries = summarizeQuestions(app);
    const financials = computeFinancials(financialRecords);
    const timing = computeTiming(submissions, callResults);

    // ── Build the data payload for the LLM ──────────────────────────────
    const dataPayload = [
      `# Application: "${app.title}"`,
      `Total questions configured: ${app.questions.length}`,
      "",
      "## Funnel Data",
      `- Total submissions: ${funnel.totalSubmissions}`,
      `- Booked: ${funnel.bookedCount} (${funnel.bookRate} of submissions)`,
      `- Showed: ${funnel.showedCount} (${funnel.showRate} of booked)`,
      `- Closed: ${funnel.closedCount} (${funnel.closeRate} of showed)`,
      `- Overall close rate: ${funnel.overallCloseRate} of all submissions`,
      "",
    ];

    if (grades.length > 0) {
      dataPayload.push("## Grade Distributions");
      for (const g of grades) {
        const entries = Object.entries(g.buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `  Grade ${k}: ${v} (${pct(v, g.total)})`)
          .join("\n");
        dataPayload.push(`${g.label} (${g.total} graded):\n${entries}`);
      }
      dataPayload.push("");
    }

    if (questionSummaries.length > 0) {
      dataPayload.push("## Question Response Data");
      for (const qs of questionSummaries) {
        dataPayload.push(`\n### "${qs.title}" (${qs.type}, ${qs.totalResponses} responses)`);
        if (qs.topAnswers.length > 0) {
          dataPayload.push("Top answers:");
          for (const ta of qs.topAnswers) {
            dataPayload.push(`  "${ta.answer}" — ${ta.count} times (${pct(ta.count, qs.totalResponses)})`);
          }
        }
        if (qs.sampleOpenEnded.length > 0) {
          dataPayload.push(`\nSample open-ended responses (${qs.sampleOpenEnded.length} of ${qs.totalResponses}):`);
          for (const s of qs.sampleOpenEnded) {
            dataPayload.push(`  "${s}"`);
          }
        }
        if (qs.byGrade) {
          dataPayload.push("\nAnswers by grade level:");
          for (const [grade, answers] of Object.entries(qs.byGrade).sort(([a], [b]) => b.localeCompare(a))) {
            dataPayload.push(`  Grade ${grade} (${answers.length} responses):\n${answers.slice(0, 10).map((a) => `    "${a}"`).join("\n")}`);
          }
        }
      }
      dataPayload.push("");
    }

    if (financials.length > 0) {
      dataPayload.push("## Financial Data");
      for (const f of financials) {
        dataPayload.push(`${f.field} (${f.count} records): min=${f.min}, max=${f.max}, avg=${f.avg}, median=${f.median}`);
      }
      dataPayload.push("");
    }

    if (timing.earliestSubmission || timing.submissionsPerWeek.length > 0) {
      dataPayload.push("## Timing Data");
      if (timing.earliestSubmission) dataPayload.push(`Date range: ${timing.earliestSubmission} to ${timing.latestSubmission}`);
      if (timing.avgDaysToBooking != null) dataPayload.push(`Average days from submission to booking: ${timing.avgDaysToBooking}`);
      if (timing.submissionsPerWeek.length > 0) {
        dataPayload.push("Submissions per week (recent):");
        for (const w of timing.submissionsPerWeek) {
          dataPayload.push(`  Week of ${w.week}: ${w.count}`);
        }
      }
      dataPayload.push("");
    }

    const userMessage = `Analyze this lead/application data and provide your narrative breakdown:\n\n${dataPayload.join("\n")}`;

    // ── Call Anthropic ──────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const narrative = textBlock?.type === "text" ? textBlock.text.trim() : "";

    if (!narrative) {
      return NextResponse.json(
        { success: false, error: "No analysis generated. Please try again." },
        { status: 500 }
      );
    }

    const generatedAt = new Date().toISOString();

    return NextResponse.json({
      success: true,
      narrative,
      generated_at: generatedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    console.error("Generate narrative error:", msg);
    const isAuthError =
      msg.includes("401") || msg.includes("authentication") || msg.includes("invalid");
    return NextResponse.json(
      {
        success: false,
        error: isAuthError
          ? "Invalid API key. Check your Anthropic API key in Settings."
          : "Failed to generate analysis. Please try again.",
      },
      { status: 500 }
    );
  }
}
