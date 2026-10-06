"""Ouverture ajoutée avant la vidéo : image(s) du QR code puis noir."""

from __future__ import annotations

import numpy as np
import segno

from .core import qr_payload

QR_HEIGHT = 0.90


def qr_matrix(key: str) -> np.ndarray:
    """Matrice du QR code (True = module noir), mode alphanumérique, correction H, sans marge."""
    q = segno.make_qr(qr_payload(key), error="h", mode="alphanumeric", boost_error=False)
    m = np.array([[bool(c) for c in row] for row in q.matrix], dtype=bool)
    return m


def qr_luma(key: str, w: int, h: int, black: int = 16, white: int = 235) -> np.ndarray:
    """Plan de luminance w×h : QR code centré sur 90 % de la hauteur, fond blanc."""
    m = qr_matrix(key)
    n = m.shape[0]
    mod = max(1, int(QR_HEIGHT * h) // n)
    size = mod * n
    img = np.full((h, w), white, np.uint8)
    big = np.kron(m, np.ones((mod, mod), dtype=bool))
    y0 = (h - size) // 2
    x0 = (w - size) // 2
    region = img[y0:y0 + size, x0:x0 + size]
    region[big] = black
    return img


def qr_rgb(key: str, w: int, h: int) -> np.ndarray:
    y = qr_luma(key, w, h, 0, 255)
    return np.repeat(y[:, :, None], 3, axis=2)


def opening_nv12(key: str, w: int, h: int, n_qr: int, n_total: int):
    """Génère les images NV12 de l'ouverture (n_qr images de QR, puis du noir)."""
    chroma = np.full((h // 2) * w, 128, np.uint8).tobytes()
    qr = qr_luma(key, w, h).tobytes() + chroma
    black = np.full(w * h, 16, np.uint8).tobytes() + chroma
    for i in range(n_total):
        yield qr if i < n_qr else black
