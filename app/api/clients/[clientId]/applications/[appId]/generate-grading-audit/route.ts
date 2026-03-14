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

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(num: number, denom: number): string {
  if (!denom) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Build call-result lookup by email ────────────────────────────────────────

function buildOutcomeLookup(callResults: CallResultRecord[]): Map<string, CallResultRecord> {
  const map = new Map<string, CallResultRecord>();
  for (const cr of callResults) {
    if (cr.email) map.set(cr.email.toLowerCase(), cr);
  }
  return map;
}

// ── Grade-to-Outcome Analysis ────────────────────────────────────────────────

interface GradeOutcome {
  grade: string;
  count: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
}

function computeGradeOutcomes(
  submissions: AppSubmission[],
  crMap: Map<string, CallResultRecord>,
  gradeField: "final_grade" | "answer_grade" | "financial_grade"
): GradeOutcome[] {
  const buckets = new Map<string, GradeOutcome>();

  for (const sub of submissions) {
    const gradeVal = sub.grade?.[gradeField];
    if (gradeVal == null) continue;
    const gKey = String(Math.round(gradeVal));
    const email = sub.respondent_email?.toLowerCase();
    const cr = email ? crMap.get(email) : undefined;

    if (!buckets.has(gKey)) {
      buckets.set(gKey, { grade: gKey, count: 0, bookedCount: 0, showedCount: 0, closedCount: 0 });
    }
    const b = buckets.get(gKey)!;
    b.count++;
    if (cr?.booked) b.bookedCount++;
    if (cr?.showed) b.showedCount++;
    if (cr?.closed) b.closedCount++;
  }

  return Array.from(buckets.values()).sort((a, b) => Number(a.grade) - Number(b.grade));
}

// ── Per-Answer Outcome Analysis (multi-choice questions with grading) ────────

interface AnswerOutcome {
  questionTitle: string;
  questionIndex: number;
  gradingPrompt: string;
  answers: {
    answer: string;
    count: number;
    assignedGrade: number | null;
    bookedCount: number;
    showedCount: number;
    closedCount: number;
  }[];
}

function computeAnswerOutcomes(
  app: Application,
  submissions: AppSubmission[],
  crMap: Map<string, CallResultRecord>
): AnswerOutcome[] {
  const results: AnswerOutcome[] = [];

  for (let i = 0; i < app.questions.length; i++) {
    const q = app.questions[i];
    // Only analyze multi-choice questions that have grading
    if (!q.grading_prompt) continue;
    if (!q.choices?.length && q.type !== "multiple_choice" && q.type !== "yes_no" && q.type !== "dropdown") continue;

    // Parse grade assignments from grading prompt (format: Give a [grade] for the answer: "[option]")
    const gradeAssignments = new Map<string, number>();
    const gradeRegex = /[Gg]ive\s+a\s+(-?\d+(?:\.\d+)?)\s+for\s+the\s+answer:\s*"([^"]+)"/g;
    let match;
    while ((match = gradeRegex.exec(q.grading_prompt)) !== null) {
      gradeAssignments.set(match[2].toLowerCase().trim(), Number(match[1]));
    }

    // Aggregate per-answer outcomes
    const answerMap = new Map<string, { count: number; assignedGrade: number | null; bookedCount: number; showedCount: number; closedCount: number }>();

    for (const sub of submissions) {
      const ans = sub.answers.find(
        (a) =>
          a.question_ref === q.id ||
          a.question_ref === q.ref ||
          a.question_title.toLowerCase().trim() === q.title.toLowerCase().trim()
      );
      if (!ans?.value?.trim()) continue;

      const val = ans.value.trim();
      const email = sub.respondent_email?.toLowerCase();
      const cr = email ? crMap.get(email) : undefined;

      if (!answerMap.has(val)) {
        const assignedGrade = gradeAssignments.get(val.toLowerCase().trim()) ?? null;
        answerMap.set(val, { count: 0, assignedGrade, bookedCount: 0, showedCount: 0, closedCount: 0 });
      }
      const bucket = answerMap.get(val)!;
      bucket.count++;
      if (cr?.booked) bucket.bookedCount++;
      if (cr?.showed) bucket.showedCount++;
      if (cr?.closed) bucket.closedCount++;
    }

    if (answerMap.size > 0) {
      results.push({
        questionTitle: q.title,
        questionIndex: i + 1,
        gradingPrompt: q.grading_prompt,
        answers: Array.from(answerMap.entries())
          .map(([answer, data]) => ({ answer, ...data }))
          .sort((a, b) => b.count - a.count),
      });
    }
  }

  return results;
}

// ── Financial Threshold Analysis ─────────────────────────────────────────────

interface FinancialBucket {
  range: string;
  min: number;
  max: number;
  count: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
}

function computeFinancialThresholds(
  submissions: AppSubmission[],
  crMap: Map<string, CallResultRecord>,
  financialRecords: FinancialRecord[]
): { field: string; buckets: FinancialBucket[] }[] {
  // Build financial lookup by email
  const finMap = new Map<string, FinancialRecord>();
  for (const fr of financialRecords) {
    if (fr.email) finMap.set(fr.email.toLowerCase(), fr);
  }

  const fields: { key: keyof FinancialRecord; label: string; ranges: [string, number, number][] }[] = [
    {
      key: "credit_score",
      label: "Credit Score",
      ranges: [
        ["Under 580", 0, 579],
        ["580-619", 580, 619],
        ["620-659", 620, 659],
        ["660-699", 660, 699],
        ["700-739", 700, 739],
        ["740-779", 740, 779],
        ["780+", 780, 999],
      ],
    },
    {
      key: "estimated_income",
      label: "Estimated Income",
      ranges: [
        ["Under $25K", 0, 24999],
        ["$25K-$50K", 25000, 49999],
        ["$50K-$75K", 50000, 74999],
        ["$75K-$100K", 75000, 99999],
        ["$100K-$150K", 100000, 149999],
        ["$150K-$250K", 150000, 249999],
        ["$250K+", 250000, Infinity],
      ],
    },
    {
      key: "credit_access",
      label: "Available Credit",
      ranges: [
        ["Under $5K", 0, 4999],
        ["$5K-$15K", 5000, 14999],
        ["$15K-$25K", 15000, 24999],
        ["$25K-$50K", 25000, 49999],
        ["$50K-$100K", 50000, 99999],
        ["$100K+", 100000, Infinity],
      ],
    },
    {
      key: "access_to_funding",
      label: "Access to Funding",
      ranges: [
        ["Under $10K", 0, 9999],
        ["$10K-$25K", 10000, 24999],
        ["$25K-$50K", 25000, 49999],
        ["$50K-$100K", 50000, 99999],
        ["$100K-$250K", 100000, 249999],
        ["$250K+", 250000, Infinity],
      ],
    },
  ];

  const results: { field: string; buckets: FinancialBucket[] }[] = [];

  for (const { key, label, ranges } of fields) {
    const buckets: FinancialBucket[] = ranges.map(([range, min, max]) => ({
      range, min, max, count: 0, bookedCount: 0, showedCount: 0, closedCount: 0,
    }));

    // Use both submission financial data and financial records
    const emailsSeen = new Set<string>();

    for (const sub of submissions) {
      const email = sub.respondent_email?.toLowerCase();
      if (!email || emailsSeen.has(email)) continue;
      emailsSeen.add(email);

      // Get financial value from financial record or submission
      const fr = finMap.get(email);
      const val = (fr?.[key] as number | undefined) ?? (sub.financial?.[key as keyof typeof sub.financial] as number | undefined);
      if (val == null || isNaN(val)) continue;

      const cr = crMap.get(email);
      for (const bucket of buckets) {
        if (val >= bucket.min && val <= bucket.max) {
          bucket.count++;
          if (cr?.booked) bucket.bookedCount++;
          if (cr?.showed) bucket.showedCount++;
          if (cr?.closed) bucket.closedCount++;
          break;
        }
      }
    }

    // Only include fields that have data
    const hasData = buckets.some((b) => b.count > 0);
    if (hasData) {
      results.push({ field: label, buckets: buckets.filter((b) => b.count > 0) });
    }
  }

  return results;
}

// ── Grade Leaker Analysis ────────────────────────────────────────────────────

interface GradeLeaker {
  email: string;
  finalGrade: number;
  answerGrade?: number;
  financialGrade?: number;
  booked: boolean;
  showed: boolean;
  closed: boolean;
  keyAnswers: { question: string; answer: string }[];
}

function findGradeLeakers(
  app: Application,
  submissions: AppSubmission[],
  crMap: Map<string, CallResultRecord>
): { highGradeNonClosers: GradeLeaker[]; lowGradeClosers: GradeLeaker[] } {
  const highGradeNonClosers: GradeLeaker[] = [];
  const lowGradeClosers: GradeLeaker[] = [];

  for (const sub of submissions) {
    const email = sub.respondent_email?.toLowerCase();
    if (!email) continue;
    const cr = crMap.get(email);
    if (!cr) continue;

    const grade = sub.grade?.final_grade ?? sub.grade?.answer_grade;
    if (grade == null) continue;

    const keyAnswers = sub.answers
      .filter((a) => a.value?.trim())
      .slice(0, 5)
      .map((a) => ({ question: a.question_title, answer: a.value!.trim().slice(0, 200) }));

    const leaker: GradeLeaker = {
      email: email.replace(/(.{2}).*(@.*)/, "$1***$2"), // partially mask email
      finalGrade: Math.round((sub.grade?.final_grade ?? 0) * 10) / 10,
      answerGrade: sub.grade?.answer_grade != null ? Math.round(sub.grade.answer_grade * 10) / 10 : undefined,
      financialGrade: sub.grade?.financial_grade != null ? Math.round(sub.grade.financial_grade * 10) / 10 : undefined,
      booked: cr.booked,
      showed: cr.showed,
      closed: cr.closed,
      keyAnswers,
    };

    // High grade (3+) who didn't close but showed
    if (grade >= 3 && cr.showed && !cr.closed) {
      highGradeNonClosers.push(leaker);
    }
    // Low grade (<2.5) who closed
    if (grade < 2.5 && cr.closed) {
      lowGradeClosers.push(leaker);
    }
  }

  return {
    highGradeNonClosers: highGradeNonClosers.slice(0, 15),
    lowGradeClosers: lowGradeClosers.slice(0, 15),
  };
}

// ── Extract Current Grading Rubrics ──────────────────────────────────────────

function extractGradingRubrics(app: Application): string[] {
  const lines: string[] = [];

  for (let i = 0; i < app.questions.length; i++) {
    const q = app.questions[i];
    if (!q.grading_prompt) continue;

    lines.push(`### Q${i + 1}: "${q.title}" (${q.type})`);
    lines.push(`Current grading rubric:`);
    lines.push("```");
    lines.push(q.grading_prompt.slice(0, 1500)); // cap length per question
    lines.push("```");
    lines.push("");
  }

  return lines;
}

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior SalesOps grading and scoring optimization consultant. You specialize in evaluating whether application grading rubrics are correctly calibrated against actual sales outcomes — show rates and close rates.

YOUR FOCUS: You are NOT auditing the questions themselves. You are auditing HOW ANSWERS ARE SCORED. Your job is to evaluate whether the current grading system effectively separates leads that close from leads that don't, and recommend specific scoring changes.

CORE PRINCIPLES:

1. **CPMQL is the North Star** — Cost Per Marketing Qualified Lead. The grading system's job is to accurately identify MQLs (Grade 2.5+) so the business optimizes for CPMQL, not cost-per-booking. A $200 CPMQL with 80% show rate crushes a $50 cost-per-booking with 30% show rate.

2. **Grade Separation = Signal Quality** — A good grading system creates clear, step-wise separation in outcomes. If Grade 3 and Grade 4 leads close at the same rate, the rubric isn't differentiating. If Grade 1 and Grade 2 show at the same rate, the low-end grading adds no value.

3. **50% Lie Rate on Multi-Choice Financials** — Half of respondents give aspirational answers on revenue, income, and financial capacity questions. Financial multi-choice grades should be weighted accordingly — they are useful for routing but unreliable as absolute qualifiers.

4. **Grade Leakers Reveal Rubric Gaps** — High-grade leads that don't close and low-grade leads that do close are your most valuable diagnostic tool. Their answer patterns reveal what the rubric is missing or overweighting.

5. **Grading Should Compound With the Four Buckets** — WHO do we want (ICP fit), WHO will show (commitment), WHO has ability (financial), WHO is likely to purchase (urgency/pain). The grading system should weight all four buckets, not just one or two.

6. **Threshold Precision Matters** — The difference between a 650 and 700 credit score cutoff can be the difference between profitable and unprofitable CPMQL. Use the actual outcome data to find where the "close cliff" is — the threshold below which close rates drop dramatically.

7. **Open-Ended Response Grading** — Fill-in questions graded by AI should weight specificity and emotional depth. Generic answers ("I want more money") should grade lower than specific answers ("I'm a chiropractor doing $15K/month but spending $4K on ads that aren't converting"). The grading prompt should reflect what actually predicts closes in this specific dataset.

VOICE & TONE:
- Be direct and data-driven. Every recommendation must cite specific numbers from the data.
- Be a teacher — explain WHY a threshold should move, not just that it should.
- Be specific — give exact new grade values, exact new thresholds, exact rubric language changes.
- Prioritize recommendations by expected CPMQL impact.

OUTPUT FORMAT — Use these exact ## headers:

## Grading Health Score
2-3 sentences. Is the current grading system effectively separating closers from non-closers? Rate the overall calibration: Well-Calibrated / Needs Adjustment / Significantly Miscalibrated. What's the single biggest grading issue?

## Grade-to-Outcome Analysis
For each grade level with data: count, show rate, close rate. Is there clear step-wise separation? Identify where the separation breaks down. If Grade 3 and Grade 4 have similar close rates, flag it. If Grade 1 and Grade 2 have similar show rates, flag it.

## Question-by-Question Grading Review
For each question that has grading: evaluate whether the current rubric is contributing signal or noise. Is the grading criteria for this question actually predicting outcomes? Should the weight of this question's grade change?

## Multi-Choice Answer Bucket Review
For each graded multi-choice question: per-option grade assignment vs. actual show/close rates. Flag any answer options where the assigned grade contradicts the actual outcomes. Provide specific grade reassignment recommendations with exact new values.

## Financial Threshold Analysis
For each financial field with data: show where the actual "close cliff" is — the threshold below which close rates drop significantly. Compare to current grading cutoffs. Recommend exact new threshold values. Account for the 50% lie rate on self-reported financial data.

## Grade Leaker Report
Analyze high-grade non-closers (Grade 3+ who showed but didn't close) and low-grade closers (Grade <2.5 who did close). What patterns emerge? What is the rubric overweighting? What is it missing?

## Recommended Rubric Changes
Prioritized by expected impact:

**IMMEDIATE (highest leverage):**
1. [Change] — Why: [data-backed reasoning] — Expected effect: [specific prediction]

**SHORT-TERM (test in 2-4 weeks):**
1. [Change] — Why: [reasoning] — Expected effect: [prediction]

**FUTURE (30-60 days):**
1. [Change] — Why: [reasoning] — Expected effect: [prediction]

## Expected Impact
Predict the effect of your recommended changes on: MQL accuracy, CPMQL, show rate by grade level, and close rate by grade level. Be specific with expected percentage changes.

RULES:
- Reference SPECIFIC data — exact show/close rates per grade, per answer option, per financial bucket
- Every recommendation must include exact new values (not "increase the grade" but "change from Grade 2 to Grade 3")
- Consider the interplay between answer grades and financial grades in the final grade
- If the data shows the current grading is well-calibrated for a particular question, say so — don't change things just to change them
- Total output: 1500-3000 words depending on data complexity`;

// ── API Handler ──────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const { apiKey, clientNotes } = body as { apiKey?: string; clientNotes?: string };

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

    // Validate we have the necessary data
    const gradedCount = submissions.filter((s) => s.grade?.final_grade != null || s.grade?.answer_grade != null).length;
    if (gradedCount === 0) {
      return NextResponse.json(
        { success: false, error: "No graded submissions found. Grade your submissions first before running a grading audit." },
        { status: 400 }
      );
    }

    if (callResults.length === 0) {
      return NextResponse.json(
        { success: false, error: "No call results found. Upload call results (booked/showed/closed data) to run a grading audit." },
        { status: 400 }
      );
    }

    // ── Build outcome lookup ──────────────────────────────────────────
    const crMap = buildOutcomeLookup(callResults);

    // ── Compute all grading data ──────────────────────────────────────
    const finalGradeOutcomes = computeGradeOutcomes(submissions, crMap, "final_grade");
    const answerGradeOutcomes = computeGradeOutcomes(submissions, crMap, "answer_grade");
    const financialGradeOutcomes = computeGradeOutcomes(submissions, crMap, "financial_grade");
    const answerOutcomes = computeAnswerOutcomes(app, submissions, crMap);
    const financialThresholds = computeFinancialThresholds(submissions, crMap, financialRecords);
    const leakers = findGradeLeakers(app, submissions, crMap);
    const rubrics = extractGradingRubrics(app);

    // ── Build data payload ────────────────────────────────────────────
    const payload: string[] = [];

    // Company context
    if (profile.company_description?.trim()) {
      payload.push(`## Company Description\n${profile.company_description.trim()}\n`);
    }

    // Client notes
    if (clientNotes?.trim()) {
      payload.push(`## Client Notes\n${clientNotes.trim()}\n`);
    }

    // Application overview
    payload.push(`## Application: "${app.title}"`);
    payload.push(`Total submissions: ${submissions.length}`);
    payload.push(`Graded submissions: ${gradedCount}`);
    payload.push(`Call results: ${callResults.length}`);
    payload.push(`Financial records: ${financialRecords.length}`);
    payload.push("");

    // Overall funnel context
    const totalBooked = callResults.filter((cr) => cr.booked).length;
    const totalShowed = callResults.filter((cr) => cr.showed).length;
    const totalClosed = callResults.filter((cr) => cr.closed).length;
    payload.push(`## Overall Funnel`);
    payload.push(`- Booked: ${totalBooked} (${pct(totalBooked, submissions.length)} of submissions)`);
    payload.push(`- Showed: ${totalShowed} (${pct(totalShowed, totalBooked)} of booked)`);
    payload.push(`- Closed: ${totalClosed} (${pct(totalClosed, totalShowed)} of showed)`);
    payload.push("");

    // Grade-to-outcome data
    const formatOutcomes = (outcomes: GradeOutcome[], label: string) => {
      if (outcomes.length === 0) return;
      payload.push(`## ${label} — Outcome Correlation`);
      for (const o of outcomes) {
        payload.push(
          `- Grade ${o.grade}: ${o.count} submissions | Booked: ${o.bookedCount} (${pct(o.bookedCount, o.count)}) | Showed: ${o.showedCount} (${pct(o.showedCount, o.bookedCount)}) | Closed: ${o.closedCount} (${pct(o.closedCount, o.showedCount)})`
        );
      }
      payload.push("");
    };

    formatOutcomes(finalGradeOutcomes, "Final Grade");
    formatOutcomes(answerGradeOutcomes, "Answer Grade");
    formatOutcomes(financialGradeOutcomes, "Financial Grade");

    // Per-answer outcomes for multi-choice graded questions
    if (answerOutcomes.length > 0) {
      payload.push("## Multi-Choice Answer Outcomes\n");
      for (const ao of answerOutcomes) {
        payload.push(`### Q${ao.questionIndex}: "${ao.questionTitle}"`);
        payload.push(`Current grading prompt:\n\`\`\`\n${ao.gradingPrompt.slice(0, 800)}\n\`\`\`\n`);
        payload.push("Per-answer breakdown:");
        for (const a of ao.answers) {
          const gradeStr = a.assignedGrade != null ? `Grade ${a.assignedGrade}` : "Ungraded";
          payload.push(
            `  "${a.answer}" — ${a.count} respondents | ${gradeStr} | Showed: ${a.showedCount} (${pct(a.showedCount, a.bookedCount || a.count)}) | Closed: ${a.closedCount} (${pct(a.closedCount, a.showedCount || a.count)})`
          );
        }
        payload.push("");
      }
    }

    // Financial threshold data
    if (financialThresholds.length > 0) {
      payload.push("## Financial Data — Outcome by Range\n");
      for (const ft of financialThresholds) {
        payload.push(`### ${ft.field}`);
        for (const b of ft.buckets) {
          payload.push(
            `  ${b.range}: ${b.count} leads | Booked: ${b.bookedCount} (${pct(b.bookedCount, b.count)}) | Showed: ${b.showedCount} (${pct(b.showedCount, b.bookedCount)}) | Closed: ${b.closedCount} (${pct(b.closedCount, b.showedCount)})`
          );
        }
        payload.push("");
      }
    }

    // Grade leakers
    if (leakers.highGradeNonClosers.length > 0 || leakers.lowGradeClosers.length > 0) {
      payload.push("## Grade Leaker Data\n");

      if (leakers.highGradeNonClosers.length > 0) {
        payload.push(`### High-Grade Non-Closers (Grade 3+ who showed but didn't close): ${leakers.highGradeNonClosers.length} found`);
        for (const l of leakers.highGradeNonClosers.slice(0, 8)) {
          payload.push(`- ${l.email} | Final: ${l.finalGrade}${l.answerGrade != null ? ` | Answer: ${l.answerGrade}` : ""}${l.financialGrade != null ? ` | Financial: ${l.financialGrade}` : ""}`);
          for (const ka of l.keyAnswers.slice(0, 3)) {
            payload.push(`    "${ka.question}": "${ka.answer}"`);
          }
        }
        payload.push("");
      }

      if (leakers.lowGradeClosers.length > 0) {
        payload.push(`### Low-Grade Closers (Grade <2.5 who closed): ${leakers.lowGradeClosers.length} found`);
        for (const l of leakers.lowGradeClosers.slice(0, 8)) {
          payload.push(`- ${l.email} | Final: ${l.finalGrade}${l.answerGrade != null ? ` | Answer: ${l.answerGrade}` : ""}${l.financialGrade != null ? ` | Financial: ${l.financialGrade}` : ""}`);
          for (const ka of l.keyAnswers.slice(0, 3)) {
            payload.push(`    "${ka.question}": "${ka.answer}"`);
          }
        }
        payload.push("");
      }
    }

    // Current grading rubrics
    if (rubrics.length > 0) {
      payload.push("## Current Grading Rubrics\n");
      payload.push(...rubrics);
    }

    const userMessage = `Audit this application's grading and scoring system. Evaluate whether the current grading rubric is correctly calibrated against actual show and close outcomes, and recommend specific scoring changes:\n\n${payload.join("\n")}`;

    // ── Call Anthropic ────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const audit = textBlock?.type === "text" ? textBlock.text.trim() : "";

    if (!audit) {
      return NextResponse.json(
        { success: false, error: "No grading audit generated. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      audit,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    console.error("Generate grading audit error:", msg);
    const isAuthError =
      msg.includes("401") || msg.includes("authentication") || msg.includes("invalid");
    return NextResponse.json(
      {
        success: false,
        error: isAuthError
          ? "Invalid API key. Check your Anthropic API key in Settings."
          : "Failed to generate grading audit. Please try again.",
      },
      { status: 500 }
    );
  }
}
