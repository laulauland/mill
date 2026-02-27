import { describe, expect, it } from "bun:test";
import { parsePiSettingsModels } from "./pi-settings.codec";

describe("parsePiSettingsModels", () => {
  it("returns models from valid settings JSON", () => {
    const raw = JSON.stringify({
      enabledModels: ["openai/gpt-4", "anthropic/claude-sonnet-4-6"],
    });
    const models = parsePiSettingsModels(raw);

    expect(models).toEqual(["openai/gpt-4", "anthropic/claude-sonnet-4-6"]);
  });

  it("returns empty array for missing enabledModels", () => {
    const raw = JSON.stringify({ otherField: "value" });
    const models = parsePiSettingsModels(raw);

    expect(models).toEqual([]);
  });

  it("returns empty array for non-object JSON", () => {
    const raw = JSON.stringify("just a string");
    const models = parsePiSettingsModels(raw);

    expect(models).toEqual([]);
  });
});
