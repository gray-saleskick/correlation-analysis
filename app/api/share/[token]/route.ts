import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  try {
    // Search all clients for an application with this share token
    const { data: rows, error } = await supabase
      .from("clients")
      .select("client_id, profile")
      .neq("client_id", "__users__");

    if (error || !rows) {
      return NextResponse.json({ error: "Failed to look up share link" }, { status: 500 });
    }

    for (const row of rows) {
      const profile = row.profile;
      if (!profile?.applications) continue;
      for (const app of profile.applications) {
        if (app.share_token === token && app.share_enabled) {
          // Return read-only data for the share page
          return NextResponse.json({
            success: true,
            clientName: profile.clientName,
            companyDescription: profile.company_description,
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
        }
      }
    }

    return NextResponse.json({ error: "Share link not found or disabled" }, { status: 404 });
  } catch (err) {
    console.error("Share lookup error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
