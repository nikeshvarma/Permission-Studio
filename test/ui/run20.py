import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:400]))
UA={"user":{"id":"005A","name":"Avery Chen","username":"avery@acme.example","active":True,"profile":"Custom: Sales","license":"Salesforce","role":"Account Executive"},
  "licenses":["Sales Cloud Einstein","CRM User","Billing","Revenue Cloud User","Data Processing Engine","Usage Management Run Time","Product Catalog Management Viewer","Rate Management Design Time"],
  "sources":[{"permissionSetId":"a","kind":"profile","label":"Custom: Sales","key":"profile:1"},{"permissionSetId":"b","kind":"permissionSet","label":"Sales Operations","key":"permissionSet:1"},{"permissionSetId":"c","kind":"group","label":"Sales Team Bundle","key":"group:1"}],
  "objects":[{"name":"Account","flags":{"read":[0,1]}},{"name":"Lead","flags":{"read":[1],"edit":[1]}}],
  "system":[{"name":"ApiEnabled","label":"API Enabled","sources":[0]}],
  "custom":[{"name":"Approve_Discounts","label":"Approve Discounts","sources":[1]},{"name":"View_Forecasts","label":"View Forecasts","sources":[2]}]}
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":860})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate(DELIVER, m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t)", t)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    check("1 the top bar has no Log button (Permission Studio: Show Log is in the Command Palette)", await pg.locator(".globalbar button:text-is('Log')").count()==0)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    # ---- User access: field search, custom permissions search
    await pg.click(".globalbar button:has-text('User access')"); await pg.fill("[data-fid='ua.q']","Ave"); await pg.dispatch_event("[data-fid='ua.q']","input"); await pg.wait_for_timeout(250)
    await post({"type":"users","text":"Ave","users":[{"userId":"005A","name":"Avery Chen","username":"avery@acme.example","profile":"Custom: Sales"}]}); await pg.wait_for_timeout(30)
    await pg.click(".results button >> nth=0"); await post({"type":"userAccess","userId":"005A","data":UA}); await pg.wait_for_timeout(40)
    await pg.fill("[data-fid='ua.fieldQ']","rating"); await pg.dispatch_event("[data-fid='ua.fieldQ']","input"); await pg.wait_for_timeout(250)
    req=(await sent("userFields"))[-1]
    check("2 searching fields asks once for every field this user has, across all objects", req.get("object") is None and req["ids"]==["a","b","c"], req)
    await post({"type":"userFields","userId":"005A","object":None,"fields":[{"field":"Account.Rating","read":[0],"edit":[]},{"field":"Lead.Rating","read":[1],"edit":[1]},{"field":"Lead.Company","read":[1],"edit":[]}]}); await pg.wait_for_timeout(40)
    rows=await pg.evaluate("()=>[...document.querySelectorAll('main section.card')].find(s=>s.innerText.startsWith('Field permissions')).querySelectorAll('tbody tr').length")
    t=await pg.inner_text("main")
    check("3 ...and shows the matching fields from every object", rows==2 and "Account.Rating" in t and "Lead.Rating" in t and "Lead.Company" not in t, rows)
    await pg.fill("[data-fid='ua.cusQ']","forecast"); await pg.dispatch_event("[data-fid='ua.cusQ']","input"); await pg.wait_for_timeout(250)
    cus=await pg.evaluate("()=>{const s=[...document.querySelectorAll('main section.card')].find(s=>s.innerText.startsWith('Custom permissions')); return {rows: s.querySelectorAll('tbody tr').length, scroll: !!s.querySelector('.scroll-y'), text: s.innerText}}")
    check("4 custom permissions: a searchable, scrolling table like System permissions", cus['rows']==1 and cus['scroll'] and "View Forecasts" in cus['text'] and "Approve Discounts" not in cus['text'], cus)
    # ---- pills: a second row lines up with the first, with a gap between rows
    al=await pg.evaluate("""()=>{const w=[...document.querySelectorAll('.pills')].find(p=>{const t=[...p.children].map(c=>Math.round(c.getBoundingClientRect().top)); return new Set(t).size>1}); if(!w) return null;
      const kids=[...w.children].map(c=>c.getBoundingClientRect()); const rows=[...new Set(kids.map(r=>Math.round(r.top)))];
      const firstOf=top=>kids.filter(r=>Math.round(r.top)===top).sort((a,b)=>a.left-b.left)[0];
      const r0=firstOf(rows[0]), r1=firstOf(rows[1]); return {lefts:[Math.round(r0.left),Math.round(r1.left)], gap: Math.round(r1.top-r0.bottom)}}""")
    check("5 wrapped pills: the second row starts where the first does, with a gap between rows", al and al['lefts'][0]==al['lefts'][1] and al['gap']>=5, al)
    # ---- Health: each finding searches its rows, in a scrolling table; Select all follows the search
    await pg.click(".globalbar button:has-text('Health')"); await pg.click("button:has-text('Check now')")
    H=json.load(open(DATA / 'health.json')); await post({"type":"health","data":H}); await pg.wait_for_timeout(60)
    await pg.fill("[data-fid='hc.q.inactive']","dev"); await pg.dispatch_event("[data-fid='hc.q.inactive']","input"); await pg.wait_for_timeout(250)
    hi=await pg.evaluate("()=>{const s=document.getElementById('hc-inactive'); return {rows: s.querySelectorAll('tbody tr').length, scroll: !!s.querySelector('.scroll-y'), text: s.innerText}}")
    check("6 a health finding searches its rows, in a scrolling table", hi['rows']==1 and hi['scroll'] and "Dev Old" in hi['text'] and "Cara Diaz" not in hi['text'], hi)
    await pg.click("#hc-inactive th [aria-label='Select all']"); await pg.wait_for_timeout(40)
    check("7 Select all takes only the rows the search shows", "Remove 1" in await pg.inner_text("#hc-inactive .card-head"), await pg.inner_text("#hc-inactive .card-head"))
    # ---- the review: a generic ticket placeholder
    await pg.click("#hc-inactive button:has-text('Remove 1')"); await pg.wait_for_timeout(30)
    await post({"type":"healthPlan","action":"remove","plan":[{"key":"permissionSet:3","label":"Lead Management","kind":"permissionSet","changes":[{"key":"assignment:005D","ref":"005D","label":"Dev Old","before":{"assigned":True,"expires":None},"after":{"assigned":False,"expires":None}}]}],"skipped":[]}); await pg.wait_for_timeout(80)
    ph=await pg.get_attribute(".modal [data-fid='rv.ticket']", "placeholder")
    check("8 the review's ticket box asks for a user story or ticket number", ph=="User story or ticket number (optional)", ph)
    # ---- a save that fails partway: each row of the review says Saved or Not saved; Save saves the rest
    await pg.click(".modal footer button:has-text('Cancel')"); await pg.wait_for_timeout(20)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    await post({"type":"stageChanges","key":"permissionSet:1","changes":[{"key":"object:Order","label":"Order","after":{"read":True,"create":False,"edit":False,"delete":False,"viewAll":False,"modifyAll":False}},
      {"key":"user:ActivateContract","label":"Activate Contracts","after":{"enabled":True}}]}); await pg.wait_for_timeout(60)
    # Staged changes open the review (as when sent from another screen); otherwise open it from the footer
    if await pg.locator(".modal .rv-table").count()==0: await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(40)
    await pg.click(".modal footer button.brand"); await pg.wait_for_timeout(30)
    await post({"type":"saveResult","key":"permissionSet:1","status":"error","partial":True,"message":"FIELD_INTEGRITY_EXCEPTION: Permission Activate Contracts depends on permission(s): Edit Contract, Read Contract",
      "outcome":[{"key":"object:Order","saved":True},{"key":"user:ActivateContract","saved":False}]}); await pg.wait_for_timeout(60)
    rows=await pg.evaluate("""()=>[...document.querySelectorAll('.modal .rv-table tbody tr:not(.rv-grp)')].map(tr=>({name: tr.querySelector('b') && tr.querySelector('b').textContent, status: (tr.querySelector('.rv-status')||{}).textContent, x: !!tr.querySelector('.rv-x')}))""")
    t=await pg.inner_text(".modal")
    btn=await pg.inner_text(".modal footer button.brand")
    check("8b after a partial failure each row says Saved or Not saved; saved rows stay, without ×",
      {"name":"Order","status":"Saved","x":False} in rows and {"name":"ActivateContract","status":"Not saved","x":True} in rows and "1 of 2 changes were saved" in t and "Salesforce’s reason: FIELD_INTEGRITY_EXCEPTION" in t, [rows, t[-300:]])
    msg=await pg.inner_text(".modal .alert.error")
    check("8d the message: the outcome on its own line, then Salesforce’s reason, no extra hints", msg.split("\n")[0].strip()=="1 of 2 changes were saved." and msg.split("\n")[1].startswith("Salesforce’s reason: FIELD_INTEGRITY_EXCEPTION") and "marked Saved" not in msg and msg.strip().endswith("Adjust what wasn’t saved, then save again."), msg)
    check("8c Save now saves only what wasn’t saved", "1 change" in btn and "16" not in btn, btn)
    await pg.click(".modal footer button:has-text('Cancel')"); await pg.wait_for_timeout(20)
    # ---- a save that ends differently says which entries and what the org has; History keeps it
    await pg.keyboard.press("Escape"); await pg.evaluate("()=>{const o=document.querySelector('.overlay'); if(o) o.remove()}")
    D=[{"key":"assignment:005A","label":"Avery Chen","text":"expiry: asked 2026-11-30, the org has 2026-11-29"},{"key":"assignment:005B","label":"Blake Morgan","text":"expiry: asked 2026-12-15, the org has no expiry"}]
    await post({"type":"saveResult","key":"permissionSet:1","status":"saved","count":2,"mismatches":[{"key":d["key"]} for d in D],"differences":D,"snapshotId":"s9","undo":[]}); await pg.wait_for_timeout(60)
    t=await pg.inner_text(".toasts")
    check("9a a save that ends differently names the entries and what the org has", "2 entries not as requested" in t and "Avery Chen: expiry: asked 2026-11-30, the org has 2026-11-29" in t and "Blake Morgan" in t and "History" not in t, t)
    await pg.click(".globalbar button:has-text('History')"); await pg.wait_for_timeout(30)
    E=[{"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),"target":"Sales_Operations","key":"permissionSet:1","path":"records","count":2,"result":"saved with differences","snapshot":"s9",
        "changes":[{"key":"assignment:005A","label":"Avery Chen","from":{"assigned":True,"expires":None},"to":{"assigned":True,"expires":"2026-11-30"}}],"differences":D}]
    await post({"type":"history","entries":E}); await pg.wait_for_timeout(60)
    t=await pg.inner_text("main")
    check("9b History shows Saved with differences, and what differed", "Saved with differences" in t and "Avery Chen: expiry: asked 2026-11-30, the org has 2026-11-29" in t, t[:500])
    await b.close()
    # ---- narrow windows: the picker with nothing open; the full width with an item open
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":900,"height":600})
    await pg.goto(DARK); post=lambda m: pg.evaluate(DELIVER, m)
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(60)
    check("9 a narrow window with nothing open offers the item picker", await pg.locator("select[aria-label='Open an item']").count()==1)
    await pg.select_option("select[aria-label='Open an item']", "permissionSet:1"); await post(detail); await pg.wait_for_timeout(60)
    w=await pg.evaluate("()=>Math.round(document.querySelector('main').getBoundingClientRect().width)")
    check("10 ...and with an item open the page uses the full width", w>=850, w)
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
