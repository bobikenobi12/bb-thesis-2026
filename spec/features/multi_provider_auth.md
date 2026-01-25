# Multi-Provider Authentication & Token Management

## 1. Problem Statement
Users may use multiple Git providers (GitHub, GitLab, Bitbucket) simultaneously. For example, a user might host their infrastructure code on GitLab but their application code on GitHub.
Standard OAuth flows in Supabase often replace the session's `provider_token` with the most recently used provider. This leads to "missing token" errors when trying to access resources from a provider that isn't the one used for the current login session.

## 2. Solution Overview
To support seamless switching between providers, we persist OAuth tokens in a dedicated database table (`provider_tokens`) immediately after a successful OAuth callback. This ensures that valid tokens are always available for all linked accounts, regardless of the current login method.

## 3. Architecture

### 3.1. Database Schema
A dedicated table `provider_tokens` stores the latest valid tokens for each user-provider pair.

```sql
create table public.provider_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  provider text not null check (provider in ('github', 'gitlab', 'bitbucket')),
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  
  unique(user_id, provider)
);
```

### 3.2. Authentication Flow (Callback)
The file `@apps/web/app/api/auth/callback/route.ts` intercepts the Supabase OAuth callback.
1.  **Exchange Code:** Exchanges the auth code for a session.
2.  **Extract Tokens:** Retrieves `provider_token` and `provider_refresh_token` from the session.
3.  **Persist:** Upserts these tokens into `provider_tokens` table, matching on `(user_id, provider)`.
4.  **Redirect:** Continues the login flow.

### 3.3. Token Retrieval
A helper function `getProviderToken` (`@apps/web/lib/supabase/tokens.ts`) abstracts the complexity:
1.  **Check Session:** First, checks if the current session's `app_metadata.provider` matches the requested provider. If so, returns the session token (optimization).
2.  **Fallback to DB:** If not, queries the `provider_tokens` table for the requested provider.
3.  **Return:** Returns the token or `null`.

## 4. User Interface Implications

### 4.1. Repository Selector
The Repository Selector component must be aware of all linked providers, not just the active session provider.
*   **Discovery:** It should query an endpoint (e.g., `/api/auth/providers`) to list all providers with valid tokens in `provider_tokens`.
*   **Selection:**
    *   If multiple providers are linked, allow the user to select the source.
    *   If only one is linked, default to it.
    *   If none are linked, prompt to connect an account.

### 4.2. Profile Settings
A "Connected Accounts" section in the user profile allows users to:
*   View status of GitHub, GitLab, and Bitbucket connections.
*   Initiate an OAuth flow to link a missing provider (or re-authenticate to refresh a token).
