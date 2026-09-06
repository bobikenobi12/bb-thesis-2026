"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { Button } from "@repo/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/ui/command";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import { authClient } from "@/lib/auth/client";
import { cn } from "@repo/ui/utils";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

import { fetchRepositoriesByProvider } from "@/app/server/actions/git/repositories";
import { Repository } from "@/app/server/actions/git/types";
import { getLinkedProviders } from "@/app/server/actions/identities";
import { useRepositoryContext } from "@/components/design-project/repository-context";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface RepositorySelectorProps {
  value: string | undefined;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  required?: boolean;
  variant?: "default" | "settings";
  onRepositorySelect?: (repository: Repository) => void;
}

const PROVIDER_HOSTS: Record<string, PublicGitProvider> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/** Maps a saved repo URL to its git provider by exact host match; null for
 *  non-URLs (e.g. an `owner/repo` slug) or unrecognized hosts. */
const GIT_PROVIDERS = [
  "github",
  "bitbucket",
  "gitlab",
] as const satisfies readonly PublicGitProvider[];

function providerFromRepoUrl(url: string): PublicGitProvider | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [h, p] of Object.entries(PROVIDER_HOSTS)) {
      if (host === h || host.endsWith(`.${h}`)) return p;
    }
  } catch {
    // not a URL — fall through to null
  }
  return null;
}

export function RepositorySelector({
  value,
  onChange,
  label,
  placeholder,
  required,
  variant = "default",
  onRepositorySelect,
}: RepositorySelectorProps) {
  const sharedCtx = useRepositoryContext();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingRepos, setFetchingRepos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRecoveryProvider, setAuthRecoveryProvider] =
    useState<PublicGitProvider | null>(null);
  const [linkedProviders, setLinkedProviders] = useState<PublicGitProvider[]>(
    [],
  );
  const [selectedProvider, setSelectedProvider] =
    useState<PublicGitProvider | null>(null);
  const [showLinkOptions, setShowLinkOptions] = useState(false);
  const [isManual, setIsManual] = useState(false);
  const [initialValue] = useState(value);
  const [open, setOpen] = useState(false);
  const repositoryShellBorder = error
    ? variant === "settings"
      ? "border-border-strong ring-1 ring-border-strong"
      : "border-destructive/50"
    : variant === "settings"
      ? "border-border-strong"
      : "border-input";

  // When shared context exists, use its data instead of fetching independently
  useEffect(() => {
    if (!sharedCtx) return;
    setLinkedProviders(sharedCtx.linkedProviders);
    setLoading(sharedCtx.loadingProviders);

    if (sharedCtx.linkedProviders.length > 0 && !selectedProvider) {
      let provider = sharedCtx.linkedProviders[0];
      const detected = initialValue ? providerFromRepoUrl(initialValue) : null;
      if (detected) provider = detected;
      if (sharedCtx.linkedProviders.includes(provider)) {
        setSelectedProvider(provider);
      } else {
        setSelectedProvider(sharedCtx.linkedProviders[0]);
      }
    }
  }, [sharedCtx?.linkedProviders, sharedCtx?.loadingProviders]);

  useEffect(() => {
    if (!sharedCtx || !selectedProvider) return;
    const repos = sharedCtx.reposByProvider[selectedProvider];
    if (repos) {
      setRepositories(repos);
      setFetchingRepos(false);
    } else {
      setFetchingRepos(sharedCtx.loadingRepos);
      sharedCtx.fetchRepos(selectedProvider);
    }
  }, [sharedCtx?.reposByProvider, selectedProvider, sharedCtx?.loadingRepos]);

  // Declared before loadInitialData, which awaits it. The old ordering only
  // worked because the call is async; referencing the binding above its
  // declaration is a TDZ hazard (react-hooks/immutability).
  const fetchRepositories = async (providerName: PublicGitProvider) => {
    setFetchingRepos(true);
    setError(null);
    setAuthRecoveryProvider(null);
    let recoveryProvider: PublicGitProvider | null = null;
    try {
      const data = await fetchRepositoriesByProvider(providerName);
      if (data.error) {
        if (
          data.authErrorCode &&
          data.authProvider &&
          (data.authErrorCode === "token_expired" ||
            data.authErrorCode === "unauthorized" ||
            data.authErrorCode === "missing_token")
        ) {
          setAuthRecoveryProvider(data.authProvider);
          recoveryProvider = data.authProvider;
        }
        throw new Error(data.error);
      }

      setRepositories(data.repositories || []);
    } catch (err) {
      console.error(`Error fetching ${providerName} repositories:`, err);
      setError(
        recoveryProvider
          ? `Authentication with ${recoveryProvider} failed or expired. Relink your account and try again.`
          : err instanceof Error
            ? err.message
            : "Failed to fetch repositories",
      );
      setRepositories([]);
    } finally {
      setFetchingRepos(false);
    }
  };

  const loadInitialData = useCallback(async () => {
    if (sharedCtx) return; // Skip — using shared context
    setLoading(true);
    setError(null);
    try {
      const providers = await getLinkedProviders();
      setLinkedProviders(providers);

      if (providers.length > 0) {
        let initialProvider = providers[0];
        const detected = initialValue
          ? providerFromRepoUrl(initialValue)
          : null;
        if (detected) initialProvider = detected;

        if (providers.includes(initialProvider)) {
          setSelectedProvider(initialProvider);
          await fetchRepositories(initialProvider);
        } else {
          setSelectedProvider(providers[0]);
          await fetchRepositories(providers[0]);
        }
      }
    } catch (err) {
      console.error("Error loading linked providers:", err);
      setError("Failed to load linked accounts");
    } finally {
      setLoading(false);
    }
  }, [initialValue, sharedCtx]);

  useEffect(() => {
    if (!sharedCtx) loadInitialData();
  }, [loadInitialData, sharedCtx]);

  const handleProviderChange = async (provider: PublicGitProvider) => {
    setSelectedProvider(provider);
    onChange(""); // Reset selected repository when provider changes
    await fetchRepositories(provider);
  };

  const handleLinkAccount = async (providerName: PublicGitProvider) => {
    try {
      const callbackURL = "/dashboard/configure";

      // Better Auth account linking — native GitHub via linkSocial (repo
      // scope); self-hosted GitLab + Bitbucket via the genericOAuth link
      // endpoint (scopes are server-configured). Redirects to the provider.
      // `oauth2.link` was deleted in 1.7; generic providers link through linkSocial
      // like any other. Only github needs an explicit scope — gitlab/bitbucket scopes
      // stay server-configured.
      const { error } = await authClient.linkSocial({
        provider: providerName,
        ...(providerName === "github" ? { scopes: ["repo"] } : {}),
        callbackURL,
      });

      if (error) throw new Error(error.message);
    } catch (err) {
      console.error("Error linking provider:", providerName, err);
      setError(
        `Failed to link ${providerName} account. Please try signing out and back in.`,
      );
    }
  };

  if (loading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-4 w-24 bg-muted rounded" />
        <div className="h-10 w-full bg-muted rounded" />
      </div>
    );
  }

  if (linkedProviders.length === 0 && !isManual) {
    return (
      <div
        className={cn(
          "space-y-3 border p-4",
          variant === "settings"
            ? "rounded-sm border-dashed border-border-strong bg-surface-sunken"
            : "rounded-lg bg-muted/30",
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
          <span>No Git accounts linked</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Link an account to select repositories automatically, or enter the URL
          manually.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleLinkAccount("github")}
          >
            <GitProviderIcon provider="github" className="mr-2" /> Link GitHub
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleLinkAccount("gitlab")}
          >
            <GitProviderIcon provider="gitlab" className="mr-2" /> Link GitLab
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => handleLinkAccount("bitbucket")}
          >
            <GitProviderIcon provider="bitbucket" className="mr-2" /> Link
            Bitbucket
          </Button>
          <div className="w-full mt-2">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-xs px-0 text-muted-foreground hover:text-foreground"
              onClick={() => setIsManual(true)}
            >
              Or enter repository URL manually
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isManual) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between min-h-[20px]">
          {label ? (
            <label className="text-sm font-medium">
              {label}
              {required && <span className="text-destructive ml-1">*</span>}
            </label>
          ) : (
            <div />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsManual(false)}
            className="text-ui-xs text-muted-foreground h-auto py-0.5 px-1.5"
          >
            Use provider select
          </Button>
        </div>
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://github.com/organization/repository"
          className={cn(
            "font-mono text-sm",
            variant === "settings" &&
              "h-[38px] rounded-sm border-border-strong bg-surface-sunken",
          )}
        />
        <p className="text-xs text-muted-foreground">
          Enter the full HTTP URL to your Git repository.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">
            {label}
            {required && <span className="text-destructive ml-1">*</span>}
          </label>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <div
          className={cn(
            "flex flex-1 items-center gap-0 overflow-hidden border bg-transparent focus-within:ring-1 focus-within:ring-ring",
            variant === "settings"
              ? "rounded-sm bg-surface-sunken shadow-none"
              : "rounded-md shadow-sm",
            repositoryShellBorder,
          )}
        >
          {/* Provider Selection (Icon Only) */}
          <Select
            value={selectedProvider || ""}
            onValueChange={(val) =>
              handleProviderChange(coerceEnum(val, GIT_PROVIDERS, "github"))
            }
          >
            {/* Icon-only, so there is no text node to fall back on even if the role allowed one:
                the trigger is a `<button role="combobox">` whose whole content is an `<svg>`. The
                UI conformance audit never scored this because the audit user has no linked git
                provider and the component renders its "connect a provider" branch instead. That is
                the exact failure mode #3756 is about: not a control that is fine, a control that is
                unnamed on every route reaching it and that nothing has reached yet. */}
            <SelectTrigger
              aria-label={
                selectedProvider ? `Git provider: ${selectedProvider}` : "Git provider"
              }
              className={cn(
                "w-[50px] shrink-0 justify-center rounded-none border-0 border-r bg-muted/20 px-0 focus:ring-0 focus:ring-offset-0",
                variant === "settings" &&
                  "h-[38px] border-border-strong bg-transparent",
              )}
            >
              {selectedProvider ? (
                <GitProviderIcon provider={selectedProvider} size={18} />
              ) : (
                <SelectValue />
              )}
            </SelectTrigger>
            <SelectContent>
              {linkedProviders.map((p) => (
                <SelectItem key={p} value={p}>
                  <div className="flex items-center gap-2">
                    <GitProviderIcon provider={p} />
                    <span className="capitalize">{p}</span>
                  </div>
                </SelectItem>
              ))}
              <div className="border-t my-1" />
              <Button
                variant="ghost"
                className="w-full justify-start text-xs h-8 px-2 font-normal"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowLinkOptions(!showLinkOptions);
                }}
              >
                <Plus className="w-3 h-3 mr-2" /> Link another
              </Button>
            </SelectContent>
          </Select>

          {/* Repository Selection with Combobox or Error State */}
          {error ? (
            <div className="flex-1 flex items-center gap-2 px-3 min-h-9">
              <AlertCircle
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  variant === "settings"
                    ? "text-text-tertiary"
                    : "text-destructive",
                )}
              />
              <span
                className={cn(
                  "truncate text-sm",
                  variant === "settings"
                    ? "text-text-secondary"
                    : "text-destructive",
                )}
              >
                {authRecoveryProvider
                  ? "Session expired — relink to continue"
                  : error}
              </span>
            </div>
          ) : (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger
                render={
                  // NO `role="combobox"`, and no hand-written `aria-expanded`. The role was untrue
                  // — there is no text input and no owned listbox here, and base-ui's popover
                  // already reports `aria-haspopup="dialog"` plus `aria-expanded`/`aria-controls`
                  // from `useRole` — and it was ACTIVELY harmful, because `combobox` is
                  // name-from-author-only: with it on, the repository name the button displays was
                  // not the button's accessible name and the control had none.
                  //
                  // With the role gone the visible text names the button, so a name is written only
                  // where the visible text does not state the purpose: once a repo is picked the
                  // button reads "acme/shop", which says what is selected but not what the control
                  // does. Empty, it already reads "Select repository..." and a second name would
                  // only be something new to keep in sync.
                  <Button
                    variant="ghost"
                    aria-label={
                      value
                        ? `Select repository: ${
                            repositories.find((r) => r.url === value)?.full_name ??
                            value
                          }`
                        : undefined
                    }
                    className={cn(
                      "flex-1 justify-start rounded-none border-0 hover:bg-transparent font-normal px-3",
                      !value && "text-muted-foreground",
                      fetchingRepos && "opacity-50",
                    )}
                    disabled={fetchingRepos || repositories.length === 0}
                  >
                    {value ? (
                      <div className="flex items-center gap-2 w-full truncate text-left">
                        <span className="font-mono text-sm truncate max-w-[calc(100%-40px)]">
                          {repositories.find((r) => r.url === value)
                            ?.full_name || value}
                        </span>
                        {repositories.find((r) => r.url === value)?.private && (
                          <span className="text-ui-2xs bg-muted text-muted-foreground px-1 py-0 rounded shrink-0">
                            Private
                          </span>
                        )}
                      </div>
                    ) : fetchingRepos ? (
                      "Fetching repositories..."
                    ) : repositories.length === 0 ? (
                      "No repositories found"
                    ) : (
                      placeholder || "Select repository..."
                    )}
                  </Button>
                }
              />
              <PopoverContent className="w-[400px] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search repositories..." />
                  <CommandList>
                    <CommandEmpty>No repository found.</CommandEmpty>
                    <CommandGroup>
                      {repositories.map((repo) => (
                        <CommandItem
                          key={repo.id}
                          value={repo.full_name}
                          onSelect={() => {
                            onChange(repo.url);
                            onRepositorySelect?.(repo);
                            setOpen(false);
                          }}
                        >
                          <div className="flex w-full items-center justify-between">
                            <span className="font-mono text-sm truncate">
                              {repo.full_name}
                            </span>
                            {repo.private && (
                              <span className="text-ui-2xs bg-muted text-muted-foreground px-1 py-0 rounded shrink-0 ml-2">
                                Private
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* Action buttons (refresh/relink/manual) */}
        {authRecoveryProvider ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => handleLinkAccount(authRecoveryProvider)}
            className={cn(
              "h-9 w-9 shrink-0",
              variant === "settings"
                ? "text-text-tertiary hover:text-text-primary"
                : "text-destructive hover:text-destructive",
            )}
            title="Relink account"
          >
            <GitProviderIcon provider={authRecoveryProvider} size={14} />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() =>
              selectedProvider && fetchRepositories(selectedProvider)
            }
            disabled={fetchingRepos || !selectedProvider}
            className="h-9 w-9 shrink-0"
            title="Refresh repositories"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${fetchingRepos ? "animate-spin" : ""}`}
            />
          </Button>
        )}
      </div>

      {showLinkOptions && (
        <div className="flex flex-wrap gap-2 p-2 border rounded-md bg-muted/20 animate-in fade-in slide-in-from-top-1">
          <p className="text-ui-2xs uppercase font-bold text-muted-foreground w-full mb-1">
            Link Platform
          </p>
          {!linkedProviders.includes("github") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleLinkAccount("github")}
            >
              <GitProviderIcon provider="github" className="mr-1" /> GitHub
            </Button>
          )}
          {!linkedProviders.includes("gitlab") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleLinkAccount("gitlab")}
            >
              <GitProviderIcon provider="gitlab" className="mr-1" /> GitLab
            </Button>
          )}
          {!linkedProviders.includes("bitbucket") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleLinkAccount("bitbucket")}
            >
              <GitProviderIcon provider="bitbucket" className="mr-1" />{" "}
              Bitbucket
            </Button>
          )}
        </div>
      )}

      {repositories.length === 0 &&
        !fetchingRepos &&
        !error &&
        selectedProvider && (
          <p className="text-xs text-muted-foreground italic px-1">
            No repositories found for this account.
          </p>
        )}
    </div>
  );
}
