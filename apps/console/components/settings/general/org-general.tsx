"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · General — the authored claude.ai/design panel (Organization profile /
// Defaults / Danger zone), composed from the shared settings primitives (shadcn +
// Tailwind tokens; no CSS module). Name + slug save via better-auth organization.update;
// description/region/default-env/terraform-version live in org metadata; delete is real.
// Logo upload + ownership transfer are stubbed (tracked in dataroom/spec/features/settings-design-port.md).

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getOrgSettings,
  type OrgPrimaryAddress,
  type OrgSettings,
} from "@/app/server/actions/org-settings";
import {
  SettingsCardFoot,
  SettingsColumns,
  SettingsDangerRow,
  SettingsField,
  SettingsPanel,
  SettingsSection,
  SettingsSelect,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
import { orgHost } from "@/lib/org-url";
import { OrgLogoUpload } from "@/components/org/org-logo-upload";
// NB: the page header lives in general/page.tsx (outside the gate) so it stays visible.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { cn } from "@repo/ui/utils";

const REGIONS = [
  "eu-west-1 · Frankfurt",
  "eu-north-1 · Stockholm",
  "us-east-1 · N. Virginia",
  "ap-southeast-1 · Singapore",
];
const ENVS = ["staging", "development", "production"];

/** A compact, human-readable rendering of the org's primary (billing) address. */
function formatPrimaryAddress(a: OrgPrimaryAddress): string {
  const cityLine = [a.city, a.state, a.postalCode].filter(Boolean).join(" ");
  return [a.name, a.line1, a.line2, cityLine, a.country]
    .filter((part) => part && part.trim())
    .join(", ");
}

export function OrgGeneral() {
  const router = useRouter();
  const activeOrgId = useWorkspaceStore((st) => st.activeOrgId);
  const fetchWorkspace = useWorkspaceStore((st) => st.fetchWorkspace);
  const [s, setS] = useState<OrgSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getOrgSettings()
      .then(setS)
      .catch(() => toast.error("Couldn't load organization settings."));
  }, []);

  function set<K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!s || !activeOrgId) return;
    setSaving(true);
    try {
      const { error } = await authClient.organization.update({
        organizationId: activeOrgId,
        data: {
          name: s.name,
          slug: s.slug,
          metadata: {
            description: s.description,
            region: s.region,
            defaultEnv: s.defaultEnv,
            terraformVersion: s.terraformVersion,
            // Preserve the billing-set primary address — it's not edited here, but the
            // metadata write would otherwise drop it.
            ...(s.primaryAddress ? { primaryAddress: s.primaryAddress } : {}),
          },
        },
      });
      if (error) throw new Error(error.message ?? "Save failed");
      toast.success("Organization updated.");
      await fetchWorkspace();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!activeOrgId) return;
    const { error } = await authClient.organization.delete({
      organizationId: activeOrgId,
    });
    if (error) {
      toast.error(error.message ?? "Couldn't delete the organization");
      return;
    }
    await fetchWorkspace();
    router.push("/dashboard");
  }

  if (!s) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const saveBtn = (
    <Button size="sm" disabled={saving} onClick={save}>
      {saving ? "Saving…" : "Save changes"}
    </Button>
  );

  return (
    <div>
      <SettingsColumns>
        <SettingsSection title="Organization profile">
          <SettingsPanel>
            <div className="py-1">
              <SettingsField
                label="Logo"
                hint="A square avatar, generated from the name until you upload one."
              >
                <OrgLogoUpload
                  name={s.name}
                  logo={s.logo}
                  onChange={(url) => set("logo", url)}
                />
              </SettingsField>
              <SettingsField
                label="Organization name"
                hint="Shown across the console and in invitations."
              >
                <input
                  className={cn(settingsControl, settingsControlSize)}
                  value={s.name}
                  onChange={(e) => set("name", e.target.value)}
                  autoComplete="off"
                />
              </SettingsField>
              <SettingsField
                label="Organization URL"
                hint="The slug for your organization's URL."
              >
                <div className="flex h-[38px] items-center overflow-hidden rounded-sm border border-border-strong bg-surface-sunken">
                  <span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
                    {orgHost()}/
                  </span>
                  <input
                    className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
                    value={s.slug}
                    onChange={(e) => set("slug", slugifyOrEmpty(e.target.value))}
                    autoComplete="off"
                  />
                </div>
                <span className="font-mono text-ui-2xs text-text-tertiary">
                  Lowercase, numbers and hyphens.
                </span>
              </SettingsField>
              <SettingsField
                label="Description"
                hint="Optional. A short line for teammates and audit context."
              >
                <textarea
                  className={cn(
                    settingsControl,
                    "min-h-16 resize-y py-2.5 leading-normal",
                  )}
                  placeholder="What does this organization manage?"
                  value={s.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </SettingsField>
              <SettingsField
                label="Primary address"
                hint="Set from billing checkout when you opt to reuse the billing address."
              >
                {s.primaryAddress ? (
                  <address className="rounded-sm border border-border-strong bg-surface-sunken px-3 py-2.5 text-ui-sm not-italic leading-relaxed text-text-secondary">
                    {formatPrimaryAddress(s.primaryAddress)}
                  </address>
                ) : (
                  <span className="font-mono text-ui-xs text-text-tertiary">
                    Not set — check &ldquo;use as primary address&rdquo; during
                    checkout.
                  </span>
                )}
              </SettingsField>
            </div>
            <SettingsCardFoot note="Applies across the console">
              {saveBtn}
            </SettingsCardFoot>
          </SettingsPanel>
        </SettingsSection>

        <SettingsSection title="Defaults">
          <SettingsPanel>
            <div className="py-1">
              <SettingsField
                label="Data region"
                hint="Residency for the control plane and Project state."
              >
                <SettingsSelect
                  value={s.region}
                  onChange={(v) => set("region", v)}
                  options={REGIONS.map((r) => ({
                    value: r.split(" ")[0],
                    label: r,
                  }))}
                />
                <span className="font-mono text-ui-2xs text-text-tertiary">
                  Region migration requires a support request.
                </span>
              </SettingsField>
              <SettingsField
                label="Default Project environment"
                hint="Pre-selected stage for newly planted Projects."
              >
                <SettingsSelect
                  value={s.defaultEnv}
                  onChange={(v) => set("defaultEnv", v)}
                  options={ENVS.map((en) => ({ value: en, label: en }))}
                />
              </SettingsField>
              <SettingsField
                label="Terraform version"
                hint="Pinned across runners unless a Project overrides it."
              >
                <input
                  className={cn(
                    settingsControl,
                    settingsControlSize,
                    "font-mono text-ui-sm",
                  )}
                  value={s.terraformVersion}
                  onChange={(e) => set("terraformVersion", e.target.value)}
                />
              </SettingsField>
            </div>
            <SettingsCardFoot note="Applies to new resources only">
              {saveBtn}
            </SettingsCardFoot>
          </SettingsPanel>
        </SettingsSection>
      </SettingsColumns>

      <SettingsSection title="Danger zone" className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title="Transfer ownership"
            description="Move this organization to another owner. They take over billing and the Owner role."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.info("Ownership transfer is coming soon.")}
            >
              Transfer
            </Button>
          </SettingsDangerRow>
          <SettingsDangerRow
            title="Delete organization"
            description={`Permanently delete ${s.name} and all its Projects. This destroys no cloud resources — run destroy first. Cannot be undone.`}
          >
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="outline" size="sm">
                    Delete
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this organization?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the organization, its members, and
                    its access grants. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void remove()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete organization
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SettingsDangerRow>
        </SettingsPanel>
      </SettingsSection>
    </div>
  );
}
