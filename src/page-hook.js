/* Exécuté dans la page elle-même (monde « MAIN »), avant les scripts de YouTube.
 * Copie les morceaux de SON que le lecteur transmet au navigateur (Media Source Extensions),
 * pour que l'extension puisse les décoder elle-même avec leurs horodatages exacts.
 * Rien n'est modifié : les données passent au navigateur exactement comme avant.
 *
 * Le lecteur de YouTube prépare souvent son flux de son avant que le reste de l'extension soit
 * chargé : on garde donc l'en-tête (segment d'initialisation) de chaque flux, et on le renvoie
 * quand l'extension le demande. */
(function () {
  "use strict";
  if (window.__brvHook) return;
  window.__brvHook = true;
  let nextId = 1;
  const stats = window.__brvStats = { sourceBuffers: [], audioAppends: 0, errors: 0 };
  const audio = [];                  // { id, mime, init } des flux de son connus
  const post = (m, transfer) => { try { window.postMessage({ __brv: m }, "*", transfer || []); } catch (e) { stats.errors++; } };

  // l'en-tête commence par la signature EBML (WebM) ou par une boîte ftyp / moov (MP4)
  function isInit(u8) {
    if (u8.length < 8) return false;
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return true;
    const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return t === "ftyp" || t === "moov";
  }

  function hookMediaSource(MS) {
    if (!MS || !MS.prototype || MS.prototype.__brvHooked) return;
    MS.prototype.__brvHooked = true;
    const add = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (mime) {
      const sb = add.apply(this, arguments);
      stats.sourceBuffers.push(String(mime));
      try {
        if (/^audio\//i.test(String(mime))) {
          sb.__brv = { id: nextId++, mime: String(mime), init: null, ms: this };
          audio.push(sb.__brv);
          if (audio.length > 8) audio.shift();
          post({ kind: "init", id: sb.__brv.id, mime: sb.__brv.mime });
        }
      } catch (e) { /* rien */ }
      return sb;
    };
  }
  hookMediaSource(window.MediaSource);
  hookMediaSource(window.ManagedMediaSource);

  // adresse « blob: » donnée à chaque MediaSource : elle devient le src de la vidéo qui la lit,
  // ce qui permet à l'extension de savoir quel flux de son appartient à la vidéo principale
  const cou = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const u = cou.apply(this, arguments);
    try {
      if (obj && ((window.MediaSource && obj instanceof window.MediaSource) ||
                  (window.ManagedMediaSource && obj instanceof window.ManagedMediaSource))) obj.__brvUrl = u;
    } catch (e) { /* rien */ }
    return u;
  };
  const urlOf = (info) => { try { return (info.ms && info.ms.__brvUrl) || ""; } catch (e) { return ""; } };

  const SB = window.SourceBuffer && window.SourceBuffer.prototype;
  if (SB) {
    const append = SB.appendBuffer;
    SB.appendBuffer = function (data) {
      const info = this.__brv;
      let copy = null, offset = 0, mode = "segments";
      if (info) {
        // décalage appliqué par le navigateur aux horodatages de ce morceau (raccord de flux)
        try { offset = this.timestampOffset || 0; mode = this.mode; } catch (e) { /* rien */ }
        try {
          const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
                   : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          copy = u8.slice();
        } catch (e) { stats.errors++; }
      }
      // D'abord le navigateur : s'il refuse le morceau (mémoire tampon pleine, fréquent en haute
      // définition), le lecteur le renverra plus tard. Le copier maintenant le compterait deux fois
      // et décalerait toute la lecture du flux.
      const result = append.apply(this, arguments);
      if (copy) {
        stats.audioAppends++;
        // relevé des derniers envois (diagnostic) : taille, premiers octets, décalage, position
        try {
          const a = stats.appends || (stats.appends = []);
          a.push([copy.length, Array.from(copy.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(""),
                  offset, Math.round(performance.now())]);
          if (a.length > 400) a.shift();
          if (window.__brvCapture) (stats.capture || (stats.capture = [])).push(copy.slice());   // tests seulement
        } catch (e) { /* rien */ }
        try {
          if (isInit(copy)) info.init = copy.slice();
          post({ kind: "data", id: info.id, mime: info.mime, url: urlOf(info), offset, mode, bytes: copy.buffer }, [copy.buffer]);
        } catch (e) { stats.errors++; }
      }
      return result;
    };
    const abort = SB.abort;
    SB.abort = function () {
      if (this.__brv) post({ kind: "abort", id: this.__brv.id });
      return abort.apply(this, arguments);
    };
    const change = SB.changeType;
    if (change) SB.changeType = function (mime) {
      if (this.__brv) {
        stats.changes = (stats.changes || 0) + 1;
        this.__brv.mime = String(mime); this.__brv.init = null;
        post({ kind: "init", id: this.__brv.id, mime: String(mime) });
      }
      return change.apply(this, arguments);
    };
  }

  // l'extension (chargée plus tard) demande ce qu'elle a manqué
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__brvReplay !== true) return;
    // marqués « replay » : l'extension ne s'en sert que si elle n'a encore rien reçu de ce flux
    // (sinon cet en-tête tomberait au milieu du son en cours et décalerait sa lecture)
    for (const a of audio) {
      post({ kind: "init", id: a.id, mime: a.mime, replay: true });
      if (a.init) { const c = a.init.slice(); post({ kind: "data", id: a.id, mime: a.mime, url: urlOf(a), replay: true, bytes: c.buffer }, [c.buffer]); }
    }
  });
})();
