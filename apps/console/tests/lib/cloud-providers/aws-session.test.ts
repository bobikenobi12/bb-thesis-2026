// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  assumeAwsRole,
  awsConfigured,
} from "@/lib/cloud-providers/session/aws";

afterEach(() => {
  delete process.env.ALETHIA_OIDC_SIGNING_KEY;
  delete process.env.ALETHIA_E2E_ASSERTION_BROKER_URL;
});

describe("AWS session assertion source", () => {
  it("reports an unconfigured assertion source", () => {
    expect(awsConfigured()).toBe(false);
  });

  it("refuses an identity without a role before requesting an assertion", async () => {
    await expect(assumeAwsRole({ credentials: {} })).rejects.toThrow(
      "This AWS connection has no role ARN.",
    );
  });
});
