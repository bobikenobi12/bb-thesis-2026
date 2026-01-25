-- Add cluster_id to configurations to link them to a specific target environment
ALTER TABLE public.configurations 
ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES public.clusters(id);

-- Make AWS fields optional since they can be derived from the cluster
ALTER TABLE public.configurations 
ALTER COLUMN aws_account_id DROP NOT NULL,
ALTER COLUMN aws_region DROP NOT NULL;
