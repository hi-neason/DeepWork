import { z } from "zod";
import { defineTool } from "./registry";
import { desktopCapturer } from "electron";
import { strict as assert } from "node:assert";

/**
 * Screenshot the primary display and return a base64 PNG plus its pixel size.
 * GUI tools are the high-risk "fallback" capability — always gated by approval.
 */
export const screenshotTool = defineTool(
  "exec",
  async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const primary = sources[0];
    assert(primary, "No display source available for screenshot");
    const img = primary.thumbnail;
    const size = img.getSize();
    return {
      content: [
        {
          type: "image_url" as const,
          image_url: { url: img.toDataURL() },
        },
        {
          type: "text" as const,
          text: `Screenshot of primary display (${size.width}x${size.height}px). The top-left is coordinate (0,0).`,
        },
      ],
    };
  },
  {
    name: "screenshot",
    description:
      "Capture the screen as a PNG image. Use this before any mouse/keyboard action so you can see what is on screen.",
    schema: z.object({}),
  },
);
