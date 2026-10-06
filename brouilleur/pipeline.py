"""Encodage complet d'une vidéo : son, ouverture, image par tranches, assemblage, vérification.

Le travail est découpé en tranches de 10 minutes écrites dans un dossier de travail :
une tranche terminée n'est jamais refaite, ce qui permet la reprise après interruption.
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import shutil
import sys
import threading
import time
from dataclasses import asdict
from fractions import Fraction
from typing import Callable

import numpy as np

from . import audio, core, ff, geometry, opening

CHUNK_SECONDS = int(os.environ.get("BRV_CHUNK_SECONDS", "600"))   # tranches de 10 min
STATE_VERSION = 2

Emit = Callable[[dict], None]


class Cancelled(Exception):
    pass


class UserError(Exception):
    """Erreur à afficher telle quelle à l'utilisateur."""


# ---------------------------------------------------------------- contrôle (pause / annulation)

class Control:
    def __init__(self):
        self.running = threading.Event()
        self.running.set()
        self.cancelled = False
        self.procs: set = set()
        self.lock = threading.Lock()
        self.paused_time = 0.0
        self._pause_start = None

    def add(self, p):
        with self.lock:
            self.procs.add(p)
            if not self.running.is_set():
                _suspend(p, True)

    def remove(self, p):
        with self.lock:
            self.procs.discard(p)

    def pause(self):
        with self.lock:
            if self.running.is_set():
                self.running.clear()
                self._pause_start = time.monotonic()
                for p in self.procs:
                    _suspend(p, True)

    def resume(self):
        with self.lock:
            if not self.running.is_set():
                for p in self.procs:
                    _suspend(p, False)
                self.paused_time += time.monotonic() - (self._pause_start or time.monotonic())
                self.running.set()

    def cancel(self):
        with self.lock:
            self.cancelled = True
            for p in self.procs:
                try:
                    _suspend(p, False)
                    p.kill()
                except Exception:
                    pass
            self.running.set()

    def check(self):
        self.running.wait()
        if self.cancelled:
            raise Cancelled()


def _suspend(p, on: bool):
    if p.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            import ctypes
            ntdll = ctypes.WinDLL("ntdll")
            k32 = ctypes.WinDLL("kernel32")
            h = k32.OpenProcess(0x0800, False, p.pid)   # PROCESS_SUSPEND_RESUME
            if h:
                (ntdll.NtSuspendProcess if on else ntdll.NtResumeProcess)(h)
                k32.CloseHandle(h)
        else:
            import signal
            os.kill(p.pid, signal.SIGSTOP if on else signal.SIGCONT)
    except Exception:
        pass


def prevent_sleep(on: bool):
    if sys.platform == "win32":
        try:
            import ctypes
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
            ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))
        except Exception:
            pass


# ---------------------------------------------------------------- utilitaires

def output_paths(src: str, out_dir: str | None) -> tuple[str, str]:
    stem = os.path.splitext(os.path.basename(src))[0]
    d = out_dir or os.path.dirname(os.path.abspath(src))
    out = os.path.join(d, f"{stem}_brouille.mp4")
    work = os.path.join(d, f".{stem}_brouille.travail")
    return out, work


def src_signature(path: str) -> dict:
    st = os.stat(path)
    return {"src": os.path.abspath(path), "size": st.st_size, "mtime": int(st.st_mtime)}


def read_state(work: str) -> dict | None:
    try:
        with open(os.path.join(work, "etat.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def estimate_size(duration: float, res: int, mbps: float | None = None) -> float:
    mbps = core.BITRATES_MBPS[res] if mbps is None else mbps
    return (mbps + core.AUDIO_MBPS) * 1e6 / 8 * (duration + 1)


def _progress_reader(proc, on_frame: Callable[[int], None]):
    """Lit la sortie « -progress » d'ffmpeg."""
    for raw in proc.stdout:
        line = raw.decode(errors="replace").strip()
        if line.startswith("frame="):
            try:
                on_frame(int(line[6:]))
            except ValueError:
                pass


def _run_ffmpeg(args: list[str], ctl: Control, log: Callable[[str], None],
                on_frame: Callable[[int], None] | None = None, stdin=None):
    import subprocess
    cmd = [ff.ffmpeg(), "-hide_banner", *(["-nostdin"] if stdin is None else []),
           "-y", "-v", "error", "-progress", "pipe:1", "-nostats", *args]
    log("ffmpeg " + " ".join(a if " " not in a else f'"{a}"' for a in cmd[1:]))
    p = ff.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                 stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL)
    ctl.add(p)
    err_lines: list[str] = []
    t_err = threading.Thread(target=lambda: err_lines.extend(
        l.decode(errors="replace").rstrip() for l in p.stderr), daemon=True)
    t_err.start()
    t_out = threading.Thread(target=_progress_reader, args=(p, on_frame or (lambda n: None)), daemon=True)
    t_out.start()
    try:
        if stdin is not None:
            try:
                for buf in stdin:
                    ctl.check()
                    p.stdin.write(buf)
                p.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        p.wait()
    finally:
        ctl.remove(p)
    t_out.join(5)
    t_err.join(5)
    if ctl.cancelled:
        raise Cancelled()
    if p.returncode != 0:
        for l in err_lines[-20:]:
            log(l)
        raise RuntimeError("ffmpeg a échoué : " + (err_lines[-1] if err_lines else f"code {p.returncode}"))


# ---------------------------------------------------------------- encodage

class Encoder:
    def __init__(self, job: dict, emit: Emit, ctl: Control):
        self.job = job
        self.emit = emit
        self.ctl = ctl
        self.hw = ff.Hardware(**job["hardware"])
        self.info: ff.MediaInfo = ff.probe(job["src"])
        self.res = int(job["res"])
        self.W, self.H = core.RESOLUTIONS[self.res]
        self.mbps = core.video_mbps(self.res, self.info.duration, job.get("max_size"))
        self.fps: Fraction = self.info.fps
        self.out, self.work = output_paths(job["src"], job.get("out_dir"))
        self.n_qr = max(1, min(5, int(job.get("n_qr", 3))))
        self.n_open = max(core.opening_frames(float(self.fps)), self.n_qr)
        self.chunk_frames = max(1, round(CHUNK_SECONDS * float(self.fps)))
        self.key = None
        self.t0 = time.monotonic()

    # -- journal / progression
    def log(self, msg: str):
        self.emit({"type": "log", "msg": msg})

    def stage(self, name: str):
        self.emit({"type": "stage", "stage": name})
        self.log(f"— Étape : {name}")

    def elapsed(self) -> float:
        return time.monotonic() - self.t0 - self.ctl.paused_time

    # -- préparation
    def prepare(self):
        job = self.job
        sig = src_signature(job["src"])
        state = read_state(self.work)
        want_key = core.normalize_key(job["key"]) if job.get("key") else None
        settings = {"res": self.res, "n_qr": self.n_qr, "encoder": ff.encoder_args(self.hw, self.res, self.fps, 1),
                    "opencl": self.hw.opencl, "fps": str(self.fps), "chunk_frames": self.chunk_frames}
        if self.mbps != core.BITRATES_MBPS[self.res]:      # débit réduit : ne pas mêler les tranches
            settings["mbps"] = self.mbps
        resumable = (state and state.get("version") == STATE_VERSION and state.get("source") == sig
                     and state.get("settings") == settings
                     and (want_key is None or state.get("key") == want_key))
        if resumable:
            self.key = state["key"]
            self.log("Reprise d'un encodage interrompu : les tranches déjà terminées sont conservées.")
            self.emit({"type": "resumed"})
        else:
            if os.path.isdir(self.work):
                shutil.rmtree(self.work, ignore_errors=True)
            os.makedirs(self.work, exist_ok=True)
            self.key = want_key or core.generate_key()
            with open(os.path.join(self.work, "etat.json"), "w", encoding="utf-8") as f:
                json.dump({"version": STATE_VERSION, "source": sig, "settings": settings,
                           "key": self.key}, f, indent=1)
        if os.name == "nt":
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(self.work, 0x02)   # dossier caché
            except Exception:
                pass
        self.vplan = core.video_plan(self.key)
        self.aplan = core.audio_plan(self.key)
        self.emit({"type": "key", "key": self.key, "payload": core.qr_payload(self.key),
                   "res": self.res, "out": self.out})
        self.check_space()

    def check_space(self):
        need = estimate_size(self.info.duration, self.res, self.mbps) * 2.05 + 100e6
        have_parts = sum(os.path.getsize(os.path.join(self.work, f)) for f in os.listdir(self.work))
        need -= have_parts
        free = shutil.disk_usage(os.path.dirname(self.out)).free
        if free < need:
            raise UserError(f"Pas assez d'espace disque : il faut environ {ff.format_size(need)}, "
                            f"il en reste {ff.format_size(free)}.")

    # -- son
    def do_audio(self):
        final = os.path.join(self.work, "son.m4a")
        if os.path.exists(final):
            self.log("Son déjà prêt (reprise).")
            return final
        self.stage("Son")
        import subprocess
        part = os.path.join(self.work, "son.part.m4a")
        rate = core.AUDIO_RATE
        ch = 2
        opening_s = self.n_open / float(self.fps)
        total_samples = max(1, int((self.info.duration + 1.2) * rate))
        dec = None
        if self.info.has_audio:
            ch = 1 if self.info.audio_channels == 1 else 2
            cmd = [ff.ffmpeg(), "-v", "error", "-nostdin", "-i", self.job["src"], "-map", "0:a:0", "-vn",
                   "-ac", str(ch), "-ar", str(rate), "-f", "f32le", "pipe:1"]
            self.log("ffmpeg " + " ".join(cmd[1:]))
            dec = ff.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
            self.ctl.add(dec)
            dec_err: list[bytes] = []
            threading.Thread(target=lambda: dec_err.append(dec.stderr.read()), daemon=True).start()

            def source():
                block = rate * ch * 4
                while True:
                    self.ctl.check()
                    buf = dec.stdout.read(block)
                    if not buf:
                        return
                    n = len(buf) // (4 * ch)
                    yield np.frombuffer(buf[: n * 4 * ch], np.float32).reshape(n, ch)
        else:
            def source():
                left = int(self.info.duration * rate)
                while left > 0:
                    n = min(left, rate)
                    left -= n
                    yield np.zeros((n, ch), np.float32)

        enc_cmd = [ff.ffmpeg(), "-hide_banner", "-y", "-v", "error", "-f", "f32le", "-ar", str(rate),
                   "-ac", str(ch), "-i", "pipe:0", "-c:a", "aac", "-b:a", "320k" if ch == 2 else "192k",
                   "-f", "mp4", part]
        self.log("ffmpeg " + " ".join(enc_cmd[1:]))
        enc = ff.popen(enc_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.ctl.add(enc)
        enc_err: list[bytes] = []
        threading.Thread(target=lambda: enc_err.append(enc.stderr.read()), daemon=True).start()
        done = [0]
        last = [0.0]

        def write(a: np.ndarray):
            self.ctl.check()
            enc.stdin.write(a.tobytes())
            done[0] += len(a)
            now = time.monotonic()
            if now - last[0] > 0.25:
                last[0] = now
                self.emit({"type": "audio", "done": min(done[0], total_samples), "total": total_samples,
                           "elapsed": self.elapsed()})

        try:
            if core.FORMAT_VERSION >= 4:
                from . import mdct4
                mdct4.scramble_stream(source(), ch, self.aplan, self.key, opening_s, write, rate)
            else:
                audio.scramble_stream(source(), ch, self.aplan, opening_s, write, rate, band_key=self.key,
                                      version=core.FORMAT_VERSION)
            enc.stdin.close()
            enc.wait()
            if dec:
                dec.wait()
        except (BrokenPipeError, OSError) as e:
            if self.ctl.cancelled:
                raise Cancelled()
            enc.kill()
            raise RuntimeError("Échec de la compression du son : "
                               + (b"".join(enc_err).decode(errors="replace")[-300:] or str(e)))
        finally:
            self.ctl.remove(enc)
            if dec:
                self.ctl.remove(dec)
        if self.ctl.cancelled:
            raise Cancelled()
        if enc.returncode != 0:
            raise RuntimeError("Échec de la compression du son : "
                               + b"".join(enc_err).decode(errors="replace")[-300:])
        if dec and dec.returncode != 0:
            raise RuntimeError("Échec de la lecture du son : "
                               + b"".join(dec_err).decode(errors="replace")[-300:])
        os.replace(part, final)
        self.emit({"type": "audio", "done": total_samples, "total": total_samples, "elapsed": self.elapsed()})
        return final

    # -- image
    def chunk_list(self) -> list[tuple[int, int]]:
        total = self.info.frames
        n = max(1, math.ceil(total / self.chunk_frames))
        return [(k * self.chunk_frames, min(self.chunk_frames, total - k * self.chunk_frames)) for k in range(n)]

    def _encoder(self) -> list[str]:
        args = ff.encoder_args(self.hw, self.res, self.fps, self.mbps)
        if self.hw.family != "cpu":
            args += ["-pix_fmt", "nv12"]
        return args

    def _scramble_filter(self) -> tuple[list[str], str]:
        """Entrées supplémentaires et chaîne de filtres de brouillage (entrée [0:v] → sortie [v])."""
        W, H = self.W, self.H
        rect = geometry.content_rect(self.info.width, self.info.height, self.info.sar)
        if self.hw.opencl:
            kp = os.path.join(self.work, "brouillage.cl")
            if not os.path.exists(kp):
                with open(kp, "w", encoding="ascii") as f:
                    f.write(geometry.opencl_kernel(self.vplan, rect))
            cw, chh = rect[2] * W, rect[3] * H
            pre = ""
            if self.info.width > cw * 1.3 or self.info.height > chh * 1.3:
                pre = f"scale={max(2, round(cw / 2) * 2)}:{max(2, round(chh / 2) * 2)}:flags=bicubic"
            if self.info.matrix != "bt709":
                pre = (pre or "scale") + ":in_color_matrix=bt601:out_color_matrix=bt709"
            if pre:
                pre += ","
            chain = (f"{pre}format=nv12,hwupload,"
                     f"program_opencl=source='{ff.filter_path(kp)}':kernel=scramble:s={W}x{H},"
                     f"hwdownload,format=nv12,{ff.COLOR_TAGS}")
            return [], chain
        # Brouillage sur le processeur : filtre remap (voisin le plus proche) sur une image
        # doublée [originale | négatif], ce qui fait retournements, négatifs et permutation d'un coup.
        xp = os.path.join(self.work, "carte_x.pgm")
        yp = os.path.join(self.work, "carte_y.pgm")
        if not (os.path.exists(xp) and os.path.exists(yp)):
            geometry.write_remap_maps(self.vplan, W, H, xp, yp)
        chain = (f"scale={W}:{H}:force_original_aspect_ratio=decrease:flags=bicubic:"
                 f"in_color_matrix={self.info.matrix}:out_color_matrix=bt709,"
                 f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,format=yuv444p,split[a][b];"
                 f"[b]lutyuv=y='clip(251-val,0,255)':u='clip(256-val,0,255)':v='clip(256-val,0,255)'[n];"
                 f"[a][n]hstack[ext];[ext][1:v][2:v]remap=format=color:fill=black,"
                 f"format={'nv12' if self.hw.family != 'cpu' else 'yuv420p'},{ff.COLOR_TAGS}")
        return ["-i", xp, "-i", yp], chain

    def do_opening(self, on_frame):
        path = os.path.join(self.work, "ouverture.ts")
        if os.path.exists(path):
            on_frame(self.n_open)
            return path
        part = path + ".part"
        fr = f"{self.fps.numerator}/{self.fps.denominator}"
        frames = opening.opening_nv12(self.key, self.W, self.H, self.n_qr, self.n_open)
        _run_ffmpeg(["-f", "rawvideo", "-pix_fmt", "nv12", "-s", f"{self.W}x{self.H}", "-framerate", fr,
                     "-i", "pipe:0", "-vf", ff.COLOR_TAGS, *self._encoder(), "-an", "-f", "mpegts", part],
                    self.ctl, self.log, on_frame, stdin=frames)
        os.replace(part, path)
        return path

    def do_chunk(self, k: int, start: int, count: int, on_frame, preview: bool):
        path = os.path.join(self.work, f"image_{k:04d}.ts")
        if os.path.exists(path):
            on_frame(count)
            return path
        part = path + ".part"
        extra_in, chain = self._scramble_filter()
        seek = []
        if start > 0:
            seek = ["-ss", f"{(start - 0.5) / float(self.fps):.6f}"]
        hwin = [*ff.opencl_args(), *self.hw.hwaccel] if self.hw.opencl else []
        fr = f"{self.fps.numerator}/{self.fps.denominator}"
        graph = f"[0:v]fps={fr},trim=end_frame={count},{chain}"
        outs = []
        if preview:
            pv = os.path.join(self.work, "apercu.jpg")
            graph += ",split=2[v][p];[p]fps=1/2,scale=640:360,format=yuvj420p[pv]"
            outs = ["-map", "[pv]", "-update", "1", "-q:v", "4", "-f", "image2", pv]
        else:
            graph += "[v]"
        threads = []
        if self.hw.family == "cpu":
            threads = ["-threads", str(self.job.get("threads_per_chunk", 4))]
        _run_ffmpeg([*hwin, *seek, "-i", self.job["src"], *extra_in, "-filter_complex", graph,
                     "-map", "[v]", "-fps_mode", "passthrough", *self._encoder(), *threads, "-an",
                     "-f", "mpegts", part, *outs],
                    self.ctl, self.log, on_frame)
        os.replace(part, path)
        return path

    def do_video(self):
        self.stage("Image")
        chunks = self.chunk_list()
        total = self.n_open + sum(c for _, c in chunks)
        counts: dict = {}
        lock = threading.Lock()
        base_done = 0
        stats = {"last": 0.0, "hist": []}

        def sizes() -> int:
            s = 0
            for f in os.listdir(self.work):
                if f.endswith(".ts") or f.endswith(".ts.part"):
                    try:
                        s += os.path.getsize(os.path.join(self.work, f))
                    except OSError:
                        pass
            return s

        def report(force=False):
            now = time.monotonic()
            if not force and now - stats["last"] < 0.25:
                return
            stats["last"] = now
            done = sum(counts.values())
            h = stats["hist"]
            h.append((now - self.ctl.paused_time, done))
            while len(h) > 2 and h[-1][0] - h[0][0] > 6:
                h.pop(0)
            fps = 0.0
            if len(h) >= 2 and h[-1][0] > h[0][0]:
                fps = (h[-1][1] - h[0][1]) / (h[-1][0] - h[0][0])
            pv = os.path.join(self.work, "apercu.jpg")
            self.emit({"type": "progress", "frames": done, "total": total, "fps": fps,
                       "speed": fps / float(self.fps) if fps else 0.0, "elapsed": self.elapsed(),
                       "size": sizes(), "preview": pv if os.path.exists(pv) else None})

        def counter(key):
            def on_frame(n):
                with lock:
                    counts[key] = n
                report()
            return on_frame

        paths = [self.do_opening(counter("open"))]
        counts["open"] = self.n_open
        parallel = 1 if self.hw.accelerated else max(1, int(self.job.get("parallel_chunks", 1)))
        results: dict[int, str] = {}
        if parallel == 1:
            for k, (start, count) in enumerate(chunks):
                self.ctl.check()
                results[k] = self.do_chunk(k, start, count, counter(k), preview=True)
                counts[k] = count
                report(True)
        else:
            from concurrent.futures import ThreadPoolExecutor
            errors: list[Exception] = []

            def work(k, start, count):
                if errors:
                    return
                try:
                    results[k] = self.do_chunk(k, start, count, counter(k), preview=(k % parallel == 0))
                    counts[k] = count
                except Exception as e:  # noqa: BLE001
                    errors.append(e)
                    if not isinstance(e, Cancelled):
                        self.ctl.cancel()      # arrête les autres tranches
            with ThreadPoolExecutor(parallel) as ex:
                for k, (start, count) in enumerate(chunks):
                    ex.submit(work, k, start, count)
            real = [e for e in errors if not isinstance(e, Cancelled)]
            if real:
                raise real[0]
            if errors:
                raise Cancelled()
        report(True)
        paths += [results[k] for k in range(len(chunks))]
        durations = [self.n_open] + [c for _, c in chunks]
        return paths, durations

    # -- assemblage
    def assemble(self, video_parts, durations, audio_path):
        self.stage("Assemblage")
        lst = os.path.join(self.work, "liste.txt")
        with open(lst, "w", encoding="utf-8") as f:
            for p, n in zip(video_parts, durations):
                f.write(f"file '{p.replace(chr(92), '/').replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
                f.write(f"duration {n / float(self.fps):.9f}\n")
        part = self.out + ".part.mp4"
        hevc = self.res >= 1440 and "hevc" in self.hw.encoders
        _run_ffmpeg(["-f", "concat", "-safe", "0", "-i", lst, "-i", audio_path,
                     "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                     *(["-tag:v", "hvc1"] if hevc else []),
                     "-movflags", "+faststart", "-f", "mp4", part], self.ctl, self.log)
        os.replace(part, self.out)

    # -- vérification
    def verify(self) -> dict:
        self.stage("Vérification")
        w, h = 1280, 720
        rng = random.Random()
        fps = float(self.fps)
        nframes = self.info.frames
        picks = sorted(rng.sample(range(max(1, nframes - 2)), min(10, max(1, nframes - 2))))
        dec_scores, scr_scores = [], []
        for i, n in enumerate(picks):
            self.ctl.check()
            orig = ff.grab_rgb(self.job["src"], (n - 0.3) / fps if n else 0, w, h, fit=True,
                               matrix=self.info.matrix)
            pub = ff.grab_rgb(self.out, (self.n_open + n - 0.3) / fps, w, h)
            dec = geometry.descramble_rgb(pub, self.vplan)
            dec_scores.append(geometry.psnr(dec, orig))
            scr_scores.append(geometry.psnr(pub, orig))
            self.emit({"type": "verify", "done": i + 1, "total": len(picks)})
            if i == 0:
                from PIL import Image
                Image.fromarray(np.concatenate([orig, pub, dec], 1)).resize((1440, 270)).save(
                    os.path.join(self.work, "verification.jpg"), quality=85)
        # QR code de l'ouverture
        qr_ok = False
        try:
            first = ff.grab_rgb(self.out, 0, w, h)
            qr_ok = qr_matches(first, self.key)
        except Exception as e:  # noqa: BLE001
            self.log(f"Lecture du QR code impossible : {e}")
        audio_corr = self.verify_audio()
        img_psnr = float(np.median(dec_scores)) if dec_scores else 0.0
        worst = float(min(dec_scores)) if dec_scores else 0.0
        res = {"image_psnr": img_psnr, "image_worst": worst,
               "scrambled_psnr": float(np.median(scr_scores)) if scr_scores else 0.0,
               "qr_ok": qr_ok, "audio_corr": audio_corr}
        res["ok"] = (img_psnr >= 24 and (qr_ok is not False) and (audio_corr is None or audio_corr >= 0.7))
        self.log(f"Vérification : image débrouillée {img_psnr:.1f} dB (pire {worst:.1f} dB), "
                 f"brouillée {res['scrambled_psnr']:.1f} dB, QR {'lu' if qr_ok else 'NON LU'}, "
                 f"son {'—' if audio_corr is None else f'{audio_corr:.2f}'}")
        return res

    def verify_audio(self) -> float | None:
        """Débrouille 10 s de son prises au hasard dans le fichier final et les compare à l'original."""
        if not self.info.has_audio or self.info.duration < 3:
            return None
        from . import decoder
        rate = core.AUDIO_RATE
        opening_s = self.n_open / float(self.fps)
        seg_s = min(10.0, self.info.duration - 1)
        tau = random.uniform(0, max(0.0, self.info.duration - seg_s - 0.5))
        n = int(seg_s * rate)
        got, parts = 0, []
        off = decoder.calibrate(self.out)
        self.log(f"Calage du son (bip de repère) : {off:+.2f} échantillon(s)")
        for b in decoder.decoded_audio(self.out, self.key, float(self.fps), opening_s + tau, 1, self.ctl,
                                       core.FORMAT_VERSION, off):
            parts.append(b)
            got += len(b)
            if got >= n:
                break
        virt = np.concatenate(parts)[:n, 0] if parts else np.zeros(0, np.float32)
        r = ff.run([ff.ffmpeg(), "-v", "error", "-nostdin", "-ss", f"{tau:.6f}", "-i", self.job["src"],
                    "-map", "0:a:0", "-ac", "1", "-ar", str(rate), "-t", f"{seg_s:.6f}", "-f", "f32le", "-"])
        orig = np.frombuffer(r.stdout, np.float32)
        m = min(len(orig), len(virt))
        a, b = orig[:m], virt[:m]
        if m < rate or np.std(a) < 1e-3:
            return None
        best = 0.0
        for lag in range(-240, 241, 8):     # ± 5 ms
            x, y = (a[lag:], b[: m - lag]) if lag >= 0 else (a[: m + lag], b[-lag:])
            best = max(best, float(np.corrcoef(x, y)[0, 1]))
        return best

    # -- tout
    def run(self) -> dict:
        prevent_sleep(True)
        try:
            self.log(f"Source : {self.info.path} — {self.info.describe()}")
            self.log(f"Matériel : {self.hw.describe()}")
            self.prepare()
            self.log(f"Sortie : {self.W}×{self.H}, {self.mbps:g} Mbit/s, clé {self.key}")
            audio_path = self.do_audio()
            parts, durations = self.do_video()
            self.assemble(parts, durations, audio_path)
            check = {}
            if self.job.get("verify", True):
                check = self.verify()
                vj = os.path.join(self.work, "verification.jpg")
                if os.path.exists(vj):
                    keep = os.path.splitext(self.out)[0] + "_verification.jpg"
                    shutil.copyfile(vj, keep)
                    check["image"] = keep
            qr_png = os.path.splitext(self.out)[0] + "_qr.png"
            from PIL import Image
            Image.fromarray(opening.qr_rgb(self.key, 400, 400)).save(qr_png)
            size = os.path.getsize(self.out)
            shutil.rmtree(self.work, ignore_errors=True)
            return {"type": "done", "out": self.out, "size": size, "key": self.key,
                    "payload": core.qr_payload(self.key), "qr": qr_png, "res": self.res,
                    "duration": self.info.duration, "elapsed": self.elapsed(), "check": check}
        finally:
            prevent_sleep(False)


def qr_matches(rgb: np.ndarray, key: str) -> bool:
    """Vérifie que l'image contient bien le QR code de la clé.

    Avec OpenCV (facultatif), le QR code est réellement décodé ; sinon on compare la grille
    de modules lue au centre de l'image avec la grille attendue.
    """
    payload = core.qr_payload(key)
    try:
        import cv2  # type: ignore
        txt, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))
        return txt == payload
    except ImportError:
        pass
    ref = opening.qr_matrix(key)
    n = ref.shape[0]
    dark = rgb.mean(axis=2) < 128
    ys, xs = np.nonzero(dark)
    if len(xs) == 0:
        return False
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cx = (x0 + (np.arange(n) + 0.5) * (x1 - x0) / n).astype(int)
    cy = (y0 + (np.arange(n) + 0.5) * (y1 - y0) / n).astype(int)
    return float(np.mean(dark[np.ix_(cy, cx)] == ref)) > 0.97
