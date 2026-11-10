import asyncio, json, time
from playwright.async_api import async_playwright
import os, pathlib, tempfile
HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get('SHOTS_OUT') or os.path.join(tempfile.gettempdir(), 'permission-studio-shots'))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get('CHROME') or None
def launch_args(extra=()):
    a = ['--no-sandbox', '--allow-file-access-from-files'] + list(extra)
    return dict(executable_path=CHROME, args=a) if CHROME else dict(args=a)
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
    async def shot(pg,n): await pg.wait_for_timeout(250); await pg.screenshot(path=f"{OUT}/r23-{n}.png")
    # muting
    pg,fr,post=await frame("")
    await fr.click("button:has-text('Groups')"); await fr.click(".split-item:has-text('Sales Team Bundle')")
    g=lists["group"][0]
    await post(det(g["key"], hdr(g["label"], g["apiName"], "Permission Set Group", "group", ["assignment","groupComponent","mute"]))); await fr.wait_for_timeout(40)
    await post({"type":"policies","key":g["key"],"list":[{"name":"Sales_Onboarding","label":"Sales Onboarding","status":"Active","triggerType":"Create","grants":True,"removes":False}]})
    await fr.click(".nav-item:has-text('Muted Permissions')")
    O=lambda **k: {**{"read":False,"create":False,"edit":False,"delete":False,"viewAll":False,"modifyAll":False},**k}
    await post({"type":"mutingDetail","key":g["key"],"savedAt":now,"refreshing":False,"data":{"muting":{"id":"0QM1","name":"Sales_Team_Bundle_Muting","label":"Sales Team Bundle Muting"},"members":3,
      "objects":[{"name":n,"props":pr} for n,pr in [("Account",O(read=True,create=True,edit=True,delete=True)),("Contact",O(read=True,create=True,edit=True)),("Lead",O(read=True,create=True,edit=True,delete=True,viewAll=True)),("Opportunity",O(read=True,create=True,edit=True,delete=True)),("Quote",O(read=True,edit=True))]],
      "system":[{"name":n,"label":l} for n,l in [("ApiEnabled","API Enabled"),("ExportReport","Export Reports"),("ModifyAllData","Modify All Data"),("RunReports","Run Reports"),("ViewSetup","View Setup and Configuration")]],
      "muted":[["mute:object:Account",O(delete=True)],["mute:user:ExportReport",{"enabled":True}]]}}); await fr.wait_for_timeout(40)
    await fr.click("[aria-label='Mute Delete on Opportunity']"); await fr.click("[aria-label='Mute Modify All Data']")
    await shot(pg,"1-muting"); await pg.close()
    # profile settings
    pg,fr,post=await frame("")
    await fr.click("button:has-text('Profiles')"); await fr.click(".split-item:has-text('Custom: Sales')")
    pr=[r for r in lists["profile"] if r["label"]=="Custom: Sales"][0]
    await post(det(pr["key"], hdr("Custom: Sales","Custom%3A Sales","Profile","profile",["object","field","user","defaultApp","loginFlow","dataCategory","passwordPolicy","sessionSetting"]))); await fr.wait_for_timeout(40)
    await fr.click(".nav-item:has-text('Profile Settings')")
    await post({"type":"profileSettings","key":pr["key"],"savedAt":now,"refreshing":False,"data":{"defaultApp":"standard__Sales","apps":[],"loginFlow":{"flow":"MFA_Prompt","friendlyname":"MFA_Prompt","type":"VisualWorkflow"},
      "dataCategories":[{"group":"Products","visibility":"ALL","categories":[]},{"group":"Regions","visibility":"CUSTOM","categories":["EMEA"]}],
      "passwordPolicy":{"fullName":"sales_password_policy","values":{"passwordExpiration":"90","passwordHistory":"3","minimumPasswordLength":"8","passwordComplexity":"1","passwordQuestion":"0","maxLoginAttempts":"5","lockoutInterval":"15","obscure":"false","minimumPasswordLifetime":"false"}},
      "sessionSetting":{"fullName":"sales_session_settings","values":{"sessionTimeout":"120","sessionTimeoutWarning":"true","forceLogout":"false","sessionPersistence":"false","requiredSessionLevel":"STANDARD"}},
      "appList":[{"name":"standard__Sales","label":"Sales"},{"name":"standard__Service","label":"Service"},{"name":"Acme_Console","label":"Acme Console"}],"flowList":[{"name":"MFA_Prompt","label":"MFA Prompt"}],"groupList":["Products","Regions","Support_Topics"]}}); await fr.wait_for_timeout(40)
    await fr.select_option("[data-fid='passwordPolicy:sales_password_policy.minimumPasswordLength']","12")
    await shot(pg,"2-profile-settings"); await pg.close()
    # user access
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('User access')")
    await fr.fill("[data-fid='ua.q']","Ana"); await fr.dispatch_event("[data-fid='ua.q']","input"); await fr.wait_for_timeout(200)
    await post({"type":"users","text":"Ana","users":[{"userId":"005A","name":"Avery Chen","username":"avery@acme.example","profile":"Custom: Sales"}]}); await fr.wait_for_timeout(30)
    await fr.click(".results button >> nth=0")
    S=[{"permissionSetId":"a","kind":"profile","label":"Custom: Sales","key":"profile:1"},{"permissionSetId":"b","kind":"permissionSet","label":"Sales Operations","key":"permissionSet:1","expires":"2026-12-31"},{"permissionSetId":"c","kind":"permissionSet","label":"Quote Approver","key":"permissionSet:6"},{"permissionSetId":"d","kind":"group","label":"Sales Team Bundle","key":"group:1"}]
    await post({"type":"userAccess","userId":"005A","data":{"user":{"id":"005A","name":"Avery Chen","username":"avery@acme.example","active":True,"profile":"Custom: Sales","license":"Salesforce","role":"Account Executive, West"},"licenses":["Sales Cloud Einstein"],"sources":S,
      "objects":[{"name":n,"flags":f} for n,f in [("Account",{"read":[0,1],"create":[1],"edit":[1,3],"delete":[3]}),("Contact",{"read":[0],"create":[0],"edit":[0]}),("Lead",{"read":[0,1],"create":[1],"edit":[1],"viewAll":[3]}),("Opportunity",{"read":[0,1,3],"create":[1],"edit":[1],"delete":[1]}),("Quote",{"read":[2],"edit":[2]})]],
      "system":[{"name":n,"label":l,"sources":s} for n,l,s in [("ApiEnabled","API Enabled",[0]),("ExportReport","Export Reports",[1]),("ModifyAllData","Modify All Data",[3]),("RunReports","Run Reports",[0,1])]],
      "custom":[{"name":"Approve_Quotes","label":"Approve Quotes","sources":[2]}]}}); await fr.wait_for_timeout(40)
    await shot(pg,"3-user-access"); await pg.close()
    # compare
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('Compare')")
    await fr.click(".seg button:has-text('In another org')"); await post({"type":"orgs","orgs":[{"username":"admin@acme.example.prod","alias":"acme-prod"}]}); await fr.wait_for_timeout(30)
    await fr.select_option("[data-fid='cmp.org']","admin@acme.example.prod")
    rows=[("Object Permissions","Lead","Read, Create, Edit","Read, Create"),("Object Permissions","Quote","Read, Edit","No access"),("Field Permissions","Lead.Region__c","Read, Edit","No access"),("Field Permissions","Lead.Rating","Read, Edit","Read"),
      ("System Permissions","ExportReport","Enabled","Off"),("Apex Class Access","LeadService","Enabled","Off"),("Custom Permissions","Approve_Quotes","Off","Enabled"),("Tab Settings","standard-Quote","Visible","Hidden")]
    await post({"type":"compareResult","labelA":"Sales Operations (acme-dev)","labelB":"Sales Operations (admin@acme.example.prod)","rows":[{"area":a,"cat":"x","entry":e,"a":x,"b":y} for a,e,x,y in rows],"markdown":"x"}); await fr.wait_for_timeout(40)
    await shot(pg,"4-compare"); await pg.close()
    # agent access
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')")
    await post(det("permissionSet:1", hdr("Sales Operations","Sales_Operations","Permission Set","permissionSet",PS_CATS))); await fr.wait_for_timeout(40)
    await fr.click(".nav-item:has-text('Agent Access')")
    await post({"type":"accessDetail","key":"permissionSet:1","category":"agent","savedAt":now,"refreshing":False,"data":{"category":"agent","metadata":True,"items":[{"name":n,"label":l,"enabled":e} for n,l,e in [("HR_Helper","HR Helper",False),("Quote_Assistant","Quote Assistant",True),("Sales_Coach","Sales Coach",True),("Service_Triage","Service Triage",False)]]}}); await fr.wait_for_timeout(30)
    await fr.click(".toggle:has-text('Show only enabled')"); await fr.click("[aria-label='HR Helper']")
    await shot(pg,"5-agent-access"); await pg.close()
    await b.close()
asyncio.run(main())
