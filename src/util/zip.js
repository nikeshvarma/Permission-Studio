'use strict';
// A small zip writer (deflate, no dependencies): builds the .vsix, and .xlsx files for exports.
const zlib = require('zlib');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** [[name, Buffer|string]] → a zip as a Buffer. `compressed` (name → deflated bytes) skips compressing those again. */
function zip(entries, compressed) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = []; const central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8'); const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = (compressed && compressed.get(name)) || zlib.deflateRawSync(raw, { level: 9 }); const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, n, comp); central.push(cen, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cd, end]));
}

/**
 * The same zip, compressed without blocking: each file is deflated asynchronously (at a normal
 * level) so a large export doesn't freeze VS Code's extension host. Same bytes layout as zip().
 */
async function zipAsync(entries) {
  const deflate = (buf, opts) => new Promise((res, rej) => zlib.deflateRaw(buf, opts, (e, out) => e ? rej(e) : res(out)));
  const ready = [];
  for (const [name, data] of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    ready.push([name, raw, await deflate(raw, { level: 6 })]);
  }
  return zip(ready.map(([name, raw]) => [name, raw]), new Map(ready.map(([name, , comp]) => [name, comp])));
}

module.exports = { zip, zipAsync, crc32 };
