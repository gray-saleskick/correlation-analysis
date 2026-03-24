import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { ClientProfile } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  try {
    // Use JSONB containment to find the specific client with this share token
    // instead of loading ALL profiles and searching in JS
    const { data, error } = await supabase
      .from("clients")
      .select("client_id, profile")
      .neq("client_id", "__users__")
      .contains("profile", { applications: [{ share_token: token }] })
      .maybeSingle();

    if (error) {
      console.error("Share lookup error:", error.message);
      return NextResponse.json({ error: "Failed to look up share link" }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Share link not found or disabled" }, { status: 404 });
    }

    const profile = data.profile as ClientProfile;
    const app = profile.applications.find(
      (a) => a.share_token === token && a.share_enabled
    );

    if (!app) {
      return NextResponse.json({ error: "Share link not found or disabled" }, { status: 404 });
    }

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
  } catch (err) {
    console.error("Share lookup error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
