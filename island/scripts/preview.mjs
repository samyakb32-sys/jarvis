// Renders the island in headless Chromium (browser preview mode, sample data)
// and measures what the robot costs.
//
//   node scripts/preview.mjs shots <outDir>   # PNGs of every view
//   node scripts/preview.mjs perf             # CPU use of Lite vs Live robot over 10 s
//
// Uses the production build (`npm run build:ui` first) served from dist/.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const file = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const executablePath = process.env.CHROMIUM || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const [cmd, arg] = process.argv.slice(2);

// What the window would be for each view (place.ts: strip 240×8, panel 680×440, orb 64×84, orb+pill 364×84, orb+panel 680×524).
const VIEWS = [
  { name: "1-docked-hidden", q: "demo=hidden", size: [240, 8] },
  { name: "2-docked-peek", q: "demo=peek", size: [680, 440] },
  { name: "3-docked-permission", q: "demo=card", size: [680, 440] },
  { name: "4-docked-question", q: "demo=question", size: [680, 440] },
  { name: "5-docked-plan", q: "demo=plan", size: [680, 440] },
  { name: "6-docked-home", q: "demo=home", size: [680, 440] },
  { name: "7-docked-settings", q: "demo=settings", size: [680, 440] },
  { name: "8-ball-hidden", q: "demo=hidden&place=float", size: [64, 84] },
  { name: "9-ball-peek", q: "demo=peek&place=float", size: [364, 84] },
  { name: "10-ball-permission", q: "demo=card&place=float", size: [680, 524] },
];

if (cmd === "shots") {
  const out = path.resolve(arg ?? "shots");
  mkdirSync(out, { recursive: true });
  for (const v of VIEWS) {
    const page = await browser.newPage({ viewport: { width: v.size[0], height: v.size[1] }, deviceScaleFactor: 2 });
    await page.addInitScript(() => localStorage.clear());
    await page.goto(`${base}?${v.q}`);
    await page.waitForTimeout(900);
    // A checkered backdrop shows the transparent window around the island.
    await page.evaluate(() => (document.documentElement.style.background = "repeating-conic-gradient(#3a3a42 0% 25%, #45454e 0% 50%) 0 0 / 16px 16px"));
    await page.screenshot({ path: path.join(out, `${v.name}.png`) });
    await page.close();
    console.log(v.name);
  }
}

if (cmd === "perf") {
  const clk = Number(process.env.CLK_TCK ?? 100);
  /** Total CPU seconds used so far by every Chromium process on the machine (the browser, renderers, GPU). */
  const cpu = () => {
    let total = 0;
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (!readFileSync(`/proc/${d}/cmdline`, "utf8").includes("chrome")) continue;
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        total += (Number(f[11]) + Number(f[12])) / clk;
      } catch {}
    }
    return total;
  };
  const measure = async (label, q) => {
    const page = await browser.newPage({ viewport: { width: 364, height: 84 } });
    await page.goto(`${base}?${q}`);
    await page.waitForTimeout(2500); // settle: load, decode, first frames
    const a = cpu();
    const t0 = Date.now();
    await page.waitForTimeout(10000);
    const used = cpu() - a;
    const secs = (Date.now() - t0) / 1000;
    console.log(`${label.padEnd(28)} ${(100 * used / secs).toFixed(1)} % of one core`);
    await page.close();
  };
  await measure("blank page (baseline)", "demo=hidden&place=float&anim=still");
  await measure("ball, Off (still image)", "demo=peek&place=float&anim=still");
  await measure("ball, Lite (sprite)", "demo=peek&place=float&anim=lite");
  await measure("ball, Live 3D (20 fps)", "demo=peek&place=float&anim=live");
}

await browser.close();
server.close();
