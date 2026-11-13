// The engine's module (voasync.wasm: compiled once, handed to the helper workers) and its commands, called with
// numbers and byte buffers (Uint8Array, copied in and freed after); a command's output its bytes (JSON or binary).

export async function compile() {
  try {
    return await WebAssembly.compileStreaming(fetch("voasync.wasm?v=454e48567f22"));
  } catch {
    return WebAssembly.compile(await (await fetch("voasync.wasm?v=454e48567f22")).arrayBuffer());
  }
}

export async function instantiate(module, progress = () => {}) {
  const ex = (await WebAssembly.instantiate(module, { env: { progress } })).exports;
  const dec = new TextDecoder();
  const output = () => new Uint8Array(ex.memory.buffer, ex.out_ptr(), ex.out_len()).slice();
  const run = (name, args) => {
    const flat = [];
    const owned = [];
    for (const a of args) {
      if (a instanceof Uint8Array) {
        const p = ex.alloc(a.length);
        new Uint8Array(ex.memory.buffer, p, a.length).set(a);
        owned.push([p, a.length]);
        flat.push(p, a.length);
      } else flat.push(a);
    }
    const ok = ex[name](...flat);
    const out = output();
    for (const [p, n] of owned) ex.dealloc(p, n);
    if (!ok) throw new Error(dec.decode(out));
    return out;
  };
  /** A command taking float32 samples (4-byte aligned in the module's memory). */
  const samples = (name, pcm) => {
    const n = pcm.length;
    const p = ex.alloc(n * 4 + 4);
    const at = (p + 3) & ~3;
    new Float32Array(ex.memory.buffer, at, n).set(pcm);
    try {
      const ok = ex[name](at, n);
      const out = output();
      if (!ok) throw new Error(dec.decode(out));
      return dec.decode(out);
    } finally {
      ex.dealloc(p, n * 4 + 4);
    }
  };
  return {
    call: (name, ...args) => dec.decode(run(name, args)),
    bytes: (name, ...args) => run(name, args),
    samples,
  };
}
