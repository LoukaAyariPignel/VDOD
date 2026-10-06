"""Géométrie du brouillage d'image.

Deux implémentations de la même transformation :
- un noyau OpenCL, exécuté par ffmpeg (filtre program_opencl) pendant l'encodage ;
- une version numpy de référence, pour l'aperçu et la vérification
  (c'est aussi le modèle que suit le shader de l'extension).

Convention (coordonnées normalisées dans l'image 16:9, voir SPEC.md) :
le bloc brouillé c = (cx, cy) contient le bloc original s = perm[c].
Pour un point (u, v) ∈ [0,1]² du bloc brouillé :
    u' = clamp((u - m) / (1 - 2m), 0, 1)     (marge : bord prolongé)
    si FLIP_H : u' = 1 - u'     si FLIP_V : v' = 1 - v'
    point source = ((sx + u') / GX, (sy + v') / GY)
    si NEGATIVE : valeur = 1 - valeur (en RGB)
"""

from __future__ import annotations

import numpy as np

from .core import (BLOCK_MARGIN, FLIP_H, FLIP_V, GRID_X, GRID_Y, NEGATIVE,
                   VideoPlan)


def content_rect(src_w: int, src_h: int, sar: float = 1.0) -> tuple[float, float, float, float]:
    """Rectangle (x, y, w, h), normalisé, occupé par l'image source dans le cadre 16:9."""
    dar = src_w * sar / src_h
    target = 16 / 9
    if dar > target:           # plus large : bandes en haut et en bas
        h = target / dar
        return 0.0, (1 - h) / 2, 1.0, h
    w = dar / target
    return (1 - w) / 2, 0.0, w, 1.0


# ---------------------------------------------------------------- OpenCL

KERNEL_TEMPLATE = r"""
// Genere par brouilleur.geometry - format BRV1
#define GX {gx}
#define GY {gy}
#define MARGIN {margin:.8f}f
#define RX {rx:.8f}f
#define RY {ry:.8f}f
#define RW {rw:.8f}f
#define RH {rh:.8f}f

__constant ushort TAB[{n}] = {{ {table} }};

__kernel void scramble(__write_only image2d_t dst, unsigned int index,
                       __read_only image2d_t src)
{{
    const sampler_t smp = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE
                        | CLK_FILTER_LINEAR;
    int2 loc = (int2)(get_global_id(0), get_global_id(1));
    int2 dd = get_image_dim(dst);
    int2 sd = get_image_dim(src);
    if (loc.x >= dd.x || loc.y >= dd.y) return;
    bool luma = get_image_channel_order(dst) == CLK_R;

    float gx = (loc.x + 0.5f) / dd.x * GX;
    float gy = (loc.y + 0.5f) / dd.y * GY;
    int cx = min((int)gx, GX - 1);
    int cy = min((int)gy, GY - 1);
    float u = clamp((gx - cx - MARGIN) / (1.0f - 2.0f * MARGIN), 0.0f, 1.0f);
    float v = clamp((gy - cy - MARGIN) / (1.0f - 2.0f * MARGIN), 0.0f, 1.0f);

    uint e = TAB[cy * GX + cx];
    uint s = e & 1023u;
    uint t = e >> 10;
    if (t & 1u) u = 1.0f - u;
    if (t & 2u) v = 1.0f - v;
    float fx = ((s % GX) + u) / GX;
    float fy = ((s / GX) + v) / GY;

    float4 val;
    float rx = (fx - RX) / RW;
    float ry = (fy - RY) / RH;
    if (rx < 0.0f || rx > 1.0f || ry < 0.0f || ry > 1.0f) {{
        val = luma ? (float4)(16.0f / 255.0f, 0.0f, 0.0f, 1.0f)
                   : (float4)(128.0f / 255.0f, 128.0f / 255.0f, 0.0f, 1.0f);
    }} else {{
        val = read_imagef(src, smp, (float2)(rx * sd.x, ry * sd.y));
    }}
    if (t & 4u) {{
        // negatif RGB exprime en YUV limite : Y -> 251 - Y, U,V -> 256 - U,V
        if (luma) val.x = 251.0f / 255.0f - val.x;
        else {{ val.x = 256.0f / 255.0f - val.x; val.y = 256.0f / 255.0f - val.y; }}
        val = clamp(val, 0.0f, 1.0f);
    }}
    write_imagef(dst, loc, val);
}}
"""


def opencl_kernel(plan: VideoPlan, rect: tuple[float, float, float, float]) -> str:
    table = ", ".join(str(p | (f << 10)) for p, f in zip(plan.perm, plan.flags))
    rx, ry, rw, rh = rect
    return KERNEL_TEMPLATE.format(gx=GRID_X, gy=GRID_Y, margin=BLOCK_MARGIN,
                                  rx=rx, ry=ry, rw=rw, rh=rh,
                                  n=len(plan.perm), table=table)


# ---------------------------------------------------------------- numpy (référence)

def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Échantillonne img (H, W, C) aux coordonnées continues (x, y) en pixels, centre = +0,5."""
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1)
    y = np.clip(y - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    ax = (x - x0)[..., None]
    ay = (y - y0)[..., None]
    f = img.astype(np.float32)
    top = f[y0, x0] * (1 - ax) + f[y0, x1] * ax
    bot = f[y1, x0] * (1 - ax) + f[y1, x1] * ax
    return top * (1 - ay) + bot * ay


def _flag_arrays(plan: VideoPlan):
    perm = np.array(plan.perm, dtype=np.int32)
    flags = np.array(plan.flags, dtype=np.int32)
    return perm, flags


def fit_16_9(rgb: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """Met une image RGB en 16:9 exact (bandes noires), à la taille de sortie."""
    h, w = rgb.shape[:2]
    rx, ry, rw, rh = content_rect(w, h)
    ys, xs = np.mgrid[0:out_h, 0:out_w].astype(np.float32)
    fx = (xs + 0.5) / out_w
    fy = (ys + 0.5) / out_h
    rxn = (fx - rx) / rw
    ryn = (fy - ry) / rh
    out = _bilinear(rgb, rxn * w, ryn * h)
    outside = (rxn < 0) | (rxn > 1) | (ryn < 0) | (ryn > 1)
    out[outside] = 0
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def scramble_rgb(frame: np.ndarray, plan: VideoPlan) -> np.ndarray:
    """Brouille une image RGB déjà en 16:9 (référence de l'encodeur)."""
    h, w = frame.shape[:2]
    perm, flags = _flag_arrays(plan)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    gx = (xs + 0.5) / w * GRID_X
    gy = (ys + 0.5) / h * GRID_Y
    cx = np.minimum(gx.astype(np.int32), GRID_X - 1)
    cy = np.minimum(gy.astype(np.int32), GRID_Y - 1)
    m = BLOCK_MARGIN
    u = np.clip((gx - cx - m) / (1 - 2 * m), 0, 1)
    v = np.clip((gy - cy - m) / (1 - 2 * m), 0, 1)
    c = cy * GRID_X + cx
    s = perm[c]
    t = flags[c]
    u = np.where(t & FLIP_H, 1 - u, u)
    v = np.where(t & FLIP_V, 1 - v, v)
    sx = (s % GRID_X + u) / GRID_X * w
    sy = (s // GRID_X + v) / GRID_Y * h
    out = _bilinear(frame, sx, sy)
    neg = (t & NEGATIVE).astype(bool)
    out[neg] = 255 - out[neg]
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def descramble_rgb(frame: np.ndarray, plan: VideoPlan, out_w: int | None = None,
                   out_h: int | None = None) -> np.ndarray:
    """Débrouille une image RGB brouillée, de n'importe quelle résolution (modèle de l'extension)."""
    h, w = frame.shape[:2]
    out_w = out_w or w
    out_h = out_h or h
    perm, flags = _flag_arrays(plan)
    inv = np.empty_like(perm)
    inv[perm] = np.arange(len(perm), dtype=np.int32)
    ys, xs = np.mgrid[0:out_h, 0:out_w].astype(np.float32)
    gx = (xs + 0.5) / out_w * GRID_X
    gy = (ys + 0.5) / out_h * GRID_Y
    sx = np.minimum(gx.astype(np.int32), GRID_X - 1)
    sy = np.minimum(gy.astype(np.int32), GRID_Y - 1)
    u = gx - sx
    v = gy - sy
    c = inv[sy * GRID_X + sx]
    t = flags[c]
    u = np.where(t & FLIP_H, 1 - u, u)
    v = np.where(t & FLIP_V, 1 - v, v)
    m = BLOCK_MARGIN
    u = m + u * (1 - 2 * m)
    v = m + v * (1 - 2 * m)
    px = (c % GRID_X + u) / GRID_X * w
    py = (c // GRID_X + v) / GRID_Y * h
    out = _bilinear(frame, px, py)
    neg = (t & NEGATIVE).astype(bool)
    out[neg] = 255 - out[neg]
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def decode_table(plan: VideoPlan) -> np.ndarray:
    """Table du décodeur (texture 32×18 RGBA) : pour le bloc affiché s, (c mod 32, c div 32, flags, 255)."""
    perm, flags = _flag_arrays(plan)
    inv = np.empty_like(perm)
    inv[perm] = np.arange(len(perm), dtype=np.int32)
    t = np.zeros((GRID_Y, GRID_X, 4), np.uint8)
    t[..., 0] = (inv % GRID_X).reshape(GRID_Y, GRID_X)
    t[..., 1] = (inv // GRID_X).reshape(GRID_Y, GRID_X)
    t[..., 2] = flags[inv].reshape(GRID_Y, GRID_X)
    t[..., 3] = 255
    return t


UNSCRAMBLE_KERNEL = r"""
// Genere par brouilleur.geometry - decodage BRV1
#define GX {gx}
#define GY {gy}
#define MARGIN {margin:.8f}f

__constant ushort TAB[{n}] = {{ {table} }};

__kernel void unscramble(__write_only image2d_t dst, unsigned int index,
                         __read_only image2d_t src)
{{
    const sampler_t smp = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE
                        | CLK_FILTER_LINEAR;
    int2 loc = (int2)(get_global_id(0), get_global_id(1));
    int2 dd = get_image_dim(dst);
    int2 sd = get_image_dim(src);
    if (loc.x >= dd.x || loc.y >= dd.y) return;
    bool luma = get_image_channel_order(dst) == CLK_R;

    float gx = (loc.x + 0.5f) / dd.x * GX;
    float gy = (loc.y + 0.5f) / dd.y * GY;
    int sx = min((int)gx, GX - 1);
    int sy = min((int)gy, GY - 1);
    float u = gx - sx;
    float v = gy - sy;
    uint e = TAB[sy * GX + sx];
    uint c = e & 1023u;
    uint t = e >> 10;
    if (t & 1u) u = 1.0f - u;
    if (t & 2u) v = 1.0f - v;
    u = MARGIN + u * (1.0f - 2.0f * MARGIN);
    v = MARGIN + v * (1.0f - 2.0f * MARGIN);
    float px = ((c % GX) + u) / GX * sd.x;
    float py = ((c / GX) + v) / GY * sd.y;
    float4 val = read_imagef(src, smp, (float2)(px, py));
    if (t & 4u) {{
        if (luma) val.x = 251.0f / 255.0f - val.x;
        else {{ val.x = 256.0f / 255.0f - val.x; val.y = 256.0f / 255.0f - val.y; }}
        val = clamp(val, 0.0f, 1.0f);
    }}
    write_imagef(dst, loc, val);
}}
"""


def opencl_unscramble_kernel(plan: VideoPlan) -> str:
    perm, flags = _flag_arrays(plan)
    inv = np.empty_like(perm)
    inv[perm] = np.arange(len(perm), dtype=np.int32)
    table = ", ".join(str(int(c) | (int(flags[c]) << 10)) for c in inv)
    return UNSCRAMBLE_KERNEL.format(gx=GRID_X, gy=GRID_Y, margin=BLOCK_MARGIN, n=len(perm), table=table)


def write_unscramble_maps(plan: VideoPlan, w: int, h: int, xpath: str, ypath: str):
    """Cartes remap du décodage sans carte graphique (source : [brouillée | négatif], largeur 2w)."""
    perm, flags = _flag_arrays(plan)
    inv = np.empty_like(perm)
    inv[perm] = np.arange(len(perm), dtype=np.int32)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    gx = (xs + 0.5) / w * GRID_X
    gy = (ys + 0.5) / h * GRID_Y
    sx = np.minimum(gx.astype(np.int32), GRID_X - 1)
    sy = np.minimum(gy.astype(np.int32), GRID_Y - 1)
    u, v = gx - sx, gy - sy
    c = inv[sy * GRID_X + sx]
    t = flags[c]
    u = np.where(t & FLIP_H, 1 - u, u)
    v = np.where(t & FLIP_V, 1 - v, v)
    m = BLOCK_MARGIN
    u = m + u * (1 - 2 * m)
    v = m + v * (1 - 2 * m)
    px = np.clip(np.floor((c % GRID_X + u) / GRID_X * w), 0, w - 1) + np.where(t & NEGATIVE, w, 0)
    py = np.clip(np.floor((c // GRID_X + v) / GRID_Y * h), 0, h - 1)
    _write_pgm16(xpath, px, w, h)
    _write_pgm16(ypath, py, w, h)


def _write_pgm16(path: str, arr: np.ndarray, w: int, h: int):
    with open(path, "wb") as f:
        f.write(f"P5\n{w} {h}\n65535\n".encode("ascii"))
        f.write(arr.astype(">u2").tobytes())


def write_remap_maps(plan: VideoPlan, w: int, h: int, xpath: str, ypath: str):
    """Cartes du filtre remap d'ffmpeg (brouillage sans carte graphique).

    La source est l'image doublée [originale | négatif] (largeur 2w) : les blocs à inverser
    lisent simplement dans la moitié droite.
    """
    perm, flags = _flag_arrays(plan)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    gx = (xs + 0.5) / w * GRID_X
    gy = (ys + 0.5) / h * GRID_Y
    cx = np.minimum(gx.astype(np.int32), GRID_X - 1)
    cy = np.minimum(gy.astype(np.int32), GRID_Y - 1)
    m = BLOCK_MARGIN
    u = np.clip((gx - cx - m) / (1 - 2 * m), 0, 1)
    v = np.clip((gy - cy - m) / (1 - 2 * m), 0, 1)
    c = cy * GRID_X + cx
    s = perm[c]
    t = flags[c]
    u = np.where(t & FLIP_H, 1 - u, u)
    v = np.where(t & FLIP_V, 1 - v, v)
    px = np.clip(np.floor((s % GRID_X + u) / GRID_X * w), 0, w - 1)
    py = np.clip(np.floor((s // GRID_X + v) / GRID_Y * h), 0, h - 1)
    px = px + np.where(t & NEGATIVE, w, 0)
    for path, arr in ((xpath, px), (ypath, py)):
        with open(path, "wb") as f:
            f.write(f"P5\n{w} {h}\n65535\n".encode("ascii"))
            f.write(arr.astype(">u2").tobytes())


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    d = a.astype(np.float32) - b.astype(np.float32)
    mse = float(np.mean(d * d))
    if mse <= 1e-9:
        return 99.0
    return 10 * np.log10(255 * 255 / mse)
