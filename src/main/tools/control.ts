import { z } from "zod";
import { defineTool } from "./registry";

// nut.js is a native module; import lazily so importing the tools module
// doesn't fail in environments where the binary can't be loaded.
async function nut() {
  return import("@nut-tree-fork/nut-js");
}

export const mouseMoveTool = defineTool(
  "exec",
  async ({ x, y }) => {
    const { mouse, Point, straightTo } = await nut();
    mouse.config.mouseSpeed = 1000;
    await mouse.move(straightTo(new Point(x, y)));
    return `Mouse moved to (${x}, ${y}).`;
  },
  {
    name: "mouse_move",
    description: "Move the mouse cursor to an absolute screen coordinate (x, y).",
    schema: z.object({
      x: z.number().int().describe("Horizontal pixel coordinate from the left edge"),
      y: z.number().int().describe("Vertical pixel coordinate from the top edge"),
    }),
  },
);

export const mouseClickTool = defineTool(
  "exec",
  async ({ x, y, button }) => {
    const { mouse, Point, Button, straightTo, centerOf } = await nut();
    if (x !== undefined && y !== undefined) {
      await mouse.move(straightTo(new Point(x, y)));
    }
    const btn =
      button === "right" ? Button.RIGHT : button === "middle" ? Button.MIDDLE : Button.LEFT;
    await mouse.click(btn);
    return `Clicked ${button ?? "left"}${x !== undefined ? ` at (${x}, ${y})` : ""}.`;
  },
  {
    name: "mouse_click",
    description:
      "Click a mouse button. Optionally move to (x, y) first. Always call screenshot first to find the right coordinates.",
    schema: z.object({
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
    }),
  },
);

export const keyboardTypeTool = defineTool(
  "exec",
  async ({ text }) => {
    const { keyboard } = await nut();
    await keyboard.type(text);
    return `Typed ${text.length} characters.`;
  },
  {
    name: "keyboard_type",
    description: "Type a string of text at the current keyboard focus.",
    schema: z.object({
      text: z.string().describe("The exact text to type"),
    }),
  },
);

export const keyboardPressTool = defineTool(
  "exec",
  async ({ keys }) => {
    const { keyboard, Key } = await nut();
    const combo = keys.map((k: string) => resolveKey(Key, k));
    await keyboard.pressKey(...combo);
    await keyboard.releaseKey(...combo);
    return `Pressed ${keys.join("+")}.`;
  },
  {
    name: "keyboard_press",
    description:
      "Press a key or chord (e.g. [\"Enter\"], [\"LeftCmd\",\"c\"]). Common: Enter, Escape, Tab, Backspace, LeftCmd, RightCtrl, a-z, 0-9.",
    schema: z.object({
      keys: z
        .array(z.string())
        .min(1)
        .describe("Key names, lower/upper case insensitive. Use LeftCmd/RightCtrl for modifiers."),
    }),
  },
);

function resolveKey(Key: Record<string, any>, name: string): any {
  const candidates = [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)];
  for (const c of candidates) {
    if (Key[c] !== undefined) return Key[c];
  }
  // Single character keys may be referenced directly (Key["a"]).
  const single = name.length === 1 ? name.toLowerCase() : null;
  if (single && Key[single] !== undefined) return Key[single];
  throw new Error(`Unknown key: ${name}`);
}
