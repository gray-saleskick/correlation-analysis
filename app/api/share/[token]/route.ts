import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { readApplicationFull, readClient } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  try {
    // Query applications table directly for the share token
    const { data, error } = await supabase
      .from("applications")
      .select("id, client_id, share_enabled")
      .eq("share_token", token)
      .eq("share_enabled", true)
      .maybeSingle();

    if (error) {
      console.error("Share lookup error:", error.message);
      return NextResponse.json({ error: "Failed to look up share link" }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Share link not found or disabled" }, { status: 404 });
    }

    // Get full application data
    const app = await readApplicationFull(data.id);
    if (!app) {
      return NextResponse.json({ error: "Share link not found or disabled" }, { status: 404 });
    }

    // Get client info for the company description
    const client = await readClient(data.client_id);

    return NextResponse.json({
      success: true,
      clientName: client?.clientName ?? "",
      companyDescription: client?.company_description,
      app: {
        id: app.id,
        title: app.title,
        questions: app.questions,
        submissions: app.submissions,
        bookings: app.bookings,
        financial_records: app.financial_records,
        call_results: app.call_results,
        grade_mappings: app.grade_mappings,
        narrative_analysis: app.narrative_analysis,
        narrative_generated_at: app.narrative_generated_at,
        audit_analysis: app.audit_analysis,
        audit_generated_at: app.audit_generated_at,
        grading_audit_analysis: app.grading_audit_analysis,
        grading_audit_generated_at: app.grading_audit_generated_at,
      },
    });
  } catch (err) {
    console.error("Share lookup error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
