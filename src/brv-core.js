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
