import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":760})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t).length", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False})
    await pg.click(".split-item:has-text('Sales Operations')")
    d=json.loads(json.dumps(detail)); d["data"]["fieldObjects"]=[{"name":"Event","label":"Event","fields":3,"objectPermissions":False},{"name":"Quote","label":"Quote","fields":1,"objectPermissions":True}]
    await post(d); await pg.wait_for_timeout(50)
    ev=await pg.inner_text("tbody tr:has(td.strong:text-is('Event'))"); assert "3 fields" in ev and "Field access only" in ev, ev
    cp=await pg.inner_text("tbody tr:has(td.strong:text-is('Quote'))"); assert "1 field" in cp and "Field access only" not in cp, cp
    n=await pg.inner_text(".nav-item:has-text('Object Settings') .count"); assert n==str(len([o for o in d["data"]["objects"] if any(o["props"].values())])+2), n
    # search finds objects that aren't listed yet, from the org's full list
    assert await sent("objectCatalog")==0
    await pg.click("[data-fid='search.objects']"); await pg.keyboard.type("task", delay=30); await pg.wait_for_timeout(250)
    assert await sent("objectCatalog")==1, "typing a search loads the full object list"
    await post({"type":"objectCatalog","objects":[{"name":"Account","label":"Account","objectPerms":True},{"name":"Event","label":"Event","objectPerms":False},{"name":"Task","label":"Task","objectPerms":False}]}); await pg.wait_for_timeout(60)
    rows=await pg.locator("tbody tr td.strong").all_inner_texts(); assert rows==["Task"], rows
    assert "Field access only" in await pg.inner_text("tbody tr")
    await pg.fill("[data-fid='search.objects']","event"); await pg.dispatch_event("[data-fid='search.objects']","input"); await pg.wait_for_timeout(250)
    rows=await pg.locator("tbody tr td.strong").all_inner_texts(); assert rows==["Event"], rows
    await pg.fill("[data-fid='search.objects']",""); await pg.dispatch_event("[data-fid='search.objects']","input"); await pg.wait_for_timeout(250)
    rows=await pg.locator("tbody tr td.strong").all_inner_texts(); assert "Task" not in rows and "Event" in rows, rows
    await pg.screenshot(path="fieldobjects.png", clip={"x":330,"y":200,"width":1070,"height":520})
    print("ok; errors:", errs); await b.close()
asyncio.run(main())
