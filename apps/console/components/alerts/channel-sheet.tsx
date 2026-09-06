"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guided "add channel" flow — a right-side Sheet as one vertical form (no stepper):
// Transport selector → Separator → Configure. "Add channel" calls addChannel, which
// verifies the endpoint and only persists the channel if it works (a channel never exists
// unverified). Editing an existing channel stays inline.

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { type AlertsBootstrap, addChannel } from "@/app/server/actions/alerts";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import {
	CHANNEL_TYPE_META,
	CHANNEL_TYPE_ORDER,
} from "@/components/alerts/channel-meta";
import { FieldHelp } from "@/components/alerts/field-help";
import { RecipientsEditor } from "@/components/alerts/recipients-editor";
import { alertChannelType, type AlertChannelType } from "@/lib/db/schema/enums";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Separator } from "@repo/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";

// Where to get the credential, per transport.
const HELP: Record<AlertChannelType, ReactNode> = {
	slack: (
		<>
			In Slack:{" "}
			<span className="text-foreground">
				Apps → Incoming Webhooks → Add to a channel
			</span>
			, then paste the webhook URL.{" "}
			<a
				href="https://api.slack.com/messaging/webhooks"
				target="_blank"
				rel="noreferrer"
				className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
			>
				Slack docs <ExternalLink className="size-3" />
			</a>
		</>
	),
	rocketchat: (
		<>
			In Rocket.Chat:{" "}
			<span className="text-foreground">
				Admin → Integrations → New → Incoming Webhook
			</span>
			, enable it, then paste the generated URL.
		</>
	),
	webhook: (
		<>
			Any HTTPS endpoint. With a signing secret the body is signed{" "}
			<code className="font-mono text-ui-xs">X-Alethia-Signature</code> so your
			receiver can verify it came from Alethia.
		</>
	),
	email: (
		<>
			Comma- or Enter-separated addresses. Delivery uses the server&apos;s SES if
			configured; otherwise it&apos;s logged.
		</>
	),
	discord: (
		<>
			In Discord:{" "}
			<span className="text-foreground">
				Channel → Edit → Integrations → Webhooks → New Webhook
			</span>
			, then copy the webhook URL.
		</>
	),
	teams: (
		<>
			In Teams: the channel&apos;s{" "}
			<span className="text-foreground">Workflows / Incoming Webhook</span>{" "}
			connector — create one and paste its POST URL.
		</>
	),
	mattermost: (
		<>
			In Mattermost:{" "}
			<span className="text-foreground">
				Integrations → Incoming Webhooks → Add
			</span>
			, then paste the URL.
		</>
	),
	googlechat: (
		<>
			In a Google Chat space:{" "}
			<span className="text-foreground">Apps & integrations → Webhooks</span>,
			add one and copy its URL.
		</>
	),
	pagerduty: (
		<>
			In PagerDuty: a service&apos;s{" "}
			<span className="text-foreground">
				Integrations → Events API v2
			</span>{" "}
			integration — copy its <em>Integration Key</em>. It&apos;s a send-only,
			revocable key (not an account token), encrypted at rest.
		</>
	),
};

const configSchema = z
	.object({
		type: z.enum(alertChannelType.enumValues),
		name: z.string().min(1, "Name your channel").max(120),
		recipients: z.array(z.string().email()),
		url: z.string(),
		signingSecret: z.string(),
		routingKey: z.string(),
	})
	.superRefine((v, ctx) => {
		const cred = CHANNEL_TYPE_META[v.type].credential;
		if (cred === "email") {
			if (v.recipients.length === 0)
				ctx.addIssue({
					code: "custom",
					path: ["recipients"],
					message: "Add at least one recipient.",
				});
			return;
		}
		if (cred === "routingKey") {
			if (!v.routingKey.trim())
				ctx.addIssue({
					code: "custom",
					path: ["routingKey"],
					message: "Paste the integration routing key.",
				});
			return;
		}
		if (!v.url.trim()) {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "A destination URL is required.",
			});
			return;
		}
		try {
			new URL(v.url);
		} catch {
			ctx.addIssue({ code: "custom", path: ["url"], message: "Enter a valid URL." });
		}
	});
type ConfigValues = z.infer<typeof configSchema>;

const DEFAULTS: ConfigValues = {
	type: "slack",
	name: CHANNEL_TYPE_META.slack.name,
	recipients: [],
	url: "",
	signingSecret: "",
	routingKey: "",
};

interface ChannelSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	bootstrap: AlertsBootstrap;
	onSaved: () => void;
}

/** Guided, single-form create flow for an alert channel. */
export function ChannelSheet({
	open,
	onOpenChange,
	bootstrap,
	onSaved,
}: ChannelSheetProps) {
	const { encryptionConfigured } = bootstrap;
	const [saving, setSaving] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const wasOpen = useRef(false);

	const form = useForm<ConfigValues>({
		resolver: zodResolver(configSchema),
		defaultValues: DEFAULTS,
		mode: "onChange",
	});
	const v = form.watch();
	const meta = CHANNEL_TYPE_META[v.type];
	const isSecret = meta.credential !== "email";
	const needsKey = isSecret && !encryptionConfigured;

	useEffect(() => {
		if (open && !wasOpen.current) {
			setSubmitError(null);
			form.reset(DEFAULTS);
		}
		wasOpen.current = open;
	}, [open, form]);

	const pickTransport = (type: AlertChannelType) => {
		form.reset({ ...DEFAULTS, type, name: CHANNEL_TYPE_META[type].name });
		setSubmitError(null);
	};

	const create = form.handleSubmit(async (values) => {
		setSaving(true);
		setSubmitError(null);
		const cred = CHANNEL_TYPE_META[values.type].credential;
		try {
			const res = await addChannel({
				type: values.type,
				name: values.name.trim(),
				enabled: true,
				recipients: cred === "email" ? values.recipients : undefined,
				secret:
					cred === "url"
						? {
								url: values.url.trim() || undefined,
								signingSecret:
									values.type === "webhook"
										? values.signingSecret.trim() || undefined
										: undefined,
							}
						: cred === "routingKey"
							? { routingKey: values.routingKey.trim() || undefined }
							: undefined,
			});
			if (res.ok) {
				toast.success("Channel verified and added");
				onOpenChange(false);
				onSaved();
			} else {
				setSubmitError(res.error);
			}
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : "Failed to add channel");
		} finally {
			setSaving(false);
		}
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
				<SheetHeader className="gap-3 border-b border-border/60 p-5">
					<div className="flex items-center gap-3">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
							<ChannelIcon type={v.type} active size={22} />
						</span>
						<div>
							<SheetTitle className="font-display text-base">
								Add a channel
							</SheetTitle>
							<SheetDescription className="text-xs">
								Where alerts get delivered. Secrets are encrypted at rest.
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>

				<div className="flex-1 space-y-5 overflow-y-auto p-5">
					{/* transport */}
					<div className="space-y-2">
						<Label>Transport</Label>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{CHANNEL_TYPE_ORDER.map((type) => {
								const m = CHANNEL_TYPE_META[type];
								const on = v.type === type;
								return (
									<button
										key={type}
										type="button"
										onClick={() => pickTransport(type)}
										className={cn(
											"flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors",
											on
												? "border-foreground/40 bg-muted"
												: "border-border/60 bg-background hover:bg-muted/40",
										)}
									>
										<ChannelIcon type={type} active={on} size={18} />
										<span className="min-w-0">
											<span className="block truncate font-medium text-ui-md">
												{m.name}
											</span>
											<span className="block truncate font-mono text-ui-2xs text-muted-foreground">
												{m.transport}
											</span>
										</span>
									</button>
								);
							})}
						</div>
					</div>

					<Separator />

					{/* configure */}
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="ch-name">Name</Label>
							<Input id="ch-name" {...form.register("name")} />
							{form.formState.errors.name && (
								<p className="text-destructive text-xs">
									{form.formState.errors.name.message}
								</p>
							)}
						</div>

						{meta.credential === "email" && (
							<div className="space-y-2">
								<div className="flex items-center gap-1.5">
									<Label>Recipients</Label>
									<FieldHelp title="Recipients">{HELP.email}</FieldHelp>
								</div>
								<RecipientsEditor
									recipients={v.recipients}
									editable
									onChange={(r) =>
										form.setValue("recipients", r, { shouldValidate: true })
									}
								/>
								{form.formState.errors.recipients && (
									<p className="text-destructive text-xs">
										{form.formState.errors.recipients.message}
									</p>
								)}
							</div>
						)}

						{meta.credential === "url" && (
							<>
								<div className="space-y-2">
									<div className="flex items-center gap-1.5">
										<Label htmlFor="ch-url">
											{v.type === "webhook"
												? "Payload URL"
												: `${meta.name} webhook URL`}
										</Label>
										<FieldHelp title="Where to find this">{HELP[v.type]}</FieldHelp>
									</div>
									<Input
										id="ch-url"
										placeholder={meta.placeholder}
										className="font-mono text-xs"
										{...form.register("url")}
									/>
									{form.formState.errors.url && (
										<p className="text-destructive text-xs">
											{form.formState.errors.url.message}
										</p>
									)}
								</div>
								{v.type === "webhook" && (
									<div className="space-y-2">
										<div className="flex items-center gap-1.5">
											<Label htmlFor="ch-secret">
												Signing secret{" "}
												<span className="font-mono text-ui-3xs uppercase text-muted-foreground">
													optional
												</span>
											</Label>
											<FieldHelp title="Signing secret">
												Optional. If set, Alethia signs each request body and sends{" "}
												<code className="font-mono">X-Alethia-Signature: sha256=…</code>{" "}
												so your receiver can verify the request is genuine.
											</FieldHelp>
										</div>
										<Input
											id="ch-secret"
											placeholder="Sent as X-Alethia-Signature"
											className="font-mono text-xs"
											{...form.register("signingSecret")}
										/>
									</div>
								)}
							</>
						)}

						{meta.credential === "routingKey" && (
							<div className="space-y-2">
								<div className="flex items-center gap-1.5">
									<Label htmlFor="ch-rk">Integration routing key</Label>
									<FieldHelp title="Routing key">{HELP[v.type]}</FieldHelp>
								</div>
								<Input
									id="ch-rk"
									placeholder={meta.placeholder}
									className="font-mono text-xs"
									{...form.register("routingKey")}
								/>
								{form.formState.errors.routingKey && (
									<p className="text-destructive text-xs">
										{form.formState.errors.routingKey.message}
									</p>
								)}
							</div>
						)}

						{needsKey && (
							<InfoNote>
								This transport stores a secret, which needs an encryption key. Set{" "}
								<code className="font-mono text-foreground">
									ALETHIA_CRED_ENCRYPTION_KEY
								</code>{" "}
								and restart, or use an Email channel.
							</InfoNote>
						)}

						{submitError ? (
							<div className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs">
								<AlertCircle className="mt-px size-4 shrink-0" />
								<p className="leading-relaxed">{submitError}</p>
							</div>
						) : (
							<p className="text-muted-foreground text-ui-xs">
								Adding sends a one-off verification to this destination — the
								channel is only created if it succeeds.
							</p>
						)}
					</div>
				</div>

				<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button size="sm" onClick={create} disabled={saving || needsKey}>
						{saving ? "Verifying…" : "Add channel"}
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

function InfoNote({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
			<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
			<p className="leading-relaxed">{children}</p>
		</div>
	);
}
