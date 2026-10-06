/* Fichier généré par build.py (brv-core.js + dsp.js + processor.js) : ne pas modifier. */
// ---- brv-core.js
/* Cœur du format BRV (voir SPEC.md) : clé, flux pseudo-aléatoire, plans de brouillage.
 * Doit donner exactement les mêmes tirages que brouilleur/core.py.
 * Script « classique » : utilisable dans la page, dans le module audio et dans Node (tests). */
(function (root) {
  "use strict";

  const GRID_X = 32, GRID_Y = 18, GRID_TEXT = "32X18", N_BLOCKS = 576;
  const BLOCK_MARGIN = 0.06;
  const OPENING_S = 0.6;
  const RATE = 48000;

  // ------------------------------------------------------------ SHA-256 (synchrone)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

  function sha256Words(ascii) {
    // renvoie les 8 mots de 32 bits de l'empreinte (octet de poids fort en premier)
    const n = ascii.length;
    const total = ((n + 9 + 63) >> 6) << 6;
    const bytes = new Uint8Array(total);
    for (let i = 0; i < n; i++) bytes[i] = ascii.charCodeAt(i) & 0xff;
    bytes[n] = 0x80;
    const bits = n * 8;
    bytes[total - 4] = (bits >>> 24) & 0xff; bytes[total - 3] = (bits >>> 16) & 0xff;
    bytes[total - 2] = (bits >>> 8) & 0xff; bytes[total - 1] = bits & 0xff;
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h;
  }

  // Flux : SHA-256(« graine:0 »), SHA-256(« graine:1 »)… → 8 entiers par empreinte.
  function Stream(seed) {
    let counter = 0, buf = null, pos = 8;
    this.next = function () {
      if (pos >= 8) { buf = sha256Words(seed + ":" + counter); counter++; pos = 0; }
      return buf[pos++];
    };
  }

  function fisherYates(stream, n) {
    const p = new Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = stream.next() % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    return p;
  }

  function videoPlan(key) {
    const s = new Stream(key + ":" + GRID_TEXT);
    const perm = fisherYates(s, N_BLOCKS);
    const flags = new Array(N_BLOCKS);
    for (let i = 0; i < N_BLOCKS; i++) flags[i] = s.next() & 7;
    return { perm, flags };
  }

  // Texture du décodeur : pour le bloc affiché s, (c mod 32, c div 32, flags, 255).
  function decodeTable(key) {
    const { perm, flags } = videoPlan(key);
    const t = new Uint8Array(N_BLOCKS * 4);
    for (let c = 0; c < N_BLOCKS; c++) {
      const s = perm[c];
      t[s * 4] = c % GRID_X; t[s * 4 + 1] = (c / GRID_X) | 0; t[s * 4 + 2] = flags[c]; t[s * 4 + 3] = 255;
    }
    return t;
  }

  function audioPlan(key) {
    const s = new Stream(key + ":" + GRID_TEXT + ":SON");
    const order = fisherYates(s, 8);
    const reverse = new Array(8);
    for (let i = 0; i < 8; i++) reverse[i] = (s.next() & 1) === 1;
    return { order, reverse };
  }

  function bandPerm(key, windowIndex, n) {
    return fisherYates(new Stream(key + ":" + GRID_TEXT + ":BANDES:" + windowIndex), n || 8);
  }

  // « BRV4:32X18:K7QP2MXE » → { key, version } ou null
  function parsePayload(txt) {
    const m = /^BRV([1-4]):(\d+)X(\d+):([A-Z0-9]{4,16})$/.exec((txt || "").trim());
    if (!m || +m[2] !== GRID_X || +m[3] !== GRID_Y) return null;
    return { key: m[4], version: +m[1] };
  }

  function normalizeKey(k) {
    k = (k || "").trim().toUpperCase();
    return /^[A-Z0-9]{4,16}$/.test(k) ? k : null;
  }

  function openingSeconds(fps) {
    return Math.max(1, Math.ceil(OPENING_S * fps - 1e-6)) / fps;
  }

  const BRV = { GRID_X, GRID_Y, N_BLOCKS, BLOCK_MARGIN, OPENING_S, RATE, sha256Words, Stream, fisherYates,
                videoPlan, decodeTable, audioPlan, bandPerm, parsePayload, normalizeKey, openingSeconds };
  root.BRV = BRV;
  if (typeof module !== "undefined" && module.exports) module.exports = BRV;
})(typeof globalThis !== "undefined" ? globalThis : this);

// ---- dsp.js
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

// ---- processor.js
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
