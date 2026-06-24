#!/usr/bin/env python3
"""Génère un asset PixelReveal (format CLAUDE.md §5.1) depuis une image source.

Pipeline déterministe (cf. §5.2) :
    open → flatten sur fond noir → resize NEAREST(W,H) → quantize(N) → extraction index+palette

Sortie : un JSON { id, width, height, palette, answer } où `answer[i]` est l'index palette
(row-major) de la vraie couleur du pixel i. La palette est compacte (0..k-1), garantie ≤ 255
couleurs pour laisser 0xFF comme sentinelle « non révélé » côté runtime.

Exemple :
    python tools/pixelize.py source.png --size 300 --colors 32 --out assets/artwork-001.json
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def parse_size(raw: str) -> tuple[int, int]:
    """`300` → (300, 300) ; `400x250` → (400, 250). Côté entre 250 et 500 (cf. §5.1)."""
    if "x" in raw.lower():
        w, h = raw.lower().split("x", 1)
        return int(w), int(h)
    n = int(raw)
    return n, n


def pixelize(src: Path, width: int, height: int, colors: int) -> tuple[list[str], list[int]]:
    img = Image.open(src)

    # Aplatir l'alpha sur fond noir : le fond « non révélé » est noir, autant aligner dessus.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (0, 0, 0))
        bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = bg
    else:
        img = img.convert("RGB")

    # NEAREST : on veut des blocs francs, pas d'interpolation qui inventerait des couleurs.
    img = img.resize((width, height), Image.Resampling.NEAREST)
    # quantize réduit à <= `colors` couleurs et passe l'image en mode palette (P).
    img = img.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)

    indices = list(img.getdata())  # row-major, un index palette par pixel

    # quantize réserve 256 slots mais n'en utilise qu'une partie. On compacte les index
    # réellement présents en 0..k-1 pour une palette serrée et un octet par pixel.
    used = sorted(set(indices))
    if len(used) > 255:
        sys.exit(f"Erreur : {len(used)} couleurs > 255 (0xFF réservé). Baisse --colors.")

    remap = {old: new for new, old in enumerate(used)}
    flat = img.getpalette()  # [r,g,b, r,g,b, ...] indexé par l'ancien index
    palette = [
        "#{:02x}{:02x}{:02x}".format(flat[old * 3], flat[old * 3 + 1], flat[old * 3 + 2])
        for old in used
    ]
    answer = [remap[i] for i in indices]
    return palette, answer


def main() -> None:
    ap = argparse.ArgumentParser(description="Pixellise une image en asset PixelReveal.")
    ap.add_argument("source", type=Path, help="image source (png, jpg, ...)")
    ap.add_argument("--size", default="300", help="taille cible : '300' ou '400x250'")
    ap.add_argument("--colors", type=int, default=32, help="nombre max de couleurs (<= 255)")
    ap.add_argument("--out", type=Path, required=True, help="chemin du JSON de sortie")
    ap.add_argument("--id", help="id de l'artwork (défaut : nom du fichier de sortie)")
    ap.add_argument(
        "--preview-scale", type=int, default=2,
        help="facteur d'agrandissement du PNG de preview (NEAREST). 0 = pas de preview",
    )
    args = ap.parse_args()

    width, height = parse_size(args.size)
    artwork_id = args.id or args.out.stem
    palette, answer = pixelize(args.source, width, height, args.colors)

    asset = {
        "id": artwork_id,
        "width": width,
        "height": height,
        "palette": palette,
        "answer": answer,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # separators compacts : answer = width*height entiers, autant ne pas gonfler le fichier.
    args.out.write_text(json.dumps(asset, separators=(",", ":")), encoding="utf-8")
    print(f"{artwork_id} : {width}x{height}, {len(palette)} couleurs -> {args.out}")

    # Preview PNG figée à côté de l'asset : référence visuelle versionnée de l'image cible
    # (l'image complète n'est jamais servie au client, mais on la garde côté repo pour relecture).
    if args.preview_scale > 0:
        write_preview(palette, answer, width, height, args.out, args.preview_scale)


def write_preview(
    palette: list[str], answer: list[int], width: int, height: int, out: Path, scale: int
) -> None:
    rgb = [tuple(int(c[i : i + 2], 16) for i in (1, 3, 5)) for c in palette]
    img = Image.new("RGB", (width, height))
    img.putdata([rgb[i] for i in answer])
    img = img.resize((width * scale, height * scale), Image.Resampling.NEAREST)
    preview = out.with_suffix(".preview.png")
    img.save(preview)
    print(f"preview -> {preview}")


if __name__ == "__main__":
    main()
