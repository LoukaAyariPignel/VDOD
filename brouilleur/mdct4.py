"""Son BRV4 : brouillage dans le domaine d'une MDCT (voir SPEC.md §5 ter).

Le son « virtuel » (silence d'ouverture puis son original, comme en BRV1-3) est découpé par une
MDCT de pas N = 2048 (42,7 ms), fenêtre sinus, orthonormée. Dans chaque fenêtre de 8 trames,
les trames sont permutées (order), certaines ont un coefficient sur deux changé de signe
(reverse : l'équivalent d'un retournement dans le temps) et 16 bandes de 375 Hz (0 – 6 kHz)
sont mélangées (band_perm). Le son publié est la synthèse de ces trames, × GAIN.

La MDCT étant une base orthonormée, l'analyse du son publié redonne exactement les trames
brouillées : le débrouillage est exact (à la précision du calcul près), et le bruit ajouté par
une recompression n'est pas amplifié. Les trames se recouvrent avec une fenêtre douce : le son
publié n'a pas de coupures franches, que les codecs rendent mal.

Chronologie du son publié (identique à BRV1-3) : bip de repère à 0, grille à partir de G
(120 ms) : l'échantillon virtuel v est à la position publiée G + v, et le son débrouillé est
joué avec W = 480 ms de retard (compensé par l'ouverture).
"""

from __future__ import annotations

import math
from typing import Callable, Iterator

import numpy as np

from .core import AUDIO_RATE, GRID_START_S, OPENING_S, AudioPlan, Stream, fisher_yates, GRID_TEXT

N = 2048                    # pas des trames (42,7 ms à 48 kHz)
FW = 8                      # trames par fenêtre de mélange (341 ms)
N_BANDS = 16                # bandes mélangées (0 – 6 kHz : deux fois moins reconnaissable que 0 – 3 kHz)
BAND_BINS = 32              # coefficients par bande (375 Hz)
GAIN = 0.7                  # marge contre la saturation (le mélange fait monter les crêtes)

_n = np.arange(2 * N)
_k = np.arange(N)
WIN = np.sin(np.pi * (_n + 0.5) / (2 * N))
_N0 = 0.5 + N / 2
_PRE = np.exp(-1j * np.pi * _n / (2 * N))
_POST = np.exp(-1j * np.pi * _N0 * (_k + 0.5) / N)
_IPRE = np.exp(1j * np.pi * _N0 * _k / N)
_IPOST = np.exp(1j * np.pi * (_n + _N0) / (2 * N))
_SIGN = (-1.0) ** _k
_SCALE = math.sqrt(2 / N)


def analyze(frames: np.ndarray) -> np.ndarray:
    """(F, 2N, ch) → coefficients (F, N, ch)."""
    z = frames * WIN[None, :, None] * _PRE[None, :, None]
    return _SCALE * np.real(np.fft.fft(z, axis=1)[:, :N] * _POST[None, :, None])


def synthesize(coefs: np.ndarray) -> np.ndarray:
    """(F, N, ch) → trames fenêtrées (F, 2N, ch), à additionner avec un pas de N."""
    F, _, ch = coefs.shape
    Z = np.zeros((F, 2 * N, ch), complex)
    Z[:, :N] = coefs * _IPRE[None, :, None]
    return _SCALE * np.real(np.fft.ifft(Z, axis=1) * (2 * N) * _IPOST[None, :, None]) * WIN[None, :, None]


def band_perm(key: str, window: int) -> list[int]:
    return fisher_yates(Stream(f"{key}:{GRID_TEXT}:BANDES:{window}"), N_BANDS)


def scramble_window(coefs: np.ndarray, plan: AudioPlan, q: list[int]) -> np.ndarray:
    """8 trames virtuelles (8, N, ch) → 8 trames publiées."""
    out = np.empty_like(coefs)
    nb = N_BANDS * BAND_BINS
    for i, (j, rev) in enumerate(zip(plan.order, plan.reverse)):
        f = coefs[j] * _SIGN[:, None] if rev else coefs[j].copy()
        bands = f[:nb].reshape(N_BANDS, BAND_BINS, -1)
        f[:nb] = bands[q].reshape(nb, -1)          # la bande brouillée b contient l'originale q[b]
        out[i] = f
    return out


def descramble_window(coefs: np.ndarray, plan: AudioPlan, q: list[int]) -> np.ndarray:
    """8 trames publiées → 8 trames virtuelles."""
    out = np.empty_like(coefs)
    nb = N_BANDS * BAND_BINS
    inv = np.argsort(q)
    for i, (j, rev) in enumerate(zip(plan.order, plan.reverse)):
        f = coefs[i].copy()
        bands = f[:nb].reshape(N_BANDS, BAND_BINS, -1)
        f[:nb] = bands[inv].reshape(nb, -1)
        if rev:
            f *= _SIGN[:, None]
        out[j] = f
    return out


def _grid_g(rate: int) -> int:
    return round(GRID_START_S * rate)


class _Reader:
    """Lecture par blocs d'un itérateur de tableaux (n, ch), complétée de silence à la fin."""

    def __init__(self, source: Iterator[np.ndarray], ch: int):
        self.source, self.ch = source, ch
        self.pending = np.zeros((0, ch))
        self.eof = False
        self.count = 0              # échantillons réels lus

    def read(self, n: int) -> np.ndarray:
        parts, have = [], 0
        while have < n:
            if not len(self.pending):
                if self.eof:
                    parts.append(np.zeros((n - have, self.ch)))
                    break
                try:
                    b = next(self.source)
                    self.pending = np.asarray(b, np.float64).reshape(len(b), self.ch)
                    self.count += len(b)
                except StopIteration:
                    self.eof = True
                continue
            take = self.pending[: n - have]
            self.pending = self.pending[len(take):]
            parts.append(take)
            have += len(take)
        return np.concatenate(parts) if len(parts) > 1 else parts[0] if parts else np.zeros((0, self.ch))


def _process(read: Callable[[int], np.ndarray], first_frame: int, frames: int, ch: int, fn, key: str,
             plan: AudioPlan, state: dict) -> np.ndarray:
    """Analyse puis resynthèse de `frames` trames à partir de first_frame (multiple de FW, + 1 ou 0).

    state garde la fin du signal lu (N échantillons) et la moitié de trame en attente.
    Renvoie les échantillons terminés : N × frames.
    """
    new = read(frames * N)
    sig = np.concatenate([state["tail"], new])               # (frames + 1) N échantillons
    state["tail"] = sig[-N:]
    idx = np.arange(frames)[:, None] * N + _n[None, :]
    X = analyze(sig[idx])                                    # trames first_frame … first_frame+frames-1
    for f0 in range(0, frames, FW):
        m = first_frame + f0
        if m >= 1:
            w = (m - 1) // FW
            X[f0:f0 + FW] = fn(X[f0:f0 + FW], plan, band_perm(key, w))
    Y = synthesize(X)
    out = np.zeros(((frames + 1) * N, ch))
    for f in range(frames):
        out[f * N:(f + 2) * N] += Y[f]
    out[:N] += state["half"]
    state["half"] = out[frames * N:]
    return out[: frames * N]


def scramble_stream(source: Iterator[np.ndarray], ch: int, plan: AudioPlan, key: str, opening_s: float,
                    write: Callable[[np.ndarray], None], rate: int = AUDIO_RATE, batch_windows: int = 16) -> int:
    """Brouille un flux de son (blocs (n, ch)) en BRV4 et écrit le son publié. Renvoie sa longueur.

    Positions : la trame m couvre les virtuels [(m−1)N, (m+1)N) ; le virtuel v est publié en G + v.
    """
    from .audio import beep
    if rate != AUDIO_RATE:
        raise ValueError("BRV4 : son à 48 kHz seulement")
    G = _grid_g(rate)
    delay = round((opening_s - OPENING_S) * rate)
    src = _Reader(source, ch)
    zeros = [delay]

    def read(n):                                              # son virtuel : délai, puis la source
        z = min(zeros[0], n)
        zeros[0] -= z
        if z == n:
            return np.zeros((n, ch))
        body = src.read(n - z)
        return np.concatenate([np.zeros((z, ch)), body]) if z else body

    state = {"tail": np.zeros((N, ch)), "half": np.zeros((N, ch))}   # tail : virtuels [−N, 0)
    pre = np.zeros((G - N, ch))
    b = beep(rate)
    pre[: len(b)] += b[:, None]
    written = 0

    def emit(x):
        nonlocal written
        if len(x):
            write(np.ascontiguousarray(x, dtype=np.float32))
            written += len(x)

    emit(pre)                                                 # publiés [0, G − N)
    emit(_process(read, 0, 1, ch, scramble_window, key, plan, state) * GAIN)   # trame 0 : [G − N, G)
    m = 1
    while True:
        frames = batch_windows * FW
        out = _process(read, m, frames, ch, scramble_window, key, plan, state)   # virtuels [(m−1)N, …)
        start = (m - 1) * N
        m += frames
        if src.eof:
            total = delay + src.count
            # fin : fenêtres complètes jusqu'au bout du son, plus la trame de traîne
            last = max(1, math.ceil(total / (FW * N))) * FW          # dernière trame utile
            end = (last + 1) * N
            if m * N >= end:
                rest = np.concatenate([out, state["half"]])[: end - start]
                emit(rest * GAIN)
                return written
        emit(out * GAIN)


def read_start(v0: float, rate: int = AUDIO_RATE) -> tuple[float, int, int]:
    """Pour restituer le son virtuel à partir de l'instant v0 (s, ≥ 0) : renvoie (instant de lecture
    dans le son publié, fenêtre de départ k_start, échantillons à sauter dans la sortie)."""
    G = _grid_g(rate)
    v = max(0, round(v0 * rate))
    k = v // (FW * N)
    k_start = k - 1                                           # une fenêtre de contexte, jetée
    if k_start <= 0:
        return (G - N) / rate, 0, v                           # trame 0 comme contexte ; sortie depuis v = 0
    return (G + k_start * FW * N) / rate, k_start, v - (k_start * FW + FW) * N


def descramble_stream(source: Iterator[np.ndarray], plan: AudioPlan, key: str, ch: int, k_start: int,
                      rate: int = AUDIO_RATE, batch_windows: int = 8) -> Iterator[np.ndarray]:
    """Débrouille en flux un son publié lu à partir de read_start(...)[0].

    Produit le son virtuel (× 1/GAIN) à partir de v = 0 (k_start = 0) ou de (k_start + 1)·FW·N.
    """
    rd = _Reader(source, ch)
    state = {"tail": rd.read(N), "half": np.zeros((N, ch))}
    if k_start <= 0:
        _process(rd.read, 0, 1, ch, descramble_window, key, plan, state)          # sortie [−N, 0) : jetée
        m = 1
    else:
        m = k_start * FW + 1
        _process(rd.read, m, FW, ch, descramble_window, key, plan, state)         # fenêtre de contexte
        m += FW
    inv = 1.0 / GAIN
    while True:
        out = _process(rd.read, m, batch_windows * FW, ch, descramble_window, key, plan, state)
        m += batch_windows * FW
        yield (out * inv).astype(np.float32)
        if rd.eof and not len(rd.pending):
            yield (state["half"] * inv).astype(np.float32)
            return
