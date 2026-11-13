// The site's data files (gzipped) kept in the browser: Cache API, one cache per data version (an older one dropped).
// The page and the engine's worker read them through here; a file fetched once is not fetched again.

let versionP = null;
let storeP = null;
const DONE = "data/ja/.stored"; // the whole Japanese dictionary is in the cache

export function version() {
  versionP ??= fetch("data/version.json", { cache: "no-cache" }).then((r) => r.json());
  return versionP;
}

function open() {
  storeP ??= (async () => {
    try {
      if (!self.caches) return null;
      const name = `voasync-${(await version()).data}`;
      for (const key of await caches.keys()) if (key.startsWith("voasync-") && key !== name) await caches.delete(key);
      return await caches.open(name);
    } catch {
      return null; // no cache here (a private window): fetched each time
    }
  })();
  return storeP;
}

/** A data file's response (data/PATH.gz): from the cache, else fetched (and kept). */
async function response(path) {
  const url = `data/${path}.gz`;
  const c = await open();
  const hit = c && (await c.match(url));
  if (hit) return hit;
  const r = await fetch(`${url}?v=${(await version()).data}`); // a browser's cache never mixes two data versions
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  if (c) await c.put(url, r.clone()).catch(() => {});
  return r;
}

/** A data file's bytes, decompressed. */
export async function gz(path) {
  const r = await response(path);
  const stream = r.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whether the browser can keep the dictionary, and whether it has. */
export async function dictionary() {
  const c = await open();
  return { storable: !!c, stored: !!(c && (await c.match(DONE))), bytes: (await version()).ja_bytes || 0 };
}

/** The whole Japanese dictionary into the cache, a few files at a time (the files there already skipped). */
export async function storeDictionary(onProgress = () => {}) {
  const c = await open();
  if (!c || (await c.match(DONE))) return;
  const paths = ((await version()).ja_files || []).map((f) => `ja/${f}`);
  let next = 0;
  let done = 0;
  const one = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      if (!(await c.match(`data/${path}.gz`))) await (await response(path)).arrayBuffer();
      onProgress(++done / paths.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, one));
  await c.put(DONE, new Response("1"));
}
