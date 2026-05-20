// Placeholder PWA / push notification icons.
// Generates valid PNGs from scratch using only Node built-ins (zlib).
// Re-run with `node tools/gen-icons.js` after replacing the design.
//
// Output:  monitor/client/public/{icon-192,icon-512,apple-touch-icon,icon-badge}.png

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = zlib.crc32(Buffer.concat([typeBytes, data]))
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0)
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf])
}

function makePNG(width, height, draw) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = draw(x, y, width)
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8 bits per channel
  ihdr[9] = 6 // RGBA
  // bytes 10..12 default to 0 — compression / filter / interlace
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Rounded-square emerald icon on the app's dark background. Plus a small
// "fill bar" near the bottom to evoke the vault meter motif.
function appIcon(size) {
  const bg = [15, 17, 21, 255]        // base-bg #0f1115
  const fg = [16, 185, 129, 255]      // emerald-500
  const accent = [5, 150, 105, 255]   // emerald-600
  const cx = size / 2, cy = size / 2
  const r = size * 0.42
  const cornerR = size * 0.18
  const barY0 = cy + r * 0.4
  const barY1 = cy + r * 0.7
  const barX0 = cx - r * 0.6
  const barX1 = cx + r * 0.6 * 0.35   // ~35% fill
  return (x, y) => {
    const ax = Math.abs(x - cx) - (r - cornerR)
    const ay = Math.abs(y - cy) - (r - cornerR)
    const inSquare =
      Math.abs(x - cx) <= r &&
      Math.abs(y - cy) <= r &&
      (ax <= 0 || ay <= 0 || ax * ax + ay * ay <= cornerR * cornerR)
    if (!inSquare) return bg
    if (x >= barX0 && x <= barX0 + r * 1.2 && y >= barY0 && y <= barY1) {
      // bar track
      if (x <= barX1) return [255, 255, 255, 255] // filled portion
      return accent // empty portion
    }
    return fg
  }
}

// Monochrome white circle on transparent — Android tints it from theme_color.
function badge(size) {
  const cx = size / 2, cy = size / 2
  const r = size * 0.45
  return (x, y) => {
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy)
    if (d2 <= r * r) return [255, 255, 255, 255]
    return [0, 0, 0, 0]
  }
}

const out = path.join(__dirname, '..', 'monitor', 'client', 'public')
const targets = [
  ['icon-192.png', 192, appIcon(192)],
  ['icon-512.png', 512, appIcon(512)],
  ['apple-touch-icon.png', 180, appIcon(180)],
  ['icon-badge.png', 96, badge(96)]
]
for (const [name, size, draw] of targets) {
  fs.writeFileSync(path.join(out, name), makePNG(size, size, draw))
  console.log(`wrote ${name}  ${size}x${size}`)
}
