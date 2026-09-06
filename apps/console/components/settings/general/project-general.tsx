"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project · Settings · General — the project-native counterpart of OrgGeneral. Rename the project
// (the slug stays stable so URLs don't break) and a danger-zone delete. Composed from the shared
// settings primitives. Wired to projects.ts (updateProjectName / deleteProject). Delete refuses
// server-side while any environment is live — destroy those first.

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  deleteProject,
  updateProjectName,
} from "@/app/server/actions/projects";
import { ClassificationControl } from "@/components/classification/classification-control";
import {
  SettingsCardFoot,
  SettingsDangerRow,
  SettingsField,
  SettingsPanel,
  SettingsSection,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
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
import { cn } from "@repo/ui/utils";

const nameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A project name is required")
    .max(100, "Project name must be 100 characters or fewer"),
});
type NameForm = z.infer<typeof nameSchema>;

/** The project General settings — rename + danger-zone delete. */
export function ProjectGeneral({
  projectId,
  orgSlug,
  initialName,
  slug,
}: {
  projectId: string;
  orgSlug: string;
  initialName: string;
  slug: string | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(initialName);
  const form = useForm<NameForm>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: initialName },
  });

  /** Persist the rename; keep the form's baseline in sync so the Save button re-disables. */
  async function onSave(values: NameForm) {
    try {
      const { project_name } = await updateProjectName(projectId, values.name);
      setName(project_name);
      form.reset({ name: project_name });
      toast.success("Project updated.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save changes.");
    }
  }

  /** Delete the project record, then return to the org overview. */
  async function onDelete() {
    setDeleting(true);
    try {
      await deleteProject(projectId);
      toast.success("Project deleted.");
      router.push(`/${orgSlug}`);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't delete the project.",
      );
      setDeleting(false);
    }
  }

  return (
    <div>
      <SettingsSection title="Project profile">
        <SettingsPanel>
          <form onSubmit={form.handleSubmit(onSave)}>
            <div className="py-1">
              <SettingsField
                label="Project name"
                hint="Shown across the console and the CLI."
              >
                <input
                  className={cn(settingsControl, settingsControlSize)}
                  autoComplete="off"
                  {...form.register("name")}
                />
                {form.formState.errors.name && (
                  <span className="text-ui-xs text-destructive">
                    {form.formState.errors.name.message}
                  </span>
                )}
              </SettingsField>
              <SettingsField
                label="Project URL"
                hint="The slug in this project's URLs — kept stable across renames."
              >
                <div className="flex h-[38px] items-center overflow-hidden rounded-sm border border-border-strong bg-surface-sunken px-3 font-mono text-ui-sm text-text-tertiary">
                  /{orgSlug}/{slug ?? "—"}
                </div>
              </SettingsField>
              {/* Classification (Workstream B) — chips + a picker for org editors. */}
              <SettingsField
                label="Classification"
                hint="Pin this project's classification values (e.g. Environment, Team)."
              >
                <ClassificationControl kind="project" id={projectId} canEdit />
              </SettingsField>
            </div>
            <SettingsCardFoot note="Applies across the console">
              <Button
                type="submit"
                size="sm"
                disabled={
                  form.formState.isSubmitting || !form.formState.isDirty
                }
              >
                {form.formState.isSubmitting ? "Saving…" : "Save changes"}
              </Button>
            </SettingsCardFoot>
          </form>
        </SettingsPanel>
      </SettingsSection>

      <SettingsSection title="Danger zone" className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title="Delete project"
            description={`Permanently delete ${name}, its environments, design, and history. This destroys no cloud resources — destroy the environments first. Cannot be undone.`}
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
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the project and its environments,
                    design, and promotion history. Provisioned cloud resources
                    are not touched — destroy the environments first. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void onDelete()}
                    disabled={deleting}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? "Deleting…" : "Delete project"}
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
