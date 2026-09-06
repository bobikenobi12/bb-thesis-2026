// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drawer's Receipt tab: signed/unsigned header + download, the receipt field grid
// (incl. version + truncated signature with copy — and an honest "runner-held" label on
// the signing key, because a platform-held key only attests "Alethia said so"), the
// sealed exception, and the root-of-trust disclaimer. Purposeful empty state when no
// receipt was sealed.

import { ArrowUpRight } from "lucide-react";
import { CopyButton } from "@repo/ui/copy-button";
import type { EvidenceEnvRow } from "../evidence-derive";
import { EVIDENCE_HELP } from "../evidence-help";
import { EvIcon } from "../evidence-status";
import { TabEmpty } from "./tab-empty";

/** One label/value receipt field row, optionally with a copy affordance. */
function Field({
	label,
	value,
	copy,
}: {
	label: string;
	value: string;
	copy?: string;
}) {
	return (
		<div className="flex items-baseline gap-3.5 border-b border-border-faint px-0.5 py-2.5">
			<span className="w-[130px] shrink-0 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
				{label}
			</span>
			<span className="min-w-0 flex-1 break-all font-mono text-ui-xs leading-relaxed text-text-primary">
				{value}
			</span>
			{copy && <CopyButton text={copy} className="shrink-0" />}
		</div>
	);
}

/** Truncate a long base64/hex value for display (full value stays copyable). */
function short(value: string, n = 24): string {
	return value.length > n ? `${value.slice(0, n)}…` : value;
}

/** A human-viewable URL for a Rekor log entry (the Sigstore search UI for the public good log). */
function rekorEntryUrl(logUrl: string | undefined, logIndex: number): string {
	if (!logUrl || logUrl.includes("rekor.sigstore.dev")) {
		return `https://search.sigstore.dev/?logIndex=${logIndex}`;
	}
	return `${logUrl.replace(/\/+$/, "")}/api/v1/log/entries?logIndex=${logIndex}`;
}

/** The Receipt tab body. */
export function ReceiptTab({
	row,
	onDownload,
}: {
	row: EvidenceEnvRow;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	const receipt = row.verify?.receipt ?? null;
	if (!receipt) {
		return (
			<TabEmpty
				icon="file-minus"
				title="No receipt sealed"
				description="Receipts are produced when a verified plan is applied — a signed receipt attests the verdict is reproducible given the same plan."
				docsHref={EVIDENCE_HELP.receipt.docsHref}
			/>
		);
	}

	const signed = receipt.algorithm === "ed25519";
	const body = receipt.receipt;
	const anchor = receipt.rekor ?? null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3 rounded-md border bg-surface px-3.5 py-3">
				<EvIcon
					name={signed ? "file-check" : "file-minus"}
					size={18}
					className="text-text-secondary"
				/>
				<div className="flex-1">
					<div className="font-display text-ui-lg font-semibold text-text-primary">
						{signed ? "Signed receipt" : "Unsigned receipt"}
					</div>
					<div className="mt-0.5 font-mono text-ui-2xs text-text-tertiary">
						{receipt.key_id ?? receipt.algorithm}
					</div>
				</div>
				<button
					type="button"
					onClick={() => onDownload(row)}
					className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-ink px-3 text-ui-sm font-medium text-ink-foreground transition-colors hover:bg-ink-hover"
				>
					<EvIcon name="download" size={14} />
					Download
				</button>
			</div>
			<div className="flex flex-col">
				<Field
					label="plan sha256"
					value={body.plan_sha256 ? short(body.plan_sha256) : "—"}
					copy={body.plan_sha256 || undefined}
				/>
				{signed && receipt.key_id && (
					<Field label="signing key" value={`${receipt.key_id} · runner-held`} />
				)}
				{signed && receipt.signature && (
					<Field
						label="signature"
						value={short(receipt.signature)}
						copy={receipt.signature}
					/>
				)}
				<Field label="receipt version" value={String(body.version)} />
				<Field label="catalog" value={body.catalog_version} />
				<Field label="provider" value={body.provider} />
				{body.tofu_version && (
					<Field label="opentofu" value={body.tofu_version} />
				)}
				{body.evaluated_at && <Field label="evaluated" value={body.evaluated_at} />}
				{body.runner && <Field label="runner" value={body.runner} />}
				{anchor && (
					<Field
						label="transparency log"
						value={`#${anchor.log_index} · anchored`}
						copy={anchor.log_id}
					/>
				)}
			</div>
			{anchor && (
				<div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3.5 py-3">
					<div className="mb-1 flex items-center gap-1.5">
						<EvIcon name="shield-check" size={14} className="text-text-secondary" />
						<span className="font-display text-ui-md font-semibold text-text-primary">
							Anchored in a transparency log
						</span>
					</div>
					<div className="text-ui-xs leading-relaxed text-text-tertiary">
						This receipt’s digest was entered into an append-only Rekor log (entry{" "}
						<span className="font-mono">#{anchor.log_index}</span>), so any third party can
						confirm offline that it existed and was not altered — no callback to Alethia.
					</div>
					<a
						href={rekorEntryUrl(anchor.log_url, anchor.log_index)}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2.5 inline-flex items-center gap-1 border-b border-border-strong pb-0.5 font-mono text-ui-xs text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary"
					>
						View log entry
						<ArrowUpRight className="size-3" />
					</a>
				</div>
			)}
			{body.exception && (
				<div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3.5 py-3">
					<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.13em] text-text-tertiary">
						Sealed exception
					</div>
					<div className="mb-2 flex flex-wrap gap-1">
						{body.exception.controls.map((c) => (
							<span
								key={c}
								className="rounded-xs border px-1.5 py-0.5 font-mono text-ui-2xs text-text-secondary"
							>
								{c}
							</span>
						))}
					</div>
					<div className="text-ui-sm leading-relaxed text-text-secondary">
						{body.exception.reason}
					</div>
					<div className="mt-2 font-mono text-ui-2xs text-text-tertiary">
						{body.exception.by}
					</div>
				</div>
			)}
			{!signed && (
				<div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3.5 py-3">
					<div className="mb-1 flex items-center gap-1.5">
						<EvIcon name="file-check" size={14} className="text-text-secondary" />
						<span className="font-display text-ui-md font-semibold text-text-primary">
							Enable signed receipts
						</span>
					</div>
					<div className="text-ui-xs leading-relaxed text-text-tertiary">
						Set an ed25519 signing key on the runner and every future receipt becomes
						tamper-evident and verifiable offline — even the platform key upgrades
						“trust the database row” to “cryptographically bound to this plan”.
					</div>
					<a
						href={EVIDENCE_HELP.receipt.docsHref}
						className="mt-2.5 inline-flex items-center gap-1 border-b border-border-strong pb-0.5 font-mono text-ui-xs text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary"
					>
						How to enable signing
						<ArrowUpRight className="size-3" />
					</a>
				</div>
			)}
			<div className="flex gap-2.5 rounded-sm border bg-surface px-3 py-2.5">
				<EvIcon
					name="shield-question"
					size={14}
					className="mt-px shrink-0 text-text-tertiary"
				/>
				<span className="text-ui-xs leading-relaxed text-text-tertiary">
					A receipt attests that this verdict is reproducible given the same plan
					— not a proof of compliance. The signing key is held by the runner that
					executed the job; anchor it with a customer-controlled key or a
					transparency log to strengthen the root of trust.
				</span>
			</div>
		</div>
	);
}
