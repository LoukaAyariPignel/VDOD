/* Son de référence : les morceaux de son que YouTube transmet au navigateur (copiés par
 * page-hook.js) sont décodés ici avec WebCodecs. Chaque échantillon décodé a son instant exact
 * dans la vidéo : en le comparant au son effectivement joué, on sait exactement quelle partie
 * de la vidéo est en train d'être jouée — quoi que fasse le navigateur (sauts, trames sautées…).
 * Le décodage se fait hors du fil de la page ; seul un stock limité autour de la position de
 * lecture est gardé (son mono à 48 kHz). */
(function (root) {
  "use strict";
  const RATE = 48000;
  const KEEP_BEFORE = 20, KEEP_AFTER = 40;           // son décodé gardé autour de la lecture (s)
  const DECODE_BEFORE = 3, DECODE_AHEAD = 20;        // zone décodée à l'avance
  const ENC_BEFORE = 90, ENC_AFTER = 1800;           // morceaux compressés gardés (peu de place)

  // ------------------------------------------------------------ lecture d'octets
  function readVint(u8, pos, keepMarker) {           // entier EBML de taille variable
    const b = u8[pos];
    if (b === undefined) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 8 || pos + len > u8.length) return null;
    let v = keepMarker ? b : (b & (mask - 1));
    let allOnes = (b & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + u8[pos + i]; if (u8[pos + i] !== 0xff) allOnes = false; }
    return { value: v, len, unknown: !keepMarker && allOnes };
  }
  const uint = (u8, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return v; };
  function concat(a, b) {
    if (!a || !a.length) return b;
    const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o;
  }

  // ------------------------------------------------------------ WebM (Opus)
  const MASTER = new Set([0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0]);
  const SKIP = new Set([0x1C53BB6B, 0x114D9B74, 0x1254C367, 0x1043A770, 0xEC, 0x1941A469]);  // Cues, SeekHead, Tags…
  // identifiants WebM attendus dans un flux de son (le reste = flux décalé, sauf petits éléments)
  const KNOWN = new Set([...MASTER, ...SKIP,
    0x1A45DFA3, 0x4286, 0x42F7, 0x42F2, 0x42F3, 0x4282, 0x4287, 0x4285, 0xBF,                    // en-tête EBML, CRC
    0x4DBB, 0x53AB, 0x53AC, 0x2AD7B1, 0x4489, 0x4D80, 0x5741, 0x4461, 0x73A4, 0x7BA9,           // SeekHead, Info
    0xD7, 0x73C5, 0x83, 0x9C, 0x22B59C, 0x22B59D, 0x86, 0x63A2, 0x56AA, 0x56BB, 0x23E383,       // TrackEntry
    0xB5, 0x9F, 0x6264, 0x78B5, 0xB9, 0x88, 0x55AA, 0x536E, 0x258688, 0xE0, 0x6DE7, 0x55EE,
    0xE7, 0xA3, 0xA1, 0xA7, 0xAB, 0x9B, 0xFB, 0x75A1, 0xA5, 0xA6, 0xEE, 0x8E, 0x75A2]);         // Cluster
  function WebmParser(onConfig, onChunk) {
    this.buf = new Uint8Array(0);
    this.onConfig = onConfig; this.onChunk = onChunk;
    this.scale = 1e6;                 // TimecodeScale (ns)
    this.track = {}; this.cluster = 0; this.audioTrack = null;
  }
  WebmParser.prototype.reset = function () { this.buf = new Uint8Array(0); };
  // journal des recalages (diagnostic) : raison, dernière trame lue
  WebmParser.prototype.note = function (why) {
    const l = this.resyncLog || (this.resyncLog = []);
    l.push(why + " (après " + (this.lastTs === undefined ? "-" : (this.lastTs / 1e6).toFixed(2)) + " s)");
    if (l.length > 20) l.shift();
  };
  // début d'un groupe (Cluster) ou d'un en-tête EBML à la position p ?
  const isClusterAt = (u8, p) => u8[p] === 0x1F && u8[p + 1] === 0x43 && u8[p + 2] === 0xB6 && u8[p + 3] === 0x75;
  const isEbmlAt = (u8, p) => u8[p] === 0x1A && u8[p + 1] === 0x45 && u8[p + 2] === 0xDF && u8[p + 3] === 0xA3;
  function findCluster(u8, from) {
    for (let p = Math.max(0, from); p + 4 <= u8.length; p++) if (isClusterAt(u8, p) || isEbmlAt(u8, p)) return p;
    return -1;
  }
  WebmParser.prototype.push = function (bytes) {
    // Un morceau qui commence par un groupe ou un en-tête repart de zéro : le reste d'un morceau
    // précédent interrompu (renvoyé ensuite par le lecteur) décalerait toute la lecture.
    if (this.buf.length && bytes.length >= 4 && (isClusterAt(bytes, 0) || isEbmlAt(bytes, 0))) {
      this.note("reste jeté (" + this.buf.length + " o)");
      this.resyncs = (this.resyncs || 0) + 1;
      this.buf = new Uint8Array(0);
    }
    this.buf = concat(this.buf, bytes);
    const u8 = this.buf;
    let pos = 0;
    const resync = (why) => {                           // flux décalé : on repart au prochain groupe
      this.note(why + " à " + pos + "/" + u8.length);
      this.resyncs = (this.resyncs || 0) + 1;
      const p = findCluster(u8, pos + 1);
      if (p < 0) { pos = Math.max(pos, u8.length - 3); return false; }
      pos = p; return true;
    };
    for (;;) {
      const id = readVint(u8, pos, true);
      if (!id) { if (u8[pos] !== undefined && u8[pos] === 0 && resync("identifiant nul")) continue; break; }
      const size = readVint(u8, pos + id.len, false);
      if (!size) { if (u8.length - pos > 16 && resync("taille illisible")) continue; break; }
      const head = id.len + size.len, eid = id.value;
      if (MASTER.has(eid)) {                            // on descend dans les éléments conteneurs
        if (eid === 0xAE) this.track = {};
        pos += head;
        continue;
      }
      if (size.unknown) { pos += head; continue; }
      // flux décalé : identifiant inconnu avec une grande taille, ou élément connu démesuré
      // (une trame de son fait au plus quelques ko)
      if ((!KNOWN.has(eid) && size.value > 65536) || (KNOWN.has(eid) && !SKIP.has(eid) && size.value > 1e6)) {
        if (resync("taille " + size.value + " pour " + eid.toString(16))) continue;
        break;
      }
      if (SKIP.has(eid) && eid !== 0x1941A469) {
        // élément ignoré (index Cues…) : le lecteur n'en envoie parfois qu'un bout, et la suite du
        // flux serait avalée comme s'il en faisait partie. Un groupe qui commence dans l'espace
        // qu'il annonce montre qu'il est tronqué : on reprend à ce groupe.
        const end = Math.min(u8.length, pos + head + size.value);
        const p = findCluster(u8.subarray(0, end), pos + head);
        if (p >= 0) { this.note("élément " + eid.toString(16) + " tronqué"); pos = p; continue; }
      }
      if (pos + head + size.value > u8.length) {        // élément incomplet : on attend la suite
        if (u8.length - pos > 32e6 && resync("élément sans fin")) continue;
        break;
      }
      const d = pos + head, n = size.value;
      if (KNOWN.has(eid) && eid !== 0xA3 && eid !== 0xA1) this.junk = 0;   // trames : jugées dans block()
      if (!KNOWN.has(eid)) this.junk = (this.junk || 0) + 1;
      if (!SKIP.has(eid)) this.element(eid, u8, d, n);
      pos = d + n;
      if (this.junk > 8) { this.junk = 0; if (resync("éléments inconnus ou trames incohérentes")) continue; break; }
    }
    this.buf = u8.slice(pos);
  };
  WebmParser.prototype.element = function (eid, u8, d, n) {
    const t = this.track;
    switch (eid) {
      case 0x2AD7B1: this.scale = uint(u8, d, n); break;                  // TimecodeScale
      case 0xD7: t.number = uint(u8, d, n); break;                         // TrackNumber
      case 0x83: t.type = uint(u8, d, n); break;                           // TrackType (2 = audio)
      case 0x86: t.codec = new TextDecoder().decode(u8.subarray(d, d + n)); break;
      case 0x63A2: t.priv = u8.slice(d, d + n); break;                     // CodecPrivate (OpusHead)
      case 0x56AA: t.delay = uint(u8, d, n); break;                        // CodecDelay (ns)
      case 0xB5: t.rate = n === 4 ? new DataView(u8.buffer, u8.byteOffset + d, 4).getFloat32(0)
                                  : new DataView(u8.buffer, u8.byteOffset + d, 8).getFloat64(0); break;
      case 0x9F: t.channels = uint(u8, d, n);
        if (t.codec) this.configure(t); break;
      case 0xE7: this.cluster = uint(u8, d, n); this.clusterFresh = true;  // Timecode du groupe
        if (this.audioTrack === null && this.track.codec) this.configure(this.track);
        break;
      case 0xA3: case 0xA1: this.block(u8, d, n); break;                   // SimpleBlock / Block
      default: break;
    }
  };
  WebmParser.prototype.configure = function (t) {
    if (!/OPUS|VORBIS|AAC/.test(t.codec || "")) return;
    this.audioTrack = t.number;
    const codec = t.codec === "A_OPUS" ? "opus" : t.codec === "A_VORBIS" ? "vorbis" : "mp4a.40.2";
    let ch = t.channels;
    // Opus : l'en-tête « OpusHead » (CodecPrivate) donne le nombre de canaux (octet 9)
    if (codec === "opus" && t.priv && t.priv.length >= 19 && String.fromCharCode(...t.priv.subarray(0, 8)) === "OpusHead") ch = t.priv[9];
    this.onConfig({ codec, sampleRate: codec === "opus" ? 48000 : Math.round(t.rate || 48000),
                    numberOfChannels: ch, description: t.priv, delay: (t.delay || 0) / 1e9 });
  };
  WebmParser.prototype.block = function (u8, d, n) {
    const tn = readVint(u8, d, false);
    if (!tn || (this.audioTrack !== null && tn.value !== this.audioTrack)) { this.junk = (this.junk || 0) + 3; return; }
    const p = d + tn.len;
    let rel = (u8[p] << 8) | u8[p + 1]; if (rel & 0x8000) rel -= 0x10000;
    const flags = u8[p + 2];
    if (flags & 0x06) return;                                              // laçage : ignoré (rare en Opus)
    const ts = (this.cluster + rel) * this.scale / 1e3;                    // µs
    // dans un groupe, les trames se suivent (20 ms) : un saut de plus de 2 s = octets parasites
    if (!this.clusterFresh && this.lastTs !== undefined && Math.abs(ts - this.lastTs) > 2e6) { this.junk = (this.junk || 0) + 3; return; }
    this.clusterFresh = false; this.lastTs = ts;
    this.junk = 0;
    this.onChunk(ts, u8.slice(p + 3, d + n));
  };

  // ------------------------------------------------------------ MP4 fragmenté (AAC)
  function Mp4Parser(onConfig, onChunk) {
    this.buf = new Uint8Array(0);
    this.onConfig = onConfig; this.onChunk = onChunk;
    this.timescale = 48000; this.defDur = 1024; this.defSize = 0; this.shift = 0;
    this.pendingMoof = null;
  }
  Mp4Parser.prototype.reset = function () { this.buf = new Uint8Array(0); this.pendingMoof = null; };
  const BOX_START = new Set(["ftyp", "moov", "moof", "styp", "sidx", "emsg"]);
  Mp4Parser.prototype.push = function (bytes) {
    // morceau commençant par une boîte de début : le reste d'un morceau interrompu est jeté
    if (this.buf.length && bytes.length >= 8 &&
        BOX_START.has(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]))) {
      this.resyncs = (this.resyncs || 0) + 1;
      this.buf = new Uint8Array(0);
    }
    this.buf = concat(this.buf, bytes);
    const u8 = this.buf;
    let pos = 0;
    while (pos + 8 <= u8.length) {
      let size = uint(u8, pos, 4), hdr = 8;
      const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      if (size === 1) { if (pos + 16 > u8.length) break; size = uint(u8, pos + 8, 8); hdr = 16; }
      if (size === 0 || pos + size > u8.length) break;
      const box = u8.subarray(pos, pos + size);
      if (type === "moov") this.moov(box);
      else if (type === "moof") this.pendingMoof = box.slice();
      else if (type === "mdat" && this.pendingMoof) { this.fragment(this.pendingMoof, box, hdr); this.pendingMoof = null; }
      pos += size;
    }
    this.buf = u8.slice(pos);
  };
  // parcourt les boîtes enfants de b (à partir de off) et appelle fn(type, début, taille)
  function children(b, off, end, fn) {
    let p = off;
    while (p + 8 <= end) {
      const s = uint(b, p, 4), t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (s < 8 || p + s > end) break;
      fn(t, p, s);
      p += s;
    }
  }
  Mp4Parser.prototype.moov = function (b) {
    const self = this;
    let cfg = null, isAudio = false, ts = 0, mediaTime = 0;
    const walk = (off, end) => children(b, off, end, (t, p, s) => {
      if (t === "trak" || t === "mdia" || t === "minf" || t === "stbl" || t === "edts" || t === "mvex") walk(p + 8, p + s);
      else if (t === "hdlr") isAudio = String.fromCharCode(b[p + 16], b[p + 17], b[p + 18], b[p + 19]) === "soun";
      else if (t === "mdhd") ts = b[p + 8] === 1 ? uint(b, p + 28, 4) : uint(b, p + 20, 4);
      else if (t === "elst") mediaTime = b[p + 8] === 1 ? uint(b, p + 20, 8) : uint(b, p + 20, 4);
      else if (t === "trex") { self.defDur = uint(b, p + 20, 4); self.defSize = uint(b, p + 24, 4); }
      else if (t === "stsd") children(b, p + 16, p + s, (t2, p2, s2) => {
        if (t2 !== "mp4a") return;
        const ch = uint(b, p2 + 24, 2), rate = uint(b, p2 + 32, 2);
        children(b, p2 + 36, p2 + s2, (t3, p3, s3) => {
          if (t3 !== "esds") return;
          // descripteurs : on cherche DecoderSpecificInfo (étiquette 5)
          for (let q = p3 + 12; q < p3 + s3 - 2; q++) {
            if (b[q] === 0x05) {
              let len = 0, k = q + 1;
              for (let i = 0; i < 4; i++) { const c = b[k++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
              if (len > 0 && len < 64) {
                const asc = b.slice(k, k + len);
                const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                const aot = asc[0] >> 3, fi = ((asc[0] & 7) << 1) | (asc[1] >> 7), cc = (asc[1] >> 3) & 0xf;
                cfg = { codec: aot === 5 || aot === 29 ? "mp4a.40." + aot : "mp4a.40.2",
                        sampleRate: fi < RATES.length ? RATES[fi] : rate, numberOfChannels: cc >= 1 && cc <= 7 ? (cc === 7 ? 8 : cc) : ch,
                        description: asc };
              }
              break;
            }
          }
        });
      });
    });
    walk(8, b.length);
    if (cfg) {
      this.timescale = ts || cfg.sampleRate;
      this.shift = mediaTime / this.timescale;           // amorce (liste d'édition)
      cfg.delay = this.shift;
      this.onConfig(cfg);
    }
  };
  Mp4Parser.prototype.fragment = function (moof, mdat, mdatHdr) {
    let base = 0, defDur = this.defDur, defSize = this.defSize;
    const runs = [];
    children(moof, 8, moof.length, (t, p, s) => {
      if (t !== "traf") return;
      children(moof, p + 8, p + s, (t2, p2, s2) => {
        if (t2 === "tfhd") {
          const fl = uint(moof, p2 + 9, 3); let q = p2 + 16;
          if (fl & 0x1) q += 8; if (fl & 0x2) q += 4;
          if (fl & 0x8) { defDur = uint(moof, q, 4); q += 4; }
          if (fl & 0x10) { defSize = uint(moof, q, 4); q += 4; }
        } else if (t2 === "tfdt") {
          base = moof[p2 + 8] === 1 ? uint(moof, p2 + 12, 8) : uint(moof, p2 + 12, 4);
        } else if (t2 === "trun") {
          const fl = uint(moof, p2 + 9, 3), count = uint(moof, p2 + 12, 4);
          let q = p2 + 16, dataOff = 0;
          if (fl & 0x1) { dataOff = new DataView(moof.buffer, moof.byteOffset + q, 4).getInt32(0); q += 4; }
          if (fl & 0x4) q += 4;
          const samples = [];
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize;
            if (fl & 0x100) { dur = uint(moof, q, 4); q += 4; }
            if (fl & 0x200) { size = uint(moof, q, 4); q += 4; }
            if (fl & 0x400) q += 4;
            if (fl & 0x800) q += 4;
            samples.push([dur, size]);
          }
          runs.push({ dataOff, samples });
        }
      });
    });
    let t = base;
    for (const r of runs) {
      let off = r.dataOff - moof.length;                   // décalage relatif au début de mdat
      if (off < mdatHdr) off = mdatHdr;
      for (const [dur, size] of r.samples) {
        if (off + size > mdat.length) return;
        this.onChunk((t / this.timescale) * 1e6, mdat.slice(off, off + size));
        off += size; t += dur;
      }
    }
  };

  // ------------------------------------------------------------ une piste de son
  function Track(mime, owner) {
    this.owner = owner;
    this.mime = mime;
    this.decoder = null; this.cfg = null;
    const onConfig = (cfg) => this.configure(cfg);
    const onChunk = (ts, data) => this.chunk(ts, data);
    this.parser = /webm/i.test(mime) ? new WebmParser(onConfig, onChunk) : new Mp4Parser(onConfig, onChunk);
  }
  Track.prototype.configure = function (cfg) {
    const key = cfg.codec + cfg.sampleRate + cfg.numberOfChannels + (cfg.description ? cfg.description.length : 0);
    if (this.cfgKey === key && this.decoder && this.decoder.state === "configured") return;
    this.cfgKey = key; this.cfg = cfg;
    try {
      if (this.decoder) this.decoder.close();
    } catch (e) { /* rien */ }
    if (typeof AudioDecoder === "undefined") { this.owner.status = "WebCodecs indisponible"; return; }
    this.decoder = new AudioDecoder({
      output: (ad) => this.output(ad),
      error: (e) => { this.owner.counts.errors++; this.owner.status = "décodage de référence : " + e.message; },
    });
    this.owner.rawConfig = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels,
                             description: cfg.description ? Array.from(cfg.description.slice(0, 16)) : null };
    const okInt = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
    const conf = { codec: cfg.codec,
                   sampleRate: okInt(cfg.sampleRate, 8000, 192000) ? Math.round(cfg.sampleRate) : 48000,
                   numberOfChannels: okInt(cfg.numberOfChannels, 1, 8) ? Math.round(cfg.numberOfChannels) : 2 };
    if (cfg.description && cfg.codec !== "opus") conf.description = cfg.description;
    this.conf = conf;
    this.runNext = undefined;
    try { this.decoder.configure(conf); this.owner.status = "référence : " + cfg.codec + " " + cfg.sampleRate + " Hz"; }
    catch (e) {
      // dernier recours : configuration minimale (le décodeur lit alors l'en-tête lui-même)
      try { const c2 = { codec: conf.codec, sampleRate: conf.sampleRate, numberOfChannels: 2 };
            if (conf.description) c2.description = conf.description;
            this.decoder.configure(c2); this.conf = c2; this.owner.status = "référence : " + c2.codec + " (configuration de secours)"; }
      catch (e2) { this.owner.status = "configuration refusée : " + e.message + " [" + JSON.stringify(this.owner.rawConfig) + "]"; this.decoder = null; }
    }
    this.formatKey = this.mime + "|" + cfg.codec;
    if (this.owner.active === this || !this.owner.active) this.owner.formatKey = this.formatKey;
  };
  // Les morceaux compressés sont gardés ; on ne décode que ce qui est proche de la lecture.
  Track.prototype.chunk = function (tsUs, data) {
    const C = this.owner.counts;
    if (this.offsetUs) {
      tsUs += this.offsetUs;
      // décalage retenu par morceau : le recalage des trames Opus sur leur grille (output) se
      // fait avant décalage
      const o = this.offsets || (this.offsets = new Map());
      o.set(Math.round(tsUs), this.offsetUs);
      if (o.size > 20000) for (const k of o.keys()) { o.delete(k); if (o.size <= 15000) break; }
    }
    C.blocks++; C.lastT = tsUs / 1e6;
    const e = this.enc || (this.enc = []);
    const t = tsUs / 1e6;
    let lo = 0, hi = e.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid].t < t) lo = mid + 1; else hi = mid; }
    const item = { t, us: Math.round(tsUs), data, done: false };
    if (lo < e.length && Math.abs(e[lo].t - t) < 1e-6) e[lo] = item; else e.splice(lo, 0, item);
  };
  // Décodage par « séries » : une série envoie au décodeur des morceaux consécutifs, à partir de
  // runNext. On ne redémarre le décodeur (nouvelle série) que si la zone utile n'est pas dans le
  // prolongement de la série en cours ; les morceaux déjà envoyés ne sont jamais renvoyés.
  Track.prototype.pump = function (now) {
    const C = this.owner.counts, have = this.owner.decodedAt;
    // après une erreur, le navigateur ferme le décodeur pour de bon : on en recrée un
    if (this.decoder && this.decoder.state === "closed" && this.cfg) {
      C.recreated = (C.recreated || 0) + 1;
      // la série en échec n'est pas renvoyée (un morceau illisible la bloquerait sans fin) :
      // le trou laissé dans la référence est court, et l'alimentation le dépasse d'elle-même
      if (this.runNext !== undefined && this.enc && this.enc[this.runNext - 1]) this.skipBefore = this.enc[this.runNext - 1].t;
      this.cfgKey = null; this.decoder = null; this.configure(this.cfg);
    }
    const d = this.decoder, e = this.enc;
    if (!e || !e.length || !d || d.state !== "configured") return;
    // éviction des morceaux compressés trop lointains (en gardant les indices de la série cohérents)
    let drop = 0;
    while (drop < e.length && e[drop].t < now - ENC_BEFORE) drop++;
    if (drop) { e.splice(0, drop); if (this.runNext !== undefined) { this.runStart -= drop; this.runNext -= drop; } }
    while (e.length && e[e.length - 1].t > now + ENC_AFTER) e.pop();
    let lo = 0, hi = e.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid].t < now - DECODE_BEFORE) lo = mid + 1; else hi = mid; }
    const inRun = (k) => this.runNext !== undefined && k >= this.runStart && k < this.runNext;
    let want = -1;
    for (let k = lo; k < e.length && e[k].t <= now + DECODE_AHEAD; k++) {
      if (this.skipBefore !== undefined && e[k].t <= this.skipBefore) continue;
      if (!have.has(e[k].us) && !inRun(k)) { want = k; break; }
    }
    if (want < 0) return;                                             // tout est décodé ou en cours
    if (this.runNext === undefined || want < this.runStart || want > this.runNext + 50) {
      // nouvelle série : redémarrage du décodeur (sinon il rangerait le son au mauvais endroit),
      // et quelques morceaux avant pour l'« amorcer » (leur sortie est jetée)
      try { d.reset(); d.configure(this.conf); } catch (err) { C.errors++; return; }
      C.resets = (C.resets || 0) + 1;
      this.preroll = new Set();
      this.runStart = Math.max(0, want - 4);
      this.runNext = this.runStart;
      for (let k = this.runStart; k < want; k++) this.preroll.add(e[k].us);
    }
    if (d.decodeQueueSize > 40) return;                               // file pleine : suite au prochain tour
    let sent = 0;
    while (this.runNext < e.length && e[this.runNext].t <= now + DECODE_AHEAD && sent < 120) {
      const x = e[this.runNext];
      try { d.decode(new EncodedAudioChunk({ type: "key", timestamp: x.us, data: x.data })); C.decoded++; sent++; }
      catch (err) { C.errors++; }
      this.runNext++;
    }
  };
  Track.prototype.output = function (ad) {
    this.owner.counts.outputs++;
    try {
      const n = ad.numberOfFrames, ch = ad.numberOfChannels;
      const L = new Float32Array(n);
      ad.copyTo(L, { planeIndex: 0, format: "f32-planar" });
      let R = L;
      if (ch > 1) { R = new Float32Array(n); ad.copyTo(R, { planeIndex: 1, format: "f32-planar" }); }
      if (this.preroll && this.preroll.has(ad.timestamp)) { this.preroll.delete(ad.timestamp); ad.close(); return; }
      if (this.owner.active !== this) { ad.close(); return; }        // sortie d'un flux qui n'est plus actif
      // WebM : horodatages arrondis à la milliseconde. Un morceau Opus dure exactement n
      // échantillons (20 ms en général) depuis le début du flux : on se recale sur cette grille.
      let t = ad.timestamp / 1e6;
      if (this.cfg && this.cfg.codec === "opus") {
        const fd = n / ad.sampleRate, off = ((this.offsets && this.offsets.get(ad.timestamp)) || 0) / 1e6;
        t = off + Math.round((t - off) / fd) * fd;
      }
      this.owner.store(t, ad.sampleRate, L, R, ad.timestamp);
    } catch (e) { this.owner.counts.errors++; }
    ad.close();
  };
  // après un saut, YouTube renvoie les morceaux : ils seront décodés de nouveau si besoin
  Track.prototype.resetDecoding = function () { this.runNext = undefined; this.skipBefore = undefined; };

  // ------------------------------------------------------------ rééchantillonnage (sinc fenêtré)
  const RESAMPLE_PHASES = 512;
  const resamplerCache = new Map();
  function resamplerTable(rate, TAP) {
    const key = rate + ":" + TAP;
    let t = resamplerCache.get(key);
    if (t) return t;
    const K = 2 * TAP, cut = Math.min(1, RATE / rate) * 0.97;
    t = new Float32Array(RESAMPLE_PHASES * K);
    for (let ph = 0; ph < RESAMPLE_PHASES; ph++) {
      const f = ph / RESAMPLE_PHASES;
      let sum = 0;
      for (let k = 0; k < K; k++) {
        const u = (k - TAP + 1) - f, arg = Math.PI * u * cut;
        const h = (u === 0 ? 1 : Math.sin(arg) / arg) * (0.5 + 0.5 * Math.cos(Math.PI * u / (TAP + 0.5)));
        t[ph * K + k] = h; sum += h;
      }
      for (let k = 0; k < K; k++) t[ph * K + k] /= sum;
    }
    resamplerCache.set(key, t);
    return t;
  }

  // ------------------------------------------------------------ ensemble des pistes et stock
  function RefAudio(clock, wantUrl) {
    this.clock = clock || (() => 0);
    this.wantUrl = () => { try { return (wantUrl && wantUrl()) || ""; } catch (e) { return ""; } };
    this.tracks = new Map();
    this.chunks = [];                 // son décodé : { t, rate, L, R, end, us } triés par t
    this.decodedAt = new Set();        // horodatages (µs) des morceaux décodés en mémoire
    this.status = "aucun son reçu";
    this.formatKey = "";
    this.counts = { messages: 0, bytes: 0, blocks: 0, decoded: 0, outputs: 0, dropped: 0, errors: 0, lastT: null };
    const handle = (m) => {
      this.counts.messages++;
      if (m.bytes) this.counts.bytes += m.bytes.byteLength;
      if (m.kind === "init") {
        const old = this.tracks.get(m.id);
        if (!old || old.mime !== m.mime) this.tracks.set(m.id, new Track(m.mime, this));
      } else if (m.kind === "data") {
        let tr = this.tracks.get(m.id);
        if (!tr && m.mime) { tr = new Track(m.mime, this); this.tracks.set(m.id, tr); }   // annonce manquée
        if (!tr) return;
        if (m.replay && tr.gotData) return;              // en-tête renvoyé : déjà reçu en direct
        tr.gotData = true;
        if (m.url) tr.url = m.url;
        this.pickActive(tr);
        // horodatages de ce morceau décalés comme le fait le navigateur (timestampOffset)
        tr.offsetUs = (+m.offset || 0) * 1e6;
        if (m.offset) this.counts.offset = +m.offset;
        if (m.mode === "sequence") this.counts.sequence = true;
        try { tr.parser.push(new Uint8Array(m.bytes)); }
        catch (err) { this.counts.errors++; this.status = "lecture du flux : " + err.message; tr.parser.reset(); }
      } else if (m.kind === "abort") {
        const tr = this.tracks.get(m.id);
        if (tr) { tr.parser.reset(); tr.resetDecoding(); }
      }
    };
    setInterval(() => this.pump(), 200);               // décodage à la demande, près de la lecture
    // récepteur installé dès le début de la page par early.js (messages mis de côté entre-temps)
    const early = root.__brvEarly;
    if (early) {
      early.handler = handle;
      const q = early.queue; early.queue = [];
      for (const m of q) handle(m);
    } else {
      root.addEventListener("message", (e) => {
        const m = e.data && e.data.__brv;
        if (m && e.source === root) handle(m);
      }, true);
    }
  }
  // demande au script de la page de renvoyer les en-têtes des flux déjà ouverts
  RefAudio.prototype.replay = function () { root.postMessage({ __brvReplay: true }, "*"); };

  // Un seul flux alimente le stock : celui qui reçoit du son en ce moment. Une publicité, une
  // autre vidéo ouverte sans recharger la page ou un aperçu au survol ont leurs propres flux,
  // horodatés eux aussi depuis 0 : mêlés au stock, ils fausseraient le son de référence.
  // Flux actif : celui dont l'adresse est le src de la vidéo principale ; faute de le savoir,
  // celui qui vient de recevoir du son (fresh).
  RefAudio.prototype.pickActive = function (fresh) {
    const want = this.wantUrl();
    if (want) {
      for (const t of this.tracks.values()) {
        if (t.gotData && t.url === want) { if (this.active !== t) this.activate(t); return; }
      }
    }
    // aucun flux reconnu : on garde le flux actif s'il est celui de la vidéo, sinon le plus récent
    if (fresh && this.active !== fresh && !(this.active && want && this.active.url === want)) this.activate(fresh);
  };
  RefAudio.prototype.activate = function (tr) {
    if (this.active) this.counts.switches = (this.counts.switches || 0) + 1;
    this.active = tr;
    this.chunks = [];
    this.decodedAt = new Set();
    for (const t of this.tracks.values()) t.resetDecoding();
    if (tr.formatKey) this.formatKey = tr.formatKey;
  };

  RefAudio.prototype.store = function (t, rate, L, R, us) {
    const c = { t, rate, L, R, end: t + L.length / rate, us };
    this.decodedAt.add(us);
    // remplace un morceau au même instant (renvoyé après un saut), sinon insère à sa place
    const arr = this.chunks;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
    if (lo < arr.length && Math.abs(arr[lo].t - t) < 1e-4) arr[lo] = c; else arr.splice(lo, 0, c);
    const now = this.clock();
    while (arr.length && arr[0].t < now - KEEP_BEFORE) this.decodedAt.delete(arr.shift().us);
    while (arr.length && arr[arr.length - 1].t > now + KEEP_AFTER) this.decodedAt.delete(arr.pop().us);
  };
  RefAudio.prototype.available = function () { return this.chunks.length > 0; };

  RefAudio.prototype.pump = function () {
    this.pickActive(null);                             // la vidéo principale a pu changer de flux
    if (this.active) this.active.pump(this.clock());
  };

  // Son de référence stéréo à 48 kHz sur [t0, t0 + n/48000), rééchantillonné si besoin
  // (sinc fenêtré) ; null s'il manque plus de `tolerance` (fraction) des échantillons.
  RefAudio.prototype.getStereo = function (t0, n, tolerance) {
    const t1 = t0 + n / RATE;
    const parts = [];
    for (const c of this.chunks) if (c.end > t0 - 0.01 && c.t < t1 + 0.01) parts.push(c);
    const L = new Float32Array(n), R = new Float32Array(n);
    let filled = Math.min(n, Math.max(0, Math.round(-t0 * RATE)));     // avant 0 : silence connu
    if (!parts.length) return filled >= (1 - (tolerance || 0.02)) * n ? { L, R } : null;
    const rate = parts[0].rate;
    if (rate === RATE) {                                // cas courant (Opus) : simple copie
      for (const c of parts) {
        const off = Math.round((c.t - t0) * RATE);
        const a = Math.max(0, -off), b = Math.min(c.L.length, n - off);
        for (let i = a; i < b; i++) { L[off + i] = c.L[i]; R[off + i] = c.R[i]; }
        if (b > a) filled += b - a;
      }
    } else {                                            // ex. AAC à 44,1 kHz
      const TAP = 16, tA = t0 - (TAP + 2) / rate;
      const len = Math.ceil((t1 - tA) * rate) + 2 * TAP + 4;
      const xl = new Float32Array(len), xr = new Float32Array(len), have = new Uint8Array(len);
      for (const c of parts) {
        const off = Math.round((c.t - tA) * rate);
        for (let i = Math.max(0, -off); i < c.L.length && off + i < len; i++) { xl[off + i] = c.L[i]; xr[off + i] = c.R[i]; have[off + i] = 1; }
      }
      const tab = resamplerTable(rate, TAP);             // filtres précalculés (512 phases)
      const P = RESAMPLE_PHASES, K = 2 * TAP;
      for (let i = 0; i < n; i++) {
        const x = (t0 + i / RATE - tA) * rate, j = Math.floor(x);
        if (j - TAP + 1 < 0 || j + TAP >= len || !have[j]) continue;
        const ph = Math.min(P - 1, Math.round((x - j) * P)), row = ph * K;
        let sl = 0, sr = 0;
        for (let k = 0; k < K; k++) { const h = tab[row + k], idx = j - TAP + 1 + k; sl += xl[idx] * h; sr += xr[idx] * h; }
        L[i] = sl; R[i] = sr; filled++;
      }
    }
    return filled >= (1 - (tolerance || 0.02)) * n ? { L, R } : null;
  };

  // mono (pour les comparaisons avec le son joué)
  RefAudio.prototype.get = function (t0, n) {
    const s = this.getStereo(t0, n, 0.05);
    if (!s) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.5 * (s.L[i] + s.R[i]);
    return out;
  };

  // Où se trouve l'extrait « played » (son joué) dans la référence autour de tGuess ?
  // Renvoie { t : instant (s) du premier échantillon de played, quality } ou null.
  RefAudio.prototype.locate = function (played, tGuess, span) {
    const n = played.length;
    const t0 = tGuess - span, m = Math.round(2 * span * RATE) + n;
    const ref = this.get(t0, m);
    if (!ref) return null;
    const S = root.BRVSync;
    let size = 1; while (size < m + n) size <<= 1;
    const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
    ar.set(ref); br.set(played);
    S.fft(ar, ai, false); S.fft(br, bi, false);
    for (let k = 0; k < size; k++) {                  // corrélation : A · conj(B)
      const r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k];
      ar[k] = r; ai[k] = i;
    }
    S.fft(ar, ai, true);
    let best = 0, bi_ = -1;
    for (let lag = 0; lag <= m - n; lag++) if (ar[lag] > best) { best = ar[lag]; bi_ = lag; }
    if (bi_ < 0) return null;
    let pe = 0, re = 0;
    for (let i = 0; i < n; i++) { pe += played[i] * played[i]; re += ref[bi_ + i] * ref[bi_ + i]; }
    const quality = best / Math.sqrt(pe * re + 1e-20);
    let frac = 0;
    if (bi_ > 0 && bi_ < m - n) {
      const a = ar[bi_ - 1], b = ar[bi_], c = ar[bi_ + 1], den = a - 2 * b + c;
      if (den) frac = 0.5 * (a - c) / den;
    }
    return { t: t0 + (bi_ + frac) / RATE, quality };
  };

  // ressemblance exacte entre played et la référence à l'instant t (sans recherche)
  RefAudio.prototype.similarity = function (played, t) {
    const n = played.length, ref = this.get(t, n);
    if (!ref) return null;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { ab += played[i] * ref[i]; aa += played[i] * played[i]; bb += ref[i] * ref[i]; }
    return ab / Math.sqrt(aa * bb + 1e-20);
  };

  root.BRVRefAudio = { RefAudio, WebmParser, Mp4Parser };
})(typeof globalThis !== "undefined" ? globalThis : this);
