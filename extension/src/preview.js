/* Aperçus de la barre de lecture (YouTube) : bulle au survol, grand aperçu en glissant, bande
 * de la recherche précise. Ce sont des vignettes découpées dans des planches d'images
 * (« storyboards », …/sb/<vidéo>/storyboard3_L2/M0.jpg) que YouTube fabrique à partir de la
 * vidéo publiée : elles sont donc brouillées, avec le même plan que la vidéo (il ne dépend que
 * de la clé). Chaque planche est débrouillée une fois, pixel par pixel comme dans le shader de
 * video.js, puis substituée à l'originale par une règle CSS : YouTube continue de placer ses
 * aperçus comme d'habitude, sur la planche débrouillée. Tant qu'une planche n'est pas prête,
 * l'aperçu reste noir plutôt que brouillé. */
(function (root) {
  "use strict";
  const BRV = root.BRV;
  const doc = root.document;
  const GX = BRV.GRID_X, GY = BRV.GRID_Y, M = BRV.BLOCK_MARGIN;
  const SB = /\/sb\/([\w-]+)\/([^/?"')]+)\/([^/?"')]+)/;      // …/sb/<vidéo>/<niveau>/<planche>

  function Previews() {
    this.key = null; this.table = null; this.videoId = null;
    this.sheets = new Map();          // « niveau/planche » → { state, url, grid }
    this.style = null; this.player = null; this.observer = null;
    this.aspect = 16 / 9;
    this.decoded = 0;
  }

  // appelé régulièrement par content.js avec la vidéo principale (ou null)
  Previews.prototype.update = function (c) {
    const key = c && c.active ? c.effectiveKey().key : null;
    const vid = c && c.id && c.id.startsWith("yt:") ? c.id.slice(3) : null;
    if (key !== this.key || vid !== this.videoId) this.reset(key, vid);
    if (!key) return;
    if (c.video.videoWidth) this.aspect = c.video.videoWidth / c.video.videoHeight;
    const player = c.video.closest(".html5-video-player") || c.video.parentElement;
    if (player !== this.player) this.observe(player);
  };

  Previews.prototype.reset = function (key, vid) {
    for (const s of this.sheets.values()) if (s.blobUrl) URL.revokeObjectURL(s.blobUrl);
    this.sheets.clear();
    this.key = key; this.videoId = vid;
    this.table = key ? BRV.decodeTable(key) : null;
    if (this.style) { this.style.remove(); this.style = null; }
    if (this.observer) { this.observer.disconnect(); this.observer = null; this.player = null; }
    if (!key) return;
    this.style = doc.createElement("style");
    this.style.className = "brv-previews";
    (doc.head || doc.documentElement).appendChild(this.style);
    this.writeRules();
  };

  // sélecteur des éléments qui affichent une planche de cette vidéo
  Previews.prototype.selector = function (path) {
    const part = this.videoId ? "/sb/" + this.videoId + "/" + (path || "") : path ? "/" + path : "/sb/";
    return "[style*=\"" + part + "\"]";
  };

  Previews.prototype.writeRules = function () {
    if (!this.style) return;
    // d'abord : noir tant que la planche n'est pas débrouillée ; ensuite, une règle par planche prête
    let css = this.selector("") + " { background-image: none !important; background-color: #000 !important; }\n";
    for (const [path, s] of this.sheets) {
      if (s.blobUrl) css += this.selector(path) + " { background-image: url(\"" + s.blobUrl + "\") !important; }\n";
    }
    this.style.textContent = css;
  };

  Previews.prototype.observe = function (player) {
    if (this.observer) this.observer.disconnect();
    this.player = player;
    if (!player) return;
    this.observer = new MutationObserver((list) => {
      for (const m of list) this.inspect(m.target);
    });
    this.observer.observe(player, { attributes: true, attributeFilter: ["style"], subtree: true, childList: true });
    for (const el of player.querySelectorAll("[style*=\"/sb/\"]")) this.inspect(el);
  };

  Previews.prototype.inspect = function (el) {
    if (!el || el.nodeType !== 1) return;
    const st = el.getAttribute("style");
    if (!st || st.indexOf("/sb/") < 0) {
      if (el.querySelectorAll) for (const e of el.querySelectorAll("[style*=\"/sb/\"]")) this.inspect(e);
      return;
    }
    const m = SB.exec(st);
    if (!m || (this.videoId && m[1] !== this.videoId)) return;
    const path = m[2] + "/" + m[3];
    if (this.sheets.has(path)) return;
    const url = /url\(\s*["']?([^"')]+)/.exec(st);
    if (!url) return;
    // disposition de la planche : la hauteur de l'élément est celle d'une vignette
    const cs = root.getComputedStyle(el);
    const bs = /([\d.]+)px\s+([\d.]+)px/.exec(cs.backgroundSize);
    const h = el.getBoundingClientRect().height;
    if (!bs || !h) return;                               // pas encore affiché : on réessaiera
    const cols = Math.max(1, Math.round(+bs[1] / (h * this.aspect))), rows = Math.max(1, Math.round(+bs[2] / h));
    const sheet = { state: "chargement", grid: [cols, rows] };
    this.sheets.set(path, sheet);
    this.decode(path, sheet, url[1].replace(/&amp;/g, "&"));
  };

  Previews.prototype.decode = async function (path, sheet, url) {
    const key = this.key;
    try {
      // i.ytimg.com autorise youtube.com à lire les pixels (Access-Control-Allow-Origin)
      const r = await fetch(url, { credentials: "omit", mode: "cors" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const bmp = await createImageBitmap(await r.blob());
      if (key !== this.key || this.sheets.get(path) !== sheet) return;
      const W = bmp.width, H = bmp.height;
      const cv = doc.createElement("canvas"); cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const src = ctx.getImageData(0, 0, W, H), out = ctx.createImageData(W, H);
      unscrambleSheet(src.data, out.data, W, H, sheet.grid[0], sheet.grid[1], this.table);
      ctx.putImageData(out, 0, 0);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      if (key !== this.key || this.sheets.get(path) !== sheet) return;
      sheet.blobUrl = URL.createObjectURL(blob);
      sheet.state = "prête";
      this.decoded++;
      this.writeRules();
    } catch (e) {
      sheet.state = "échec : " + e.message;
    }
  };

  // Débrouille chaque vignette (cols × rows) de la planche : même calcul que le shader de video.js
  // (bloc source, retournements, marge de 6 %, négatif), avec interpolation bilinéaire.
  function unscrambleSheet(S, D, W, H, cols, rows, table) {
    const cw = W / cols, ch = H / rows;
    for (let ty = 0; ty < rows; ty++) {
      const y0 = Math.round(ty * ch), y1 = Math.round((ty + 1) * ch), hh = y1 - y0;
      for (let tx = 0; tx < cols; tx++) {
        const x0 = Math.round(tx * cw), x1 = Math.round((tx + 1) * cw), ww = x1 - x0;
        // blocs de quelques pixels : la réduction de l'image a mêlé ~1 pixel de bloc voisin au
        // bord de chaque bloc ; on ne lit pas ce bord (le pixel juste à l'intérieur est répété)
        const lox = Math.min(0.45, Math.max(M, 1.1 * GX / ww)), loy = Math.min(0.45, Math.max(M, 1.1 * GY / hh));
        for (let y = 0; y < hh; y++) {
          const gy = (y + 0.5) / hh * GY, sy = Math.min(GY - 1, Math.floor(gy)), fy0 = gy - sy;
          for (let x = 0; x < ww; x++) {
            const gx = (x + 0.5) / ww * GX, sx = Math.min(GX - 1, Math.floor(gx));
            let fx = gx - sx, fy = fy0;
            const e = (sy * GX + sx) * 4, fl = table[e + 2];
            if (fl & 1) fx = 1 - fx;
            if (fl & 2) fy = 1 - fy;
            // position dans la vignette source (pixels), bornée à la vignette
            const bx = Math.min(1 - lox, Math.max(lox, M + fx * (1 - 2 * M)));
            const by = Math.min(1 - loy, Math.max(loy, M + fy * (1 - 2 * M)));
            const u = (table[e] + bx) / GX * ww - 0.5;
            const v = (table[e + 1] + by) / GY * hh - 0.5;
            const iu = Math.max(0, Math.min(ww - 2, Math.floor(u))), iv = Math.max(0, Math.min(hh - 2, Math.floor(v)));
            const au = Math.max(0, Math.min(1, u - iu)), av = Math.max(0, Math.min(1, v - iv));
            const p00 = ((y0 + iv) * W + x0 + iu) * 4, p10 = p00 + 4, p01 = p00 + W * 4, p11 = p01 + 4;
            const o = ((y0 + y) * W + x0 + x) * 4;
            for (let k = 0; k < 3; k++) {
              let val = (S[p00 + k] * (1 - au) + S[p10 + k] * au) * (1 - av) + (S[p01 + k] * (1 - au) + S[p11 + k] * au) * av;
              if (fl >= 4) val = 255 - val;
              D[o + k] = val;
            }
            D[o + 3] = 255;
          }
        }
      }
    }
  }

  Previews.prototype.report = function () {
    if (!this.key) return "";
    let ready = 0; for (const s of this.sheets.values()) if (s.blobUrl) ready++;
    const fail = [...this.sheets.values()].find((s) => /^échec/.test(s.state));
    return ready + " planche" + (ready > 1 ? "s" : "") + " d'aperçus débrouillée" + (ready > 1 ? "s" : "") + (fail ? " (" + fail.state + ")" : "");
  };

  root.BRVPreview = { Previews, unscrambleSheet };
})(typeof globalThis !== "undefined" ? globalThis : this);
