create table if not exists public.provider_tokens (
    id uuid default gen_random_uuid() primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null,
    access_token text not null,
    refresh_token text,
    expires_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(user_id, provider)
);

alter table public.provider_tokens enable row level security;

create policy "Users can view their own tokens"
on public.provider_tokens for select
using (auth.uid() = user_id);

create policy "Users can insert their own tokens"
on public.provider_tokens for insert
with check (auth.uid() = user_id);

create policy "Users can update their own tokens"
on public.provider_tokens for update
using (auth.uid() = user_id);
