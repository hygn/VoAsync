// The record under the hand (Mixlyzer's scratch: audioengine/python/dsp.py ScratchPlatter), an AudioWorklet: per
// output frame, the song's position the hand had DELAY_SEC before it is heard, interpolated between the pointer's
// samples (a jitter buffer: the speed carries on between events), carried on at the last RATE_SEC's speed for up to
// EXTRAPOLATE_SEC past the last sample (never past the next pixel), smoothed by two one-pole lowpasses (critically
// damped, SMOOTH_SEC); the song read there (the 22050 Hz mono, cubic interpolation). Messages: load {pcm, rate},
// begin {pos, at, latency, pixel} (pos in the song's frames, at on the output's clock in s), to {pos, at}, end.

const DELAY_SEC = 0.06;
const EXTRAPOLATE_SEC = 0.02;
const RATE_SEC = 0.012;
const SMOOTH_SEC = 0.008;
const HISTORY_SEC = 1.0;
const CLOCK_GAIN = 0.02;
const CLOCK_RESYNC_SEC = 0.05;
const FADE_SEC = 0.005;

class Scratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = null;
    this.rate = 22050;
    this.on = false;
    this.level = 0;
    this.pole = Math.exp(-1 / (SMOOTH_SEC * sampleRate));
    this.reset(0, 0, 0);
    this.port.onmessage = (e) => this.message(e.data);
  }

  reset(pos, now, pixel) {
    this.times = [now];
    this.path = [pos];
    this.pixel = Math.abs(pixel);
    this.clock = now;
    this.z1 = pos;
    this.z2 = pos;
    this.at = 0; // the path's index the lookups have reached
  }

  message(m) {
    if (m.type === "load") {
      this.pcm = m.pcm;
      this.rate = m.rate;
    } else if (m.type === "begin") {
      this.latency = m.latency;
      this.reset(m.pos, m.at, m.pixel || 0);
      this.on = true;
    } else if (m.type === "to") {
      const at = Math.max(m.at, this.times[this.times.length - 1]);
      this.times.push(at);
      this.path.push(m.pos);
      let cut = 0;
      while (cut < this.times.length - 2 && this.times[cut] < at - HISTORY_SEC) cut++;
      if (cut) {
        this.times.splice(0, cut);
        this.path.splice(0, cut);
        this.at = Math.max(0, this.at - cut);
      }
    } else if (m.type === "end") {
      this.on = false;
    }
  }

  /** The hand's position at ``t`` (s): between its samples, else carried on from the last. */
  hand(t) {
    const times = this.times;
    const path = this.path;
    const last = times.length - 1;
    if (t <= times[0]) return path[0];
    if (t >= times[last]) {
      let x = path[last];
      if (last >= 1) {
        let j = last - 1;
        while (j > 0 && times[j] > times[last] - RATE_SEC) j--;
        const span = times[last] - times[j];
        if (span > 1e-4) {
          let ahead = ((path[last] - path[j]) / span) * Math.min(t - times[last], EXTRAPOLATE_SEC);
          if (this.pixel) ahead = Math.max(-this.pixel, Math.min(this.pixel, ahead));
          x += ahead;
        }
      }
      return x;
    }
    let i = Math.min(this.at, last - 1);
    while (i > 0 && times[i] > t) i--;
    while (i < last - 1 && times[i + 1] <= t) i++;
    this.at = i;
    const span = times[i + 1] - times[i];
    const f = span > 0 ? (t - times[i]) / span : 1;
    return path[i] + f * (path[i + 1] - path[i]);
  }

  /** The song at a fractional frame: cubic (Catmull-Rom) between its four neighbours. */
  read(pos) {
    const pcm = this.pcm;
    const n = pcm.length;
    const i = Math.floor(pos);
    const f = pos - i;
    const at = (k) => (k < 0 || k >= n ? 0 : pcm[k]);
    const y0 = at(i - 1);
    const y1 = at(i);
    const y2 = at(i + 1);
    const y3 = at(i + 2);
    return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.pcm || (!this.on && this.level <= 0)) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const heard = currentTime + (this.latency || 0);
    const error = heard - this.clock;
    if (Math.abs(error) > CLOCK_RESYNC_SEC) this.clock = heard;
    else this.clock += CLOCK_GAIN * error;
    const k = 1 - this.pole;
    const step = 1 / (FADE_SEC * sampleRate);
    for (let i = 0; i < n; i++) {
      const target = this.hand(this.clock + i / sampleRate - DELAY_SEC);
      this.z1 += k * (target - this.z1);
      this.z2 += k * (this.z1 - this.z2);
      this.level = this.on ? Math.min(1, this.level + step) : Math.max(0, this.level - step);
      const v = this.read(this.z2) * this.level;
      for (const ch of out) ch[i] = v;
    }
    this.clock += n / sampleRate;
    if (!this.on && this.level <= 0) this.port.postMessage({ type: "ended" });
    return true;
  }
}

registerProcessor("scratch", Scratch);
