import asyncio, json, time
from playwright.async_api import async_playwright
from common import *

async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    for theme in ["dark","light"]:
      pg=await b.new_page(viewport={"width":1360,"height":760})
      errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
      await pg.goto(DARK if theme == "dark" else LIGHT)
      post=lambda m: pg.evaluate(DELIVER, m)
      sent=lambda: pg.evaluate("window.sent")
      await post(ctx); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(50)
      await pg.click("text=Sales Operations"); assert (await sent())[-1]=={"type":"select","key":"permissionSet:1"}
      await post(detail); await pg.wait_for_timeout(50)
      if theme=="light": await pg.screenshot(path="light_detail.png"); 
      await pg.click("td:has-text('Lead')")
      s=(await sent())[-2]; assert s=={"type":"openObject","key":"permissionSet:1","object":"Lead"}, s
      await post(objd); await pg.wait_for_timeout(50)
      # Edit on Description (not readable) -> Read added automatically
      await pg.click("[aria-label='Edit Description']")
      assert await pg.is_checked("[aria-label='Read Description']")
      assert await pg.locator("tr.row-edited").count()==1
      assert "1 unsaved change" in (await pg.inner_text(".docked-footer"))
      # Score is read-only: Edit disabled
      assert await pg.is_disabled("[aria-label='Edit Score']")
      # Modify All on the object -> implied flags
      await pg.click("label.cb:has-text('Modify All Records') input")
      assert await pg.is_checked("label.cb:has-text('Modify All Records') input")
      autos=await pg.locator(".perm-grid .auto").count(); assert autos==0, autos  # read/edit/delete/viewAll were already on
      await pg.click("label.cb:has-text('View All Fields') input")
      assert "2 unsaved changes" in (await pg.inner_text(".docked-footer"))
      await pg.screenshot(path=f"{theme}_object.png")
      # Bulk: Edit Access header for all shown fields
      await pg.click("th label.cb:has-text('Edit Access') input")
      n=await pg.locator("tr.row-edited").count()
      # Review
      await pg.click(".docked-footer button.brand")
      await pg.wait_for_timeout(50)
      if not await pg.is_visible(".modal"):
        await pg.screenshot(path="debug.png"); print("ERRS", errs); print(await pg.evaluate("document.querySelector('.overlay').outerHTML.slice(0,400)"))
      assert await pg.is_visible(".modal")
      assert await pg.is_disabled("#saveBtn"), "production confirm required"
      await pg.fill("#confirm","uat")
      assert not await pg.is_disabled("#saveBtn")
      await pg.screenshot(path=f"{theme}_review.png")
      await pg.click("#saveBtn")
      s=(await sent())[-1]; assert s["type"]=="save" and s["confirm"]=="uat" and s["object"]=="Lead", s
      keys=sorted(c["key"] for c in s["changes"])
      assert "object:Lead" in keys and "field:Lead.Description" in keys and "field:Lead.Score__c" not in keys, keys
      desc=[c for c in s["changes"] if c["key"]=="field:Lead.Description"][0]
      assert desc=={"key":"field:Lead.Description","ref":None,"before":{"read":False,"edit":False},"after":{"read":True,"edit":True},"label":"Description"}, desc
      lead=[c for c in s["changes"] if c["key"]=="object:Lead"][0]["after"]
      assert lead["modifyAll"] and lead["viewAllFields"] and lead["read"]
      await post({"type":"saveProgress","key":"permissionSet:1","label":"Adding field access","done":1,"total":3}); await pg.wait_for_timeout(30)
      assert "Adding field access (2 of 3)" in await pg.inner_text(".modal")
      await post({"type":"saveResult","key":"permissionSet:1","status":"saved","count":len(keys),"mismatches":[],"snapshotId":"x","undo":[{"key":"field:Lead.Description","after":{"read":False,"edit":False}}]})
      await pg.wait_for_timeout(50)
      assert not await pg.is_visible(".modal") and await pg.locator(".docked-footer").is_hidden()
      assert "saved to Sales Operations" in await pg.inner_text(".toasts")
      await pg.screenshot(path=f"{theme}_saved.png")
      # Fresh data arrives, then Undo stages the old value for review
      od2=json.loads(json.dumps(objd)); [f.update(read=True,edit=True) for f in od2["data"]["fields"] if f["apiName"]=="Description"]
      await post(od2); await pg.wait_for_timeout(30)
      await pg.click(".toast >> text=Undo")
      assert (await sent())[-1]=={"type":"undoSnapshot","snapshotId":"x"}
      await post({"type":"stageChanges","key":"permissionSet:1","changes":[{"key":"field:Lead.Description","ref":None,"before":{"read":True,"edit":True},"after":{"read":False,"edit":False}}]}); await pg.wait_for_timeout(50)
      assert await pg.is_visible(".modal") and "Description" in await pg.inner_text(".modal")
      await pg.click(".modal footer button.neutral")
      # Discard guard when switching items with unsaved edits
      await pg.click("text=Lead Management")
      assert "Discard unsaved changes?" in await pg.inner_text(".modal")
      await pg.click("text=Keep editing")
      assert (await sent())[-1]["type"]!="select" or (await sent())[-1]["key"]!="permissionSet:3"
      await pg.click(".docked-footer button.neutral")
      # System permissions
      await pg.click(".nav-item:has-text('Object Settings')")
      await pg.click(".nav-item:has-text('System Permissions')")
      await pg.click("[aria-label='Export Reports']")
      assert "1 unsaved change" in await pg.inner_text(".docked-footer")
      await pg.screenshot(path=f"{theme}_system.png")
      await pg.click(".docked-footer button.neutral")
      # Read-only group
      await pg.click("button.kind:has-text('Groups')"); await pg.click("text=Sales Bundle")
      g=json.loads(json.dumps(detail)); g["key"]="group:1"; g["data"]["header"].update(label="Sales Bundle",kind="Permission Set Group",kindId="group",editable=True,editableCats=["assignment"],readOnlyReason="Permission set group access comes from its permission sets and muting. Edit those permission sets instead.")
      await post(g); await pg.wait_for_timeout(50)
      assert await pg.is_disabled("[aria-label='Export Reports']")
      if theme=="dark": await pg.screenshot(path="dark_group.png")
      print(theme, "ok; bulk-edited rows:", n, "errors:", errs)
      await pg.close()
    await b.close()
asyncio.run(main())
