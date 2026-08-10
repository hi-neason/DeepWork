import { describe, expect, it } from "vitest";
import { SessionRuntime } from "./sessionRuntime";

describe("SessionRuntime", () => {
  it("scopes workspace, model, mode, and grants to one session", () => {
    const runtime = new SessionRuntime();
    runtime.setWorkspace("a", "/project-a");
    runtime.setModel("a", "openai:gpt-4o");
    runtime.setMode("a", "auto");
    runtime.allowTool("a", "write_file");

    expect(runtime.getWorkspace("a")).toBe("/project-a");
    expect(runtime.getModel("a")).toBe("openai:gpt-4o");
    expect(runtime.getMode("a")).toBe("auto");
    expect(runtime.getAlwaysAllowed("a")?.has("write_file")).toBe(true);
    expect(runtime.getAlwaysAllowed("b")).toBeUndefined();
  });

  it("clears transient state on session deletion and rebuild", () => {
    const runtime = new SessionRuntime();
    runtime.setWorkspace("a", "/project-a");
    runtime.setUnattended("a", true);
    runtime.allowTool("a", "execute");
    runtime.forget("a");

    expect(runtime.getWorkspace("a")).toBeUndefined();
    expect(runtime.isUnattended("a")).toBe(false);
    expect(runtime.getAlwaysAllowed("a")).toBeUndefined();

    runtime.allowTool("b", "write_file");
    runtime.clearAlwaysAllowed();
    expect(runtime.getAlwaysAllowed("b")).toBeUndefined();
  });
});
