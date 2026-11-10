import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
def many(kind, n, label): return [row(f"{kind}:{i}", kind, f"{label} {i}", f"{label.replace(' ','_')}_{i}") for i in range(1, n+1)]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    allok=True
    for W in (970, 1230, 1480):
      pg=await b.new_page(viewport={"width":W,"height":700})
      await pg.goto(DARK)
      post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
      L={"permissionSet":many("permissionSet",605,"Sales Ops"),"group":many("group",61,"Bundle"),"profile":many("profile",98,"Custom")}
      await post(dict(ctx,production=False,sandbox=True)); await post({"type":"lists","lists":L,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(80)
      r=await pg.evaluate("""()=>{const head=document.querySelector('.kinds-row').getBoundingClientRect();
        const tabs=[...document.querySelectorAll('.kinds .kind')].map(t=>{const r=t.getBoundingClientRect(); const label=[...t.children].find(c=>getComputedStyle(c).display!=='none'&&!c.classList.contains('count'));
          return {text:t.innerText.replace(/\\n/g,' '), inside:r.left>=head.left-1&&r.right<=head.right+1, cut: label? label.scrollWidth>label.clientWidth+1 : true}});
        const btn=document.querySelector('.search-row .rail-btn').getBoundingClientRect(); const sr=document.querySelector('.search-row').getBoundingClientRect();
        return {width: Math.round(document.querySelector('.split').getBoundingClientRect().width), tabs, button: btn.width>0 && btn.right<=sr.right+1}}""")
      ok = all(t['inside'] and not t['cut'] for t in r['tabs']) and r['button']
      allok = allok and ok
      print(W, 'list', r['width'], 'px |', ' | '.join(t['text'] + ('' if t['inside'] and not t['cut'] else ' (CUT)') for t in r['tabs']), '| hide button', 'visible' if r['button'] else 'HIDDEN', '->', 'ok' if ok else 'FAIL')
      await pg.screenshot(path=f"{OUT}/tabs-{W}.png", clip={"x":0,"y":0,"width":360,"height":140})
      await pg.close()
    print('ALL OK' if allok else 'PROBLEMS')
    await b.close()
asyncio.run(main())
