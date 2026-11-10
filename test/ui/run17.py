import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:400]))
# Every box that scrolls in the given root, scrolled to its middle: returns their keys.
SCROLL_ALL = """(sel)=>{const root=document.querySelector(sel); const out=[]; for (const e of root.querySelectorAll('*')) { const st=getComputedStyle(e);
  if (!/(auto|scroll)/.test(st.overflowY) || e.scrollHeight <= e.clientHeight + 20) continue; e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) / 2);
  e.setAttribute('data-test-scroll', String(out.length)); out.push([e.tagName + '.' + e.className, e.scrollTop]); } return out}"""
POSITIONS = """(sel)=>[...document.querySelector(sel).querySelectorAll('*')].filter(e=>{const st=getComputedStyle(e); return /(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 20}).map(e=>[e.tagName + '.' + e.className, e.scrollTop])"""
def many(kind, n, label): return [row(f"{kind}:{i}", kind, f"{label} {i:02d}", f"{label.replace(' ','_')}_{i:02d}") for i in range(1, n+1)]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1500,"height":760})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate(DELIVER, m)
    L={"permissionSet":many("permissionSet",60,"Sales PS"),"profile":many("profile",20,"Custom")}
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":L,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    d=json.loads(json.dumps(detail)); d["key"]="permissionSet:1"
    await pg.click(".split-item >> nth=0"); await post(d); await pg.wait_for_timeout(40)
    async def keeps(label, root, act):
      before=await pg.evaluate(SCROLL_ALL, root)
      if not before: check(label + ' (found a box that scrolls)', False, 'nothing scrolls here'); return
      await act(); await pg.wait_for_timeout(80)
      after=await pg.evaluate(POSITIONS, root)
      moved=[(k, b2, a2) for (k, b2), (k2, a2) in zip(before, after) if abs(b2 - a2) > 2]
      check(label + ' (%d scrolling box%s)' % (len(before), '' if len(before)==1 else 'es'), not moved and len(after)==len(before), {'before': before, 'after': after})
    # ---- Grant field access: the field list and "Grant to"
    await pg.click(".globalbar button:has-text('Grant field access')"); await post({"type":"objectCatalog","objects":[{"name":"Quote","label":"Quote"}]})
    await pg.fill("[data-fid='wz.obj']","Quote"); await pg.dispatch_event("[data-fid='wz.obj']","change")
    await post({"type":"wizardFields","object":"Quote","fields":[{"name":"Quote.F%02d__c"%i,"apiName":"F%02d__c"%i,"label":"Field %02d"%i,"type":"picklist","custom":True,"canEdit":True} for i in range(60)]}); await pg.wait_for_timeout(40)
    async def tick_field():
      box=await pg.query_selector("[data-test-scroll='0']")
      cbs=await box.query_selector_all(".cb input"); visible=[c for c in cbs if await c.is_visible()]
      el=await pg.evaluate_handle("(b)=>{const r=b.getBoundingClientRect(); return [...b.querySelectorAll('.cb input')].find(i=>{const q=i.parentElement.getBoundingClientRect(); return q.top>r.top+30 && q.bottom<r.bottom})}", box)
      await el.as_element().evaluate("i=>i.click()")
    await keeps("1 Grant field access: ticking a field keeps the field list where it was", "main", tick_field)
    await pg.click("[aria-label='Field 01']"); await pg.wait_for_timeout(40)
    await post({"type":"wizardCurrent","object":"Quote","fields":["Quote.F01__c"],"byKey":{}}); await pg.wait_for_timeout(40)
    async def tick_target():
      # a "Grant to" row in the middle of its box
      await pg.evaluate("""()=>{const boxes=[...document.querySelectorAll('[data-test-scroll]')]; const box=boxes[boxes.length-1]; const r=box.getBoundingClientRect();
        const i=[...box.querySelectorAll('tbody .cb input')].find(i=>{const q=i.parentElement.getBoundingClientRect(); return q.top>r.top+40 && q.bottom<r.bottom}); i.click()}""")
    await keeps("2 Grant field access: ticking a permission set keeps every list where it was", "main", tick_target)
    # ---- Grant object access: the grid
    await pg.click(".globalbar button:has-text('Grant object access')"); await post({"type":"objectCatalog","objects":[{"name":"Quote","label":"Quote"}]})
    await pg.fill("[data-fid='ow.obj']","Quote"); await pg.dispatch_event("[data-fid='ow.obj']","change")
    await post({"type":"objWizardInfo","object":"Quote","columns":["read","create","edit","delete","viewAll","modifyAll"],"recordTypes":[]})
    await post({"type":"objWizardCurrent","object":"Quote","byKey":{}}); await pg.wait_for_timeout(60)
    async def tick_cell():
      await pg.evaluate("""()=>{const boxes=[...document.querySelectorAll('[data-test-scroll]')]; const box=boxes[boxes.length-1]; const r=box.getBoundingClientRect();
        const g=[...box.querySelectorAll('button.gc')].find(i=>{const q=i.getBoundingClientRect(); return q.top>r.top+40 && q.bottom<r.bottom}); g.click()}""")
    await keeps("2 Grant object access: ticking a cell in the grid keeps it where it was", "main", tick_cell)
    # ---- the section menu (Apps), at a laptop height
    await pg.set_viewport_size({"width":1500,"height":560}); await pg.wait_for_timeout(60)
    await pg.click(".tool .link:has-text('Back')"); await pg.wait_for_timeout(60)
    async def pick_section():
      await pg.evaluate("""()=>{const nav=document.querySelector('.section-nav'); const r=nav.getBoundingClientRect();
        const it=[...nav.querySelectorAll('.nav-item')].find(i=>{const q=i.getBoundingClientRect(); return q.top>r.top+40 && q.bottom<r.bottom && !i.classList.contains('on')}); it.click()}""")
    await keeps("3 the section menu keeps its place when a section is chosen", ".sections", pick_section)
    # ---- the review's list
    await pg.set_viewport_size({"width":1500,"height":760}); await pg.wait_for_timeout(40)
    await pg.click(".nav-item:has-text('Object Settings')"); await pg.wait_for_timeout(30)
    await pg.click("td.strong:text-is('Lead')"); await post(objd); await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[]}}); await pg.wait_for_timeout(40)
    for lab in ['Read Website','Edit Rating','Read Sales Region','Edit Sales Region','Read Rating']:
      if await pg.locator(f"[aria-label='{lab}']").count(): await pg.click(f"[aria-label='{lab}']")
    await pg.click(".breadcrumb button"); await pg.click(".nav-item:has-text('System Permissions')"); await pg.wait_for_timeout(30)
    n=await pg.evaluate("()=>{const cbs=[...document.querySelectorAll('main tbody .cb input')].filter(i=>!i.checked && !i.disabled).slice(0,8); cbs.forEach(i=>i.click()); return cbs.length}")
    await pg.wait_for_timeout(40)
    await pg.set_viewport_size({"width":1500,"height":560}); await pg.wait_for_timeout(40)
    await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(60)
    async def remove_one():
      await pg.evaluate("()=>{const l=document.querySelector('.rv-scroll'); const xs=[...l.querySelectorAll('.rv-x')]; xs[xs.length-1].click()}")
    await keeps("2 the review keeps its list where it was after removing a change", ".modal", remove_one)
    await pg.click(".modal button:has-text('Cancel')"); await pg.click(".docked-footer button.neutral"); await pg.wait_for_timeout(30)
    # ---- the page itself, on a record section
    if await pg.locator(".breadcrumb button").count(): await pg.click(".breadcrumb button")
    await pg.click(".nav-item:has-text('Object Settings')"); await pg.wait_for_timeout(30)
    await pg.evaluate("()=>{document.querySelector('main').scrollTop=120}")
    m1=await pg.evaluate("()=>document.querySelector('main').scrollTop")
    await pg.click(".toggle:has-text('Show all objects')"); await pg.wait_for_timeout(60)
    m2=await pg.evaluate("()=>document.querySelector('main').scrollTop")
    check("2 the page itself keeps its place when a toggle is flipped", abs(m1-m2)<=2, [m1, m2])
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
