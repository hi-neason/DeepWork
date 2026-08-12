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
});
