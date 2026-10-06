/* Script de la page : repère les vidéos, trouve la clé, pilote l'image et le son. */
(function (root) {
  "use strict";
  const BRV = root.BRV, api = root.BRVBrowser;
  const doc = root.document;
  const QR_SCAN_UNTIL = 1.2;           // secondes de vidéo analysées au début
  const QR_SIDE = 400;                // carré central (le QR code fait 90 % de la hauteur) : ~12 px par module
  const FIRST_FRAME = 0.03;           // la première image (celle du QR code) va de 0 à 1/fps s

  let settings = { enabled: true, manualKey: "" };
  // son de référence : morceaux reçus par le lecteur (page-hook.js), décodés avec leurs horodatages
  let refAudio = null;
  const mainVideoTime = () => {
    try { const c = mainController(); return c ? c.video.currentTime : 0; } catch (e) { return 0; }
  };
  // adresse « blob: » de la vidéo principale : désigne son flux de son parmi ceux de la page
  const mainVideoSrc = () => {
    try { const c = mainController(); return c ? c.video.currentSrc || c.video.src : ""; } catch (e) { return ""; }
  };
  if (root.BRVRefAudio) { refAudio = new root.BRVRefAudio.RefAudio(mainVideoTime, mainVideoSrc); refAudio.replay(); }
  const log = (...a) => { if (settings.debug) console.log("[BRV]", ...a); };
  const controllers = new Map();       // <video> → Controller
  // aperçus de la barre de lecture (planches d'images de YouTube), débrouillés eux aussi
  const previews = root.BRVPreview ? new root.BRVPreview.Previews() : null;

  function videoId() {
    const u = new URL(root.location.href);
    if (u.hostname.includes("youtube")) {
      if (u.searchParams.get("v")) return "yt:" + u.searchParams.get("v");
      const m = /\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
      if (m) return "yt:" + m[2];
    }
    return null;
  }

  function isAd(video) {
    const p = video.closest(".html5-video-player");
    return !!(p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")));
  }

  function Controller(video) {
    this.video = video;
    this.renderer = new root.BRVVideo.Renderer(video);
    this.audio = new root.BRVAudio.AudioLink(video, log);
    this.audio.ref = refAudio;
    this.id = null;
    this.key = null; this.version = 4; this.source = "";
    this.scanning = false;
    this.scanCanvas = null;
    this.fpsSamples = []; this.lastMediaTime = null; this.fps = 30;
    this.probing = false;
    this.frameLoop();
    // branché tôt : le bip du début est alors déjà dans l'historique quand la clé est trouvée
    const early = () => { if (settings.enabled) this.audio.connectIfAllowed(); };
    video.addEventListener("play", early);
    if (!video.paused) early();
    video.addEventListener("loadedmetadata", () => this.refresh());
    // vidée par le lecteur (changement de qualité : YouTube recrée son flux) : même vidéo si
    // l'adresse de la page n'a pas changé, on garde donc la clé
    video.addEventListener("emptied", () => this.refresh());
    // image du début affichée avant même la lecture (chargement, saut) : c'est celle du QR code
    const firstFrame = () => {
      if (this.scanning && settings.enabled && !this.probing && video.readyState >= 2 && video.currentTime < FIRST_FRAME) this.scanFrame(video.currentTime);
    };
    for (const n of ["loadeddata", "canplay", "seeked", "playing"]) video.addEventListener(n, firstFrame);
    this.refresh().then(firstFrame);
  }

  // identité de la vidéo : celle de YouTube, sinon l'adresse de la page (l'adresse interne du
  // flux, « blob:… », change à chaque changement de qualité)
  Controller.prototype.currentId = function () {
    const src = this.video.currentSrc || "";
    if (videoId()) return videoId();
    if (src && !src.startsWith("blob:")) return "src:" + src.split("#")[0];
    return "page:" + root.location.origin + root.location.pathname + root.location.search;
  };

  // nouvelle vidéo ? on reprend la clé mémorisée, sinon on cherche le QR code
  Controller.prototype.refresh = async function () {
    const id = this.currentId();
    if (id !== this.id) {
      this.id = id;
      this.audio.setVideo(id);
      this.key = null; this.source = ""; this.version = 4;
      const stored = (await api.storageGet({ ["cle:" + id]: null }))["cle:" + id];
      if (id !== this.id) return;
      if (stored && stored !== "aucune") {
        const [ver, key] = stored.split(":");
        this.key = key; this.version = +ver; this.source = "mémorisée";
      } else if (stored === "aucune") {
        this.source = "aucune";
      }
      // « aucune » (QR code non trouvé une fois) : le début est tout de même relu s'il est joué,
      // pour rattraper un QR code manqué ; mais on n'y revient plus exprès
      this.scanning = !this.key;
      if (this.scanning && this.source !== "aucune" && settings.enabled && this.video.currentTime > QR_SCAN_UNTIL && !this.video.paused) {
        this.probeStart();
      }
    }
    this.apply();
  };

  Controller.prototype.effectiveKey = function () {
    if (this.key) return { key: this.key, version: this.version, source: this.source };
    const mk = BRV.normalizeKey(settings.manualKey);
    if (mk && this.source === "aucune") return { key: mk, version: 4, source: "manuelle" };
    return null;
  };

  Controller.prototype.apply = function () {
    const k = this.effectiveKey();
    const active = settings.enabled && k && !isAd(this.video) && !this.renderer.error;
    this.active = !!active;
    this.renderer.setKey(active ? k.key : null);
    this.renderer.show(!!active || this.probing);
    this.audio.configure(active ? "decode" : "pass", active ? k.key : null, active ? k.version : 1);
  };

  // Première ouverture au milieu de la vidéo : retour un instant au début pour lire le QR code.
  Controller.prototype.probeStart = async function () {
    if (this.probing) return;
    this.probing = true;
    this.probedFor = this.id;
    const v = this.video, back = v.currentTime, id = this.id, wasPlaying = !v.paused;
    this.renderer.show(true); this.renderer.setKey(null);   // écran noir pendant la recherche
    try {
      if (wasPlaying) v.pause();                              // sinon l'image 0 passe aussitôt
      // le QR code est sur la première image (0 à 1/fps s) : on s'y place, puis un peu après
      // (anciennes vidéos à plusieurs images de QR code)
      for (const t of [0, 0.001, 0.05]) {
        if (this.key || id !== this.id) break;
        v.currentTime = t;
        await Promise.race([new Promise((r) => v.addEventListener("seeked", r, { once: true })),
                            new Promise((r) => setTimeout(r, 3000))]);
        for (let k = 0; k < 6 && !this.key; k++) {           // image pas toujours prête tout de suite
          await new Promise((r) => setTimeout(r, 100));
          if (v.readyState >= 2) this.scanFrame();
        }
      }
    } finally {
      if (!this.key && id === this.id) this.remember(null);
      if (id === this.id) v.currentTime = back;
      if (wasPlaying && id === this.id) v.play().catch(() => {});
      this.probing = false;
      this.apply();
    }
  };

  Controller.prototype.scanFrame = function (mediaTime) {
    const v = this.video;
    if (!v.videoWidth || typeof root.jsQR !== "function") return false;
    if (!this.scanCanvas) {
      this.scanCanvas = doc.createElement("canvas");
      this.scanCanvas.width = QR_SIDE; this.scanCanvas.height = QR_SIDE;
      this.scanCtx = this.scanCanvas.getContext("2d", { willReadFrequently: true });
    }
    try {
      // le QR code est centré : on n'analyse que le carré du milieu, en plus grand
      const vw = v.videoWidth, vh = v.videoHeight, side = Math.min(vw, vh);
      this.scanCtx.fillStyle = "#fff"; this.scanCtx.fillRect(0, 0, QR_SIDE, QR_SIDE);
      this.scanCtx.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, QR_SIDE, QR_SIDE);
      const img = this.scanCtx.getImageData(0, 0, QR_SIDE, QR_SIDE);
      // première image : ressemble-t-elle à un QR code (blanc et noir francs) ?
      if ((mediaTime !== undefined ? mediaTime : v.currentTime) < FIRST_FRAME) {
        this.sawFirst = this.id;
        let white = 0, black = 0;
        for (let i = 1; i < img.data.length; i += 4 * 7) { const g = img.data[i]; if (g > 190) white++; else if (g < 70) black++; }
        const n = img.data.length / 28;
        if (white > 0.3 * n && black > 0.15 * n) this.firstLooksQR = this.id;
      }
      const r = root.jsQR(img.data, QR_SIDE, QR_SIDE, { inversionAttempts: "dontInvert" });
      const found = r && BRV.parsePayload(r.data);
      if (found) {
        this.key = found.key; this.version = found.version; this.source = "QR code";
        this.scanning = false;
        this.remember(found);
        log("clé trouvée", found);
        this.apply();
        return true;
      }
    } catch (e) {
      log("lecture du QR code impossible", e);
      this.scanning = false;
    }
    return false;
  };

  Controller.prototype.remember = async function (found) {
    if (!this.id) return;
    const k = "cle:" + this.id, id = this.id;
    if (!found) {
      // QR code non relu (image pas encore prête, changement de qualité…) : on n'efface jamais
      // une clé déjà mémorisée pour cette vidéo
      const stored = (await api.storageGet({ [k]: null }))[k];
      if (id !== this.id) return;
      if (stored && stored !== "aucune") {
        const [ver, key] = stored.split(":");
        this.key = key; this.version = +ver; this.source = "mémorisée"; this.scanning = false;
        this.apply();
        return;
      }
      api.storageSet({ [k]: "aucune" });
      this.source = "aucune";
      this.apply();                      // clé manuelle éventuelle : elle s'applique maintenant
      return;
    }
    api.storageSet({ [k]: found.version + ":" + found.key });
  };

  // une image traitée exactement une fois, au rythme de la vidéo
  Controller.prototype.frameLoop = function () {
    const v = this.video;
    const onFrame = (now, meta) => {
      const t = meta ? meta.mediaTime : v.currentTime;
      if (this.lastMediaTime !== null) {
        const dt = t - this.lastMediaTime;
        if (dt > 0.004 && dt < 0.1) {
          this.fpsSamples.push(1 / dt);
          if (this.fpsSamples.length > 30) this.fpsSamples.shift();
          const s = this.fpsSamples.slice().sort((a, b) => a - b);
          this.fps = s[s.length >> 1];
        }
      }
      this.lastMediaTime = t;
      if (this.scanning && settings.enabled && t <= QR_SCAN_UNTIL && !this.probing) {
        this.scanFrame(t);
      } else if (this.scanning && t > QR_SCAN_UNTIL && !this.probing && !v.seeking) {
        // le QR code n'est que sur la première image, que le navigateur saute parfois au
        // démarrage : avant de conclure, on revient la regarder (une seule fois par vidéo)
        if (settings.enabled && this.probedFor !== this.id && this.source !== "aucune" && (this.sawFirst !== this.id || this.firstLooksQR === this.id)) this.probeStart();
        else { this.scanning = false; this.remember(null); this.apply(); }
      }
      if (isAd(v) !== this.wasAd) { this.wasAd = isAd(v); this.apply(); }
      if (this.active) this.renderer.draw(t, this.fps);
      schedule();
    };
    const schedule = () => {
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
      else root.requestAnimationFrame(() => onFrame(0, null));
    };
    schedule();
  };

  Controller.prototype.statusReport = function () {
    const k = this.effectiveKey();
    return {
      id: this.id,
      key: k ? k.key : null, version: k ? k.version : null, source: k ? k.source : this.source,
      active: this.active,
      ad: isAd(this.video),
      fps: Math.round(this.fps * 100) / 100,
      resolution: this.video.videoWidth ? this.video.videoWidth + "×" + this.video.videoHeight : "",
      audio: this.audio.status,
      audioInfo: this.audio.report(),
      error: this.renderer.error || "",
      previews: previews && this === mainController() ? previews.report() : "",
    };
  };

  function scan() {
    for (const v of doc.querySelectorAll("video")) {
      if (!controllers.has(v)) controllers.set(v, new Controller(v));
    }
    for (const c of controllers.values()) if (c.currentId() !== c.id) c.refresh();
    if (previews) previews.update(mainController());
  }

  function mainController() {
    let best = null, area = -1;
    for (const [v, c] of controllers) {
      if (!v.isConnected) continue;
      const a = v.offsetWidth * v.offsetHeight + (v.currentSrc ? 1 : 0);
      if (a > area) { area = a; best = c; }
    }
    return best;
  }

  api.storageGet({ enabled: true, manualKey: "", debug: false }).then((s) => {
    settings = s;
    scan();
    root.setInterval(scan, 1000);
    doc.addEventListener("yt-navigate-finish", () => setTimeout(scan, 100));
  });

  api.onStorage((ch) => {
    let changed = false;
    for (const k of ["enabled", "manualKey", "debug"]) {
      if (ch[k]) { settings[k] = ch[k].newValue; changed = true; }
    }
    if (changed) for (const c of controllers.values()) c.apply();
  });

  api.onMessage((msg) => {
    if (msg && msg.type === "brv-status") {
      // YouTube contient des cadres sans vidéo : seul celui qui a la vidéo répond
      const c = mainController();
      return c ? c.statusReport() : undefined;
    }
    if (msg && msg.type === "brv-forget") {
      const c = mainController();
      if (c && c.id) {
        api.storageSet({ ["cle:" + c.id]: null });
        c.id = null; c.refresh();
      }
      return { ok: true };
    }
    return undefined;
  });

  // accès pour les tests automatiques (page locale uniquement)
  root.addEventListener("message", (e) => {
    if (!e.data || e.data.brvTest !== "refinfo" || /^(localhost|127\.0\.0\.1)$/.test(root.location.hostname)) return;
    const r = refAudio, ch = r ? r.chunks : [], c = mainController();
    root.postMessage({ brvTestReply: { raw: r && r.rawConfig, status: r && r.status, n: ch.length, format: r && r.formatKey, counts: r && r.counts,
      first: ch.length ? ch[0].t : null, last: ch.length ? ch[ch.length - 1].t : null,
      log: c ? c.audio.lastLog : [], audio: c ? c.audio.status : null, key: c ? c.key : null,
      source: c ? c.source : null, probed: c ? c.probedFor === c.id : null, previews: previews ? previews.report() : "",
      resyncLog: r ? [...r.tracks.values()].map((t) => t.parser.resyncLog || []) : [] } }, "*");
  });
  // diagnostic : le son joué correspond-il à la référence, et à quel décalage ? (toute page)
  root.addEventListener("message", async (e) => {
    if (!e.data || e.data.brvTest !== "refmatch") return;
    const c = mainController();
    if (!c || !c.audio.port || !refAudio) { root.postMessage({ brvTestReply: null }, "*"); return; }
    const n = 12288, snap = await c.audio.snapshot(null, n);
    const t = c.video.currentTime, guess = t - n / 48000 - 0.05;
    const r = snap.data.length >= n ? refAudio.locate(snap.data, guess, 0.5) : null;
    root.postMessage({ brvTestReply: { t, quality: r ? r.quality : null, offset: r ? r.t - guess : null } }, "*");
  });
  if (/^(localhost|127\.0\.0\.1)$/.test(root.location.hostname)) {
    root.addEventListener("message", async (e) => {
      if (!e.data || !e.data.brvTest) return;
      const c = mainController();
      if (e.data.brvTest === "status") root.postMessage({ brvTestReply: c ? c.statusReport() : null }, "*");
      if (e.data.brvTest && e.data.brvTest.refget) {
        const g = refAudio ? refAudio.get(e.data.brvTest.refget[0], e.data.brvTest.refget[1]) : null;
        root.postMessage({ brvTestReply: g ? Array.from(g) : null }, "*");
      }
      if (e.data.brvTest === "refinfo") {
        const r = refAudio, ch = r ? r.chunks : [];
        root.postMessage({ brvTestReply: { counts: r && r.counts, status: r && r.status, n: ch.length, first: ch.length ? ch[0].t : null,
          last: ch.length ? ch[ch.length - 1].end : null, format: r && r.formatKey,
          log: c ? c.audio.lastLog : [], key: c ? c.key : null, source: c ? c.source : null, mode: c ? c.audio.mode : null,
          useRef: c ? c.audio.useRef() : null, locked: c ? c.audio.lockedAt : null } }, "*");
      }
      if (e.data.brvTest === "state" && c && c.audio.port) {
        root.postMessage({ brvTestReply: await c.audio.state() }, "*");
      }
      if (e.data.brvTest === "insnap" && c && c.audio.port) {
        const n = 48000 * 5, from = (c.audio.lastCount || 0) - n;
        const r = await c.audio.snapshot(from, n);
        root.postMessage({ brvTestReply: { from, data: Array.from(r.data), log: c.audio.lastLog, onsets: c.audio.onsetLog || [] } }, "*");
      }
      if (e.data.brvTest === "beepsnap" && c) {
        const b = c.audio.lastSnap;
        root.postMessage({ brvTestReply: b ? { from: b.from, index: b.index, T: b.T, data: Array.from(b.data) } : null }, "*");
      }
      if (e.data.brvTest === "fedsnap" && c && c.audio.port) {
        const r = await c.audio.fedSnap();
        root.postMessage({ brvTestReply: { from: r.from, fed: r.fed, data: Array.from(r.data), c: c.audio.refDelays } }, "*");
      }
      if (e.data.brvTest === "outsnap" && c && c.audio.port) {
        const r = await c.audio.outputSnapshot();
        root.postMessage({ brvTestReply: { data: Array.from(r.data), count: r.count } }, "*");
      }
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
