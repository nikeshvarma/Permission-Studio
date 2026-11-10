import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok), info)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:300]))
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":800})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)+" @ "+(e.stack or "").split("\n")[1].strip() if e.stack else str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate(DELIVER, m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t)", t)
    HOSTILE='<img src=x onerror="window.__xss=1">Sales & "Ops"'
    L=json.loads(json.dumps(lists)); L["permissionSet"][0]["label"]=HOSTILE
    await post(dict(ctx,production=True)); await post({"type":"lists","lists":L,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    d=json.loads(json.dumps(detail)); d["data"]["header"]["label"]=HOSTILE
    await pg.click(".split-item >> nth=0"); await post(d); await pg.wait_for_timeout(50)
    # W6 hostile labels are shown as text
    check("W6 labels with HTML render as text, no script runs", await pg.evaluate("()=>!window.__xss && !document.querySelector('main img[src=x]') && document.querySelector('.page-header h1').textContent.includes('<img')"))
    # W3 Ctrl+S with nothing to save
    await pg.keyboard.press("Control+s"); await pg.wait_for_timeout(30)
    check("W3a Ctrl+S with nothing to save opens nothing", await pg.locator(".modal").count()==0)
    # make changes
    await pg.click("td.strong:text-is('Lead')"); await post(objd); await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[]}}); await pg.wait_for_timeout(40)
    await pg.click("[aria-label='Read Website']"); await pg.click("[aria-label='Edit Rating']")
    await pg.keyboard.press("Control+s"); await pg.wait_for_timeout(30)
    check("W3b Ctrl+S opens the review", await pg.locator(".modal").count()==1)
    # W17 production confirm, case-insensitive like the server
    await pg.fill("#confirm","  UAT "); await pg.dispatch_event("#confirm","input"); await pg.wait_for_timeout(20)
    check("W17 production name in any case enables Save", not await pg.is_disabled("#saveBtn"), "disabled")
    # W1 double-click Save
    before=len(await sent("save"))
    await pg.dblclick("#saveBtn"); await pg.wait_for_timeout(40)
    await pg.keyboard.press("Control+s"); await pg.wait_for_timeout(30)
    check("W1 double-click + Ctrl+S during a save sends one save", len(await sent("save"))-before==1, len(await sent("save"))-before)
    # W2 Esc during save keeps the dialog
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(20)
    check("W2 Esc during a save keeps the dialog open", await pg.locator(".modal").count()==1)
    # W13 busy reply
    await post({"type":"saveResult","key":"permissionSet:1","status":"busy","message":"A save is already running. Wait for it to finish."}); await pg.wait_for_timeout(30)
    check("W13 'busy' keeps the save in progress", await pg.locator(".modal").count()==1 and "already running" in await pg.inner_text(".toasts"))
    await post({"type":"saveResult","key":"permissionSet:1","status":"error","message":"Nope"}); await pg.wait_for_timeout(30)
    # W7 remove all changes from the review
    await pg.fill("#confirm",""); 
    while await pg.locator(".rv-x").count(): await pg.click(".rv-x >> nth=0"); await pg.wait_for_timeout(20)
    check("W7 removing every change closes the review and the footer", await pg.locator(".modal").count()==0 and not await pg.is_visible(".docked-footer button.brand"))
    # W8 filter to nothing
    await pg.click("[aria-label='Read Website']"); await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(30)
    await pg.fill("[data-fid='rv.filter']","zzzz"); await pg.dispatch_event("[data-fid='rv.filter']","input"); await pg.wait_for_timeout(20)
    check("W8 a filter matching nothing says so; Save still covers every change", "No changes match" in await pg.inner_text(".modal") and "Save 1 change" in await pg.inner_text("#saveBtn"))
    await pg.click(".modal button:has-text('Cancel')"); await pg.wait_for_timeout(20)
    # W4 switch item with pending: prompt, cancel keeps, discard drops
    await pg.click(".split-item >> nth=1"); await pg.wait_for_timeout(30)
    check("W4a switching items with unsaved changes asks first", await pg.locator(".modal").count()==1)
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(20)
    check("W4b cancelling keeps the changes", "1 unsaved change" in await pg.inner_text(".docked-footer"))
    # W5 a tool page and back keeps them
    await pg.click(".globalbar button:has-text('History')"); await post({"type":"history","entries":[]}); await pg.wait_for_timeout(20)
    await pg.click("text=Back to the record"); await pg.wait_for_timeout(30)
    check("W5a History opens without discarding, and coming back keeps the change", "1 unsaved change" in await pg.inner_text(".docked-footer"))
    await pg.click(".globalbar button:has-text('Grant field access')"); await pg.wait_for_timeout(30)
    check("W5b a grant screen still asks first", await pg.locator(".modal").count()==1)
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(20)
    # W9 a huge paste into a search box
    t0=time.time(); await pg.fill("[data-fid='search.fields']","x"*10000); await pg.dispatch_event("[data-fid='search.fields']","input"); await pg.wait_for_timeout(300)
    check("W9 a 10,000-character search stays responsive", time.time()-t0<2.5, time.time()-t0)
    await pg.fill("[data-fid='search.fields']",""); await pg.dispatch_event("[data-fid='search.fields']","input")
    await pg.click(".docked-footer button.neutral"); await pg.wait_for_timeout(20)
    # W16 nonsense in an object picker
    await pg.click(".globalbar button:has-text('Grant object access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead","objectPerms":True}]}); await pg.wait_for_timeout(20)
    n0=len(await sent("objWizardInfo"))
    await pg.click("[data-fid='ow.obj']"); await pg.keyboard.type("¯\\_(ツ)_/¯ '; DROP", delay=5); await pg.keyboard.press("Escape"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(30)
    check("W16 nonsense + Enter in an object picker does nothing", len(await sent("objWizardInfo"))==n0)
    # W14 resize with a list open
    await pg.fill("[data-fid='ow.obj']",""); await pg.click("[data-fid='ow.obj']"); await pg.wait_for_timeout(20)
    await pg.set_viewport_size({"width":850,"height":800}); await pg.wait_for_timeout(60)
    check("W14 resizing closes an open list", await pg.locator(".combo-list:not([hidden])").count()==0)
    await pg.set_viewport_size({"width":1400,"height":800}); await pg.wait_for_timeout(30)
    # W18 the open item was deleted in Setup: a refresh brings lists without it
    L2=json.loads(json.dumps(L)); L2["permissionSet"]=[r for r in L2["permissionSet"] if r["key"]!="permissionSet:1"]
    await pg.click(".globalbar button:has-text('Grant object access')"); await pg.wait_for_timeout(20)
    await post({"type":"lists","lists":L2,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    check("W18 the open item vanishing from a refresh is handled: list redrawn, item closed", len(errs)==0 and await pg.locator(".split-item").count()==len(L2["permissionSet"]), errs)
    # W10 an empty org
    await post({"type":"lists","lists":{"permissionSet":[],"group":[],"profile":[]},"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    check("W10 an org with no permission sets shows an empty list, no errors", len(errs)==0, errs)
    # W11 a detail with missing parts
    await post({"type":"lists","lists":L,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(20)
    await pg.click(".globalbar button:has-text('Grant object access')"); await pg.wait_for_timeout(20)
    await pg.click(".split-item >> nth=1"); await pg.wait_for_timeout(20)
    await post({"type":"detail","key":"permissionSet:2","savedAt":now,"refreshing":False,"data":{"header":{"label":"Bare","apiName":"Bare","kind":"Permission Set","kindId":"permissionSet","editableCats":[]},"objects":[],"system":[]}}); await pg.wait_for_timeout(40)
    check("W11 a detail with missing parts still renders", "Bare" in await pg.inner_text("main") and len(errs)==0, errs)
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
