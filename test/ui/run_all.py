"""Runs every browser test against the real media/app.js and media/app.css.

    python3 test/ui/run_all.py            all of them
    python3 test/ui/run_all.py run16 run17 just these

Needs Playwright for Python (pip install playwright, then python -m playwright install chromium),
or CHROME=/path/to/chrome. Exits non-zero if any check fails. Screenshots go to UI_OUT
(default: a permission-studio-ui folder in the system temp folder).
"""
import os, re, subprocess, sys, time, pathlib
HERE = pathlib.Path(__file__).resolve().parent
TESTS = [
    ('run.py', 'Basics: lists, a permission set, editing, the review, light and dark themes'),
    ('run2.py', 'Objects, fields and record types'),
    ('run3.py', 'Find access'),
    ('run4.py', 'History: filters, selection, copy and export'),
    ('run5.py', 'Grant field access'),
    ('run7.py', 'Grant object access'),
    ('run8.py', 'Assignments and groups'),
    ('run9.py', 'Narrow windows (under 900 px)'),
    ('run10.py', 'Keyboard, focus and dialogs'),
    ('run11.py', 'QA charters: saving, production confirm, errors'),
    ('run12.py', '2.3 features: muting, profile settings, user access, compare, policies, licences, loading'),
    ('run13.py', 'Layout audit at four laptop sizes, collapse controls, list tabs'),
    ('run14.py', 'Health check: findings, fixes, export'),
    ('run15.py', 'Design check: one style for tags, checkboxes, radios, tables, containers, buttons'),
    ('run16.py', 'Controls and the Health page with an org-sized dataset'),
    ('run17.py', 'Every scrolling box keeps its place when the screen redraws'),
    ('run18.py', 'Big saves and big History entries: progress, chips 300 at a time, export by save'),
]
def passed(out):
    last = [l for l in out.strip().splitlines() if l.strip()][-1:] or ['']
    last = last[0]
    m = re.search(r'SUMMARY (\d+) of (\d+) passed; page errors: \[\]', last)
    if m: return m.group(1) == m.group(2)
    return bool(re.search(r'\bok\b.*errors: \[\]$', last))
def main():
    pick = sys.argv[1:]
    todo = [t for t in TESTS if not pick or t[0][:-3] in pick or t[0] in pick]
    failed = []
    for name, what in todo:
        t0 = time.time()
        r = subprocess.run([sys.executable, name], cwd=HERE, capture_output=True, text=True, timeout=600)
        ok = r.returncode == 0 and passed(r.stdout)
        last = ([l for l in r.stdout.strip().splitlines() if l.strip()] or [''])[-1]
        print(('PASS ' if ok else 'FAIL ') + name.ljust(9) + ' %5.1fs  ' % (time.time() - t0) + what + ('' if ok else '\n     ' + (last or r.stderr.strip().splitlines()[-1:] and r.stderr.strip().splitlines()[-1] or '')))
        if not ok:
            failed.append(name)
            sys.stdout.write('\n'.join('     ' + l for l in (r.stdout + r.stderr).strip().splitlines()[-15:]) + '\n')
    print('\n%d of %d browser tests passed' % (len(todo) - len(failed), len(todo)))
    sys.exit(1 if failed else 0)
if __name__ == '__main__':
    main()
