-- Update a single application within a client's profile JSONB without reading the full profile.
-- Finds the app by ID in the applications array and replaces it in-place.
-- Call via: supabase.rpc('update_application', { p_client_id, p_app_id, p_app_data })
CREATE OR REPLACE FUNCTION update_application(
  p_client_id text,
  p_app_id text,
  p_app_data jsonb
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  app_index int;
BEGIN
  -- Find the index of the application with the matching ID
  SELECT ordinality - 1 INTO app_index
  FROM clients,
       jsonb_array_elements(profile->'applications') WITH ORDINALITY AS elem
  WHERE client_id = p_client_id
    AND elem->>'id' = p_app_id
  LIMIT 1;

  IF app_index IS NULL THEN
    RETURN false;
  END IF;

  -- Update just that one application element in the JSONB array
  UPDATE clients
  SET profile = jsonb_set(
        profile,
        ARRAY['applications', app_index::text],
        p_app_data
      ),
      updated_at = now()
  WHERE client_id = p_client_id;

  RETURN true;
END;
$$;
