// The page: a song and its lyrics in, the song decoded here (the browser's decoder, mono at 22050 Hz for the
// engine), the engine run in a worker, the lyrics shown over the playing song (each character filled as it is sung,
// or lit a character at a time) and written out as files. The song plays through Web Audio, so the clicks (each
// mora's first sound, a line's first a fifth up, as the desktop app's) are scheduled on the music's own clock.

import { apply, LANGS, t } from "./i18n.js?v=454e48567f22";
import { ass, lineEnd, lineStart, lrcKaraoke, lrcLines, position, srt, stamp, tagsOf, units, wipe } from "./lyrics.js?v=454e48567f22";
import { MainView } from "./mainview.js?v=454e48567f22";
import { dictionary, storeDictionary } from "./store.js?v=454e48567f22";

const $ = (id) => document.getElementById(id);

for (const [code, name] of LANGS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost";
  b.dataset.lang = code;
  b.textContent = name;
  b.addEventListener("click", () => {
    apply(code, true);
    updatePlay();
    dictNote();
  });
  $("langs").appendChild(b);
}
apply();
const RATE = 22050;
const WEIGHTS = { decode: 0.08, read: 0.17, spectra: 0.3, vocal: 0.35, align: 0.1 };
const ORDER = ["decode", "read", "spectra", "vocal", "align"];
const ACCENT = 2 ** (7 / 12);

let song = null; // File
let result = null; // the engine's alignment
let lines = []; // its lines: wipe segments, start, end, each character's start
let lyricsSource = "";
let monoPcm = null; // the song at 22050 Hz, mono: the main view's waveform, the scratch's record
let scrubbing = false; // the overview or the position bar dragged (Mixlyzer's scrub: the clicks muted)
let scratch = null; // the main view held: {wasPlaying, t} (Mixlyzer's scratch: the record under the hand)
let realigning = false;

const stored = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: not kept */
  }
};
let mode = stored("voasync.mode", "fill");
let clicksOn = stored("voasync.click", "0") === "1";

// ---- inputs --------------------------------------------------------------------------------------------------

function setSong(file) {
  if (!file) return;
  song = file;
  delete $("songName").dataset.i18n; // the file's name now, in any language
  $("songName").textContent = file.name;
  $("songDrop").classList.add("has-file");
  update();
}

function update() {
  $("start").disabled = !(song && $("lyricsText").value.trim());
}

$("songInput").addEventListener("change", (e) => setSong(e.target.files[0]));
const drop = $("songDrop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const files = [...e.dataTransfer.files];
  const audio = files.find((f) => !/\.(lrc|txt)$/i.test(f.name));
  const text = files.find((f) => /\.(lrc|txt)$/i.test(f.name));
  if (audio) setSong(audio);
  if (text) readLyrics(text);
});
document.body.addEventListener("dragover", (e) => e.preventDefault());
document.body.addEventListener("drop", (e) => e.preventDefault());

async function readLyrics(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // not UTF-8: a Japanese or Korean file of the old code pages
    const ja = new TextDecoder("shift_jis").decode(buf);
    const ko = new TextDecoder("euc-kr").decode(buf);
    const bad = (s) => (s.match(/�/g) || []).length;
    text = bad(ja) <= bad(ko) ? ja : ko;
  }
  $("lyricsText").value = text.replace(/^﻿/, "");
  $("lyricsInfo").textContent = file.name;
  update();
  dictNote();
}

$("lyricsOpen").addEventListener("click", () => $("lyricsInput").click());
$("lyricsInput").addEventListener("change", (e) => e.target.files[0] && readLyrics(e.target.files[0]));
$("lyricsText").addEventListener("input", () => {
  update();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(dictNote, 300);
});
let noteTimer = 0;

// ---- the player ----------------------------------------------------------------------------------------------

let ac = null;
let music = null;
let clickOut = null;
let buffer = null; // the song at the context's rate
let clickBuf = null;
let source = null;
let startedAt = 0; // the context time of the song's 0 while playing
let pausedAt = 0;
let playing = false;
let onsets = []; // [{t, accent}] in time order
let nextClick = 0;
let scheduled = [];
let timer = null;

function context() {
  if (!ac) {
    ac = new AudioContext();
    music = ac.createGain();
    music.connect(ac.destination);
    clickOut = ac.createGain();
    clickOut.gain.value = 0.6;
    clickOut.connect(ac.destination);
    fetch("click.wav")
      .then((r) => r.arrayBuffer())
      .then((b) => ac.decodeAudioData(b))
      .then((b) => (clickBuf = b))
      .catch(() => {});
  }
  return ac;
}

const duration = () => (buffer ? buffer.duration : result ? result.duration : 0);
const clock = () => (playing ? ac.currentTime - startedAt : pausedAt);

/** The song's time now heard (the clock less the output's latency). */
function heard() {
  if (scratch) return scratch.t;
  if (!playing) return pausedAt;
  return Math.max(0, clock() - (ac.outputLatency || 0) - (ac.baseLatency || 0));
}

function firstOnset(t) {
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function schedule() {
  if (!playing || !clicksOn || !clickBuf || scrubbing) return;
  const horizon = clock() + 0.25;
  while (nextClick < onsets.length && onsets[nextClick].t < horizon) {
    const o = onsets[nextClick++];
    const when = startedAt + o.t;
    if (when < ac.currentTime) continue;
    const s = ac.createBufferSource();
    s.buffer = clickBuf;
    if (o.accent) s.playbackRate.value = ACCENT;
    const g = ac.createGain();
    g.gain.value = o.accent ? 1 : 0.75;
    s.connect(g).connect(clickOut);
    s.start(when);
    scheduled.push(s);
    s.onended = () => (scheduled = scheduled.filter((x) => x !== s));
  }
}

function cancelClicks() {
  for (const s of scheduled) {
    try {
      s.stop();
    } catch {
      /* already over */
    }
  }
  scheduled = [];
}

function stopSource() {
  const s = source;
  source = null;
  if (s) {
    s.onended = null;
    try {
      s.stop();
    } catch {
      /* already over */
    }
  }
  clearInterval(timer);
  timer = null;
  cancelClicks();
}

function play() {
  if (!buffer || playing) return;
  ac.resume();
  if (pausedAt >= buffer.duration - 0.05) pausedAt = 0;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.connect(music);
  const at = ac.currentTime + 0.05; // a moment for the first clicks to be scheduled
  src.start(at, pausedAt);
  startedAt = at - pausedAt;
  src.onended = () => {
    if (source !== src) return;
    playing = false;
    pausedAt = buffer.duration;
    stopSource();
    updatePlay();
  };
  source = src;
  playing = true;
  nextClick = firstOnset(pausedAt);
  timer = setInterval(schedule, 25);
  schedule();
  updatePlay();
}

function pause() {
  if (!playing) return;
  pausedAt = Math.min(clock(), duration());
  playing = false;
  stopSource();
  updatePlay();
}

function seek(t) {
  const was = playing;
  if (playing) {
    playing = false;
    stopSource();
  }
  pausedAt = Math.max(0, Math.min(t, duration()));
  if (was) play();
  else updatePlay();
}

function updatePlay() {
  $("play").textContent = playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", t(playing ? "pause" : "play"));
}

/** m:ss.mmm */
function mmss(t) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

// ---- scrub (the overview, the position bar) and scratch (the main view) ------------------------------------------

function scrubBegin() {
  scrubbing = true;
  cancelClicks();
}

function scrubEnd() {
  if (!scrubbing) return;
  scrubbing = false;
  if (playing) {
    nextClick = firstOnset(clock());
    schedule();
  }
}

let scratchNode = null;
let scratchReady = null;

/** The scratch's worklet, once per audio context (none where the browser has no AudioWorklet: a silent scratch). */
function scratchSetup() {
  if (!scratchReady) {
    scratchReady = context()
      .audioWorklet.addModule("scratch.js?v=454e48567f22")
      .then(() => {
        scratchNode = new AudioWorkletNode(ac, "scratch", { numberOfInputs: 0, outputChannelCount: [2] });
        scratchNode.connect(music);
      })
      .catch(() => (scratchNode = null));
  }
  return scratchReady;
}

/** Now on the output's clock (s): the time a sample played now is heard. */
function outputTime() {
  const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
  if (ts && ts.performanceTime) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  return ac.currentTime - (ac.outputLatency || 0) - (ac.baseLatency || 0);
}

function scratchBegin(secPerPx) {
  if (!buffer) return;
  const t = heard();
  scratch = { wasPlaying: playing, t };
  if (playing) {
    playing = false;
    stopSource();
  }
  pausedAt = t;
  ac.resume();
  const latency = (ac.baseLatency || 0) + (ac.outputLatency || 0);
  scratchNode?.port.postMessage({ type: "begin", pos: t * RATE, at: outputTime(), latency, pixel: secPerPx * RATE });
}

function scratchMove(t) {
  if (!scratch) return;
  scratch.t = t;
  scratchNode?.port.postMessage({ type: "to", pos: t * RATE, at: outputTime() });
}

function scratchEnd(t) {
  if (!scratch) return;
  scratchNode?.port.postMessage({ type: "end" });
  const was = scratch.wasPlaying;
  scratch = null;
  pausedAt = Math.max(0, Math.min(t, duration()));
  if (was) play();
  else updatePlay();
}

const view = new MainView($("mainCanvas"), {
  windowSec: +stored("voasync.window", "6"),
  onScratchBegin: scratchBegin,
  onScratchMove: scratchMove,
  onScratchEnd: scratchEnd,
});
view.onWindow = (sec) => store("voasync.window", String(sec));

let dragging = false;
$("play").addEventListener("click", () => (playing ? pause() : play()));
$("seek").addEventListener("pointerdown", () => {
  dragging = true;
  scrubBegin();
});
$("seek").addEventListener("pointerup", () => {
  dragging = false;
  scrubEnd();
});
$("seek").addEventListener("input", (e) => seek(+e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || $("result").hidden || /^(TEXTAREA|INPUT|BUTTON)$/.test(e.target.tagName)) return;
  e.preventDefault();
  playing ? pause() : play();
});

function setMode(m) {
  mode = m;
  store("voasync.mode", m);
  for (const b of $("mode").children) b.classList.toggle("on", b.dataset.mode === m);
  $("karaoke").className = `karaoke ${m}-mode`;
  shown = -2;
}

function setClicks(on) {
  clicksOn = on;
  store("voasync.click", on ? "1" : "0");
  $("click").setAttribute("aria-pressed", String(on));
  cancelClicks();
  if (playing) {
    nextClick = firstOnset(clock());
    schedule();
  }
}

for (const b of $("mode").children) b.addEventListener("click", () => setMode(b.dataset.mode));
$("click").addEventListener("click", () => setClicks(!clicksOn));

// ---- running -------------------------------------------------------------------------------------------------

let progressAt = {};

/** A stage's progress: decoding and reading the lyrics run side by side; the analysis' stages after both. */
function progress(stage, fraction) {
  progressAt[stage] = Math.max(progressAt[stage] || 0, Math.min(1, fraction));
  if (ORDER.indexOf(stage) > ORDER.indexOf("read")) {
    for (const s of ORDER.slice(0, ORDER.indexOf(stage))) progressAt[s] = 1;
  }
  let total = 0;
  for (const s of ORDER) total += WEIGHTS[s] * (progressAt[s] || 0);
  $("progressFill").style.width = `${(total * 100).toFixed(1)}%`;
  for (const li of $("stages").children) {
    const f = progressAt[li.dataset.stage] || 0;
    li.className = f >= 1 ? "done" : f > 0 || li.dataset.stage === stage ? "active" : "";
  }
}

async function decodeMono(bytes) {
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const audio = await ctx.decodeAudioData(bytes);
  const a = audio.getChannelData(0);
  if (audio.numberOfChannels < 2) return new Float32Array(a);
  const b = audio.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

function showError(message) {
  $("error").hidden = false;
  $("error").textContent = message;
  $("progress").hidden = true;
  $("inputs").hidden = false;
}

let worker = null;
let storing = false;

/** The whole dictionary kept on the device, in the background (once: later songs fetch none of it). */
function storeInBackground() {
  if (storing) return;
  storing = true;
  storeDictionary()
    .then(() => dictNote())
    .catch(() => {})
    .finally(() => (storing = false));
}

async function start() {
  context().resume(); // within the click: the browser lets the page's audio start
  pause();
  $("error").hidden = true;
  $("result").hidden = true;
  $("inputs").hidden = true;
  $("progress").hidden = false;
  progressAt = {};
  progress("decode", 0);
  lyricsSource = $("lyricsText").value;
  if (!worker) worker = new Worker("worker.js?v=454e48567f22", { type: "module" });
  let playback;
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "progress") progress(m.stage, m.fraction);
    else if (m.type === "read") {
      if (m.japanese) storeInBackground(); // while the song is analysed
    } else if (m.type === "done" && realigning) {
      realigning = false;
      $("realign").disabled = false;
      show(m.result, true);
    } else if (m.type === "error" && realigning) {
      realigning = false;
      $("realign").disabled = false;
      $("editNote").textContent = m.message === "E_NO_LINES" ? t("errNoLines") : `${t("errAlign")}: ${m.message}`;
    } else if (m.type === "done") {
      console.debug("voasync steps (ms)", JSON.stringify(m.times));
      progress("align", 1);
      try {
        buffer = await playback;
      } catch (err) {
        showError(`${t("errSong")}: ${err.message || err}`);
        return;
      }
      show(m.result);
    } else if (m.type === "error") showError(m.message === "E_NO_LINES" ? t("errNoLines") : `${t("errAlign")}: ${m.message}`);
  };
  worker.onerror = (e) => showError(`${t("errEngine")}: ${e.message}`);
  // the lyrics read (their dictionary fetched) while the song is decoded here
  worker.postMessage({ type: "lyrics", lyrics: lyricsSource });
  let pcm;
  try {
    const bytes = await song.arrayBuffer();
    playback = ac.decodeAudioData(bytes.slice(0));
    pcm = await decodeMono(bytes);
  } catch (e) {
    showError(`${t("errSong")}: ${e.message || e}`);
    return;
  }
  progress("decode", 1);
  monoPcm = pcm;
  const copy = pcm.slice();
  worker.postMessage({ type: "audio", pcm: copy }, [copy.buffer]);
}

const JAPANESE = /[぀-ヿ㐀-鿿]/;

/** The note under the start button: the dictionary to be fetched once, for Japanese lyrics. */
async function dictNote() {
  const note = $("dictNote");
  if (!JAPANESE.test($("lyricsText").value)) {
    note.hidden = true;
    return;
  }
  try {
    const d = await dictionary();
    note.hidden = !d.storable || d.stored;
    note.textContent = t("dictNote").replace("{mb}", String(Math.round(d.bytes / 1e6)));
  } catch {
    note.hidden = true;
  }
}

$("start").addEventListener("click", start);
$("again").addEventListener("click", () => {
  pause();
  $("result").hidden = true;
  $("progress").hidden = true;
  $("inputs").hidden = false;
  document.querySelector(".lyrics").appendChild($("lyricsText"));
  $("editNote").textContent = "";
});

// ---- the result ----------------------------------------------------------------------------------------------

let shown = -2;
let nowSpans = [];
let nowState = [];
let nowRuby = []; // the current line's reading spans (a mora each)
let rubyState = [];

const KANJI = /[⺀-⿟㐀-鿿豈-﫿々〆ヶ]/;

/** A line's characters as spans, a kanji word's reading above it (ruby) a span per mora: [chars, ruby], each
 * ruby span with its mora's index. */
function renderLine(el, line) {
  el.textContent = "";
  const chars = Array.from(line.text);
  const groups = new Map(); // first char -> [end, first mora, mora after the last]
  for (let i = 0; i < line.moras.length; ) {
    const [a, b] = line.moras[i].span;
    let j = i;
    while (j < line.moras.length && line.moras[j].span[0] === a && line.moras[j].span[1] === b) j++;
    const read = line.moras.slice(i, j).some((m) => m.label !== "＊"); // a wildcard: no reading to show
    if (read && KANJI.test(chars.slice(a, b).join(""))) groups.set(a, [b, i, j]);
    i = j;
  }
  const spans = [];
  const ruby = [];
  const charSpan = (ch) => {
    const s = document.createElement("span");
    s.className = "ch";
    s.textContent = ch;
    spans.push(s);
    return s;
  };
  for (let c = 0; c < chars.length; ) {
    const g = groups.get(c);
    if (!g) {
      el.appendChild(charSpan(chars[c++]));
      continue;
    }
    const r = document.createElement("ruby");
    for (; c < g[0]; c++) r.appendChild(charSpan(chars[c]));
    const rt = document.createElement("rt");
    for (let m = g[1]; m < g[2]; m++) {
      const s = document.createElement("span");
      s.className = "ch";
      s.textContent = line.moras[m].label;
      s.dataset.mora = String(m);
      rt.appendChild(s);
      ruby.push(s);
    }
    r.appendChild(rt);
    el.appendChild(r);
  }
  return [spans, ruby];
}

/** Each character's start and its unit's index (a karaoke unit: a character, or the characters of one mora). */
function charTimes(line) {
  const starts = [];
  const unit = [];
  units(line).forEach((u, k) => {
    for (const _ of Array.from(u.text)) {
      starts.push(u.start);
      unit.push(k);
    }
  });
  return { starts, unit };
}

function lineAt(t) {
  let k = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= t + 0.05) k = i;
    else break;
  }
  return k;
}

function frame() {
  if (!$("result").hidden && lines.length) {
    const t = heard();
    const k = lineAt(t);
    const current = Math.max(k, 0);
    const line = lines[current];
    if (current !== shown) {
      shown = current;
      $("kPrev").textContent = current > 0 ? lines[current - 1].text : "";
      [nowSpans, nowRuby] = renderLine($("kNow"), line);
      nowState = nowSpans.map(() => "");
      rubyState = nowRuby.map(() => "");
      $("kNext").textContent = lines[current + 1]?.text ?? "";
      $("kNext2").textContent = lines[current + 2]?.text ?? "";
    }
    if (mode === "fill") {
      const x = k < 0 ? 0 : position(line.segs, t);
      for (let c = 0; c < nowSpans.length; c++) {
        const p = Math.max(0, Math.min(1, x - c)).toFixed(3);
        if (nowState[c] !== p) nowSpans[c].style.setProperty("--p", (nowState[c] = p));
      }
      // a reading's mora filled as the wipe crosses its share of the word's characters
      for (let r = 0; r < nowRuby.length; r++) {
        const [, , p0, p1] = line.segs[+nowRuby[r].dataset.mora];
        const f = p1 > p0 ? (x - p0) / (p1 - p0) : x >= p1 ? 1 : 0;
        const p = Math.max(0, Math.min(1, f)).toFixed(3);
        if (rubyState[r] !== p) nowRuby[r].style.setProperty("--p", (rubyState[r] = p));
      }
    } else {
      const { starts, unit } = line.chars;
      let cur = -1;
      if (k >= 0 && t < line.end) for (let c = 0; c < starts.length; c++) if (starts[c] <= t) cur = unit[c];
      for (let c = 0; c < nowSpans.length; c++) {
        const state = k < 0 || starts[c] > t ? "" : unit[c] === cur ? "cur" : "sung";
        if (nowState[c] !== state) nowSpans[c].className = `ch ${(nowState[c] = state)}`;
      }
      // a reading's moras lit as they start, the sounding one boxed
      let sounding = -1;
      if (k >= 0 && t < line.end) for (let m = 0; m < line.segs.length; m++) if (line.segs[m][0] <= t) sounding = m;
      for (let r = 0; r < nowRuby.length; r++) {
        const m = +nowRuby[r].dataset.mora;
        const state = k < 0 || line.segs[m][0] > t ? "" : m === sounding ? "cur" : "sung";
        if (rubyState[r] !== state) nowRuby[r].className = `ch ${(rubyState[r] = state)}`;
      }
    }
    if (!dragging) $("seek").value = String(t);
    $("time").textContent = mmss(t);
    drawCursor(t);
    view.draw(t);
  }
  requestAnimationFrame(frame);
}

function drawActivity() {
  const cv = $("activityCanvas");
  const w = (cv.width = cv.clientWidth * devicePixelRatio);
  const h = (cv.height = cv.clientHeight * devicePixelRatio);
  const g = cv.getContext("2d");
  g.clearRect(0, 0, w, h);
  const act = result.activity;
  g.fillStyle = "#234a72";
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * act.length);
    const b = Math.max(a + 1, Math.floor(((x + 1) / w) * act.length));
    let m = 0;
    for (let i = a; i < b; i++) m = Math.max(m, act[i]);
    g.fillRect(x, h * (1 - m), 1, h * m);
  }
  g.fillStyle = "#ffb000";
  for (const line of lines) g.fillRect((line.start / duration()) * w, 0, Math.max(1, devicePixelRatio), h * 0.35);
  cv._base = g.getImageData(0, 0, w, h);
}

function drawCursor(t) {
  const cv = $("activityCanvas");
  if (!cv._base) return;
  const g = cv.getContext("2d");
  g.putImageData(cv._base, 0, 0);
  const x = (s) => (s / duration()) * cv.width;
  g.strokeStyle = "rgba(255, 255, 255, 0.35)";
  g.lineWidth = Math.max(1, devicePixelRatio);
  g.strokeRect(x(t - view.windowSec / 2), 0.5, Math.max(2, x(view.windowSec) - x(0)), cv.height - 1);
  g.fillStyle = "#ffffff";
  g.fillRect(x(t), 0, Math.max(1, devicePixelRatio), cv.height);
}

// a line or a character pressed: the song a second before it (as the desktop app's karaoke)
const jump = (t) => seek(Math.max(0, t - 1));
for (const [id, offset] of [["kPrev", -1], ["kNext", 1], ["kNext2", 2]]) {
  $(id).addEventListener("click", () => {
    if (!lines[shown + offset]) return;
    toLine(shown + offset);
    jump(lines[shown + offset].start);
  });
}
$("kNow").addEventListener("click", (e) => {
  const line = lines[shown];
  if (!line) return;
  toLine(shown);
  const c = nowSpans.indexOf(e.target);
  const m = e.target.dataset?.mora;
  jump(m !== undefined ? line.segs[+m][0] : c >= 0 ? line.chars.starts[c] : line.start);
});

const overviewAt = (e) => {
  const r = $("activity").getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration();
};
$("activity").addEventListener("pointerdown", (e) => {
  if (!result || e.button !== 0) return;
  $("activity").setPointerCapture(e.pointerId);
  scrubBegin();
  seek(overviewAt(e));
});
$("activity").addEventListener("pointermove", (e) => scrubbing && seek(overviewAt(e)));
$("activity").addEventListener("pointerup", scrubEnd);
$("activity").addEventListener("pointercancel", scrubEnd);

function show(res, again = false) {
  result = res;
  lines = res.lines.map((l) => {
    const line = { ...l, segs: wipe(l), start: lineStart(l), end: lineEnd(l) };
    line.chars = charTimes(line);
    return line;
  });
  onsets = lines.flatMap((l) => l.moras.map((m, i) => ({ t: m.cons ?? m.start, accent: i === 0 })));
  onsets.sort((a, b) => a.t - b.t);
  if (!again) {
    pausedAt = 0;
    view.setTrack(monoPcm, RATE, duration());
    scratchSetup().then(() => scratchNode?.port.postMessage({ type: "load", pcm: monoPcm, rate: RATE }));
  }
  view.setLyrics(lines, res.activity, res.hop);
  $("progress").hidden = true;
  $("result").hidden = false;
  if ($("lyricsText").parentElement !== $("editWrap")) $("editWrap").appendChild($("lyricsText")); // kept where it is
  paintEditor();
  $("seek").max = String(duration());
  $("duration").textContent = mmss(duration());
  shown = -2;
  setMode(mode);
  setClicks(clicksOn);
  updatePlay();
  drawActivity();
}

// ---- the lyrics edited over the result: a line marked at the time heard, then aligned again ----------------------

const bodyOf = (raw) =>
  raw
    .replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, "")
    .replace(/<\d+:\d+(?:[.:]\d+)?>/g, "")
    .trim();

/** Each shown line's row in the editor (the lyrics' order; a text met again, its next row). */
function sourceRows() {
  const rows = $("lyricsText").value.split("\n").map(bodyOf);
  const out = [];
  let from = 0;
  for (const l of lines) {
    let i = rows.indexOf(l.text, from);
    if (i < 0) i = rows.indexOf(l.text);
    out.push(i);
    if (i >= 0) from = i + 1;
  }
  return out;
}

const caretRow = () => {
  const ta = $("lyricsText");
  return ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
};

let painted = "";

/** The editor's backdrop: its rows as the textarea lays them out, the caret's row highlighted (and outlined in the
 * main view). */
function paintEditor() {
  const ta = $("lyricsText");
  const back = $("editBack");
  if (ta.parentElement !== $("editWrap")) return;
  const at = caretRow();
  const key = `${at}\u0000${ta.clientWidth}\u0000${ta.value}`;
  if (key !== painted) {
    painted = key;
    back.replaceChildren(
      ...ta.value.split("\n").map((r, i) => {
        const d = document.createElement("div");
        d.textContent = r || "\u00a0";
        if (i === at) d.className = "at";
        return d;
      }),
    );
    view.focusLine = sourceRows().indexOf(at);
  }
  back.style.width = `${ta.clientWidth}px`;
  back.style.height = `${ta.clientHeight}px`;
  back.scrollTop = ta.scrollTop;
}

/** The caret to an editor row's start, the row scrolled into sight. */
function caretTo(i) {
  const ta = $("lyricsText");
  const rows = ta.value.split("\n");
  let pos = 0;
  for (let k = 0; k < i && k < rows.length; k++) pos += rows[k].length + 1;
  ta.setSelectionRange(pos, pos);
  paintEditor();
  const row = $("editBack").children[i];
  if (row && (row.offsetTop < ta.scrollTop || row.offsetTop + row.offsetHeight > ta.scrollTop + ta.clientHeight)) {
    ta.scrollTop = row.offsetTop - ta.clientHeight / 3;
    paintEditor();
  }
}

/** The caret to a shown line's row. */
function toLine(k) {
  const i = sourceRows()[k];
  if (i >= 0) caretTo(i);
}

/** The caret's line stamped with the time heard (its stamps before replaced); the caret on to the next line. */
function markLine() {
  const ta = $("lyricsText");
  const text = ta.value;
  const pos = ta.selectionStart;
  const a = text.lastIndexOf("\n", pos - 1) + 1;
  let b = text.indexOf("\n", pos);
  if (b < 0) b = text.length;
  const body = text.slice(a, b).replace(/^(\s*\[\d+:\d+(?:[.:]\d+)?\])+\s*/, "");
  const line = `[${stamp(heard())}]${body}`;
  ta.setRangeText(line, a, b, "end");
  const v = ta.value;
  let next = a + line.length + 1;
  while (next < v.length) {
    const e = v.indexOf("\n", next);
    if (v.slice(next, e < 0 ? v.length : e).trim()) break;
    if (e < 0) next = v.length;
    else next = e + 1;
  }
  next = Math.min(next, v.length);
  caretTo(v.slice(0, next).split("\n").length - 1);
}

function realign() {
  if (!worker || !result || realigning) return;
  realigning = true;
  $("realign").disabled = true;
  $("editNote").textContent = "";
  lyricsSource = $("lyricsText").value;
  worker.postMessage({ type: "realign", lyrics: lyricsSource });
}

$("mark").addEventListener("click", markLine);
$("toLine").addEventListener("click", () => toLine(Math.max(0, shown)));
$("realign").addEventListener("click", realign);
// over the result, anywhere: Ctrl+Enter a marker, Ctrl+Shift+Enter the caret to the line shown
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || $("result").hidden) return;
  e.preventDefault();
  if (e.shiftKey) toLine(Math.max(0, shown));
  else markLine();
});
for (const type of ["input", "keyup", "click", "select", "scroll"]) $("lyricsText").addEventListener(type, paintEditor);
document.addEventListener("selectionchange", () => document.activeElement === $("lyricsText") && paintEditor());
new ResizeObserver(() => paintEditor()).observe($("lyricsText"));

function baseName() {
  return song ? song.name.replace(/\.[^.]+$/, "") : "lyrics";
}

function meta() {
  const tags = tagsOf(lyricsSource);
  return { title: tags.title || baseName(), artist: tags.artist, album: tags.album, duration: duration() };
}

function save(text, name) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

for (const b of document.querySelectorAll("[data-file]")) {
  b.addEventListener("click", () => {
    if (!result) return;
    const base = baseName();
    const files = {
      karaoke: () => save(lrcKaraoke(lines, meta()), `${base}.lrc`),
      lines: () => save(lrcLines(lines, meta()), `${base} (${t("linesSuffix")}).lrc`),
      ass: () => save(ass(lines, meta()), `${base}.ass`),
      srt: () => save(srt(lines), `${base}.srt`),
    };
    files[b.dataset.file]();
  });
}

window.addEventListener("resize", () => result && drawActivity());

if (location.protocol === "file:") {
  showError(t("errFile"));
}

requestAnimationFrame(frame);
