"""Cœur du format BRV1 : clé, flux pseudo-aléatoire, permutations et géométrie.

Tout ce qui est ici doit être reproduit à l'identique par l'extension
(voir SPEC.md). Ne rien changer sans changer la version du format.
"""

from __future__ import annotations

import hashlib
import secrets
import struct
from dataclasses import dataclass

FORMAT_ID = "BRV4"          # BRV4 = son brouillé dans le domaine MDCT (débrouillage exact)
FORMAT_VERSION = 4

# Image
GRID_X = 32
GRID_Y = 18
GRID_TEXT = f"{GRID_X}X{GRID_Y}"
N_BLOCKS = GRID_X * GRID_Y
BLOCK_MARGIN = 0.06          # fraction de la taille d'un bloc, de chaque côté

# Flags de transformation d'un bloc
FLIP_H = 1
FLIP_V = 2
NEGATIVE = 4

# Son
AUDIO_RATE = 48000
CHUNK_MS = 60
WINDOW_CHUNKS = 8
WINDOW_MS = CHUNK_MS * WINDOW_CHUNKS     # 480 ms
MARGIN_MS = 4
OPENING_S = 0.6                           # durée minimale de l'ouverture
GRID_START_S = OPENING_S - WINDOW_MS / 1000   # 0,12 s : début de la 1re fenêtre
BEEP_MS = 50
BEEP_F0 = 500.0
BEEP_F1 = 5000.0
BEEP_AMPLITUDE = 0.5

KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
KEY_LENGTH = 8


def generate_key() -> str:
    return "".join(secrets.choice(KEY_ALPHABET) for _ in range(KEY_LENGTH))


def normalize_key(key: str) -> str:
    """Met la clé au format attendu ou lève ValueError."""
    k = key.strip().upper()
    if not 4 <= len(k) <= 16:
        raise ValueError("La clé doit contenir entre 4 et 16 caractères.")
    bad = sorted({c for c in k if c not in KEY_ALPHABET})
    if bad:
        raise ValueError("Caractères non autorisés dans la clé : " + " ".join(bad)
                         + " (lettres A–Z et chiffres uniquement).")
    return k


def qr_payload(key: str) -> str:
    return f"{FORMAT_ID}:{GRID_TEXT}:{key}"


class Stream:
    """Flux d'entiers 32 bits : SHA-256(« graine:0 »), SHA-256(« graine:1 »)…"""

    def __init__(self, seed: str):
        self.seed = seed
        self.counter = 0
        self.buf: list[int] = []

    def next(self) -> int:
        if not self.buf:
            digest = hashlib.sha256(f"{self.seed}:{self.counter}".encode("ascii")).digest()
            self.counter += 1
            self.buf = list(struct.unpack(">8I", digest))
        return self.buf.pop(0)


def fisher_yates(stream: Stream, n: int) -> list[int]:
    p = list(range(n))
    for i in range(n - 1, 0, -1):
        j = stream.next() % (i + 1)
        p[i], p[j] = p[j], p[i]
    return p


@dataclass(frozen=True)
class VideoPlan:
    """perm[c] = bloc original contenu dans le bloc brouillé c ; flags[c] = transformations."""
    perm: tuple[int, ...]
    flags: tuple[int, ...]

    @property
    def inverse(self) -> tuple[int, ...]:
        inv = [0] * len(self.perm)
        for c, s in enumerate(self.perm):
            inv[s] = c
        return tuple(inv)


@dataclass(frozen=True)
class AudioPlan:
    """order[i] = morceau original placé à la position i de la fenêtre ; reverse[i] = joué à l'envers."""
    order: tuple[int, ...]
    reverse: tuple[bool, ...]


def video_plan(key: str) -> VideoPlan:
    s = Stream(f"{key}:{GRID_TEXT}")
    perm = fisher_yates(s, N_BLOCKS)
    flags = []
    for _ in range(N_BLOCKS):
        flags.append(s.next() & 7)   # bits 0-1 : retournement, bit 2 : négatif
    return VideoPlan(tuple(perm), tuple(flags))


def audio_plan(key: str) -> AudioPlan:
    s = Stream(f"{key}:{GRID_TEXT}:SON")
    order = fisher_yates(s, WINDOW_CHUNKS)
    reverse = tuple(bool(s.next() & 1) for _ in range(WINDOW_CHUNKS))
    return AudioPlan(tuple(order), reverse)


def opening_frames(fps: float) -> int:
    """Nombre d'images de l'ouverture : au moins 0,6 s, arrondi à l'image supérieure."""
    import math
    return max(1, math.ceil(OPENING_S * fps - 1e-6))


# Résolutions de sortie (16:9 exact)
RESOLUTIONS = {
    1080: (1920, 1080),
    1440: (2560, 1440),
    2160: (3840, 2160),
}
BITRATES_MBPS = {1080: 16, 1440: 30, 2160: 60}
AUDIO_MBPS = 0.33          # son AAC (320 kbit/s en stéréo) et conteneur
MIN_MBPS = 4               # en dessous, les jointures des blocs s'abîment dès l'envoi


def video_mbps(res: int, duration: float, max_bytes: float | None = None) -> float:
    """Débit de l'image : celui de la résolution, réduit si besoin pour ne pas dépasser max_bytes."""
    base = BITRATES_MBPS[res]
    if not max_bytes:
        return base
    fit = max_bytes * 8 / (duration + 1) / 1e6 - AUDIO_MBPS
    return round(max(MIN_MBPS, min(base, fit)), 2)
