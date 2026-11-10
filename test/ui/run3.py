import time
import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1440,"height":860})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    sent=lambda: pg.evaluate("window.sent")
    last=lambda t: pg.evaluate("t=>[...window.sent].reverse().find(m=>m.type===t)", t)
    await post(dict(ctx,production=True)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(50)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(50)
    nav=await pg.locator(".nav-item").all_inner_texts()
    assert [n.split('\n')[0] for n in nav][:3]==["Assigned Apps","Object Settings","Apex Class Access"], nav
    assert any("Tab Settings" in n for n in nav) and any("Assignments" in n for n in nav) and not any("Login Hours" in n for n in nav)
    await pg.screenshot(path="s_nav.png")
    # local file offered in review
    await post({"type":"localFile","key":"permissionSet:1","path":"force-app/main/default/permissionsets/Sales_Operations.permissionset-meta.xml","mode":"ask"})
    # tab settings
    await pg.click(".nav-item:has-text('Tab Settings')")
    assert (await last("loadTabs"))=={"type":"loadTabs","key":"permissionSet:1"}
    await post({"type":"tabsDetail","key":"permissionSet:1","savedAt":now,"refreshing":False,"data":{"items":[{"name":"standard-Account","label":"Accounts","visibility":"None"},{"name":"standard-Lead","label":"Leads","visibility":"Visible"}]}}); await pg.wait_for_timeout(40)
    assert await pg.locator("tbody tr").count()==1
    await pg.click("text=Show only set"); await pg.wait_for_timeout(30)
    await pg.select_option("[aria-label='Visibility of Accounts']","Available")
    assert "1 unsaved change" in await pg.inner_text(".docked-footer")
    # assignments
    await pg.click(".nav-item:has-text('Assignments')")
    await post({"type":"assignments","key":"permissionSet:1","savedAt":now,"refreshing":False,"data":{"readOnly":False,"expiration":"datetime","items":[{"userId":"005A","name":"Ana Lima","username":"ana@example.com","profile":"Custom: Sales","assigned":True,"expires":None},{"userId":"005B","name":"Ben Okafor","username":"ben@example.com","profile":"System Administrator","assigned":True,"expires":"2026-12-31"}]}}); await pg.wait_for_timeout(40)
    await pg.click("[data-fid='search.users']"); await pg.keyboard.type("cara", delay=40); await pg.wait_for_timeout(250)
    assert (await last("userSearch"))=={"type":"userSearch","text":"cara"}
    assert await pg.evaluate("document.activeElement.value")=="cara"
    await post({"type":"users","text":"cara","users":[{"userId":"005C","name":"Cara Diaz","username":"cara@example.com","profile":"Custom: Sales"}]}); await pg.wait_for_timeout(40)
    await pg.click("ul.results button:has-text('Add')")
    assert "New" in await pg.inner_text("tbody tr:first-child")
    await pg.click("[aria-label='Assigned to Ana Lima']")
    await pg.fill("[aria-label='Expiry for Ben Okafor']","2027-03-31"); await pg.dispatch_event("[aria-label='Expiry for Ben Okafor']","change"); await pg.wait_for_timeout(30)
    assert "4 unsaved changes" in await pg.inner_text(".docked-footer"), await pg.inner_text(".docked-footer")
    await pg.screenshot(path="s_assign.png")
    # review shows everything, local file box, prod confirm
    await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(40)
    txt=await pg.inner_text(".modal")
    assert "Tab Settings (1)" in txt and "Assignments (3)" in txt and "Expires: 2026-12-31 → 2027-03-31" in txt and "Visibility: None → Available" in txt, txt
    assert "Also update force-app/main/default/permissionsets/Sales_Operations.permissionset-meta.xml" in txt
    await pg.fill("#confirm","uat"); await pg.click("#saveBtn")
    s=await last("save")
    assert s["writeLocal"] is True and len(s["changes"])==4
    cara=[c for c in s["changes"] if c["key"]=="assignment:005C"][0]
    assert cara=={"key":"assignment:005C","ref":"005C","before":{"assigned":False,"expires":None},"after":{"assigned":True,"expires":None},"label":"Cara Diaz"}, cara
    await pg.screenshot(path="s_review.png")
    await post({"type":"saveResult","key":"permissionSet:1","status":"saved","count":4,"mismatches":[],"snapshotId":"s1","local":{"path":"force-app/x.xml","applied":2,"skipped":2}}); await pg.wait_for_timeout(40)
    assert "Updated force-app/x.xml" in await pg.inner_text(".toasts")
    # removed in 2.0.0
    assert await pg.locator(".globalbar button:has-text('New')").count()==0
    assert await pg.locator(".ph-actions button:has-text('Export'), .ph-actions button:has-text('CSV')").count()==0
    assert "default org" not in await pg.inner_text(".globalbar")
    # clone
    await pg.click(".ph-actions button:has-text('Clone')")
    assert await pg.input_value("[data-fid='ps.name']")=="Copy_of_Sales_Operations"
    await pg.click(".modal footer button.neutral")
    # lookup tool: one box for object or field
    await pg.click("text=Find access")
    assert (await last("objectCatalog"))=={"type":"objectCatalog"}
    await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"},{"name":"Account","label":"Account"}]}); await pg.wait_for_timeout(30)
    await pg.click("[data-fid='lk.target']"); await pg.keyboard.type("Lead.Rat", delay=20); await pg.wait_for_timeout(40)
    assert (await last("wizardFields"))=={"type":"wizardFields","object":"Lead"}
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.Rating","apiName":"Rating","label":"Rating","type":"picklist","custom":False,"canEdit":True}]}); await pg.wait_for_timeout(30)
    await pg.keyboard.type("ing", delay=20); await pg.dispatch_event("[data-fid='lk.target']","change"); await pg.wait_for_timeout(30)
    await pg.select_option("[aria-label='Access']","edit")
    await pg.click(".lk-bar button.brand")
    assert (await last("lookup"))=={"type":"lookup","object":"Lead","field":"Rating","level":"edit"}, await last("lookup")
    res={"object":"Lead","field":"Lead.Rating","level":"edit","sources":[{"permissionSetId":"0PS1","key":"permissionSet:1","kind":"permissionSet","label":"Sales Operations","apiName":"Sales_Operations","objectVia":["object"],"fieldVia":["field"],"users":2},
      {"permissionSetId":"0PS9","key":"profile:1","kind":"profile","label":"System Administrator","apiName":"X","objectVia":["ModifyAllData"],"fieldVia":[],"users":1}],
      "users":[{"userId":"1","name":"Ana Lima","username":"ana@example.com","profile":"Custom: Sales","license":"Salesforce","objectFrom":["0PS1"],"fieldFrom":["0PS1"]},{"userId":"2","name":"Ben Okafor","username":"ben@example.com","profile":"System Administrator","license":"Salesforce","objectFrom":["0PS1","0PS9"],"fieldFrom":["0PS1"]}],
      "partial":[{"userId":"3","name":"Cara Diaz","objectFrom":["0PS9"],"fieldFrom":[]}],"inactive":[]}
    await post({"type":"lookupResult","result":res}); await pg.wait_for_timeout(40)
    t=await pg.inner_text("main")
    assert "2 active users have Edit on Lead.Rating" in t and "Modify All Data" in t and "1 more user has only half" in t, t[:600]
    assert "Recent:" in t and "Lead.Rating (Edit)" in t, "recent searches"
    await pg.select_option("[aria-label='Profile']","System Administrator"); await pg.wait_for_timeout(30)
    rows=await pg.locator(".lk-cols tbody tr td b").all_inner_texts(); assert "Ben Okafor" in rows and "Ana Lima" not in rows, rows
    await pg.click(".lk-cols button:has-text('Why?')"); await pg.wait_for_timeout(20)
    assert "How Ben gets Edit on Lead.Rating" in await pg.inner_text("main")
    await pg.click("[aria-label='Select Sales Operations']"); await pg.click("button:has-text('Remove from selected')")
    assert (await last("revokePlan"))=={"type":"revokePlan","object":"Lead","field":"Lead.Rating","level":"edit","sourceKeys":["permissionSet:1"]}
    await post({"type":"revokePlan","plan":[{"key":"permissionSet:1","label":"Sales Operations","kind":"permissionSet","changes":[{"key":"field:Lead.Rating","before":{"read":True,"edit":True},"after":{"read":True,"edit":False},"label":"Lead.Rating"}]}],"skipped":[]}); await pg.wait_for_timeout(30)
    assert "Remove access from selected sources" in await pg.inner_text("main") and "− Edit" in await pg.inner_text("main")
    await pg.click("button:has-text('Back')"); await pg.wait_for_timeout(20)
    await pg.screenshot(path="s_lookup.png")
    # field grant: what each item has now, and what changes
    await pg.click("text=Grant field access")
    await pg.fill("[data-fid='wz.obj']","Lead"); await pg.dispatch_event("[data-fid='wz.obj']","change"); await pg.wait_for_timeout(30)
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.Rating","apiName":"Rating","label":"Rating","type":"picklist","custom":False,"canEdit":True},{"name":"Lead.Score__c","apiName":"Score__c","label":"Score","type":"double","custom":True,"canEdit":False},{"name":"Lead.Tier__c","apiName":"Tier__c","label":"Tier","type":"picklist","custom":True,"canEdit":True}]}); await pg.wait_for_timeout(30)
    assert await pg.locator("td.strong:text-is('Rating')").count()==0, "custom only by default"
    await pg.click("[aria-label='Tier']"); await pg.click("[aria-label='Score']")
    await pg.click("text=Read and Edit")
    wc=await last("wizardCurrent"); assert wc["object"]=="Lead" and sorted(wc["fields"])==["Lead.Score__c","Lead.Tier__c"], wc
    await post({"type":"wizardCurrent","object":"Lead","fields":wc["fields"],"byKey":{"permissionSet:1":{"users":18,"objectRead":True,"fields":{"Lead.Tier__c":{"read":True,"edit":False}}},"permissionSet:3":{"users":6,"objectRead":False,"fields":{}}}}); await pg.wait_for_timeout(30)
    await post({"type":"favorites","items":["permissionSet:Sales_Operations"],"objects":[]}); await pg.wait_for_timeout(20)
    await pg.click("button:has-text('Add favorites')")
    await pg.click("[aria-label='Lead Management']")
    t=await pg.inner_text("main")
    assert "2 selected" in t and "reaching up to 24 users" in t and "4 field changes" in t, t[:900]
    assert "Grant Read and Edit on Lead where it’s missing (1 item)" in t
    await pg.screenshot(path="s_wizard.png")
    await pg.click(".grant-sum button.brand")
    wp=await last("wizardPlan"); assert wp["level"]=="edit" and sorted(f["apiName"] for f in wp["fields"])==["Score__c","Tier__c"] and set(wp["targets"])=={"permissionSet:1","permissionSet:3"} and wp["grantObject"] is True, wp
    plan={"type":"wizardPlan","object":"Lead","plan":[{"key":"permissionSet:1","label":"Sales Operations","kind":"permissionSet","changes":[{"key":"field:Lead.Tier__c","before":{"read":False,"edit":False},"after":{"read":True,"edit":True},"label":"Tier"}]}],"skipped":[{"key":"permissionSet:3","label":"Lead Management","reason":"Already has this access."}]}
    await post(plan); await pg.wait_for_timeout(30)
    t=await pg.inner_text("main"); assert "Tier" in t and "+ Read" in t and "+ Edit" in t, t[:600]
    assert await pg.is_disabled("#wzApply"), "production confirm"
    await pg.fill("[data-fid='wizardApply.confirm']","uat"); await pg.dispatch_event("[data-fid='wizardApply.confirm']","input")
    await pg.click("#wzApply")
    assert (await last("wizardApply"))["confirm"]=="uat"
    await post({"type":"wizardProgress","done":0,"total":1,"label":"Sales Operations"}); await pg.wait_for_timeout(20)
    await post({"type":"wizardResult","results":[{"key":"permissionSet:1","label":"Sales Operations","status":"saved","count":1}]}); await pg.wait_for_timeout(30)
    assert "1 of 1 saved." in await pg.inner_text("main")
    # object grant: one grid of items x permissions
    await pg.click("text=Grant object access")
    await pg.fill("[data-fid='ow.obj']","Lead"); await pg.dispatch_event("[data-fid='ow.obj']","change"); await pg.wait_for_timeout(30)
    assert (await last("objWizardInfo"))=={"type":"objWizardInfo","object":"Lead"}
    await post({"type":"objWizardInfo","object":"Lead","columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],"recordTypes":[{"name":"Lead.Direct","developerName":"Direct","label":"Direct Lead","active":True},{"name":"Lead.Partner","developerName":"Partner","label":"Partner Lead","active":True}]}); await pg.wait_for_timeout(30)
    assert (await last("objWizardCurrent"))=={"type":"objWizardCurrent","object":"Lead"}
    await post({"type":"objWizardCurrent","object":"Lead","byKey":{"permissionSet:1":{"users":18,"props":{"read":True,"edit":True}},"permissionSet:3":{"users":6,"props":{"read":True}}}}); await pg.wait_for_timeout(30)
    assert await pg.locator("tr:has-text('Lead Management') .gc.on").count()==1, "Read already granted shows a grey tick"
    await pg.click("[aria-label='Grant modifyAll to Lead Management']"); await pg.wait_for_timeout(20)
    for f in ['edit','delete','viewAll','modifyAll']: assert await pg.locator(f"[aria-label='Don’t grant {f} to Lead Management']").count()==1, f
    assert await pg.locator(".auto").count()==0, "no auto tags"
    await pg.click("[aria-label='Don’t grant delete to Lead Management']"); await pg.wait_for_timeout(20)
    assert await pg.locator("[aria-label='Grant modifyAll to Lead Management']").count()==1, "unticking Delete drops Modify All"
    await pg.click("[aria-label='Default Partner Lead']")
    assert await pg.is_checked("[aria-label='Partner Lead']")
    await pg.click(".col-set:has-text('Create')"); await pg.wait_for_timeout(20)
    await pg.screenshot(path="s_objwizard.png")
    await pg.click(".card-body.btns button.brand")
    op=await last("objWizardPlan")
    assert op["recordTypes"]==["Lead.Partner"] and op["defaultRt"]=="Lead.Partner" and sorted(op["perTarget"]["permissionSet:3"])==["create","edit","read","viewAll"], op
    assert sorted(op["perTarget"]["permissionSet:1"])==["create","edit","read"] and sorted(op["perTarget"]["permissionSet:4"])==["create","read"], "setting a column for everyone shown"
    await post({"type":"objWizardPlan","object":"Lead","plan":[{"key":"permissionSet:3","label":"Lead Management","kind":"permissionSet","changes":[{"key":"object:Lead","before":{"read":True},"after":{"read":True,"edit":True,"viewAll":True},"label":"Lead"},{"key":"recordType:Lead.Partner","before":{"visible":False},"after":{"visible":True},"label":"Partner"}]}],"skipped":[]}); await pg.wait_for_timeout(30)
    t=await pg.inner_text("main")
    assert "Partner" in t and "+ Assigned" in t and "Metadata API deploy per item" in t, t
    await pg.fill("[data-fid='objWizardApply.confirm']","uat"); await pg.dispatch_event("[data-fid='objWizardApply.confirm']","input")
    await pg.click("#wzApply"); assert (await last("objWizardApply"))["plan"][0]["key"]=="permissionSet:3"
    await post({"type":"objWizardResult","results":[{"key":"permissionSet:3","label":"Lead Management","status":"saved","count":2}]}); await pg.wait_for_timeout(30)
    assert "1 of 1 saved." in await pg.inner_text("main")
    # auto-refresh asks again for what is on screen, without losing edits
    await pg.click("button:has-text('Done')")
    # history tool and undo
    await pg.click(".globalbar button:has-text('History')")
    await post({"type":"history","entries":[{"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-3600)),"org":"u","target":"Sales_Operations","key":"permissionSet:1","path":"records","count":1,"result":"saved","snapshot":"snap-9","changes":[{"key":"field:Lead.Rating","from":{"read":True,"edit":False},"to":{"read":True,"edit":True}}]},
      {"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-86400)),"org":"u","target":"Lead_Management","key":"permissionSet:3","path":"records + deploy","count":2,"result":"failed","error":"boom","snapshot":"snap-8"}]}); await pg.wait_for_timeout(30)
    assert await pg.locator("button:has-text('Undo…')").count()==1, "failed saves can't be undone"
    await pg.screenshot(path="s_history.png")
    await pg.click("button:has-text('Undo…')"); assert (await last("undoSnapshot"))=={"type":"undoSnapshot","snapshotId":"snap-9"}
    await post({"type":"stageChanges","key":"permissionSet:1","changes":[{"key":"field:Lead.Rating","ref":None,"before":{"read":True,"edit":True},"after":{"read":True,"edit":False}}]}); await pg.wait_for_timeout(40)
    assert (await last("select"))["key"]=="permissionSet:1", "reopens the item to get fresh values"
    await post(detail); await pg.wait_for_timeout(40)
    assert await pg.is_visible(".modal") and "− Edit" in await pg.inner_text(".modal")
    await pg.click(".modal footer button.neutral"); await pg.click(".docked-footer button.neutral")
    # profile: login hours, IP ranges, layouts
    await pg.click("button.kind:has-text('Profiles')"); await pg.click(".split-item:has-text('System Administrator')")
    pd=json.loads(json.dumps(detail)); pd["key"]="profile:1"; pd["data"]["header"].update(label="Custom: Sales",kind="Profile",kindId="profile",canRename=False,canClone=False,editableCats=["object","field","user","recordType","layoutAssignment","loginHours","loginIpRanges"])
    await post(pd); await pg.wait_for_timeout(30)
    nav=await pg.locator(".nav-item").all_inner_texts()
    assert any("Login Hours" in n for n in nav) and any(n.startswith("Users") for n in nav) and any("Tab Settings" in n for n in nav), nav
    await pg.click(".nav-item:has-text('Login Hours')")
    await post({"type":"loginSettings","key":"profile:1","savedAt":now,"refreshing":False,"data":{"hours":{"mondayStart":"480","mondayEnd":"1080"},"ranges":[{"startAddress":"10.0.0.0","endAddress":"10.0.0.255","description":"Office"}]}}); await pg.wait_for_timeout(30)
    assert await pg.input_value("[aria-label='monday start']")=="480"
    await pg.select_option("[aria-label='friday start']","420")
    await pg.click("button:has-text('Add range')")
    await pg.fill("[aria-label='Start IP 2']","192.168.1.0"); await pg.dispatch_event("[aria-label='Start IP 2']","change")
    await pg.fill("[aria-label='End IP 2']","192.168.1.255"); await pg.dispatch_event("[aria-label='End IP 2']","change"); await pg.wait_for_timeout(30)
    assert "2 unsaved changes" in await pg.inner_text(".docked-footer")
    await pg.screenshot(path="s_login.png")
    await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(30)
    t=await pg.inner_text(".modal")
    assert "Friday Start: — → 7:00 AM" in t and "IP ranges: 10.0.0.0–10.0.0.255 → 10.0.0.0–10.0.0.255, 192.168.1.0–192.168.1.255" in t and "Metadata API deploy" in t, t
    await pg.click(".modal footer button.neutral"); await pg.click(".docked-footer button.neutral")
    await pg.click(".nav-item:has-text('Object Settings')"); await pg.click("td:has-text('Lead') >> nth=0")
    po=json.loads(json.dumps(objd)); po["key"]="profile:1"; await post(po)
    assert (await last("loadLayouts"))=={"type":"loadLayouts","key":"profile:1","object":"Lead"}
    await post({"type":"layouts","key":"profile:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","layouts":[{"name":"Lead-Lead Layout","label":"Lead Layout"},{"name":"Lead-Partner Layout","label":"Partner Layout"}],
      "rows":[{"key":"layoutAssignment:Lead.","recordType":None,"label":"Master","layout":"Lead-Lead Layout"},{"key":"layoutAssignment:Lead.Partner","recordType":"Lead.Partner","label":"Partner Lead","layout":""}]}})
    await post({"type":"recordTypes","key":"profile:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":True,"items":[]}}); await pg.wait_for_timeout(40)
    await pg.select_option("[aria-label='Layout for Partner Lead']","Lead-Partner Layout")
    assert "1 unsaved change" in await pg.inner_text(".docked-footer")
    await pg.screenshot(path="s_layouts.png", full_page=False)
    print("ok; errors:", errs)
    await b.close()
asyncio.run(main())
