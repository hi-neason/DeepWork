import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasPickedWorkspace,
  sessionArtifactsDir,
  sessionRootDir,
} from "./paths";

describe("session workspace paths", () => {
  it("places an unselected session under the configured default workspace", () => {
    const configuredDefault = path.resolve("/tmp/deepwork-default");
    const expected = path.join(configuredDefault, "sessions", "session-1");

    expect(hasPickedWorkspace(undefined)).toBe(false);
    expect(sessionRootDir("session-1", undefined, configuredDefault)).toBe(expected);
    expect(sessionArtifactsDir("session-1", undefined, configuredDefault)).toBe(expected);
  });

  it("places a selected project's session workspace in its .deepwork drawer", () => {
    const project = path.resolve("/tmp/deepwork-project");

    expect(hasPickedWorkspace(project)).toBe(true);
    const expected = path.join(project, ".deepwork", "sessions", "session-2");
    expect(sessionRootDir("session-2", project)).toBe(expected);
    expect(sessionArtifactsDir("session-2", project)).toBe(
      expected,
    );
  });
});
