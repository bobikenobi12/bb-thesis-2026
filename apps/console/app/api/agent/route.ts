// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { z } from "zod";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { AGENT_STEP_PART_TYPE, agentStepMarker } from "@/lib/ai/agent-steps";
import {
	formatMentionsForPrompt,
	type Mention,
	mentionsSchema,
} from "@/lib/ai/mentions";
import {
	formatContextBlock,
	readAgentContext,
} from "@/lib/ai/project-knowledge";
import {
	cachedSystemMessage,
	thinkingOptions,
} from "@/lib/ai/provider-options";
import { textToAiOutput, uiMessagesToAiInput } from "@/lib/ai/ai-observability";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import {
	AiBudgetError,
	type AiHoldContext,
	assertAiAllowed,
	releaseAiHold,
} from "@/lib/billing/ai-guard";
import { resolveAiTier } from "@/lib/billing/ai-plan";
import {
	getAdvisorModel,
	getExecutorModel,
	isAiConfigured,
	isSelectableModel,
	resolveModel,
} from "@/lib/config/ai";

interface AgentBody {
	messages: UIMessage[];
	/** When set, the full transcript is persisted to this thread on finish. */
	threadId?: string;
	/** Ask = read-only; Act = may propose plan/deploy operations. */
	mode?: AgentMode;
	/** Selected model id (validated against the allowlist). */
	model?: string;
	/** Resources the user @-referenced in the latest message. */
	mentions?: Mention[];
	/**
	 * Per-message opt-in to the Opus advisor ("deep reasoning"). Only effective on `ai_max`
	 * (the advisor selection guards it); ignored on every other tier.
	 */
	deepReasoning?: boolean;
	/** The grid cell an empty-cell prompt asked to fill (drives the GRID hint). */
	cellTarget?: { x: number; y: number } | null;
}

/** Parse the optional empty-cell target off a request body. */
const cellTargetSchema = z
	.object({ x: z.number().int().min(0).max(4), y: z.number().int().min(0) })
	.nullish()
	.catch(null);

/** Parse the optional `deepReasoning` flag from a request body — defaults to false. */
const deepReasoningSchema = z.boolean().catch(false);

/**
 * System prompt for the general Agent page (infra Q&A + project design + Act-mode ops).
 * Exported so the nightly behavior eval (tests/ai-eval) scores the REAL prompt — the
 * thing that actually decides whether the model reaches for the right tool.
 */
export function systemPrompt(mode: AgentMode): string {
	const act =
		mode === "act"
			? [
					"",
					"ACT MODE — you may propose operations on EXISTING projects (never run them yourself):",
					"- To plan or deploy, first identify the project (`list_projects`/`get_project`), then call",
					"  `propose_operation` to ask the user to APPROVE it. plan_project queues a plan; after it",
					"  succeeds (`get_plan_result`), propose provision_project with the planJobId + add/change/destroy",
					"  + monthly stats so they review before deploying. Approval + the deploy itself happen on the",
					"  user's click — state that you're proposing, not that it's done.",
					"- You cannot create a NEW project from chat yet — point the user to Create a Project (the canvas).",
				]
			: [
					"",
					"You are in ASK (read-only) mode — to plan or deploy a project, tell the user to switch to Act.",
				];
	return [
		"You are the Alethia agent — an infrastructure copilot for a multi-cloud Kubernetes control plane.",
		"Alethia models infrastructure as Projects (provider-neutral configs) provisioned by runners via OpenTofu.",
		"",
		"You can READ the user's account (these tools run immediately, gated by their permissions):",
		"- `list_projects` / `get_project` — saved projects + their components/sizes.",
		"- `list_clusters` — provisioned/live stacks (endpoints, dbs, caches).",
		"- `list_jobs` / `get_job` / `get_plan_result` — provisioning job status + errors.",
		"- `list_runners` — execution agents. `list_connectors` — connected providers + health.",
		"- `list_cloud_identities` — verified cloud accounts. `get_cached_resources(id)` — an account's existing",
		"  VPCs/subnets, to reuse a VPC or avoid CIDR clashes.",
		"- `search_docs` — the Alethia docs (connectors, keyless OIDC auth, architecture, CLI, self-hosting).",
		"  GROUND how-to / how-it-works answers with it (esp. 'how do I connect <cloud>') instead of guessing.",
		"- `connect_cloud(provider)` — surface a one-click action that opens the connect sheet for a cloud.",
		"Cloud connectors are KEYLESS — Alethia stores no keys; it federates via its own OIDC issuer. Design",
		"onto an ALREADY-connected account: call `list_cloud_identities` first, and its provider fixes the valid",
		"service options. If the cloud the user wants (or asks to connect) isn't connected, call",
		"`connect_cloud(provider)` so they can connect it in one click.",
		"",
		"You can help DESIGN infrastructure with the catalog tools:",
		"- `list_services` — what can be built + each cloud's service name.",
		"- `list_service_options(provider)` — valid instance types / k8s versions / db engines + capacity /",
		"  cache node types / regions for a provider; map a request like 'size X' onto a valid option.",
		"- `cidr_for_hosts(hosts, base?, cloud?)` — the smallest CIDR that fits N hosts AND that the",
		"  cloud's template can carve subnets out of. ALWAYS pass `cloud` once it is known: the floors",
		"  differ (aws/azure /18, hetzner /22, alibaba /28, gcp none) and the apply gate rejects a",
		"  network below its cloud's floor. Without `cloud` the answer is widened to a /18.",
		"",
		"You can ANALYZE A REPO and propose a whole stack from it:",
		"- `scan_repo(repoUrl)` → queues a scan (returns a jobId; logs stream in the panel). Then poll",
		"  `get_scan_result(jobId)` for the inferred stack + a proposed Project, and `compare_providers(jobId)` for",
		"  the cost on each cloud. When ready, tell the user to open it in the canvas (the result includes an",
		"  openInCanvasUrl) to review/edit before deploying. Summarize the inferred needs + their rationale.",
		"",
		"GRID (the side-panel bento canvas):",
		"- Structured read results (list_*/get_*_usage/billing/drift) auto-pin to the user's per-chat",
		"  widget grid; `build_dashboard` pins one widget per block. You don't need to do anything.",
		"- `pin_widget` pins ONE extra widget on request — a `block` you compose from fetched data, or a",
		"  `source` (read tool + args). Use it when the user asks to put something on the grid/dashboard",
		"  or to fill a specific cell (pass `position`). Never invent data for blocks.",
		"",
		"Rules:",
		"- Use real values from the tools; never invent ids, regions, instance types, or credentials.",
		"- Be terse, concrete, and grayscale in tone. No emoji.",
		...act,
	].join("\n");
}

export async function POST(req: Request) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response(
			"AI is not configured. Set ANTHROPIC_API_KEY to enable the agent.",
			{ status: 503 },
		);
	}

	const actor = await currentActor();
	const {
		messages,
		threadId,
		mode = "ask",
		model,
		mentions,
		deepReasoning: deepReasoningRaw,
		cellTarget: cellTargetRaw,
	}: AgentBody = await req.json();
	const deepReasoning = deepReasoningSchema.parse(deepReasoningRaw);
	const cellTarget = cellTargetSchema.parse(cellTargetRaw);

	// Metered turn: gate on headroom (the real cost-of-serve is settled after it runs). The
	// deep-reasoning flag no longer affects the charge — Opus just settles its own real cost.
	const charge = await assertAiAllowed(actor.orgId, "agent", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) return e;
		throw e;
	});
	if (charge instanceof AiBudgetError) {
		return new Response(
			JSON.stringify({
				error: charge.message,
				reason: charge.reason,
				resetAt: charge.resetAt,
				upgradable: charge.upgradable,
			}),
			{ status: 402, headers: { "content-type": "application/json" } },
		);
	}

	// Everything from here through the streamText registration runs AFTER the hold was reserved. A
	// throw in this window (req parsing happened above; tier/mentions/model resolution here) would
	// otherwise strand the ≈$0.10 hold — nothing downstream releases it — so release it in the catch.
	const holdCtx: AiHoldContext = {
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "agent",
		refId: threadId,
	};
	try {
		// Cost-optimized orchestration: a tier-derived ADVISOR plans step 0, then a cheap Haiku
		// EXECUTOR runs the tool loop (ai_free = Haiku throughout — no distinct advisor). The advisor
		// is Sonnet by default; on ai_max the per-message `deepReasoning` opt-in upgrades it to Opus.
		// An explicit client model pick overrides orchestration with that single deliberate choice.
		const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
		const executor = getExecutorModel();
		const advisor = getAdvisorModel(tier, { deepReasoning });
		const clientPick = isSelectableModel(model) ? model : null;
		// The base run: the client's explicit pick, else the cheap executor. Step 0 upgrades to the
		// advisor (via prepareStep) unless the user forced a pick.
		const base = clientPick ? resolveModel(clientPick) : executor;
		/** The canonical key metered for a given step (step 0 = advisor unless the user forced a pick). */
		const modelForStep = (stepNumber: number): string =>
			!clientPick && stepNumber === 0 ? advisor.key : base.key;

		// Resolve @-mentions into a prompt block so the model knows what each ref points to.
		const parsedMentions = mentionsSchema.safeParse(mentions);
		const mentionBlock = parsedMentions.success
			? formatMentionsForPrompt(parsedMentions.data)
			: "";
		// Empty-cell prompt: the user clicked grid cell (x, y) and described a widget.
		const cellBlock = cellTarget
			? [
					`The user is filling grid cell (x=${cellTarget.x}, y=${cellTarget.y}) of the 5-column`,
					"bento grid with this request. Satisfy it with ONE read tool, then call `pin_widget`",
					`with position {x: ${cellTarget.x}, y: ${cellTarget.y}}, sized to fit the content.`,
				].join(" ")
			: "";
		// The org-level pinned context (custom instructions + knowledge) rides EVERY org chat —
		// the Claude-Projects model, where a workspace's instructions are inherited by its chats.
		// Project-scoped context deliberately does NOT leak in here.
		//
		// Pass the whole actor: readAgentContext is scope-flag-aware — off, it reads under the
		// user id (unchanged); on, it reads the shared org row (preferring it over a legacy
		// personal row). See lib/ai/org-agent-context-flag.ts.
		const orgCtx = await readAgentContext(actor, null).catch(() => null);
		const orgBlock = formatContextBlock("Organization", orgCtx);

		const system = [systemPrompt(mode), orgBlock, mentionBlock, cellBlock]
			.filter(Boolean)
			.join("\n\n");

		const modelMessages = await convertToModelMessages(messages);

		// LLM-observability enrichment (PostHog): thread = session, prompt = input, the mode's tool set
		// powers the Tools view, wall-clock latency around the turn. Hoisted so onFinish/onError reuse them.
		const agentTools = buildAgentTools({ mode });
		const aiInput = uiMessagesToAiInput(messages);
		const toolNames = Object.keys(agentTools);
		const startedAt = Date.now();

		// Wrap streamText in a UI message stream so orchestration markers (`data-agent-step`
		// parts) interleave with the model's own parts — the transcript renders them as
		// PLAN/EXECUTE separators showing which model owns each phase.
		const stream = createUIMessageStream({
			originalMessages: messages,
			execute: ({ writer }) => {
				const result = streamText({
					model: base.model,
					// Cache the (stable) system prompt so repeated turns read it from cache.
					messages: [cachedSystemMessage(system), ...modelMessages],
					// Our own system prompt (cached) is intentionally a system message; user turns are
					// never system-role, so this is not a prompt-injection surface.
					allowSystemInMessages: true,
					// Wire the request's abort signal so a client disconnect aborts generation (and fires
					// onAbort) instead of streaming — and paying — into the void with the hold left open.
					abortSignal: req.signal,
					tools: agentTools,
					stopWhen: stepCountIs(8),
					// A forced pick runs one model on every step — it thinks throughout.
					providerOptions: clientPick ? thinkingOptions(base) : undefined,
					// Step 0 runs on the advisor (unless the user forced a model); the rest use the
					// executor. The planning step gets extended thinking on EVERY tier (the free
					// tier's Haiku advisor included) so reasoning streams to the transcript.
					prepareStep: ({ stepNumber }) => {
						const marker = agentStepMarker({
							stepNumber,
							clientPick: !!clientPick,
							advisorKey: advisor.key,
							executorKey: executor.key,
							baseKey: base.key,
						});
						if (marker) {
							writer.write({
								type: AGENT_STEP_PART_TYPE,
								id: `step-${stepNumber}`,
								data: marker,
							});
						}
						if (clientPick) return {};
						return stepNumber === 0
							? { model: advisor.model, providerOptions: thinkingOptions(advisor) }
							: {};
					},
					// Meter PER MODEL: advisor + executor tokens are ledgered separately (correct cost_micros).
					onFinish: ({ steps, text, finishReason }) => {
						void recordAgentTurnUsage({
							orgId: actor.orgId,
							userId: actor.userId,
							kind: "agent",
							charge,
							refId: threadId,
							steps: steps.map((s, i) => ({
								model: modelForStep(i),
								usage: {
									inputTokens: s.usage.inputTokens,
									outputTokens: s.usage.outputTokens,
									cachedInputTokens: s.usage.cachedInputTokens,
								},
							})),
							// Turn-level PostHog enrichment (rides the primary generation; session on all rows).
							turn: {
								sessionId: threadId,
								input: aiInput,
								outputChoices: textToAiOutput(text),
								tools: toolNames,
								latencyMs: Date.now() - startedAt,
								stopReason: finishReason,
							},
						});
					},
					// A failed turn still shows in PostHog's Errors view (no per-model steps on error) and
					// RELEASES its reserved hold (reconciled to 0) so an errored turn never leaks headroom.
					onError: ({ error }) => {
						void recordAiUsage({
							orgId: actor.orgId,
							userId: actor.userId,
							kind: "agent",
							source: charge.source,
							holdId: charge.settle ? charge.holdId : undefined,
							refId: threadId,
							model: base.key,
							latencyMs: Date.now() - startedAt,
							sessionId: threadId,
							input: aiInput,
							tools: toolNames,
							stream: true,
							isError: true,
							error: error instanceof Error ? error.message : String(error),
						}).catch(meteringFailed(actor.orgId));
					},
					// Client disconnect mid-stream: onFinish/onError won't fire, so RELEASE the hold here
					// (mutually exclusive with them) — otherwise an abandoned turn leaks its ≈$0.10 hold.
					onAbort: () => {
						void releaseAiHold(charge, holdCtx);
					},
				});
				writer.merge(result.toUIMessageStream());
			},
			onFinish: ({ messages: finished }) => {
				if (threadId) void saveThreadMessages(threadId, finished);
			},
		});

		return createUIMessageStreamResponse({ stream });
	} catch (e) {
		// A throw between the gate and stream registration (tier/model resolution, message
		// conversion, tool build) strands the hold — release it to 0 before propagating.
		await releaseAiHold(charge, holdCtx);
		throw e;
	}
}
