/* Son : branchement de la vidéo sur Web Audio et calage du débrouillage.
 *
 * Le son de l'élément <video> passe par un module audio (AudioWorklet) à 48 kHz.
 * Calage (relier les échantillons reçus à la position dans le son publié) :
 *   - lecture depuis le début : le bip de repère (0 – 50 ms) donne la position exacte ;
 *     on en déduit aussi le retard interne du navigateur (« biais »), mémorisé ;
 *   - reprise après une pause, un saut ou une attente : le son reprend après un silence ;
 *     sa reprise correspond à video.currentTime, corrigé du biais mémorisé.
 * Un branchement est définitif : sans clé ou décodage coupé, le module laisse passer le son. */
(function (root) {
  "use strict";
  const BRV = root.BRV;
  const RATE = 48000;
  const api = root.BRVBrowser;

  // bip de repère : glissando 500 → 5000 Hz, 50 ms, enveloppe de Hann, amplitude 0,5
  function beepTemplate() {
    const n = 2400, T = n / RATE, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const ph = 2 * Math.PI * (500 * t + 4500 * t * t / (2 * T));
      out[i] = 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))) * Math.sin(ph);
    }
    return out;
  }

  // filtre passe-bas 3 kHz (la partie du bip que tous les codecs gardent fidèlement)
  function lowpass(x) {
    const taps = 63, h = new Float32Array(taps), fc = 3000 / RATE;
    let s = 0;
    for (let k = 0; k < taps; k++) {
      const m = k - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      h[k] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * k / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * k / (taps - 1)));
      s += h[k];
    }
    const y = new Float32Array(x.length), half = (taps - 1) / 2;
    for (let i = 0; i < x.length; i++) {
      let v = 0;
      for (let k = 0; k < taps; k++) { const j = i + k - half; if (j >= 0 && j < x.length) v += x[j] * h[k]; }
      y[i] = v / s;
    }
    return y;
  }

  // position (réelle) du bip dans x, ou null
  function findBeep(x, minQuality) {
    const tpl = lowpass(beepTemplate());
    const y = lowpass(x);
    const n = tpl.length;
    let tn = 0;
    for (let i = 0; i < n; i++) tn += tpl[i] * tpl[i];
    const c = new Float32Array(Math.max(0, y.length - n));
    // énergie glissante (en double, recalculée régulièrement pour éviter la dérive)
    const floor = n * 1e-7;                                  // extraits quasi muets ignorés
    let best = -1, bestQ = 0, energy = 0;
    for (let lag = 0; lag < c.length; lag++) {
      if (lag % 2048 === 0) { energy = 0; for (let i = 0; i < n; i++) energy += y[lag + i] * y[lag + i]; }
      let s = 0;
      for (let i = 0; i < n; i++) s += y[lag + i] * tpl[i];
      c[lag] = s;
      if (energy > floor) {
        const q = s / Math.sqrt(tn * energy);                // corrélation normalisée à cet endroit
        if (q > bestQ) { bestQ = q; best = lag; }
      }
      energy += y[lag + n] * y[lag + n] - y[lag] * y[lag];
    }
    if (best <= 0 || best >= c.length - 1) return null;
    let en = 0;
    for (let i = 0; i < n; i++) en += y[best + i] * y[best + i];
    const quality = c[best] / Math.sqrt(tn * en + 1e-20);    // vérification exacte
    if (quality < (minQuality || 0.5)) return null;
    const a = c[best - 1], b = c[best], e = c[best + 1], den = a - 2 * b + e;
    return { pos: best + (den ? 0.5 * (a - e) / den : 0), quality };
  }

  // position (réelle, en échantillons du son publié) du premier échantillon de seg dans le bip
  function locateInBeep(seg) {
    const tpl = beepTemplate(), n = Math.min(seg.length, 1200);
    let sn = 0;
    for (let i = 0; i < n; i++) sn += seg[i] * seg[i];
    const c = new Float64Array(tpl.length - n + 1);
    let best = -1, bestQ = 0;
    for (let lag = 0; lag < c.length; lag++) {
      let s = 0, tn = 0;
      for (let i = 0; i < n; i++) { s += seg[i] * tpl[lag + i]; tn += tpl[lag + i] * tpl[lag + i]; }
      c[lag] = s;
      const q = s / Math.sqrt(sn * tn + 1e-20);
      if (q > bestQ) { bestQ = q; best = lag; }
    }
    if (best <= 0 || best >= c.length - 1 || bestQ < 0.9) return null;
    const a = c[best - 1], b = c[best], e = c[best + 1], den = a - 2 * b + e;
    return { pos: best + (den ? 0.5 * (a - e) / den : 0), quality: bestQ };
  }

  const CALIB_T = 0.02;            // saut au milieu du bip pour mesurer le décalage après un saut

  function AudioLink(video, log) {
    this.video = video;
    this.log = log || function () {};
    this.ctx = null; this.node = null; this.port = null; this.ready = null;
    this.path = "";
    this.mode = "pass";
    this.key = null; this.version = 1;
    this.status = "son non branché";
    this.snapId = 0; this.snapWait = new Map();
    this.bias = 0; this.biasKnown = false;
    this.expectT = null;          // position (s) de la vidéo à la prochaine reprise du son
    this.selfSeekTried = false;
    this.calibration = null;      // { back } : retour au début pour mesurer le décalage
    this.lockedAt = null;
    this.lastLog = [];
    this.videoId = null;
    const ev = (name, fn) => video.addEventListener(name, fn);
    for (const n of ["seeking", "seeked", "pause", "play", "playing", "waiting", "canplay"]) {
      video.addEventListener(n, () => { if (this.port) this.port.postMessage({ type: "mark", label: n + "@" + video.currentTime.toFixed(3) }); });
    }
    // La reprise du son après un silence (saut, pause, attente) donne un repère précis :
    // on se met à l'écoute dès le début de l'événement, avec la position qui correspondra.
    // position du compteur d'échantillons au dernier saut : une reprise du son détectée avant
    // appartient à l'ancienne position et ne doit pas servir de repère
    ev("seeking", () => { this.seekMark = this.lastCount; this.seekTo = video.currentTime; this.pauseMap = null; this.unlock("saut"); this.arm(video.currentTime); });
    // pause ou attente : le son reprendra exactement là où il s'arrête ; on garde le calage en cours
    // (mode « joué ») pour en déduire la position à la reprise
    const holdLock = () => { const l = this.lockedAt; this.pauseMap = l && !l.ref ? { base: l.i0 - l.p0, at: this.lastCount } : null; };
    ev("pause", () => { holdLock(); this.unlock("pause"); this.arm(video.currentTime); });
    ev("play", () => { if (this.expectT === null) this.arm(video.currentTime); });
    ev("waiting", () => { holdLock(); this.unlock("attente"); this.arm(video.currentTime); });
    // si le calage par la référence échoue, on ne reste jamais muet : relockNow réessaie
    const refOrRelock = async (why) => { if (!(await this.refLock(why)) && !video.paused && !this.lockedAt) this.relockNow(); };
    ev("playing", () => { if (this.useRef()) refOrRelock("reprise"); else if (this.expectT === null && !this.lockedAt) this.relockNow(); });
    ev("seeked", () => { if (!video.paused && this.useRef()) refOrRelock("saut"); });
    ev("emptied", () => this.unlock("nouvelle vidéo"));
    ev("ratechange", () => this.onRate());
  }

  AudioLink.prototype.note = function (msg) {
    this.log(msg);
    this.lastLog.push(msg);
    if (this.lastLog.length > 30) this.lastLog.shift();
  };

  // Graphe (une seule fois par élément) : vidéo → module audio → haut-parleurs.
  // Branché tout de suite : tant que le navigateur bloque le son, la vidéo est muette
  // (plutôt que de laisser entendre le son brouillé).
  AudioLink.prototype.connect = function () {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "playback" });
      this.ctx = ctx;
      let node = null;
      const url = api.url("src/worklet.js");
      const attempts = [["module audio", () => ctx.audioWorklet.addModule(url)],
                        ["module audio (blob)", async () => {
                          const code = await (await fetch(url)).text();
                          return ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
                        }]];
      for (const [name, attempt] of attempts) {
        try {
          await attempt();
          node = new AudioWorkletNode(ctx, "brv-decoder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          this.path = name;
          break;
        } catch (e) { this.note(name + " refusé : " + e.message); }
      }
      let port;
      if (node) {
        port = node.port;
        port.onmessage = (e) => this.onMessage(e.data);
      } else {
        // secours : ScriptProcessor (fil principal), même traitement
        node = ctx.createScriptProcessor(1024, 2, 2);
        const core = new root.BRVProcessorCore((m) => this.onMessage(m));
        node.onaudioprocess = (e) => {
          const ib = e.inputBuffer, ob = e.outputBuffer;
          const ins = [ib.getChannelData(0), ib.getChannelData(ib.numberOfChannels > 1 ? 1 : 0)];
          const outs = [ob.getChannelData(0), ob.getChannelData(1)];
          for (let off = 0; off < 1024; off += 128) {
            core.process(ins.map((a) => a.subarray(off, off + 128)), outs.map((a) => a.subarray(off, off + 128)), 128);
          }
        };
        port = { postMessage: (m) => core.message(m) };
        this.path = "secours ScriptProcessor";
      }
      const src = ctx.createMediaElementSource(this.video);
      src.connect(node);
      node.connect(ctx.destination);
      this.node = node; this.port = port;
      this.video.preservesPitch = false; this.video.mozPreservesPitch = false;
      this.sendConfig();
      // début de lecture : on guette l'arrivée du son (le bip), qui sert de repère
      if (this.video.currentTime < 0.3) this.arm(this.video.currentTime);
      this.resumeContext();
      return true;
    })();
    return this.ready;
  };

  // Branche le son seulement si le navigateur l'autorise déjà (sinon une vidéo normale
  // deviendrait muette jusqu'au premier clic).
  AudioLink.prototype.connectIfAllowed = async function () {
    if (this.ready) return;
    try {
      const probe = new AudioContext();
      await Promise.race([probe.resume(), new Promise((r) => setTimeout(r, 200))]);
      const ok = probe.state === "running";
      probe.close();
      if (ok) this.connect();
    } catch (e) { /* rien */ }
  };

  AudioLink.prototype.resumeContext = function () {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running") return;
    ctx.resume().catch(() => {});
    if (this.waitingGesture) return;
    this.waitingGesture = true;
    const go = () => ctx.resume().then(() => {
      if (ctx.state === "running") {
        this.waitingGesture = false;
        ["pointerdown", "keydown"].forEach((t) => root.document.removeEventListener(t, go, true));
        this.note("son autorisé par le navigateur");
        if (this.mode === "decode" && !this.video.paused) this.relockNow();
      }
    });
    ["pointerdown", "keydown"].forEach((t) => root.document.addEventListener(t, go, true));
    setTimeout(() => {
      if (ctx.state !== "running") this.status = "cliquez sur la page pour activer le son (bloqué par le navigateur)";
    }, 300);
  };

  AudioLink.prototype.configure = function (mode, key, version) {
    const was = this.mode;
    if (mode !== was) this.note("mode : " + was + " → " + mode);
    this.mode = mode; this.key = key; this.version = version;
    // BRV2 n'est débrouillable qu'avec le son de référence (il a besoin du son à venir)
    if (this.mode !== "decode") { this.sendConfig(); return; }
    this.connect().then(() => {
      this.sendConfig();
      if (was !== "decode" && !this.video.paused && !this.lockedAt) this.relockNow();
    });
  };

  AudioLink.prototype.sendConfig = function () {
    if (!this.port) return;
    const mode = this.mode === "decode" && this.video.playbackRate !== 1 ? "mute" : this.mode;
    this.port.postMessage({ type: "config", key: this.key, version: this.version, mode });
    if (mode === "pass") this.status = "son laissé tel quel";
    if (mode === "mute") this.status = "son coupé : décodage seulement à la vitesse ×1";
  };

  AudioLink.prototype.onRate = function () {
    this.sendConfig();
    if (this.video.playbackRate === 1 && this.mode === "decode" && !this.video.paused) this.relockNow();
  };

  AudioLink.prototype.unlock = function (why) {
    this.lockedAt = null;
    this.feedNext = null;
    if (!this.port) return;
    this.port.postMessage({ type: "unlock" });
    if (this.mode === "decode") this.status = "calage du son… (" + why + ")";
  };

  // écoute de la prochaine reprise du son, qui correspondra à la position T de la vidéo
  AudioLink.prototype.arm = function (T) {
    this.expectT = T;
    if (!this.port) return;
    this.port.postMessage({ type: "watchOnset" });   // aussi sans clé : sert à mesurer le décalage
    if (this.mode !== "decode") return;
    this.port.postMessage({ type: "unlock" });
    this.lockedAt = null;
    this.status = "calage du son…";
  };

  // Calage en pleine lecture : il faut un repère.
  //  - près du début : le bip est peut-être déjà dans l'historique reçu ; sinon retour à 0 ;
  //  - décalage du navigateur jamais mesuré : retour un instant au début pour le mesurer ;
  //  - sinon : micro-saut sur place, qui interrompt le son et donne une reprise nette.
  // un seul recalage à la fois : deux en parallèle se contrediraient (l'un saute au début pendant
  // que l'autre vient de caler le son)
  AudioLink.prototype.relockNow = async function () {
    if (this.relocking) return;
    this.relocking = true;
    try { await this.relockNowInner(); } finally { this.relocking = false; }
  };

  AudioLink.prototype.relockNowInner = async function () {
    this.note("recalage demandé (port " + !!this.port + ", mode " + this.mode + ", référence " + this.useRef() + ", calé " + !!this.lockedAt + ")");
    if (!this.port || this.mode !== "decode") return;
    if (this.useRef() && await this.refLock("démarrage")) return;
    // un autre calage (reprise du son, bip) a pu réussir pendant nos attentes : on s'arrête alors
    const lockBefore = this.lockedAt;
    const overtaken = () => this.lockedAt && this.lockedAt !== lockBefore;
    if (this.version === 2) {                              // pas de référence : BRV2 impossible (BRV4 : calage sur le bip)
      this.status = "BRV" + this.version + " : en attente du son de référence (vidéo lue hors du lecteur YouTube ?)";
      if (!this.v2Wait) this.v2Wait = setTimeout(() => { this.v2Wait = null; this.relockNow(); }, 1000);
      return;
    }
    const v = this.video;
    // mesure en cours (saut au début) : on attend la reprise du son, sans la relancer ni perdre
    // la position où revenir ; au-delà de 3 s, on abandonne et on y revient
    if (this.calibration) {
      if (Date.now() - this.calibration.at < 3000) return;
      const back = this.calibration.back; this.calibration = null;
      this.note("mesure du décalage abandonnée");
      if (back !== null) { v.currentTime = back; return; }
    }
    this.seekTries = (this.seekTries || 0) + 1;
    if (v.currentTime < 3) {
      // le son n'a pas encore commencé : sa reprise (le bip) fera le calage
      if (this.expectT !== null && this.expectT < 0.3 && !this.startOnset) { this.seekTries--; return; }
      let snap = null;
      for (let t = 0; t < 10; t++) {                // au moins 0,3 s de son reçu (bip complet)
        snap = await this.snapshot(null, 48000 * 4);
        if (overtaken()) return;
        // 0,3 s de SON reçu (le silence d'avant le démarrage ne compte pas) : le bip est alors complet
        let first = 0;
        while (first < snap.data.length && Math.abs(snap.data[first]) < 1e-5) first++;
        if (snap.data.length - first >= 14400) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (overtaken()) return;
      const b = findBeep(snap.data, 0.9);
      this.note("historique : " + snap.data.length + " éch. depuis " + snap.from + ", bip " +
                (b ? "à " + (snap.from + b.pos).toFixed(1) + " (qualité " + b.quality.toFixed(3) + ")" : "absent") +
                ", mode " + this.mode + ", pause " + v.paused);
      if (b && this.mode === "decode" && !v.paused) {
        const beepAt = snap.from + b.pos;
        const o = this.startOnset;
        if (o && o.T < 0.3 && Math.abs(o.index - beepAt) < 4800) this.learnBias((o.index - beepAt) - o.T * RATE);
        const at = snap.from + snap.data.length;
        this.seekTries = 0;
        this.doLock(at, at - beepAt, "bip de repère");
        return;
      }
    }
    if (this.seekTries > 3) { this.doLock(this.lastCount || 0, v.currentTime * RATE + this.bias, "estimé (peu précis)"); return; }
    if (v.currentTime < 3 || !this.biasKnown) {
      const cal = this.calibration = { back: v.currentTime < 0.3 ? null : v.currentTime, at: Date.now() };
      setTimeout(() => { if (this.calibration === cal && !v.paused) this.relockNow(); }, 3200);
      this.note("mesure du décalage du son : saut un instant au début");
      v.currentTime = CALIB_T;
    } else {
      this.note("micro-saut sur place pour caler le son");
      v.currentTime = v.currentTime;
    }
  };

  AudioLink.prototype.setVideo = function (id) {
    if (id === this.videoId) return;
    this.videoId = id;
    this.bias = 0; this.biasKnown = false;
    api.storageGet({ ["biais:" + id]: null }).then((v) => {
      const b = v["biais:" + id];
      if (id === this.videoId && typeof b === "number") { this.bias = b; this.biasKnown = true; }
    });
  };

  AudioLink.prototype.learnBias = function (value) {
    this.bias = value;
    this.biasKnown = true;
    if (this.videoId) api.storageSet({ ["biais:" + this.videoId]: value });
    this.note("décalage du son après un saut : " + value.toFixed(2) + " éch.");
  };

  // ------------------------------------------------------------ calage par le son de référence
  // (morceaux de son reçus par le lecteur, décodés par refaudio.js avec leurs horodatages)
  AudioLink.prototype.useRef = function () {
    return !!(this.ref && this.ref.available() && this.port && this.mode === "decode");
  };

  // décalage entre l'horodatage de la référence et le son publié (amorce du codec), par format
  AudioLink.prototype.refDelay = async function () {
    const fk = this.ref.formatKey || "?";
    if (this.refDelays && fk in this.refDelays) return this.refDelays[fk];
    const st = await api.storageGet({ refDelays: {} });
    this.refDelays = st.refDelays || {};
    if (fk in this.refDelays) return this.refDelays[fk];
    // le début de la vidéo est-il dans la référence ? le bip y commence à la position publiée 0
    const head = this.ref.get(0, 48000 * 0.4);
    if (head) {
      const b = findBeep(head, 0.8);
      if (b) {
        this.refDelays[fk] = -b.pos;
        api.storageSet({ refDelays: this.refDelays });
        this.note("décalage de la référence (" + fk + ") : " + (-b.pos).toFixed(2) + " éch.");
        return -b.pos;
      }
    }
    return null;
  };

  AudioLink.prototype.refLock = async function (why) {
    try { return await this.refLockInner(why); }
    catch (e) { this.note("erreur de calage : " + e.message + " " + (e.stack || "").split("\n")[1]); return false; }
  };

  AudioLink.prototype.refLockInner = async function (why) {
    if (!this.useRef()) return false;
    const token = this.refToken = (this.refToken || 0) + 1;
    await new Promise((r) => setTimeout(r, 300));            // 0,3 s de son joué
    if (token !== this.refToken || !this.useRef() || this.video.paused) { this.note("calage abandonné (" + (token !== this.refToken ? "remplacé" : this.video.paused ? "pause" : "référence") + ")"); return true; }
    if (await this.beepLockRef()) {
      if (token !== this.refToken) return true;
      this.refTries = 0;
      clearTimeout(this.refTimer);
      this.refTimer = setTimeout(() => this.refCheck(), 5000);
      return true;
    }
    if (token !== this.refToken) return true;
    // extrait plus long à chaque échec (un passage calme se reconnaît sur 1 – 2 s, pas sur 0,26 s),
    // sans remonter avant la reprise du son
    const tries = this.refTries || 0, span = [0.35, 0.35, 1.5, 1.5, 4, 4][tries % 6];
    const since = this.lastResumeMark !== undefined && this.lastCount !== undefined ? this.lastCount - this.lastResumeMark - 4800 : Infinity;
    let n = 12288;
    while (n < (span > 2 ? 49152 : 98304) && n * 2 <= since && n < 12288 << Math.min(tries, 3)) n *= 2;
    let snap = await this.snapshot(null, n);
    for (let t = 0; t < 20 && snap.data.length < n && token === this.refToken; t++) {   // pas encore assez de son
      await new Promise((r) => setTimeout(r, 150));
      snap = await this.snapshot(null, n);
    }
    if (token !== this.refToken || snap.data.length < n) { this.note("calage abandonné (extrait " + snap.data.length + ")"); return true; }
    let e = 0; for (let i = 0; i < n; i++) e += snap.data[i] * snap.data[i];
    if (e < 1e-10) { this.status = "son trop faible pour le calage (volume à zéro ?)"; setTimeout(() => { if (token === this.refToken) this.refLock("volume"); }, 1000); return true; }
    const guess = this.video.currentTime - n / RATE - 0.05;
    // recherche près de la position de la vidéo, puis de plus en plus large si les essais échouent
    // (son joué décalé par rapport à l'image : sortie audio lente, casque Bluetooth…)
    const r = this.ref.locate(snap.data, guess, span);
    if (r && r.quality >= 0.8 && Math.abs(r.t - guess) > 0.3) {
      this.note("son joué trouvé à " + (r.t - guess >= 0 ? "+" : "") + (r.t - guess).toFixed(2) + " s de la position attendue (ressemblance " + r.quality.toFixed(2) + ")");
    }
    if (!r || r.quality < 0.8) {
      // juste après une reprise, l'extrait peut mêler silence et ancien son : on réessaie
      this.refTries = (this.refTries || 0) + 1;
      const ch = this.ref.chunks, near = ch.filter((c) => c.end > guess - 1 && c.t < guess + 1).length;
      this.note("calage par la référence impossible" + (r ? " (ressemblance " + r.quality.toFixed(2) + ", recherche ±" + span + " s)" : " (référence absente ici)") +
                " [vers " + guess.toFixed(2) + " s ; extrait " + (n / RATE).toFixed(2) + " s ; référence " + (ch.length ? ch[0].t.toFixed(1) + "–" + ch[ch.length - 1].end.toFixed(1) + " s, " + near + " morceaux proches" : "vide") + "]" +
                (this.refTries <= 6 || r ? ", nouvel essai" : ""));
      // référence présente mais son trop calme ou ambigu : on réessaie sans fin, avec des extraits
      // plus longs (le son finit par devenir reconnaissable) ; sauter ailleurs n'aiderait pas
      if (this.refTries <= 6 || r) {
        if (this.refTries > 6) this.status = "calage du son… (passage trop calme, nouvel essai)";
        setTimeout(() => { if (token === this.refToken) this.refLock(why); }, this.refTries <= 6 ? 400 : 1000);
        return true;
      }
      this.refTries = 0;
      return false;
    }
    this.refTries = 0;
    let c = await this.refDelay();
    if (token !== this.refToken) return true;
    if (c === null) {
      // début de la vidéo jamais reçu pour ce format : on y va un instant pour mesurer
      if (!this.calibration) {
        this.calibration = { back: this.video.currentTime, at: Date.now() };
        this.note("mesure de l'amorce du codec : retour un instant au début");
        this.video.currentTime = 0;
      }
      return true;
    }
    if (this.calibration) {
      const back = this.calibration.back; this.calibration = null;
      if (back > 1) { this.video.currentTime = back; return true; }
    }
    const p0 = r.t * RATE + c;
    this.lockedByRef = { i0: snap.from, p0, t: r.t };
    this.doLockRef(snap.from, p0, "référence (" + why + ", ressemblance " + r.quality.toFixed(3) + ")");
    clearTimeout(this.refTimer);
    this.refTimer = setTimeout(() => this.refCheck(), 5000);
    return true;
  };

  // Lecture partie du début : le bip de repère (fort, quel que soit le son de la vidéo) donne la
  // position exacte. La comparaison avec la référence échoue, elle, sur un début très calme :
  // 0,3 s après le départ, le bip est déjà sorti de l'extrait comparé.
  AudioLink.prototype.beepLockRef = async function () {
    const v = this.video;
    // pas après un saut ailleurs qu'au début (un saut au milieu du bip n'en joue qu'une partie)
    if (v.currentTime > 3 || (this.seekTo !== undefined && this.seekTo > 0.005)) return false;
    const T = v.currentTime;
    const len = Math.min(this.lastCount || 0, Math.round((T + 0.8) * RATE) + 2400);
    if (len < 4800) return false;
    const snap = await this.snapshot(null, len);
    const end = snap.from + snap.data.length;
    // le bip a été joué vers end − T (plus le retard de la sortie du son) : recherche à ± 0,6 s
    const expect = snap.data.length - Math.round(T * RATE);
    const a = Math.max(0, expect - 28800), b = Math.min(snap.data.length, expect + 28800 + 2400);
    if (b - a < 4800) return false;
    const bp = findBeep(snap.data.subarray(a, b), 0.85);
    if (!bp) return false;
    const beepAt = snap.from + a + bp.pos;
    if (this.seekMark !== undefined && beepAt < this.seekMark) return false;   // joué avant le dernier saut
    const p0 = end - beepAt;
    if (Math.abs(p0 / RATE - T) > 0.6) return false;      // pause ou attente depuis : compteur décalé
    if (await this.refDelay() === null || this.video.paused) return false;
    this.doLockRef(end, p0, "bip de repère (qualité " + bp.quality.toFixed(3) + ")");
    return true;
  };

  // contrôle périodique : le son joué est-il toujours là où on le croit ?
  AudioLink.prototype.refCheck = async function () {
    try { await this.refCheckInner(); } catch (e) { this.note("erreur de contrôle : " + e.message); }
  };

  AudioLink.prototype.refCheckInner = async function () {
    const lock = this.lockedAt;
    if (!lock || !this.useRef() || this.video.paused) return;
    const n = 8192;
    const snap = await this.snapshot(null, n);
    if (this.lockedAt !== lock || snap.data.length < n) return;
    const again = () => { this.refTimer = setTimeout(() => this.refCheck(), 5000); };
    // passage très calme : on garde le calage (rien à comparer de façon fiable)
    let e = 0; for (let i = 0; i < n; i++) e += snap.data[i] * snap.data[i];
    if (e / n < 1e-8) { again(); return; }
    const c = await this.refDelay();
    if (c === null) return;
    const pExpected = snap.from - lock.i0 + lock.p0;          // position publiée supposée
    const r = this.ref.locate(snap.data, (pExpected - c) / RATE, 0.02);
    const here = this.ref.similarity(snap.data, (pExpected - c) / RATE);
    if (r && r.quality > 0.8) {
      const drift = r.t * RATE + c - pExpected;
      // on ne corrige que si la nouvelle position est nettement meilleure que l'actuelle
      // (un son grave se ressemble d'une trame à l'autre : il ne faut pas suivre un pic secondaire)
      if (Math.abs(drift) > 0.4 && (here === null || r.quality > here + 0.02 || (Math.abs(drift) < 3 && r.quality >= here))) {
        this.note("dérive de " + drift.toFixed(2) + " éch. (ressemblance " + r.quality.toFixed(3) + " contre " +
                  (here === null ? "—" : here.toFixed(3)) + " ici) : recalage");
        this.doLockRef(snap.from, pExpected + drift, "référence (dérive)");
        return;
      }
    } else if ((here === null || here < 0.5) && (!r || r.quality < 0.5)) {
      this.note("contrôle : son joué introuvable autour de la position attendue, recalage");
      // le calage actuel reste en place tant qu'un meilleur n'est pas trouvé ; le contrôle continue
      this.refLock("contrôle").then(() => { if (this.lockedAt === lock) again(); });
      return;
    }
    again();
  };

  AudioLink.prototype.snapshot = function (from, len) {
    const id = ++this.snapId;
    return new Promise((res) => { this.snapWait.set(id, res); this.port.postMessage({ type: "snapshot", id, from, len }); });
  };

  AudioLink.prototype.fedSnap = function () {
    const id = ++this.snapId;
    return new Promise((res) => { this.snapWait.set(id, res); this.port.postMessage({ type: "fedSnap", id }); });
  };

  AudioLink.prototype.state = function () {
    const id = ++this.snapId;
    return new Promise((res) => { this.snapWait.set(id, res); this.port.postMessage({ type: "state", id }); });
  };

  AudioLink.prototype.outputSnapshot = function () {
    const id = ++this.snapId;
    return new Promise((res) => { this.snapWait.set(id, res); this.port.postMessage({ type: "outSnap", id }); });
  };

  AudioLink.prototype.onMessage = function (m) {
    if (m.type === "snapshot" || m.type === "outSnap" || m.type === "state" || m.type === "fedSnap") {
      const r = this.snapWait.get(m.id);
      if (r) { this.snapWait.delete(m.id); r(m); }
    } else if (m.type === "onset") {
      this.onOnset(m.index, m.count, m.prevEnd);
    } else if (m.type === "tick") {
      this.lastCount = m.count;
      this.lastPos = m.pos;
    } else if (m.type === "mark") {
      if (/^(seeked|playing)@/.test(m.label)) this.lastResumeMark = m.count;
    }
  };

  AudioLink.prototype.onOnset = async function (index, count, prevEnd) {
    if (this.useRef()) { this.expectT = null; return; }      // la référence s'en charge
    // reprise antérieure au dernier saut (message en retard) : ignorée, la bonne va suivre
    if (index !== null && this.seekMark !== undefined && index < this.seekMark - 4800) {
      this.note("reprise du son antérieure au dernier saut : ignorée");
      return;
    }
    // déjà calé (et rien n'a interrompu le son depuis : saut, pause et attente décalent) :
    // cette reprise est un ancien message ; s'en servir remplacerait un bon calage par un mauvais
    if (this.lockedAt && !this.calibration) {
      this.expectT = null;
      return;
    }
    if (index !== null && this.expectT !== null && this.expectT < 0.3) this.startOnset = { index, T: this.expectT };
    if (this.mode !== "decode") { this.expectT = null; return; }
    (this.onsetLog = this.onsetLog || []).push({ index, count, T: this.expectT, at: Date.now() });
    const T = this.expectT;
    this.expectT = null;
    if (index === null || T === null) {
      // Pas de silence net avant la reprise (fréquent avec Opus) : la reprise a eu lieu vers
      // le moment de l'événement « seeked », décalé du délai appris ; la vérification corrige.
      if (T !== null && T >= 0.3 && this.biasKnown && this.lastResumeMark !== undefined && !this.video.paused) {
        const i0 = this.lastResumeMark + Math.round(this.markDelay || 0);
        this.doLock(i0, T * RATE + this.bias, "reprise du son (estimée)");
        return;
      }
      if (!this.video.paused) this.relockNow();
      return;
    }
    this.seekTries = 0;
    if (this.lastResumeMark !== undefined && index - this.lastResumeMark < 48000) {
      // délai entre l'événement et l'arrivée du son : appris sur les reprises bien visibles
      const d = index - this.lastResumeMark;
      this.markDelay = this.markDelay === undefined ? d : 0.7 * this.markDelay + 0.3 * d;
    }
    if (this.calibration && Math.abs(T - CALIB_T) < 1e-6) {
      const snap = await this.snapshot(index, 1400);
      const b = locateInBeep(snap.data);
      const back = this.calibration.back;
      this.calibration = null;
      if (b) {
        this.learnBias(b.pos - T * RATE);
        if (back !== null) { this.video.currentTime = back; return; }   // retour à la position d'origine
        this.doLock(index, b.pos, "bip de repère (après saut)");
        return;
      }
      this.note("mesure du décalage impossible (bip non reconnu)");
      if (back !== null) { this.video.currentTime = back; return; }
    }
    if (T < 0.3 && T < CALIB_T / 2) {
      // départ du début : le bip commence à l'instant 0 du son publié
      // le bip peut précéder la reprise détectée (le silence naturel qui le suit ressemble à une reprise)
      const from = Math.max(0, index - 12000 - Math.round(T * RATE)), len = index - from + 2400 + 16000;
      const snap = await this.snapshot(from, len);
      this.lastSnap = { from, index, T, data: snap.data };
      const b = findBeep(snap.data);
      if (b) {
        const beepAt = from + b.pos;                    // indice d'entrée (réel) du début du bip
        const p0 = index - beepAt;                      // position publiée de l'échantillon « index »
        this.note("bip trouvé (qualité " + b.quality.toFixed(2) + ")");
        // décalage entre la reprise détectée et la position réelle : le même après un saut, donc
        // appris ici, sans avoir à revenir au début plus tard pour le mesurer
        if (!this.biasKnown && Math.abs(p0 - T * RATE) < 4800) this.learnBias(p0 - T * RATE);
        this.doLock(index, p0, "bip de repère");
        return;
      }
      this.note("bip introuvable au début");
    }
    if (!this.biasKnown && !this.video.paused) { this.relockNow(); return; }   // mesurer d'abord
    // reprise après une pause (sans saut) : le premier échantillon qui revient suit le dernier joué
    const pm = this.pauseMap;
    this.pauseMap = null;
    if (pm && prevEnd !== undefined && prevEnd !== null && prevEnd < index && prevEnd >= (pm.at || 0) - 48000) {
      this.doLock(index, prevEnd + 1 - pm.base, "reprise après pause");
      return;
    }
    this.doLock(index, T * RATE + this.bias, "reprise du son");
  };

  AudioLink.prototype.doLock = function (i0, p0, how) {
    if (this.mode !== "decode" || this.video.paused) return;
    this.port.postMessage({ type: "lock", i0, p0 });
    const lock = { i0, p0, how };
    this.lockedAt = lock;
    this.status = "son débrouillé (calage : " + how + ")";
    this.note("calage : " + how + ", p0 = " + p0.toFixed(1));
    // Après un saut, le navigateur saute parfois lui-même quelques trames de son (1024 ou 960
    // échantillons chacune) : on vérifie sur 3 s de son grâce aux copies des jointures.
    // (contrôle propre aux jointures de BRV1 et BRV3)
    if (!/bip|corrigé|référence/.test(how) && root.BRVSync && !this.useRef() && this.version !== 4) setTimeout(() => this.verify(lock), 3300);
  };

  // Mode référence : le son publié (celui de YouTube, décodé par l'extension) est débrouillé
  // à l'avance ; le son joué ne sert qu'à savoir où l'on en est.
  AudioLink.prototype.doLockRef = function (i0, p0, how) {
    if (this.mode !== "decode" || this.video.paused) return;
    this.port.postMessage({ type: "lockRef", i0, p0 });
    const lock = { i0, p0, how, ref: true };
    const jumped = !this.lockedAt || !this.lockedAt.ref || Math.abs((p0 - i0) - (this.lockedAt.p0 - this.lockedAt.i0)) > 48000;
    this.lockedAt = lock;
    this.status = "son débrouillé (calage : " + how + ")";
    this.note("calage : " + how + ", p0 = " + p0.toFixed(1));
    if (jumped) this.feedNext = null;                     // saut : on reprend l'alimentation plus loin
    if (!this.feedTimer) this.feedTimer = setInterval(() => this.feed(), 100);
    this.feed();
  };

  AudioLink.prototype.feed = async function () {
    const lock = this.lockedAt;
    if (!lock || !lock.ref || this.feeding || this.mode !== "decode") return;
    const c = this.refDelays && this.ref.formatKey in this.refDelays ? this.refDelays[this.ref.formatKey] : null;
    if (c === null) return;
    const pNow = (this.lastCount !== undefined ? this.lastCount : lock.i0) - lock.i0 + lock.p0;
    if (this.feedNext === null || this.feedNext === undefined || this.feedNext < pNow - 72000 || this.feedNext > pNow + 480000) {
      this.feedNext = Math.max(0, Math.round(pNow) - 72000);        // 1,5 s avant : contexte des fenêtres
    }
    this.feeding = true;
    try {
      const BLOCK = 12000;
      while (this.feedNext < pNow + 120000) {                    // 2,5 s d'avance
        const s = this.ref.getStereo((this.feedNext - c) / RATE, BLOCK);
        if (!s) {                                                // pas encore reçu ou décodé
          this.starved = true;
          const now = performance.now();
          if (!this.lastStarveNote || now - this.lastStarveNote > 1000) {
            this.lastStarveNote = now;
            const tt = (this.feedNext - c) / RATE, ch = this.ref.chunks;
            const near = ch.filter((x) => x.end > tt && x.t < tt + BLOCK / RATE);
            this.note("son de référence manquant vers " + tt.toFixed(3) + " s (maintenant " + ((pNow - c) / RATE).toFixed(2) +
                      " s) : " + near.length + " morceaux, " + near.map((x) => x.t.toFixed(4) + "+" + x.L.length + "@" + x.rate).slice(0, 4).join(" "));
          }
          break;
        }
        this.starved = false;
        this.port.postMessage({ type: "feed", p0: this.feedNext, L: s.L, R: s.R }, [s.L.buffer, s.R.buffer]);
        this.feedNext += BLOCK;
      }
    } finally { this.feeding = false; }
  };

  AudioLink.prototype.verify = async function (lock) {
    if (this.lockedAt !== lock || this.video.paused || this.mode !== "decode") return;
    const S = root.BRVSync;
    const snap = await this.snapshot(null, 48000 * 3);
    if (this.lockedAt !== lock || snap.data.length < 48000 * 2.5) return;
    const hf = S.whitenedHigh(snap.data);
    if (!this.pairs || this.pairs.key !== this.key) { this.pairs = new S.Pairs(this.key); this.pairs.key = this.key; }
    const p0 = Math.round(snap.from - lock.i0 + lock.p0);   // position publiée supposée de snap.data[0]
    const skips = [0];
    for (const F of [1024, 960]) for (let k = 1; k <= 6; k++) skips.push(k * F);
    const sc = skips.map((d) => S.score(hf, p0 + d, this.pairs));
    let bi = 0, second = -1;
    for (let i = 1; i < sc.length; i++) if (sc[i] !== null && (sc[bi] === null || sc[i] > sc[bi])) bi = i;
    for (let i = 0; i < sc.length; i++) if (i !== bi && sc[i] !== null && sc[i] > second) second = sc[i];
    const cur = sc[0] === null ? -1 : sc[0];
    const clear = bi !== 0 && sc[bi] > 0.12 && sc[bi] - cur > 0.06 && sc[bi] - second > 0.03;
    this.note("vérification : " + (clear ? "le navigateur a sauté " + skips[bi] + " éch., correction" :
              "calage confirmé ou indécis (score " + (sc[0] === null ? "—" : sc[0].toFixed(2)) + ")"));
    if (clear && this.lockedAt === lock) this.doLock(lock.i0, lock.p0 + skips[bi], lock.how + ", corrigé");
  };

  AudioLink.prototype.report = function () {
    return {
      status: this.status,
      reference: this.ref ? this.ref.status + (this.ref.available() ? "" : " (vide)") + (this.starved ? ", en attente de son" : "") +
                 (this.lastPos && this.lastPos.underruns ? ", " + this.lastPos.underruns + " manques" : "") + this.refSummary() : "—",
      path: this.path || "non branché",
      context: this.ctx ? this.ctx.state : "—",
      bias: this.biasKnown ? this.bias.toFixed(1) + " éch." : "non mesuré",
      log: this.lastLog.slice(-8),
    };
  };

  // état du son de référence, pour le menu : zone décodée autour de la lecture, compteurs
  AudioLink.prototype.refSummary = function () {
    const r = this.ref, ch = r.chunks, C = r.counts;
    let s = " — vidéo à " + this.video.currentTime.toFixed(1) + " s, référence " +
            (ch.length ? ch[0].t.toFixed(1) + "–" + ch[ch.length - 1].end.toFixed(1) + " s" : "vide") +
            ", reçu jusqu'à " + (C.lastT === null ? "—" : C.lastT.toFixed(1) + " s");
    // flux reçus du lecteur : morceaux, octets, trames lues, octets en attente, recalages du flux
    let pending = 0, resyncs = 0, why = [];
    for (const tr of r.tracks.values()) {
      pending += tr.parser.buf.length; resyncs += tr.parser.resyncs || 0;
      if (tr.parser.resyncLog) why = why.concat(tr.parser.resyncLog.slice(-2));
    }
    s += " [" + C.messages + " envois, " + Math.round(C.bytes / 1024) + " ko, " + C.blocks + " trames, " + r.tracks.size + " flux";
    if (pending > 4096) s += ", " + Math.round(pending / 1024) + " ko en attente";
    if (resyncs) s += ", " + resyncs + " recalages du flux, derniers : " + why.join(" ; ");
    s += "]";
    if (C.switches) s += ", " + C.switches + " changements de flux";
    if (C.offset) s += ", décalage de YouTube " + C.offset.toFixed(3) + " s";
    if (C.sequence) s += ", mode séquence";
    if (C.errors) s += ", " + C.errors + " erreurs";
    if (C.recreated) s += ", décodeur recréé " + C.recreated + "×";
    return s;
  };

  root.BRVAudio = { AudioLink, findBeep, beepTemplate, locateInBeep };
})(typeof globalThis !== "undefined" ? globalThis : this);
