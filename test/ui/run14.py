import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:400]))
TODAY=time.strftime('%Y-%m-%d')
HEALTH={"generatedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),"expiringDays":30,"notes":[],
  "summary":{"unusedPermissionSets":2,"unusedGroups":1,"unusedProfiles":1,"emptyPermissionSets":1,"inactiveAssignments":2,"expiring":1,"highImpactUsers":2,"integrationAdmins":1},
  "unusedPermissionSets":[{"key":"permissionSet:3","label":"Lead Management","apiName":"Lead_Management","managed":False,"inactiveUsers":1},{"key":"permissionSet:2","label":"Report Builder","apiName":"acme__Report_Builder","managed":True,"inactiveUsers":0}],
  "unusedGroups":[{"key":"group:1","label":"Old Bundle","apiName":"Old_Bundle","managed":False,"members":2,"inactiveUsers":0}],
  "unusedProfiles":[{"key":"profile:9","label":"Custom: Legacy","apiName":"Custom: Legacy","standard":False,"inactiveUsers":3},{"key":"profile:8","label":"Read Only","apiName":"Read Only","standard":True,"inactiveUsers":0}],
  "emptyPermissionSets":[{"key":"permissionSet:4","label":"API Integration User","apiName":"API_Integration_User","activeUsers":0}],
  "inactiveAssignments":[{"assignmentId":"0Pa1","userId":"005C","name":"Cara Diaz","username":"cara@acme.example","profile":"Custom: Sales","lastLogin":"2026-03-02","key":"permissionSet:1","itemLabel":"Sales Operations","kind":"permissionSet","expires":""},
    {"assignmentId":"0Pa2","userId":"005D","name":"Dev Old","username":"dev@acme.example","profile":"Custom: Sales","lastLogin":"","key":"permissionSet:3","itemLabel":"Lead Management","kind":"permissionSet","expires":""}],
  "expiring":[{"assignmentId":"0Pa3","userId":"005A","name":"Ana Lima","username":"ana@acme.example","profile":"Custom: Sales","lastLogin":TODAY,"key":"permissionSet:1","itemLabel":"Sales Operations","kind":"permissionSet","expires":TODAY,"daysLeft":5}],
  "highImpact":[{"name":"ModifyAllData","label":"Modify All Data","users":[{"userId":"005I","name":"Integration Bot","username":"bot@acme.example","profile":"System Administrator","lastLogin":"","sources":["System Administrator"]},{"userId":"005B","name":"Ben Okafor","username":"ben@acme.example","profile":"System Administrator","lastLogin":"","sources":["System Administrator"]}]}],
  "integrationAdmins":[{"userId":"005I","name":"Integration Bot","username":"bot@acme.example","profile":"System Administrator","lastLogin":"","why":"API Only User","permissions":["Modify All Data","View All Data"],"sources":["System Administrator"]}]}
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":860})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate(DELIVER, m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t)", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    await pg.click(".globalbar button:has-text('Health')"); await pg.wait_for_timeout(30)
    t=await pg.inner_text("main")
    check("H1 the Health page opens on the health check, explaining what it checks", "Health check" in t and "Assignments to inactive users" in t and "Check now" in t, t[:300])
    await pg.select_option("[data-fid='hc.days']","60"); await pg.click("button:has-text('Check now')"); await pg.wait_for_timeout(30)
    check("H2 checking sends the expiry window and shows a placeholder", (await sent("healthCheck"))[-1]=={"type":"healthCheck","expiringDays":60} and await pg.locator(".skeleton").count()>0)
    await post({"type":"health","data":HEALTH}); await pg.wait_for_timeout(40)
    cards=await pg.locator(".hc-card").all_inner_texts()
    check("H3 eight summary cards with the counts", len(cards)==8 and any("1\nintegration users with admin access" in c for c in cards), cards)
    check("H4 managed and standard items are hidden until asked", "Report Builder" not in await pg.inner_text("#hc-unusedPs") and "Read Only" not in await pg.inner_text("#hc-unusedProfiles"))
    await pg.click("#hc-unusedPs .toggle:has-text('Include managed packages')"); await pg.wait_for_timeout(20)
    check("H5 ...and shown when asked", "Report Builder" in await pg.inner_text("#hc-unusedPs"))
    await pg.click("#hc-high button:has-text('Modify All Data')"); await pg.wait_for_timeout(20)
    check("H6 a high-impact permission lists its users and sources", "Integration Bot" in await pg.inner_text("#hc-high") and "Ben Okafor" in await pg.inner_text("#hc-high"))
    await pg.click("[aria-label='Select all'] >> nth=0"); await pg.wait_for_timeout(20)
    await pg.click("#hc-inactive button:has-text('Remove 2')"); await pg.wait_for_timeout(20)
    check("H7 removing the inactive users' assignments asks for a plan", (await sent("healthPlan"))[-1]=={"type":"healthPlan","action":"remove","assignmentIds":["0Pa1","0Pa2"],"days":90}, (await sent("healthPlan"))[-1])
    await post({"type":"healthPlan","action":"remove","plan":[{"key":"permissionSet:1","label":"Sales Operations","kind":"permissionSet","changes":[{"key":"assignment:005C","ref":"005C","label":"Cara Diaz","before":{"assigned":True,"expires":None},"after":{"assigned":False,"expires":None}}]}],"skipped":[]}); await pg.wait_for_timeout(30)
    t=await pg.inner_text("main")
    check("H8 the plan is reviewed before saving", "Remove assignments of inactive users" in t and "Cara Diaz" in t, t[:400])
    await pg.click("#wzApply"); await pg.wait_for_timeout(20)
    check("H9 saving goes through the bulk save", (await sent("healthApply"))[-1]["plan"][0]["key"]=="permissionSet:1")
    await post({"type":"wizardResult","results":[{"key":"permissionSet:1","label":"Sales Operations","status":"saved","count":1}]}); await pg.wait_for_timeout(30)
    check("H10 the result shows, and Back runs the check again", "1 of 1 saved" in await pg.inner_text("main"))
    await pg.click("button:has-text('Back to results')"); await pg.wait_for_timeout(20)
    check("H11 ...", (await sent("healthCheck"))[-1]["type"]=="healthCheck")
    await post({"type":"health","data":HEALTH}); await pg.wait_for_timeout(30)
    await pg.select_option("[data-fid='hc.extend']","180"); await pg.click("[aria-label^='Select Ana Lima']"); await pg.click("#hc-expiring button:has-text('Extend 1')"); await pg.wait_for_timeout(20)
    check("H12 extending sends the days chosen", (await sent("healthPlan"))[-1]=={"type":"healthPlan","action":"extend","assignmentIds":["0Pa3"],"days":180})
    await post({"type":"healthPlan","action":"extend","plan":[{"key":"permissionSet:1","label":"Sales Operations","kind":"permissionSet","changes":[{"key":"assignment:005A","ref":"005A","label":"Ana Lima","before":{"assigned":True,"expires":TODAY},"after":{"assigned":True,"expires":"2027-01-01"}}]}],"skipped":[]}); await pg.wait_for_timeout(30)
    check("H12b the extension plan names the change", "Extend assignments" in await pg.inner_text("main") and "Ana Lima" in await pg.inner_text("main"))
    await pg.click(".btns button:has-text('Back')"); await pg.wait_for_timeout(30)
    await pg.click(".hc-bar button:has-text('Export')"); await pg.wait_for_timeout(20)
    check("H13 Export (one Excel workbook)", (await sent("export"))[-1]=={"type":"export","what":"health"} and "CSV" not in await pg.inner_text("main"))
    await post({"type":"exported","path":"/home/me/project/access-health-uat.xlsx","sheets":9}); await pg.wait_for_timeout(30)
    t=await pg.inner_text(".toasts")
    check("H13b the Exported notice offers Open and Show in folder", "access-health-uat.xlsx (9 sheets)" in t and "Open" in t and "Show in folder" in t, t)
    await pg.click(".toasts button:has-text('Show in folder')"); await pg.wait_for_timeout(20)
    check("H13c Show in folder", (await sent("revealFile"))[-1]=={"type":"revealFile","path":"/home/me/project/access-health-uat.xlsx"})
    await pg.click("#hc-integration button.link:has-text('Integration Bot')"); await pg.wait_for_timeout(20)
    check("H14 a user opens in User access", (await sent("userAccess"))[-1]=={"type":"userAccess","userId":"005I"} and "User access" in await pg.inner_text("main"))
    # ---- consistent shapes: buttons rectangles, dropdowns and search boxes pills
    await pg.click(".globalbar button:has-text('Health')"); await pg.wait_for_timeout(30)
    shapes=await pg.evaluate("""()=>{const r=e=>parseFloat(getComputedStyle(e).borderTopLeftRadius);
      const grouped=e=>e.closest('.btn-group, .seg');
      const groups=[...document.querySelectorAll('.btn-group, .seg')].map(g=>parseFloat(getComputedStyle(g).borderTopLeftRadius) || parseFloat(getComputedStyle(g.firstElementChild).borderTopLeftRadius));
      return {buttons:[...document.querySelectorAll('.btn')].filter(e=>!grouped(e)).map(r).concat(groups), selects:[...document.querySelectorAll('select.select')].map(r), searches:[...document.querySelectorAll('.search input, .combo > input')].map(r)}}""")
    check("C1 every button has the same rectangle corners", len(set(shapes['buttons']))==1 and shapes['buttons'][0]<=6, set(shapes['buttons']))
    check("C2 every dropdown and search box is a pill", shapes['selects'] and shapes['searches'] and min(shapes['selects']+shapes['searches'])>=100, shapes)
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
