import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createMillRuntime } from "./runtime.api";

describe("runtime.api", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = `/tmp/mill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    try {
      require("fs").rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("createMillRuntime returns api object", () => {
    const runtime = createMillRuntime({ tasksDirectory: tmpDir });
    expect(typeof runtime.submit).toBe("function");
    expect(typeof runtime.status).toBe("function");
    expect(typeof runtime.wait).toBe("function");
    expect(typeof runtime.result).toBe("function");
    expect(typeof runtime.send).toBe("function");
    expect(typeof runtime.complete).toBe("function");
    expect(typeof runtime.cancel).toBe("function");
    expect(typeof runtime.list).toBe("function");
  });
});
