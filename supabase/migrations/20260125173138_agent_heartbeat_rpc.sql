-- Secure Agent Operations via RPC (SECURITY DEFINER bypasses RLS)
-- These functions allow the agent to operate using the 'anon' key by providing a valid token hash.

-- 1. Heartbeat
CREATE OR REPLACE FUNCTION public.agent_heartbeat(
  p_cluster_id UUID,
  p_token_hash TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.clusters
  SET 
    last_heartbeat = NOW(),
    status = 'ONLINE'
  WHERE id = p_cluster_id
    AND agent_token_hash = p_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid cluster ID or token hash';
  END IF;
END;
$$;

-- 2. Fetch Next Job
CREATE OR REPLACE FUNCTION public.fetch_next_provision(
  p_cluster_id UUID,
  p_token_hash TEXT
)
RETURNS SETOF public.provisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clusters WHERE id = p_cluster_id AND agent_token_hash = p_token_hash) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT * FROM public.provisions
  WHERE cluster_id = p_cluster_id
    AND status = 'QUEUED'
  ORDER BY created_at ASC
  LIMIT 1;
END;
$$;

-- 3. Update Job Status
CREATE OR REPLACE FUNCTION public.update_provision_status(
  p_cluster_id UUID,
  p_token_hash TEXT,
  p_provision_id UUID,
  p_status TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify agent ownership
  IF NOT EXISTS (SELECT 1 FROM public.clusters WHERE id = p_cluster_id AND agent_token_hash = p_token_hash) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.provisions
  SET 
    status = p_status,
    error_message = p_error_message,
    started_at = CASE WHEN p_status = 'PROCESSING' THEN NOW() ELSE started_at END,
    completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED') THEN NOW() ELSE completed_at END
  WHERE id = p_provision_id 
    AND cluster_id = p_cluster_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provision not found or does not belong to this cluster';
  END IF;
END;
$$;

-- 4. Insert Logs
CREATE OR REPLACE FUNCTION public.insert_provision_log(
  p_cluster_id UUID,
  p_token_hash TEXT,
  p_provision_id UUID,
  p_log_chunk TEXT,
  p_stream_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify agent ownership
  IF NOT EXISTS (
    SELECT 1 FROM public.provisions p
    JOIN public.clusters c ON c.id = p.cluster_id
    WHERE p.id = p_provision_id 
      AND c.id = p_cluster_id 
      AND c.agent_token_hash = p_token_hash
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  INSERT INTO public.provision_logs (provision_id, log_chunk, stream_type)
  VALUES (p_provision_id, p_log_chunk, p_stream_type);
END;
$$;

-- Grant access to all functions for the anon role
GRANT EXECUTE ON FUNCTION public.agent_heartbeat(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.fetch_next_provision(UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.update_provision_status(UUID, TEXT, UUID, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_provision_log(UUID, TEXT, UUID, TEXT, TEXT) TO anon;