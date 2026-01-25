-- 1. Create the new cloud_identities table
CREATE TABLE IF NOT EXISTS public.cloud_identities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('aws', 'azure', 'gcp')),
    name TEXT NOT NULL DEFAULT 'My Cloud Account',
    
    -- We use JSONB for credentials to support different providers in the future
    -- AWS Structure: { "role_arn": "...", "external_id": "...", "account_id": "..." }
    credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Add RLS Policies
ALTER TABLE public.cloud_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own identities" 
    ON public.cloud_identities FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own identities" 
    ON public.cloud_identities FOR INSERT 
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own identities" 
    ON public.cloud_identities FOR UPDATE 
    USING (auth.uid() = user_id);

-- 3. Refactor configurations table (Linking to Identity)
-- Note: You will run this after migrating existing data if needed
ALTER TABLE public.configurations 
ADD COLUMN cloud_identity_id UUID REFERENCES public.cloud_identities(id);

-- Optional: Create an index for faster lookups
CREATE INDEX idx_cloud_identities_user_id ON public.cloud_identities(user_id);
