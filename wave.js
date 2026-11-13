// The detail waveform, drawn as the desktop app draws it (app/wave.py: Mixlyzer's RGB style): short frames' thin
// min..max bars coloured by the low / mid / high band levels, two frames to a column, rendered a second at a time
// with 0.2 s of audio around it (the band filters see the neighbours: no seams), from the 22050 Hz mono the engine
// reads. The bands' wide Gaussian smoothing is three box filters here (a drawing: close enough).

// scipy's butter(4, band, "band", output="sos") at 22050 Hz: 20-200, 250-1500, 1600-10804.5 Hz (app/wave.py BANDS)
const SOS = [
  [
    [4.0488148509331036e-7, 8.097629701866207e-7, 4.0488148509331036e-7, 1.0, -1.9183831556613595, 0.920534158346891],
    [1.0, 2.0, 1.0, 1.0, -1.9620270182990998, 0.9650866703830981],
    [1.0, -2.0, 1.0, 1.0, -1.9880227265970545, 0.9880695374811342],
    [1.0, -2.0, 1.0, 1.0, -1.9962659324579628, 0.9962997370797622],
  ],
  [
    [0.000657245376712737, 0.001314490753425474, 0.000657245376712737, 1.0, -1.5143788879059241, 0.5966291141425142],
    [1.0, 2.0, 1.0, 1.0, -1.6430994339118845, 0.7965157551455196],
    [1.0, -2.0, 1.0, 1.0, -1.8508911809168402, 0.859284238079065],
    [1.0, -2.0, 1.0, 1.0, -1.9545987740806807, 0.9598476990221626],
  ],
  [
    [0.5031207515876076, -1.0062415031752152, 0.5031207515876076, 1.0, -1.2696436137927516, 0.41797026198869336],
    [1.0, -2.0, 1.0, 1.0, -1.5384323012398575, 0.7142265952665808],
    [1.0, 2.0, 1.0, 1.0, 1.8854440730587994, 0.8892667542579873],
    [1.0, 2.0, 1.0, 1.0, 1.9496750820024091, 0.9535460670761053],
  ],
];
const FRAMES_PER_COLUMN = 2;
export const CHUNK_SEC = 1.0;
const CONTEXT_SEC = 0.2;
const COLOR_SMOOTH_SEC = 0.05;
const SAT_FLOOR = 0.6;
const CENTER_QUIET = 0.01; // -40 dBFS
const CENTER_RMS_SEC = 0.01;

/** The drawing frame (ms) of a main view ``windowSec`` wide (Mixlyzer's close / short / long views). */
export const frameMsFor = (windowSec) => (windowSec <= 3 ? 0.5 : windowSec <= 9 ? 1 : 2);

/** Zero-phase band filter: the sections forward, then backward (from rest: the context absorbs the edges). */
function filtfilt(x, sos) {
  const y = Float64Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    for (const [b0, b1, b2, , a1, a2] of sos) {
      let z1 = 0;
      let z2 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = y[i];
        const o = b0 * v + z1;
        z1 = b1 * v - a1 * o + z2;
        z2 = b2 * v - a2 * o;
        y[i] = o;
      }
    }
    y.reverse();
  }
  return y;
}

const reflect = (i, n) => {
  // scipy's "reflect" (d c b a | a b c d | d c b a)
  while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
  return i;
};

/** A moving average of width ``w`` (odd), reflected at the ends. */
function box(x, w) {
  const n = x.length;
  const r = w >> 1;
  const out = new Float64Array(n);
  let s = 0;
  for (let k = -r; k <= r; k++) s += x[reflect(k, n)];
  for (let i = 0; i < n; i++) {
    out[i] = s / w;
    s += x[reflect(i + r + 1, n)] - x[reflect(i - r, n)];
  }
  return out;
}

/** A Gaussian of ``sigma`` samples: three box filters of the widths whose variance sums to it. */
function gaussianWide(x, sigma) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  let y = x;
  for (let k = 0; k < 3; k++) y = box(y, k < m ? wl : wu);
  return y;
}

/** Per-column RGB (0-255) from the low / mid / high levels (app/wave.py wave_colors, no white threshold). */
function waveColor(lo, mid, hi) {
  const scale = Math.max(lo, mid, hi, 1e-8);
  let r = lo / scale;
  let g = mid / scale;
  let b = hi / scale;
  const sat = 1 - Math.min(r, g, b);
  if (sat < SAT_FLOOR) {
    const k = SAT_FLOOR / Math.max(sat, 1e-8);
    r = Math.min(1, Math.max(0, 1 - (1 - r) * k));
    g = Math.min(1, Math.max(0, 1 - (1 - g) * k));
    b = Math.min(1, Math.max(0, 1 - (1 - b) * k));
  }
  return [Math.floor(r * 255 + 0.5), Math.floor(g * 255 + 0.5), Math.floor(b * 255 + 0.5)];
}

/** One chunk's image (a canvas, columns x ``height``) and the span it covers (s): app/wave.py render_chunk. */
export function renderChunk(mono, sr, chunk, frameMs, height) {
  const n = mono.length;
  const frameHop = Math.max(1, Math.round(frameMs * 1e-3 * sr));
  const hop = FRAMES_PER_COLUMN * frameHop;
  const total = Math.ceil(n / hop);
  const chunkSamples = Math.round(1.0 * sr);
  const c0 = Math.min(total, Math.floor((chunk * chunkSamples) / hop));
  const end = (chunk + 1) * chunkSamples;
  const c1 = end >= n ? total : Math.min(total, Math.floor(end / hop));
  const start = (c0 * hop) / sr;
  const stop = (c1 * hop) / sr;
  const canvas = document.createElement("canvas");
  if (c1 <= c0) {
    canvas.width = 1;
    canvas.height = height;
    return { canvas, start, end: Math.max(stop, start + 1e-3) };
  }
  const context = Math.ceil((CONTEXT_SEC * sr) / hop);
  const p0 = Math.max(0, c0 - context);
  const seg = mono.subarray(p0 * hop, Math.min(n, (c1 + context) * hop));
  const frames = Math.ceil(seg.length / frameHop);
  const columns = Math.ceil(frames / FRAMES_PER_COLUMN);
  // each band's level per frame: the RMS of its filtered signal, its square smoothed, then its fourth root
  const sigma = (COLOR_SMOOTH_SEC * sr) / frameHop;
  const levels = SOS.map((sos) => {
    const f = filtfilt(seg, sos);
    const ms = new Float64Array(frames);
    for (let k = 0; k < frames; k++) {
      const a = k * frameHop;
      const b = Math.min(seg.length, a + frameHop);
      let s = 0;
      for (let i = a; i < b; i++) s += f[i] * f[i];
      ms[k] = s / (b - a); // the RMS squared
    }
    const smooth = gaussianWide(ms, sigma);
    for (let k = 0; k < frames; k++) smooth[k] = Math.sqrt(Math.sqrt(Math.max(0, smooth[k])));
    return smooth;
  });
  // the frames' bars summed into their columns (area anti-aliasing): a difference array per column
  const H = height;
  const half = H >> 1;
  const acc = new Float64Array(columns * (H + 1) * 3);
  const count = new Float64Array(columns);
  for (let k = 0; k < frames; k++) {
    const a = k * frameHop;
    const b = Math.min(seg.length, a + frameHop);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < b; i++) {
      const v = seg[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const top = Math.min(H - 1, Math.max(0, half - Math.trunc(hi * half)));
    const bottom = Math.min(H - 1, Math.max(0, half - Math.trunc(lo * half)));
    const first = Math.min(top, bottom);
    const last = Math.max(top, bottom);
    const col = Math.floor(k / FRAMES_PER_COLUMN);
    const rgb = waveColor(levels[0][k], levels[1][k], levels[2][k]);
    const base = col * (H + 1);
    for (let c = 0; c < 3; c++) {
      acc[(base + first) * 3 + c] += rgb[c];
      acc[(base + last + 1) * 3 + c] -= rgb[c];
    }
    count[col]++;
  }
  const image = new Float64Array(columns * H * 3); // [column][row][rgb]
  for (let col = 0; col < columns; col++) {
    const base = col * (H + 1);
    const div = Math.max(1, count[col]);
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let y = 0; y < H; y++) {
        s += acc[(base + y) * 3 + c];
        image[(col * H + y) * 3 + c] = s / div;
      }
    }
  }
  // a slight blur across the columns (sigma 0.8, as the desktop's)
  const kernel = [-3, -2, -1, 0, 1, 2, 3].map((d) => Math.exp(-(d * d) / (2 * 0.64)));
  const ksum = kernel.reduce((a, b) => a + b, 0);
  const blurred = new Float64Array(image.length);
  for (let col = 0; col < columns; col++) {
    for (let k = 0; k < 7; k++) {
      const src = reflect(col + k - 3, columns);
      const w = kernel[k] / ksum;
      const from = src * H * 3;
      const to = col * H * 3;
      for (let j = 0; j < H * 3; j++) blurred[to + j] += w * image[from + j];
    }
  }
  // the centre line: white where the column is quiet (its loudest 10 ms under -40 dBFS)
  const win = Math.max(1, Math.round(CENTER_RMS_SEC * sr));
  const prefix = new Float64Array(seg.length + 1);
  for (let i = 0; i < seg.length; i++) prefix[i + 1] = prefix[i] + seg[i] * seg[i];
  const loud = new Float64Array(columns);
  for (let k = 0; k < frames; k++) {
    const centre = Math.min(k * frameHop + (frameHop >> 1), seg.length - 1);
    const a = Math.max(0, centre - (win >> 1));
    const b = Math.min(seg.length, a + win);
    const level = Math.sqrt(Math.max(0, (prefix[b] - prefix[a]) / (b - a)));
    const col = Math.floor(k / FRAMES_PER_COLUMN);
    if (level > loud[col]) loud[col] = level;
  }
  const from = c0 - p0;
  const width = c1 - c0;
  canvas.width = width;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const data = g.createImageData(width, H);
  for (let x = 0; x < width; x++) {
    const col = from + x;
    const alpha = Math.min(1, Math.max(0, 1 - loud[col] / CENTER_QUIET));
    for (let y = 0; y < H; y++) {
      const i = (col * H + y) * 3;
      let r = blurred[i];
      let gg = blurred[i + 1];
      let b = blurred[i + 2];
      if (y === half) {
        r += alpha * (255 - r);
        gg += alpha * (255 - gg);
        b += alpha * (255 - b);
      }
      const o = (y * width + x) * 4;
      data.data[o] = r;
      data.data[o + 1] = gg;
      data.data[o + 2] = b;
      data.data[o + 3] = 255;
    }
  }
  g.putImageData(data, 0, 0);
  return { canvas, start, end: stop };
}
