import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
SYS=[{"name":"ApiEnabled","label":"API Enabled","enabled":False},{"name":"ModifyAllData","label":"Modify All Data","enabled":False},{"name":"ViewAllData","label":"View All Data","enabled":False},
     {"name":"UseAnyApiClient","label":"Use Any API Client","enabled":False},{"name":"RunReports","label":"Run Reports","enabled":True}]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":800})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    last=lambda t: pg.evaluate("t=>[...window.sent].reverse().find(m=>m.type===t)", t)
    L=json.loads(json.dumps(lists)); L["permissionSet"][0]["sessionBased"]=True
    L["profile"]=[{"key":"profile:1","kind":"profile","label":"Custom: Sales","apiName":"Custom: Sales","managed":False,"standard":False,"status":"","license":"Salesforce"},
                  {"key":"profile:2","kind":"profile","label":"System Administrator","apiName":"System Administrator","managed":False,"standard":True,"status":"","license":"Salesforce"}]
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":L,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False,"profilesFiltered":False}); await pg.wait_for_timeout(40)
    assert (await last("permDeps"))=={"type":"permDeps"}, "rules asked for once the lists arrive"
    await post({"type":"permDeps","system":{"ModifyAllData":["ViewAllData"],"PermissionsViewAllData":["PermissionsApiEnabled"]},"custom":{"0CP2":["0CP1"]}})
    assert "Session-based" in await pg.inner_text(".split-item:has-text('Sales Operations')")
    await pg.click(".split-item:has-text('Sales Operations')")
    d=json.loads(json.dumps(detail)); d["data"]["system"]=SYS; d["data"]["header"]["sessionBased"]=True
    await post(d); await pg.wait_for_timeout(40)
    assert "Session-based" in await pg.inner_text(".page-header h1")
    # --- 2. rules: Modify All Data brings View All Data and API Enabled; unticking API Enabled takes both back off
    await pg.click(".nav-item:has-text('System Permissions')"); await pg.wait_for_timeout(30)
    assert "High impact" in await pg.inner_text("tr:has-text('Use Any API Client')"), "new connected-app permission flagged"
    await pg.click("[aria-label='Modify All Data']"); await pg.wait_for_timeout(40)
    for n in ["Modify All Data","View All Data","API Enabled"]: assert await pg.is_checked(f"[aria-label='{n}']"), n
    assert "Also turned on View All Data and API Enabled, which Salesforce requires for it." in await pg.inner_text("tr:has-text('Modify All Data') .rule-note")
    assert await pg.locator(".toast").count()==0, "the note replaces the pop-up"
    await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(30)
    t=await pg.inner_text(".modal"); assert t.count("auto")>=2, t
    await pg.click(".modal button:has-text('Cancel')"); await pg.wait_for_timeout(30)
    await pg.click("[aria-label='API Enabled']"); await pg.wait_for_timeout(40)
    for n in ["Modify All Data","View All Data","API Enabled"]: assert not await pg.is_checked(f"[aria-label='{n}']"), n
    await pg.screenshot(path="rules.png", clip={"x":330,"y":200,"width":1070,"height":420})
    assert await pg.locator(".docked-footer button.neutral").count()==0 or not await pg.is_visible(".docked-footer"), "back where it started: nothing to save"
    # --- 6. Changes in Setup
    await pg.click(".nav-item:has-text('Changes in Setup')"); await pg.wait_for_timeout(30)
    assert (await last("loadAudit"))["key"]=="permissionSet:1"
    await post({"type":"audit","key":"permissionSet:1","savedAt":now,"refreshing":False,"data":{"items":[{"at":"2026-11-01T09:30:00Z","by":"Jordan Lee","action":"PermSetEnableUserPerm","section":"Manage Users","display":"Permission set Sales Operations: system permission Export Reports was changed from disabled to enabled","delegate":""}]}}); await pg.wait_for_timeout(30)
    assert "Export Reports was changed" in await pg.inner_text("main") and "Jordan Lee" in await pg.inner_text("main")
    await pg.screenshot(path="audit.png", clip={"x":330,"y":200,"width":1070,"height":300})
    await post({"type":"audit","key":"permissionSet:1","savedAt":now,"refreshing":False,"data":{"items":[],"denied":True}}); await pg.wait_for_timeout(30)
    assert "needs the View Setup Audit Trail permission" in await pg.inner_text("main")
    # --- 5. licence check on a new assignee
    await pg.click(".nav-item:has-text('Assignments')"); await pg.wait_for_timeout(20)
    await post({"type":"assignments","key":"permissionSet:1","savedAt":now,"refreshing":False,"data":{"readOnly":False,"expiration":"datetime","items":[]}}); await pg.wait_for_timeout(30)
    await pg.click("[data-fid='search.users']"); await pg.keyboard.type("ca", delay=30); await pg.wait_for_timeout(260)
    await post({"type":"users","text":"ca","users":[{"userId":"005C","name":"Cara Diaz","username":"cara@example.com","profile":"Custom: Platform"}]}); await pg.wait_for_timeout(30)
    await pg.click("ul.results button:has-text('Add')")
    assert (await last("checkAssignees"))=={"type":"checkAssignees","key":"permissionSet:1","userIds":["005C"]}
    await post({"type":"assigneeChecks","key":"permissionSet:1","blockers":{"005C":"has the Salesforce Platform user license; this permission set needs Salesforce."}}); await pg.wait_for_timeout(30)
    assert "License mismatch" in await pg.inner_text("tr:has-text('Cara Diaz')")
    await pg.click(".docked-footer button.neutral")
    # --- 3. Find access for a system permission, high-impact ones first
    await pg.click(".globalbar button:has-text('Find access')"); await pg.wait_for_timeout(30)
    await pg.click("button:has-text('System permission')")
    assert (await last("lookupOptions"))=={"type":"lookupOptions"}
    await post({"type":"lookupOptions","system":[{"name":n,"label":l} for n,l in [("ApiEnabled","API Enabled"),("ModifyAllData","Modify All Data"),("RunReports","Run Reports"),("UseAnyApiClient","Use Any API Client")]],"custom":[{"id":"0CP1","name":"Approve_Discounts","label":"Approve Discounts"}]}); await pg.wait_for_timeout(30)
    groups=await pg.evaluate("[...document.querySelectorAll('[data-fid=\"lk.perm\"] optgroup')].map(g=>g.label+':'+[...g.children].map(o=>o.textContent).join('|'))")
    assert groups[0]=="High impact:Modify All Data|Use Any API Client", groups
    await pg.select_option("[data-fid='lk.perm']","ModifyAllData")
    await pg.click(".lk-bar button.brand")
    assert (await last("lookupPermission"))=={"type":"lookupPermission","kind":"system","name":"ModifyAllData","label":"Modify All Data"}
    await post({"type":"lookupResult","result":{"permission":{"kind":"system","name":"ModifyAllData","label":"Modify All Data"},"sources":[{"permissionSetId":"ps9","key":"profile:3","kind":"profile","label":"System Administrator","users":2},{"permissionSetId":"ps1","key":"permissionSet:1","kind":"permissionSet","label":"Sales Operations","users":1}],
      "users":[{"userId":"1","name":"Ben Okafor","username":"ben@acme.example","profile":"System Administrator","objectFrom":["ps9"]},{"userId":"2","name":"Ana Lima","username":"ana@acme.example","profile":"Custom: Sales","objectFrom":["ps1"]}],"partial":[]}}); await pg.wait_for_timeout(30)
    t=await pg.inner_text("main"); assert "2 active users have Modify All Data" in t and "High impact" in t and "Granted by" in t, t[:400]
    await pg.screenshot(path="who-system.png", clip={"x":330,"y":120,"width":1070,"height":560})
    await pg.click("button:has-text('Custom permission')"); await pg.wait_for_timeout(30)
    await pg.select_option("[data-fid='lk.perm']","0CP1"); await pg.click(".lk-bar button.brand")
    assert (await last("lookupPermission"))["kind"]=="custom" and (await last("lookupPermission"))["id"]=="0CP1"
    await pg.click("text=Back to the record")
    # --- 1 & 4. profile: tab settings with profile words; copy to a permission set
    await pg.click("button.kind:has-text('Profiles')"); await pg.click(".split-item:has-text('Custom: Sales')")
    pd=json.loads(json.dumps(detail)); pd["key"]="profile:1"; pd["data"]["header"].update(kind="Profile",kindId="profile",label="Custom: Sales",apiName="Custom: Sales",canRename=False,canClone=False,canCopyToPs=True,editableCats=["object","field","user","tab","recordType","layoutAssignment","loginHours","loginIpRanges"])
    await post(pd); await pg.wait_for_timeout(40)
    await pg.click(".nav-item:has-text('Tab Settings')"); await pg.wait_for_timeout(20)
    await post({"type":"tabsDetail","key":"profile:1","savedAt":now,"refreshing":False,"data":{"items":[{"name":"standard-Lead","label":"Leads","sobject":"Lead","custom":False,"visibility":"Visible"}]}}); await pg.wait_for_timeout(30)
    opts=await pg.evaluate("[...document.querySelectorAll('select[aria-label=\"Visibility of Leads\"] option')].map(o=>o.textContent)")
    assert opts==["Default On","Default Off","Tab Hidden"], opts
    await pg.click("button:has-text('Copy to permission set')"); await pg.wait_for_timeout(30)
    assert await pg.input_value("[data-fid='ps.label']")=="Sales Access" and await pg.input_value("[data-fid='ps.name']")=="Sales_Access"
    assert "stay on the profile" in await pg.inner_text(".modal")
    await pg.screenshot(path="copy-profile.png")
    await pg.click("#psBtn")
    cp=await last("copyProfile"); assert cp["key"]=="profile:1" and cp["name"]=="Sales_Access" and cp["useLicense"]==True, cp
    await post({"type":"psSaved","mode":"copyProfile","key":"permissionSet:10","label":"Sales Access","from":"Custom: Sales","counts":{"objects":12,"fields":140,"system":38,"entities":6,"tabs":4,"recordTypes":2}}); await pg.wait_for_timeout(30)
    assert "Copied Custom: Sales into Sales Access: 12 object, 140 field, 38 system" in await pg.inner_text(".toasts")
    # --- 7. profile filtering note
    await post({"type":"lists","lists":dict(L, profile=[L["profile"][0]]),"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False,"profilesFiltered":True}); await pg.wait_for_timeout(40)
    assert "Only your own profile is visible" in await pg.inner_text(".split-list")
    print("ok; errors:", errs); await b.close()
asyncio.run(main())
