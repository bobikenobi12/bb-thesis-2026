"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The SSO provider editor Sheet — the second AccordionForm consumer (Protocol → Identity provider
// → Domain & mapping → Review) with a persistent footer submit. Registration goes through
// @better-auth/sso's own /api/auth/sso/register endpoint; edits go through the updateSsoProvider
// server action (which merges into the stored config, so an untouched secret is preserved).

import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import {
	type SsoProviderRow,
	updateSsoProvider,
} from "@/app/server/actions/sso";
import {
	AccordionForm,
	type FormSectionDef,
} from "@/components/forms/accordion-form";
import { useInvalidateSso } from "@/lib/query/use-sso-query";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import {
	type SsoProviderInput,
	ssoProviderSchema,
} from "@/lib/validations/sso";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

interface ProviderSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The provider being edited, or null to register a new one. */
	provider: SsoProviderRow | null;
	canManage: boolean;
	onSaved: () => void;
}

const BLANK: SsoProviderInput = {
	type: "oidc",
	providerId: "",
	domain: "",
	issuer: "",
	clientId: "",
	clientSecret: "",
	entryPoint: "",
	cert: "",
	mappingEmail: "",
	mappingName: "",
};

/** Drops empty strings so we never persist a blank mapping override. */
function mappingOf(v: SsoProviderInput): Record<string, string> | undefined {
	const m: Record<string, string> = {};
	if (v.mappingEmail) m.email = v.mappingEmail;
	if (v.mappingName) m.name = v.mappingName;
	return Object.keys(m).length > 0 ? m : undefined;
}

export function ProviderSheet({
	open,
	onOpenChange,
	provider,
	canManage,
	onSaved,
}: ProviderSheetProps) {
	const invalidate = useInvalidateSso();
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const [openSection, setOpenSection] = useState("protocol");
	const [saving, setSaving] = useState(false);
	const isEdit = provider != null;
	const mode = isEdit ? "edit" : "create";

	const form = useForm<SsoProviderInput>({
		resolver: zodResolver(ssoProviderSchema(mode)),
		defaultValues: BLANK,
		mode: "onChange",
	});

	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			form.reset(
				provider
					? {
							...BLANK,
							// A row with neither config reports "unknown"; default the editor to OIDC.
							type: provider.type === "saml" ? "saml" : "oidc",
							providerId: provider.providerId,
							domain: provider.domain,
							issuer: provider.issuer,
							clientId: provider.clientId ?? "",
							entryPoint: provider.ssoUrl ?? "",
						}
					: BLANK,
			);
			setOpenSection("protocol");
		}
		wasOpen.current = open;
	}, [open, provider, form]);

	// Subscribing to `type` here re-renders the sheet, so the sections below (whose `fields` swap
	// per protocol) are rebuilt on a protocol switch.
	const type = form.watch("type");
	const errors = form.formState.errors;

	async function onSubmit(v: SsoProviderInput) {
		setSaving(true);
		try {
			if (isEdit) {
				await updateSsoProvider(provider.id, {
					domain: v.domain,
					issuer: v.issuer,
					clientId: v.clientId || undefined,
					clientSecret: v.clientSecret || undefined,
					entryPoint: v.entryPoint || undefined,
					cert: v.cert || undefined,
					mapping: mappingOf(v),
				});
				toast.success("Provider updated");
			} else {
				// Registration is @better-auth/sso's own endpoint (it mints the domain-verification
				// token and enforces the Enterprise entitlement via the ee/ guard).
				const body =
					v.type === "oidc"
						? {
								providerId: v.providerId,
								issuer: v.issuer,
								domain: v.domain,
								organizationId: activeOrgId,
								oidcConfig: {
									clientId: v.clientId,
									clientSecret: v.clientSecret,
									mapping: mappingOf(v),
								},
							}
						: {
								providerId: v.providerId,
								issuer: v.issuer,
								domain: v.domain,
								organizationId: activeOrgId,
								samlConfig: {
									entryPoint: v.entryPoint,
									cert: v.cert,
									mapping: mappingOf(v),
								},
							};
				const res = await fetch("/api/auth/sso/register", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					const data: unknown = await res.json().catch(() => null);
					const message =
						typeof data === "object" &&
						data !== null &&
						"message" in data &&
						typeof data.message === "string"
							? data.message
							: "Couldn't register the provider";
					throw new Error(message);
				}
				toast.success("Provider registered — verify its domain to enable sign-in");
			}
			invalidate();
			onSaved();
			onOpenChange(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save the provider");
		} finally {
			setSaving(false);
		}
	}

	const sections: FormSectionDef<SsoProviderInput>[] = [
		{
			id: "protocol",
			title: "Protocol",
			hint: "Which standard your identity provider speaks.",
			fields: ["type"],
			summary: (v) => (v.type === "saml" ? "SAML 2.0" : "OIDC"),
			body: (v) => (
				<div className="flex gap-2">
					{(["oidc", "saml"] as const).map((t) => (
						<button
							key={t}
							type="button"
							disabled={!canManage || isEdit}
							onClick={() => form.setValue("type", t, { shouldValidate: true })}
							className={cn(
								"flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
								v.type === t
									? "border-border-strong bg-surface-muted"
									: "border-border hover:border-border-strong",
								(isEdit || !canManage) && "opacity-60",
							)}
						>
							<div className="text-ui-md font-medium text-text-primary">
								{t === "oidc" ? "OIDC" : "SAML 2.0"}
							</div>
							<div className="text-ui-xs text-text-tertiary">
								{t === "oidc"
									? "OpenID Connect (Okta, Entra ID, Auth0…)"
									: "SAML assertions (ADFS, OneLogin…)"}
							</div>
						</button>
					))}
				</div>
			),
		},
		{
			id: "idp",
			title: "Identity provider",
			hint:
				type === "oidc"
					? "From your IdP's OIDC application."
					: "From your IdP's SAML application metadata.",
			// Fields SWAP on protocol — AccordionForm reads `fields` fresh each render, so
			// validation/advance only ever considers the active branch.
			fields:
				type === "oidc"
					? ["issuer", "clientId", "clientSecret"]
					: ["issuer", "entryPoint", "cert"],
			summary: (v) => v.issuer,
			body: () => (
				<div className="space-y-3">
					<Field
						label={type === "oidc" ? "Issuer URL" : "IdP Entity ID (issuer)"}
						placeholder={
							type === "oidc" ? "https://acme.okta.com" : "https://idp.acme.com/metadata"
						}
						error={errors.issuer?.message}
						disabled={!canManage}
						{...form.register("issuer")}
					/>
					{type === "oidc" ? (
						<>
							<Field
								label="Client ID"
								placeholder="0oa1b2c3…"
								error={errors.clientId?.message}
								disabled={!canManage}
								{...form.register("clientId")}
							/>
							<Field
								label="Client secret"
								type="password"
								placeholder={isEdit ? "•••••• (unchanged)" : "…"}
								hint={isEdit ? "Leave blank to keep the stored secret." : undefined}
								error={errors.clientSecret?.message}
								disabled={!canManage}
								{...form.register("clientSecret")}
							/>
						</>
					) : (
						<>
							<Field
								label="IdP sign-on URL"
								placeholder="https://idp.acme.com/sso/saml"
								error={errors.entryPoint?.message}
								disabled={!canManage}
								{...form.register("entryPoint")}
							/>
							<div className="space-y-1.5">
								<Label className="text-ui-xs text-text-tertiary">
									Signing certificate (X.509)
								</Label>
								<Textarea
									rows={4}
									className="font-mono text-ui-xs"
									placeholder={
										isEdit
											? "•••••• (unchanged — paste a new cert to rotate)"
											: "-----BEGIN CERTIFICATE-----"
									}
									disabled={!canManage}
									{...form.register("cert")}
								/>
								{errors.cert && (
									<p className="text-destructive text-xs">{errors.cert.message}</p>
								)}
							</div>
						</>
					)}
				</div>
			),
		},
		{
			id: "domain",
			title: "Domain & mapping",
			hint: "The email domain this IdP is authoritative for. You'll prove ownership via DNS after saving.",
			fields: ["domain"],
			summary: (v) => v.domain,
			body: () => (
				<div className="space-y-3">
					{!isEdit && (
						<Field
							label="Provider id"
							placeholder="okta-prod"
							hint="A stable slug used in URLs and the DNS record."
							error={errors.providerId?.message}
							disabled={!canManage}
							{...form.register("providerId")}
						/>
					)}
					<Field
						label="Email domain"
						placeholder="acme.com"
						error={errors.domain?.message}
						disabled={!canManage}
						{...form.register("domain")}
					/>
					<div className="grid grid-cols-2 gap-2">
						<Field
							label="Email claim"
							placeholder="email (default)"
							disabled={!canManage}
							{...form.register("mappingEmail")}
						/>
						<Field
							label="Name claim"
							placeholder="name (default)"
							disabled={!canManage}
							{...form.register("mappingName")}
						/>
					</div>
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			fields: [],
			terminal: true,
			complete: () => true,
			summary: () => "",
			body: (v) => (
				<div className="space-y-1.5 text-ui-sm text-text-secondary">
					<Row k="Protocol" v={v.type === "saml" ? "SAML 2.0" : "OIDC"} />
					<Row k="Provider id" v={v.providerId || provider?.providerId || "—"} />
					<Row k="Domain" v={v.domain || "—"} />
					<Row k="Issuer" v={v.issuer || "—"} />
					{!isEdit && (
						<p className="pt-1 text-ui-xs text-text-tertiary">
							After registering, add the DNS TXT record shown on the provider to verify
							the domain — sign-in stays disabled until it&apos;s verified.
						</p>
					)}
				</div>
			),
		},
	];

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
				<SheetHeader className="gap-3 border-b border-border/60 p-5">
					<div className="flex items-center gap-3">
						<span className="flex size-10 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
							<KeyRound size={18} className="text-text-secondary" />
						</span>
						<div>
							<SheetTitle className="font-display text-base">
								{isEdit ? "Edit provider" : "Connect an identity provider"}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{isEdit
									? provider.providerId
									: "Register your IdP so your team can sign in with SSO."}
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>
				<FormProvider {...form}>
					<div className="flex-1 overflow-y-auto p-5">
						<AccordionForm
							sections={sections}
							open={openSection}
							onOpenChange={setOpenSection}
						/>
					</div>
					<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!canManage || saving}
							onClick={() => void form.handleSubmit(onSubmit)()}
						>
							{saving
								? "Saving…"
								: isEdit
									? "Save changes"
									: "Register provider"}
						</Button>
					</SheetFooter>
				</FormProvider>
			</SheetContent>
		</Sheet>
	);
}

/** A labelled input with an optional hint + error. Forwards RHF's register props. */
function Field({
	label,
	hint,
	error,
	...props
}: React.ComponentProps<typeof Input> & {
	label: string;
	hint?: string;
	error?: string;
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-ui-xs text-text-tertiary">{label}</Label>
			<Input autoComplete="off" {...props} />
			{hint && !error && (
				<p className="text-ui-xs text-text-tertiary">{hint}</p>
			)}
			{error && <p className="text-destructive text-xs">{error}</p>}
		</div>
	);
}

function Row({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex gap-2">
			<span className="text-text-tertiary">{k}:</span>
			<span className="truncate">{v}</span>
		</div>
	);
}
