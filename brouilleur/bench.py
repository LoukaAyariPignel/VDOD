"""Détection du matériel et essai de vitesse, mémorisés entre les lancements."""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict

from . import core, ff, geometry

TARGET_SPEED = 6.0          # 10 min pour 1 h de vidéo
BENCH_SECONDS = 10


def config_dir() -> str:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        d = os.path.join(base, "Brouilleur")
    else:
        d = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "brouilleur")
    os.makedirs(d, exist_ok=True)
    return d


def _cache_path() -> str:
    return os.path.join(config_dir(), "materiel.json")


def load_cache() -> dict:
    try:
        with open(_cache_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cache(data: dict):
    with open(_cache_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)


def hardware(force: bool = False) -> ff.Hardware:
    """Matériel détecté (rapide si déjà en cache et si le pilote n'a pas changé)."""
    cache = load_cache()
    if not force and "hardware" in cache:
        try:
            hw = ff.Hardware(**cache["hardware"])
            if hw.ffmpeg_version and hw.ffmpeg_version in ff.run([ff.ffmpeg(), "-hide_banner", "-version"]
                                                                 ).stdout.decode(errors="replace"):
                return hw
        except TypeError:
            pass
    hw = ff.detect_hardware(os.path.join(config_dir(), "tmp"))
    cache = {"hardware": asdict(hw)}
    save_cache(cache)
    return hw


def speeds(hw: ff.Hardware) -> dict | None:
    cache = load_cache()
    b = cache.get("bench")
    if b and b.get("signature") == hw.signature():
        return {int(k): v for k, v in b["fps"].items()}
    return None


def _sample_clip() -> str:
    path = os.path.join(config_dir(), "essai_1080p.mp4")
    if not os.path.exists(path):
        tmp = path + ".part.mp4"
        r = ff.run([ff.ffmpeg(), "-y", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                    "testsrc2=s=1920x1080:r=30,noise=alls=12:allf=t", "-t", str(BENCH_SECONDS),
                    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "12M", "-pix_fmt", "yuv420p", tmp])
        if r.returncode != 0:
            raise RuntimeError("Impossible de créer la vidéo d'essai : " + r.stderr.decode(errors="replace")[-300:])
        os.replace(tmp, path)
    return path


def run_bench(hw: ff.Hardware, progress=None) -> dict:
    """Essai sur 10 secondes de vidéo 1080p30 dans chaque résolution de sortie ; renvoie images/s."""
    from fractions import Fraction
    clip = _sample_clip()
    tmp = os.path.join(config_dir(), "tmp")
    os.makedirs(tmp, exist_ok=True)
    plan = core.video_plan("ESSAI000")
    kp = os.path.join(tmp, "essai.cl")
    with open(kp, "w", encoding="ascii") as f:
        f.write(geometry.opencl_kernel(plan, (0, 0, 1, 1)))
    xp, yp = os.path.join(tmp, "x.pgm"), os.path.join(tmp, "y.pgm")
    result = {}
    for i, res in enumerate(sorted(core.RESOLUTIONS)):
        if progress:
            progress(i, len(core.RESOLUTIONS), res)
        W, H = core.RESOLUTIONS[res]
        enc = ff.encoder_args(hw, res, Fraction(30), core.BITRATES_MBPS[res])
        if hw.family != "cpu":
            enc += ["-pix_fmt", "nv12"]
        if hw.opencl:
            args = [*ff.opencl_args(), *hw.hwaccel, "-i", clip, "-filter_complex",
                    f"[0:v]format=nv12,hwupload,program_opencl=source='{ff.filter_path(kp)}':kernel=scramble:"
                    f"s={W}x{H},hwdownload,format=nv12,{ff.COLOR_TAGS}[v]"]
        else:
            geometry.write_remap_maps(plan, W, H, xp, yp)
            args = ["-i", clip, "-i", xp, "-i", yp, "-filter_complex",
                    f"[0:v]scale={W}:{H},format=yuv444p,split[a][b];[b]negate[n];[a][n]hstack[e];"
                    f"[e][1:v][2:v]remap=format=color,format={'nv12' if hw.family != 'cpu' else 'yuv420p'},{ff.COLOR_TAGS}[v]"]
        cmd = [ff.ffmpeg(), "-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1",
               "-stats_period", "0.1", *args, "-map", "[v]", *enc, "-f", "null", "-"]
        result[res] = round(_steady_fps(cmd), 1)
    cache = load_cache()
    cache["bench"] = {"signature": hw.signature(), "fps": result, "date": time.time()}
    save_cache(cache)
    return result


def _steady_fps(cmd: list[str]) -> float:
    """Vitesse en régime établi : le démarrage d'ffmpeg ne compte pas pour une longue vidéo."""
    import subprocess
    p = ff.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    marks = []
    for raw in p.stdout:
        line = raw.decode(errors="replace").strip()
        if line.startswith("frame="):
            try:
                n = int(line[6:])
            except ValueError:
                continue
            if n > 0:
                marks.append((time.perf_counter(), n))
    p.wait()
    if p.returncode != 0 or len(marks) < 2:
        return 0.0
    # on ignore le premier tiers (montée en charge)
    first = marks[len(marks) // 3]
    last = marks[-1]
    if last[0] <= first[0]:
        return 0.0
    return (last[1] - first[1]) / (last[0] - first[0])


def choose_resolution(mode: str, fps_video: float, bench: dict | None) -> int:
    """Rapide : la plus haute résolution qui tient ×6 le temps réel. Qualité : 4K."""
    if mode == "qualite":
        return 2160
    if not bench:
        return 1080
    need = TARGET_SPEED * fps_video
    for res in sorted(bench, reverse=True):
        if bench[res] >= need:
            return res
    return 1080


def estimate_seconds(frames: int, res: int, bench: dict | None, fps_video: float) -> float | None:
    if not bench or not bench.get(res):
        return None
    # le son (≈ 1 à 2 min pour 3 h) s'ajoute à l'image, plus ~15 s fixes (assemblage, vérification)
    return frames / bench[res] + frames / fps_video / 150 + 15
