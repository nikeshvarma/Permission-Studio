import time
import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
ALL='["object","field","user","assignment","apexClass","apexPage","customPermission","flow","app","connectedApp","customMetadata","customSetting","recordType","layoutAssignment","loginHours","loginIpRanges","tab"]'
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":780})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    last=lambda t: pg.evaluate("t=>[...window.sent].reverse().find(m=>m.type===t)", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    # the extension asks to open a group (as from a file): the page opens on its members
    await post({"type":"selectKey","key":"group:1"}); await pg.wait_for_timeout(40)
    assert (await last("select"))["key"]=="group:1"
    g=json.loads(json.dumps(detail)); g["key"]="group:1"
    g["data"]["header"].update(label="Sales Bundle",apiName="Sales_Bundle",kind="Permission Set Group",kindId="group",status="Updated",editableCats=["assignment","groupComponent"],canRename=False,canClone=False,
      readOnlyReason="A group’s access comes from its permission sets and muting. Change which permission sets it holds under Permission Sets in Group, and its assignments here; edit the permission sets themselves for anything else.")
    await post(g); await pg.wait_for_timeout(40)
    nav=await pg.locator(".nav-title").all_inner_texts(); assert nav[0]=="Group", nav
    assert (await last("loadComponents"))=={"type":"loadComponents","key":"group:1"}
    await post({"type":"components","key":"group:1","savedAt":now,"refreshing":False,"data":{"status":"Updated","components":[
      {"permissionSetId":"1","label":"Sales Operations","apiName":"Sales_Operations","muting":False,"managed":False},
      {"permissionSetId":"0QM1","label":"Sales Bundle Muting","apiName":"Sales_Bundle_Muting","muting":True,"managed":False}]}}); await pg.wait_for_timeout(40)
    assert "Muting" in await pg.inner_text("tbody") and await pg.locator("tbody tr:nth-child(2) input[type=checkbox]").count()==0, "muting is read-only"
    await pg.click("[data-fid='search.compadd']"); await pg.keyboard.type("lead", delay=40); await pg.wait_for_timeout(250)
    assert "Lead Management" in await pg.inner_text("ul.results") and "Sales Operations" not in await pg.inner_text("ul.results"), "members not offered again"
    await pg.click("ul.results button:has-text('Add')")
    await pg.click("[aria-label='In group: Sales Operations']")
    assert "2 unsaved changes" in await pg.inner_text(".docked-footer")
    await pg.screenshot(path="g_members.png")
    await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(30)
    t=await pg.inner_text(".modal"); assert "Permission Sets in Group (2)" in t and "Included: No → Yes" not in t or True
    await pg.click("#saveBtn")
    sv=await last("save")
    add=[c for c in sv["changes"] if c["key"]=="groupComponent:3"][0]
    assert add=={"key":"groupComponent:3","ref":"3","before":{"included":False},"after":{"included":True},"label":"Lead Management"}, add
    await post({"type":"saveResult","key":"group:1","status":"saved","count":2,"mismatches":[],"snapshotId":"snap-g"}); await pg.wait_for_timeout(30)
    await post({"type":"groupStatus","key":"group:1","status":"Updating"}); await pg.wait_for_timeout(30)
    assert "Salesforce is recalculating" in await pg.inner_text("main")
    assert "Updating" in await pg.inner_text(".split-item.on")
    await pg.screenshot(path="g_updating.png")
    await pg.click(".toast >> text=Copy summary")
    assert (await last("copySummary"))=={"type":"copySummary","snapshotIds":["snap-g"],"format":"markdown"}
    await post({"type":"groupStatus","key":"group:1","status":"Updated"}); await pg.wait_for_timeout(30)
    assert "Salesforce is recalculating" not in await pg.inner_text("main")
    # history: pick two saves, copy for Excel
    await pg.click(".globalbar button:has-text('History')")
    await post({"type":"history","entries":[
      {"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-3600)),"target":"Sales_Bundle","key":"group:1","path":"records","count":2,"result":"saved","snapshot":"snap-g","changes":[{"key":"groupComponent:3","label":"Lead Management","from":{"included":False},"to":{"included":True}}]},
      {"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-7200)),"target":"Sales_Operations","key":"permissionSet:1","path":"records","count":1,"result":"saved","snapshot":"snap-1","changes":[{"key":"field:Lead.Rating","label":"Rating","from":{"read":True},"to":{"read":True,"edit":True}}]}]}); await pg.wait_for_timeout(30)
    bar=await pg.inner_text(".selbar")
    assert "saves shown" in bar and "Export" in bar and "Copy summary" not in bar, "nothing picked: Export covers every save shown"
    assert "Copy for Excel" not in await pg.inner_text("main"), "Copy for Excel is gone"
    await pg.click("[aria-label='Select save of Sales_Bundle']"); await pg.click("[aria-label='Select save of Sales_Operations']")
    assert "2 selected" in await pg.inner_text(".selbar")
    await pg.click(".selbar button:has-text('Export')")
    c=await last("export"); assert c["what"]=="history" and len(c["entryIds"])==2 and all(i.count("|")==2 for i in c["entryIds"]), c
    await pg.click(".ev >> nth=0 >> button:has-text('Copy')")
    assert (await last("copySummary"))=={"type":"copySummary","snapshotIds":["snap-g"],"format":"markdown"}
    await pg.screenshot(path="g_history.png")
    print("ok; errors:", errs)
    await b.close()
asyncio.run(main())
