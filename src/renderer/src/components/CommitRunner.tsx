import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

const BEST_KEY = "deepwork.commitrunner.best";

type Colors = {
  bg: string;
  bgElev: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  danger: string;
  ok: string;
};

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || "#000000";
  return {
    bg: v("--bg"),
    bgElev: v("--bg-elev"),
    border: v("--border"),
    text: v("--text"),
    dim: v("--text-dim"),
    accent: v("--accent"),
    danger: v("--danger"),
    ok: v("--ok"),
  };
}

function loadBest(): number {
  try {
    return parseInt(localStorage.getItem(BEST_KEY) || "0", 10) || 0;
  } catch {
    return 0;
  }
}

function saveBest(n: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/**
 * A tiny developer-flavored easter-egg game for the empty/new-session page:
 * an endless runner where you jump (click or Space) to dodge red "bugs" on the
 * ground and collect green "commits" in the air. The component unmounts as soon
 * as a real conversation starts, so it costs nothing during work.
 */
export function CommitRunner(): React.ReactElement {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorsRef = useRef<Colors>(readColors());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const CSS_W = 300;
    const CSS_H = 132;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(CSS_W * dpr);
    canvas.height = Math.round(CSS_H * dpr);
    ctx.scale(dpr, dpr);

    const groundY = CSS_H - 22;
    const playerX = 36;
    const playerW = 22;
    const playerH = 22;
    const gravity = 0.62;
    const jumpV = -10.6;

    type Bug = { x: number; w: number; h: number };
    type Commit = { x: number; y: number; r: number; taken: boolean; bob: number };

    let running = false;
    let over = false;
    let score = 0;
    let best = loadBest();
    let speed = 3.2;
    let py = groundY;
    let vy = 0;
    let onGround = true;
    let bugs: Bug[] = [];
    let commits: Commit[] = [];
    let bugTimer = 60;
    let commitTimer = 40;
    let frame = 0;
    let milestone: { text: string; life: number } | null = null;
    let raf = 0;

    const roundRect = (
      c: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
    ): void => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    const milestoneAt = (n: number): string | null => {
      if (n === 10) return t("chat.dinoMilestone1");
      if (n === 30) return t("chat.dinoMilestone2");
      if (n === 50) return t("chat.dinoMilestone3");
      return null;
    };

    const reset = (): void => {
      running = false;
      over = false;
      score = 0;
      speed = 3.2;
      py = groundY;
      vy = 0;
      onGround = true;
      bugs = [];
      commits = [];
      bugTimer = 60;
      commitTimer = 40;
      frame = 0;
      milestone = null;
    };

    const start = (): void => {
      if (!running && !over) running = true;
      else if (over) {
        reset();
        running = true;
      }
    };

    const jump = (): void => {
      if (!running) {
        start();
        return;
      }
      if (onGround) {
        vy = jumpV;
        onGround = false;
      }
    };

    const spawnBug = (): void => {
      const h = 14 + Math.floor(Math.random() * 8);
      bugs.push({ x: CSS_W + 10, w: 16 + Math.floor(Math.random() * 6), h });
      const base = Math.max(46, 120 - speed * 8);
      bugTimer = base + Math.floor(Math.random() * 50);
    };

    const spawnCommit = (): void => {
      const y = groundY - 42 - Math.floor(Math.random() * 22);
      commits.push({ x: CSS_W + 10, y, r: 7, taken: false, bob: Math.random() * Math.PI * 2 });
      commitTimer = 70 + Math.floor(Math.random() * 80);
    };

    const rectHit = (bx: number, by: number, bw: number, bh: number): boolean =>
      playerX < bx + bw && playerX + playerW > bx && py < by + bh && py + playerH > by;

    const draw = (): void => {
      const c = colorsRef.current;
      ctx.clearRect(0, 0, CSS_W, CSS_H);
      ctx.fillStyle = c.bgElev;
      ctx.fillRect(0, 0, CSS_W, CSS_H);

      // ground line + subtle moving dots
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(CSS_W, groundY);
      ctx.stroke();
      ctx.fillStyle = c.border;
      const offset = (frame * speed) % 24;
      for (let x = -offset; x < CSS_W; x += 24) {
        ctx.fillRect(x, groundY + 6, 10, 2);
      }

      // commits
      for (const cm of commits) {
        if (cm.taken) continue;
        const yy = cm.y + Math.sin((frame + cm.bob * 20) * 0.08) * 2;
        ctx.fillStyle = c.ok;
        ctx.beginPath();
        ctx.arc(cm.x, yy, cm.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("✓", cm.x, yy + 0.5);
      }

      // bugs
      for (const b of bugs) {
        const by = groundY - b.h;
        ctx.fillStyle = c.danger;
        roundRect(ctx, b.x, by, b.w, b.h, 4);
        ctx.fill();
        ctx.fillStyle = c.text;
        ctx.fillRect(b.x + 3, by + 4, 2, 2);
        ctx.fillRect(b.x + b.w - 5, by + 4, 2, 2);
      }

      // player (a little terminal/code block)
      ctx.fillStyle = c.accent;
      roundRect(ctx, playerX, py, playerW, playerH, 4);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(">", playerX + playerW / 2, py + playerH / 2 + 1);

      // HUD
      ctx.fillStyle = c.text;
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`${score} ✅`, 8, 8);
      ctx.fillStyle = c.dim;
      ctx.textAlign = "right";
      ctx.fillText(`BEST ${best}`, CSS_W - 8, 8);

      // milestone popup
      if (milestone && milestone.life > 0) {
        ctx.fillStyle = c.accent;
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(milestone.text, CSS_W / 2, CSS_H / 2 - 18);
      }

      // ready overlay
      if (!running && !over) {
        ctx.fillStyle = c.dim;
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("▶ " + t("chat.dinoReady"), CSS_W / 2, CSS_H / 2);
      }

      // game over overlay
      if (over) {
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0, 0, CSS_W, CSS_H);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 14px sans-serif";
        ctx.fillText("💥 " + t("chat.dinoOver"), CSS_W / 2, CSS_H / 2 - 18);
        ctx.font = "12px sans-serif";
        ctx.fillText(`${score} ✅ · BEST ${best}`, CSS_W / 2, CSS_H / 2 + 4);
        ctx.fillStyle = c.accent;
        ctx.font = "bold 12px sans-serif";
        ctx.fillText(t("chat.dinoRestart"), CSS_W / 2, CSS_H / 2 + 24);
      }
    };

    const step = (): void => {
      if (running && !over) {
        frame++;
        speed = Math.min(7.5, speed + 0.0015);
        vy += gravity;
        py += vy;
        if (py >= groundY) {
          py = groundY;
          vy = 0;
          onGround = true;
        }
        for (const b of bugs) b.x -= speed;
        bugs = bugs.filter((b) => b.x + b.w > -10);
        for (const cm of commits) cm.x -= speed;
        commits = commits.filter((cm) => cm.x + cm.r > -10);

        bugTimer--;
        if (bugTimer <= 0) spawnBug();
        commitTimer--;
        if (commitTimer <= 0) spawnCommit();

        for (const b of bugs) {
          if (rectHit(b.x, groundY - b.h, b.w, b.h)) {
            over = true;
            if (score > best) {
              best = score;
              saveBest(best);
            }
            break;
          }
        }
        for (const cm of commits) {
          if (cm.taken) continue;
          const cy = cm.y + Math.sin((frame + cm.bob * 20) * 0.08) * 2;
          if (
            playerX < cm.x + cm.r &&
            playerX + playerW > cm.x - cm.r &&
            py < cy + cm.r &&
            py + playerH > cy - cm.r
          ) {
            cm.taken = true;
            score++;
            const m = milestoneAt(score);
            if (m) milestone = { text: m, life: 90 };
          }
        }
        if (milestone) milestone.life--;
      } else {
        frame++;
        for (const cm of commits) cm.x -= speed * 0.3;
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);

    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
        e.preventDefault();
        if (over) {
          reset();
          running = true;
        } else {
          jump();
        }
      }
    };

    const onClick = (): void => {
      if (over) {
        reset();
        running = true;
      } else {
        jump();
      }
    };

    window.addEventListener("keydown", onKey);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      onClick();
    }, { passive: false });

    const onTheme = (): void => {
      colorsRef.current = readColors();
    };
    const observer = new MutationObserver(onTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onTheme);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      canvas.removeEventListener("click", onClick);
      observer.disconnect();
      mq.removeEventListener("change", onTheme);
    };
  }, [t]);

  return (
    <div className="dino-card">
      <div className="dino-head">
        <span className="dino-title">{t("chat.dinoTitle")}</span>
        <span className="dino-hint">{t("chat.dinoHint")}</span>
      </div>
      <canvas ref={canvasRef} className="dino-canvas" />
    </div>
  );
}
