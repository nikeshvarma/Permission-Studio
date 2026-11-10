import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:400]))
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1386,"height":998})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate(DELIVER, m)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    await pg.click(".nav-item:has-text('System Permissions')"); await pg.wait_for_timeout(30)
    await pg.click(".toggle:has-text('Show only enabled')"); await pg.wait_for_timeout(30)
    # 1, 4: toggles centred on their label; on is green
    t=await pg.evaluate("""()=>[...document.querySelectorAll('.toggle')].filter(e=>e.offsetParent).map(e=>{const tr=e.querySelector('.track').getBoundingClientRect(); const lab=e.querySelector('span:last-child').getBoundingClientRect();
      const knob=getComputedStyle(e.querySelector('.track'),'::after'); const on=e.querySelector('input').checked;
      return {dy: Math.abs((tr.top+tr.height/2)-(lab.top+lab.height/2)), knobTop: parseFloat(knob.top)+parseFloat(knob.marginTop), h: tr.height, on, bg: getComputedStyle(e.querySelector('.track')).backgroundColor}})""")
    check("1 toggles: track centred on the label, knob centred in the track", t and all(x['dy']<=1 and abs(x['knobTop']-(x['h']/2-6-1))<=1 for x in t), t)
    on=[x for x in t if x['on']]
    check("4 a toggle that's on is green", on and all(x['bg']=='rgb(46, 160, 67)' for x in on), on)
    # 2: dropdown arrows 12 px from the edge, the same everywhere
    await pg.click(".globalbar button:has-text('Find access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"}]}); await pg.wait_for_timeout(30)
    a=await pg.evaluate("""()=>[...document.querySelectorAll('select.select, .flt select')].filter(e=>e.offsetParent).map(e=>({cls:e.className, app:getComputedStyle(e).appearance, pos:getComputedStyle(e).backgroundPosition}))""")
    check("2 dropdown arrows drawn 12 px in from the edge", a and all(x['app']=='none' and 'calc(100% - 12px)' in x['pos'] for x in a if x['cls']=='select'), a[:3])
    # 3: Compare's switch fits its buttons
    await pg.click(".globalbar button:has-text('Compare')"); await pg.click(".seg button:has-text('In another org')"); await post({"type":"orgs","orgs":[{"username":"qa@acme.example","alias":"qa"}]}); await pg.wait_for_timeout(30)
    g=await pg.evaluate("""()=>{const s=document.querySelector('.cmp-bar .seg'); const r=s.getBoundingClientRect(); const last=s.lastElementChild.getBoundingClientRect(); return {gap: Math.round(r.right-last.right)}}""")
    check("3 'In another org': no empty space after it", g['gap']<=1, g)
    # 5, 6: the magnifier in the pickers, and one height for every field
    hs={}
    for tool, sel in [('Find access', "[data-fid='lk.target']"), ('Grant field access', "[data-fid='wz.obj']"), ('Grant object access', "[data-fid='ow.obj']")]:
      await pg.click(f".globalbar button:has-text('{tool}')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"}]}); await pg.wait_for_timeout(30)
      hs[tool]=await pg.evaluate("""(sel)=>{const i=document.querySelector(sel); const icon=i.parentElement.querySelector('.search-icon'); const ir=icon&&icon.getBoundingClientRect(), r=i.getBoundingClientRect();
        const all=[...document.querySelectorAll('main select.select, main .search input, main .combo > input, main input.text')].filter(e=>e.offsetParent).map(e=>Math.round(e.getBoundingClientRect().height));
        return {icon: !!ir && ir.left>r.left && ir.right<r.left+40 && Math.abs((ir.top+ir.height/2)-(r.top+r.height/2))<=1, textStart: parseFloat(getComputedStyle(i).paddingLeft), heights:[...new Set(all)]}}""", sel)
    check("5 Find access: the magnifier in the object or field box", hs['Find access']['icon'] and hs['Find access']['textStart']>=28, hs['Find access'])
    check("6 Grant field and object access: the magnifier too", hs['Grant field access']['icon'] and hs['Grant object access']['icon'], hs)
    check("5 one height (30 px) for every dropdown, search box, picker and text field", all(v['heights']==[30] for v in hs.values()), hs)
    # 7, 8, 9: Health
    btn=await pg.inner_text(".globalbar button:has-text('Health')")
    check("9 the button says Health", btn.strip()=="Health", btn)
    await pg.click(".globalbar button:has-text('Health')"); await pg.click("button:has-text('Check now')")
    await post({"type":"health","data":json.load(open(DATA / 'health-big.json'))}); await pg.wait_for_timeout(200)
    h=await pg.evaluate("""()=>({rows: document.querySelectorAll('main tbody tr').length, nested: document.querySelectorAll('main .scroll-y').length, more: [...document.querySelectorAll('.hc-more')].map(e=>e.innerText.replace(/\\n/g,' ')),
      tabs: !!document.querySelector('.rp-tabs'), matrix: document.body.innerText.includes('Access matrix'), title: document.querySelector('main h1') && document.querySelector('main h1').textContent})""")
    check("7 no boxes inside boxes, and long findings start with 50 rows", h['nested']==0 and h['rows']<=50*6+12 and any('Showing 50 of 5,345' in m for m in h['more']), h)
    check("8 no access matrix anywhere", not h['tabs'] and not h['matrix'], h)
    await pg.click("#hc-inactive .hc-more button:has-text('Show 100 more')"); await pg.wait_for_timeout(60)
    check("7 'Show 100 more' adds rows", 'Showing 150 of 5,345' in await pg.inner_text("#hc-inactive"))
    await pg.click("#hc-inactive th [aria-label='Select all']"); await pg.wait_for_timeout(80)
    check("7 Select all takes every row of the finding, not only those shown", 'Remove 5345' in await pg.inner_text("#hc-inactive"), await pg.inner_text("#hc-inactive .card-head"))
    await pg.evaluate("()=>{document.querySelector('main').scrollTop=999999}"); await pg.wait_for_timeout(80)
    gap=await pg.evaluate("()=>{const m=document.querySelector('main'); const last=[...m.querySelectorAll('section.card')].pop().getBoundingClientRect(); return Math.round(m.getBoundingClientRect().bottom-last.bottom)}")
    check("7 no blank space under the last finding", gap < 80, gap)
    # The reported blank space: the page itself must never grow or scroll, after a summary card or at the end.
    await pg.evaluate("()=>{document.querySelector('main').scrollTop=0}")
    await pg.click(".hc-card:has-text('unused custom profiles')"); await pg.wait_for_timeout(900)
    after_card=await pg.evaluate("()=>({h: document.scrollingElement.scrollHeight, win: innerHeight, top: document.scrollingElement.scrollTop, main: Math.round(document.querySelector('main').scrollTop)})")
    await pg.mouse.wheel(0, 20000); await pg.wait_for_timeout(300)
    at_end=await pg.evaluate("()=>({h: document.scrollingElement.scrollHeight, win: innerHeight, top: document.scrollingElement.scrollTop})")
    check("7 the page never grows or scrolls: a summary card scrolls only the health check", after_card['h']==after_card['win'] and after_card['top']==0 and after_card['main']>1000, after_card)
    check("7 ...and scrolling to the end leaves no blank space", at_end['h']==at_end['win'] and at_end['top']==0, at_end)
    await pg.screenshot(path=f"{OUT}/run16-health.png")
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
