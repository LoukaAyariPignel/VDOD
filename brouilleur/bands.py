"""Brouillage des fréquences du son (format BRV2).

Le son est découpé par une MDCT (trames de 2N = 512 échantillons, pas N = 256, fenêtre
sinus) : c'est une transformée orthogonale, donc re-analyser le signal reconstruit
redonne exactement les mêmes coefficients, et le mélange se défait à l'échantillon près.

Seule la zone 0 – 3 kHz est touchée (32 coefficients = 8 bandes de 4 coefficients,
375 Hz chacune) : c'est la partie que même les versions de son les plus compressées de
YouTube codent finement. Essais (voir README) : jusqu'à 4,5 kHz, Opus à 48 kbit/s abîmait
nettement le son débrouillé ; à 3 kHz, il reste proche d'un son normal recompressé, et le
timbre est toujours méconnaissable. Au-dessus de 3 kHz, rien ne bouge.

Dans chaque fenêtre de 480 ms, les 8 bandes sont permutées selon une permutation tirée
de la clé et du numéro de fenêtre : la correspondance change deux fois par seconde. Les
bandes font un nombre pair de coefficients, donc chaque déplacement est un nombre pair de
coefficients, ce qui garde la cohérence de phase d'une trame à l'autre (un son stable
reste un son stable une fois déplacé).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Iterator

import numpy as np

from .core import AUDIO_RATE, GRID_TEXT, WINDOW_MS, Stream, fisher_yates

N = 256                     # pas de la MDCT (5,33 ms à 48 kHz)
BAND_BINS = 4               # coefficients par bande (375 Hz)
N_BANDS = 8                 # 8 × 375 Hz = 0 – 3 kHz


@lru_cache(None)
def _matrices(n: int = N):
    k = np.arange(n)
    t = np.arange(2 * n)
    win = np.sin(np.pi * (t + 0.5) / (2 * n))
    c = np.cos(np.pi / n * (t[:, None] + 0.5 + n / 2) * (k[None, :] + 0.5))
    analysis = (win[:, None] * c).astype(np.float32)          # (2n, n)
    synthesis = (np.float32(2.0 / n) * analysis.T).copy()      # (n, 2n)
    return analysis, synthesis


@lru_cache(4096)
def band_perm(key: str, window: int) -> tuple[int, ...]:
    """Bande originale placée dans chaque bande brouillée, pour la fenêtre donnée."""
    return tuple(fisher_yates(Stream(f"{key}:{GRID_TEXT}:BANDES:{window}"), N_BANDS))


def frames_per_window(rate: int = AUDIO_RATE) -> float:
    return WINDOW_MS / 1000 * rate / N


def _permute(coefs: np.ndarray, first_frame: int, key: str, inverse: bool, rate: int,
             win_origin: int = 0, first_center: int = N):
    """coefs : (trames, N, canaux), modifié sur place. La trame m (centrée sur m·N) appartient
    à la fenêtre floor((m·N − win_origin) / W) ; les trames centrées avant first_center ne
    sont jamais permutées."""
    W = round(WINDOW_MS / 1000 * rate)
    m = first_frame + np.arange(coefs.shape[0])
    win = np.floor_divide(m * N - win_origin, W)
    lim = N_BANDS * BAND_BINS
    win[m * N < first_center] = -1
    for w in np.unique(win):
        sel = win == w
        if w < 0:
            continue
        q = band_perm(key, int(w))
        block = coefs[sel, :lim].reshape(sel.sum(), N_BANDS, BAND_BINS, -1)
        out = np.empty_like(block)
        if inverse:
            out[:, list(q)] = block
        else:
            out[:] = block[:, list(q)]
        coefs[sel, :lim] = out.reshape(sel.sum(), lim, -1)


def process_stream(source: Iterator[np.ndarray], key: str, start: int, inverse: bool,
                   ch: int, rate: int = AUDIO_RATE, block: int = 256 * N,
                   tail: bool = False, win_origin: int = 0, first_center: int = N) -> Iterator[np.ndarray]:
    """Applique le mélange de bandes (ou son inverse) à un flux de son.

    start : indice absolu (temps « virtuel » de SPEC.md) du premier échantillon du flux.
    La sortie a la même longueur et le même alignement que l'entrée. Ce qui précède start
    est traité comme du silence : les N premiers échantillons produits ne sont donc exacts
    que si start ≤ 0 (l'appelant démarre un peu plus tôt et jette le début sinon).

    tail : prolonge la sortie de N échantillons après la fin de l'entrée (la dernière trame
    déborde : l'encodeur garde ce débordement pour que le décodage soit exact jusqu'au bout).

    La trame m couvre les indices [(m−1)·N, (m+1)·N) ; les échantillons [j·N, (j+1)·N) sont
    complets une fois les trames j et j+1 ajoutées.
    """
    A, S = _matrices()
    origin = (start // N) * N - N              # aligné sur la grille, avec une trame de contexte
    buf = np.zeros((start - origin, ch), np.float32)
    acc = np.zeros((start - origin, ch), np.float32)
    total = 0
    eof = False
    src = iter(source)
    while not eof:
        while len(buf) < block + 2 * N:
            try:
                b = np.asarray(next(src), np.float32)
            except StopIteration:
                eof = True
                break
            if b.size:
                first = origin + len(buf)
                if first < 0:                     # indices négatifs : silence par définition
                    b = b.copy()
                    b[: min(len(b), -first)] = 0
                buf = np.concatenate([buf, b])
                acc = np.concatenate([acc, np.zeros_like(b)])
                total += len(b)
        if eof:
            pad = (-len(buf)) % N + 3 * N
            buf = np.concatenate([buf, np.zeros((pad, ch), np.float32)])
            acc = np.concatenate([acc, np.zeros((pad, ch), np.float32)])
        usable = (len(buf) // N) * N
        nfr = usable // N - 1
        if nfr <= 0:
            continue
        halves = buf[: (nfr + 1) * N].reshape(nfr + 1, N, ch)
        frames = np.concatenate([halves[:-1], halves[1:]], axis=1)       # (trames, 2N, canaux)
        coefs = np.matmul(A.T, frames)                                    # (trames, N, canaux)
        _permute(coefs, origin // N + 1, key, inverse, rate, win_origin, first_center)
        y = np.matmul(S.T, coefs)                                         # (trames, 2N, canaux)
        acc[: nfr * N] += y[:, :N].reshape(nfr * N, ch)
        acc[N: (nfr + 1) * N] += y[:, N:].reshape(nfr * N, ch)
        done_end = origin + nfr * N                          # indices complets : [origin, done_end)
        lo = max(origin, start)
        hi = min(done_end, start + total + (N if tail else 0)) if eof else done_end
        if hi > lo:
            yield acc[lo - origin: hi - origin].astype(np.float32)
        keep = nfr * N
        buf, acc = buf[keep:], acc[keep:]
        origin += keep


def published_params(rate: int = AUDIO_RATE) -> dict:
    """Réglages BRV3 : mélange appliqué au son publié, à partir de la grille (le bip reste intact)."""
    from .audio import Geometry
    g = Geometry(rate)
    return {"win_origin": g.G, "first_center": g.G - g.M + N}
