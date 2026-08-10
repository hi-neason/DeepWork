import { describe, expect, it } from "vitest";
import { TurnRuntime } from "./turnRuntime";

describe("TurnRuntime", () => {
  it("cancels only the active turn for a session", () => {
    const runtime = new TurnRuntime();
    const a = runtime.start("a");
    const b = runtime.start("b");

    expect(runtime.cancel("a")).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(false);
    expect(runtime.state("a")).toBe("cancelling");
  });

  it("does not let a stale turn clear a newer active turn", () => {
    const runtime = new TurnRuntime();
    const old = runtime.start("a");
    const current = runtime.start("a");
    runtime.finish("a", old.turnId, "completed");

    expect(runtime.activeTurnId("a")).toBe(current.turnId);
    expect(runtime.state("a")).toBe("running");

    runtime.finish("a", current.turnId, "completed");
    expect(runtime.activeTurnId("a")).toBeUndefined();
    expect(runtime.state("a")).toBe("completed");
  });
});
