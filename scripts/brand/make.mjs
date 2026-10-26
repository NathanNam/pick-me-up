#!/usr/bin/env node
// Favicon set + 1200×630 share image for Pick Me Up.
//
//   npm i --no-save puppeteer-core@23.11.1
//   node scripts/brand/make.mjs
//
// Needs Google Chrome at CHROME_PATH (default: the macOS app path).
// Outputs (committed): public/icon.svg, public/favicon.ico, public/favicon-32.png,
// public/apple-touch-icon.png, public/icon-512.png, public/og.png

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pub = path.join(root, 'public');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const font = fs.readFileSync(path.join(pub, 'fonts/nunito-latin-wght-normal.woff2')).toString('base64');
const display = fs.readFileSync(path.join(pub, 'fonts/fraunces-latin-full-normal.woff2')).toString('base64');
const art = fs.readFileSync(path.join(pub, 'art/pickup.jpg')).toString('base64');

// A brown map pin whose head is a clock, on harvest gold, with the wagon's
// three-stripe decal along the bottom.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <clipPath id="r"><rect width="64" height="64" rx="14"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="64" height="64" fill="#e5a630"/>
    <rect y="50" width="64" height="5" fill="#d9631e"/><rect y="55" width="64" height="5" fill="#7a4a24"/><rect y="60" width="64" height="4" fill="#3a2616"/>
  </g>
  <path d="M32 54 C24 44 14 36 14 25 a18 18 0 0 1 36 0 C50 36 40 44 32 54Z" fill="#3a2616"/>
  <circle cx="32" cy="25" r="12" fill="#fffaf0"/>
  <path d="M32 17.5 V25 L37.5 28" fill="none" stroke="#3a2616" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(size, o); header.writeUInt8(size, o + 1);
    header.writeUInt16LE(1, o + 4); header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(buf.length, o + 8); header.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.buf)]);
}

// The share poster: title, tagline, features and URL on the left; the app's
// answer card on the right, with a real kind of event (a playoff game at Chase
// Center while crowds arrive) flagged on the route.
const POSTER = `<!doctype html><style>
@font-face{font-family:N;font-weight:300 900;src:url(data:font/woff2;base64,${font})}
@font-face{font-family:F;font-weight:100 900;src:url(data:font/woff2;base64,${display})}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#f6eedb;color:#3a2616;font:600 18px/1.4 N,sans-serif;position:relative}
.soft{font-family:F,serif;font-variation-settings:"SOFT" 100,"WONK" 1,"opsz" 144}
.art{position:absolute;left:0;bottom:0;width:760px;height:356px;display:block}
.left{position:absolute;left:64px;top:52px;width:620px}
.k{display:flex;align-items:center;gap:12px;font-weight:800;font-size:16px;letter-spacing:.14em;text-transform:uppercase;color:#a44a14}
.k svg{width:40px;height:40px}
h1{font-weight:900;font-size:96px;line-height:.95;letter-spacing:-.02em;margin:14px 0 14px;color:#5a3417;display:flex;align-items:center;gap:18px}
.decal{display:inline-flex;flex-direction:column;gap:5px}.decal i{display:block;width:84px;height:9px;border-radius:4px}
.decal i:nth-child(1){background:#d9631e}.decal i:nth-child(2){background:#e5a630}.decal i:nth-child(3){background:#7a4a24}
.tl{font-weight:800;font-size:28px;line-height:1.25}
.sub{margin-top:10px;color:#7d6650;font-size:18px;line-height:1.45}
.url{position:absolute;right:452px;top:286px;display:none}
.phone{position:absolute;right:70px;top:40px;width:370px;height:620px;border-radius:50px;background:#3a2616;padding:13px;box-shadow:0 30px 60px #3a261633}
.scr{background:#f4ead4;border-radius:38px;height:100%;padding:24px 16px;overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;font-weight:900;font-size:19px;margin-bottom:12px;color:#5a3417}
.bar svg{width:26px;height:26px}
.wood{border-radius:20px;padding:11px;border:3px solid #c9ccd1;background:linear-gradient(180deg,#0000 0 46%,#ffffff22 50%,#0000 54%),repeating-linear-gradient(180deg,#7a4a24 0 5px,#8c5a2c 5px 9px,#6b3f1e 9px 11px,#93612f 11px 18px,#7f4e27 18px 23px)}
.door{background:#fffaf0;border-radius:12px;padding:16px 12px 14px;text-align:center;box-shadow:0 0 0 3px #d9dce0,0 0 0 5px #9aa0a6}
.w{font-weight:800;font-size:13px;letter-spacing:.06em;color:#a44a14;text-transform:uppercase}
.l{margin-top:6px;font-weight:700;color:#7d6650;font-size:15px}
.t{font-weight:900;font-size:64px;line-height:1;margin:2px 0 6px}
.d{color:#7d6650;font-size:14px}
.v{display:inline-block;margin-top:10px;padding:6px 12px;border-radius:6px;background:#d9631e;color:#fffaf0;font-weight:900;font-size:13px;letter-spacing:.03em;text-transform:uppercase;transform:rotate(-1.5deg);border:2px dashed #fffaf099}
.m{color:#7d6650;font-size:13px;margin-top:8px}.m b{color:#3a2616}
.note{margin-top:12px;background:#fffdf6 repeating-linear-gradient(180deg,#0000 0 23px,#bcd3e6 23px 24px);border-radius:16px;padding:12px 12px 4px 30px;position:relative;border:1px solid #e4d3b2}
.note:before{content:"";position:absolute;left:20px;top:0;bottom:0;width:2px;background:#e8a0a0}
.note h4{font-weight:800;font-size:17px;line-height:24px;color:#5a3417}
.note div{font-size:13px;line-height:24px}.note b{font-weight:800}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.url2{position:absolute;left:64px;top:370px;font-weight:800;font-size:20px;background:#d9631e;color:#fffaf0;border-radius:12px;padding:8px 16px;box-shadow:0 3px 0 #8a3d12}
</style>
<canvas class="art" id="art" width="1280" height="600"></canvas>
<script>
// The picture's sky is plain cream: paint out its sun and cloud so the title has room.
const img = new Image();
img.onload = () => {
  const c = document.getElementById('art'), g = c.getContext('2d');
  g.drawImage(img, 0, 0, 1280, 600);
  const [r, gg, b] = g.getImageData(640, 24, 1, 1).data;
  g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
  g.fillRect(0, 0, 1280, 6);       // the picture's top border
  g.fillRect(490, 0, 230, 205);   // sun
  g.fillRect(95, 90, 170, 85);    // cloud
  document.body.dataset.ready = '1';
};
img.src = 'data:image/jpeg;base64,${art}';
</script>
<div class="left">
  <div class="k">${ICON} San Francisco</div>
  <h1 class="soft">Pick Me Up <span class="decal"><i></i><i></i><i></i></span></h1>
  <p class="tl">Know when to leave for school,<br>planned for a bad-traffic day.</p>
  <p class="sub">Leave-by countdown · games, concerts, conventions<br>and street closures checked along your route</p>
</div>
<div class="url2">pickmeup-sf.vercel.app</div>
<div class="phone"><div class="scr">
  <div class="bar">${ICON}<span class="soft">Pick Me Up</span></div>
  <div class="wood"><div class="door">
    <div class="w soft">Pick-up · Today</div>
    <div class="l">Leave by</div>
    <div class="t soft">2:14 PM</div>
    <div class="d">to be at School by 3:00 PM</div>
    <div class="v soft">Game at Chase Center on your route</div>
    <div class="m">Bad-day drive <b>26 min</b> · usually 17 · plus 10 min</div>
  </div></div>
  <div class="note">
    <h4 class="soft">Carpool schedule</h4>
    <div><span class="dot" style="background:#6f7d2c"></span><b>Tue</b> · Pick-up 3:00 · nothing unusual</div>
    <div><span class="dot" style="background:#e5a630"></span><b>Wed</b> · Pick-up 3:00 · summit nearby</div>
    <div><span class="dot" style="background:#6f7d2c"></span><b>Thu</b> · Pick-up 3:00 · nothing unusual</div>
    <div><span class="dot" style="background:#6f7d2c"></span><b>Sat</b> · Science fair 10:00 AM</div>
  </div>
</div></div>`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  fs.writeFileSync(path.join(pub, 'icon.svg'), ICON);
  const page = await browser.newPage();
  const png = async (size, opaque) => {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${ICON}`);
    return page.screenshot({ omitBackground: !opaque });
  };
  const [p16, p32, p48] = [await png(16), await png(32), await png(48)];
  fs.writeFileSync(path.join(pub, 'favicon-32.png'), p32);
  fs.writeFileSync(path.join(pub, 'apple-touch-icon.png'), await png(180, true));
  fs.writeFileSync(path.join(pub, 'icon-512.png'), await png(512, true));
  fs.writeFileSync(path.join(pub, 'favicon.ico'), ico([{ size: 16, buf: p16 }, { size: 32, buf: p32 }, { size: 48, buf: p48 }]));
  console.log('wrote public/icon.svg, favicon-32.png, apple-touch-icon.png, icon-512.png, favicon.ico');

  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(POSTER, { waitUntil: 'load' });
  await page.waitForSelector('body[data-ready]');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(pub, 'og.png') });
  console.log('wrote public/og.png');
} finally {
  await browser.close();
}
