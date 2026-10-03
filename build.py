"""Assemble le module audio et prépare les paquets de l'extension.

    python extension/build.py          → src/worklet.js, icônes, dist/*.zip
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def worklet():
    parts = []
    for name in ("brv-core.js", "dsp.js", "processor.js"):
        with open(os.path.join(HERE, "src", name), encoding="utf-8") as f:
            parts.append(f"// ---- {name}\n" + f.read())
    head = "/* Fichier généré par build.py (brv-core.js + dsp.js + processor.js) : ne pas modifier. */\n"
    with open(os.path.join(HERE, "src", "worklet.js"), "w", encoding="utf-8") as f:
        f.write(head + "\n".join(parts))


def icons():
    from PIL import Image, ImageDraw
    colors = ["#e8554e", "#f2b134", "#3aa6a0", "#4a6fd1", "#8e5ad6", "#2c2c2c"]
    order = [3, 0, 5, 2, 1, 4, 2, 5, 0, 4, 3, 1, 5, 1, 4, 0]
    os.makedirs(os.path.join(HERE, "icons"), exist_ok=True)
    for size in (16, 32, 48, 128):
        big = 512
        img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        cell = big / 4
        for i, c in enumerate(order):
            x, y = i % 4, i // 4
            d.rounded_rectangle([x * cell + 6, y * cell + 6, (x + 1) * cell - 6, (y + 1) * cell - 6],
                                radius=cell * 0.12, fill=colors[c])
        img.resize((size, size), Image.LANCZOS).save(os.path.join(HERE, "icons", f"icon{size}.png"))


def package():
    dist = os.path.join(HERE, "dist")
    os.makedirs(dist, exist_ok=True)
    files = ["manifest.json"]
    for folder in ("src", "lib", "popup", "icons"):
        for name in sorted(os.listdir(os.path.join(HERE, folder))):
            files.append(f"{folder}/{name}")
    out = os.path.join(dist, "debrouilleur-brv.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(os.path.join(HERE, f), f)
    return out


if __name__ == "__main__":
    worklet()
    icons()
    print(package())
