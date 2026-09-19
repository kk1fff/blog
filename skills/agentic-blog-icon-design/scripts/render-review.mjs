import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const svgPath = argument("--svg");
const outputDirectory = argument("--out");
if (!svgPath || !outputDirectory) {
  throw new Error("Usage: node render-review.mjs --svg <icon.svg> --out <directory>");
}

const svg = await fs.readFile(svgPath);
const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;
await fs.mkdir(outputDirectory, { recursive: true });

async function render(name, background, favicon) {
  const browser = await chromium.launch({ headless: true });
  try {
  const page = await browser.newPage({ viewport: { width: 560, height: favicon ? 300 : 420 }, deviceScaleFactor: 1 });
  const content = favicon ? `
    <main class="favicon-sheet">
      <p>Native 16 px</p><canvas id="native" width="16" height="16" aria-label="Native 16 pixel favicon"></canvas>
      <p>Pixel inspection (12×)</p><canvas id="zoom" width="192" height="192" aria-label="Nearest-neighbor enlarged favicon"></canvas>
    </main>` : `
    <main class="full-sheet"><img src="${dataUrl}" alt="SVG icon at review size" /></main>`;
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;min-height:100%;background:#fff;}
    body{align-items:center;display:flex;font-family:system-ui,sans-serif;justify-content:center;}
    main{align-items:center;background:${background};color:${background === "#ffffff" ? "#0b1220" : "#e5e7eb"};display:flex;justify-content:center;gap:28px;}
    .full-sheet{height:340px;width:480px;}
    .full-sheet img{width:256px;height:256px;display:block;}
    .favicon-sheet{align-items:center;flex-direction:column;gap:8px;height:260px;padding:20px;width:360px;}
    p{margin:0;font-size:14px;font-weight:700;letter-spacing:.02em;}
    #native{image-rendering:pixelated;}
    #zoom{image-rendering:pixelated;outline:1px solid ${background === "#ffffff" ? "#cbd5e1" : "#94a3b8"};}
  </style>${content}`);
  if (favicon) {
    await page.evaluate(async (src) => {
      const image = new Image(); image.src = src; await image.decode();
      const native = document.querySelector("#native");
      const zoom = document.querySelector("#zoom");
      const nativeContext = native.getContext("2d");
      nativeContext.drawImage(image, 0, 0, 16, 16);
      const zoomContext = zoom.getContext("2d"); zoomContext.imageSmoothingEnabled = false;
      zoomContext.drawImage(native, 0, 0, 16, 16, 0, 0, 192, 192);
    }, dataUrl);
  } else {
    await page.locator("img").evaluate((image) => image.decode());
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(outputDirectory, name) });
  await page.close();
  } finally {
    await browser.close();
  }
}

await render("light-full.png", "#ffffff", false);
await render("dark-full.png", "#334155", false);
await render("light-favicon.png", "#ffffff", true);
await render("dark-favicon.png", "#334155", true);
