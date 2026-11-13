// A helper of the engine's worker: an instance of the same module computing frame ranges (REPET's background, the
// network's outputs) while the others compute theirs. Each message answered with its id (and its bytes, or an error).

import { instantiate } from "./wasm.js?v=454e48567f22";

let engine = null;

onmessage = async (msg) => {
  const m = msg.data;
  try {
    if (m.type === "init") {
      engine = await instantiate(m.module);
      engine.call("cmd_model", m.model);
      // a short silent slice through the network first: the browser optimizes its functions while the song's
      // spectra are made, not while the song's slice runs
      const t = 64;
      const warm = new Uint8Array(20 + 2 * 96 * t * 4);
      const v = new DataView(warm.buffer);
      [0, t, 2, 96, t].forEach((x, i) => v.setUint32(i * 4, x, true));
      engine.bytes("cmd_net_run", warm);
      postMessage({ id: m.id });
    } else if (m.type === "repet-load") {
      engine.call("cmd_repet_load", m.input);
      postMessage({ id: m.id });
    } else if (m.type === "repet") {
      const out = engine.bytes("cmd_repet", m.from, m.to);
      postMessage({ id: m.id, out }, [out.buffer]);
    } else if (m.type === "net") {
      const out = engine.bytes("cmd_net_run", m.slice);
      postMessage({ id: m.id, out }, [out.buffer]);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message ? err.message : err) });
  }
};
