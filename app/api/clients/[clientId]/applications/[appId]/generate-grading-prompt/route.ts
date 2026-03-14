import { NextRequest, NextResponse } from "next/server";
import { readProfile } from "@/lib/store";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// ── Template Types & Loading ─────────────────────────────────────────────────

interface GradingTemplate {
  id: string;
  label: string;
  explanation: string;
  template: string;
}

const ALLOWED_TEMPLATES = new Set([
  "biggest-challenge", "most-help", "what-is-your-goal",
  "why-now", "multiple-choice", "occupation",
]);

function loadTemplate(templateId: string): GradingTemplate | null {
  if (!ALLOWED_TEMPLATES.has(templateId)) return null;
  const filePath = path.join(process.cwd(), "data", "grading-templates", `${templateId}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as GradingTemplate;
  } catch {
    return null;
  }
}

// ── Collect Real Submission Answers ──────────────────────────────────────────

function collectAnswersForQuestion(
  questionId: string,
  questionRef: string | undefined,
  questionTitle: string,
  submissions: Array<{ answers: Array<{ question_ref: string; question_title: string; value: string | null }>; grade?: { answer_grade?: number; final_grade?: number } }>
): { answers: string[]; gradedAnswers: Map<number, string[]> } {
  const answers: string[] = [];
  const gradedAnswers = new Map<number, string[]>();

  for (const sub of submissions) {
    const match = sub.answers.find(
      (a) =>
        a.question_ref === questionId ||
        a.question_ref === questionRef ||
        a.question_title.toLowerCase().trim() === questionTitle.toLowerCase().trim()
    );
    if (!match || !match.value?.trim()) continue;

    const val = match.value.trim();
    answers.push(val);

    const grade = sub.grade?.answer_grade ?? sub.grade?.final_grade;
    if (grade != null && grade >= 1 && grade <= 4) {
      const rounded = Math.round(grade);
      if (!gradedAnswers.has(rounded)) gradedAnswers.set(rounded, []);
      gradedAnswers.get(rounded)!.push(val);
    }
  }

  return { answers, gradedAnswers };
}

// ── Build Examples Context ──────────────────────────────────────────────────

function buildExamplesContext(
  gradedAnswers: Map<number, string[]>,
  allAnswers: string[]
): string {
  const hasGradedData = [1, 2, 3, 4].some((g) => (gradedAnswers.get(g)?.length ?? 0) > 0);

  if (hasGradedData) {
    const parts: string[] = [];
    for (const grade of [1, 2, 3, 4]) {
      const examples = gradedAnswers.get(grade) ?? [];
      if (examples.length > 0) {
        const selected = examples.slice(0, 4);
        parts.push(`Real examples that were graded ${grade}:\n${selected.map((e) => `"${e}"`).join("\n")}`);
      } else {
        parts.push(`No real examples available for grade ${grade} — generate representative examples based on the scoring criteria.`);
      }
    }
    if (allAnswers.length > 0) {
      const ungradedSample = allAnswers.slice(0, 30);
      parts.push(`\nAdditional real responses for reference (${ungradedSample.length} of ${allAnswers.length} total):\n${ungradedSample.map((a) => `"${a}"`).join("\n")}`);
    }
    return parts.join("\n\n");
  }

  if (allAnswers.length >= 15) {
    const shuffled = [...allAnswers].sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, Math.min(50, allAnswers.length));
    return `There are ${allAnswers.length} real submission responses for this question. No pre-assigned grades exist yet, so you must analyze these responses and categorize them yourself.

Here are ${sample.length} real responses:\n${sample.map((a) => `"${a}"`).join("\n")}

IMPORTANT: Use these real answers as your examples. Follow this process:
1. Read through all the responses above to understand the range and quality of answers this audience actually gives.
2. Identify the best responses — these set the baseline for what a grade 4 looks like for THIS audience.
3. Work backwards from there: grade 3 answers are good but not as detailed, grade 2 answers are basic/surface-level, grade 1 answers are vague/irrelevant.
4. Pick the 4 best real examples for each grade level. Only generate synthetic examples if you cannot find enough real ones for a particular grade.
5. Make sure the grade descriptions reflect what this specific audience actually writes.`;
  }

  if (allAnswers.length > 0) {
    return `There are ${allAnswers.length} real submission responses (fewer than 15, so limited data). Here they are:\n${allAnswers.map((a) => `"${a}"`).join("\n")}\n\nUse these to understand the audience tone and style. Supplement with generated examples where needed, but prefer real responses when possible.`;
  }

  return "No submission data is available yet. Generate examples that would be appropriate for this business and audience.";
}

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a grading prompt specialist. Your job is to take a grading template and customize it for a specific question and dataset.

You MUST:
1. Keep the core structure, formatting, and grading scale (1-4) from the template exactly as provided
2. Replace "YOUR QUESTION" with the actual question text
3. Replace all "EXAMPLE" placeholders with real examples from actual submissions whenever possible
4. Tailor the grading criteria descriptions to be specific to the question context and audience
5. ALWAYS prefer real submission data over generated examples
6. When categorizing ungraded responses: find the best real answers first — these define what a grade 4 looks like for this specific audience. Then work backwards to define grades 3, 2, and 1
7. Only generate synthetic examples when there are genuinely not enough real answers for a particular grade level
8. Keep the language professional and clear

Output ONLY the completed grading prompt text. Do NOT wrap it in JSON, markdown code blocks, or any other formatting. Just output the raw grading prompt text ready to be used.`;

// ── API Handler ──────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const {
      questionId,
      questionRef,
      questionTitle,
      questionType,
      questionChoices,
      templateId,
      companyDescription,
      apiKey: bodyApiKey,
    } = body as {
      questionId?: string;
      questionRef?: string;
      questionTitle?: string;
      questionType?: string;
      questionChoices?: { id: string; label: string }[];
      templateId?: string;
      companyDescription?: string;
      apiKey?: string;
    };

    const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;

    if (!questionTitle || !templateId) {
      return NextResponse.json(
        { success: false, error: "questionTitle and templateId are required" },
        { status: 400 }
      );
    }

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "API key is required. Set ANTHROPIC_API_KEY env var or add key in Settings." },
        { status: 400 }
      );
    }

    const template = loadTemplate(templateId);
    if (!template) {
      return NextResponse.json(
        { success: false, error: `Template '${templateId}' not found` },
        { status: 404 }
      );
    }

    // Collect submission examples
    let examplesContext = "No submission data available.";
    const profile = await readProfile(clientId);
    if (profile) {
      const app = profile.applications.find((a) => a.id === appId);
      if (app?.submissions?.length) {
        const { answers, gradedAnswers } = collectAnswersForQuestion(
          questionId ?? "",
          questionRef,
          questionTitle,
          app.submissions
        );
        examplesContext = buildExamplesContext(gradedAnswers, answers);
      }
    }

    // Build user message
    let userMessage: string;

    const companyCtx = companyDescription?.trim()
      ? `## Company Context\n${companyDescription.trim()}\n\n`
      : "";

    if (templateId === "multiple-choice" && questionChoices?.length) {
      userMessage = `${companyCtx}For the question "${questionTitle}", assign a grade to each answer option. Use the format below — one line per option, nothing else. You may use negative grades (like -1 or -10) for disqualifying answers.

The answer options are:
${questionChoices.map((c) => `- "${c.label}"`).join("\n")}

Output ONLY the grading lines in this exact format, one per option:
Give a [grade] for the answer: "[option text]"`;
    } else {
      userMessage = `${companyCtx}## Question Being Graded
Question: "${questionTitle}"
Question type: ${questionType ?? "open-ended"}

## Template to Customize
${template.template}

## Template Explanation
${template.explanation}

## Real Submission Examples
${examplesContext}

Please generate the customized grading prompt now.`;
    }

    // Call Anthropic API
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const result = textBlock?.type === "text" ? textBlock.text : "";

    return NextResponse.json({ success: true, grading_prompt: result.trim() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed";
    console.error("Generate grading prompt error:", msg);
    // Don't leak full error details
    const isAuthError = msg.includes("401") || msg.includes("authentication") || msg.includes("invalid");
    return NextResponse.json(
      { success: false, error: isAuthError ? "Invalid API key. Please check your Anthropic API key in Settings." : "Failed to generate grading prompt. Please try again." },
      { status: 500 }
    );
  }
}
