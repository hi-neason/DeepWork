import { describe, expect, it } from "vitest";
import { classifyModelError } from "./model";

describe("classifyModelError", () => {
  it.each([
    [{ status: 401, message: "invalid key" }, "authentication"],
    [{ status: 429, message: "too many requests" }, "rate_limit"],
    [new Error("fetch failed: ECONNRESET"), "network"],
    [new Error("maximum context length exceeded"), "context_limit"],
    [new Error("unexpected response"), "unknown"],
  ] as const)("classifies %o as %s", (error, expected) => {
    expect(classifyModelError(error)).toBe(expected);
  });
});
