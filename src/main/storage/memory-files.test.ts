import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// timeline-memory.ts / project-memory.ts 把状态落到 config/paths 指定的目录。
// 这里在 mock 工厂内建临时目录，并把它作为 TIMELINE_MEMORY_DIR / PROJECT_MEMORY_DIR，
// 从而隔离真实 ~/DeepWork，且保证模块加载时即捕获到临时路径。
vi.mock("../config/paths", async (importOriginal) => {
  const f = await import("node:fs");
  const p = await import("node:path");
  const o = await import("node:os");
  const base = f.mkdtempSync(p.join(o.tmpdir(), "dw-memfiles-"));
  return {
    ...(await importOriginal<typeof import("../config/paths")>()),
    TIMELINE_MEMORY_DIR: p.join(base, "timeline"),
    PROJECT_MEMORY_DIR: p.join(base, "project"),
  };
});

import * as paths from "../config/paths";
import * as timeline from "./timeline-memory";
import * as project from "./project-memory";

describe("storage/timeline-memory", () => {
  const tlDir = paths.TIMELINE_MEMORY_DIR;
  beforeEach(() => {
    fs.mkdirSync(tlDir, { recursive: true });
    fs.mkdirSync(paths.PROJECT_MEMORY_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(tlDir), { recursive: true, force: true });
  });

  it("todayStr 返回 Asia/Shanghai 的 YYYY-MM-DD", () => {
    expect(timeline.todayStr(new Date("2026-08-08T10:00:00+08:00"))).toBe("2026-08-08");
  });

  it("首次追加生成标题 + 项目分段 + 有序编号", () => {
    const date = "2026-08-08";
    timeline.appendTimelineEntry({ date, project: "DeepWork", points: ["做了 A", "做了 B"] });
    const file = path.join(tlDir, `${date}.md`);
    const content = fs.readFileSync(file, "utf-8");
    expect(content).toContain(`# ${date} 时间线记忆`);
    expect(content).toContain("## DeepWork");
    expect(content).toContain("1. 做了 A");
    expect(content).toContain("2. 做了 B");
  });

  it("同一项目续号，且去重相同条目", () => {
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["x"] });
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["x", "y"] });
    const content = fs.readFileSync(path.join(tlDir, "2026-08-08.md"), "utf-8");
    expect(content).toContain("1. x");
    expect(content).toContain("2. y");
    expect(content.split("1. x").length - 1).toBe(1);
  });

  it("不同项目各自成段", () => {
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "A", points: ["a1"] });
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "B", points: ["b1"] });
    const content = fs.readFileSync(path.join(tlDir, "2026-08-08.md"), "utf-8");
    expect(content).toContain("## A");
    expect(content).toContain("## B");
  });

  it("空 points 不写文件", () => {
    timeline.appendTimelineEntry({ project: "P", points: ["   ", ""] });
    expect(fs.existsSync(path.join(tlDir, "2026-08-08.md"))).toBe(false);
  });

  // C-S1 回归：date 原样拼进路径，未做校验 → 路径穿越可读 DeepWork 目录外任意
  // markdown。修复后 readTimelineDate/timelinePath 在边界处校验格式 + 解析路径前缀
  // 必须落在 TIMELINE_MEMORY_DIR 内，穿越既不读外部文件也不泄露路径。
  it("readTimelineDate 拒绝含 ../ 的 date，不读取目录外文件 (C-S1 路径穿越防护)", () => {
    // 在 timeline 目录放一份正常文件
    timeline.appendTimelineEntry({ date: "2026-08-08", project: "P", points: ["safe"] });
    // 在 timeline 目录外放一份诱饵，确认不会被穿越读到
    const decoyDir = path.dirname(tlDir);
    fs.writeFileSync(path.join(decoyDir, "secret-2026-08-08.md"), "LEAKED");

    const normal = timeline.readTimelineDate("2026-08-08");
    expect(normal).toContain("safe");

    const traversal = timeline.readTimelineDate("../../secret-2026-08-08");
    expect(traversal).toBe(""); // 穿越被拦截，不返回诱饵内容
    expect(traversal).not.toContain("LEAKED");

    // 格式错误（非 YYYY-MM-DD）同样安全返回空
    expect(timeline.readTimelineDate("not-a-date")).toBe("");
  });

  it("timelinePath 对非法 date 抛错而非返回越界路径", () => {
    expect(() => timeline.timelinePath("../escape")).toThrow();
  });
});

describe("storage/project-memory", () => {
  const pjDir = paths.PROJECT_MEMORY_DIR;
  beforeEach(() => {
    fs.mkdirSync(pjDir, { recursive: true });
    fs.mkdirSync(paths.TIMELINE_MEMORY_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(pjDir), { recursive: true, force: true });
  });

  it("safeFileName 把非法文件名字符替换为下划线（验证 projectMemoryFilePath 输出）", () => {
    const p = project.projectMemoryFilePath("a/b:c*?d");
    // 路径中的目录分隔符是允许的；检查文件名部分已把非法字符替换为下划线
    expect(path.basename(p)).toBe("a_b_c__d.md");
    expect(p.endsWith("a_b_c__d.md")).toBe(true);
  });

  it("按日期分组，新日期置顶", () => {
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-07", points: ["old"] });
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["new"] });
    const content = fs.readFileSync(project.projectMemoryPath("P"), "utf-8");
    const idxNew = content.indexOf("## 2026-08-08");
    const idxOld = content.indexOf("## 2026-08-07");
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("同日期去重且续号", () => {
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["m"] });
    project.appendProjectMemoryEntry({ project: "P", date: "2026-08-08", points: ["m", "n"] });
    const content = fs.readFileSync(project.projectMemoryPath("P"), "utf-8");
    expect(content).toContain("1. m");
    expect(content).toContain("2. n");
    expect(content.split("1. m").length - 1).toBe(1);
  });
});
