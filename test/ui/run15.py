import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
HEALTH=json.loads(open(DATA / 'health.json').read())
# The rules, measured on screen.
MEASURE = """(screen) => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const px = (e, p) => parseFloat(getComputedStyle(e)[p]);
  const all = sel => [...document.querySelectorAll(sel)].filter(vis);
  const bad = [];
  const tags = all('.pill, .badge, .rv-chip, .src, .rv-risk, .rv-auto, .ticket, .st, .type, .mx-chip, .count').filter(e => !e.closest('.kinds'));
  for (const e of tags) {
    const h = Math.round(e.getBoundingClientRect().height);
    if (h !== 20 || px(e, 'borderTopLeftRadius') < 10 || px(e, 'fontSize') !== 12) bad.push('tag ' + e.className + ' "' + e.textContent.trim().slice(0, 20) + '": ' + h + 'px high, radius ' + px(e, 'borderTopLeftRadius') + ', font ' + px(e, 'fontSize'));
  }
  for (const e of all('.cb .box')) { const r = e.getBoundingClientRect(); if (Math.round(r.width) !== 14 || Math.round(r.height) !== 14 || px(e, 'borderTopLeftRadius') !== 3) bad.push('checkbox ' + r.width + 'x' + r.height + ' radius ' + px(e, 'borderTopLeftRadius')); }
  for (const e of all('input[type="radio"]')) { const r = e.getBoundingClientRect(); if (Math.round(r.width) !== 14 || Math.round(r.height) !== 14 || px(e, 'borderTopLeftRadius') < 7) bad.push('radio ' + r.width + 'x' + r.height); }
  for (const e of all('.card, .modal, .lk-bar, .hc-card, .rv-stat, .ev, .steps, .alert, .rv-call, .policy-note, .restored, .rv-license')) if (px(e, 'borderTopLeftRadius') !== 8) bad.push('container ' + e.className + ' radius ' + px(e, 'borderTopLeftRadius'));
  const heads = all('.datatable th, .rv-table th, .mx-table thead th');
  for (const e of heads) if (px(e, 'fontSize') !== 12 || getComputedStyle(e).fontWeight !== '600' || px(e, 'paddingLeft') !== 10) bad.push('table header "' + e.textContent.trim().slice(0, 15) + '" font ' + px(e, 'fontSize') + ' weight ' + getComputedStyle(e).fontWeight + ' padding ' + px(e, 'paddingLeft'));
  for (const e of all('.datatable td, .rv-table td, .mx-table td').slice(0, 300)) if (px(e, 'paddingLeft') !== 10) { bad.push('table cell padding ' + px(e, 'paddingLeft')); break; }
  for (const e of all('.btn').filter(e => !e.closest('.btn-group, .seg'))) if (px(e, 'borderTopLeftRadius') !== 4) bad.push('button "' + e.textContent.trim().slice(0, 15) + '" radius ' + px(e, 'borderTopLeftRadius'));
  for (const e of all('select.select, .search input, .combo > input')) if (px(e, 'borderTopLeftRadius') < 100) bad.push('dropdown/search not a pill');
  return { counts: { tags: tags.length, checkboxes: all('.cb .box').length, radios: all('input[type="radio"]').length, containers: all('.card, .modal, .alert, .rv-call').length, tables: heads.length }, bad: [...new Set(bad)].slice(0, 8) };
}"""
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":860})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    seen={}; fails=[]
    async def m(name):
      await pg.wait_for_timeout(60)
      r=await pg.evaluate(MEASURE, name); seen[name]=r['counts']
      if r['bad']: fails.append((name, r['bad']))
    await post(dict(ctx,production=True)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(50); await m("record")
    await pg.click("td:has-text('Lead') >> nth=0"); await post(objd); await post({"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[{"name":"Lead.Partner","label":"Partner","active":True,"visible":True,"default":False}]}}); await pg.wait_for_timeout(40); await m("object")
    await pg.click("[aria-label='Edit Rating']"); await pg.click(".docked-footer button.brand"); await pg.wait_for_timeout(40); await m("review")
    await pg.click(".modal button:has-text('Cancel')"); await pg.click(".docked-footer button.neutral"); await pg.click(".breadcrumb button")
    await pg.click(".nav-item:has-text('System Permissions')"); await pg.wait_for_timeout(30); await m("system")
    await pg.click(".globalbar button:has-text('Find access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead"}]}); await pg.click("[data-fid='lk.target']"); await pg.keyboard.type("Lead"); await pg.keyboard.press("Escape"); await pg.click(".lk-bar button.brand")
    await post({"type":"lookupResult","result":{"object":"Lead","field":None,"level":"read","sources":[{"permissionSetId":"0PS1","key":"permissionSet:1","kind":"permissionSet","label":"Sales Operations","apiName":"S","objectVia":["object"],"fieldVia":[],"users":2},{"permissionSetId":"0PS9","key":"profile:1","kind":"profile","label":"System Administrator","apiName":"X","objectVia":["ModifyAllData"],"fieldVia":[],"users":1}],"users":[{"userId":"1","name":"Ana Lima","username":"ana@x","profile":"Custom: Sales","license":"Salesforce","objectFrom":["0PS1"],"fieldFrom":[]}],"partial":[],"inactive":[]}}); await pg.wait_for_timeout(40); await m("findaccess")
    await pg.click(".globalbar button:has-text('Grant field access')"); await pg.fill("[data-fid='wz.obj']","Lead"); await pg.dispatch_event("[data-fid='wz.obj']","change")
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.A__c","apiName":"A__c","label":"Region","type":"picklist","custom":True,"canEdit":True}]}); await pg.wait_for_timeout(30); await m("grant")
    await pg.click(".globalbar button:has-text('History')"); await post({"type":"history","entries":[{"at":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),"target":"Sales_Operations","key":"permissionSet:1","path":"records","count":1,"result":"saved","snapshot":"s1","ticket":"ADO 1","changes":[{"key":"field:Lead.Rating","label":"Rating","from":{"read":True,"edit":False},"to":{"read":True,"edit":True}}]}]}); await pg.wait_for_timeout(40); await m("history")
    await pg.click(".globalbar button:has-text('Health')"); await pg.click("button:has-text('Check now')"); await post({"type":"health","data":HEALTH}); await pg.wait_for_timeout(40); await m("health")
    await pg.click(".globalbar button:has-text('User access')"); await pg.fill("[data-fid='ua.q']","Ana"); await pg.dispatch_event("[data-fid='ua.q']","input"); await pg.wait_for_timeout(200)
    await post({"type":"users","text":"Ana","users":[{"userId":"005A","name":"Ana Lima","username":"ana@x","profile":"Custom: Sales"}]}); await pg.wait_for_timeout(30); await pg.click(".results button >> nth=0")
    await post({"type":"userAccess","userId":"005A","data":{"user":{"id":"005A","name":"Ana Lima","username":"ana@x","active":True,"profile":"Custom: Sales","license":"Salesforce","role":""},"licenses":["Sales Cloud"],"sources":[{"permissionSetId":"a","kind":"profile","label":"Custom: Sales","key":"profile:1"},{"permissionSetId":"b","kind":"permissionSet","label":"Sales Operations","key":"permissionSet:1","expires":"2026-12-31"}],"objects":[{"name":"Account","flags":{"read":[0]}}],"system":[{"name":"ModifyAllData","label":"Modify All Data","sources":[1]}],"custom":[]}}); await pg.wait_for_timeout(40); await m("useraccess")
    for name, c in seen.items(): print(f"{name:11} {c}")
    total = {k: sum(c[k] for c in seen.values()) for k in ['tags','checkboxes','radios','containers','tables']}
    print('measured:', total)
    for name, bad in fails: print('FAIL', name, '->', bad)
    print('ok; errors:', errs) if not fails and not errs and total['radios'] > 0 and total['checkboxes'] > 0 and total['tags'] > 10 else print('FAILED', errs)
    await b.close()
asyncio.run(main())
