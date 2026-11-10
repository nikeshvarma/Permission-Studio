import subprocess, json, sys, asyncio, time
# 1. The full layout audit: every screen, four laptop sizes, no problems.
r = subprocess.run([sys.executable, 'audit.py'], capture_output=True, text=True, timeout=280)
report = json.loads(r.stdout)
fails = []
for screen, sizes in report.items():
    for size, v in sizes.items():
        if v['problems']: fails.append(f"{screen} {size}: {'; '.join(v['problems'])}")
        if size == '970x620' and screen in ('1-objects', '2-object-detail', '4-system') and v['info']['contentTop'] > 300: fails.append(f"{screen} {size}: content starts at {v['info']['contentTop']}px")
print('layout audit:', 'ok' if not fails else 'FAIL'); [print('  ' + f) for f in fails]
# 2. The collapse controls work and are remembered.
from playwright.async_api import async_playwright
from common import *
async def toggles():
  async with async_playwright() as p:
    b = await p.chromium.launch(**launch_args())
    pg = await b.new_page(viewport={"width": 970, "height": 620})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post = lambda m: pg.evaluate(DELIVER, m)
    await post(dict(ctx, production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    ok = []
    ok.append(("list shows while nothing is open", not await pg.evaluate("()=>document.querySelector('.body').classList.contains('list-collapsed')")))
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(60)
    ok.append(("narrow window: the list collapses once an item is open, with a picker", await pg.evaluate("()=>document.querySelector('.body').classList.contains('list-collapsed')") and await pg.is_visible(".narrow-bar.show select")))
    await pg.select_option(".narrow-bar.show select", "permissionSet:3"); await pg.wait_for_timeout(40)
    ok.append(("the picker opens another item", (await pg.evaluate("()=>window.sent.filter(m=>m.type==='select').pop()"))["key"] == "permissionSet:3"))
    d3 = json.loads(json.dumps(detail)); d3["key"] = "permissionSet:3"; d3["data"]["header"]["label"] = "Lead Management"
    await post(d3); await pg.wait_for_timeout(50)
    await pg.click(".list-rail .rail-btn"); await pg.wait_for_timeout(40)
    ok.append(("the rail brings the list back, and the menu turns to icons", not await pg.evaluate("()=>document.querySelector('.body').classList.contains('list-collapsed')") and await pg.evaluate("()=>document.querySelector('main').classList.contains('nav-compact')")))
    await pg.click(".nav-toggle"); await pg.wait_for_timeout(40)
    ok.append(("'show section names' wins over the narrow width", not await pg.evaluate("()=>document.querySelector('main').classList.contains('nav-compact')")))
    await pg.click(".search-row .rail-btn"); await pg.wait_for_timeout(40)
    ok.append(("the list can be hidden again by hand", await pg.evaluate("()=>document.querySelector('.body').classList.contains('list-collapsed')")))
    await pg.set_viewport_size({"width": 1480, "height": 760}); await pg.wait_for_timeout(80)
    ok.append(("a choice made by hand is kept when the window grows", await pg.evaluate("()=>document.querySelector('.body').classList.contains('list-collapsed')") and not await pg.evaluate("()=>document.querySelector('main').classList.contains('nav-compact')")))
    ok.append(("no page errors", not errs))
    for name, v in ok: print(('PASS ' if v else 'FAIL ') + name + ('' if v else f'  {errs}'))
    await b.close()
    return all(v for _, v in ok)
good = asyncio.run(toggles())
# 3. With all three lists (605 / 61 / 98 items), every tab and the hide button fit at every width.
t = subprocess.run([sys.executable, 'tabs.py'], capture_output=True, text=True, timeout=120)
print(t.stdout.strip())
good = good and 'ALL OK' in t.stdout
print('ok; errors: []' if good and not fails else 'FAILED')
