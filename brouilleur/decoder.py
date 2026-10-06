"""Décodeur BRV1 : lecture de la clé et export d'une vidéo débrouillée."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import threading
import time

import numpy as np

from . import audio, core, ff, geometry
from .pipeline import Cancelled, Control, _run_ffmpeg, prevent_sleep

PAYLOAD_RE = re.compile(r"^BRV([1-4]):(\d+)X(\d+):([A-Z0-9]{4,16})$")


def parse_payload(txt: str | None) -> tuple[str, int] | None:
    """(clé, version du format) d'un texte de QR code BRV1/2/3, ou None."""
    m = PAYLOAD_RE.match((txt or "").strip())
    if not m or (int(m.group(2)), int(m.group(3))) != (core.GRID_X, core.GRID_Y):
        return None
    return m.group(4), int(m.group(1))


def read_qr(gray: np.ndarray) -> str | None:
    try:
        import cv2  # type: ignore
    except ImportError:
        return None
    txt, _, _ = cv2.QRCodeDetector().detectAndDecode(gray)
    return parse_payload(txt)


def find_key(path: str, seconds: float = 1.0) -> tuple[str, int] | None:
    """Cherche le QR code dans les images de la première seconde : (clé, version)."""
    w, h = 640, 360
    p = ff.popen([ff.ffmpeg(), "-v", "error", "-nostdin", "-t", f"{seconds}", "-i", path, "-map", "0:v:0",
                  "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    found = None
    try:
        while True:
            buf = p.stdout.read(w * h)
            if len(buf) < w * h:
                break
            found = read_qr(np.frombuffer(buf, np.uint8).reshape(h, w))
            if found:
                break
    finally:
        p.kill()
        p.wait()
    return found


def _cache_file() -> str:
    from .bench import config_dir
    return os.path.join(config_dir(), "cles.json")


def _cache_id(path: str) -> str:
    st = os.stat(path)
    return f"{os.path.basename(path)}|{st.st_size}"


def remembered_key(path: str) -> tuple[str, int] | None:
    try:
        with open(_cache_file(), encoding="utf-8") as f:
            v = json.load(f).get(_cache_id(path))
    except (OSError, ValueError):
        return None
    if not v:
        return None
    if ":" in v:
        ver, key = v.split(":", 1)
        return key, int(ver)
    return v, 1


def remember_key(path: str, key: str, version: int = core.FORMAT_VERSION):
    try:
        with open(_cache_file(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data[_cache_id(path)] = f"{version}:{key}"
    with open(_cache_file(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


def locate_key(path: str) -> tuple[str | None, int, str]:
    """(clé, version, origine) : QR code en priorité, sinon clé mémorisée pour ce fichier."""
    found = find_key(path)
    if found:
        remember_key(path, *found)
        return found[0], found[1], "qr"
    found = remembered_key(path)
    if found:
        return found[0], found[1], "memoire"
    return None, core.FORMAT_VERSION, ""


# ---------------------------------------------------------------- son

_SEEK_FIX: dict[str, int] = {}


def _seek_args(path: str, start: float) -> list[str]:
    """Options ffmpeg pour lire à partir de start, à l'échantillon près.

    Un saut « -ss » avant le fichier n'est pas exact en Opus (.webm, d'ordinaire −48 échantillons)
    ni en AAC (.m4a, plusieurs centaines) ; le mélange des bandes et BRV4 exigent l'échantillon
    près. On saute donc grossièrement 1 s avant, puis finement (décodage) ; l'écart qui reste
    (constant pour un fichier) est mesuré une fois sur le début du fichier et compensé.
    """
    if start <= 0:
        return ["-i", path]
    coarse = max(0.0, start - 1.0)
    t = start
    if coarse > 0:                      # l'écart ne vient que du saut grossier
        t = start + _seek_fix(path) / core.AUDIO_RATE
        coarse = max(0.0, t - 1.0)
    args = (["-ss", f"{coarse:.6f}"] if coarse > 0 else []) + ["-i", path]
    if t - coarse > 0:
        args += ["-ss", f"{t - coarse:.6f}"]
    return args


def _seek_fix(path: str) -> int:
    """Écart (échantillons) d'un saut grossier + fin dans ce fichier, mesuré contre un décodage continu."""
    key = os.path.abspath(path)
    if key in _SEEK_FIX:
        return _SEEK_FIX[key]
    fix = 0
    try:
        rate, t0 = core.AUDIO_RATE, 2.5
        base = [ff.ffmpeg(), "-v", "error", "-nostdin"]
        tail = ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
        full = np.frombuffer(ff.run(base + ["-i", path, "-t", "4"] + tail).stdout, np.float32)
        part = np.frombuffer(ff.run(base + ["-ss", "1.5", "-i", path, "-ss", "1.0", "-t", "1"] + tail).stdout, np.float32)
        n = round(t0 * rate)
        if len(full) > n + 3000 + 24000 and len(part) >= 24000 and np.abs(part[:24000]).max() > 1e-4:
            ref = full[n - 3000: n + 3000 + 24000]
            L = 1 << 16
            c = np.fft.irfft(np.fft.rfft(ref, L) * np.conj(np.fft.rfft(part[:24000], L)), L)[:6001]
            k = int(np.argmax(c)) - 3000
            q = c[k + 3000] / (np.linalg.norm(part[:24000]) * np.linalg.norm(ref[k + 3000:k + 3000 + 24000]) + 1e-12)
            if q > 0.9:
                fix = -k
    except Exception:
        fix = 0
    _SEEK_FIX[key] = fix
    return fix


def audio_source(path: str, start: float, rate: int = core.AUDIO_RATE, ch: int = 2, ctl: Control | None = None):
    """Son d'un fichier, en float32 (n, ch), à partir de l'instant start (≥ 0), à l'échantillon près."""
    cmd = [ff.ffmpeg(), "-v", "error", "-nostdin"] + _seek_args(path, start)
    cmd += ["-map", "0:a:0", "-vn", "-ac", str(ch), "-ar", str(rate), "-f", "f32le", "-"]
    p = ff.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    if ctl:
        ctl.add(p)

    def gen():
        block = rate // 10 * ch * 4
        try:
            while True:
                if ctl:
                    ctl.check()
                buf = p.stdout.read(block)
                if not buf:
                    return
                n = len(buf) // (4 * ch)
                yield np.frombuffer(buf[: n * 4 * ch], np.float32).reshape(n, ch)
        finally:
            if p.poll() is None:
                p.kill()
            p.wait()
            if ctl:
                ctl.remove(p)
    return gen()


def calibrate(path: str) -> float:
    """Décalage du son du fichier, en échantillons à 48 kHz (réel), mesuré sur le bip de repère.

    Le bip commence à l'instant 0 du son publié ; une recompression peut le déplacer de
    quelques échantillons (délai ou déphasage du codec). Le mélange des bandes de fréquences
    exige un alignement au sous-échantillon près, d'où la mesure fine (interpolation
    parabolique du pic de corrélation). Renvoie 0 si le bip est introuvable.
    """
    rate = core.AUDIO_RATE
    r = ff.run([ff.ffmpeg(), "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(rate),
                "-t", "0.4", "-f", "f32le", "-"])
    x = np.frombuffer(r.stdout, np.float32)
    if len(x) < rate // 10:
        return 0.0
    tpl = audio.beep(rate)
    pad = 2048
    y = np.concatenate([np.zeros(pad, np.float32), x])
    # seule la partie < 3 kHz du bip compte : c'est la zone des bandes mélangées, que tous les
    # codecs gardent fidèlement (Opus à bas débit déforme la phase des aigus)
    L = 1 << int(np.ceil(np.log2(len(y) + len(tpl))))
    f = np.fft.rfftfreq(L, 1 / rate)
    mask = (f < 3000).astype(np.float64)
    Y = np.fft.rfft(y, L) * mask
    T = np.fft.rfft(tpl, L) * mask
    c = np.fft.irfft(Y * np.conj(T), L)[: len(y) - len(tpl) + 1]
    tpl = np.fft.irfft(T, L)[: len(tpl)]
    y = np.fft.irfft(Y, L)[: len(y)]
    k = int(np.argmax(c))
    seg = y[k:k + len(tpl)]
    quality = c[k] / (np.linalg.norm(tpl) * np.linalg.norm(seg) + 1e-12)
    if quality < 0.5 or not 0 < k < len(c) - 1:
        return 0.0
    a, b, e = c[k - 1], c[k], c[k + 1]
    den = a - 2 * b + e
    frac = 0.5 * (a - e) / den if den else 0.0
    raw = float(k - pad + frac)
    # Opus à ≤ 48 kbit/s change de mode en cours de route et son retard varie de −2,4 à +1
    # échantillon : un écart intermédiaire mesuré au début n'est pas fiable, le meilleur
    # choix moyen est alors 0. Les petits déphasages (filtres) et les gros décalages
    # (délai de codec mal compensé) sont, eux, stables et corrigés.
    if 0.75 <= abs(raw) < 3:
        return 0.0
    return raw


def _frac_advance(source, frac: float, ch: int, taps: int = 16):
    """y[n] = x[n + frac] (|frac| ≤ 0,5), par interpolation sinc fenêtrée.

    La source doit commencer `taps` échantillons avant le premier échantillon voulu.
    """
    k = np.arange(-taps, taps + 1)
    h = np.sinc(k - frac) * np.blackman(2 * taps + 3)[1:-1]
    h = (h / h.sum()).astype(np.float32)[::-1]
    buf = np.zeros((0, ch), np.float32)
    for b in source:
        buf = np.concatenate([buf, b])
        if len(buf) <= 2 * taps:
            continue
        out = np.stack([np.convolve(buf[:, c], h, "valid") for c in range(ch)], axis=1)
        yield out.astype(np.float32)
        buf = buf[-2 * taps:]


def decoded_audio(path: str, key: str, fps: float, t_pub: float, ch: int = 2,
                  ctl: Control | None = None, version: int = core.FORMAT_VERSION, offset: float = 0.0):
    """Son débrouillé tel qu'il doit sortir à partir de l'instant t_pub du fichier publié.

    offset : décalage mesuré par calibrate(), compensé à la lecture.
    Avant la fin de l'ouverture, c'est du silence (le bip de repère est masqué).
    """
    from . import bands
    rate = core.AUDIO_RATE
    plan = core.audio_plan(key)
    g = audio.Geometry(rate)
    v0 = t_pub - core.OPENING_S         # instant « virtuel » (voir SPEC.md §5)
    lead = 0
    if v0 < 0:
        lead = round(-v0 * rate)
        v0 = 0.0
    v = round(v0 * rate)
    if version >= 4:
        from . import mdct4
        t_read, k_start, skip4 = mdct4.read_start(v0, rate)

        def gen4():
            n = lead
            while n > 0:
                k = min(n, rate // 10)
                n -= k
                yield np.zeros((k, ch), np.float32)
            s = mdct4.descramble_stream(_aligned_source(path, t_read, offset, rate, ch, ctl), plan, key, ch, k_start, rate)
            skip = skip4
            for b in s:
                if skip:
                    cut = min(skip, len(b))
                    b = b[cut:]
                    skip -= cut
                if len(b):
                    yield b
        return gen4()
    k0 = v // g.W
    if version == 2 and k0 > 0:
        k0 -= 1                         # une fenêtre de contexte pour les trames MDCT
    a0 = k0 * g.W - g.M                 # indice virtuel du premier échantillon débrouillé
    pre = 2 * bands.N if version >= 3 else 0   # contexte MDCT avant le début (BRV3)
    start = (g.G + a0 - pre) / rate

    def gen():
        n = lead
        while n > 0:
            k = min(n, rate // 10)
            n -= k
            yield np.zeros((k, ch), np.float32)
        s = _aligned_source(path, start, offset, rate, ch, ctl)
        if version >= 3:
            s = _drop(bands.process_stream(s, key, g.G + a0 - pre, True, ch, rate,
                                           **bands.published_params(rate)), pre)
        s = audio.descramble_stream(s, plan, ch, 0, rate)
        if version == 2:
            s = bands.process_stream(s, key, a0, True, ch, rate)
        skip = v - a0
        for b in s:
            if skip:
                cut = min(skip, len(b))
                b = b[cut:]
                skip -= cut
            if len(b):
                yield b
    return gen()


def _drop(source, n: int):
    for b in source:
        if n:
            cut = min(n, len(b))
            b = b[cut:]
            n -= cut
        if len(b):
            yield b


def _aligned_source(path: str, start: float, offset: float, rate: int, ch: int, ctl):
    """Son publié à partir de start (secondes nominales), corrigé du décalage mesuré."""
    whole = int(np.floor(offset + 0.5))
    frac = offset - whole
    taps = 16 if abs(frac) > 0.02 else 0
    first = round(start * rate) + whole - taps          # échantillon réel à lire en premier
    lead = max(0, -first)

    def gen():
        if lead:
            yield np.zeros((lead, ch), np.float32)
        yield from audio_source(path, max(0, first) / rate, rate, ch, ctl)
    return _frac_advance(gen(), frac, ch, taps) if taps else gen()


# ---------------------------------------------------------------- export

class DecodeJob:
    """Recrée un fichier vidéo normal à partir d'une vidéo brouillée."""

    def __init__(self, job: dict, emit, ctl: Control):
        self.job, self.emit, self.ctl = job, emit, ctl
        self.hw = ff.Hardware(**job["hardware"])
        self.info = ff.probe(job["src"])
        self.fps = self.info.fps
        self.n_open = core.opening_frames(float(self.fps))
        stem = os.path.splitext(os.path.basename(job["src"]))[0]
        if stem.endswith("_brouille"):
            stem = stem[: -len("_brouille")]
        d = job.get("out_dir") or os.path.dirname(os.path.abspath(job["src"]))
        self.out = os.path.join(d, f"{stem}_debrouille.mp4")
        self.t0 = time.monotonic()

    def log(self, msg):
        self.emit({"type": "log", "msg": msg})

    def run(self) -> dict:
        prevent_sleep(True)
        tmp_files = []
        try:
            key = self.job.get("key")
            version = int(self.job.get("version", core.FORMAT_VERSION))
            if not key:
                key, version, _ = locate_key(self.job["src"])
            if not key:
                from .pipeline import UserError
                raise UserError("Aucun QR code BRV1 trouvé au début de cette vidéo : saisissez la clé.")
            key = core.normalize_key(key)
            self.log(f"Clé : {key}")
            self.emit({"type": "stage", "stage": "Son"})
            audio_path = None
            if self.info.has_audio:
                audio_path = self.out + ".son.m4a"
                tmp_files.append(audio_path)
                self._audio(key, audio_path, version)
            self.emit({"type": "stage", "stage": "Image"})
            self._video(key, audio_path, tmp_files)
            return {"type": "done", "out": self.out, "size": os.path.getsize(self.out), "key": key,
                    "elapsed": time.monotonic() - self.t0 - self.ctl.paused_time,
                    "duration": max(0.0, self.info.duration - self.n_open / float(self.fps))}
        finally:
            prevent_sleep(False)
            for f in tmp_files:
                try:
                    os.remove(f)
                except OSError:
                    pass

    def _audio(self, key: str, path: str, version: int):
        rate = core.AUDIO_RATE
        opening = self.n_open / float(self.fps)
        enc = ff.popen([ff.ffmpeg(), "-hide_banner", "-y", "-v", "error", "-f", "f32le", "-ar", str(rate), "-ac", "2",
                        "-i", "pipe:0", "-c:a", "aac", "-b:a", "256k", "-f", "mp4", path],
                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.ctl.add(enc)
        total = max(1.0, self.info.duration - opening)
        done = 0
        last = 0.0
        try:
            off = calibrate(self.job["src"])
            self.log(f"Calage du son : {off:+.2f} échantillon(s)")
            for block in decoded_audio(self.job["src"], key, float(self.fps), opening, 2, self.ctl, version, off):
                enc.stdin.write(block.tobytes())
                done += len(block)
                if time.monotonic() - last > 0.25:
                    last = time.monotonic()
                    self.emit({"type": "audio", "done": min(done, total * rate), "total": total * rate,
                               "elapsed": time.monotonic() - self.t0})
            enc.stdin.close()
            enc.wait()
        finally:
            self.ctl.remove(enc)
        if self.ctl.cancelled:
            raise Cancelled()
        if enc.returncode != 0:
            raise RuntimeError("ffmpeg a échoué : compression du son")

    def _video(self, key: str, audio_path: str | None, tmp_files: list):
        plan = core.video_plan(key)
        W, H = self.info.width, self.info.height
        res = min(core.RESOLUTIONS, key=lambda r: abs(r - H))
        enc = ff.encoder_args(self.hw, res, self.fps, core.BITRATES_MBPS[res])
        if self.hw.family != "cpu":
            enc += ["-pix_fmt", "nv12"]
        head = f"[0:v]trim=start_frame={self.n_open},setpts=PTS-STARTPTS"
        extra, pre = [], []
        if self.hw.opencl:
            kp = self.out + ".cl"
            tmp_files.append(kp)
            with open(kp, "w", encoding="ascii") as f:
                f.write(geometry.opencl_unscramble_kernel(plan))
            pre = [*ff.opencl_args(), *self.hw.hwaccel]
            graph = (f"{head},format=nv12,hwupload,program_opencl=source='{ff.filter_path(kp)}':"
                     f"kernel=unscramble,hwdownload,format=nv12,{ff.COLOR_TAGS}[v]")
        else:
            xp, yp = self.out + ".x.pgm", self.out + ".y.pgm"
            tmp_files += [xp, yp]
            geometry.write_unscramble_maps(plan, W, H, xp, yp)
            extra = ["-i", xp, "-i", yp]
            graph = (f"{head},format=yuv444p,split[a][b];"
                     f"[b]lutyuv=y='clip(251-val,0,255)':u='clip(256-val,0,255)':v='clip(256-val,0,255)'[n];"
                     f"[a][n]hstack[e];[e][1:v][2:v]remap=format=color:fill=black,"
                     f"format={'nv12' if self.hw.family != 'cpu' else 'yuv420p'},{ff.COLOR_TAGS}[v]")
        ain = ["-i", audio_path] if audio_path else []
        amap = ["-map", f"{3 if extra else 1}:a:0", "-c:a", "copy"] if audio_path else []
        total = max(1, self.info.frames - self.n_open)
        hevc = "hevc" in enc[1]
        part = self.out + ".part.mp4"
        tmp_files.append(part)

        def on_frame(n):
            el = time.monotonic() - self.t0 - self.ctl.paused_time
            self.emit({"type": "progress", "frames": n, "total": total, "elapsed": el})

        _run_ffmpeg([*pre, "-i", self.job["src"], *extra, *ain, "-filter_complex", graph, "-map", "[v]", *amap,
                     "-fps_mode", "passthrough", *enc, *(["-tag:v", "hvc1"] if hevc else []),
                     "-movflags", "+faststart", "-f", "mp4", part], self.ctl, self.log, on_frame)
        os.replace(part, self.out)
