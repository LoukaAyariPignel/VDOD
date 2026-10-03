/* Débrouillage du son en direct (BRV1, BRV2, BRV3), échantillon par échantillon.
 *
 * Deux façons de recevoir le son publié :
 *  - « référence » (recommandée) : le son de YouTube, décodé par l'extension avec ses
 *    horodatages, est fourni EN AVANCE par feed(p0, …) — p0 étant sa position dans le son
 *    publié. Tous les formats sont possibles, BRV2 compris (il a besoin du son à venir).
 *  - « joué » (secours) : le son tel que le navigateur le joue ; un calage relie le compteur
 *    d'échantillons reçus i à la position publiée : p = p0 + (i − i0), p0 réel.
 * Dans les deux cas, l'échantillon d'entrée i (le moment présent) est relié au son publié par
 * p(i) = i − base, et on y joue le son virtuel v = p − G − W (une fenêtre de retard, compensée
 * à l'encodage ; plus LATENCY en mode « joué », faute de son à l'avance).
 *
 * Chaîne (SPEC.md §5 et §5 bis) :
 *   A : son publié (BRV3 : bandes de fréquences remises en place, MDCT sur le son publié)
 *   V : morceaux de 60 ms remis en ordre dans chaque fenêtre de 480 ms (BRV2 : bandes remises
 *       en place ensuite, MDCT sur le son virtuel)
 * Script classique : chargé dans le module audio (AudioWorklet), dans la page (secours) et dans Node. */
(function (root) {
  "use strict";
  const BRV = root.BRV || (typeof require !== "undefined" ? require("./brv-core.js") : null);

  const L = 2880, M = 192, W = 23040, G = 5760;     // 60 ms, 4 ms, 480 ms, 120 ms à 48 kHz
  const N = 256, BINS = 32, BAND = 4;               // MDCT : 8 bandes de 4 coefficients (0-3 kHz)
  const FIRST_CENTER_PUB = G - M + N;               // BRV3 : trames plus tôt jamais permutées
  const LATENCY = 2 * M + 3 * N + 128;              // mode « joué » : marge de calcul
  const RING = 1 << 19;                             // ~10,9 s
  const MASK = RING - 1;
  const TAPS = 16;                                  // interpolation fractionnaire ±16

  const TRAP = new Float32Array(L + 2 * M);         // fenêtre trapèze des morceaux
  for (let t = 0; t < L + 2 * M; t++) {
    const r = (t + 0.5) / (2 * M), r2 = (L + 2 * M - t - 0.5) / (2 * M);
    TRAP[t] = Math.min(1, r, r2);
  }
  const MD = new Float32Array(2 * N * BINS);        // MDCT limitée aux 32 premiers coefficients
  for (let t = 0; t < 2 * N; t++) {
    const win = Math.sin(Math.PI * (t + 0.5) / (2 * N));
    for (let k = 0; k < BINS; k++) MD[t * BINS + k] = win * Math.cos(Math.PI / N * (t + 0.5 + N / 2) * (k + 0.5));
  }

  function rings(ch) { const r = []; for (let c = 0; c < ch; c++) r.push(new Float32Array(RING)); return r; }

  // ---------------------------------------------------------------- BRV4 (SPEC.md §5 ter)
  // MDCT de pas N4 (fenêtre sinus, orthonormée) calculée par FFT de 2·N4 points ; dans chaque
  // fenêtre de 8 trames : trames permutées, signes alternés (reverse), 16 bandes de 32 coefficients (0 – 6 kHz).
  const N4 = 2048, FW4 = 8, NB4 = 16, BB4 = 32, GAIN4 = 0.7, F4 = 2 * N4;
  const T4 = (() => {
    const t = { win: new Float64Array(F4), preR: new Float64Array(F4), preI: new Float64Array(F4),
                postR: new Float64Array(N4), postI: new Float64Array(N4), ipreR: new Float64Array(N4), ipreI: new Float64Array(N4),
                ipostR: new Float64Array(F4), ipostI: new Float64Array(F4), rev: new Uint32Array(F4),
                cos: new Float64Array(F4 / 2), sin: new Float64Array(F4 / 2) };
    const n0 = 0.5 + N4 / 2;
    for (let n = 0; n < F4; n++) {
      t.win[n] = Math.sin(Math.PI * (n + 0.5) / F4);
      t.preR[n] = Math.cos(-Math.PI * n / F4); t.preI[n] = Math.sin(-Math.PI * n / F4);
      t.ipostR[n] = Math.cos(Math.PI * (n + n0) / F4); t.ipostI[n] = Math.sin(Math.PI * (n + n0) / F4);
    }
    for (let k = 0; k < N4; k++) {
      t.postR[k] = Math.cos(-Math.PI * n0 * (k + 0.5) / N4); t.postI[k] = Math.sin(-Math.PI * n0 * (k + 0.5) / N4);
      t.ipreR[k] = Math.cos(Math.PI * n0 * k / N4); t.ipreI[k] = Math.sin(Math.PI * n0 * k / N4);
    }
    const bits = Math.log2(F4);
    for (let i = 0; i < F4; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); t.rev[i] = r; }
    for (let i = 0; i < F4 / 2; i++) { t.cos[i] = Math.cos(2 * Math.PI * i / F4); t.sin[i] = Math.sin(2 * Math.PI * i / F4); }
    return t;
  })();
  const SCALE4 = Math.sqrt(2 / N4);

  // FFT complexe sur place, non normalisée ; sign = −1 (directe) ou +1 (inverse)
  function fft4(re, im, sign) {
    const n = F4, rev = T4.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = T4.cos[k], wi = sign * T4.sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function Decoder(key, version, channels) {
    this.ch = channels || 2;
    this.version = version;
    const ap = BRV.audioPlan(key);
    this.order = ap.order; this.reverse = ap.reverse;
    this.key = key;
    this.bandCache = new Map();
    this.input = rings(this.ch);     // son joué (toujours gardé : mesures, mode « joué »)
    this.A = rings(this.ch);         // son publié (+ corrections BRV3)
    this.dA = rings(this.ch);
    this.V = rings(this.ch);         // son virtuel (+ corrections BRV2)
    this.dV = rings(this.ch);
    this.inCount = 0;
    this.locked = false;
    this.mode = "played";
    this.started = false;
    this.carry = [new Float32Array(2 * M), new Float32Array(2 * M)];
    this.win = new Float32Array(W + 2 * M);
    this.X = new Float32Array(BINS); this.Y = new Float32Array(BINS);
    this.fir = null;
    this.underruns = 0;
  }

  Decoder.prototype.bands = function (w, n) {
    const id = w + ":" + (n || 8);
    let q = this.bandCache.get(id);
    if (!q) {
      q = BRV.bandPerm(this.key, w, n || 8);
      if (this.bandCache.size > 64) this.bandCache.clear();
      this.bandCache.set(id, q);
    }
    return q;
  };

  // ------------------------------------------------ BRV4 : trames MDCT remises en ordre
  // Trame m : publiés [G + (m−1)N4, G + (m+1)N4) ; la fenêtre w regroupe les trames 8w+1 … 8w+8
  // (la trame 0 n'est pas brouillée). Le virtuel v est rendu en V (× 1/GAIN4).
  Decoder.prototype.start4 = function (pStart) {
    let m = Math.ceil((pStart - G) / N4) + 1;            // 1re trame dont tout le support est fourni
    if (m <= 0) m = 0;
    else m = Math.ceil((m - 1) / FW4) * FW4 + 1;          // début de la fenêtre suivante
    this.nextFrame4 = m;
    this.pNeed = Math.max(pStart, G + (m - 1) * N4);      // mode « joué » : 1er publié à recopier
    this.pub4 = [];                                       // trames publiées de la fenêtre en cours
    this.validFrom = m * N4;                              // [(m−1)N4, mN4) incomplet
    this.validTo = this.validFrom;
    this.firstSynth4 = true;
    if (!this.re4) { this.re4 = new Float64Array(F4); this.im4 = new Float64Array(F4); }
    this.started = true;
  };

  Decoder.prototype.analyze4 = function (m) {             // → [coefs canal 0, canal 1…]
    const out = [], re = this.re4, im = this.im4, p0 = G + (m - 1) * N4;
    for (let c = 0; c < this.ch; c++) {
      const a = this.A[c];
      for (let n = 0; n < F4; n++) { const x = a[(p0 + n) & MASK] * T4.win[n]; re[n] = x * T4.preR[n]; im[n] = x * T4.preI[n]; }
      fft4(re, im, -1);
      const X = new Float64Array(N4);
      for (let k = 0; k < N4; k++) X[k] = SCALE4 * (re[k] * T4.postR[k] - im[k] * T4.postI[k]);
      out.push(X);
    }
    return out;
  };

  Decoder.prototype.synth4 = function (coefs, f) {        // trame virtuelle f → V
    const re = this.re4, im = this.im4, v0 = (f - 1) * N4, g = 1 / GAIN4;
    for (let c = 0; c < this.ch; c++) {
      const X = coefs[c], out = this.V[c];
      for (let k = 0; k < N4; k++) { re[k] = X[k] * T4.ipreR[k]; im[k] = X[k] * T4.ipreI[k]; }
      for (let k = N4; k < F4; k++) { re[k] = 0; im[k] = 0; }
      fft4(re, im, +1);
      for (let n = 0; n < F4; n++) {
        const y = SCALE4 * (re[n] * T4.ipostR[n] - im[n] * T4.ipostI[n]) * T4.win[n] * g;
        const i = (v0 + n) & MASK;
        // 1re moitié : complète la trame précédente (sauf au démarrage) ; 2e moitié : nouvelle
        if (n < N4 && !this.firstSynth4) out[i] += y; else out[i] = y;
      }
    }
    this.firstSynth4 = false;
    this.validTo = f * N4;
  };

  Decoder.prototype.run4 = function () {
    while (G + (this.nextFrame4 + 1) * N4 <= this.pA) {
      const m = this.nextFrame4++;
      const X = this.analyze4(m);
      if (m === 0) { this.synth4(X, 0); continue; }        // trame 0 : non brouillée
      this.pub4.push(X);
      if (this.pub4.length < FW4) continue;
      // fenêtre complète : la position i contient la trame virtuelle order[i]
      const w = (m - 1 - (FW4 - 1)) / FW4, q = this.bands(w, NB4), virt = new Array(FW4);
      for (let i = 0; i < FW4; i++) {
        const j = this.order[i], rev = this.reverse[i], frame = [];
        for (let c = 0; c < this.ch; c++) {
          const src = this.pub4[i][c], dst = new Float64Array(N4);
          for (let jb = 0; jb < NB4; jb++) {                  // la bande publiée jb contient l'originale q[jb]
            const s0 = jb * BB4, d0 = q[jb] * BB4;
            for (let b = 0; b < BB4; b++) dst[d0 + b] = src[s0 + b];
          }
          for (let k = NB4 * BB4; k < N4; k++) dst[k] = src[k];
          if (rev) for (let k = 1; k < N4; k += 2) dst[k] = -dst[k];
          frame.push(dst);
        }
        virt[j] = frame;
      }
      for (let j = 0; j < FW4; j++) this.synth4(virt[j], w * FW4 + 1 + j);
      this.pub4 = [];
    }
  };

  // (Re)démarre la chaîne pour du son publié disponible à partir de pStart.
  Decoder.prototype.start = function (pStart) {
    if (this.version === 4) { this.start4(pStart); return; }
    let k0 = Math.ceil((pStart - G + M + 3 * N) / W);
    if (k0 < 0) k0 = 0;
    this.nextWindow = k0;
    this.pNeed = G + k0 * W - M - 3 * N;                   // premier p utile
    this.nextFrameA = Math.ceil((this.pNeed + N) / N);      // trame MDCT m : [(m−1)N, (m+1)N)
    this.doneA = (this.nextFrameA - 2) * N;
    this.virtStart = k0 * W + M;                            // 2M premiers virtuels incomplets
    this.virtEnd = this.virtStart;
    this.nextFrameV = Math.ceil((this.virtStart + N) / N);
    this.validFrom = this.version === 2 ? this.nextFrameV * N : this.virtStart;
    this.validTo = this.validFrom;
    for (let c = 0; c < this.ch; c++) { this.carry[c].fill(0); this.dA[c].fill(0); this.dV[c].fill(0); }
    this.started = true;
  };

  // Mode « joué » : l'échantillon d'entrée i0 est à la position publiée p0 (réel).
  Decoder.prototype.lock = function (i0, p0) {
    const pi = Math.round(p0);
    const frac = p0 - pi;
    this.base = i0 - pi;
    this.frac = frac;
    if (Math.abs(frac) > 0.02) {
      this.fir = new Float32Array(2 * TAPS + 1);
      let s = 0;
      for (let k = -TAPS; k <= TAPS; k++) {
        const x = k + frac;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const bw = 0.42 + 0.5 * Math.cos(Math.PI * x / (TAPS + 1)) + 0.08 * Math.cos(2 * Math.PI * x / (TAPS + 1));
        this.fir[k + TAPS] = sinc * bw; s += sinc * bw;
      }
      for (let k = 0; k < this.fir.length; k++) this.fir[k] /= s;
    } else this.fir = null;
    this.mode = "played";
    const oldest = Math.max(this.inCount - RING + 4096, 0) - this.base;
    this.start(oldest);
    this.pA = this.pNeed;
    this.locked = true;
    this.fade = 0;
  };

  // Mode « référence » : l'échantillon d'entrée i0 est à la position publiée p0 ; le son publié
  // lui-même arrive par feed().
  Decoder.prototype.lockRef = function (i0, p0) {
    this.base = i0 - Math.round(p0);
    if (this.mode !== "ref") this.started = false;
    this.mode = "ref";
    this.locked = true;
    this.fade = 0;
  };

  Decoder.prototype.unlock = function () { this.locked = false; };

  // Son publié [p0, p0 + n) (mode « référence »)
  Decoder.prototype.feed = function (p0, chans, n) {
    if (this.mode !== "ref") return;
    if (!this.started || p0 !== this.pA) { this.start(p0); this.pA = p0; }
    for (let c = 0; c < this.ch; c++) {
      const src = chans[Math.min(c, chans.length - 1)], dst = this.A[c];
      for (let k = 0; k < n; k++) dst[(p0 + k) & MASK] = src[k];
    }
    this.pA = p0 + n;
    this.run();
  };

  Decoder.prototype.push = function (chans, n) {
    const i0 = this.inCount;
    for (let c = 0; c < this.ch; c++) {
      const src = chans[Math.min(c, chans.length - 1)], dst = this.input[c];
      for (let k = 0; k < n; k++) dst[(i0 + k) & MASK] = src ? src[k] : 0;
    }
    this.inCount += n;
    if (this.locked && this.mode === "played") { this.align(); this.run(); }
  };

  Decoder.prototype.align = function () {
    const pMax = this.inCount - 1 - (this.fir ? TAPS : 0) - this.base;
    while (this.pA <= pMax) {
      const p = this.pA, i = p + this.base;
      for (let c = 0; c < this.ch; c++) {
        const x = this.input[c];
        let v;
        if (this.fir) { v = 0; for (let k = -TAPS; k <= TAPS; k++) v += x[(i + k) & MASK] * this.fir[k + TAPS]; }
        else v = x[i & MASK];
        this.A[c][p & MASK] = v;
      }
      this.pA++;
    }
  };

  Decoder.prototype.run = function () {
    if (this.version === 4) { this.run4(); return; }
    let final = this.pA;
    if (this.version === 3) {
      while ((this.nextFrameA + 1) * N <= this.pA) {
        const m = this.nextFrameA, c = m * N, w = Math.floor((c - G) / W);
        this.frame(this.A, this.dA, m, c >= FIRST_CENTER_PUB && w >= 0 ? w : -1);
        this.nextFrameA++;
      }
      final = this.doneA = (this.nextFrameA - 2) * N;
    }
    while (G + (this.nextWindow + 1) * W + M <= final) this.window(this.nextWindow++);
    if (this.version === 2) {
      while ((this.nextFrameV + 1) * N <= this.virtEnd) {
        const m = this.nextFrameV, w = Math.floor(m * N / W);
        this.frame(this.V, this.dV, m, m >= 1 && w >= 0 ? w : -1);
        this.nextFrameV++;
      }
      this.validTo = (this.nextFrameV - 2) * N;
    } else this.validTo = this.virtEnd;
  };

  // Trame MDCT m sur le signal (buf, delta) : les 32 premiers coefficients sont remis en place
  // selon la fenêtre w (w < 0 : trame non permutée) ; seule la différence est resynthétisée.
  Decoder.prototype.frame = function (buf, delta, m, w) {
    const start = (m - 1) * N;
    for (let c = 0; c < this.ch; c++) {            // [(m−2)N, (m−1)N) est désormais définitif
      const a = buf[c], d = delta[c];
      for (let p = start - N; p < start; p++) { const i = p & MASK; a[i] += d[i]; d[i] = 0; }
    }
    if (w < 0) return;
    const q = this.bands(w), X = this.X, Y = this.Y, md = MD, scale = 2 / N;
    for (let c = 0; c < this.ch; c++) {
      const a = buf[c], d = delta[c];
      X.fill(0);
      for (let t = 0; t < 2 * N; t++) {
        const v = a[(start + t) & MASK];
        if (v === 0) continue;
        const row = t * BINS;
        for (let k = 0; k < BINS; k++) X[k] += v * md[row + k];
      }
      for (let jb = 0; jb < 8; jb++) {              // la bande brouillée j contient l'originale q[j]
        const dst = q[jb] * BAND, src = jb * BAND;
        for (let b = 0; b < BAND; b++) Y[dst + b] = X[src + b];
      }
      for (let k = 0; k < BINS; k++) Y[k] = (Y[k] - X[k]) * scale;
      for (let t = 0; t < 2 * N; t++) {
        const row = t * BINS;
        let s = 0;
        for (let k = 0; k < BINS; k++) s += Y[k] * md[row + k];
        d[(start + t) & MASK] += s;
      }
    }
  };

  Decoder.prototype.window = function (k) {
    const base = G + k * W - M, y = this.win;
    for (let c = 0; c < this.ch; c++) {
      const a = this.A[c];
      y.fill(0);
      for (let i = 0; i < 8; i++) {
        const j = this.order[i], rev = this.reverse[i];
        const src = base + i * L, dst = j * L, n = L + 2 * M;
        if (!rev) for (let t = 0; t < n; t++) y[dst + t] += a[(src + t) & MASK] * TRAP[t];
        else for (let t = 0; t < n; t++) y[dst + t] += a[(src + n - 1 - t) & MASK] * TRAP[t];
      }
      const car = this.carry[c];
      for (let t = 0; t < 2 * M; t++) y[t] += car[t];
      const out = this.V[c], v0 = k * W - M;
      for (let t = 0; t < W; t++) out[(v0 + t) & MASK] = y[t];
      for (let t = 0; t < 2 * M; t++) car[t] = y[W + t];
    }
    this.virtEnd = (k + 1) * W - M;
  };

  // Remplit la sortie pour les n derniers échantillons d'entrée reçus.
  Decoder.prototype.pull = function (outs, n) {
    const first = this.inCount - n;
    const lat = this.mode === "ref" ? 0 : LATENCY;
    let missing = 0;
    for (let c = 0; c < outs.length; c++) {
      const o = outs[c], src = this.V[Math.min(c, this.ch - 1)];
      for (let k = 0; k < n; k++) {
        if (!this.locked || !this.started) { o[k] = 0; continue; }
        const v = first + k - this.base - lat - G - W;
        if (v < this.validFrom || v >= this.validTo || v < 0) { o[k] = 0; if (c === 0 && v >= this.validTo) missing++; continue; }
        o[k] = src[v & MASK];
      }
    }
    if (missing) this.underruns++;
    if (this.locked) {
      for (let k = 0; k < n; k++) {
        const g = Math.min(1, (this.fade + k) / 480);
        for (let c = 0; c < outs.length; c++) outs[c][k] *= g;
      }
      this.fade += n;
    }
  };

  // position publiée jouée en ce moment, et jusqu'où le son publié a été fourni (mode référence)
  Decoder.prototype.position = function () {
    return { now: this.locked ? this.inCount - this.base : null, fed: this.mode === "ref" && this.started ? this.pA : null,
             underruns: this.underruns };
  };

  Decoder.prototype.snapshot = function (from, len) {
    const out = new Float32Array(len);
    for (let k = 0; k < len; k++) {
      const i = from + k;
      if (i < 0 || i >= this.inCount || i < this.inCount - RING) continue;
      let s = 0;
      for (let c = 0; c < this.ch; c++) s += this.input[c][i & MASK];
      out[k] = s / this.ch;
    }
    return out;
  };

  const DSP = { Decoder, L, M, W, G, N, LATENCY };
  root.BRVDSP = DSP;
  if (typeof module !== "undefined" && module.exports) module.exports = DSP;
})(typeof globalThis !== "undefined" ? globalThis : this);
