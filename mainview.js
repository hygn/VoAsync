// The main view, as the desktop app's (app/views.py MainView, after Mixlyzer's): around the playhead (in the middle)
// a ruler, the detail waveform (a second a chunk, drawn by the engine's worker: engine/src/wave.rs, asked for nearest
// the playhead first, a few at a time), the vocal activity, the moras (the consonant hatched, the vowel filled, the one sounding amber) and the
// lines; the lyrics' own line times (an LRC's) dashed. The left edge on whole pixels, so everything moves together.
// The wheel steps the width; held and dragged, the record is under the hand (a scratch, Mixlyzer's main view).

const CHUNK_SEC = 1;
/** The drawing frame (ms) of a view ``windowSec`` wide (Mixlyzer's close / short / long views). */
const frameMsFor = (windowSec) => (windowSec <= 3 ? 0.5 : windowSec <= 9 ? 1 : 2);
const MAX_DPR = 2; // a phone's 3x drawn at 2x: less to fill each frame
const ASKED = 4; // chunks asked of the worker at once

const WINDOWS = [1, 3, 6, 9, 12, 24];
const RULER_H = 18;
const DETAIL_H = 96;
const ACT_H = 5;
const MORA_H = 40;
const LINE_H = 22;
const GAP = 4;
export const VIEW_HEIGHT = RULER_H + DETAIL_H + ACT_H + GAP + MORA_H + GAP + LINE_H + GAP;
const PLAYHEAD = "rgb(255, 200, 50)";
const KEEP_SEC = 60;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hatch(color, dpr) {
  const s = Math.max(4, Math.round(6 * dpr));
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  for (const o of [-s, 0, s]) {
    g.moveTo(o, s);
    g.lineTo(o + s, 0);
  }
  g.stroke();
  return c;
}

export class MainView {
  constructor(canvas, { onScratchBegin, onScratchMove, onScratchEnd, requestChunk, windowSec }) {
    this.canvas = canvas;
    this.requestChunk = requestChunk;
    this.inflight = new Set();
    this.gen = 0;
    this.version = 0; // bumped by whatever changes the picture but the time
    this.drawn = "";
    this.g = canvas.getContext("2d");
    this.windowSec = windowSec >= WINDOWS[0] && windowSec <= WINDOWS[WINDOWS.length - 1] ? windowSec : 6;
    this.pinch = null;
    this.onWindow = null;
    this.duration = 0;
    this.cache = new Map();
    this.moras = [];
    this.lines = [];
    this.act = null;
    this.hop = 0;
    this.grab = null;
    this.focusLine = -1; // the editor's caret line, outlined
    this.elided = new Map();
    this.accent = css("--accent") || "#1f7fe5";
    this.font = css("--font") || "sans-serif";
    this.dim = css("--text-dim") || "#8a8a8a";
    this.text = css("--text") || "#d8d8d8";
    this.separator = css("--separator") || "#232323";
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.duration) return;
        e.preventDefault();
        // a step closer in (up) or further out (down), from the steps around the width (a pinch's may lie between)
        const next =
          e.deltaY < 0
            ? ([...WINDOWS].reverse().find((w) => w < this.windowSec - 1e-6) ?? WINDOWS[0])
            : (WINDOWS.find((w) => w > this.windowSec + 1e-6) ?? WINDOWS[WINDOWS.length - 1]);
        this.setWindow(next);
      },
      { passive: false },
    );
    // the mouse held: a scratch at once (Mixlyzer's); a finger: once it has moved TOUCH_SLOP px (a second finger
    // first: a pinch, no scratch); two fingers: a pinch (apart, closer in; together, further out)
    const TOUCH_SLOP = 6;
    const touches = new Map(); // pointer id -> its x, y
    const spread = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const endScratch = (x) => {
      const g = this.grab;
      this.grab = null;
      if (g?.started) onScratchEnd(Math.max(0, Math.min(this.duration, g.t - (x - g.x) * g.secPerPx)));
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.duration) return;
      canvas.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        endScratch(this.grab?.last ?? 0);
        this.pinch = { spread: Math.max(1, spread()), windowSec: this.windowSec };
        return;
      }
      if (touches.size > 2 || this.pinch) return;
      const secPerPx = this.windowSec / canvas.clientWidth;
      const started = e.pointerType !== "touch";
      this.grab = { x: e.clientX, last: e.clientX, id: e.pointerId, t: this.t ?? 0, secPerPx, started };
      if (started) onScratchBegin(secPerPx);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.grab;
      if (this.pinch && touches.size === 2) {
        this.setWindow((this.pinch.windowSec * this.pinch.spread) / Math.max(1, spread()));
      } else if (g && e.pointerId === g.id) {
        if (!g.started) {
          if (Math.abs(e.clientX - g.x) < TOUCH_SLOP) return;
          g.started = true;
          g.x = e.clientX; // the record taken from here: no jump by the slop
          g.t = this.t ?? g.t;
          onScratchBegin(g.secPerPx);
        }
        g.last = e.clientX;
        onScratchMove(this.handAt(e.clientX));
      }
    });
    const release = (e) => {
      touches.delete(e.pointerId);
      if (this.pinch) {
        if (!touches.size) this.pinch = null; // once all are lifted, the next touch scratches again
        return;
      }
      if (this.grab && e.pointerId === this.grab.id) endScratch(e.clientX);
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  /** The view's width (s): 1-24, a wheel's step or anything between (a pinch). */
  setWindow(sec) {
    const w = Math.max(WINDOWS[0], Math.min(WINDOWS[WINDOWS.length - 1], sec));
    if (w === this.windowSec) return;
    this.windowSec = w;
    this.onWindow?.(Math.round(w * 100) / 100);
  }

  /** The time under the hand: the record moves with it (dragged right, the song goes back). */
  handAt(x) {
    const t = this.grab.t - (x - this.grab.x) * this.grab.secPerPx;
    return Math.max(0, Math.min(this.duration, t));
  }

  setTrack(duration) {
    this.duration = duration;
    this.gen++;
    this.cache.clear();
    this.inflight.clear();
    this.version++;
  }

  /** A chunk drawn by the worker: {key, start, end, width, height, rgba} (or {key, failed}). */
  putChunk(m) {
    if (!this.inflight.delete(m.key)) return; // another song's
    let canvas = null;
    if (!m.failed && m.width) {
      canvas = document.createElement("canvas");
      canvas.width = m.width;
      canvas.height = m.height;
      canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(m.rgba.buffer), m.width, m.height), 0, 0);
    }
    this.cache.set(m.key, { canvas, start: m.start, end: m.end });
    this.version++;
  }

  /** The alignment: its lines (each with moras {label, cons, start, end} and its own time ``at``), the activity. */
  setLyrics(lines, activity, hop) {
    this.lines = lines.map((l) => ({ text: l.text, at: l.at, start: l.start, end: l.end }));
    this.moras = [];
    lines.forEach((l, k) =>
      l.moras.forEach((m) =>
        this.moras.push({ onset: m.cons ?? m.start, start: m.start, end: m.end, label: m.label, cons: m.cons != null, line: k }),
      ),
    );
    this.hop = hop;
    this.version++;
    this.elided.clear();
    const n = activity.length;
    this.act = null;
    if (n) {
      const c = document.createElement("canvas");
      c.width = n;
      c.height = 1;
      const g = c.getContext("2d");
      const img = g.createImageData(n, 1);
      const [r, gg, b] = this.rgb(this.accent);
      for (let i = 0; i < n; i++) {
        img.data.set([r, gg, b, Math.round(Math.max(0, Math.min(1, activity[i])) * 255)], i * 4);
      }
      g.putImageData(img, 0, 0);
      this.act = c;
    }
  }

  rgb(color) {
    const c = document.createElement("canvas").getContext("2d");
    c.fillStyle = color;
    const hex = c.fillStyle;
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }

  fit() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(VIEW_HEIGHT * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.elided.clear();
    }
    if (this.dpr !== dpr) {
      this.dpr = dpr;
      this.hatchAccent = this.g.createPattern(hatch(this.accent, dpr), "repeat");
      this.hatchOn = this.g.createPattern(hatch(PLAYHEAD, dpr), "repeat");
      this.cache.clear();
    }
    return dpr;
  }

  /** The chunks seen that have come (those missing asked for, nearest the playhead first, then a view ahead). */
  chunks(frameMs, left, right, t, height) {
    const last = Math.max(0, Math.ceil(this.duration / CHUNK_SEC) - 1);
    const want = [];
    const lo = Math.max(0, Math.floor(left / CHUNK_SEC));
    const hi = Math.min(last, Math.floor(right / CHUNK_SEC));
    for (let c = lo; c <= hi; c++) want.push(c);
    const seen = new Set(want);
    const ahead = [];
    for (let c = hi + 1; c <= Math.min(last, Math.floor((right + this.windowSec) / CHUNK_SEC)); c++) ahead.push(c);
    const key = (c) => `${this.gen}|${frameMs}|${height}|${c}`;
    const missing = want
      .sort((a, b) => Math.abs(a + 0.5 - t) - Math.abs(b + 0.5 - t))
      .concat(ahead)
      .filter((c) => !this.cache.has(key(c)) && !this.inflight.has(key(c)));
    for (const c of missing) {
      if (this.inflight.size >= ASKED || !this.requestChunk) break;
      this.inflight.add(key(c));
      this.requestChunk({ key: key(c), chunk: c, frameMs, height });
    }
    if (this.cache.size > 4 * (want.length + ahead.length) + 16) {
      for (const k of [...this.cache.keys()]) {
        const [, ms, h, c] = k.split("|");
        if (+ms !== frameMs || +h !== height || Math.abs(+c - t) > KEEP_SEC) this.cache.delete(k);
      }
    }
    return [...seen].map((c) => this.cache.get(key(c))).filter((ch) => ch?.canvas);
  }

  elide(k, text, width) {
    const key = `${k}|${Math.round(width)}`;
    let got = this.elided.get(key);
    if (got !== undefined) return got;
    const g = this.g;
    got = text;
    if (g.measureText(text).width > width) {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (g.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
        else hi = mid - 1;
      }
      got = lo ? `${text.slice(0, lo)}…` : "";
    }
    this.elided.set(key, got);
    return got;
  }

  draw(t) {
    this.t = t;
    const dpr = this.fit();
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // nothing changed (paused, nothing come): the picture stays
    const state = `${t}|${this.windowSec}|${W}|${this.focusLine}|${this.version}|${this.inflight.size}`;
    if (state === this.drawn) return;
    this.drawn = state;
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    if (!this.duration) return;
    const px = this.windowSec / W; // seconds per device pixel
    const left = Math.round((t - this.windowSec / 2) / px) * px;
    const right = left + this.windowSec;
    const leftPx = Math.round(left / px);
    const x = (s) => s / px - leftPx;
    const d = (v) => Math.round(v * dpr);
    // the ruler: a tick a second, a label every one or two
    const step = this.windowSec <= 9 ? 1 : 2;
    g.fillStyle = this.dim;
    g.font = `${d(11)}px ${this.font}`;
    g.textBaseline = "alphabetic";
    for (let s = Math.max(0, Math.floor(left)); s <= Math.ceil(right); s++) {
      const xs = Math.round(x(s));
      const tick = s % step === 0 ? d(6) : d(3);
      g.fillRect(xs, d(RULER_H) - tick, Math.max(1, d(1)), tick);
      if (s % step === 0) g.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, xs + d(3), d(12));
    }
    // the waveform
    const yWave = d(RULER_H);
    const hWave = d(DETAIL_H);
    {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      for (const ch of this.chunks(frameMsFor(this.windowSec), left, right, t, hWave)) {
        const a = Math.round(ch.start / px) - leftPx;
        const b = Math.round(ch.end / px) - leftPx;
        g.drawImage(ch.canvas, a, yWave, Math.max(1, b - a), hWave);
      }
    }
    // the lanes
    const yAct = yWave + hWave;
    const yMora = yAct + d(ACT_H + GAP);
    const yLine = yMora + d(MORA_H + GAP);
    if (this.act && this.hop) {
      const n = this.act.width;
      const c0 = Math.max(0, Math.floor(left / this.hop));
      const c1 = Math.min(n, Math.ceil(right / this.hop) + 1);
      if (c1 > c0) g.drawImage(this.act, c0, 0, c1 - c0, 1, x(c0 * this.hop), yAct, ((c1 - c0) * this.hop) / px, d(ACT_H));
    }
    this.drawLines(t, left, right, x, yLine, d);
    this.drawMoras(t, left, right, x, yMora, d);
    // the lyrics' own line times (an LRC's), dashed
    g.strokeStyle = "rgba(230, 230, 230, 0.6)";
    g.lineWidth = Math.max(1, d(1));
    g.setLineDash([d(4), d(2)]);
    g.beginPath();
    for (const l of this.lines) {
      if (l.at == null || l.at < left - 1 || l.at > right + 1) continue;
      const xr = Math.floor(x(l.at)) + 0.5;
      g.moveTo(xr, yMora - d(2));
      g.lineTo(xr, H);
    }
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = PLAYHEAD;
    g.fillRect(Math.round(x(t)) - d(1), 0, Math.max(2, d(2)), H);
  }

  drawLines(t, left, right, x, y, d) {
    const g = this.g;
    const h = d(LINE_H);
    let current = -1;
    for (let k = 0; k < this.lines.length; k++) if (this.lines[k].start <= t + 0.25) current = k;
    g.font = `${d(11)}px ${this.font}`;
    g.textBaseline = "middle";
    for (let k = 0; k < this.lines.length; k++) {
      const l = this.lines[k];
      if (l.end < left || l.start > right) continue;
      const a = x(l.start);
      const w = Math.max(1, x(l.end) - a);
      g.fillStyle = this.separator;
      g.fillRect(a, y, w, h);
      if (k === current) {
        g.globalAlpha = 110 / 255;
        g.fillStyle = this.accent;
        g.fillRect(a, y, w, h);
        g.globalAlpha = 1;
      }
      g.fillStyle = k === current ? this.text : this.dim;
      const text = this.elide(k, l.text, Math.max(0, w - d(8)));
      if (text) g.fillText(text, a + d(4), y + h / 2);
      if (k === this.focusLine) {
        const lw = Math.max(1, d(1));
        g.strokeStyle = "#ffffff";
        g.lineWidth = lw;
        g.strokeRect(a + lw / 2, y + lw / 2, w - lw, h - lw);
      }
    }
  }

  drawMoras(t, left, right, x, y, d) {
    const g = this.g;
    const h = d(MORA_H);
    const ms = this.moras;
    let sounding = -1;
    for (let i = 0; i < ms.length && ms[i].onset <= t; i++) if (t < ms[i].end) sounding = i;
    g.font = `bold ${d(14)}px ${this.font}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let lo = 0;
    let hi = ms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ms[mid].end < left) lo = mid + 1;
      else hi = mid;
    }
    for (let i = Math.max(0, lo - 2); i < ms.length && ms[i].onset <= right; i++) {
      const m = ms[i];
      if (m.end < left) continue;
      const on = i === sounding && t >= m.start;
      const consOn = i === sounding && !on;
      if (m.cons) {
        const a = x(m.onset) + 0.5;
        const w = Math.max(1, x(m.start) - x(m.onset) - 1);
        g.fillStyle = "#000";
        g.fillRect(a, y, w, h);
        g.fillStyle = on || consOn ? this.hatchOn : this.hatchAccent;
        g.fillRect(a, y, w, h);
      }
      g.fillStyle = on ? PLAYHEAD : this.accent;
      g.globalAlpha = on ? 1 : m.line % 2 === 1 ? 170 / 255 : 230 / 255;
      const a = x(m.start) + 0.5;
      const w = Math.max(1, x(m.end) - x(m.start) - 1);
      g.beginPath();
      if (g.roundRect) g.roundRect(a, y, w, h, d(2));
      else g.rect(a, y, w, h);
      g.fill();
      g.globalAlpha = 1;
      const span = x(m.end) - x(m.onset);
      if (span >= g.measureText(m.label).width + 2) {
        g.fillStyle = on ? "#000" : consOn ? PLAYHEAD : "#fff";
        g.fillText(m.label, x(m.onset) + span / 2, y + h / 2);
      }
    }
    g.textAlign = "start";
  }
}
