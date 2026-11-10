import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1360,"height":800})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    sent=lambda: pg.evaluate("window.sent")
    c=dict(ctx, production=False)
    await post(c)
    fav={"permissionSet":[lists["permissionSet"][0]],"group":[],"profile":[]}
    await post({"type":"favorites","items":["permissionSet:Sales_Operations"],"objects":["Lead","Contact"]})
    await post({"type":"lists","lists":fav,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":True,"partial":True}); await pg.wait_for_timeout(50)
    assert "Loading the rest" in await pg.inner_text(".split-list")
    await pg.screenshot(path="fav_partial.png", clip={"x":0,"y":0,"width":360,"height":300})
    await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(50)
    groups=await pg.locator(".si-group").all_inner_texts(); assert groups==["Favorites","All permission sets"], groups
    await pg.click(".split-item:has-text('Lead Management') .star")
    assert (await sent())[-1]=={"type":"toggleFavorite","kind":"item","id":"permissionSet:Lead_Management"}
    assert not any(m.get("type")=="select" and m.get("key")=="permissionSet:3" for m in await sent()), "star must not open the item"
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(50)
    # favourite objects pinned, including Contact with no access
    rows=await pg.locator("table.datatable tbody tr td.strong").all_inner_texts()
    assert rows[:2]==["Contact","Lead"], rows
    # search focus: type several characters
    await pg.click("[data-fid='search.objects']"); await pg.keyboard.type("Opp", delay=60); await pg.wait_for_timeout(250)
    v=await pg.evaluate("document.activeElement.getAttribute('data-fid')+'|'+document.activeElement.value")
    assert v=="search.objects|Opp", v
    assert await pg.locator("table.datatable tbody tr").count()==1
    await pg.keyboard.press("Backspace"); await pg.keyboard.press("Backspace"); await pg.keyboard.press("Backspace"); await pg.wait_for_timeout(250)
    # object page: field search focus + record types
    await pg.click("td:has-text('Lead') >> nth=0")
    s=await sent(); assert s[-2]["type"]=="openObject" and s[-1]=={"type":"loadRecordTypes","key":"permissionSet:1","object":"Lead"}, s[-2:]
    await post(objd); await pg.wait_for_timeout(50)
    assert "Reading record type assignments with the Metadata API" in await pg.inner_text("main") and await pg.locator(".skeleton").count()>0
    await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[{"name":"Lead.Direct","developerName":"Direct","label":"Direct Lead","active":True,"visible":False},{"name":"Lead.Partner","developerName":"Partner","label":"Partner Lead","active":True,"visible":True}]}})
    await pg.wait_for_timeout(50)
    await pg.click("[data-fid='search.fields']"); await pg.keyboard.type("lead so", delay=50); await pg.wait_for_timeout(250)
    v=await pg.evaluate("document.activeElement.value"); assert v=="lead so", v
    assert await pg.locator("#fieldBody tr").count()==1
    await pg.fill("[data-fid='search.fields']",""); await pg.wait_for_timeout(250)
    await pg.click("[aria-label='Assign Direct Lead']")
    assert "1 unsaved change" in await pg.inner_text(".docked-footer")
    await pg.screenshot(path="rt_ps.png")
    await pg.click(".docked-footer button.brand")
    assert "Metadata API deploy" in await pg.inner_text(".modal")
    await pg.click("#saveBtn")
    s=(await sent())[-1]; assert s["changes"]==[{"key":"recordType:Lead.Direct","ref":None,"before":{"visible":False},"after":{"visible":True},"label":"Direct Lead"}], s
    await post({"type":"saveResult","key":"permissionSet:1","status":"error","message":"The deploy removed 1 other permission from this item (1 field). A full copy was saved before the deploy; select Restore to put them back.","restorable":True,"snapshotId":"snap-1"})
    await pg.wait_for_timeout(50)
    await pg.screenshot(path="restore.png")
    await pg.click("text=Restore removed permissions")
    assert [m for m in (await sent()) if m.get("type")=="restore"][-1]=={"type":"restore","key":"permissionSet:1","snapshotId":"snap-1"}
    # Apex classes tab
    await pg.click(".breadcrumb button")
    await pg.click(".nav-item:has-text('Apex Class Access')")
    assert {"type":"loadAccess","key":"permissionSet:1","category":"apexClass"} in (await sent())[-3:]
    items=[{"entityId":"01p%015d"%i,"name":n,"label":n,"namespace":"acme" if n.startswith("acme") else "","description":"","enabled":n=="LeadService"} for i,n in enumerate(["AccountTriggerHandler","LeadService","OpportunityService","acme__Util"]+["Class%04d"%i for i in range(1200)])]
    await post({"type":"accessDetail","key":"permissionSet:1","category":"apexClass","savedAt":now,"refreshing":False,"data":{"category":"apexClass","items":items}}); await pg.wait_for_timeout(50)
    assert await pg.locator("#accBody tr").count()==1, "only enabled by default"
    await pg.click("[data-fid='search.apexClass']"); await pg.keyboard.type("Service", delay=40); await pg.wait_for_timeout(250)
    assert await pg.evaluate("document.activeElement.value")=="Service"
    assert await pg.locator("#accBody tr").count()==2
    await pg.click("[aria-label='OpportunityService']")
    await pg.fill("[data-fid='search.apexClass']",""); await pg.wait_for_timeout(250)
    await pg.uncheck("text=Show only enabled"); await pg.wait_for_timeout(50)
    assert await pg.locator("#accBody tr").count()==300
    assert "Show 500 more of 904" in await pg.inner_text(".more")
    await pg.check("text=Show only enabled")
    assert (await pg.inner_text(".nav-item.on .count"))=="2"
    await pg.screenshot(path="apex.png")
    await pg.click(".docked-footer button.brand"); await pg.click("#saveBtn")
    s=(await sent())[-1]; assert s["changes"]==[{"key":"apexClass:OpportunityService","ref":"01p000000000000002","before":{"enabled":False},"after":{"enabled":True},"label":"OpportunityService"}], s
    await post({"type":"saveResult","key":"permissionSet:1","status":"saved","count":1,"mismatches":[],"snapshotId":"s","undo":[]}); await pg.wait_for_timeout(30)
    # profile record types with default radio
    await pg.click("button.kind:has-text('Profiles')"); await pg.click(".split-item:has-text('System Administrator')")
    pd=json.loads(json.dumps(detail)); pd["key"]="profile:1"; pd["data"]["header"].update(label="Custom: Sales",kind="Profile",kindId="profile")
    await post(pd); await pg.wait_for_timeout(30)
    await pg.click(".nav-item:has-text('Object Settings')")
    await pg.click("td:has-text('Lead') >> nth=0")
    po=json.loads(json.dumps(objd)); po["key"]="profile:1"; await post(po)
    await post({"type":"recordTypes","key":"profile:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":True,"items":[{"name":"Lead.Direct","label":"Direct Lead","active":True,"visible":False,"default":False},{"name":"Lead.Partner","label":"Partner Lead","active":True,"visible":True,"default":True}]}})
    await pg.wait_for_timeout(50)
    await pg.click("[aria-label='Assign Partner Lead']")
    assert "Choose another default" in await pg.inner_text(".toasts")
    assert await pg.is_checked("[aria-label='Assign Partner Lead']")
    await pg.click("[aria-label='Default Direct Lead']")
    assert await pg.is_checked("[aria-label='Assign Direct Lead']") and await pg.is_checked("[aria-label='Default Direct Lead']")
    assert "2 unsaved changes" in await pg.inner_text(".docked-footer")
    await pg.screenshot(path="rt_profile.png")
    print("ok; errors:", errs)
    await b.close()
asyncio.run(main())
