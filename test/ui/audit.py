import asyncio, json, time, sys
from playwright.async_api import async_playwright
from common import *
PS_CATS=["object","field","user","assignment","tab","apexClass","apexPage","customPermission","flow","app","connectedApp","customMetadata","customSetting","recordType","agent","externalCredential","externalDataSource","presenceStatus","emailRouting"]
def hdr(label, api, kind, kindId, cats): return {"label":label,"apiName":api,"kind":kind,"kindId":kindId,"license":"Salesforce","status":"","activeAssignees":12,"managed":False,"standard":False,"description":"Access for the sales operations team to manage leads, opportunities and campaigns.","lastModified":"2026-10-28T09:12:00Z","lastModifiedBy":"Jordan Lee","editableCats":cats}
SIZES=[(970,620),(1230,620),(1220,760),(1480,760)]
# What counts as a layout problem, measured in the page.
MEASURE = """() => {
  const W = innerWidth, H = innerHeight, out = [];
  const scrollsX = el => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p !== document.body && p !== document.documentElement) return true; } return false; };
  if (document.documentElement.scrollWidth > W + 1) out.push('page scrolls sideways (' + document.documentElement.scrollWidth + ' > ' + W + ')');
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === 'hidden') continue;
    if (r.right > W + 1 && !scrollsX(el)) out.push('off the right edge: ' + (el.className || el.tagName) + ' ' + (el.textContent || '').trim().slice(0, 30));
    if ((el.tagName === 'BUTTON' || el.classList.contains('pill') || el.classList.contains('rv-chip')) && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== 'ellipsis') out.push('text cut off: ' + el.tagName + ' "' + el.textContent.trim().slice(0, 30) + '"');
  }
  // The page itself is exactly the window: only its areas scroll.
  const d = document.scrollingElement;
  if (d.scrollHeight > H + 1 || d.scrollTop) out.push('the page is ' + d.scrollHeight + 'px tall in a ' + H + 'px window (scrolled ' + d.scrollTop + ')');
  const gb = document.querySelector('.globalbar'); if (gb && gb.getBoundingClientRect().height > 70) out.push('top bar wraps (' + Math.round(gb.getBoundingClientRect().height) + 'px tall)');
  const m = document.querySelector('.modal'); if (m) { const r = m.getBoundingClientRect(); if (r.bottom > H + 1 || r.top < 0) out.push('dialog taller than the window (' + Math.round(r.height) + ' > ' + H + ')'); }
  const nav = document.querySelector('.section-nav'), mainEl = document.querySelector('main');
  const content = document.querySelector('.section-body') || document.querySelector('.tab-body');
  const info = { contentWidth: content ? Math.round(content.getBoundingClientRect().width) : null, navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : null,
    contentTop: content ? Math.round(content.getBoundingClientRect().top) : null };
  return { problems: [...new Set(out)].slice(0, 12), info };
}"""
async def main():
  only = sys.argv[1] if len(sys.argv) > 1 else None
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    report = {}
    for (W,H) in SIZES:
      pg=await b.new_page(viewport={"width":W,"height":H})
      errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
      await pg.goto(DARK)
      post=lambda m: pg.evaluate(DELIVER, m)
      L=json.loads(json.dumps(lists)); L["group"]=[row("group:1","group","Sales Team Bundle","Sales_Team_Bundle")]; L["profile"]=[row("profile:1","profile","Custom: Sales","Custom: Sales")]
      await post(dict(ctx,production=True,sandbox=False)); await post({"type":"lists","lists":L,"kinds":["permissionSet","group","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
      async def measure(name):
        await pg.wait_for_timeout(60)
        r = await pg.evaluate(MEASURE)
        report.setdefault(name, {})[f"{W}x{H}"] = r
        if (W,H) == SIZES[0]: await pg.screenshot(path=f"{OUT}/aud-{name}.png")
      # record page
      await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(50)
      await measure("1-objects")
      await pg.click("td.strong:text-is('Lead')"); await post(objd); await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[]}}); await pg.wait_for_timeout(40)
      await measure("2-object-detail")
      await pg.click("[aria-label='Read Website']"); await pg.click("[aria-label='Edit Rating']")
      await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(50)
      await measure("3-review")
      await pg.click(".modal button:has-text('Cancel')"); await pg.click(".docked-footer button.neutral"); await pg.wait_for_timeout(20)
      await pg.click(".breadcrumb button"); await pg.click(".nav-item:has-text('System Permissions')"); await pg.wait_for_timeout(30)
      await measure("4-system")
      # tools
      await pg.click(".globalbar button:has-text('Find access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"}]}); await pg.wait_for_timeout(20)
      res={"object":"Lead","field":"Lead.Rating","level":"edit","sources":[{"permissionSetId":"0PS1","key":"permissionSet:1","kind":"permissionSet","label":"Sales Operations","apiName":"Sales_Operations","objectVia":["object"],"fieldVia":["field"],"users":18},{"permissionSetId":"0PS9","key":"profile:1","kind":"profile","label":"System Administrator","apiName":"X","objectVia":["ModifyAllData"],"fieldVia":[],"users":4},{"permissionSetId":"0PG1","key":"group:1","kind":"group","label":"Sales Team Bundle","apiName":"G","objectVia":["object"],"fieldVia":["field"],"users":12,"includes":["Quote Approver"]}],
        "users":[{"userId":str(i),"name":n,"username":n.split()[0].lower()+"@acme.example","profile":"Custom: Sales","license":"Salesforce","objectFrom":["0PS1","0PG1"],"fieldFrom":["0PS1"]} for i,n in enumerate(["Avery Chen","Blake Morgan","Devon Ruiz","Emery Walsh"])],"partial":[],"inactive":[]}
      await pg.click("[data-fid='lk.target']"); await pg.keyboard.type("Lead"); await pg.keyboard.press("Escape"); await pg.click(".lk-bar button.brand"); await post({"type":"lookupResult","result":res}); await pg.wait_for_timeout(40)
      await measure("5-find-access")
      await pg.click(".globalbar button:has-text('Grant field access')"); await pg.fill("[data-fid='wz.obj']","Lead"); await pg.dispatch_event("[data-fid='wz.obj']","change")
      await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.A__c","apiName":"A__c","label":"Sales Region","type":"picklist","custom":True,"canEdit":True},{"name":"Lead.B__c","apiName":"B__c","label":"Account Tier","type":"picklist","custom":True,"canEdit":True}]}); await pg.wait_for_timeout(20)
      await pg.click("[aria-label='Sales Region']"); await pg.click("[aria-label='Account Tier']")
      await post({"type":"wizardCurrent","object":"Lead","fields":["Lead.A__c","Lead.B__c"],"byKey":{"permissionSet:1":{"users":18,"objectRead":True,"fields":{}}}}); await pg.wait_for_timeout(30)
      await measure("6-grant-fields")
      await pg.click(".globalbar button:has-text('Grant object access')"); await pg.fill("[data-fid='ow.obj']","Lead"); await pg.dispatch_event("[data-fid='ow.obj']","change")
      await post({"type":"objWizardInfo","object":"Lead","columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],"recordTypes":[{"name":"Lead.Partner","developerName":"Partner","label":"Partner Lead","active":True}]})
      await post({"type":"objWizardCurrent","object":"Lead","byKey":{"permissionSet:1":{"users":18,"props":{"read":True}}}}); await pg.wait_for_timeout(40)
      await measure("7-grant-object")
      await pg.click(".globalbar button:has-text('User access')"); await pg.wait_for_timeout(20)
      await post({"type":"userAccess","userId":None,"data":None})
      await pg.evaluate("()=>{}")
      await pg.fill("[data-fid='ua.q']","Ava"); await pg.dispatch_event("[data-fid='ua.q']","input"); await pg.wait_for_timeout(200)
      await post({"type":"users","text":"Ava","users":[{"userId":"005A","name":"Avery Chen","username":"avery@acme.example","profile":"Custom: Sales"}]}); await pg.wait_for_timeout(30)
      await pg.click(".results button >> nth=0")
      S=[{"permissionSetId":"a","kind":"profile","label":"Custom: Sales","key":"profile:1"},{"permissionSetId":"b","kind":"permissionSet","label":"Sales Operations","key":"permissionSet:1","expires":"2026-12-31"},{"permissionSetId":"d","kind":"group","label":"Sales Team Bundle","key":"group:1"}]
      await post({"type":"userAccess","userId":"005A","data":{"user":{"id":"005A","name":"Avery Chen","username":"avery@acme.example","active":True,"profile":"Custom: Sales","license":"Salesforce","role":"Account Executive"},"licenses":["Sales Cloud Einstein"],"sources":S,
        "objects":[{"name":"Account","flags":{"read":[0,1],"edit":[1,2]}},{"name":"Opportunity","flags":{"read":[0,1,2],"delete":[1]}}],"system":[{"name":"ModifyAllData","label":"Modify All Data","sources":[2]}],"custom":[]}}); await pg.wait_for_timeout(40)
      await measure("8-user-access")
      await pg.click(".globalbar button:has-text('Compare')"); await pg.select_option("[data-fid='cmp.a']","permissionSet:1"); await pg.select_option("[data-fid='cmp.b']","permissionSet:3")
      await post({"type":"compareResult","labelA":"Sales Operations","labelB":"Lead Management","rows":[{"area":"Object Permissions","cat":"object","entry":"Account","a":"Read, Create, Edit, Delete","b":"Read"},{"area":"Field Permissions","cat":"field","entry":"Account.Customer_Priority__c","a":"Read, Edit","b":"No access"}],"markdown":"x"}); await pg.wait_for_timeout(40)
      await measure("9-compare")
      await pg.click(".globalbar button:has-text('Health')"); await pg.wait_for_timeout(20)
      await pg.click("button:has-text('Check now')")
      await post({"type":"health","data":json.loads(open(DATA / 'health.json').read())}); await pg.wait_for_timeout(40)
      await measure("11-health")
      await pg.click(".globalbar button:has-text('History')")
      await post({"type":"history","entries":[{"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),"target":"Sales_Operations","key":"permissionSet:1","path":"records","count":3,"result":"saved","snapshot":"s1","ticket":"ADO US 11581701","changes":[{"key":"field:Lead.Rating","label":"Rating","from":{"read":True,"edit":False},"to":{"read":True,"edit":True}}]}]}); await pg.wait_for_timeout(40)
      await measure("10-history")
      await pg.close()
    print(json.dumps(report, indent=1))
    await b.close()
asyncio.run(main())
