"""Regenerates the README screenshots in media/readme from the current screen.

    python3 tools/screenshots/make.py

Needs Playwright for Python and Pillow (pip install playwright pillow; python -m playwright
install chromium), or CHROME=/path/to/chrome. how-it-works.png is a diagram and isn't regenerated.
"""
import os, subprocess, sys, pathlib, tempfile
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = pathlib.Path(os.environ.get('SHOTS_OUT') or os.path.join(tempfile.gettempdir(), 'permission-studio-shots'))  # the same as the scripts'
SHOTS = [('shoot.py', [('overview', 'overview'), ('editing', 'editing'), ('groups', 'groups'), ('light-theme', 'light-theme')]),
         ('readme_shots.py', [('readme-1-review', 'review'), ('readme-2-find-access', 'find-access'), ('readme-3-grant-fields', 'grant-field-access'),
                              ('readme-4-grant-object', 'grant-object-access'), ('readme-5-history', 'history')]),
         ('readme23.py', [('r23-1-muting', 'muting'), ('r23-3-user-access', 'user-access'), ('r23-4-compare', 'compare')]),
         ('shots24.py', [('r24-1-health', 'health-check')])]
def main():
    from PIL import Image
    for script, pairs in SHOTS:
        for src, _ in pairs: (OUT / (src + '.png')).unlink(missing_ok=True)
        r = subprocess.run([sys.executable, script], cwd=HERE, capture_output=True, text=True, timeout=600)
        missing = [src for src, _ in pairs if not (OUT / (src + '.png')).exists()]
        if missing: sys.exit(script + ' made no ' + ', '.join(missing) + '\n' + r.stdout[-1500:] + r.stderr[-1500:])
        for src, dst in pairs:
            im = Image.open(OUT / (src + '.png')).convert('RGB')
            im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
            im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(ROOT / 'media' / 'readme' / (dst + '.png'), optimize=True)
            print('media/readme/' + dst + '.png')
if __name__ == '__main__':
    main()
