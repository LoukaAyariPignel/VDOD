"""Accès à ffmpeg : localisation, analyse des vidéos, détection du matériel."""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from fractions import Fraction
from functools import lru_cache

import numpy as np

NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


class FFmpegMissing(RuntimeError):
    pass


def _find(name: str) -> str:
    exe = name + (".exe" if sys.platform == "win32" else "")
    env = os.environ.get("BRV_FFMPEG_DIR")
    candidates = []
    if env:
        candidates.append(os.path.join(env, exe))
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates += [os.path.join(here, "ffmpeg", "bin", exe), os.path.join(here, "ffmpeg", exe)]
    w = shutil.which(name)
    if w:
        candidates.append(w)
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [os.path.join(local, "Microsoft", "WinGet", "Links", exe)]
        candidates += sorted(glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "*FFmpeg*",
                                                    "*", "bin", exe)), reverse=True)
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    raise FFmpegMissing(
        "ffmpeg est introuvable. Installez-le (par exemple « winget install Gyan.FFmpeg ») "
        "ou placez-le dans le dossier « ffmpeg » à côté de l'application.")


@lru_cache(None)
def ffmpeg() -> str:
    return _find("ffmpeg")


@lru_cache(None)
def ffprobe() -> str:
    return _find("ffprobe")


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, creationflags=NO_WINDOW, **kw)


def popen(args: list[str], **kw) -> subprocess.Popen:
    return subprocess.Popen(args, creationflags=NO_WINDOW, **kw)


def filter_path(p: str) -> str:
    """Chemin utilisable dans une option de filtre ffmpeg."""
    return p.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


# ---------------------------------------------------------------- analyse

@dataclass
class MediaInfo:
    path: str
    width: int
    height: int
    sar: float
    fps: Fraction
    duration: float
    frames: int
    codec: str
    has_audio: bool
    audio_desc: str
    size: int
    rotation: int = 0
    audio_channels: int = 0
    color_space: str = ""

    @property
    def matrix(self) -> str:
        """Matrice YUV de la source (les vidéos HD sans étiquette sont en BT.709)."""
        if self.color_space in ("bt470bg", "smpte170m", "bt601"):
            return "bt601"
        if self.color_space in ("", "unknown") and self.height < 720:
            return "bt601"
        return "bt709"

    @property
    def fps_float(self) -> float:
        return float(self.fps)

    def describe(self) -> str:
        d = format_duration(self.duration)
        fps = f"{self.fps_float:.3f}".rstrip("0").rstrip(".").replace(".", ",")
        return (f"{d} — {self.width}×{self.height} — {fps} images/s — "
                f"{format_size(self.size)}" + ("" if self.has_audio else " — sans son"))


def _frac(s: str | None) -> Fraction | None:
    if not s or s in ("0/0", "N/A"):
        return None
    try:
        f = Fraction(s)
        return f if f > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def probe(path: str) -> MediaInfo:
    r = run([ffprobe(), "-v", "error", "-show_streams", "-show_format", "-of", "json", path])
    if r.returncode != 0:
        raise RuntimeError("Impossible de lire ce fichier vidéo : "
                           + r.stderr.decode(errors="replace").strip()[-300:])
    data = json.loads(r.stdout)
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")), None)
    if v is None:
        raise RuntimeError("Ce fichier ne contient pas d'image vidéo.")
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fps = _frac(v.get("avg_frame_rate")) or _frac(v.get("r_frame_rate")) or Fraction(30)
    # ffprobe donne parfois 30000/1001 en avg et 60000/1001 en r pour de l'entrelacé : on garde avg
    fps = fps.limit_denominator(1001)
    dur = 0.0
    for d in (v.get("duration"), data.get("format", {}).get("duration")):
        try:
            dur = float(d)
            if dur > 0:
                break
        except (TypeError, ValueError):
            pass
    sar = _frac(v.get("sample_aspect_ratio")) or Fraction(1)
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"]) % 360
    w, h = int(v["width"]), int(v["height"])
    if rot in (90, 270):
        w, h = h, w
    try:
        size = int(data["format"]["size"])
    except (KeyError, ValueError):
        size = os.path.getsize(path)
    frames = int(round(dur * float(fps)))
    adesc = ""
    if a:
        adesc = f"{a.get('codec_name', '?')} {a.get('sample_rate', '?')} Hz, {a.get('channels', '?')} can."
    return MediaInfo(path=path, width=w, height=h, sar=float(sar), fps=fps, duration=dur,
                     frames=frames, codec=v.get("codec_name", "?"), has_audio=a is not None,
                     audio_desc=adesc, size=size, rotation=rot,
                     audio_channels=int(a.get("channels", 2) or 2) if a else 0,
                     color_space=v.get("color_space", "") or "")


def grab_rgb(path: str, t: float, w: int, h: int, fit: bool = False, matrix: str = "bt709") -> np.ndarray:
    """Extrait l'image à l'instant t, en RGB w×h (fit : conserver les proportions avec bandes noires)."""
    if fit:
        vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease:in_color_matrix={matrix},"
              f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black")
    else:
        vf = f"scale={w}:{h}:in_color_matrix={matrix}"
    r = run([ffmpeg(), "-v", "error", "-nostdin", "-ss", f"{max(0.0, t):.6f}", "-i", path,
             "-frames:v", "1", "-vf", vf + ",format=rgb24", "-f", "rawvideo", "-"])
    need = w * h * 3
    if r.returncode != 0 or len(r.stdout) < need:
        raise RuntimeError("Impossible d'extraire une image : "
                           + r.stderr.decode(errors="replace").strip()[-300:])
    return np.frombuffer(r.stdout[:need], np.uint8).reshape(h, w, 3)


# ---------------------------------------------------------------- matériel

@dataclass
class Hardware:
    gpu_name: str = ""
    opencl: bool = False
    family: str = "cpu"            # nvenc, qsv, amf, cpu
    encoders: dict = field(default_factory=dict)   # "h264"/"hevc" -> nom ffmpeg
    qsv_low_power: bool = False
    hwaccel: list = field(default_factory=list)
    ffmpeg_version: str = ""

    @property
    def accelerated(self) -> bool:
        return self.family != "cpu"

    def describe(self) -> str:
        fam = {"nvenc": "NVIDIA NVENC", "qsv": "Intel Quick Sync", "amf": "AMD AMF",
               "cpu": "logiciel (processeur)"}[self.family]
        who = self.gpu_name or "Carte graphique"
        scr = "brouillage sur la carte graphique" if self.opencl else "brouillage sur le processeur"
        if self.accelerated:
            return f"{who} : encodage accéléré ({fam}), {scr}"
        return f"Pas d'encodeur matériel détecté : encodage logiciel, {scr}"

    def signature(self) -> str:
        return f"{self.gpu_name}|{self.family}|{self.opencl}|{self.encoders}|{self.qsv_low_power}|{self.ffmpeg_version}"


_TEST_KERNEL = r"""
__kernel void scramble(__write_only image2d_t dst, unsigned int index, __read_only image2d_t src)
{
    const sampler_t s = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_LINEAR;
    int2 p = (int2)(get_global_id(0), get_global_id(1));
    write_imagef(dst, p, read_imagef(src, s, (float2)(p.x + 0.5f, p.y + 0.5f)));
}
"""


def _encode_test(encoder: str, extra: list[str]) -> bool:
    r = run([ffmpeg(), "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30",
             "-frames:v", "3", "-pix_fmt", "nv12", "-c:v", encoder, *extra, "-f", "null", "-"],
            timeout=60)
    return r.returncode == 0


def opencl_args() -> list[str]:
    return ["-init_hw_device", "opencl=ocl", "-filter_hw_device", "ocl"]


def detect_hardware(tmpdir: str) -> Hardware:
    hw = Hardware()
    r = run([ffmpeg(), "-hide_banner", "-version"])
    first = r.stdout.decode(errors="replace").splitlines()[:1]
    hw.ffmpeg_version = first[0] if first else "?"
    hw.hwaccel = ["-hwaccel", "d3d11va"] if sys.platform == "win32" else ["-hwaccel", "auto"]

    # OpenCL (brouillage sur la carte graphique)
    try:
        os.makedirs(tmpdir, exist_ok=True)
        kp = os.path.join(tmpdir, "test.cl")
        with open(kp, "w", encoding="ascii") as f:
            f.write(_TEST_KERNEL)
        r = run([ffmpeg(), "-v", "verbose", "-nostdin", *opencl_args(), "-f", "lavfi",
                 "-i", "color=c=gray:s=320x180:r=30", "-frames:v", "2", "-vf",
                 f"format=nv12,hwupload,program_opencl=source='{filter_path(kp)}':kernel=scramble,"
                 "hwdownload,format=nv12", "-f", "null", "-"], timeout=60)
        log = r.stderr.decode(errors="replace")
        hw.opencl = r.returncode == 0
        m = re.search(r"\] 0\.0: [^/\n]*/ ?([^\r\n]+)", log)
        if m:
            hw.gpu_name = m.group(1).strip()
    except Exception:
        hw.opencl = False

    # Encodeurs matériels
    for fam, h264, hevc in (("nvenc", "h264_nvenc", "hevc_nvenc"),
                            ("qsv", "h264_qsv", "hevc_qsv"),
                            ("amf", "h264_amf", "hevc_amf")):
        try:
            extra = ["-low_power", "1"] if fam == "qsv" else []
            ok = _encode_test(h264, extra)
            if fam == "qsv" and ok:
                hw.qsv_low_power = True
            elif fam == "qsv":
                ok = _encode_test(h264, [])
            if not ok:
                continue
            hw.family = fam
            hw.encoders = {"h264": h264}
            if _encode_test(hevc, extra if hw.qsv_low_power else []):
                hw.encoders["hevc"] = hevc
            break
        except Exception:
            continue
    if hw.family == "cpu":
        hw.encoders = {"h264": "libx264"}
    if not hw.gpu_name and sys.platform == "win32":
        try:
            r = run(["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"], timeout=20)
            hw.gpu_name = r.stdout.decode(errors="replace").strip()
        except Exception:
            pass
    return hw


# Étiquettes de couleur posées dans le graphe de filtres : en option de l'encodeur, elles
# feraient insérer par ffmpeg une conversion logicielle très lente en 4K.
COLOR_TAGS = "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709"


def encoder_args(hw: Hardware, res: int, fps: Fraction, bitrate_mbps: float) -> list[str]:
    """Arguments de compression vidéo : mode le plus rapide, débit élevé et fixe."""
    b = f"{bitrate_mbps:g}M"
    gop = str(max(1, round(float(fps) * 2)))
    common = ["-b:v", b, "-maxrate", b, "-bufsize", f"{bitrate_mbps * 2:g}M", "-g", gop]
    codec = "hevc" if res >= 1440 and "hevc" in hw.encoders else "h264"
    enc = hw.encoders.get(codec, "libx264")
    if hw.family == "nvenc":
        return ["-c:v", enc, "-preset", "p1", "-rc", "cbr", "-bf", "0", *common]
    if hw.family == "qsv":
        lp = ["-low_power", "1"] if hw.qsv_low_power else []
        return ["-c:v", enc, "-preset", "veryfast", *lp, "-async_depth", "4", *common]
    if hw.family == "amf":
        return ["-c:v", enc, "-quality", "speed", "-rc", "cbr", *common]
    return ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", *common]


# ---------------------------------------------------------------- formatage

def format_duration(sec: float) -> str:
    sec = max(0, int(round(sec)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h} h {m:02d} min"
    if m:
        return f"{m} min {s:02d} s"
    return f"{s} s"


def format_size(n: float) -> str:
    for unit in ("octets", "Ko", "Mo", "Go", "To"):
        if n < 1000 or unit == "To":
            return f"{n:.0f} {unit}" if unit == "octets" else f"{n:.1f} {unit}".replace(".", ",")
        n /= 1000
    return ""


def format_int(n: int) -> str:
    return f"{n:,}".replace(",", " ")
