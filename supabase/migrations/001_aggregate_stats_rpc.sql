-- Compute aggregate stats server-side instead of downloading all profiles to JS.
-- Call via: supabase.rpc('get_aggregate_stats')
CREATE OR REPLACE FUNCTION get_aggregate_stats()
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'totalClients', count(*),
    'totalApplications', coalesce(sum(jsonb_array_length(profile->'applications')), 0),
    'totalSubmissions', coalesce((
      SELECT sum(jsonb_array_length(app->'submissions'))
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->'submissions' IS NOT NULL
    ), 0),
    'totalFinancialRecords', coalesce((
      SELECT sum(jsonb_array_length(app->'financial_records'))
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->'financial_records' IS NOT NULL
    ), 0),
    'totalQuestions', coalesce((
      SELECT sum(jsonb_array_length(app->'questions'))
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->'questions' IS NOT NULL
    ), 0),
    'totalCallResults', coalesce((
      SELECT sum(jsonb_array_length(app->'call_results'))
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->'call_results' IS NOT NULL
    ), 0),
    'totalAuditsGenerated', coalesce((
      SELECT count(*)
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->>'audit_analysis' IS NOT NULL
    ), 0),
    'totalGradingAuditsGenerated', coalesce((
      SELECT count(*)
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app
      WHERE c2.client_id != '__users__' AND app->>'grading_audit_analysis' IS NOT NULL
    ), 0),
    'totalBookings', coalesce((
      SELECT count(*)
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app, jsonb_array_elements(app->'call_results') AS cr
      WHERE c2.client_id != '__users__' AND (cr->>'booked')::boolean = true
    ), 0),
    'totalShows', coalesce((
      SELECT count(*)
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app, jsonb_array_elements(app->'call_results') AS cr
      WHERE c2.client_id != '__users__' AND (cr->>'showed')::boolean = true
    ), 0),
    'totalCloses', coalesce((
      SELECT count(*)
      FROM clients c2, jsonb_array_elements(c2.profile->'applications') AS app, jsonb_array_elements(app->'call_results') AS cr
      WHERE c2.client_id != '__users__' AND (cr->>'closed')::boolean = true
    ), 0)
  ) INTO result
  FROM clients
  WHERE client_id != '__users__';

  RETURN result;
END;
$$;
