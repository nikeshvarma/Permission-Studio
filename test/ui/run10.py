import asyncio, json, time
from playwright.async_api import async_playwright
from common import *
# an org-sized object list, like the reported one
BIG=[{"name":"Account","label":"Account","objectPerms":True},{"name":"AccountContactRelation","label":"Account Contact Relationship","objectPerms":True},
     {"name":"Apttus__AccountHierarchy__c","label":"Account Hierarchy","objectPerms":True},{"name":"Lead","label":"Lead","objectPerms":True},{"name":"Event","label":"Event","objectPerms":False}]
BIG+=[{"name":"Obj%04d__c"%i,"label":"Generated Object %d"%i,"objectPerms":True} for i in range(1500)]
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    pg=await b.new_page(viewport={"width":1400,"height":800})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e)))
    await pg.goto(DARK)
    post=lambda m: pg.evaluate("m=>window.postMessage(m,'*')",m)
    sent=lambda t: pg.evaluate("t=>window.sent.filter(m=>m.type===t)", t)
    shownList=lambda: pg.evaluate("()=>{const l=document.querySelector('.combo-list:not([hidden])');return l?[...l.querySelectorAll('.cv')].map(x=>x.textContent):null}")
    note=lambda: pg.evaluate("()=>{const n=document.querySelector('.combo-list:not([hidden]) .combo-note');return n?n.textContent:''}")
    await post(dict(ctx,production=False)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","profile"],"savedAt":now,"refreshing":False}); await pg.wait_for_timeout(40)
    await pg.click(".split-item:has-text('Sales Operations')"); await post(detail); await pg.wait_for_timeout(40)
    # ---- Grant object access, the reported screen, with 1,500+ objects
    await pg.click(".globalbar button:has-text('Grant object access')"); await pg.wait_for_timeout(30)
    await post({"type":"objectCatalog","objects":BIG}); await pg.wait_for_timeout(40)
    await pg.click("[data-fid='ow.obj']"); await pg.wait_for_timeout(40)
    l=await shownList(); assert l and len(l)==50, len(l or [])
    assert "Showing 50 of 1504" in await note(), await note()
    assert "Event" not in l, "objects without object permissions aren't offered here"
    bg=await pg.evaluate("()=>getComputedStyle(document.querySelector('.combo-list')).backgroundColor"); assert bg!="rgb(255, 255, 255)", "themed, not the browser's white list: "+bg
    box=await pg.evaluate("()=>{const r=document.querySelector('.combo-list').getBoundingClientRect();return [r.top,r.bottom,innerHeight]}"); assert box[1]<=box[2] and box[1]-box[0]>=200, "fully visible, not cut off by the card: %s"%box
    await pg.keyboard.type("acc", delay=40); await pg.wait_for_timeout(30)
    l=await shownList(); assert l[:3]==["Account","AccountContactRelation","Apttus__AccountHierarchy__c"], l[:5]
    await pg.keyboard.press("Escape"); await pg.wait_for_timeout(20)
    assert await shownList() is None, "Esc closes the list"
    assert "Grant object access" in await pg.inner_text("main"), "…without leaving the page"
    await pg.keyboard.press("ArrowDown"); await pg.wait_for_timeout(20)
    assert (await shownList())[0]=="Account"
    await pg.keyboard.press("ArrowDown"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(40)
    assert (await sent("objWizardInfo"))[-1]=={"type":"objWizardInfo","object":"AccountContactRelation"}, "↓ ↓ Enter picked the second match"
    assert await shownList() is None
    # click elsewhere closes
    await pg.fill("[data-fid='ow.obj']",""); await pg.click("[data-fid='ow.obj']"); await pg.keyboard.type("lea", delay=30); await pg.wait_for_timeout(20)
    assert (await shownList())[0]=="Lead"
    await pg.mouse.click(1300, 760); await pg.wait_for_timeout(30)
    assert await shownList() is None, "a click elsewhere closes it"
    # clicking an item picks it
    await pg.click("[data-fid='ow.obj']"); await pg.wait_for_timeout(30)
    await pg.click(".combo-list li:has(.cv:text-is('Lead'))"); await pg.wait_for_timeout(40)
    assert (await sent("objWizardInfo"))[-1]=={"type":"objWizardInfo","object":"Lead"}
    # ---- Find access: the list stays open while typing, then offers the object's fields
    await pg.click(".globalbar button:has-text('Find access')"); await pg.wait_for_timeout(30)
    await pg.click("[data-fid='lk.target']")
    await pg.evaluate("()=>{window.__box=document.querySelector('[data-fid=\"lk.target\"]')}")
    same=lambda: pg.evaluate("()=>document.querySelector('[data-fid=\"lk.target\"]')===window.__box && document.activeElement===window.__box")
    for ch in "Lead":
        await pg.keyboard.type(ch); await pg.wait_for_timeout(250)
        assert await same() and await shownList() is not None, "list open and box kept after " + ch
    assert (await shownList())[0]=="Lead"
    await pg.keyboard.type("."); await pg.wait_for_timeout(40)
    assert "Loading" in await note(), "fields being fetched"
    assert (await sent("wizardFields"))[-1]=={"type":"wizardFields","object":"Lead"}
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.Rating","apiName":"Rating","label":"Rating","type":"picklist","custom":False,"canEdit":True},{"name":"Lead.Region__c","apiName":"Region__c","label":"Sales Region","type":"picklist","custom":True,"canEdit":True}]}); await pg.wait_for_timeout(40)
    assert await same() and await shownList()==["Lead.Rating","Lead.Region__c"], await shownList()
    await pg.keyboard.type("re", delay=40); await pg.wait_for_timeout(20)
    assert (await shownList())==["Lead.Region__c"], await shownList()
    for _ in range(2): await pg.keyboard.press("Backspace")
    await pg.keyboard.type("ra", delay=40); await pg.wait_for_timeout(20)
    assert (await shownList())==["Lead.Rating"], await shownList()
    await pg.click(".combo-list li:has(.cv:text-is('Lead.Rating'))"); await pg.wait_for_timeout(30)
    lv=await pg.evaluate("()=>[...document.querySelector('[data-fid=\"lk.level\"]').options].map(o=>o.value)"); assert lv==["read","edit"], lv
    await pg.select_option("[data-fid='lk.level']","edit")
    await pg.click("[data-fid='lk.target']"); await pg.keyboard.press("End"); await pg.keyboard.press("Escape"); await pg.keyboard.press("Enter"); await pg.wait_for_timeout(30)
    assert (await sent("lookup"))[-1]=={"type":"lookup","object":"Lead","field":"Rating","level":"edit"}, await sent("lookup")
    await pg.screenshot(path="combo.png")
    print("ok; errors:", errs); await b.close()
asyncio.run(main())
