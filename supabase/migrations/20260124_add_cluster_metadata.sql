-- Add metadata column to clusters for storing environment details (VPC, Region, etc)
ALTER TABLE public.clusters 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
