"""Lecteur avec décodage en temps réel (modèle de l'extension de navigateur).

- Image : décodée par ffmpeg en YUV 4:2:0, envoyée telle quelle à la carte graphique ;
  un seul shader remet les blocs en place, les retourne, applique les négatifs, convertit
  en RGB et adoucit les jointures. Rien n'est calculé sur le processeur par image.
- Son : débrouillé en flux (numpy), fenêtre par fenêtre, et joué par QAudioSink ;
  c'est l'horloge du son qui cadence l'affichage des images.
"""

from __future__ import annotations

import collections
import os
import queue
import subprocess
import threading
import time

import numpy as np
from OpenGL import GL
from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from PySide6.QtWidgets import (QCheckBox, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
                               QProgressBar, QPushButton, QSlider, QVBoxLayout, QWidget)

from . import core, decoder, ff, geometry

MAX_PIPE_HEIGHT = 1080          # au-delà, l'image est réduite avant l'envoi (comme choisir 1080p)

VERTEX = """
#version 120
attribute vec2 pos;
varying vec2 uv;
void main() {
    uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    gl_Position = vec4(pos, 0.0, 1.0);
}
"""

# Le même calcul que le shader de l'extension (voir SPEC.md §3).
FRAGMENT = """
#version 120
uniform sampler2D ty;
uniform sampler2D tu;
uniform sampler2D tv;
uniform sampler2D ttab;
uniform int decode;
uniform int masked;
uniform vec2 size;
uniform float smoothing;
varying vec2 uv;

const vec2 GRID = vec2(32.0, 18.0);
const float M = 0.06;

vec3 yuv2rgb(vec2 p) {
    float y = (texture2D(ty, p).r - 0.0627451) * 1.1643836;
    float u = texture2D(tu, p).r - 0.5019608;
    float v = texture2D(tv, p).r - 0.5019608;
    return vec3(y + 1.7927411 * v, y - 0.2132486 * u - 0.5329093 * v, y + 2.1124018 * u);
}

vec3 decodeAt(vec2 X) {
    vec2 g = X * GRID;
    vec2 s = min(floor(g), GRID - 1.0);
    vec2 f = g - s;
    vec4 e = texture2D(ttab, (s + 0.5) / GRID);
    vec2 c = floor(e.rg * 255.0 + 0.5);
    float fl = floor(e.b * 255.0 + 0.5);
    if (mod(fl, 2.0) >= 1.0) f.x = 1.0 - f.x;
    if (mod(floor(fl / 2.0), 2.0) >= 1.0) f.y = 1.0 - f.y;
    f = M + f * (1.0 - 2.0 * M);
    vec3 rgb = yuv2rgb((c + f) / GRID);
    if (fl >= 4.0) rgb = 1.0 - rgb;
    return rgb;
}

void main() {
    if (masked == 1) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    if (decode == 0) { gl_FragColor = vec4(clamp(yuv2rgb(uv), 0.0, 1.0), 1.0); return; }
    vec3 rgb = decodeAt(uv);
    if (smoothing > 0.0) {
        // adoucissement des jointures : moyenne avec les pixels voisins de l'autre côté
        vec2 bp = size / GRID;
        vec2 f = fract(uv * GRID);
        vec2 dist = min(f, 1.0 - f) * bp;
        vec2 px = 1.0 / size;
        if (dist.x < 1.5) {
            vec3 n = 0.5 * (decodeAt(uv + vec2(px.x, 0.0)) + decodeAt(uv - vec2(px.x, 0.0)));
            rgb = mix(rgb, n, smoothing * (1.0 - dist.x / 1.5));
        }
        if (dist.y < 1.5) {
            vec3 n = 0.5 * (decodeAt(uv + vec2(0.0, px.y)) + decodeAt(uv - vec2(0.0, px.y)));
            rgb = mix(rgb, n, smoothing * (1.0 - dist.y / 1.5));
        }
    }
    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
"""


class VideoView(QOpenGLWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(480, 270)
        self.frame = None           # (bytes, w, h)
        self.dirty = False
        self.table = None
        self.table_dirty = False
        self.decode = False
        self.masked = False
        self.prog = None
        self.tex = None
        self.tex_size = (0, 0)
        self.gpu_ms = 0.0

    def set_table(self, table: np.ndarray | None):
        self.table = table
        self.table_dirty = True
        self.update()

    def set_frame(self, data: bytes, w: int, h: int):
        self.frame = (data, w, h)
        self.dirty = True
        self.update()

    def clear(self):
        self.frame = None
        self.update()

    def initializeGL(self):
        def shader(kind, src):
            s = GL.glCreateShader(kind)
            GL.glShaderSource(s, src)
            GL.glCompileShader(s)
            if not GL.glGetShaderiv(s, GL.GL_COMPILE_STATUS):
                raise RuntimeError(GL.glGetShaderInfoLog(s).decode(errors="replace"))
            return s
        p = GL.glCreateProgram()
        GL.glAttachShader(p, shader(GL.GL_VERTEX_SHADER, VERTEX))
        GL.glAttachShader(p, shader(GL.GL_FRAGMENT_SHADER, FRAGMENT))
        GL.glBindAttribLocation(p, 0, "pos")
        GL.glLinkProgram(p)
        if not GL.glGetProgramiv(p, GL.GL_LINK_STATUS):
            raise RuntimeError(GL.glGetProgramInfoLog(p).decode(errors="replace"))
        self.prog = p
        self.tex = GL.glGenTextures(4)
        for i, t in enumerate(self.tex):
            GL.glBindTexture(GL.GL_TEXTURE_2D, t)
            filt = GL.GL_NEAREST if i == 3 else GL.GL_LINEAR
            GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_MIN_FILTER, filt)
            GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_MAG_FILTER, filt)
            GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_WRAP_S, GL.GL_CLAMP_TO_EDGE)
            GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_WRAP_T, GL.GL_CLAMP_TO_EDGE)
        self.quad = np.array([-1, -1, 1, -1, -1, 1, 1, 1], np.float32)
        self.table_dirty = True

    def _upload(self):
        data, w, h = self.frame
        GL.glPixelStorei(GL.GL_UNPACK_ALIGNMENT, 1)
        a = np.frombuffer(data, np.uint8)
        planes = ((a[: w * h], w, h), (a[w * h: w * h * 5 // 4], w // 2, h // 2),
                  (a[w * h * 5 // 4: w * h * 3 // 2], w // 2, h // 2))
        realloc = self.tex_size != (w, h)
        for t, (buf, pw, ph) in zip(self.tex[:3], planes):
            GL.glBindTexture(GL.GL_TEXTURE_2D, t)
            if realloc:
                GL.glTexImage2D(GL.GL_TEXTURE_2D, 0, GL.GL_LUMINANCE, pw, ph, 0, GL.GL_LUMINANCE,
                                GL.GL_UNSIGNED_BYTE, buf)
            else:
                GL.glTexSubImage2D(GL.GL_TEXTURE_2D, 0, 0, 0, pw, ph, GL.GL_LUMINANCE, GL.GL_UNSIGNED_BYTE, buf)
        self.tex_size = (w, h)
        self.dirty = False

    def paintGL(self):
        t0 = time.perf_counter()
        dpr = self.devicePixelRatioF()
        W, H = int(self.width() * dpr), int(self.height() * dpr)
        GL.glViewport(0, 0, W, H)
        GL.glClearColor(0, 0, 0, 1)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT)
        if self.table_dirty:
            tab = self.table if self.table is not None else np.zeros((18, 32, 4), np.uint8)
            GL.glBindTexture(GL.GL_TEXTURE_2D, self.tex[3])
            GL.glPixelStorei(GL.GL_UNPACK_ALIGNMENT, 1)
            GL.glTexImage2D(GL.GL_TEXTURE_2D, 0, GL.GL_RGBA, 32, 18, 0, GL.GL_RGBA, GL.GL_UNSIGNED_BYTE,
                            np.ascontiguousarray(tab))
            self.table_dirty = False
        if not self.frame:
            return
        if self.dirty:
            self._upload()
        fw, fh = self.tex_size
        # image centrée avec bandes noires
        scale = min(W / fw, H / fh)
        vw, vh = int(fw * scale), int(fh * scale)
        GL.glViewport((W - vw) // 2, (H - vh) // 2, vw, vh)
        GL.glUseProgram(self.prog)
        for i, name in enumerate(("ty", "tu", "tv", "ttab")):
            GL.glActiveTexture(GL.GL_TEXTURE0 + i)
            GL.glBindTexture(GL.GL_TEXTURE_2D, self.tex[i])
            GL.glUniform1i(GL.glGetUniformLocation(self.prog, name), i)
        GL.glUniform1i(GL.glGetUniformLocation(self.prog, "decode"), int(self.decode and self.table is not None))
        GL.glUniform1i(GL.glGetUniformLocation(self.prog, "masked"), int(self.masked))
        GL.glUniform2f(GL.glGetUniformLocation(self.prog, "size"), float(fw), float(fh))
        # lissage : marqué en 720p, quasi nul à partir de 1440p
        smooth = 0.0 if fh >= 1440 else (0.35 if fh <= 720 else 0.2)
        GL.glUniform1f(GL.glGetUniformLocation(self.prog, "smoothing"), smooth)
        GL.glEnableVertexAttribArray(0)
        GL.glVertexAttribPointer(0, 2, GL.GL_FLOAT, False, 0, self.quad)
        GL.glDrawArrays(GL.GL_TRIANGLE_STRIP, 0, 4)
        GL.glDisableVertexAttribArray(0)
        GL.glActiveTexture(GL.GL_TEXTURE0)
        self.gpu_ms = (time.perf_counter() - t0) * 1000


# ---------------------------------------------------------------- lecture en arrière-plan

class VideoReader(threading.Thread):
    def __init__(self, path: str, start: float, w: int, h: int, fps: float, hwaccel: list):
        super().__init__(daemon=True)
        self.w, self.h, self.fps = w, h, fps
        self.q: queue.Queue = queue.Queue(maxsize=8)
        self.stop_flag = False
        self.eof = False
        cmd = [ff.ffmpeg(), "-v", "error", "-nostdin", *hwaccel]
        if start > 0:
            cmd += ["-ss", f"{start:.6f}"]
        cmd += ["-i", path, "-map", "0:v:0", "-vf", f"scale={w}:{h}:flags=fast_bilinear,format=yuv420p",
                "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
        self.proc = ff.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        # instant de la première image : la première dont l'horodatage est ≥ start
        self.t_first = max(0.0, np.ceil(start * fps - 1e-3) / fps)

    def run(self):
        size = self.w * self.h * 3 // 2
        n = 0
        try:
            while not self.stop_flag:
                # readinto dans un tampon neuf : read(n) allouerait n octets à chaque petit morceau reçu
                buf = bytearray(size)
                if self.proc.stdout.readinto(buf) < size:
                    break
                t = self.t_first + n / self.fps
                n += 1
                while not self.stop_flag:
                    try:
                        self.q.put((t, buf), timeout=0.1)
                        break
                    except queue.Full:
                        continue
        finally:
            self.eof = True

    def stop(self):
        self.stop_flag = True
        try:
            self.proc.kill()
        except Exception:
            pass


class AudioReader(threading.Thread):
    """Produit le son à jouer (débrouillé ou tel quel), en float32 stéréo 48 kHz."""

    def __init__(self, path: str, start: float, key: str | None, fps: float, version: int = 2,
                 offset: float = 0.0):
        super().__init__(daemon=True)
        self.q: queue.Queue = queue.Queue(maxsize=40)
        self.stop_flag = False
        self.eof = False
        self.ctl = _StopControl()
        if key:
            self.gen = decoder.decoded_audio(path, key, fps, start, 2, self.ctl, version, offset)
        else:
            self.gen = decoder.audio_source(path, start, core.AUDIO_RATE, 2, self.ctl)

    def run(self):
        try:
            for block in self.gen:
                if self.stop_flag:
                    break
                for i in range(0, len(block), 4800):      # morceaux de 100 ms
                    b = block[i:i + 4800].tobytes()
                    while not self.stop_flag:
                        try:
                            self.q.put(b, timeout=0.1)
                            break
                        except queue.Full:
                            continue
        except Exception:
            pass
        finally:
            self.eof = True

    def stop(self):
        self.stop_flag = True
        self.ctl.cancel()


class _StopControl:
    """Version minimale de pipeline.Control pour arrêter les lectures en cours."""

    def __init__(self):
        self.procs = set()
        self.cancelled = False

    def add(self, p):
        self.procs.add(p)
        if self.cancelled:
            p.kill()

    def remove(self, p):
        self.procs.discard(p)

    def check(self):
        if self.cancelled:
            from .pipeline import Cancelled
            raise Cancelled()

    def cancel(self):
        self.cancelled = True
        for p in list(self.procs):
            try:
                p.kill()
            except Exception:
                pass


# ---------------------------------------------------------------- page du lecteur

class PlayerPage(QWidget):
    key_found = Signal(object, int, str, float)

    def __init__(self, main):
        super().__init__()
        self.main = main
        self.info: ff.MediaInfo | None = None
        self.path = ""
        self.key: str | None = None
        self.version = core.FORMAT_VERSION
        self.offset = 0.0
        self.vreader: VideoReader | None = None
        self.areader: AudioReader | None = None
        self.sink: QAudioSink | None = None
        self.sink_io = None
        self.pending = b""
        self.playing = False
        self.start_t = 0.0
        self.written = 0
        self.mono_start = 0.0
        self.mono_base = 0.0
        self.audio_done_at = None
        self.next_frame = None
        self.need_first = True
        self.shown_t = 0.0
        self.frames_shown = 0
        self.frames_dropped = 0
        self.stats_t = time.monotonic()
        self.seeking = False
        self.proc = None
        self.key_found.connect(self._key_ready)

        lay = QVBoxLayout(self)
        top = QHBoxLayout()
        ob = QPushButton("Ouvrir une vidéo brouillée…")
        ob.clicked.connect(self._open)
        top.addWidget(ob)
        self.file_label = QLabel("Aucune vidéo — glissez-déposez un fichier ici (par exemple une vidéo "
                                 "téléchargée depuis YouTube)")
        top.addWidget(self.file_label, 1)
        lay.addLayout(top)

        self.view = VideoView()
        lay.addWidget(self.view, 1)

        ctr = QHBoxLayout()
        self.play_btn = QPushButton("▶")
        self.play_btn.setFixedWidth(44)
        self.play_btn.clicked.connect(self.toggle_play)
        ctr.addWidget(self.play_btn)
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, 1000)
        self.slider.sliderPressed.connect(lambda: setattr(self, "seeking", True))
        self.slider.sliderReleased.connect(self._seek_release)
        ctr.addWidget(self.slider, 1)
        self.time_label = QLabel("0:00 / 0:00")
        ctr.addWidget(self.time_label)
        ctr.addWidget(QLabel("Volume"))
        self.volume = QSlider(Qt.Horizontal)
        self.volume.setRange(0, 100)
        self.volume.setValue(80)
        self.volume.setFixedWidth(90)
        self.volume.valueChanged.connect(lambda v: self.sink and self.sink.setVolume(v / 100))
        ctr.addWidget(self.volume)
        lay.addLayout(ctr)

        opts = QHBoxLayout()
        self.decode_box = QCheckBox("Décodage actif")
        self.decode_box.setChecked(True)
        self.decode_box.toggled.connect(self._decode_toggled)
        opts.addWidget(self.decode_box)
        opts.addWidget(QLabel("Clé manuelle :"))
        self.key_edit = QLineEdit()
        self.key_edit.setPlaceholderText("seulement si le QR code est illisible")
        self.key_edit.setMaxLength(16)
        self.key_edit.setFixedWidth(230)
        self.key_edit.returnPressed.connect(self._manual_key)
        opts.addWidget(self.key_edit)
        kb = QPushButton("Appliquer")
        kb.clicked.connect(self._manual_key)
        opts.addWidget(kb)
        self.status = QLabel("")
        opts.addWidget(self.status, 1)
        self.export_btn = QPushButton("Exporter débrouillée…")
        self.export_btn.clicked.connect(self._export)
        self.export_btn.setEnabled(False)
        opts.addWidget(self.export_btn)
        lay.addLayout(opts)

        exp = QHBoxLayout()
        self.export_bar = QProgressBar()
        self.export_bar.setRange(0, 1000)
        self.export_bar.hide()
        self.export_label = QLabel("")
        self.export_label.hide()
        self.export_cancel = QPushButton("Arrêter l'export")
        self.export_cancel.hide()
        self.export_cancel.clicked.connect(lambda: self.proc and self.proc.write(b"cancel\n"))
        exp.addWidget(self.export_label)
        exp.addWidget(self.export_bar, 1)
        exp.addWidget(self.export_cancel)
        lay.addLayout(exp)
        self.stats = QLabel("")
        self.stats.setStyleSheet("color: gray;")
        lay.addWidget(self.stats)

        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.PreciseTimer)
        self.timer.setInterval(4)
        self.timer.timeout.connect(self._tick)

    # ------------------------------------------------ ouverture
    def _open(self):
        p, _ = QFileDialog.getOpenFileName(self, "Ouvrir une vidéo brouillée", "",
                                           "Vidéos (*.mp4 *.mkv *.webm *.mov *.m4v);;Tous les fichiers (*)")
        if p:
            self.open_file(p)

    def open_file(self, path: str):
        self.stop()
        try:
            self.info = ff.probe(path)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "Lecture impossible", str(e))
            return
        self.path = path
        self.key = None
        self.view.set_table(None)
        self.view.clear()
        i = self.info
        self.file_label.setText(f"<b>{os.path.basename(path)}</b> — {i.describe()}")
        self.status.setText("Recherche du QR code…")
        self.export_btn.setEnabled(False)
        self.start_t = 0.0

        def work():
            off = 0.0
            try:
                key, version, origin = decoder.locate_key(path)
                if self.info.has_audio:
                    off = decoder.calibrate(path)
            except Exception as e:  # noqa: BLE001
                key, version, origin = None, core.FORMAT_VERSION, "erreur : " + str(e)
            self.key_found.emit(key, version, origin, off)
        threading.Thread(target=work, daemon=True).start()

    def _key_ready(self, key, version, origin, offset):
        self.version = version
        self.offset = offset
        if key:
            self._set_key(key, "trouvée dans le QR code" if origin == "qr" else "mémorisée pour ce fichier")
        else:
            self.status.setText("<span style='color:#b35900'>Aucun QR code BRV1 trouvé : lecture sans décodage "
                                "(saisissez la clé si besoin).</span>")
            self.export_btn.setEnabled(False)
        self.play_from(0.0)

    def _set_key(self, key: str, how: str):
        self.key = key
        self.view.set_table(geometry.decode_table(core.video_plan(key)))
        self.status.setText(f"Clé <b>{key}</b> {how} (format BRV{self.version}, calage du son "
                            f"{self.offset:+.1f} éch.)".replace(".", ",", 1) if self.info and self.info.has_audio
                            else f"Clé <b>{key}</b> {how} (format BRV{self.version})")
        self.export_btn.setEnabled(True)

    def _manual_key(self):
        if not self.info:
            return
        try:
            k = core.normalize_key(self.key_edit.text())
        except ValueError as e:
            QMessageBox.warning(self, "Clé invalide", str(e))
            return
        self.version = core.FORMAT_VERSION
        decoder.remember_key(self.path, k, self.version)
        self._set_key(k, "saisie à la main")
        self.play_from(self.clock(), keep_state=True)

    # ------------------------------------------------ lecture
    @property
    def fps(self) -> float:
        return self.info.fps_float if self.info else 30.0

    @property
    def opening(self) -> float:
        return core.opening_frames(self.fps) / self.fps

    def _decoding(self) -> bool:
        return self.decode_box.isChecked() and self.key is not None

    def _pipe_size(self) -> tuple[int, int]:
        w, h = self.info.width, self.info.height
        if h > MAX_PIPE_HEIGHT:
            w, h = round(w * MAX_PIPE_HEIGHT / h), MAX_PIPE_HEIGHT
        return max(2, w // 2 * 2), max(2, h // 2 * 2)

    def play_from(self, t: float, keep_state: bool = False):
        if not self.info:
            return
        was_playing = self.playing if keep_state else True
        self._stop_readers()
        t = max(0.0, min(t, max(0.0, self.info.duration - 0.05)))
        self.start_t = t
        w, h = self._pipe_size()
        hw = self.main.hw.hwaccel if self.main.hw else []
        self.vreader = VideoReader(self.path, t, w, h, self.fps, hw)
        self.vreader.start()
        self.next_frame = None
        self.need_first = True
        self.shown_t = t
        self.pending = b""
        self.written = 0
        self.audio_done_at = None
        if self.info.has_audio:
            self.areader = AudioReader(self.path, t, self.key if self._decoding() else None, self.fps,
                                       self.version, self.offset)
            self.areader.start()
            self._make_sink()
        self.mono_base = t
        self.mono_start = time.monotonic()
        self.playing = was_playing
        if self.sink and not self.playing:
            self.sink.suspend()
        self.play_btn.setText("❚❚" if self.playing else "▶")
        self.frames_shown = self.frames_dropped = 0
        self.stats_t = time.monotonic()
        self.timer.start()

    def _make_sink(self):
        fmt = QAudioFormat()
        fmt.setSampleRate(core.AUDIO_RATE)
        fmt.setChannelCount(2)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Float)
        dev = QMediaDevices.defaultAudioOutput()
        self.sink = QAudioSink(dev, fmt, self)
        self.sink.setBufferSize(core.AUDIO_RATE * 8 // 4)       # 250 ms
        self.sink.setVolume(self.volume.value() / 100)
        self.sink_io = self.sink.start()

    def _stop_readers(self):
        for r in (self.vreader, self.areader):
            if r:
                r.stop()
        self.vreader = self.areader = None
        if self.sink:
            self.sink.stop()
            self.sink.deleteLater()
        self.sink = None
        self.sink_io = None

    def stop(self):
        self.timer.stop()
        self._stop_readers()
        self.playing = False
        self.play_btn.setText("▶")

    def toggle_play(self):
        if not self.info:
            return
        if not self.vreader:
            self.play_from(self.start_t)
            return
        now = self.clock()
        self.playing = not self.playing
        if self.sink:
            (self.sink.resume if self.playing else self.sink.suspend)()
        self.mono_base, self.mono_start = now, time.monotonic()
        self.play_btn.setText("❚❚" if self.playing else "▶")

    def clock(self) -> float:
        """Position de lecture, en secondes du fichier publié."""
        if self.sink and self.audio_done_at is None:
            bps = core.AUDIO_RATE * 8
            buffered = self.sink.bufferSize() - self.sink.bytesFree()
            return self.start_t + max(0, self.written - buffered) / bps
        if not self.playing:
            return self.mono_base
        return self.mono_base + time.monotonic() - self.mono_start

    def _feed_audio(self):
        if not (self.sink and self.sink_io and self.areader):
            return
        free = self.sink.bytesFree()
        while free > 0:
            if not self.pending:
                try:
                    self.pending = self.areader.q.get_nowait()
                except queue.Empty:
                    if self.areader.eof and self.audio_done_at is None:
                        # fin du son : l'horloge continue sans lui
                        self.mono_base, self.mono_start = self.clock(), time.monotonic()
                        self.audio_done_at = time.monotonic()
                    break
            n = self.sink_io.write(self.pending[:free])
            if n <= 0:
                break
            self.pending = self.pending[n:]
            self.written += n
            free -= n

    def _tick(self):
        if not self.vreader:
            return
        if self.playing:
            self._feed_audio()
        now = self.clock()
        frame = None
        while True:
            if self.next_frame is None:
                try:
                    self.next_frame = self.vreader.q.get_nowait()
                except queue.Empty:
                    break
            t, data = self.next_frame
            # en pause, seule la première image après un saut s'affiche
            if (self.playing and t <= now + 0.5 / self.fps) or (frame is None and self.need_first):
                if frame is not None:
                    self.frames_dropped += 1
                frame = self.next_frame
                self.next_frame = None
            else:
                break
        if frame:
            t, data = frame
            self.need_first = False
            self.shown_t = t
            self.view.decode = self._decoding()
            self.view.masked = self._decoding() and t < self.opening - 0.5 / self.fps
            w, h = self._pipe_size()
            self.view.set_frame(data, w, h)
            self.frames_shown += 1
        if self.vreader.eof and self.vreader.q.empty() and self.next_frame is None and self.playing:
            self.playing = False
            self.play_btn.setText("▶")
            if self.sink:
                self.sink.suspend()
            self.mono_base = self.shown_t
        if not self.seeking and self.info.duration > 0:
            self.slider.blockSignals(True)
            self.slider.setValue(int(1000 * min(1.0, now / self.info.duration)))
            self.slider.blockSignals(False)
        self.time_label.setText(f"{_mmss(min(now, self.info.duration))} / {_mmss(self.info.duration)}")
        el = time.monotonic() - self.stats_t
        if el > 1.0:
            w, h = self._pipe_size()
            fps = self.frames_shown / el
            self.stats.setText(f"Affichage : {fps:.0f} images/s (vidéo : {self.fps:.3g}) — "
                               f"{self.frames_dropped} image(s) sautée(s) — image {w}×{h} — "
                               f"rendu {self.view.gpu_ms:.1f} ms".replace(".", ","))
            self.frames_shown = self.frames_dropped = 0
            self.stats_t = time.monotonic()

    def _seek_release(self):
        self.seeking = False
        if self.info:
            self.play_from(self.slider.value() / 1000 * self.info.duration, keep_state=True)

    def _decode_toggled(self, on):
        if self.info and self.vreader:
            # le son doit être relu dans l'autre mode ; l'image change immédiatement
            self.play_from(self.clock(), keep_state=True)

    # ------------------------------------------------ export
    def _export(self):
        if not (self.info and self.key and self.main.hw):
            return
        d = QFileDialog.getExistingDirectory(self, "Dossier de l'export", os.path.dirname(self.path))
        if not d:
            return
        job = {"type": "decode", "src": self.path, "out_dir": d, "key": self.key, "version": self.version,
               "hardware": self.main.hw_dict(), "stop_with_gui": True}
        self.export_bar.setValue(0)
        for w in (self.export_bar, self.export_label, self.export_cancel):
            w.show()
        self.export_label.setText("Export : son…")
        self.export_btn.setEnabled(False)
        self.proc = self.main.launch_worker(job, self._export_msg, self._export_finished)

    def _export_msg(self, m: dict):
        t = m.get("type")
        if t == "audio":
            self.export_bar.setValue(int(200 * m["done"] / max(1, m["total"])))
        elif t == "stage" and m["stage"] == "Image":
            self.export_label.setText("Export : image…")
        elif t == "progress":
            self.export_bar.setValue(200 + int(800 * m["frames"] / max(1, m["total"])))
        elif t == "done":
            self._export_result = m
        elif t == "error":
            self._export_result = m
        elif t == "cancelled":
            self._export_result = m
        elif t == "log":
            self.main._append_log(m["msg"])

    def _export_finished(self):
        r = getattr(self, "_export_result", None) or {"type": "error", "msg": "arrêt inattendu"}
        self._export_result = None
        self.proc = None
        for w in (self.export_bar, self.export_cancel):
            w.hide()
        self.export_btn.setEnabled(self.key is not None)
        if r["type"] == "done":
            self.export_label.setText(f"Export terminé : {r['out']} ({ff.format_size(r['size'])}, "
                                      f"{ff.format_duration(r['elapsed'])})")
            self.main._notify("Export terminé", os.path.basename(r["out"]))
        elif r["type"] == "cancelled":
            self.export_label.setText("Export arrêté.")
        else:
            self.export_label.setText("")
            QMessageBox.critical(self, "Export impossible", r.get("msg", "erreur"))


def _mmss(s: float) -> str:
    s = int(max(0, s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"
