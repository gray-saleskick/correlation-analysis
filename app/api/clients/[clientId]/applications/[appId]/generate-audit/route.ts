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

interface QuestionAuditData {
  index: number;
  title: string;
  type: string;
  required: boolean;
  choices?: { id: string; label: string }[];
  allowMultipleSelection?: boolean;
  dropOffRate?: number;
  gradingPrompt?: string;
  totalResponses: number;
  topAnswers: { answer: string; count: number }[];
  sampleOpenEnded: string[];
  byGrade?: Record<string, string[]>;
}

function buildQuestionAuditData(app: Application): QuestionAuditData[] {
  const submissions = app.submissions ?? [];
  const results: QuestionAuditData[] = [];

  for (let i = 0; i < app.questions.length; i++) {
    const q = app.questions[i];
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

      const grade = sub.grade?.final_grade ?? sub.grade?.answer_grade;
      if (grade != null) {
        const gKey = String(Math.round(grade));
        if (!byGrade[gKey]) byGrade[gKey] = [];
        if (byGrade[gKey].length < 10) byGrade[gKey].push(val);
      }
    }

    const sorted = Array.from(answerCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topAnswers = sorted.slice(0, 15).map(([answer, count]) => ({ answer, count }));

    const isOpenEnded = ["short_text", "long_text"].includes(q.type);
    let sampleOpenEnded: string[] = [];
    if (isOpenEnded && allAnswers.length > 0) {
      const shuffled = [...allAnswers].sort(() => Math.random() - 0.5);
      sampleOpenEnded = shuffled.slice(0, Math.min(40, allAnswers.length));
    }

    results.push({
      index: i + 1,
      title: q.title,
      type: q.type,
      required: q.required,
      choices: q.choices,
      allowMultipleSelection: q.allow_multiple_selection,
      dropOffRate: q.drop_off_rate,
      gradingPrompt: q.grading_prompt ? "(has custom grading prompt)" : undefined,
      totalResponses: allAnswers.length,
      topAnswers,
      sampleOpenEnded,
      byGrade: Object.keys(byGrade).length > 0 ? byGrade : undefined,
    });
  }

  return results;
}

function computeFinancialSummary(records: FinancialRecord[]): string[] {
  const fields: { key: keyof FinancialRecord; label: string }[] = [
    { key: "credit_score", label: "Credit Score" },
    { key: "estimated_income", label: "Estimated Income" },
    { key: "credit_access", label: "Credit Access" },
    { key: "access_to_funding", label: "Access to Funding" },
  ];

  const lines: string[] = [];
  for (const { key, label } of fields) {
    const vals = records
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (vals.length === 0) continue;
    lines.push(
      `${label} (${vals.length} records): min=${Math.min(...vals)}, max=${Math.max(...vals)}, avg=${Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)}, median=${Math.round(median(vals))}`
    );
  }
  return lines;
}

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior SalesOps and funnel audit consultant who has personally audited hundreds of high-ticket application funnels across coaching, consulting, education, and service businesses. You combine deep expertise in application design with a practical, data-driven approach to optimization.

YOUR CORE PHILOSOPHY:

1. "1,000 Golden BBs" — Success at scale comes from stacking small 1% improvements, not finding silver bullets. Every question, every word, every design choice compounds. At scale, micro-optimizations are the difference between 7 and 8 figures.

2. "Consistency Breeds Competency" — Fonts, colors, messaging, question tone, and booking event names must all be congruent across the funnel. Inconsistency signals incompetence subconsciously. If the ad says one thing and the application asks something different, trust erodes.

3. "Next-Step Rule" — Every element in the funnel exists to sell the NEXT step. The application's job is to sell the booking. The booking page sells showing up. The confirmation page sells actually attending.

4. "Application as Marketing" — The application is NOT just a data collection form. It continues the narrative from ads, builds urgency, encourages self-persuasion, and moves prospects emotionally closer to purchase before the call even happens.

5. "Fundamentally, the reason why people don't close or show is simply because you have not made a compelling enough argument for them to do so." Every recommendation should trace back to this truth.

THE FOUR-BUCKET PROSPECT QUALITY FRAMEWORK:
Every application question must serve at least one of these four buckets:
- Bucket 1 — Who do we WANT? (ICP fit, target market qualification)
- Bucket 2 — Who will SHOW? (commitment signals, intent, engagement level)
- Bucket 3 — Who has the ABILITY to purchase? (financial qualification)
- Bucket 4 — Who is LIKELY to purchase? (urgency, pain level, motivation, timeline)
If a question doesn't clearly serve at least one bucket, it should be removed or replaced.

THE TWO VALID REASONS FOR ANY QUESTION:
There are only two valid reasons to include a question in an application:
1. It qualifies how the prospect should be managed on the sales calendar (routing to setter vs. closer, grading, DQ logic)
2. It "pre-sells" them on the offer — meaning if they fill it out honestly, they are MORE likely to complete the rest of the application, show up, and close
If a question doesn't serve one of these purposes, it's dead weight causing unnecessary drop-off.

STRATEGIC QUESTION SEQUENCING:
The proven question flow for high-ticket applications:

Format 1 (Long App, 10-12 questions — default for B2C):
Q1: Y/N Qualifier (hard gate — "Are you a [target] looking to [outcome]?" / "No — I will leave this page immediately")
Q2-3: Pre-Sell multi-choice ("Select ALL that apply" — benefit-focused, increases engagement)
Q4: Light Qualifier (situational question)
Q5-6: Hard Qualifiers (fill-in questions for intent, pain, urgency, financial capacity)
Q7-8: Hard Qualifiers continued (timeline, commitment level)
Q9-12: Contact Info (First Name, Last Name, Email, Phone) — ALWAYS after qualifying questions, never before
Final Q: Y/N Commitment ("Will you 100% commit to attending?" with "Maybe" = DQ score of 1)

Format 2 (Short App, 7-9 questions — test AFTER Format 1):
Q1: Y/N Qualifier → Q2: Light Qualifier → Q3: Qualifier/Pre-sell → Q4: Hard Qualifier → Contact Info → Y/N Commitment

Key sequencing rules:
- Always START with a hard Y/N qualifier — it sets the tone and filters immediately
- Always END with a commitment Y/N — captures "Maybe" prospects for DQ
- Contact info goes AFTER qualifying questions — reduces friction of starting the form
- Pre-sell questions come early to build momentum before hard qualifiers
- Display ONE question at a time (Typeform-style) — showing all questions at once causes "form shock" and dramatically increases drop-off

QUESTION TYPE BEST PRACTICES:
- Fill-in (short_text, long_text): CRITICAL for qualifying intent, pain, and urgency. Multi-choice categorizes, but fill-in lets reps meet the prospect where they are. Character count = engagement level. Emotional language = pain depth.
- Multi-choice: Good for routing/grading, but 50% of people lie on financial qualification questions. Use financial data enrichment when possible instead.
- Yes/No: Use for hard gates (Q1 qualifier, final commitment). 3% who click "No" on opening Y/N qualifiers have a 100% no-show rate — these are immediate DQs.
- Pre-sell multi-choice: Must pass the test: "If the lead fills this out honestly, are they MORE or LESS likely to complete the rest?" Should be net positive for engagement.

KEY BENCHMARKS:
- Fixing the confirmation page alone can yield ~10% show rate improvement
- Only allow bookings 48 hours out (CRITICAL — show rate for calls 3+ days out drops significantly)
- Grade 2.5+ = MQL (goes directly to closers), below 2.5 = setter territory
- CPMQL (Cost Per Marketing Qualified Lead) is the metric that matters, not raw cost per booking
- Application reading level should be Grade 5-7 (check with Hemingway App)
- "Not all conversions are created equal" — optimizing for qualified bookings is fundamentally different from optimizing for raw volume

SHOW RATE CONTEXT:
To get someone to show up, you must answer two questions:
1. "How do I show up?" — Logistics (Zoom link, time, how to prepare, what to expect)
2. "Why should I show up?" — Motivation (why this call matters, what they'll gain)
Best practice: Two confirmation page videos — a short logistics video (2-3 min) and a longer homework/training video (15-25 min) that acts as a second VSL disguised as education.

You also have broad knowledge of established qualification frameworks (BANT, MEDDIC, SPIN) and apply them where relevant alongside the above methodology. You understand consumer psychology, behavioral economics, commitment escalation, and cognitive load theory.

YOU HAVE ACCESS TO:
- The company description and what they sell
- Every question in order with type, choices, and drop-off rate
- Real response data showing what leads actually answer
- Grade distributions showing how answers correlate with lead quality
- Funnel data showing conversion through booked > showed > closed
- Financial data if available
- Any notes the client provided about their goals or concerns

VOICE & TONE:
- Be direct and blunt, but empathetic. Acknowledge what's working before critiquing.
- Be a teacher — explain the WHY behind every recommendation using first principles and psychology, not just "change this."
- Be opinionated — take clear positions. You're a paid consultant, not a diplomat.
- If something is great, say so enthusiastically and explain why it works — don't change things just to change them.
- Prioritize every recommendation with urgency tags.

OUTPUT FORMAT — Use these exact ## headers. Skip sections only if truly no data exists:

## Executive Assessment
2-3 sentences. Is this a good application? What's the single biggest opportunity? Which of the Four Buckets is weakest?

## Question-by-Question Audit
For EACH question in order, provide:

### Q[N]: "[question title]"
- **Purpose & Bucket**: What is this question trying to accomplish? Which of the 4 Buckets does it serve? (WANT / SHOW / ABILITY / LIKELY, or Pre-sell, or Contact Info)
- **Effectiveness**: Based on the response data, is it achieving that purpose? Use specific numbers from the data.
- **Drop-off Impact**: If drop-off data exists, is this question causing abandonment? Is the qualification value worth the friction cost?
- **Sequencing**: Is this question in the right position? Would it be more effective earlier or later?
- **Response Quality**: Are the responses useful for sales? Do they differentiate high-quality from low-quality leads? For fill-in questions: are responses detailed enough to be actionable on calls?
- **Recommendation**: KEEP as-is / MODIFY (with exact new question text and why) / MOVE (reposition with justification) / REMOVE (with justification)

## Sequence & Flow Analysis
- Compare the current sequence against the strategic sequencing framework (Y/N → Pre-Sell → Qualifiers → Contact → Commitment)
- Is it building momentum and micro-commitments, or creating jarring transitions?
- Does the sequence start easy and escalate commitment appropriately?
- Provide a specific recommended question order if changes needed

## Gap Analysis
- Which of the Four Buckets is under-represented or missing?
- What critical qualification information is MISSING?
- Recommended questions to ADD (with exact text, question type, and placement)
- Every addition must earn its place — justify the qualification value vs. the drop-off cost

## Marketing & Positioning Signals
- Based on how leads respond, what does this tell us about the marketing driving them?
- Are leads pre-qualified by the time they hit the application, or is the app doing all the heavy lifting?
- Any disconnect between what the company offers and what leads seem to expect?
- If responses suggest a marketing problem rather than an application problem, say so

## Drop-off & Friction Analysis
- Which questions have the highest drop-off rates and why?
- Are any questions too complex, too personal too early, or redundant?
- Is the form displayed one-question-at-a-time or all at once? (If all at once, flag as critical)
- Cost-benefit: which questions provide the most qualification value per unit of friction?

## Grading & Qualification Optimization
- Are the current grading criteria effectively separating MQLs (Grade 2.5+) from non-MQLs?
- Do grade distributions suggest the rubric is well-calibrated or needs adjustment?
- Are there response patterns that predict show/close but aren't being captured in grading?
- Are multi-choice financial questions being relied on too heavily? (50% lie rate)

## Show Rate & Conversion Impact
- How does the current application design affect show rates? (pre-sell effectiveness, commitment question strength, urgency signals)
- Does the application create enough buy-in that prospects will prioritize attending their call?
- Are there questions that could double as pre-sell tools if reworded?
- Recommendations for post-booking sequence if relevant (confirmation page, reminders)

## Action Items
Prioritized by urgency and expected impact:

**IMMEDIATE (do now — highest leverage)**:
1. [Change] — Why: [first-principles reasoning] — Expected effect: [specific prediction]

**SHORT-TERM (test in 2-4 weeks)**:
1. [Change] — Why: [reasoning] — Expected effect: [prediction]

**FUTURE (30-60 days)**:
1. [Change] — Why: [reasoning] — Expected effect: [prediction]

RULES:
- Reference SPECIFIC data (exact percentages, counts, response examples) — never generalize
- Every recommendation must be justified with data from the application OR established best practice
- Consider the full customer journey: ad > landing page > application > booking > confirmation > sale
- Account for the company's specific business context when making recommendations
- If a question is great, say so enthusiastically — don't change things just to change them
- Be a teacher: explain the psychology and first principles behind your recommendations
- Total output: 1500-3000 words depending on question count`;

// ── API Handler ─────────────────────────────────────────────────────────────

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

    if (app.questions.length === 0) {
      return NextResponse.json(
        { success: false, error: "No questions configured. Add questions first." },
        { status: 400 }
      );
    }

    // ── Aggregate data ──────────────────────────────────────────────────
    const funnel = computeFunnel(submissions, callResults);
    const grades = computeGrades(submissions);
    const questionData = buildQuestionAuditData(app);
    const financialLines = computeFinancialSummary(financialRecords);

    // ── Build data payload ──────────────────────────────────────────────
    const payload: string[] = [];

    // Company context
    if (profile.company_description?.trim()) {
      payload.push(`## Company Description\n${profile.company_description.trim()}\n`);
    }

    // Client notes
    if (clientNotes?.trim()) {
      payload.push(`## Client Notes & Goals\n${clientNotes.trim()}\n`);
    }

    // Application overview
    payload.push(`## Application: "${app.title}"`);
    payload.push(`Total questions: ${app.questions.length}`);
    payload.push(`Total submissions: ${submissions.length}`);
    payload.push(`Call results available: ${callResults.length > 0 ? "Yes" : "No"}`);
    payload.push(`Financial data available: ${financialRecords.length > 0 ? "Yes" : "No"}`);
    payload.push("");

    // Funnel data
    if (callResults.length > 0) {
      payload.push("## Funnel Data");
      payload.push(`- Submissions: ${funnel.totalSubmissions}`);
      payload.push(`- Booked: ${funnel.bookedCount} (${funnel.bookRate} of submissions)`);
      payload.push(`- Showed: ${funnel.showedCount} (${funnel.showRate} of booked)`);
      payload.push(`- Closed: ${funnel.closedCount} (${funnel.closeRate} of showed)`);
      payload.push(`- Overall close rate: ${funnel.overallCloseRate}`);
      payload.push("");
    }

    // Grade distributions
    if (grades.length > 0) {
      payload.push("## Grade Distributions");
      for (const g of grades) {
        const entries = Object.entries(g.buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `  Grade ${k}: ${v} (${pct(v, g.total)})`)
          .join("\n");
        payload.push(`${g.label} (${g.total} graded):\n${entries}`);
      }
      payload.push("");
    }

    // Questions with full data
    payload.push("## Questions (in order)\n");
    for (const q of questionData) {
      payload.push(`### Q${q.index}: "${q.title}"`);
      payload.push(`Type: ${q.type} | Required: ${q.required ? "yes" : "no"} | Responses: ${q.totalResponses}`);
      if (q.allowMultipleSelection) payload.push(`Multi-select: yes`);
      if (q.dropOffRate != null) payload.push(`Drop-off rate: ${q.dropOffRate}%`);
      if (q.gradingPrompt) payload.push(`Custom grading: yes`);

      if (q.choices && q.choices.length > 0) {
        payload.push(`Choices: ${q.choices.map((c) => `"${c.label}"`).join(", ")}`);
      }

      if (q.topAnswers.length > 0) {
        payload.push("Top answers:");
        for (const ta of q.topAnswers) {
          payload.push(`  "${ta.answer}" — ${ta.count} times (${pct(ta.count, q.totalResponses)})`);
        }
      }

      if (q.sampleOpenEnded.length > 0) {
        payload.push(`\nSample responses (${q.sampleOpenEnded.length} of ${q.totalResponses}):`);
        for (const s of q.sampleOpenEnded) {
          payload.push(`  "${s}"`);
        }
      }

      if (q.byGrade) {
        payload.push("\nAnswers by grade level:");
        for (const [grade, answers] of Object.entries(q.byGrade).sort(([a], [b]) => b.localeCompare(a))) {
          payload.push(`  Grade ${grade} (${answers.length} samples):\n${answers.map((a) => `    "${a}"`).join("\n")}`);
        }
      }

      payload.push("");
    }

    // Financial summary
    if (financialLines.length > 0) {
      payload.push("## Financial Summary");
      payload.push(...financialLines);
      payload.push("");
    }

    const userMessage = `Audit this application form and provide your comprehensive analysis:\n\n${payload.join("\n")}`;

    // ── Call Anthropic ──────────────────────────────────────────────────
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
        { success: false, error: "No audit generated. Please try again." },
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
    console.error("Generate audit error:", msg);
    const isAuthError =
      msg.includes("401") || msg.includes("authentication") || msg.includes("invalid");
    return NextResponse.json(
      {
        success: false,
        error: isAuthError
          ? "Invalid API key. Check your Anthropic API key in Settings."
          : "Failed to generate audit. Please try again.",
      },
      { status: 500 }
    );
  }
}
