import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKSPACE_DIR } from "../config/paths";

const { mkdirMock, appendFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  appendFileMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  appendFile: appendFileMock,
}));

describe("logger", () => {
  beforeEach(() => {
    mkdirMock.mockClear();
    appendFileMock.mockClear();
  });

  it("uses the built-in default workspace when the configured path is empty", async () => {
    const { configureLogger, logger } = await import("./logger");

    configureLogger({ enabled: true, workspaceDir: "" });
    logger.info("app", "ready", undefined, "session-1");

    await vi.waitFor(() => {
      expect(appendFileMock).toHaveBeenCalledWith(
        expect.stringContaining(`${DEFAULT_WORKSPACE_DIR}/sessions/session-1/deepwork.log`),
        expect.any(String),
      );
    });
  });

  it("does not write when logging is disabled", async () => {
    const { configureLogger, logger } = await import("./logger");
    configureLogger({ enabled: false, workspaceDir: "/tmp/work" });
    logger.error("app", "hidden");
    await Promise.resolve();
    expect(appendFileMock).not.toHaveBeenCalled();
  });

  it("redacts secret-shaped metadata and preserves ordinary fields", async () => {
    const { configureLogger, logger } = await import("./logger");
    configureLogger({ enabled: true, workspaceDir: "/tmp/work" });
    logger.info("http", "request", {
      apiKey: "top-secret",
      authorization: "Bearer secret",
      endpoint: "https://example.com/v1",
    }, "s1");
    await vi.waitFor(() => expect(appendFileMock).toHaveBeenCalled());
    const line = appendFileMock.mock.calls.at(-1)?.[1] as string;
    expect(line).not.toContain("top-secret");
    expect(line).not.toContain("Bearer secret");
    expect(JSON.parse(line)).toMatchObject({
      apiKey: "<redacted>", authorization: "<redacted>", endpoint: "https://example.com/v1",
    });
  });

  it("serializes writes in call order and continues after a write failure", async () => {
    const { configureLogger, logger } = await import("./logger");
    appendFileMock.mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureLogger({ enabled: true, workspaceDir: "/tmp/work" });
    logger.info("app", "first", undefined, "s1");
    logger.info("app", "second", undefined, "s1");
    await vi.waitFor(() => expect(appendFileMock).toHaveBeenCalledTimes(2));
    expect(appendFileMock.mock.calls[0][1]).toContain('"msg":"first"');
    expect(appendFileMock.mock.calls[1][1]).toContain('"msg":"second"');
    expect(consoleSpy).toHaveBeenCalledWith("[logger] write failed", expect.any(Error));
  });
});
