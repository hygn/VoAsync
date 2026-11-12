// The engine (voasync.wasm) in a worker of its own. The page hands it the lyrics first ("lyrics": read while the page
// decodes the song; Japanese: the dictionary's pieces of the lyrics' words, from the browser's cache or fetched),
// then the decoded mix ("audio": analysed and aligned); it reports its progress and hands back the alignment. The
// analysis' heavy parts (REPET's background, the vocal network) run on helper workers, a frame range each, as many as
// the device has cores for (alone where there are none).

import { gz } from "./store.js";
import { compile, instantiate } from "./wasm.js";

let module = null; // the compiled engine, shared with the helpers
let engine = null;
let modelBytes = null;
let prepared = null; // the lyrics' reading (a promise)
const enc = new TextEncoder();
const STAGES = { 1: "spectra", 2: "vocal", 4: "align" };
const times = {}; // each step's end (ms since the lyrics came), handed back with the result
let t0 = 0;
const mark = (name) => (times[name] = Math.round(performance.now() - t0));

function post(stage, fraction) {
  postMessage({ type: "progress", stage, fraction });
}

/** Fetches many files, several at a time, each handed to ``use`` as it arrives. */
async function fetchAll(paths, use, onCount) {
  let next = 0;
  let done = 0;
  const one = async () => {
    while (next < paths.length) {
      const i = next++;
      use(i, await gz(paths[i]));
      onCount(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, one));
}

/** The lyrics read (the engine, the model, the Japanese dictionary's pieces): whether they hold Japanese. */
async function prepare(lyrics) {
  if (!engine) {
    module = await compile();
    engine = await instantiate(module, (stage, f) => post(STAGES[stage] || "align", f));
    const [net, templates] = await Promise.all([gz("model.bin"), gz("templates.bin")]);
    engine.call("cmd_model", net);
    engine.call("cmd_templates", templates);
    modelBytes = net;
    startHelpers(); // their instances made while the lyrics are read
  }
  const need = JSON.parse(engine.call("cmd_lyrics", enc.encode(lyrics)));
  if (!need.rows) throw new Error("E_NO_LINES"); // the page words it
  post("read", 0.05);
  if (need.english) engine.call("cmd_english", await gz("en.tsv"));
  if (need.japanese) {
    const [pos, meta, index, rows] = await Promise.all(
      ["ja/pos.tsv", "ja/meta.tsv", "ja/lex/index.tsv", "ja/conn/rows.bin"].map(gz),
    );
    engine.call("cmd_ja_meta", pos, meta, index, rows);
    // the lexicon's files, then the matrix rows' files their words need ("core" or a number each)
    const packs = JSON.parse(engine.call("cmd_ja_packs"));
    await fetchAll(
      packs.map((name) => `ja/lex/${name}.tsv`),
      (i, bytes) => engine.call("cmd_ja_pack", i, bytes),
      (k) => post("read", 0.05 + (0.55 * k) / packs.length),
    );
    const files = JSON.parse(engine.call("cmd_ja_rows"));
    await fetchAll(
      files.map((name) => `ja/conn/${name}.bin`),
      (_i, bytes) => engine.call("cmd_ja_row", bytes),
      (k) => post("read", 0.6 + (0.35 * k) / files.length),
    );
    engine.call("cmd_ja_read");
  }
  post("read", 1);
  mark("read");
  postMessage({ type: "read", japanese: !!need.japanese });
}

// ---- the helpers ------------------------------------------------------------------------------------------------

class Helper {
  constructor() {
    this.worker = new Worker("helper.js", { type: "module" });
    this.next = 0;
    this.waiting = new Map();
    this.worker.onmessage = (e) => {
      const { id, out, error } = e.data;
      const p = this.waiting.get(id);
      this.waiting.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(out);
    };
    this.worker.onerror = (e) => {
      for (const p of this.waiting.values()) p.reject(new Error(e.message || "helper failed"));
      this.waiting.clear();
    };
  }

  ask(msg, transfer = []) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
}

let helpers = null; // a promise: the helpers ready, or none (the engine alone)

function startHelpers() {
  helpers ??= (async () => {
    const n = Math.min(8, (navigator.hardwareConcurrency || 2) - 1);
    if (n < 2 || typeof Worker === "undefined") return [];
    try {
      const hs = Array.from({ length: n }, () => new Helper());
      await Promise.all(hs.map((h) => h.ask({ type: "init", module, model: modelBytes })));
      return hs;
    } catch {
      return [];
    }
  })();
  return helpers;
}

/** [from, to) ranges of the frames, ``k`` of them. */
function ranges(frames, k) {
  const out = [];
  for (let i = 0; i < k; i++) {
    const a = Math.floor((frames * i) / k);
    const b = Math.floor((frames * (i + 1)) / k);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Each job run by the next free helper. */
async function spread(hs, jobs, run) {
  let next = 0;
  await Promise.all(
    hs.map(async (h) => {
      while (next < jobs.length) await run(h, jobs[next++]);
    }),
  );
}

/** The mix analysed: on the helpers (REPET and the network by frame ranges), else by the engine alone. */
async function analyse(pcm) {
  const hs = await startHelpers();
  times.helpers = hs.length;
  mark("helpers");
  if (!hs.length) {
    engine.samples("cmd_audio", pcm);
    return;
  }
  const { frames } = JSON.parse(engine.samples("cmd_spectra_start", pcm));
  mark("stft");
  const input = engine.bytes("cmd_repet_input");
  await Promise.all(hs.map((h) => h.ask({ type: "repet-load", input })));
  const rs = ranges(frames, hs.length * 3);
  let done = 0;
  await spread(hs, rs, async (h, [a, b]) => {
    engine.call("cmd_repet_put", a, b, await h.ask({ type: "repet", from: a, to: b }));
    post("spectra", 0.3 + (0.7 * ++done) / rs.length);
  });
  mark("repet");
  engine.call("cmd_spectra_finish");
  const ns = ranges(frames, hs.length);
  done = 0;
  await spread(hs, ns, async (h, [a, b]) => {
    const slice = engine.bytes("cmd_net_slice", a, b);
    engine.call("cmd_net_put", a, b, await h.ask({ type: "net", slice }, [slice.buffer]));
    post("vocal", ++done / ns.length);
  });
  mark("net");
  engine.call("cmd_audio_finish");
  mark("analysis");
}

const fail = (err) => postMessage({ type: "error", message: String(err && err.message ? err.message : err) });

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "lyrics") {
    t0 = performance.now();
    prepared = prepare(m.lyrics);
    prepared.catch(fail);
  } else if (m.type === "audio") {
    try {
      await prepared;
    } catch {
      return; // told already
    }
    try {
      mark("audio");
      await analyse(m.pcm);
      post("align", 0);
      const result = JSON.parse(engine.call("cmd_align"));
      mark("align");
      postMessage({ type: "done", result, times });
    } catch (err) {
      fail(err);
    }
  }
};
