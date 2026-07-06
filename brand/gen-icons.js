// Regenerates site/icons/* from the derived flat favicon (brand/favicon-src.svg).
// One-off build tool — sharp is NOT a project dependency (keeps CI/deploy lean; the icons are
// committed). To re-run:  npm i -D sharp && node brand/gen-icons.js
const sharp = require('sharp');
const fs = require('fs');
const CREAM = { r:0xF7, g:0xF4, b:0xEC, alpha:1 };
const svg = fs.readFileSync('brand/favicon-src.svg');

// Transparent small favicons (crisp on the tab bar, any background)
async function transparent(size, out) {
  await sharp(svg, { density: 384 }).resize(size, size, { fit:'contain', background:{r:0,g:0,b:0,alpha:0} })
    .png().toFile(out);
}
// Rounded cream tile for app icons (iOS apple-touch has no alpha; Android tiles look better with a plate)
async function tile(size, out, pad) {
  const inner = Math.round(size * (1 - pad*2));
  const bird = await sharp(svg, { density: 512 }).resize(inner, inner, { fit:'contain', background:{r:0,g:0,b:0,alpha:0} }).png().toBuffer();
  const radius = Math.round(size * 0.18);
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`);
  await sharp({ create:{ width:size, height:size, channels:4, background:CREAM } })
    .composite([{ input: bird, gravity:'center' }, { input: mask, blend:'dest-in' }])
    .png().toFile(out);
}

(async () => {
  await transparent(16,  'site/icons/favicon-16.png');
  await transparent(32,  'site/icons/favicon-32.png');
  await tile(180, 'site/icons/apple-touch-icon.png', 0.14);
  await tile(192, 'site/icons/icon-192.png', 0.12);
  await tile(512, 'site/icons/icon-512.png', 0.12);
  // maskable needs generous safe-zone padding (bird well inside the 40% safe circle)
  await tile(512, 'site/icons/icon-512-maskable.png', 0.20);

  // Minimal multi-image ICO (PNG payloads: 16 + 32) — accepted by all current browsers.
  const imgs = [];
  for (const s of [16,32]) imgs.push({ size:s, data: fs.readFileSync(`site/icons/favicon-${s}.png`) });
  const header = Buffer.alloc(6); header.writeUInt16LE(0,0); header.writeUInt16LE(1,2); header.writeUInt16LE(imgs.length,4);
  const dir = Buffer.alloc(16*imgs.length);
  let offset = 6 + 16*imgs.length;
  imgs.forEach((im, i) => {
    const o = i*16;
    dir.writeUInt8(im.size>=256?0:im.size, o+0);
    dir.writeUInt8(im.size>=256?0:im.size, o+1);
    dir.writeUInt8(0, o+2); dir.writeUInt8(0, o+3);
    dir.writeUInt16LE(1, o+4); dir.writeUInt16LE(32, o+6);
    dir.writeUInt32LE(im.data.length, o+8); dir.writeUInt32LE(offset, o+12);
    offset += im.data.length;
  });
  fs.writeFileSync('site/icons/favicon.ico', Buffer.concat([header, dir, ...imgs.map(i=>i.data)]));

  for (const f of fs.readdirSync('site/icons')) console.log('  site/icons/'+f, fs.statSync('site/icons/'+f).size, 'bytes');
})();
