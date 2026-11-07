"""Screenshots in 256 colours (AFD-118): the guide's PNGs are most of the VSIX, and a UI screenshot
looks the same with a 256-colour palette at about 40 % of the size. Rewrites each file given only
when that makes it smaller. Needs Pillow; `just docs-shots` runs it after each shot.

    python scripts/quantize-png.py docs/guide/images/*.png
"""

import io
import sys

from PIL import Image


def quantize(path: str) -> tuple[int, int]:
    with open(path, "rb") as f:
        raw = f.read()
    image = Image.open(io.BytesIO(raw))
    # Already a palette: done before.
    if image.mode == "P":
        return len(raw), len(raw)
    q = image.convert("RGB").quantize(
        colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    out = io.BytesIO()
    q.save(out, "PNG", optimize=True)
    if len(out.getvalue()) < len(raw):
        with open(path, "wb") as f:
            f.write(out.getvalue())
        return len(raw), len(out.getvalue())
    return len(raw), len(raw)


if __name__ == "__main__":
    before = after = 0
    for p in sys.argv[1:]:
        b, a = quantize(p)
        before += b
        after += a
    print(f"{len(sys.argv) - 1} file(s): {before // 1024} KB -> {after // 1024} KB")
