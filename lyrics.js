// The aligned lyrics as karaoke: each line's wipe over its own characters (the moras' times spread over the
// characters each is sung on), and the files written from it: the karaoke LRC (Enhanced LRC: a stamp before each
// character, a kanji word's characters timed through its moras, the line's end stamped), the plain LRC (a line each),
// ASS (\kf karaoke, for video) and SRT. UTF-8 without BOM, LF; stamps rounded to centiseconds first.

/** A line's wipe: segments [t0, t1, p0, p1] (the wipe at position p0 at t0, p1 at t1; positions are characters). */
export function wipe(line) {
  const segs = [];
  const moras = line.moras;
  let i = 0;
  let reach = 0;
  while (i < moras.length) {
    const [a, b] = moras[i].span;
    let j = i;
    while (j < moras.length && moras[j].span[0] === a && moras[j].span[1] === b) j++;
    const k = j - i;
    for (let q = 0; q < k; q++) {
      const m = moras[i + q];
      const onset = m.cons ?? m.start;
      const p0 = Math.max(reach, a + ((b - a) * q) / k);
      const p1 = Math.max(p0, a + ((b - a) * (q + 1)) / k);
      segs.push([onset, Math.max(onset, m.end), p0, p1]);
      reach = p1;
    }
    i = j;
  }
  return segs;
}

/** The wipe's position (characters) at time t. */
export function position(segs, t) {
  let x = 0;
  for (const [t0, t1, p0, p1] of segs) {
    if (t < t0) break;
    x = t >= t1 || t1 <= t0 ? p1 : p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
  }
  return x;
}

/** The time the wipe reaches position c. */
export function reaches(segs, c) {
  for (const [t0, t1, p0, p1] of segs) {
    if (p1 <= c && !(p0 >= c)) continue;
    if (p0 >= c || p1 <= p0) return t0;
    return t0 + ((c - p0) / (p1 - p0)) * (t1 - t0);
  }
  return segs.length ? segs[segs.length - 1][1] : 0;
}

export function lineStart(line) {
  const m = line.moras[0];
  return m.cons ?? m.start;
}

export function lineEnd(line) {
  return line.moras[line.moras.length - 1].end;
}

/** A line's karaoke units: {text, start}. A mora sung on several characters (きゃ, an English syllable) is one unit;
 * a word whose moras share its characters (a kanji word) a unit per character; the characters no mora is sung on
 * (spaces, punctuation) go with the unit before them (the first unit's, at the line's start). */
export function units(line) {
  const chars = Array.from(line.text);
  const segs = wipe(line);
  const starts = new Map(); // char index -> its unit's end (exclusive)
  const moras = line.moras;
  let i = 0;
  while (i < moras.length) {
    const [a, b] = moras[i].span;
    let j = i;
    while (j < moras.length && moras[j].span[0] === a && moras[j].span[1] === b) j++;
    if (j - i === 1 || b - a <= 1) {
      if (!starts.has(a)) starts.set(a, Math.max(b, a + 1));
    } else {
      for (let c = a; c < b; c++) if (!starts.has(c)) starts.set(c, c + 1);
    }
    i = j;
  }
  const order = [...starts.keys()].sort((x, y) => x - y);
  const out = [];
  if (!order.length) return [{ text: line.text, start: lineStart(line) }];
  for (let u = 0; u < order.length; u++) {
    const from = u === 0 ? 0 : order[u];
    const to = u + 1 < order.length ? order[u + 1] : chars.length;
    out.push({ text: chars.slice(from, to).join(""), start: reaches(segs, order[u]) });
  }
  for (let u = 1; u < out.length; u++) out[u].start = Math.max(out[u].start, out[u - 1].start);
  return out;
}

const cs = (t) => Math.max(0, Math.round(t * 100));

/** [mm:ss.xx] (minutes past 99 written whole). */
export function stamp(t) {
  const c = cs(t);
  const m = Math.floor(c / 6000);
  const s = Math.floor((c % 6000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`;
}

function header(meta) {
  const rows = [];
  if (meta.title) rows.push(`[ti:${meta.title}]`);
  if (meta.artist) rows.push(`[ar:${meta.artist}]`);
  if (meta.album) rows.push(`[al:${meta.album}]`);
  if (meta.duration) rows.push(`[length:${stamp(meta.duration).slice(0, 5)}]`);
  rows.push("[re:VoAsync]");
  return rows;
}

/** Each line's start, made strictly increasing (a player reads two lines of one stamp as text and translation). */
function starts(lines) {
  const out = [];
  let last = -1;
  for (const line of lines) {
    let c = cs(lineStart(line));
    if (c <= last) c = last + 1;
    out.push(c / 100);
    last = c;
  }
  return out;
}

const GAP = 4.0; // a blank stamp after a line followed by this long a silence (and after the last)

function blankAfter(lines, k, begins) {
  const end = lineEnd(lines[k]);
  const next = k + 1 < lines.length ? begins[k + 1] : Infinity;
  return next - end >= GAP ? `[${stamp(end)}]` : null;
}

export function lrcLines(lines, meta = {}) {
  const begins = starts(lines);
  const rows = header(meta);
  lines.forEach((line, k) => {
    rows.push(`[${stamp(begins[k])}]${line.text}`);
    const blank = blankAfter(lines, k, begins);
    if (blank) rows.push(blank);
  });
  return rows.join("\n") + "\n";
}

export function lrcKaraoke(lines, meta = {}) {
  const begins = starts(lines);
  const rows = header(meta);
  lines.forEach((line, k) => {
    const us = units(line);
    us[0].start = begins[k];
    let text = `[${stamp(begins[k])}]`;
    let last = begins[k];
    for (const u of us) {
      last = Math.max(last, u.start);
      text += `<${stamp(last)}>${u.text}`;
    }
    text += `<${stamp(Math.max(last, lineEnd(line)))}>`;
    rows.push(text);
    const blank = blankAfter(lines, k, begins);
    if (blank) rows.push(blank);
  });
  return rows.join("\n") + "\n";
}

function assTime(t) {
  const c = cs(t);
  const h = Math.floor(c / 360000);
  const m = Math.floor((c % 360000) / 6000);
  const s = Math.floor((c % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`;
}

const assText = (s) => s.replace(/\\/g, "＼").replace(/\{/g, "（").replace(/\}/g, "）");

export function ass(lines, meta = {}) {
  const rows = [
    "[Script Info]",
    `Title: ${meta.title || "VoAsync"}`,
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, " +
      "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, " +
      "MarginR, MarginV, Encoding",
    "Style: Default,Noto Sans CJK JP,72,&H0000B0FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2," +
      "60,60,80,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const begins = starts(lines);
  lines.forEach((line, k) => {
    const us = units(line);
    us[0].start = begins[k];
    const end = Math.max(lineEnd(line), begins[k] + 0.01);
    let text = "";
    for (let u = 0; u < us.length; u++) {
      const a = cs(Math.max(us[u].start, begins[k]));
      const b = cs(u + 1 < us.length ? Math.max(us[u + 1].start, us[u].start) : end);
      text += `{\\kf${Math.max(0, b - a)}}${assText(us[u].text)}`;
    }
    rows.push(`Dialogue: 0,${assTime(begins[k])},${assTime(end)},Default,,0,0,0,,${text}`);
  });
  return rows.join("\n") + "\n";
}

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (v, n) => String(v).padStart(n, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

export function srt(lines) {
  const begins = starts(lines);
  return (
    lines
      .map((line, k) => `${k + 1}\n${srtTime(begins[k])} --> ${srtTime(Math.max(lineEnd(line), begins[k] + 0.01))}\n${line.text}\n`)
      .join("\n") + ""
  );
}

/** The lyrics' own tags ([ti:] [ar:] [al:]) when they are an LRC. */
export function tagsOf(text) {
  const meta = {};
  for (const m of text.matchAll(/^\s*\[(ti|ar|al):([^\]]*)\]\s*$/gim)) {
    const key = { ti: "title", ar: "artist", al: "album" }[m[1].toLowerCase()];
    if (m[2].trim()) meta[key] = m[2].trim();
  }
  return meta;
}
