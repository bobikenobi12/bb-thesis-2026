// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  WorkloadAssertionRequest,
  WorkloadAssertionSource,
} from "@repo/workload-identity";
import { mintWorkloadToken } from "./issuer";

/** Production assertion source backed by the console's vault-held local issuer key. */
export const localAssertionSource: WorkloadAssertionSource = {
  async getAssertion(request: WorkloadAssertionRequest): Promise<string> {
    return mintWorkloadToken(request);
  },
};
