-- Add configuration_hash to provisions table to ensure data integrity
ALTER TABLE public.provisions 
ADD COLUMN IF NOT EXISTS configuration_hash TEXT;

-- Create an index for potential lookups
CREATE INDEX IF NOT EXISTS idx_provisions_config_hash ON public.provisions(configuration_hash);
