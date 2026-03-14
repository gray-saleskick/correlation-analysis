import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM_PROMPTS: Record<string, string> = {
  narrative: `You are a follow-up assistant for a lead analysis consultation. The original lead analysis is provided below. Answer the user's follow-up questions based on this analysis and the underlying data it references.

Be concise and specific — reference data points, percentages, and specific findings from the analysis. If the user asks about something not covered, say so rather than speculating. Keep responses focused and actionable.

Format: Use short paragraphs and bullet points. Bold key terms with **bold**. Keep responses under 500 words unless the question genuinely requires more depth.`,

  audit: `You are a follow-up assistant for an application audit consultation. The original application audit is provided below. Answer the user's follow-up questions based on this audit and the underlying data it references.

Be concise and specific — reference specific questions, data points, and recommendations from the audit. If the user asks about something not covered, say so rather than speculating. Keep responses focused and actionable.

Format: Use short paragraphs and bullet points. Bold key terms with **bold**. Keep responses under 500 words unless the question genuinely requires more depth.`,

  grading_audit: `You are a follow-up assistant for a grading and scoring audit consultation. The original grading audit is provided below. Answer the user's follow-up questions based on this analysis and the underlying grade-to-outcome data it references.

Be concise and specific — reference specific grade thresholds, answer bucket scores, financial cutoffs, show/close rates by grade level, and recommendations from the audit. If the user asks about something not covered, say so rather than speculating. Keep responses focused and actionable.

Format: Use short paragraphs and bullet points. Bold key terms with **bold**. Keep responses under 500 words unless the question genuinely requires more depth.`,
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string; appId: string }> }
) {
  const { clientId, appId } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const { apiKey: bodyApiKey, context, messages, systemContext } = body as {
      apiKey?: string;
      context?: string;
      messages?: { role: "user" | "assistant"; content: string }[];
      systemContext?: string;
    };

    const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "API key is required. Set ANTHROPIC_API_KEY env var or add key in Settings." },
        { status: 400 }
      );
    }

    if (!context || !["narrative", "audit", "grading_audit"].includes(context)) {
      return NextResponse.json(
        { success: false, error: "Invalid context. Must be 'narrative', 'audit', or 'grading_audit'." },
        { status: 400 }
      );
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { success: false, error: "Messages array is required." },
        { status: 400 }
      );
    }

    if (!systemContext) {
      return NextResponse.json(
        { success: false, error: "System context (original analysis) is required." },
        { status: 400 }
      );
    }

    const contextLabels: Record<string, string> = {
      narrative: "LEAD ANALYSIS",
      audit: "APPLICATION AUDIT",
      grading_audit: "GRADING AUDIT",
    };
    const systemPrompt = `${SYSTEM_PROMPTS[context]}\n\n--- ORIGINAL ${contextLabels[context] ?? "ANALYSIS"} ---\n\n${systemContext}`;

    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const reply = textBlock?.type === "text" ? textBlock.text.trim() : "";

    if (!reply) {
      return NextResponse.json(
        { success: false, error: "No response generated." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat request failed";
    console.error("Chat error:", msg);
    const isAuthError =
      msg.includes("401") || msg.includes("authentication") || msg.includes("invalid");
    return NextResponse.json(
      {
        success: false,
        error: isAuthError
          ? "Invalid API key. Check your Anthropic API key in Settings."
          : "Failed to get response. Please try again.",
      },
      { status: 500 }
    );
  }
}
