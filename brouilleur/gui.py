"""Interface graphique du brouilleur (PySide6)."""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from dataclasses import asdict

import numpy as np
from PySide6.QtCore import (QObject, QProcess, QProcessEnvironment, QRunnable, QSize, Qt,
                            QThreadPool, QTimer, QUrl, Signal)
from PySide6.QtGui import (QAction, QColor, QDesktopServices, QFont, QIcon, QImage, QPainter,
                           QPixmap)
from PySide6.QtWidgets import (QApplication, QButtonGroup, QCheckBox, QDialog, QDoubleSpinBox, QFileDialog, QFormLayout,
                               QFrame, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QLineEdit,
                               QListWidget, QListWidgetItem, QMainWindow, QMessageBox,
                               QPlainTextEdit, QProgressBar, QPushButton, QRadioButton,
                               QScrollArea, QSizePolicy, QSpinBox, QStackedWidget,
                               QSystemTrayIcon, QTabWidget, QToolButton, QVBoxLayout, QWidget)

from . import bench, core, ff, geometry, pipeline

VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".wmv", ".flv", ".ts", ".mts", ".m2ts",
             ".mpg", ".mpeg", ".3gp", ".ogv"}
RES_LABEL = {1080: "1080p", 1440: "1440p", 2160: "4K (2160p)"}


# ---------------------------------------------------------------- utilitaires

def app_icon() -> QIcon:
    pm = QPixmap(64, 64)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    colors = ["#e8554e", "#f2b134", "#3aa6a0", "#4a6fd1", "#8e5ad6", "#2c2c2c"]
    order = [3, 0, 5, 2, 1, 4, 2, 5, 0, 4, 3, 1, 5, 1, 4, 0]
    for i, c in enumerate(order):
        x, y = i % 4, i // 4
        p.fillRect(4 + x * 14, 4 + y * 14, 13, 13, QColor(colors[c]))
    p.end()
    return QIcon(pm)


def np_to_pixmap(rgb: np.ndarray) -> QPixmap:
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888)
    return QPixmap.fromImage(img.copy())


def open_folder(path: str):
    if sys.platform == "win32" and os.path.isfile(path):
        import subprocess
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    else:
        QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.dirname(path) if os.path.isfile(path) else path))


class Task(QRunnable):
    """Exécute une fonction dans le pool de threads et renvoie le résultat par signal."""

    class _Sig(QObject):
        done = Signal(object)
        failed = Signal(str)
        progress = Signal(object)

    def __init__(self, fn, *args):
        super().__init__()
        self.fn, self.args = fn, args
        self.sig = Task._Sig()

    def run(self):
        try:
            self.sig.done.emit(self.fn(*self.args))
        except Exception as e:  # noqa: BLE001
            self.sig.failed.emit(str(e))


_live_tasks: set = set()


def run_task(fn, *args, done=None, failed=None) -> Task:
    """Lance fn(*args) en arrière-plan ; done/failed sont appelés dans le thread de l'interface."""
    t = Task(fn, *args)
    t.setAutoDelete(False)
    _live_tasks.add(t)          # garde la tâche (et son émetteur de signaux) en vie jusqu'au bout

    def finish(slot):
        def f(value):
            _live_tasks.discard(t)
            if slot:
                slot(value)
        return f
    t.sig.done.connect(finish(done))
    t.sig.failed.connect(finish(failed))
    QThreadPool.globalInstance().start(t)
    return t


class TaskbarProgress:
    """Progression sur l'icône de la barre des tâches (Windows) ou du dock (Ubuntu/Unity)."""

    def __init__(self, window: QWidget):
        self.window = window
        self.tb = None
        if sys.platform == "win32":
            try:
                import ctypes
                from ctypes import wintypes

                class GUID(ctypes.Structure):
                    _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD),
                                ("d", ctypes.c_ubyte * 8)]

                def guid(a, b, c, d):
                    return GUID(a, b, c, (ctypes.c_ubyte * 8)(*d))
                clsid = guid(0x56FDF344, 0xFD6D, 0x11D0, [0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90])
                iid = guid(0xEA1AFB91, 0x9E28, 0x4B86, [0x90, 0xE9, 0x9E, 0x9F, 0x8A, 0x5E, 0xEF, 0xAF])
                ole = ctypes.OleDLL("ole32")
                ole.CoInitialize(None)
                ptr = ctypes.c_void_p()
                ole.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(iid), ctypes.byref(ptr))
                vtbl = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0],
                                   ctypes.POINTER(ctypes.c_void_p))
                proto = ctypes.WINFUNCTYPE
                self._hrinit = proto(ctypes.HRESULT, ctypes.c_void_p)(vtbl[3])
                self._setvalue = proto(ctypes.HRESULT, ctypes.c_void_p, wintypes.HWND,
                                       ctypes.c_ulonglong, ctypes.c_ulonglong)(vtbl[9])
                self._setstate = proto(ctypes.HRESULT, ctypes.c_void_p, wintypes.HWND, ctypes.c_int)(vtbl[10])
                self._hrinit(ptr)
                self.tb = ptr
            except Exception:
                self.tb = None

    def set(self, fraction: float | None, paused: bool = False):
        if sys.platform == "win32":
            if not self.tb:
                return
            try:
                hwnd = int(self.window.winId())
                if fraction is None:
                    self._setstate(self.tb, hwnd, 0)
                else:
                    self._setstate(self.tb, hwnd, 8 if paused else 2)
                    self._setvalue(self.tb, hwnd, int(fraction * 1000), 1000)
            except Exception:
                pass
        else:
            try:
                from PySide6.QtDBus import QDBusConnection, QDBusMessage
                msg = QDBusMessage.createSignal("/fr/brouilleur", "com.canonical.Unity.LauncherEntry", "Update")
                props = {"progress-visible": fraction is not None, "progress": float(fraction or 0.0)}
                msg.setArguments(["application://brouilleur.desktop", props])
                QDBusConnection.sessionBus().send(msg)
            except Exception:
                pass


# ---------------------------------------------------------------- éléments de la file

class Item:
    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self.info: ff.MediaInfo | None = None
        self.thumb: QPixmap | None = None
        self.error = ""
        self.mode = "rapide"
        self.key_auto = True
        self.key = ""
        self.n_qr = 3
        self.max_gb = 0.0             # taille maximale du fichier brouillé (0 : sans limite)
        self.out_dir = ""
        self.status = "attente"       # attente, encodage, termine, erreur, interrompu
        self.result: dict | None = None
        self.resume_key = ""
        self.widget: QListWidgetItem | None = None

    @property
    def name(self) -> str:
        return os.path.basename(self.path)


# ---------------------------------------------------------------- fenêtre d'aperçu

class PreviewDialog(QDialog):
    def __init__(self, parent, item: Item, res: int):
        super().__init__(parent)
        self.setWindowTitle(f"Aperçu — {item.name}")
        self.resize(1000, 640)
        lay = QVBoxLayout(self)
        self.status = QLabel("Préparation de l'aperçu…")
        lay.addWidget(self.status)
        row = QHBoxLayout()
        self.labels = []
        for title in ("Originale", "Brouillée (ce que voient les autres)", "Débrouillée (avec l'extension)"):
            box = QVBoxLayout()
            t = QLabel(f"<b>{title}</b>")
            t.setAlignment(Qt.AlignCenter)
            img = QLabel()
            img.setMinimumSize(300, 170)
            img.setAlignment(Qt.AlignCenter)
            img.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
            box.addWidget(t)
            box.addWidget(img, 1)
            row.addLayout(box)
            self.labels.append(img)
        lay.addLayout(row, 1)
        self.pix = []
        key = item.key if (not item.key_auto and item.key) else (item.resume_key or "APERCU00")
        self._task = run_task(self._compute, item, key, done=self._show, failed=self._fail)

    @staticmethod
    def _compute(item: Item, key: str):
        info = item.info
        t = info.duration * 0.3
        orig = ff.grab_rgb(item.path, t, 960, 540, fit=True, matrix=info.matrix)
        plan = core.video_plan(key)
        scr = geometry.scramble_rgb(orig, plan)
        dec = geometry.descramble_rgb(scr, plan)
        return orig, scr, dec, key

    def _show(self, r):
        orig, scr, dec, key = r
        self.pix = [np_to_pixmap(a) for a in (orig, scr, dec)]
        self.status.setText(f"Image prise à 30 % de la vidéo — clé {key}"
                            + (" (clé d'exemple : la vraie sera générée au lancement)" if key == "APERCU00" else ""))
        self._rescale()

    def _fail(self, msg):
        self.status.setText("Aperçu impossible : " + msg)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._rescale()

    def _rescale(self):
        for lab, pm in zip(self.labels, self.pix):
            lab.setPixmap(pm.scaled(lab.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))


# ---------------------------------------------------------------- fenêtre principale

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowIcon(app_icon())
        self.setAcceptDrops(True)
        self.resize(1000, 720)
        self.items: list[Item] = []
        self.hw: ff.Hardware | None = None
        self.bench: dict | None = None
        self.proc: QProcess | None = None
        self.queue: list[Item] = []
        self.current: Item | None = None
        self.finished: list[Item] = []
        self.paused = False
        self.closing = False
        self.cancel_requested = False
        self._buf = b""
        self._preview_mtime = 0.0
        self._loading_form = False
        self.taskbar = TaskbarProgress(self)
        self.tray = QSystemTrayIcon(app_icon(), self)
        self.tray.setToolTip("Brouilleur")

        self.stack = QStackedWidget()
        self.stack.addWidget(self._build_prep())
        self.stack.addWidget(self._build_run())
        self.stack.addWidget(self._build_end())
        from .player import PlayerPage
        self.player = PlayerPage(self)
        self.tabs = QTabWidget()
        self.tabs.addTab(self.stack, "Encoder")
        self.tabs.addTab(self.player, "Lire / Décoder")
        self.tabs.currentChanged.connect(lambda i: i == 0 and self.player.playing and self.player.toggle_play())
        self.setCentralWidget(self.tabs)
        self._set_title()
        QTimer.singleShot(50, self._start_hardware)

    # ------------------------------------------------ page 1 : préparation
    def _build_prep(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)

        hwrow = QHBoxLayout()
        self.hw_label = QLabel("Détection du matériel…")
        self.hw_label.setWordWrap(True)
        self.rebench_btn = QToolButton()
        self.rebench_btn.setText("Refaire l'essai de vitesse")
        self.rebench_btn.clicked.connect(lambda: self._run_bench(force=True))
        self.rebench_btn.setEnabled(False)
        hwrow.addWidget(self.hw_label, 1)
        hwrow.addWidget(self.rebench_btn)
        lay.addLayout(hwrow)

        body = QHBoxLayout()
        left = QVBoxLayout()
        title = QLabel("<b>Vidéos à brouiller</b> — glissez-déposez des fichiers ici")
        left.addWidget(title)
        self.list = QListWidget()
        self.list.setIconSize(QSize(160, 90))
        self.list.setSpacing(3)
        self.list.currentRowChanged.connect(self._select)
        left.addWidget(self.list, 1)
        btns = QHBoxLayout()
        add = QPushButton("Ouvrir…")
        add.clicked.connect(self._open_files)
        self.remove_btn = QPushButton("Retirer")
        self.remove_btn.clicked.connect(self._remove)
        btns.addWidget(add)
        btns.addWidget(self.remove_btn)
        btns.addStretch(1)
        left.addLayout(btns)
        body.addLayout(left, 3)

        self.settings = QGroupBox("Réglages de la vidéo sélectionnée")
        form = QFormLayout(self.settings)
        self.info_label = QLabel("—")
        self.info_label.setWordWrap(True)
        form.addRow(self.info_label)

        self.mode_fast = QRadioButton("Rapide (résolution choisie pour tenir 10 min par heure)")
        self.mode_quality = QRadioButton("Qualité maximale (4K)")
        g = QButtonGroup(self)
        g.addButton(self.mode_fast)
        g.addButton(self.mode_quality)
        self.mode_fast.setChecked(True)
        mbox = QVBoxLayout()
        mbox.addWidget(self.mode_fast)
        mbox.addWidget(self.mode_quality)
        form.addRow("Sortie :", mbox)

        self.limit_check = QCheckBox("Ne pas dépasser")
        self.limit_gb = QDoubleSpinBox()
        self.limit_gb.setRange(1, 1000)
        self.limit_gb.setDecimals(1)
        self.limit_gb.setSuffix(" Go")
        self.limit_gb.setValue(15)
        self.limit_gb.setToolTip("Réduit le débit de l'image pour tenir dans cette taille, sans changer la résolution. "
                                 "Utile pour une source de faible résolution, qui n'a pas besoin du débit maximal.")
        lbox = QHBoxLayout()
        lbox.addWidget(self.limit_check)
        lbox.addWidget(self.limit_gb)
        lbox.addStretch(1)
        form.addRow("Taille :", lbox)

        self.key_auto = QRadioButton("Générée automatiquement")
        self.key_manual = QRadioButton("Saisie :")
        g2 = QButtonGroup(self)
        g2.addButton(self.key_auto)
        g2.addButton(self.key_manual)
        self.key_auto.setChecked(True)
        self.key_edit = QLineEdit()
        self.key_edit.setPlaceholderText("ex. K7QP2MXE")
        self.key_edit.setMaxLength(16)
        kbox = QHBoxLayout()
        kbox.addWidget(self.key_auto)
        kbox.addWidget(self.key_manual)
        kbox.addWidget(self.key_edit, 1)
        form.addRow("Clé :", kbox)

        self.nqr = QSpinBox()
        self.nqr.setRange(1, 3)
        self.nqr.setToolTip("3 par défaut : le navigateur saute parfois la première image au démarrage. "
                            "L'ouverture reste masquée en noir par l'extension.")
        form.addRow("Images de QR code :", self.nqr)

        drow = QHBoxLayout()
        self.dest_edit = QLineEdit()
        self.dest_edit.setPlaceholderText("À côté de la vidéo d'origine")
        dbtn = QPushButton("Choisir…")
        dbtn.clicked.connect(self._choose_dest)
        drow.addWidget(self.dest_edit, 1)
        drow.addWidget(dbtn)
        form.addRow("Destination :", drow)

        self.estimate_label = QLabel("—")
        self.estimate_label.setWordWrap(True)
        form.addRow("Estimation :", self.estimate_label)

        self.preview_btn = QPushButton("Aperçu brouillé / débrouillé…")
        self.preview_btn.clicked.connect(self._preview)
        form.addRow(self.preview_btn)

        for wdg in (self.mode_fast, self.mode_quality, self.key_auto, self.key_manual):
            wdg.toggled.connect(self._form_changed)
        self.key_edit.textChanged.connect(self._form_changed)
        self.nqr.valueChanged.connect(self._form_changed)
        self.limit_check.toggled.connect(self._form_changed)
        self.limit_gb.valueChanged.connect(self._form_changed)
        self.dest_edit.textChanged.connect(self._form_changed)
        body.addWidget(self.settings, 2)
        lay.addLayout(body, 1)

        bottom = QHBoxLayout()
        self.total_label = QLabel("")
        bottom.addWidget(self.total_label, 1)
        self.start_btn = QPushButton("Lancer l'encodage")
        f = self.start_btn.font()
        f.setBold(True)
        self.start_btn.setFont(f)
        self.start_btn.setMinimumHeight(36)
        self.start_btn.clicked.connect(self._start_queue)
        bottom.addWidget(self.start_btn)
        lay.addLayout(bottom)
        self._refresh_prep()
        return w

    # ------------------------------------------------ page 2 : encodage
    def _build_run(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.run_title = QLabel()
        f = self.run_title.font()
        f.setPointSize(f.pointSize() + 3)
        f.setBold(True)
        self.run_title.setFont(f)
        lay.addWidget(self.run_title)

        steps = QHBoxLayout()
        self.step_labels = {}
        for i, name in enumerate(("Son", "Image", "Assemblage", "Vérification")):
            if i:
                arr = QLabel("→")
                steps.addWidget(arr)
            lab = QLabel(name)
            self.step_labels[name] = lab
            steps.addWidget(lab)
        steps.addStretch(1)
        lay.addLayout(steps)

        self.bar = QProgressBar()
        self.bar.setRange(0, 1000)
        self.bar.setMinimumHeight(26)
        self.bar.setFormat("%p %")
        lay.addWidget(self.bar)

        mid = QHBoxLayout()
        stats = QGridLayout()
        self.stat = {}
        for r, (k, t) in enumerate((("frames", "Images traitées"), ("speed", "Vitesse"),
                                    ("elapsed", "Temps écoulé"), ("eta", "Temps restant estimé"),
                                    ("size", "Taille actuelle"), ("out", "Sortie"))):
            stats.addWidget(QLabel(t + " :"), r, 0, Qt.AlignRight | Qt.AlignTop)
            v = QLabel("—")
            v.setTextInteractionFlags(Qt.TextSelectableByMouse)
            v.setWordWrap(True)
            vf = v.font()
            vf.setBold(True)
            v.setFont(vf)
            stats.addWidget(v, r, 1)
            self.stat[k] = v
        stats.setRowStretch(6, 1)
        stats.setColumnStretch(1, 1)
        mid.addLayout(stats, 1)
        self.live = QLabel("Aperçu de l'image brouillée")
        self.live.setFixedSize(480, 270)
        self.live.setAlignment(Qt.AlignCenter)
        self.live.setFrameShape(QFrame.StyledPanel)
        mid.addWidget(self.live)
        lay.addLayout(mid)

        btns = QHBoxLayout()
        self.pause_btn = QPushButton("Pause")
        self.pause_btn.clicked.connect(self._toggle_pause)
        self.cancel_btn = QPushButton("Annuler")
        self.cancel_btn.clicked.connect(self._cancel)
        self.log_btn = QToolButton()
        self.log_btn.setText("▸ Journal détaillé")
        self.log_btn.setCheckable(True)
        self.log_btn.toggled.connect(self._toggle_log)
        btns.addWidget(self.log_btn)
        btns.addStretch(1)
        btns.addWidget(self.pause_btn)
        btns.addWidget(self.cancel_btn)
        lay.addLayout(btns)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(5000)
        self.log.setFont(QFont("Consolas" if sys.platform == "win32" else "Monospace", 9))
        self.log.hide()
        lay.addWidget(self.log, 1)
        lay.addStretch(0)
        return w

    # ------------------------------------------------ page 3 : fin
    def _build_end(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.end_title = QLabel()
        f = self.end_title.font()
        f.setPointSize(f.pointSize() + 3)
        f.setBold(True)
        self.end_title.setFont(f)
        lay.addWidget(self.end_title)
        self.end_scroll = QScrollArea()
        self.end_scroll.setWidgetResizable(True)
        lay.addWidget(self.end_scroll, 1)
        btns = QHBoxLayout()
        btns.addStretch(1)
        again = QPushButton("Encoder une autre vidéo")
        again.clicked.connect(self._back_to_prep)
        btns.addWidget(again)
        lay.addLayout(btns)
        return w

    def _fill_end(self):
        box = QWidget()
        lay = QVBoxLayout(box)
        ok = [i for i in self.finished if i.status == "termine"]
        self.end_title.setText(f"Encodage terminé — {len(ok)} vidéo(s) prête(s)"
                               if ok else "Aucune vidéo n'a été terminée")
        for it in self.finished:
            g = QGroupBox(it.name)
            gl = QHBoxLayout(g)
            if it.status == "termine" and it.result:
                r = it.result
                qr = QLabel()
                qr.setPixmap(QPixmap(r["qr"]).scaled(150, 150, Qt.KeepAspectRatio, Qt.SmoothTransformation))
                gl.addWidget(qr)
                c = r.get("check", {})
                if c:
                    if c.get("ok"):
                        vtxt = (f"<span style='color:#1a7f37'>✔ Vérification réussie</span> : image débrouillée "
                                f"{c['image_psnr']:.0f} dB (brouillée {c['scrambled_psnr']:.0f} dB), QR code lu"
                                + ("" if c.get("audio_corr") is None else f", son {c['audio_corr']:.2f}".replace(".", ",")))
                    else:
                        vtxt = (f"<span style='color:#b35900'>⚠ Vérification douteuse</span> : image "
                                f"{c.get('image_psnr', 0):.0f} dB, QR {'lu' if c.get('qr_ok') else 'non lu'}"
                                + ("" if c.get("audio_corr") is None else f", son {c['audio_corr']:.2f}")
                                + " — voir le journal")
                else:
                    vtxt = "Vérification non effectuée"
                txt = QLabel(
                    f"<b>Fichier :</b> {r['out']}<br><b>Taille :</b> {ff.format_size(r['size'])}"
                    f" — <b>Résolution :</b> {RES_LABEL.get(r['res'], r['res'])}<br>"
                    f"<b>Durée :</b> {ff.format_duration(r['duration'] + core.OPENING_S)} "
                    f"(dont 0,6 s d'ouverture) — encodée en {ff.format_duration(r['elapsed'])}<br>"
                    f"<b>Clé :</b> <code>{r['key']}</code> — QR code : <code>{r['payload']}</code><br>"
                    f"{vtxt}<br><i>Conseil : publiez la vidéo en « non répertoriée ».</i>")
                txt.setTextInteractionFlags(Qt.TextSelectableByMouse)
                txt.setWordWrap(True)
                gl.addWidget(txt, 1)
                col = QVBoxLayout()
                ob = QPushButton("Ouvrir le dossier")
                ob.clicked.connect(lambda _=False, p=r["out"]: open_folder(p))
                col.addWidget(ob)
                if c.get("image") and os.path.exists(c["image"]):
                    vb = QPushButton("Voir la vérification")
                    vb.clicked.connect(lambda _=False, p=c["image"]: QDesktopServices.openUrl(QUrl.fromLocalFile(p)))
                    col.addWidget(vb)
                col.addStretch(1)
                gl.addLayout(col)
            else:
                msg = it.error or ("Interrompu : les tranches terminées sont conservées, relancez pour reprendre."
                                   if it.status == "interrompu" else "Non traité")
                lab = QLabel(f"<span style='color:#c62828'>✖</span> {msg}")
                lab.setWordWrap(True)
                gl.addWidget(lab, 1)
            lay.addWidget(g)
        lay.addStretch(1)
        self.end_scroll.setWidget(box)

    # ------------------------------------------------ matériel et essai de vitesse
    def _start_hardware(self):
        try:
            ff.ffmpeg()
            ff.ffprobe()
        except ff.FFmpegMissing as e:
            self.hw_label.setText(f"<span style='color:#c62828'>{e}</span>")
            self.start_btn.setEnabled(False)
            return
        run_task(bench.hardware, done=self._hw_ready, failed=lambda m: self.hw_label.setText(
            "Détection du matériel impossible : " + m))

    def _hw_ready(self, hw):
        self.hw = hw
        self.bench = bench.speeds(hw)
        if self.bench is None:
            self._run_bench()
        else:
            self._show_hw()

    def _run_bench(self, force=False):
        if not self.hw:
            return
        self.rebench_btn.setEnabled(False)
        self.hw_label.setText(f"{self.hw.describe()}<br><i>Essai de vitesse en cours (une fois pour toutes, "
                              f"environ 20 secondes)…</i>")
        self._update_estimates()

        def done(b):
            self.bench = b
            self._show_hw()

        def fail(m):
            self.hw_label.setText(f"{self.hw.describe()}<br>Essai de vitesse impossible : {m}")
            self.rebench_btn.setEnabled(True)
        run_task(bench.run_bench, self.hw, done=done, failed=fail)

    def _show_hw(self):
        sp = ""
        if self.bench:
            sp = " — vitesse mesurée : " + ", ".join(
                f"{RES_LABEL[r].split(' ')[0]} {v:.0f} img/s" for r, v in sorted(self.bench.items()))
        self.hw_label.setText(f"<b>Matériel :</b> {self.hw.describe()}{sp}")
        self.rebench_btn.setEnabled(True)
        self._update_estimates()

    # ------------------------------------------------ file d'attente
    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls() and (self.tabs.currentIndex() == 1 or self.stack.currentIndex() == 0):
            e.acceptProposedAction()

    def dropEvent(self, e):
        if self.tabs.currentIndex() == 1:
            files = [u.toLocalFile() for u in e.mimeData().urls() if os.path.isfile(u.toLocalFile())]
            if files:
                self.player.open_file(files[0])
            return
        paths = []
        for u in e.mimeData().urls():
            p = u.toLocalFile()
            if os.path.isdir(p):
                for f in sorted(os.listdir(p)):
                    if os.path.splitext(f)[1].lower() in VIDEO_EXT:
                        paths.append(os.path.join(p, f))
            elif p:
                paths.append(p)
        self._add_paths(paths)

    def _open_files(self):
        exts = " ".join("*" + e for e in sorted(VIDEO_EXT))
        paths, _ = QFileDialog.getOpenFileNames(self, "Choisir des vidéos", "", f"Vidéos ({exts});;Tous les fichiers (*)")
        self._add_paths(paths)

    def _add_paths(self, paths):
        for p in paths:
            if any(os.path.normcase(i.path) == os.path.normcase(os.path.abspath(p)) for i in self.items):
                continue
            it = Item(p)
            self.items.append(it)
            it.widget = QListWidgetItem(it.name + "\nAnalyse…")
            self.list.addItem(it.widget)
            run_task(self._probe, it, done=lambda r, it=it: self._probed(it, r),
                     failed=lambda m, it=it: self._probe_failed(it, m))
        if self.items and self.list.currentRow() < 0:
            self.list.setCurrentRow(0)
        self._refresh_prep()

    @staticmethod
    def _probe(it: Item):
        info = ff.probe(it.path)
        thumb = None
        try:
            thumb = ff.grab_rgb(it.path, min(info.duration * 0.1, 30), 320, 180, fit=True, matrix=info.matrix)
        except Exception:
            pass
        _, work = pipeline.output_paths(it.path, None)
        st = pipeline.read_state(work)
        resume = ""
        if st and st.get("source") == pipeline.src_signature(it.path):
            resume = st.get("key", "")
        return info, thumb, resume

    def _probed(self, it: Item, r):
        it.info, thumb, it.resume_key = r
        if thumb is not None:
            it.thumb = np_to_pixmap(thumb)
            it.widget.setIcon(QIcon(it.thumb))
        if it.resume_key:
            it.key_auto = False
            it.key = it.resume_key
        self._update_item_text(it)
        if self.current_item() is it:
            self._load_form(it)
        self._refresh_prep()

    def _probe_failed(self, it: Item, msg: str):
        it.error = msg
        it.status = "erreur"
        it.widget.setText(f"{it.name}\n⚠ {msg}")
        self._refresh_prep()

    def _remove(self):
        row = self.list.currentRow()
        if row < 0:
            return
        self.items.pop(row)
        self.list.takeItem(row)
        self._refresh_prep()

    def current_item(self) -> Item | None:
        row = self.list.currentRow()
        return self.items[row] if 0 <= row < len(self.items) else None

    def _select(self, row):
        it = self.current_item()
        if it:
            self._load_form(it)
        self._refresh_prep()

    def _load_form(self, it: Item):
        self._loading_form = True
        self.mode_fast.setChecked(it.mode == "rapide")
        self.mode_quality.setChecked(it.mode == "qualite")
        self.key_auto.setChecked(it.key_auto)
        self.key_manual.setChecked(not it.key_auto)
        self.key_edit.setText(it.key)
        self.key_edit.setEnabled(not it.key_auto)
        self.nqr.setValue(it.n_qr)
        self.limit_check.setChecked(it.max_gb > 0)
        if it.max_gb > 0:
            self.limit_gb.setValue(it.max_gb)
        self.limit_gb.setEnabled(it.max_gb > 0)
        self.dest_edit.setText(it.out_dir)
        self._loading_form = False
        self._update_form_info(it)

    def _form_changed(self, *_):
        self.key_edit.setEnabled(self.key_manual.isChecked())
        self.limit_gb.setEnabled(self.limit_check.isChecked())
        if self._loading_form:
            return
        it = self.current_item()
        if not it:
            return
        it.mode = "qualite" if self.mode_quality.isChecked() else "rapide"
        it.key_auto = self.key_auto.isChecked()
        it.key = self.key_edit.text().strip().upper()
        it.n_qr = self.nqr.value()
        it.max_gb = self.limit_gb.value() if self.limit_check.isChecked() else 0.0
        it.out_dir = self.dest_edit.text().strip()
        self._update_item_text(it)
        self._update_form_info(it)
        self._refresh_prep()

    def _choose_dest(self):
        d = QFileDialog.getExistingDirectory(self, "Dossier de destination", self.dest_edit.text() or "")
        if d:
            self.dest_edit.setText(d)

    def _plan(self, it: Item):
        """(résolution, secondes estimées, taille estimée, débit de l'image) pour un élément."""
        if not it.info:
            return None, None, None, None
        res = bench.choose_resolution(it.mode, it.info.fps_float, self.bench)
        frames = it.info.frames + core.opening_frames(it.info.fps_float)
        secs = bench.estimate_seconds(frames, res, self.bench, it.info.fps_float)
        mbps = core.video_mbps(res, it.info.duration, it.max_gb * 1e9 or None)
        return res, secs, pipeline.estimate_size(it.info.duration, res, mbps), mbps

    def _estimate_text(self, it: Item) -> str:
        res, secs, size, mbps = self._plan(it)
        if res is None:
            return "—"
        t = f"{RES_LABEL[res]}, {mbps:g} Mbit/s — ".replace(".", ",") + (f"environ {ff.format_duration(secs)}" if secs else "durée inconnue (essai de vitesse en cours)")
        t += f" — au plus {ff.format_size(size)}"
        if it.max_gb and mbps <= core.MIN_MBPS and size > it.max_gb * 1e9:
            t += f" (débit minimal de {core.MIN_MBPS} Mbit/s atteint : taille visée impossible)"
        return t

    def _update_item_text(self, it: Item):
        if not it.widget:
            return
        if it.error and it.status == "erreur":
            return
        lines = [it.name]
        if it.info:
            lines.append(it.info.describe())
            lines.append(self._estimate_text(it))
        if it.resume_key and it.status == "attente":
            lines.append(f"↻ Reprise possible (clé {it.resume_key})")
        status = {"termine": "✔ Terminé", "interrompu": "⏸ Interrompu — reprise possible",
                  "erreur": "⚠ Erreur"}.get(it.status)
        if status:
            lines.append(status)
        it.widget.setText("\n".join(lines))

    def _update_form_info(self, it: Item):
        if it.info:
            i = it.info
            fps = f"{i.fps_float:.3f}".rstrip("0").rstrip(".").replace(".", ",")
            self.info_label.setText(
                f"<b>{it.name}</b><br>Durée {ff.format_duration(i.duration)} — {i.width}×{i.height} — "
                f"{fps} images/s — {ff.format_size(i.size)}<br>"
                f"Image : {i.codec} — Son : {i.audio_desc or 'aucun'}")
            self.estimate_label.setText(self._estimate_text(it))
        else:
            self.info_label.setText(f"<b>{it.name}</b><br>{it.error or 'Analyse en cours…'}")
            self.estimate_label.setText("—")

    def _update_estimates(self):
        for it in self.items:
            self._update_item_text(it)
        it = self.current_item()
        if it:
            self._update_form_info(it)
        self._refresh_prep()

    def _refresh_prep(self):
        it = self.current_item()
        self.settings.setEnabled(bool(it and it.info))
        self.preview_btn.setEnabled(bool(it and it.info))
        self.remove_btn.setEnabled(it is not None)
        todo = [i for i in self.items if i.info and i.status in ("attente", "interrompu", "erreur")]
        total_s = 0.0
        known = True
        for i in todo:
            _, s, _, _ = self._plan(i)
            if s is None:
                known = False
            else:
                total_s += s
        self.start_btn.setText(f"Lancer l'encodage ({len(todo)} vidéo{'s' if len(todo) > 1 else ''})"
                               if todo else "Lancer l'encodage")
        self.start_btn.setEnabled(bool(todo) and self.hw is not None)
        if todo:
            self.total_label.setText(f"File d'attente : {len(todo)} vidéo(s)"
                                     + (f" — environ {ff.format_duration(total_s)} au total" if known else ""))
        else:
            self.total_label.setText("Ajoutez une vidéo avec « Ouvrir… » ou en la glissant dans la fenêtre.")

    def _preview(self):
        it = self.current_item()
        if it and it.info:
            res, _, _, _ = self._plan(it)
            PreviewDialog(self, it, res).exec()

    # ------------------------------------------------ lancement
    def _start_queue(self):
        todo = [i for i in self.items if i.info and i.status in ("attente", "interrompu", "erreur")]
        for it in todo:
            if not it.key_auto:
                try:
                    it.key = core.normalize_key(it.key)
                except ValueError as e:
                    self.list.setCurrentRow(self.items.index(it))
                    QMessageBox.warning(self, "Clé invalide", f"{it.name} : {e}")
                    return
            if it.out_dir and not os.path.isdir(it.out_dir):
                QMessageBox.warning(self, "Destination introuvable", f"Le dossier « {it.out_dir} » n'existe pas.")
                return
            out, _ = pipeline.output_paths(it.path, it.out_dir or None)
            if os.path.exists(out):
                r = QMessageBox.question(self, "Fichier existant",
                                         f"« {out} » existe déjà. Le remplacer ?")
                if r != QMessageBox.Yes:
                    return
        self.queue = list(todo)
        self.finished = []
        self.log.clear()
        self.stack.setCurrentIndex(1)
        self._next_job()

    def _next_job(self):
        if not self.queue:
            self.current = None
            self.taskbar.set(None)
            self._set_title()
            self._fill_end()
            self.stack.setCurrentIndex(2)
            ok = [i for i in self.finished if i.status == "termine"]
            if ok:
                vid = sum(i.result["duration"] for i in ok)
                took = sum(i.result["elapsed"] for i in ok)
                self._notify("Encodage terminé",
                             f"{ff.format_duration(vid)} de vidéo en {ff.format_duration(took)}")
            return
        it = self.queue.pop(0)
        self.current = it
        it.status = "encodage"
        it.error = ""
        idx = len(self.finished) + 1
        n = idx + len(self.queue)
        self.run_title.setText(f"Vidéo {idx} / {n} : {it.name}" if n > 1 else it.name)
        for lab in self.step_labels.values():
            lab.setStyleSheet("color: gray;")
        for v in self.stat.values():
            v.setText("—")
        self.live.setText("Aperçu de l'image brouillée")
        self.bar.setRange(0, 1000)
        self.bar.setValue(0)
        self.paused = False
        self.cancel_requested = False
        self.pause_btn.setText("Pause")
        self.pause_btn.setEnabled(True)
        self.cancel_btn.setEnabled(True)
        self._stage = ""
        self._preview_mtime = 0.0
        self._preview_loaded = 0.0

        res, _, _, _ = self._plan(it)
        job = {"max_size": it.max_gb * 1e9 or None,"src": it.path, "out_dir": it.out_dir or None, "res": res,
               "key": None if it.key_auto else it.key, "n_qr": it.n_qr,
               "hardware": asdict(self.hw), "stop_with_gui": True, "verify": True,
               "parallel_chunks": max(1, (os.cpu_count() or 4) // 4), "threads_per_chunk": 4}
        jobs = os.path.join(bench.config_dir(), "travaux")
        os.makedirs(jobs, exist_ok=True)
        jp = os.path.join(jobs, f"travail_{int(time.time() * 1000)}.json")
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False, indent=1)
        self._job_file = jp
        self._append_log(f"=== {it.name} → {RES_LABEL[res]} ===")

        self.proc = QProcess(self)
        env = QProcessEnvironment.systemEnvironment()
        env.insert("PYTHONIOENCODING", "utf-8")
        env.insert("PYTHONUNBUFFERED", "1")
        self.proc.setProcessEnvironment(env)
        self.proc.setWorkingDirectory(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.proc.readyReadStandardOutput.connect(self._read_out)
        self.proc.readyReadStandardError.connect(
            lambda: self._append_log(bytes(self.proc.readAllStandardError()).decode(errors="replace").rstrip()))
        self.proc.finished.connect(self._proc_finished)
        self._buf = b""
        self._got_final = False
        self.proc.start(python_for_worker(), ["-m", "brouilleur.worker", jp])
        self._set_title(0.0)

    def _read_out(self):
        self._buf += bytes(self.proc.readAllStandardOutput())
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                self._append_log(line.decode(errors="replace"))
                continue
            self._handle(msg)

    def _handle(self, m: dict):
        t = m.get("type")
        it = self.current
        if t == "log":
            self._append_log(m["msg"])
        elif t == "stage":
            self._set_stage(m["stage"])
        elif t == "key":
            self.stat["out"].setText(f"{m['out']} ({RES_LABEL.get(m['res'], m['res'])}, clé {m['key']})")
        elif t == "audio":
            frac = m["done"] / max(1, m["total"])
            self.bar.setValue(int(frac * 1000))
            self.stat["elapsed"].setText(ff.format_duration(m["elapsed"]))
            self._set_title(frac, "Son")
        elif t == "progress":
            frac = m["frames"] / max(1, m["total"])
            self.bar.setValue(int(frac * 1000))
            self.stat["frames"].setText(f"{ff.format_int(m['frames'])} / {ff.format_int(m['total'])}")
            if m["fps"] > 0:
                self.stat["speed"].setText(f"{m['fps']:.0f} images/s — ×{m['speed']:.1f} le temps réel"
                                           .replace(".", ","))
                rem = (m["total"] - m["frames"]) / m["fps"]
                self.stat["eta"].setText(ff.format_duration(rem) if not self.paused else "en pause")
            self.stat["elapsed"].setText(ff.format_duration(m["elapsed"]))
            self.stat["size"].setText(ff.format_size(m["size"]))
            self._set_title(frac, "Encodage")
            pv = m.get("preview")
            if pv:
                try:
                    mt = os.path.getmtime(pv)
                    if mt != self._preview_mtime and time.monotonic() - self._preview_loaded > 1.0:
                        pm = QPixmap(pv)
                        if not pm.isNull():
                            self._preview_mtime = mt
                            self._preview_loaded = time.monotonic()
                            self.live.setPixmap(pm.scaled(self.live.size(), Qt.KeepAspectRatio,
                                                          Qt.SmoothTransformation))
                except OSError:
                    pass
        elif t == "verify":
            self.bar.setRange(0, m["total"])
            self.bar.setValue(m["done"])
        elif t == "paused":
            self.paused = m["paused"]
            self.pause_btn.setText("Reprendre" if self.paused else "Pause")
            self._set_title(self.bar.value() / max(1, self.bar.maximum()),
                            "En pause" if self.paused else "Encodage")
        elif t == "done":
            self._got_final = True
            it.status = "termine"
            it.result = m
            it.resume_key = ""
        elif t == "cancelled":
            self._got_final = True
            it.status = "interrompu"
        elif t == "error":
            self._got_final = True
            it.status = "erreur"
            it.error = m["msg"]
            self._append_log("ERREUR : " + m["msg"])

    def _proc_finished(self, code, _status):
        self._read_out()
        it = self.current
        if it is None:
            return
        try:
            os.remove(self._job_file)
        except OSError:
            pass
        if not self._got_final:
            it.status = "erreur"
            it.error = f"Le processus d'encodage s'est arrêté brutalement (code {code}). Voir le journal détaillé."
        self.proc = None
        if self.closing:
            self.close()
            return
        if it.status == "interrompu":
            self._after_cancel(it)
            return
        if it.status == "erreur":
            QMessageBox.critical(self, "Erreur d'encodage", f"{it.name} :\n\n{it.error}")
            self.log_btn.setChecked(True)
        self.finished.append(it)
        self._update_item_text(it)
        self._next_job()

    def _after_cancel(self, it: Item):
        _, work = pipeline.output_paths(it.path, it.out_dir or None)
        keep = QMessageBox.question(
            self, "Encodage annulé",
            "Garder les tranches déjà terminées pour reprendre plus tard ?\n\n"
            "(Si vous relancez cette vidéo avec les mêmes réglages, l'encodage reprendra où il s'est arrêté.)",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
        st = pipeline.read_state(work)
        if keep == QMessageBox.Yes:
            it.resume_key = (st or {}).get("key", "")
            if it.resume_key:
                it.key_auto, it.key = False, it.resume_key
        else:
            shutil.rmtree(work, ignore_errors=True)
            it.status = "attente"
            it.resume_key = ""
        self.queue = []
        self.current = None
        self._update_item_text(it)
        self.taskbar.set(None)
        self._set_title()
        self._back_to_prep()

    # ------------------------------------------------ contrôles
    def _set_stage(self, name: str):
        self._stage = name
        seen = True
        for k, lab in self.step_labels.items():
            if k == name:
                lab.setStyleSheet("font-weight: bold;")
                seen = False
            elif seen:
                lab.setStyleSheet("color: #1a7f37;")
            else:
                lab.setStyleSheet("color: gray;")
        if name == "Assemblage":
            self.bar.setRange(0, 0)
        else:
            self.bar.setRange(0, 1000)
        if name in ("Assemblage", "Vérification"):
            self.stat["eta"].setText("quelques secondes")
            self._set_title(1.0, name)

    def hw_dict(self) -> dict:
        return asdict(self.hw)

    def launch_worker(self, job: dict, on_msg, on_finished) -> QProcess:
        """Lance un travail dans le processus séparé ; on_msg reçoit chaque message JSON."""
        jobs = os.path.join(bench.config_dir(), "travaux")
        os.makedirs(jobs, exist_ok=True)
        jp = os.path.join(jobs, f"travail_{int(time.time() * 1000)}.json")
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False, indent=1)
        proc = QProcess(self)
        env = QProcessEnvironment.systemEnvironment()
        env.insert("PYTHONIOENCODING", "utf-8")
        env.insert("PYTHONUNBUFFERED", "1")
        proc.setProcessEnvironment(env)
        proc.setWorkingDirectory(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        buf = [b""]

        def read():
            buf[0] += bytes(proc.readAllStandardOutput())
            while b"\n" in buf[0]:
                line, buf[0] = buf[0].split(b"\n", 1)
                try:
                    on_msg(json.loads(line.decode("utf-8")))
                except ValueError:
                    pass

        def finished(*_):
            read()
            try:
                os.remove(jp)
            except OSError:
                pass
            on_finished()
        proc.readyReadStandardOutput.connect(read)
        proc.finished.connect(finished)
        proc.start(python_for_worker(), ["-m", "brouilleur.worker", jp])
        return proc

    def _toggle_pause(self):
        if self.proc:
            self.proc.write(b"resume\n" if self.paused else b"pause\n")

    def _cancel(self):
        if not self.proc:
            return
        r = QMessageBox.question(self, "Annuler", "Arrêter l'encodage en cours ?")
        if r == QMessageBox.Yes:
            self.cancel_requested = True
            self.cancel_btn.setEnabled(False)
            self.pause_btn.setEnabled(False)
            self.proc.write(b"cancel\n")

    def _toggle_log(self, on):
        self.log.setVisible(on)
        self.log_btn.setText(("▾ " if on else "▸ ") + "Journal détaillé")

    def _append_log(self, text: str):
        if text:
            self.log.appendPlainText(text)

    def _back_to_prep(self):
        for it in self.items:
            self._update_item_text(it)
        self.stack.setCurrentIndex(0)
        self._refresh_prep()

    def _set_title(self, frac: float | None = None, what: str = "Encodage"):
        if frac is None:
            self.setWindowTitle("Brouilleur de vidéos")
            return
        self.setWindowTitle(f"{int(frac * 100)} % — {what}")
        self.taskbar.set(frac, paused=self.paused)

    def _notify(self, title: str, text: str):
        try:
            if QSystemTrayIcon.isSystemTrayAvailable():
                self.tray.show()
                self.tray.showMessage(title, text, app_icon(), 10000)
        except Exception:
            pass
        QApplication.alert(self)

    def closeEvent(self, e):
        self.player.stop()
        if self.player.proc:
            self.player.proc.write(b"cancel\n")
            self.player.proc.waitForFinished(5000)
        if self.proc and not self.closing:
            r = QMessageBox.question(
                self, "Encodage en cours",
                "Un encodage est en cours. Quitter quand même ?\n\n"
                "Les tranches terminées sont conservées : il reprendra au prochain lancement.")
            if r != QMessageBox.Yes:
                e.ignore()
                return
            self.closing = True
            self.proc.write(b"cancel\n")
            if not self.proc.waitForFinished(8000):
                self.proc.kill()
            e.accept()
            return
        e.accept()


def python_for_worker() -> str:
    exe = sys.executable
    if sys.platform == "win32":
        d = os.path.dirname(exe)
        w = os.path.join(d, "pythonw.exe")
        if os.path.exists(w):
            return w
    return exe


def main():
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Brouilleur.BRV1")
        except Exception:
            pass
    app = QApplication(sys.argv)
    app.setApplicationName("Brouilleur")
    app.setDesktopFileName("brouilleur")
    app.setWindowIcon(app_icon())
    w = MainWindow()
    w.show()
    paths = [a for a in sys.argv[1:] if os.path.isfile(a)]
    if paths:
        w._add_paths(paths)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
