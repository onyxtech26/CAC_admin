"""Install the two team-member portraits into public/assets.

The contact-page cards crop their photo into a 96px circle, so this centre-crops
each source image to a square and writes it at the exact path the site expects.
Source images can be any size, any format, any filename.

    python scripts/install_team_photos.py <photo-for-card-2> <photo-for-card-3>

e.g. python scripts/install_team_photos.py ~/Downloads/blonde.jpg ~/Downloads/moustache.jpg
"""

import sys
from pathlib import Path

from PIL import Image

# Card 2 is the blonde flat-top / navy tie; card 3 is the moustache / dotted tie.
TARGETS = ["public/assets/team-02.png", "public/assets/team-03.png"]
SIZE = 800
# Portraits frame the face high, so bias the square crop towards the top.
TOP_BIAS = 0.30


def install(src: Path, dest: Path) -> None:
    im = Image.open(src).convert("RGB")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = int((h - side) * TOP_BIAS)
    im = im.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "PNG")
    print(f"{src.name} ({w}x{h}) -> {dest} ({SIZE}x{SIZE})")


def main() -> int:
    args = sys.argv[1:]
    if len(args) != 2:
        print(__doc__)
        return 1
    root = Path(__file__).resolve().parent.parent
    for arg, target in zip(args, TARGETS):
        src = Path(arg).expanduser()
        if not src.is_file():
            print(f"error: no such file: {src}")
            return 1
        install(src, root / target)
    print("\nDone. Refresh the contact page - no restart needed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
