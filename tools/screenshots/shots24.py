import asyncio, json, time
import os, pathlib, tempfile
HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get('SHOTS_OUT') or os.path.join(tempfile.gettempdir(), 'permission-studio-shots'))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get('CHROME') or None
def launch_args(extra=()):
    a = ['--no-sandbox', '--allow-file-access-from-files'] + list(extra)
    return dict(executable_path=CHROME, args=a) if CHROME else dict(args=a)
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
from playwright.async_api import async_playwright
exec((HERE / 'shoot.py').read_text().split('async def main')[0])
PS_CATS=["object","field","user","assignment","tab","app","agent","externalCredential","externalDataSource","presenceStatus","emailRouting"]
def hdr(label, api, kind, kindId, cats): return {"label":label,"apiName":api,"kind":kind,"kindId":kindId,"license":"Salesforce","status":"","activeAssignees":12,"managed":False,"standard":False,"description":"","lastModified":"2026-10-28T09:12:00Z","lastModifiedBy":"Jordan Lee","editableCats":cats}
def det(key, header): return {"type":"detail","key":key,"savedAt":now-60000,"refreshing":False,"data":{"header":header,"objects":[],"system":[],"fieldObjects":[]}}
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    async def frame(title):
      pg=await b.new_page(viewport={"width":1600,"height":1060},device_scale_factor=1.25)
      await pg.goto((HERE / "frame-dark.html").as_uri()); await pg.wait_for_timeout(250)
      await pg.evaluate("t=>{document.body.style.flexDirection='column';document.body.style.gap='18px';const c=document.createElement('div');c.textContent=t;c.style.cssText='color:#dbe6fb;font:600 20px \"Noto Sans CJK JP\",sans-serif;width:1440px';document.body.insertBefore(c,document.body.firstChild)}", title)
      fr=pg.frames[1]; post=lambda m: fr.evaluate("m=>window.postMessage(m,'*')",m)
      c=ctx(False,"acme-dev"); c["sandbox"]=True
      await post(favs); await post(c); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now-60000,"refreshing":False}); await fr.wait_for_timeout(80)
      return pg, fr, post
    async def shot(pg,n): await pg.wait_for_timeout(250); await pg.screenshot(path=f"{OUT}/{n}.png")
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('Health')"); await fr.wait_for_timeout(30)
    await fr.click("button:has-text('Check now')"); await post({"type":"health","data":HEALTH}); await fr.wait_for_timeout(50)
    await fr.click("#hc-high button:has-text('Modify All Data')"); await fr.wait_for_timeout(30)
    await shot(pg,"r24-1-health"); await pg.close()
    await b.close()
asyncio.run(main())
