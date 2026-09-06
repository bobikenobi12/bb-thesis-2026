// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** The provider-neutral input required to mint one cloud-token-exchange assertion. */
export interface WorkloadAssertionRequest {
  readonly audience: string;
  readonly subject?: string;
  readonly ttlSeconds?: number;
}

/** A replaceable source of short-lived workload assertions. */
export interface WorkloadAssertionSource {
  /** Returns one assertion scoped to the requested audience, subject, and lifetime. */
  getAssertion(request: WorkloadAssertionRequest): Promise<string>;
}

export {
  brokerAssertionRequestSchema,
  brokerAssertionResponseSchema,
  brokerRunSchema,
  MAX_ASSERTION_TTL_SECONDS,
  MIN_ASSERTION_TTL_SECONDS,
  WORKLOAD_SUBJECT,
  workloadProviderSchema,
} from "./broker";
export type {
  BrokerAssertionRequest,
  BrokerAssertionResponse,
  BrokerRun,
  WorkloadProvider,
} from "./broker";
