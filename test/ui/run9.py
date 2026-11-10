import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
SYS=[{"name":"ApiEnabled","label":"API Enabled","enabled":False},{"name":"ModifyAllData","label":"Modify All Data","enabled":False},{"name":"ViewAllData","label":"View All Data","enabled":False}]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":800})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t)", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    # 2. kept changes for an item that no longer exists are dropped, and never block keeping new ones
    await post({"type":"persisted","values":{"pending":{"key":"permissionSet:999","entries":[["user:ApiEnabled",{"before":{"enabled":False},"after":{"enabled":True},"label":"API Enabled","cat":"user","touched":["enabled"]}]]}}}); await pg.wait_for_timeout(30)
    assert (await sent("persist"))[-1]=={"type":"persist","name":"pending","value":None}, "gone item: kept set dropped"
    await pg.click(".split-item:has-text('Sales Operations')")
    d=json.loads(json.dumps(detail)); d["data"]["system"]=SYS
    await post(d); await post({"type":"permDeps","system":{"ModifyAllData":["ViewAllData"]},"custom":{}}); await pg.wait_for_timeout(40)
    # 7. on a wide window the narrow pickers aren't built at all
    assert await pg.locator(".narrow-bar").count()==0 and await pg.locator(".narrow-sections").count()==0
    # 3. the rule note goes away with the change it explains
    await pg.click(".nav-item:has-text('System Permissions')"); await pg.click("[aria-label='Modify All Data']"); await pg.wait_for_timeout(30)
    assert await pg.locator(".rule-note").count()==1
    p1=(await sent("persist"))[-1]; assert p1["name"]=="pending" and p1["value"]["key"]=="permissionSet:1" and len(p1["value"]["entries"])==2, "new changes are kept"
    await pg.click(".docked-footer button.neutral"); await pg.wait_for_timeout(30)
    assert await pg.locator(".rule-note").count()==0, "note cleared with Cancel"
    # 1. Find access: typing then one click is enough
    await pg.click(".globalbar button:has-text('Find access')")
    await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"}]}); await pg.wait_for_timeout(30)
    await pg.click("[data-fid='lk.target']"); await pg.keyboard.type("Lead", delay=15)
    assert not await pg.is_disabled(".lk-bar button.brand"), "Find is usable while typing"
    await pg.click(".lk-bar button.brand"); await pg.wait_for_timeout(30)
    lk=await sent("lookup"); assert lk and lk[-1]=={"type":"lookup","object":"Lead","field":None,"level":"read"}, lk
    await post({"type":"lookupResult","result":{"object":"Lead","field":None,"level":"read","sources":[],"users":[],"partial":[],"inactive":[]}}); await pg.wait_for_timeout(30)
    await pg.fill("[data-fid='lk.target']","Nope"); await pg.click(".lk-bar button.brand"); await pg.wait_for_timeout(30)
    assert "Nothing to look up" in await pg.inner_text(".toasts")
    # 5. a late answer for an earlier field selection is ignored
    await pg.click(".globalbar button:has-text('Grant field access')")
    await pg.fill("[data-fid='wz.obj']","Lead"); await pg.dispatch_event("[data-fid='wz.obj']","change")
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.A__c","apiName":"A__c","label":"A","type":"text","custom":True,"canEdit":True},{"name":"Lead.B__c","apiName":"B__c","label":"B","type":"text","custom":True,"canEdit":True}]}); await pg.wait_for_timeout(30)
    await pg.click("[aria-label='A']"); await pg.click("[aria-label='B']"); await pg.click("[aria-label='Sales Operations']")
    await post({"type":"wizardCurrent","object":"Lead","fields":["Lead.A__c"],"byKey":{"permissionSet:1":{"users":5,"objectRead":True,"fields":{"Lead.A__c":{"read":True,"edit":True}}}}}); await pg.wait_for_timeout(30)
    assert "Checking current access" in await pg.inner_text(".grant-sum"), "stale answer ignored"
    await post({"type":"wizardCurrent","object":"Lead","fields":["Lead.B__c","Lead.A__c"],"byKey":{"permissionSet:1":{"users":5,"objectRead":True,"fields":{}}}}); await pg.wait_for_timeout(30)
    assert "2 field changes" in await pg.inner_text(".grant-sum")
    # 7. narrow: the pickers appear
    await pg.set_viewport_size({"width":800,"height":800}); await pg.click(".globalbar button:has-text('Grant field access')"); await pg.wait_for_timeout(60)
    assert await pg.locator(".narrow-bar").count()==1, "pickers once the window is narrow"
    print("ok; errors:", errs); await b.close()
asyncio.run(main())
