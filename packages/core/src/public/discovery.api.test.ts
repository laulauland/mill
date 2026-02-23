import { describe, expect, it } from "bun:test";
import { createDiscoveryPayload } from "./discovery.api";

describe("createDiscoveryPayload", () => {
  it("returns discovery contract v1", async () => {
    const payload = await createDiscoveryPayload();

    expect(payload.discoveryVersion).toBe(1);
    expect(payload.async.submit).toContain("mill run");
    expect(payload.programApi.spawnRequired).toContain("agent");
  });
});
