import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":820})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    last=lambda t: pg.evaluate("t=>[...window.sent].reverse().find(m=>m.type===t)", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False})
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    # object list: activities say "Field access only"
    await pg.click("text=Show all objects")
    await post({"type":"objectCatalog","objects":[{"name":"Account","label":"Account","objectPerms":True},{"name":"Event","label":"Event","objectPerms":False,"fieldPerms":True},{"name":"Task","label":"Task","objectPerms":False,"fieldPerms":True}]}); await pg.wait_for_timeout(40)
    row=await pg.inner_text("tbody tr:has(td.strong:text-is('Event'))"); assert "Field access only" in row, row
    # Lead: fixed fields listed, locked, not counted
    await pg.click("td.strong:text-is('Lead')")
    od=json.loads(json.dumps(objd)); od["data"]["objectPermissions"]=True
    od["data"]["fields"]+= [{"name":"Lead.LastName","apiName":"LastName","label":"Last Name","type":"string","canEdit":False,"read":True,"edit":True,"fixed":True},
                            {"name":"Lead.CreatedDate","apiName":"CreatedDate","label":"Created Date","type":"datetime","canEdit":False,"read":True,"edit":False,"fixed":True}]
    od["data"]["fields"].sort(key=lambda f:f["label"])
    await post(od); await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[]}}); await pg.wait_for_timeout(50)
    assert await pg.is_disabled("[aria-label='Read Last Name (always)']") and await pg.is_checked("[aria-label='Read Last Name (always)']")
    assert await pg.is_checked("[aria-label='Edit Last Name (fixed)']") and not await pg.is_checked("[aria-label='Edit Created Date (fixed)']")
    assert "Always visible" in await pg.inner_text("tr[data-row='field:Lead.LastName']")
    assert "5 of 7 readable · 2 always visible" in await pg.inner_text("#fieldCount"), await pg.inner_text("#fieldCount")
    await pg.click("th label.cb:has-text('Edit Access') input")
    assert await pg.locator("tr.fixed.row-edited").count()==0, "bulk edit leaves fixed fields alone"
    await pg.click("text=Show only granted"); await pg.wait_for_timeout(30)
    assert await pg.locator("tr.fixed").count()==0, "Show only granted hides fields nobody grants"
    await pg.click("text=Show only granted"); await pg.wait_for_timeout(30)
    await pg.evaluate("document.querySelector('main.record').scrollTop=10000"); await pg.wait_for_timeout(30)
    await pg.screenshot(path="fixed.png")
    await pg.click(".docked-footer button.neutral")
    # Event: note instead of object permissions
    await pg.click(".breadcrumb button")
    await pg.click("td.strong:text-is('Event')")
    await post({"type":"objectDetail","key":"permissionSet:1","object":"Event","savedAt":now,"refreshing":False,"data":{"object":"Event","label":"Event","props":P(),"columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],"objectPermissions":False,
      "fields":[{"name":"Event.Region__c","apiName":"Region__c","label":"Region","type":"picklist","canEdit":True,"read":False,"edit":False},{"name":"Event.Subject","apiName":"Subject","label":"Subject","type":"combobox","canEdit":False,"read":True,"edit":True,"fixed":True}]}})
    await post({"type":"recordTypes","key":"permissionSet:1","object":"Event","savedAt":now,"refreshing":False,"data":{"object":"Event","profile":False,"items":[]}}); await pg.wait_for_timeout(50)
    t=await pg.inner_text("main"); assert "Salesforce has no object permissions for Event" in t and "Edit Tasks and Edit Events" in t, t[:500]
    assert await pg.locator(".perm-grid").count()==0
    await pg.click("[aria-label='Read Region']")
    assert "1 unsaved change" in await pg.inner_text(".docked-footer")
    await pg.evaluate("document.querySelector('main.record').scrollTop=0"); await pg.screenshot(path="event.png")
    await pg.click(".docked-footer button.neutral")
    # Grant object access offers no activities
    await pg.click("text=Grant object access"); await pg.wait_for_timeout(30)
    await pg.click("[data-fid='ow.obj']"); await pg.wait_for_timeout(30)
    opts=await pg.locator(".combo-list .cv").all_inner_texts(); assert "Event" not in opts and "Account" in opts, opts
    await pg.keyboard.press("Escape")
    # Find access, field only
    await pg.click("text=Find access")
    await post({"type":"lookupResult","result":{"object":"Event","field":"Event.Region__c","level":"read","fieldOnly":True,"sources":[],"users":[],"partial":[]}}); await pg.wait_for_timeout(30)
    assert "this shows field access only" in await pg.inner_text("main")
    print("ok; errors:", errs)
    await b.close()
asyncio.run(main())
