// Squeeze screenshots into the smallest lossless PNG (make.fun png-squeeze-01).
// One program answers 8 RGBA screenshots in a single run: it re-encodes each one
// losslessly (every pixel, including the RGB of fully transparent pixels) as the
// smallest valid PNG it can, choosing colour type, palette order and row filters
// per instance, then compressing the filtered bytes with its own optimal-parsing
// deflate encoder (greedy cost-model iterations over an LZ77 token stream, with
// adaptive block splitting and exact dynamic/fixed Huffman choice per block).
// Pure Node built-ins only; fully deterministic: no clock, no environment reads,
// no randomness, every decision a function of the input bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const W = 1280;
const H = 720;

// ---------------------------------------------------------------------------
// Checksums and the PNG container
// ---------------------------------------------------------------------------

const CRC_TAB = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TAB[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ASCII = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ASCII(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// A zlib stream of raw bytes in stored (uncompressed) deflate blocks: the
// always-valid fallback encoding.
function storedZlib(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + 5 * blocks + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const from = k * 65535;
    const len = Math.min(65535, raw.length - from);
    out[at] = k === blocks - 1 ? 1 : 0;
    out[at + 1] = len & 0xff;
    out[at + 2] = len >>> 8;
    out[at + 3] = ~len & 0xff;
    out[at + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(from, from + len), at + 5);
    at += 5 + len;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

// ---------------------------------------------------------------------------
// PNG decoding (the input screenshots and our own outputs for verification)
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIG.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended || at + 12 > bytes.length) return null;
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return null;
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return null;
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null || len !== 13) return null;
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || header.interlace !== 0 || !Object.hasOwn(CHANNELS, header.colourType)) return null;
    } else if (type === 'PLTE') {
      if (palette !== null || header.colourType !== 3 || len === 0 || len % 3 !== 0) return null;
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return null;
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) return null;
      ended = true;
    } else {
      return null;
    }
  }
  if (!ended || !header || idat.length === 0) return null;
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    return null;
  }
  if (raw.length !== expected) return null;
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return null;
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return null;
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: what the pixels hold, and the forms that hold them exactly
// ---------------------------------------------------------------------------

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  const u32 = new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// Every exact form of the image: palette forms first when they apply (a palette
// holds a few-colour image in a third of the bytes of RGB or less), then the
// channel form with the smallest channel count that keeps every pixel exact.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------------------
// Row filters: one pass computes every trial row, then each heuristic picks
// its own winner per row (minimum signed sum, fewest distinct byte pairs,
// entropy cost from a first-pass frequency table); fixed filters are cheap.
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// The filtered data of one form under several filter choices: one pass
// fills the minimum-sum and fewest-pairs choices, and a brute-force pass
// then weighs each row's filter by its real deflate cost.
function filterChoices(samples, width, height, bpp) {
  const stride = width * bpp;
  const size = height * (stride + 1);
  const out = {
    0: new Uint8Array(size),
    minsum: new Uint8Array(size),
    pairs: new Uint8Array(size),
    brute: new Uint8Array(size),
  };
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const bruteRow = new Uint8Array(stride + 1);
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    out[0][at] = 0;
    out[0].set(cur, at + 1);
    let bt = 0;
    let bs = Infinity;
    let pt = 0;
    let ps = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < bs) { bs = s; bt = t; }
      stamp++;
      let pairs = 0;
      for (let i = 1; i < stride; i++) {
        const pair = (trial[t][i - 1] << 8) | trial[t][i];
        if (seen[pair] !== stamp) { seen[pair] = stamp; pairs++; }
      }
      if (pairs < ps) { ps = pairs; pt = t; }
    }
    out.minsum[at] = bt;
    out.minsum.set(trial[bt], at + 1);
    out.pairs[at] = pt;
    out.pairs.set(trial[pt], at + 1);
    // Brute force in the same pass, reusing the filtered rows just
    // computed instead of filtering each row a second time: each row's
    // filter is the one whose level-4 deflate of the row (filter byte
    // included) is shortest, with the last 32 KiB of the rows already
    // chosen as its dictionary. When the two heuristics already agree,
    // the trials add nothing, so the agreed filter is kept directly.
    const before = out.brute.subarray(Math.max(0, at - 32768), at);
    let bbt = bt;
    let bc = Infinity;
    if (bt !== pt) {
      for (let t = 0; t < 5; t++) {
        bruteRow[0] = t;
        bruteRow.set(trial[t], 1);
        const len = before.length === 0
          ? deflateSync(bruteRow, { level: 4, memLevel: 9 }).length
          : deflateSync(bruteRow, { level: 4, memLevel: 9, dictionary: before }).length;
        if (len < bc) { bc = len; bbt = t; }
      }
    }
    out.brute[at] = bbt;
    out.brute.set(trial[bbt], at + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deflate: length and distance code tables, Huffman lengths, bit writing
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function lenSymOf(len) {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function distSymOf(d) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Candidate match lengths for a longest match of length L: every length where
// the length code changes, plus L itself.
const CAND = (() => {
  const bounds = [3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 104, 112, 120, 128, 144, 160, 176, 192, 208, 224, 240, 258];
  const out = new Array(259);
  for (let L = 0; L <= 258; L++) {
    const list = bounds.filter((b) => b <= L);
    if (list[list.length - 1] !== L) list.push(L);
    out[L] = list;
  }
  return out;
})();

// Optimal Huffman code lengths for a frequency table, limited to maxBits.
// The tree is built with two queues; the length limit follows zlib's
// gen_bitlen, whose overflow count covers every node of the tree, leaf or
// internal, that runs deeper than the limit.
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const leaves = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) leaves.push(i);
  leaves.sort((a, b) => freq[a] - freq[b] || a - b);
  const lens = new Uint8Array(n);
  if (leaves.length === 0) return lens;
  if (leaves.length === 1) { lens[leaves[0]] = 1; return lens; }
  const nodes = [];
  let li = 0;
  const intern = [];
  let ii = 0;
  const nextNode = () => {
    let a;
    if (ii < intern.length && (li >= leaves.length || nodes[intern[ii]].f <= freq[leaves[li]])) a = intern[ii++];
    else {
      const s = leaves[li++];
      a = nodes.length;
      nodes.push({ f: freq[s], sym: s, left: -1, right: -1 });
    }
    return a;
  };
  while (true) {
    const a = nextNode();
    const b = nextNode();
    const idx = nodes.length;
    nodes.push({ f: nodes[a].f + nodes[b].f, sym: -1, left: a, right: b });
    if (li >= leaves.length && ii >= intern.length) { intern.push(idx); break; }
    intern.push(idx);
  }
  const root = intern[intern.length - 1];
  let overflow = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [nd, d] = stack.pop();
    const node = nodes[nd];
    if (d > maxBits) overflow++;
    if (node.sym >= 0) lens[node.sym] = d;
    else { stack.push([node.left, d + 1]); stack.push([node.right, d + 1]); }
  }
  const count = new Int32Array(maxBits + 2);
  for (let i = 0; i < n; i++) if (lens[i]) count[Math.min(lens[i], maxBits)]++;
  if (overflow === 0) return lens;
  let ov = overflow;
  do {
    let bits = maxBits - 1;
    while (count[bits] === 0) bits--;
    count[bits]--;
    count[bits + 1] += 2;
    count[maxBits]--;
    ov -= 2;
  } while (ov > 0);
  const syms = leaves.slice().sort((a, b) => freq[b] - freq[a] || a - b);
  let si = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    for (let k = 0; k < count[bits]; k++) lens[syms[si++]] = bits;
  }
  return lens;
}

function canonicalCodes(lens) {
  const n = lens.length;
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (lens[i]) blCount[lens[i]]++;
  const next = new Int32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lens[i];
    if (l) codes[i] = next[l]++;
  }
  return codes;
}

// A Huffman code with a single symbol is incomplete and inflate rejects it,
// so give such an alphabet a dummy second code of length 1.
function ensureTwo(lens) {
  let used = 0;
  let firstZero = -1;
  for (let i = 0; i < lens.length; i++) {
    if (lens[i]) used++;
    else if (firstZero < 0) firstZero = i;
  }
  if (used === 0) lens[0] = 1;
  else if (used === 1 && firstZero >= 0) lens[firstZero] = 1;
}

function revBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

class BitWriter {
  constructor(cap) {
    this.buf = new Uint8Array(cap);
    this.pos = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  write(code, len) {
    this.acc |= code << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  writeRev(code, len) {
    this.write(revBits(code, len), len);
  }
  bytes() {
    if (this.nbits > 0) {
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc = 0;
      this.nbits = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

const FIXED_LIT_LENS = (() => {
  const a = new Uint8Array(288);
  for (let i = 0; i < 144; i++) a[i] = 8;
  for (let i = 144; i < 256; i++) a[i] = 9;
  for (let i = 256; i < 280; i++) a[i] = 7;
  for (let i = 280; i < 288; i++) a[i] = 8;
  return a;
})();
const FIXED_DIST_LENS = new Uint8Array(32).fill(5);

// Bit cost tables from Huffman lengths: literal, match-length and distance
// costs, with unused symbols charged 15 bits so the parser avoids them.
function costTablesFrom(litLens, distLens) {
  const lit = new Float64Array(256);
  for (let i = 0; i < 256; i++) lit[i] = litLens[i] || 15;
  const len = new Float64Array(259);
  for (let L = 3; L <= 258; L++) {
    const s = lenSymOf(L);
    len[L] = (litLens[257 + s] || 15) + LEN_EXT[s];
  }
  const dist = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = distSymOf(d);
    dist[d] = (distLens[s] || 15) + DIST_EXT[s];
  }
  return { lit, len, dist };
}

// ---------------------------------------------------------------------------
// LZ77: longest matches at every position, then optimal parsing by cost
// ---------------------------------------------------------------------------

// The longest match starting at each position, by hash chains over 3-byte
// sequences. Screenshots repeat whole rows, so besides the chains the search
// also tries the same column one to four rows above, distances the chains
// reach only after hundreds of nearer candidates.
function longestMatches(data, maxChain, extraDists) {
  const n = data.length;
  const HSIZE = 1 << 16;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const lens = new Uint16Array(n);
  const dists = new Int32Array(n);
  for (let pos = 0; pos + 3 < n; pos++) {
    const h = ((data[pos] << 8) ^ (data[pos + 1] << 4) ^ data[pos + 2] ^ (data[pos + 3] << 12)) & (HSIZE - 1);
    let cand = head[h];
    let bestLen = 2;
    let bestDist = 0;
    let chain = 0;
    const limit = pos > 32768 ? pos - 32768 : 0;
    const maxPossible = Math.min(258, n - pos);
    while (cand >= limit && chain < maxChain && cand !== -1) {
      chain++;
      if (data[cand + bestLen] === data[pos + bestLen]) {
        let l = 0;
        while (l < maxPossible && data[cand + l] === data[pos + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = pos - cand;
          if (l >= maxPossible) break;
        }
      }
      // A match this long is already near the best the parser can use;
      // walking the rest of the chain for a few more bytes costs more
      // time than those bytes are worth.
      if (bestLen >= 128) break;
      cand = prev[cand];
    }
    // The row-above tries only pay when the chain has not already found a
    // long match: once one reaches 200 bytes the parser is fed either way,
    // and the extra extension loops are pure overhead.
    if (extraDists && bestLen < 200) {
      for (let k = 0; k < extraDists.length; k++) {
        const dd = extraDists[k];
        const c2 = pos - dd;
        if (c2 < limit) continue;
        if (data[c2] !== data[pos] || data[c2 + bestLen] !== data[pos + bestLen]) continue;
        let l = 0;
        while (l < maxPossible && data[c2 + l] === data[pos + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = dd;
          if (l >= maxPossible) break;
        }
      }
    }
    lens[pos] = bestLen;
    dists[pos] = bestDist;
    prev[pos] = head[h];
    head[h] = pos;
  }
  return { lens, dists };
}

// Optimal parsing backwards from the end: at each position the cheapest of
// a literal and every candidate match length at the longest match's distance.
// A longer match wins an exact tie, since it leaves fewer symbols to code.
function dpParse(data, lens, dists, ct) {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  const choiceLen = new Uint16Array(n);
  const choiceDist = new Int32Array(n);
  const lit = ct.lit;
  const lenC = ct.len;
  const distC = ct.dist;
  cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let best = lit[data[i]] + cost[i + 1];
    let bestLen = 0;
    const L = lens[i];
    if (L >= 3) {
      const dc = distC[dists[i]];
      const cands = CAND[L];
      for (let k = 0; k < cands.length; k++) {
        const l = cands[k];
        const c = lenC[l] + dc + cost[i + l];
        if (c < best || (c === best && l > bestLen)) { best = c; bestLen = l; }
      }
    }
    cost[i] = best;
    choiceLen[i] = bestLen;
    if (bestLen) choiceDist[i] = dists[i];
  }
  const isMatch = new Uint8Array(n + 1);
  const v1 = new Int32Array(n + 1);
  const v2 = new Int32Array(n + 1);
  const tpos = new Int32Array(n + 1);
  let ntok = 0;
  let i = 0;
  while (i < n) {
    const l = choiceLen[i];
    if (l >= 3) {
      isMatch[ntok] = 1; v1[ntok] = l; v2[ntok] = choiceDist[i]; tpos[ntok] = i; ntok++; i += l;
    } else {
      isMatch[ntok] = 0; v1[ntok] = data[i]; tpos[ntok] = i; ntok++; i++;
    }
  }
  return {
    isMatch: isMatch.subarray(0, ntok),
    v1: v1.subarray(0, ntok),
    v2: v2.subarray(0, ntok),
    tpos: tpos.subarray(0, ntok),
    ntok,
  };
}

function freqsOfRange(tok, i0, i1) {
  const lf = new Int32Array(288);
  const df = new Int32Array(32);
  for (let i = i0; i < i1; i++) {
    if (tok.isMatch[i]) {
      lf[257 + lenSymOf(tok.v1[i])]++;
      df[distSymOf(tok.v2[i])]++;
    } else lf[tok.v1[i]]++;
  }
  lf[256] = 1;
  return { lf, df };
}

function blockTokenCost(tok, i0, i1, litLens, distLens) {
  let bits = 0;
  for (let i = i0; i < i1; i++) {
    if (tok.isMatch[i]) {
      const s = lenSymOf(tok.v1[i]);
      bits += litLens[257 + s] + LEN_EXT[s];
      const ds = distSymOf(tok.v2[i]);
      bits += distLens[ds] + DIST_EXT[ds];
    } else bits += litLens[tok.v1[i]];
  }
  bits += litLens[256];
  return bits;
}

// The bit cost of a dynamic block's header: the run-length coded lengths.
function dynamicHeaderBits(litLens, distLens) {
  let hlit = 288;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 32;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = [];
  for (let i = 0; i < hlit; i++) seq.push(litLens[i]);
  for (let i = 0; i < hdist; i++) seq.push(distLens[i]);
  const items = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    if (v === 0) {
      let run = 0;
      while (i + run < seq.length && seq[i + run] === 0) run++;
      if (run >= 11) {
        const take = Math.min(run, 138);
        items.push([18, take - 11, 7]);
        i += take;
      } else if (run >= 3) {
        items.push([17, run - 3, 3]);
        i += run;
      } else {
        for (let k = 0; k < run; k++) items.push([0, 0, 0]);
        i += run;
      }
    } else {
      items.push([v, 0, 0]);
      i++;
      let run = 0;
      while (i + run < seq.length && seq[i + run] === v) run++;
      while (run >= 3) {
        const take = Math.min(run, 6);
        items.push([16, take - 3, 2]);
        run -= take;
        i += take;
      }
      while (run > 0) { items.push([v, 0, 0]); run--; i++; }
    }
  }
  const clf = new Int32Array(19);
  for (const [s] of items) clf[s]++;
  const clLens = buildLengths(clf, 7);
  {
    let used = 0;
    for (let j = 0; j < 19; j++) if (clLens[j]) used++;
    if (used === 1) {
      for (let j = 0; j < 19; j++) if (!clLens[j]) { clLens[j] = 1; break; }
    }
  }
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 5 + 5 + 4 + hclen * 3;
  for (const [s, , eb] of items) bits += clLens[s] + eb;
  return { bits, hlit, hdist, hclen, items, clLens };
}

function writeDynamicHeader(w, litLens, distLens, hdr) {
  const { hlit, hdist, hclen, items, clLens } = hdr;
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.write(clLens[CL_ORDER[i]], 3);
  const clCodes = canonicalCodes(clLens);
  for (const [s, ex, eb] of items) {
    w.writeRev(clCodes[s], clLens[s]);
    if (eb) w.write(ex, eb);
  }
}

// The cheapest way to write one token range: dynamic or fixed Huffman.
function rangeBits(tok, i0, i1) {
  const { lf, df } = freqsOfRange(tok, i0, i1);
  const ll = buildLengths(lf, 15);
  const dl = buildLengths(df, 15);
  ensureTwo(ll);
  ensureTwo(dl);
  const hdr = dynamicHeaderBits(ll, dl);
  const dyn = hdr.bits + blockTokenCost(tok, i0, i1, ll, dl);
  const fix = blockTokenCost(tok, i0, i1, FIXED_LIT_LENS, FIXED_DIST_LENS);
  return Math.min(dyn, fix) + 3;
}

// Split a token range in two while the two halves together cost fewer bits
// than the whole, recursing down to a minimum block size in input bytes.
function splitBlocks(tok, dataLen, minBytes) {
  const ranges = [];
  const rec = (i0, i1, b0, b1) => {
    const whole = rangeBits(tok, i0, i1);
    if (b1 - b0 <= minBytes || i1 - i0 < 4) { ranges.push([i0, i1]); return; }
    const midPos = (b0 + b1) >> 1;
    let m = i0;
    while (m < i1 && tok.tpos[m] < midPos) m++;
    if (m <= i0 || m >= i1) { ranges.push([i0, i1]); return; }
    const left = rangeBits(tok, i0, m);
    const right = rangeBits(tok, m, i1);
    if (left + right < whole) {
      rec(i0, m, b0, tok.tpos[m]);
      rec(m, i1, tok.tpos[m], b1);
    } else ranges.push([i0, i1]);
  };
  rec(0, tok.ntok, 0, dataLen);
  return ranges;
}

function emitBlocks(data, tok, ranges) {
  let estBits = 16;
  for (const [i0, i1] of ranges) estBits += rangeBits(tok, i0, i1);
  const w = new BitWriter(Math.ceil(estBits / 8) + 1024);
  w.write(0x78, 8);
  w.write(0x9c, 8);
  for (let bi = 0; bi < ranges.length; bi++) {
    const [i0, i1] = ranges[bi];
    const last = bi === ranges.length - 1 ? 1 : 0;
    const { lf, df } = freqsOfRange(tok, i0, i1);
    const ll = buildLengths(lf, 15);
    const dl = buildLengths(df, 15);
    ensureTwo(ll);
    ensureTwo(dl);
    const hdr = dynamicHeaderBits(ll, dl);
    const dynBits = hdr.bits + blockTokenCost(tok, i0, i1, ll, dl);
    const fixBits = blockTokenCost(tok, i0, i1, FIXED_LIT_LENS, FIXED_DIST_LENS);
    if (dynBits <= fixBits) {
      w.write(last, 1);
      w.write(2, 2);
      writeDynamicHeader(w, ll, dl, hdr);
      const lc = canonicalCodes(ll);
      const dc = canonicalCodes(dl);
      for (let i = i0; i < i1; i++) {
        if (tok.isMatch[i]) {
          const L = tok.v1[i];
          const s = lenSymOf(L);
          w.writeRev(lc[257 + s], ll[257 + s]);
          w.write(L - LEN_BASE[s], LEN_EXT[s]);
          const D = tok.v2[i];
          const ds = distSymOf(D);
          w.writeRev(dc[ds], dl[ds]);
          w.write(D - DIST_BASE[ds], DIST_EXT[ds]);
        } else w.writeRev(lc[tok.v1[i]], ll[tok.v1[i]]);
      }
      w.writeRev(lc[256], ll[256]);
    } else {
      w.write(last, 1);
      w.write(1, 2);
      const lc = canonicalCodes(FIXED_LIT_LENS);
      const dc = canonicalCodes(FIXED_DIST_LENS);
      for (let i = i0; i < i1; i++) {
        if (tok.isMatch[i]) {
          const L = tok.v1[i];
          const s = lenSymOf(L);
          w.writeRev(lc[257 + s], FIXED_LIT_LENS[257 + s]);
          w.write(L - LEN_BASE[s], LEN_EXT[s]);
          const D = tok.v2[i];
          const ds = distSymOf(D);
          w.writeRev(dc[ds], 5);
          w.write(D - DIST_BASE[ds], DIST_EXT[ds]);
        } else w.writeRev(lc[tok.v1[i]], FIXED_LIT_LENS[tok.v1[i]]);
      }
      w.writeRev(lc[256], 7);
    }
  }
  const body = w.bytes();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  const ad = adler32(data);
  out[body.length] = (ad >>> 24) & 0xff;
  out[body.length + 1] = (ad >>> 16) & 0xff;
  out[body.length + 2] = (ad >>> 8) & 0xff;
  out[body.length + 3] = ad & 0xff;
  return out;
}

// The whole custom deflate: match search once, then two optimal-parsing
// passes (first under fixed Huffman costs, then under the costs the first
// pass's tokens imply), adaptive block splitting, and exact emission.
function compressOptimal(data, pitch) {
  const small = data.length <= 1200000;
  // Large streams walk fewer chain candidates: the row-above tries below
  // already cover the matches that matter most on big streams.
  const maxChain = small ? 256 : 64;
  const extra = small
    ? [pitch, 2 * pitch, 3 * pitch, 4 * pitch]
    : [pitch, 2 * pitch];
  const { lens, dists } = longestMatches(data, maxChain, extra);
  // Two cost-model passes everywhere. Large streams still gain a little
  // from further passes, but each extra pass costs seconds and the entry
  // has a 60-second wall for the whole set, so two is the budget.
  const iters = 2;
  let ct = costTablesFrom(FIXED_LIT_LENS, FIXED_DIST_LENS);
  let tok = dpParse(data, lens, dists, ct);
  for (let it = 1; it < iters; it++) {
    const { lf, df } = freqsOfRange(tok, 0, tok.ntok);
    const ll = buildLengths(lf, 15);
    const dl = buildLengths(df, 15);
    ensureTwo(ll);
    ensureTwo(dl);
    ct = costTablesFrom(ll, dl);
    tok = dpParse(data, lens, dists, ct);
  }
  const ranges = splitBlocks(tok, data.length, 16384);
  return emitBlocks(data, tok, ranges);
}

// ---------------------------------------------------------------------------
// One instance: pick the best form and filter, compress, verify, write
// ---------------------------------------------------------------------------

const SCREEN = { level: 6, memLevel: 8, strategy: 0 };

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Compress one screenshot and return its PNG bytes.
function compressImage(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const choices = filterChoices(form.samples, width, height, form.bpp);
    const overhead = chunkOverhead(form);
    for (const name of ['0', 'minsum', 'pairs', 'brute']) {
      const data = choices[name];
      const z = deflateSync(data, SCREEN);
      const bytes = z.length + overhead;
      if (best === null || bytes < best.bytes) {
        best = { form, data, bytes };
      }
    }
  }
  const { form, data } = best;
  const pitch = width * form.bpp + 1;
  const optimal = compressOptimal(data, pitch);
  const z9 = deflateSync(data, { level: 9, memLevel: 8, strategy: 0 });
  const idat = optimal.length <= z9.length ? optimal : new Uint8Array(z9.buffer, z9.byteOffset, z9.length);
  let file = pngOfForm(width, height, form, idat);
  // Verify the file decodes back to exactly these pixels; if anything about
  // the encoding path disagrees, fall back to a stored PNG, which is valid
  // by construction.
  const check = decodePng(file);
  if (check === null || !sameBytes(check.rgba, rgba)) {
    const raw = new Uint8Array(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    file = pngOf([
      ['IHDR', ihdrOf(width, height, 6)],
      ['IDAT', storedZlib(raw)],
      ['IEND', new Uint8Array(0)],
    ]);
  }
  return file;
}

// ---------------------------------------------------------------------------
// Main: one run answers every instance under the input directory
// ---------------------------------------------------------------------------

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (image === null) throw new Error(`${id}/image.png: unreadable`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compressImage(image.rgba, image.width, image.height));
}
