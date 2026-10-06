/* Module audio (AudioWorklet) : reçoit le son de la vidéo, le débrouille en direct.
 * Messages reçus (port) :
 *   {type:"config", key, version, mode}   mode : "pass" (son tel quel), "mute", "decode"
 *   {type:"lock", i0, p0}                  l'échantillon d'entrée i0 est à la position p0 du son publié
 *   {type:"unlock"}                        silence jusqu'au prochain calage
 *   {type:"watchOnset"}                    signaler la reprise du son après un silence
 *   {type:"snapshot", id, from, len}       copie (mono) de l'entrée, pour les mesures
 * Messages envoyés : {type:"onset", index}, {type:"snapshot", id, data, from}, {type:"tick", count}.
 * Fonctionne aussi hors AudioWorklet (ScriptProcessor de secours) via BRVProcessorCore. */
(function (root) {
  "use strict";

  function BRVProcessorCore(post) {
    this.post = post;
    this.mode = "pass";
    this.dec = null;
    this.count = 0;               // échantillons d'entrée reçus
    this.zeroRun = 0;             // blocs entièrement silencieux consécutifs
    this.zeroStart = -1;
    this.watch = false;
    this.watchSince = 0;
    this.lastTick = 0;
    this.pendingSnaps = [];
    this.outRing = new Float32Array(48000 * 8);   // dernières 8 s de sortie (mono), pour les tests
    this.history = [new Float32Array(1 << 19), new Float32Array(1 << 19)];   // entrée, avant qu'une clé soit connue
    this.watchGap = false;
    this.outCount = 0;
  }

  BRVProcessorCore.prototype.message = function (m) {
    if (m.type === "config") {
      this.mode = m.mode;
      if (m.key && (!this.dec || this.dec.key !== m.key || this.dec.version !== m.version)) {
        const old = this.dec;
        this.dec = new root.BRVDSP.Decoder(m.key, m.version, 2);
        this.dec.inCount = this.count;
        for (let c = 0; c < 2; c++) this.dec.input[c].set(old ? old.input[c] : this.history[c]);   // on garde l'historique
      }
    } else if (m.type === "lock") {
      if (this.dec) this.dec.lock(m.i0, m.p0);
    } else if (m.type === "lockRef") {
      if (this.dec) this.dec.lockRef(m.i0, m.p0);
    } else if (m.type === "feed") {
      if (this.dec) this.dec.feed(m.p0, [m.L, m.R], m.L.length);
    } else if (m.type === "unlock") {
      if (this.dec) this.dec.unlock();
    } else if (m.type === "watchOnset") {
      this.watch = true;
      this.watchSince = this.count;
      this.watchGap = this.zeroRun > 0;          // silence déjà en cours (début de lecture, pause)
    } else if (m.type === "snapshot") {
      if (m.from === null) {                       // « les len derniers » : ce qui est déjà reçu
        m.len = Math.min(m.len, this.count);
        m.from = this.count - m.len;
      }
      this.pendingSnaps.push(m);
    } else if (m.type === "mark") {
      (this.marks = this.marks || []).push([m.label, this.count]);
      if (this.marks.length > 40) this.marks.shift();
      this.post({ type: "mark", label: m.label, count: this.count });
    } else if (m.type === "fedSnap") {
      const d = this.dec, n = 48000, out = new Float32Array(n);
      const pos = d ? d.position() : null;
      const from = pos && pos.now !== null ? Math.round(pos.now) - n : 0;
      if (d) for (let k = 0; k < n; k++) out[k] = 0.5 * (d.A[0][(from + k) & ((1 << 19) - 1)] + d.A[1][(from + k) & ((1 << 19) - 1)]);
      this.post({ type: "fedSnap", id: m.id, from, data: out, fed: pos && pos.fed });
    } else if (m.type === "state") {
      const d = this.dec;
      this.post({ type: "state", id: m.id, mode: this.mode, count: this.count, marks: this.marks || [],
                  dec: d ? { locked: d.locked, base: d.base, frac: d.frac, inCount: d.inCount, nextWindow: d.nextWindow,
                             virtStart: d.virtStart, virtEnd: d.virtEnd, pAligned: d.pAligned, version: d.version } : null });
    } else if (m.type === "outSnap") {
      const n = this.outRing.length, out = new Float32Array(n);
      for (let k = 0; k < n; k++) out[k] = this.outRing[(this.outCount + k) % n];
      this.post({ type: "outSnap", id: m.id, data: out, count: this.outCount });
    }
  };

  BRVProcessorCore.prototype.process = function (input, output, n) {
    const L = input[0], R = input[1] || input[0];
    let silent = true;
    if (L) for (let k = 0; k < n; k++) { if (L[k] !== 0 || (R && R[k] !== 0)) { silent = false; break; } }
    // reprise du son après un silence (lecture, saut, pause, attente).
    // Le son lui-même contient de vrais silences : on n'accepte que le silence déjà en cours
    // au moment de la demande, ou commencé dans les 150 ms qui la suivent (vidage du saut).
    if (this.watch) {
      if (silent && this.zeroRun === 0 && this.count - this.watchSince <= 7200) this.watchGap = true;
      if (!silent && this.zeroRun >= 2 && this.watchGap) {
        let first = 0;
        while (first < n && L[first] === 0 && (!R || R[first] === 0)) first++;
        // prevEnd : dernier échantillon non nul avant le silence (reprise après une pause : le son
        // continue exactement là où il s'était arrêté)
        this.post({ type: "onset", index: this.count + first, prevEnd: this.lastSound });
        this.watch = false;
      } else if (!silent && !this.watchGap && this.count - this.watchSince > 48000 * 0.6) {
        this.post({ type: "onset", index: null, count: this.count });   // pas de silence net
        this.watch = false;
      }
    }
    this.zeroRun = silent ? this.zeroRun + 1 : 0;
    if (!silent) {
      let last = n - 1;
      while (last > 0 && L[last] === 0 && (!R || R[last] === 0)) last--;
      this.lastSound = this.count + last;
    }

    const dec = this.dec;
    if (dec) {
      dec.push(L ? [L, R] : [new Float32Array(n), new Float32Array(n)], n);
    } else if (L) {
      const hm = this.history[0].length - 1;
      for (let k = 0; k < n; k++) { this.history[0][(this.count + k) & hm] = L[k]; this.history[1][(this.count + k) & hm] = R[k]; }
    }
    this.count += n;
    if (this.mode === "decode" && dec) {
      dec.pull(output, n);
    } else if (this.mode === "pass" && L) {
      for (let c = 0; c < output.length; c++) output[c].set(c === 0 ? L : R);
    } else {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
    }
    const ring = this.outRing, rn = ring.length;
    for (let k = 0; k < n; k++) ring[(this.outCount + k) % rn] = 0.5 * (output[0][k] + (output[1] || output[0])[k]);
    this.outCount += n;
    // copies demandées, dès que les échantillons sont arrivés
    if (this.pendingSnaps.length) {
      const keep = [];
      for (const s of this.pendingSnaps) {
        if (s.from + s.len <= this.count) {
          this.post({ type: "snapshot", id: s.id, from: s.from, data: dec ? dec.snapshot(s.from, s.len) : this.historySnap(s.from, s.len) });
        } else keep.push(s);
      }
      this.pendingSnaps = keep;
    }
    if (this.count - this.lastTick >= 4800) {                 // 10 fois par seconde
      this.lastTick = this.count;
      this.post({ type: "tick", count: this.count, locked: !!(dec && dec.locked), pos: dec ? dec.position() : null });
    }
  };

  BRVProcessorCore.prototype.historySnap = function (from, len) {
    const out = new Float32Array(len), h = this.history, hm = h[0].length - 1;
    for (let k = 0; k < len; k++) {
      const i = from + k;
      if (i < 0 || i >= this.count || i < this.count - h[0].length) continue;
      out[k] = 0.5 * (h[0][i & hm] + h[1][i & hm]);
    }
    return out;
  };

  root.BRVProcessorCore = BRVProcessorCore;

  if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor !== "undefined") {
    class BRVProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.core = new BRVProcessorCore((m) => this.port.postMessage(m));
        this.port.onmessage = (e) => this.core.message(e.data);
      }
      process(inputs, outputs) {
        const out = outputs[0];
        const n = out[0] ? out[0].length : 128;
        this.core.process(inputs[0] || [], out, n);
        return true;
      }
    }
    registerProcessor("brv-decoder", BRVProcessor);
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
