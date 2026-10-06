"""Brouillage du son : morceaux de 60 ms mélangés dans des fenêtres de 480 ms.

Chronologie du son publié (voir SPEC.md) :
    0      – 50 ms  : bip de repère (glissando 500 → 5000 Hz)
    120 ms (G)      : début de la première fenêtre brouillée
Le signal « virtuel » brouillé fenêtre par fenêtre est : d secondes de silence, puis
le son original, où d = O − 0,6 s (O = durée réelle de l'ouverture, un nombre entier
d'images). Une fois débrouillé, avec une fenêtre de retard (480 ms), le son original
retombe exactement au début de la vidéo (instant O).

Dans chaque fenêtre, la position i contient le morceau original order[i], retourné
si reverse[i]. Chaque morceau est prolongé de 4 ms de son voisinage original de
chaque côté et pondéré par un trapèze (rampes linéaires de 8 ms centrées sur les
jointures), puis les morceaux sont additionnés : les rampes se recouvrent en
fondu croisé et leur somme vaut 1.
"""

from __future__ import annotations

import math
from typing import Callable, Iterator

import numpy as np

from .core import (AUDIO_RATE, BEEP_AMPLITUDE, BEEP_F0, BEEP_F1, BEEP_MS, CHUNK_MS,
                   GRID_START_S, MARGIN_MS, OPENING_S, WINDOW_CHUNKS, AudioPlan)


class Geometry:
    def __init__(self, rate: int = AUDIO_RATE):
        self.rate = rate
        self.L = round(CHUNK_MS * rate / 1000)
        self.M = round(MARGIN_MS * rate / 1000)
        self.W = self.L * WINDOW_CHUNKS
        self.G = round(GRID_START_S * rate)
        n = self.L + 2 * self.M
        k = np.arange(n, dtype=np.float32)
        ramp = (k + 0.5) / (2 * self.M)
        w = np.minimum(1.0, np.minimum(ramp, ramp[::-1]))
        self.window = w.astype(np.float32)[:, None]


def beep(rate: int = AUDIO_RATE) -> np.ndarray:
    n = round(BEEP_MS * rate / 1000)
    t = np.arange(n) / rate
    T = n / rate
    phase = 2 * np.pi * (BEEP_F0 * t + (BEEP_F1 - BEEP_F0) * t * t / (2 * T))
    env = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / (n - 1))
    return (BEEP_AMPLITUDE * env * np.sin(phase)).astype(np.float32)


def _scramble_batch(seg: np.ndarray, nwin: int, g: Geometry, plan: AudioPlan) -> np.ndarray:
    """seg : signal virtuel [S−M, S+nwin·W+M). Renvoie le brouillé sur la même étendue."""
    L, M, W = g.L, g.M, g.W
    out = np.zeros_like(seg)
    base = (np.arange(nwin) * W)[:, None]
    span = np.arange(L + 2 * M)[None, :]
    for i, (j, rev) in enumerate(zip(plan.order, plan.reverse)):
        piece = seg[base + j * L + span]          # (nwin, L+2M, ch)
        if rev:
            piece = piece[:, ::-1]
        out[base + i * L + span] += piece * g.window
    return out


def descramble(published: np.ndarray, plan: AudioPlan, g: Geometry, opening_s: float) -> np.ndarray:
    """Débrouille un son publié entier (référence, pour la vérification).

    Renvoie le son original reconstitué, l'indice 0 correspondant au début de la vidéo originale.
    """
    out = descramble_grid(published[g.G - g.M:], plan, g)
    d = round((opening_s - OPENING_S) * g.rate)
    return out[g.M + d:]


def descramble_grid(grid: np.ndarray, plan: AudioPlan, g: Geometry) -> np.ndarray:
    """Débrouille un extrait qui commence M échantillons avant le début d'une fenêtre.

    Le résultat couvre la même étendue, en temps « virtuel » ; il n'est exact qu'à partir
    de l'indice M (début de la fenêtre).
    """
    L, M, W = g.L, g.M, g.W
    nwin = max(0, (len(grid) - 2 * M) // W)
    grid = grid[:nwin * W + 2 * M]
    out = np.zeros_like(grid)
    base = (np.arange(nwin) * W)[:, None]
    span = np.arange(L + 2 * M)[None, :]
    for i, (j, rev) in enumerate(zip(plan.order, plan.reverse)):
        piece = grid[base + i * L + span]
        if rev:
            piece = piece[:, ::-1]
        out[base + j * L + span] += piece * g.window
    return out


def read_start(v0: float, rate: int = AUDIO_RATE) -> tuple[float, int, int]:
    """Pour restituer le son virtuel à partir de l'instant v0 (secondes, v0 ≥ 0) :
    renvoie (instant de lecture dans le son publié, fenêtre de départ k0, échantillons à sauter)."""
    g = Geometry(rate)
    v = max(0, round(v0 * rate))
    k0 = v // g.W
    return (g.G + k0 * g.W - g.M) / rate, k0, v - k0 * g.W + g.M


def descramble_stream(source: Iterator[np.ndarray], plan: AudioPlan, ch: int, skip: int,
                      rate: int = AUDIO_RATE, batch_windows: int = 2) -> Iterator[np.ndarray]:
    """Débrouille en flux un son publié lu à partir de G + k0·W − M (voir read_start).

    Produit le son virtuel à partir de l'instant k0·W − M + skip, par blocs.
    """
    g = Geometry(rate)
    W, M = g.W, g.M
    need = batch_windows * W + 2 * M
    parts: list[np.ndarray] = []
    have = 0
    eof = False
    carry = np.zeros((2 * M, ch), np.float32)
    while True:
        while have < need and not eof:
            try:
                b = next(source)
                parts.append(b)
                have += len(b)
            except StopIteration:
                eof = True
        if have == 0:
            return
        buf = np.concatenate(parts) if len(parts) > 1 else parts[0]
        real = min(have, need)
        seg = buf[:need]
        if len(seg) < need:
            seg = np.concatenate([seg, np.zeros((need - len(seg), ch), np.float32)])
        y = descramble_grid(seg, plan, g)
        y[: 2 * M] += carry
        out = y[: batch_windows * W]
        carry = y[batch_windows * W:].copy()
        rest = buf[batch_windows * W:]
        parts, have = ([rest], len(rest)) if len(rest) else ([], 0)
        if eof:
            out = out[: max(0, real - M)]
        if skip:
            cut = min(skip, len(out))
            out = out[cut:]
            skip -= cut
        if len(out):
            yield out
        if eof and have <= 2 * M:
            return


class _Virtual:
    """Signal virtuel : d échantillons de silence, puis le son source, puis du silence."""

    def __init__(self, source: Iterator[np.ndarray], delay: int, ch: int):
        self.source = source
        self.pending = np.zeros((delay, ch), np.float32)
        self.ch = ch
        self.eof = False
        self.length = delay        # longueur connue du signal virtuel (hors silence final)

    @property
    def total(self) -> int | None:
        return self.length if self.eof else None

    def read(self, n: int) -> np.ndarray:
        parts, have = [], 0
        while have < n:
            if len(self.pending) == 0:
                if self.eof:
                    parts.append(np.zeros((n - have, self.ch), np.float32))
                    break
                try:
                    self.pending = next(self.source)
                    self.length += len(self.pending)
                except StopIteration:
                    self.eof = True
                continue
            take = self.pending[: n - have]
            self.pending = self.pending[len(take):]
            parts.append(take)
            have += len(take)
        return np.concatenate(parts) if parts else np.zeros((0, self.ch), np.float32)


def scramble_stream(source: Iterator[np.ndarray], ch: int, plan: AudioPlan, opening_s: float,
                    write: Callable[[np.ndarray], None], rate: int = AUDIO_RATE,
                    batch_windows: int = 25, band_key: str | None = None, version: int = 3) -> int:
    """Brouille un flux de son (blocs float32 (n, ch)) et écrit le son publié.

    band_key : mélange aussi les bandes de fréquences (bands.py) :
      - version 2 : sur le signal virtuel, avant le mélange dans le temps ;
      - version 3 : sur le son publié, après le mélange dans le temps (décodable en direct).
    Renvoie le nombre d'échantillons écrits.
    """
    written = 0
    blocks = _scramble_blocks(source, ch, plan, opening_s, rate, batch_windows,
                              band_key if version == 2 else None)
    if band_key and version >= 3:
        from . import bands
        blocks = bands.process_stream(blocks, band_key, 0, False, ch, rate, tail=True,
                                      **bands.published_params(rate))
    for b in blocks:
        write(np.ascontiguousarray(b, dtype=np.float32))
        written += len(b)
    return written


def _scramble_blocks(source, ch, plan, opening_s, rate, batch_windows, band_key):
    """Générateur du son publié (mélange dans le temps ; bandes sur le virtuel si band_key)."""
    g = Geometry(rate)
    L, M, W = g.L, g.M, g.W
    delay = round((opening_s - OPENING_S) * rate)
    if band_key:
        from . import bands

        def virtual():
            yield np.zeros((delay, ch), np.float32)
            yield from source
        src = _Virtual(bands.process_stream(virtual(), band_key, 0, False, ch, rate, tail=True), 0, ch)
    else:
        src = _Virtual(source, delay, ch)

    pre = np.zeros((g.G, ch), np.float32)
    b = beep(rate)
    pre[: len(b)] += b[:, None]
    yield pre[: g.G - M]
    carry = np.zeros((2 * M, ch), np.float32)
    carry[:M] = pre[g.G - M:]
    buf = np.concatenate([np.zeros((M, ch), np.float32), src.read(M)])
    start = 0                                     # début du lot, en échantillons virtuels
    while True:
        seg = np.concatenate([buf, src.read(batch_windows * W)])
        y = _scramble_batch(seg, batch_windows, g, plan)
        y[: 2 * M] += carry
        buf = seg[-2 * M:]
        total = src.total
        if total is not None:
            nwin_total = max(1, math.ceil(total / W))
            remaining = nwin_total * W - start          # échantillons encore utiles dans ce lot
            if remaining <= batch_windows * W:
                yield y[: remaining + 2 * M]
                return
        yield y[: batch_windows * W]
        carry = y[batch_windows * W:]
        start += batch_windows * W
