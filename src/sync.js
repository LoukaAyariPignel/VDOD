/* Vérification du calage du son par les copies redondantes des jointures.
 *
 * Autour de chaque jointure de morceaux, le même bout de son original est présent deux fois
 * dans le son publié (fin d'un morceau, début du suivant, avec des pondérations
 * complémentaires). Avec la bonne grille, ces deux zones se ressemblent ; avec une grille
 * décalée de plus de ~8 ms, non. On mesure cela dans les aigus (> 3,3 kHz), que le mélange
 * des fréquences ne touche pas, après « blanchiment » du spectre (les sons tenus ne dominent
 * plus), et en contraste avec des paires mal assorties (la ressemblance générale s'annule). */
(function (root) {
  "use strict";
  const BRV = root.BRV || (typeof require !== "undefined" ? require("./brv-core.js") : null);
  const RATE = 48000, L = 2880, M = 192, W = 23040, G = 5760;

  // FFT complexe en place (taille puissance de 2)
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // aigus blanchis (3,3 – 12 kHz)
  function whitenedHigh(x) {
    let n = 1; while (n < x.length) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(x);
    fft(re, im, false);
    const mag = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    // enveloppe : moyenne glissante de la magnitude sur ±32 cases (sommes cumulées)
    const half = 32, H = n / 2 + 1, cs = new Float64Array(H + 1), env = new Float64Array(H);
    for (let k = 0; k < H; k++) cs[k + 1] = cs[k] + mag[k];
    for (let k = 0; k < H; k++) {
      const a = Math.max(0, k - half), b = Math.min(H, k + half + 1);
      env[k] = (cs[b] - cs[a]) / (b - a) + 1e-9;
    }
    const lo = Math.floor(3300 * n / RATE), hi = Math.ceil(12000 * n / RATE);
    for (let k = 0; k <= n / 2; k++) {
      const g = k >= lo && k <= hi ? 1 / env[k] : 0;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < n / 2) { re[n - k] = re[k]; im[n - k] = -im[k]; }
    }
    fft(re, im, true);
    return Float32Array.from(re.subarray(0, x.length));
  }

  function Pairs(key) {
    const { order, reverse } = BRV.audioPlan(key);
    const inv = new Array(8);
    for (let i = 0; i < 8; i++) inv[order[i]] = i;
    this.list = [];
    for (let j = 1; j < 8; j++) {
      const i = inv[j], a = inv[j - 1];
      const c1 = reverse[i] ? [i * L + L, true] : [i * L, false];     // chez le morceau j
      const c2 = reverse[a] ? [a * L, true] : [a * L + L, false];     // chez le morceau j−1
      // morceaux restés voisins : les deux « copies » sont la même zone, sans information
      if (Math.abs(c1[0] - c2[0]) >= 2 * M) this.list.push([c1, c2]);
    }
  }

  function pairCorr(hf, base, p1, p2) {
    const s1 = base + p1[0], s2 = base + p2[0], n = 2 * M;
    if (Math.min(s1, s2) < 0 || Math.max(s1, s2) + n > hf.length) return null;
    let ab = 0, aa = 0, bb = 0;
    for (let t = 0; t < n; t++) {
      const a = hf[p1[1] ? s1 + n - 1 - t : s1 + t], b = hf[p2[1] ? s2 + n - 1 - t : s2 + t];
      ab += a * b; aa += a * a; bb += b * b;
    }
    return ab / Math.sqrt(aa * bb + 1e-20);
  }

  // score du calage « hf[0] est à la position publiée p0 » (contraste ; ~0,4 si juste, ~0 sinon)
  function score(hf, p0, pairs) {
    let good = 0, ng = 0, bad = 0, nb = 0;
    const k0 = Math.ceil((p0 - G + M) / W);
    for (let k = k0; ; k++) {
      const base = G + k * W - M - p0;
      if (base + W + 2 * M > hf.length) break;
      const P = pairs.list;
      for (let n = 0; n < P.length; n++) {
        const v = pairCorr(hf, base, P[n][0], P[n][1]);
        if (v === null) continue;
        good += v; ng++;
        const o = P[(n + 3) % P.length][1];
        const w = Math.abs(o[0] - P[n][0][0]) >= 2 * M ? pairCorr(hf, base, P[n][0], o) : null;
        if (w !== null) { bad += w; nb++; }
      }
    }
    if (ng < 6) return null;
    return good / ng - (nb ? bad / nb : 0);
  }

  // Meilleur décalage d (hf[0] à la position p0 + d) pour d dans [dMin, dMax].
  function search(hf, p0, pairs, dMin, dMax) {
    let best = null, bestD = 0, cur = score(hf, p0, pairs);
    for (let d = dMin; d <= dMax; d += 16) {
      const s = score(hf, p0 + d, pairs);
      if (s !== null && (best === null || s > best)) { best = s; bestD = d; }
    }
    if (best === null) return null;
    let fineBest = best, fineD = bestD;
    for (let d = bestD - 15; d <= bestD + 15; d++) {
      const s = score(hf, p0 + d, pairs);
      if (s !== null && s > fineBest) { fineBest = s; fineD = d; }
    }
    return { d: fineD, score: fineBest, current: cur };
  }

  const SYNC = { whitenedHigh, Pairs, score, search, fft };
  root.BRVSync = SYNC;
  if (typeof module !== "undefined" && module.exports) module.exports = SYNC;
})(typeof globalThis !== "undefined" ? globalThis : this);
