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

// A navy map pin whose head is a clock, on school-bus yellow.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#f4b400"/>
  <path d="M32 58 C24 47 13 38 13 26 a19 19 0 0 1 38 0 C51 38 40 47 32 58Z" fill="#1d2733"/>
  <circle cx="32" cy="26" r="12.5" fill="#fffdf9"/>
  <path d="M32 18.5 V26 L37.5 29" fill="none" stroke="#1d2733" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
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
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:#f7f3ec;color:#1d2733;font:600 18px/1.4 N,sans-serif;position:relative}
body:before{content:"";position:absolute;right:-120px;top:-160px;width:760px;height:760px;border-radius:50%;background:radial-gradient(circle,#fff3cc 0,#f7f3ec00 70%)}
.left{position:absolute;left:72px;top:70px;width:560px}
.k{display:flex;align-items:center;gap:12px;font-weight:800;font-size:17px;letter-spacing:.14em;text-transform:uppercase;color:#6a7280}
.k svg{width:44px;height:44px}
h1{font-weight:900;font-size:104px;line-height:.95;letter-spacing:-.04em;margin:26px 0 22px}
h1 span{color:#f4b400;-webkit-text-stroke:0}
.tl{font-weight:800;font-size:30px;line-height:1.25}
.sub{margin-top:16px;color:#6a7280;font-size:19px;line-height:1.5}
.url{position:absolute;left:72px;bottom:56px;font-weight:800;font-size:22px;background:#1d2733;color:#fff;border-radius:14px;padding:10px 18px}
.phone{position:absolute;right:84px;top:44px;width:400px;height:640px;border-radius:52px;background:#1d2733;padding:14px;box-shadow:0 30px 60px #1d273330}
.scr{background:#f7f3ec;border-radius:40px;height:100%;padding:26px 18px;overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:12px}
.bar svg{width:24px;height:24px}
.card{background:#fffdf9;border:1px solid #e7e0d4;border-radius:22px;padding:20px 16px 16px;text-align:center;position:relative;overflow:hidden;box-shadow:0 6px 20px #1d27330d}
.card:before{content:"";position:absolute;left:0;right:0;top:0;height:6px;background:#f4b400}
.w{font-weight:800;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#6a7280}
.l{margin-top:8px;font-weight:700;color:#6a7280;font-size:16px}
.t{font-weight:900;font-size:72px;line-height:1;letter-spacing:-.03em;margin:2px 0 6px}
.c{font-weight:800;font-size:19px}
.d{color:#6a7280;font-size:15px}
.v{display:inline-flex;align-items:center;gap:8px;margin-top:12px;padding:7px 13px;border-radius:999px;background:#fbe6df;color:#b4432a;font-weight:800;font-size:15px}
.v:before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor}
.m{color:#6a7280;font-size:14px;margin-top:10px}.m b{color:#1d2733}
.ev{margin-top:12px;background:#fffdf9;border:1px solid #e7e0d4;border-radius:22px;padding:14px 14px;display:grid;grid-template-columns:40px 1fr;gap:10px;text-align:left}
.i{width:40px;height:40px;border-radius:12px;background:#fbe6df;display:grid;place-items:center;font-size:20px}
.et{font-weight:800;font-size:15px;line-height:1.25}.et span{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;background:#fbe6df;color:#b4432a;border-radius:6px;padding:1px 6px;margin-right:6px}
.em{color:#6a7280;font-size:13px}
</style>
<div class="left">
  <div class="k">${ICON} San Francisco · school run</div>
  <h1>Pick Me<br>Up<span>.</span></h1>
  <p class="tl">Know when to leave for school,<br>planned for a bad-traffic day.</p>
  <p class="sub">Bad-day drive time · a leave-by countdown<br>Giants games, Chase Center, street closures on your route</p>
</div>
<div class="url">pickmeup-sf.vercel.app</div>
<div class="phone"><div class="scr">
  <div class="bar">${ICON} Pick Me Up</div>
  <div class="card">
    <div class="w">Pick-up · Today</div>
    <div class="l">Leave by</div>
    <div class="t">2:22 PM</div>
    <div class="c">in 48 min</div>
    <div class="d">to be at School by 3:00 PM</div>
    <div class="v">Valkyries game on your route</div>
    <div class="m">Bad-day drive <b>28 min</b> · usually 19 · plus your 10 min</div>
  </div>
  <div class="ev"><div class="i">🏟️</div><div><div class="et"><span>On your route</span>WNBA Playoffs: Valkyries v Dream</div><div class="em">Crowds arriving 3:30–5:15 PM · Chase Center</div></div></div>
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
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(pub, 'og.png') });
  console.log('wrote public/og.png');
} finally {
  await browser.close();
}
