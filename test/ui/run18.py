import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
results=[]
def check(name, ok, info=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(info)[:400]))
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
    # ---- a big fix shows its progress: the item, how many changes, which step
    await pg.click(".globalbar button:has-text('Health')"); await pg.click("button:has-text('Check now')")
    await post({"type":"health","data":json.load(open(DATA / 'health-big.json'))}); await pg.wait_for_timeout(200)
    await pg.click("#hc-inactive th [aria-label='Select all']"); await pg.click("#hc-inactive button:has-text('Remove 5345')"); await pg.wait_for_timeout(40)
    await post({"type":"healthPlan","action":"remove","plan":[{"key":"permissionSet:1","label":"Sales Operations","kind":"permissionSet","changes":[{"key":"assignment:005%05d"%i,"ref":"005%05d"%i,"label":"User %d"%i,"before":{"assigned":True,"expires":None},"after":{"assigned":False,"expires":None}} for i in range(5345)]}],"skipped":[]}); await pg.wait_for_timeout(60)
    await pg.click("#wzApply"); await pg.wait_for_timeout(30)
    await post({"type":"wizardProgress","done":1,"total":3,"label":"Saving 5,345 changes in one request","items":1,"changesSaved":0,"changesTotal":5345}); await pg.wait_for_timeout(40)
    bar=await pg.inner_text(".modal .save-progress"); pos=await pg.get_attribute(".modal .save-progress", "aria-valuenow")
    w0=await pg.evaluate("()=>document.querySelector('.modal .save-progress .bar > i').getBoundingClientRect().width"); await pg.wait_for_timeout(1200)
    w1=await pg.evaluate("()=>document.querySelector('.modal .save-progress .bar > i').getBoundingClientRect().width")
    check("1b the bar keeps moving while the step runs (no new message needed)", w1 > w0 + 2, [w0, w1])
    check("1 a big save shows a progress bar: what is happening, and changes saved out of all of them", "Saving 5,345 changes in one request" in bar and "0 of 5,345 changes saved" in bar and pos=="33", [bar, pos])
    await post({"type":"wizardResult","results":[{"key":"permissionSet:1","label":"Sales Operations","status":"saved","count":5345}]}); await pg.wait_for_timeout(40)
    # ---- the health check's wording
    await pg.click("button:has-text('Back to results')"); await post({"type":"health","data":json.load(open(DATA / 'health-big.json'))}); await pg.wait_for_timeout(200)
    t=await pg.inner_text("main")
    check("2 unused items say they may still be assigned at run time", "A Flow or user access policy may still assign one" in t and "A user access policy may still assign one" in t, '')
    title=await pg.evaluate("()=>{const s=document.querySelector(\"[data-fid='hc.extend']\"); return s && s.parentElement.getAttribute('title')}")
    check("3 Extend says it counts from the current expiry date", title == "Counted from each assignment’s current expiry date", title)
    # ---- History: a 5,000-change save draws only what it shows
    await pg.click(".globalbar button:has-text('History')")
    at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    big={"at":at,"target":"Sales_Operations","key":"permissionSet:1","path":"Health check","count":5000,"result":"saved","snapshot":"big","changes":[{"key":"assignment:005%05d"%i,"label":"User %d"%i,"from":{"assigned":True},"to":{"assigned":False}} for i in range(5000)]}
    rename={"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-60)),"target":"Renamed_PS","key":"permissionSet:2","path":"rename","count":1,"result":"saved"}
    await post({"type":"history","entries":[big, rename]}); await pg.wait_for_timeout(120)
    chips=lambda: pg.evaluate("()=>document.querySelector('.ev').querySelectorAll('.ch > :not(button)').length")
    n1=await chips(); more=await pg.inner_text(".ev .ch button")
    check("4 a 5,000-change save draws 6 chips and offers the rest", n1==6 and more.strip()=="+4,994 more", [n1, more])
    await pg.click(".ev .ch button:has-text('more')"); await pg.wait_for_timeout(120)
    n2=await chips()
    check("5 ...then 300 at a time", n2==300 and await pg.locator(".ev .ch button:has-text('Show 300 more')").count()==1, n2)
    await pg.click(".ev .ch button:has-text('Show 300 more')"); await pg.wait_for_timeout(120)
    check("6 ...300 more", await chips()==600)
    await pg.click(".ev .ch button:has-text('Show fewer')"); await pg.wait_for_timeout(80)
    check("7 ...and Show fewer goes back to 6", await chips()==6)
    # ---- History's Export: every save shown, a rename (no snapshot) included
    await pg.click(".selbar button:has-text('Export')"); await pg.wait_for_timeout(30)
    ex=(await sent("export"))[-1]
    check("8 Export with nothing selected sends every save shown, the rename too", ex.get("what")=="history" and len(ex.get("entryIds",[]))==2 and any(i.startswith(rename["at"]+"|Renamed_PS|rename") for i in ex["entryIds"]), ex)
    print("SUMMARY", sum(1 for r in results if r[1]), "of", len(results), "passed; page errors:", errs)
    await b.close()
asyncio.run(main())
