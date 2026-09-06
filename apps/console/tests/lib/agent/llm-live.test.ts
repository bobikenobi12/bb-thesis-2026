// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live LLM exercise (opt-in): drives the supervisor + LLM sub-agent runner against the
// REAL model, end-to-end — through the SAME direct-to-provider path production uses
// (lib/config/ai `getExecutorModel()` → `@ai-sdk/anthropic` → api.anthropic.com, no
// Vercel AI Gateway). Gated behind ELENCH_LIVE=1 and a direct Anthropic key so it is
// SKIPPED in normal CI (it makes a non-deterministic, credit-spending network call).
// Run explicitly: ELENCH_LIVE=1 ANTHROPIC_API_KEY=sk-ant-… pnpm -C apps/console \
//   exec vitest run tests/lib/agent/llm-live.test.ts

import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createLlmSubAgentRunner } from "@/lib/agent/llm-subagent";
import { runSupervisor } from "@/lib/agent/supervisor";
import { cachedSystemMessage } from "@/lib/ai/provider-options";
import { getExecutorModel, resolveModel } from "@/lib/config/ai";

// A direct Anthropic key (sk-ant…) is required: this proves the gateway-free path works
// with a native provider key — the whole point of the de-gateway refactor.
const key = process.env.ANTHROPIC_API_KEY || "";
const live = process.env.ELENCH_LIVE === "1" && key.startsWith("sk-ant");

/** Generate via the production resolver — direct to the provider, no gateway. */
async function generate(prompt: string): Promise<string> {
	const { model } = getExecutorModel();
	const { text } = await generateText({ model, prompt });
	return text;
}

describe.runIf(live)("live LLM colony exercise (direct provider)", () => {
	it(
		"runs the supervisor end-to-end against the real model via the direct provider",
		async () => {
			const runner = createLlmSubAgentRunner(generate);

			const res = await runSupervisor(
				[
					{
						id: "t1",
						objective:
							'Acknowledge this trivial check is complete. Respond ONLY as JSON {"ok":true,"result":"<short note>","facts":[]}.',
						status: "pending",
					},
				],
				runner,
				{ maxRounds: 2 },
			);

			// One task delegated and resolved (done or failed) — the live path ran.
			expect(res.completed.length + res.failed.length).toBe(1);
			// Observable evidence of the live run.
			console.log(
				"LIVE colony result:",
				JSON.stringify(res.completed[0] ?? res.failed[0]),
			);
		},
		60_000,
	);

	it(
		"caches the stable system prompt (cachedInputTokens on a repeat) and streams with adaptive thinking",
		async () => {
			// A distinct advisor (Sonnet) with adaptive extended thinking, over a stable system
			// prompt large enough to clear Anthropic's minimum cacheable size (~1024 tokens).
			const { model } = resolveModel("anthropic/claude-sonnet-4-6");
			const bigSystem = "You are a terse assistant. Reply with exactly OK. ".repeat(300);
			const messages = [
				cachedSystemMessage(bigSystem),
				{ role: "user" as const, content: "Reply with OK." },
			];
			const providerOptions = {
				anthropic: { thinking: { type: "adaptive" as const } },
			};

			// First call writes the cache; the identical second call should read it.
			const first = await generateText({
				model,
				messages,
				allowSystemInMessages: true,
				maxOutputTokens: 2048,
				providerOptions,
			});
			expect(first.text.length).toBeGreaterThan(0); // thinking didn't break the stream

			const second = await generateText({
				model,
				messages,
				allowSystemInMessages: true,
				maxOutputTokens: 2048,
				providerOptions,
			});
			console.log(
				"LIVE cache tokens — first cache_read:",
				first.usage.cachedInputTokens,
				"second cache_read:",
				second.usage.cachedInputTokens,
			);
			// The repeat reads the cached system prefix (cache-read tokens > 0).
			expect(second.usage.cachedInputTokens ?? 0).toBeGreaterThan(0);
		},
		90_000,
	);
});
