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
now=int(time.time()*1000)
def row(i,kind,label,api,**k): return dict(key=f"{kind}:{i}",kind=kind,label=label,apiName=api,managed=k.get('m',False),standard=k.get('s',False),status=k.get('st',''),license=k.get('lic',''))
PS=[("1","Sales Operations","Sales_Operations"),("2","Service Agent","Service_Agent"),("3","Marketing Viewer","Marketing_Viewer"),("4","Integration User","Integration_User"),
    ("5","Partner Community Access","Partner_Community_Access"),("6","Quote Approver","Quote_Approver"),("7","Report Builder","acmeapps__Report_Builder",True),("8","Data Steward","Data_Steward"),("9","Field Service Technician","Field_Service_Technician")]
lists={"permissionSet":[row(i,"permissionSet",l,a,m=(len(x)>3)) for x in PS for i,l,a in [x[:3]]],
       "group":[row("1","group","Sales Team Bundle","Sales_Team_Bundle",st="Updated"),row("2","group","Service Team Bundle","Service_Team_Bundle",st="Updated")],
       "profile":[row("1","profile","Custom: Sales","Custom: Sales",lic="Salesforce"),row("2","profile","Custom: Service","Custom: Service",lic="Salesforce"),row("3","profile","System Administrator","System Administrator",s=True,lic="Salesforce")]}
favs={"type":"favorites","items":["permissionSet:Sales_Operations","permissionSet:Service_Agent","profile:Custom: Sales"],"objects":["Lead","Opportunity"]}
ALL=["object","field","user","assignment","apexClass","apexPage","customPermission","flow","app","connectedApp","customMetadata","customSetting","recordType","tab"]
def ctx(prod=False, alias="acme-dev", user="admin@acme.example.dev"):
    return {"type":"context","status":"ready","message":"","projectDir":"/work/acme-sales-app","org":{"alias":alias,"username":user,"location":"Local"},"production":prod,"mode":"library","connecting":False,"offline":False}
P=lambda **k: {**{"read":False,"create":False,"edit":False,"delete":False,"viewAll":False,"modifyAll":False,"viewAllFields":False},**k}
def detail(key="permissionSet:1",label="Sales Operations",api="Sales_Operations",kind="Permission Set",kindId="permissionSet",cats=ALL,reason="",status="",desc="Access for the sales operations team to manage leads, opportunities and campaigns."):
    return {"type":"detail","key":key,"savedAt":now-90000,"refreshing":False,"data":{"header":{"label":label,"apiName":api,"kind":kind,"kindId":kindId,"license":"Salesforce","status":status,"activeAssignees":42,"managed":False,"standard":False,
      "description":desc,"modified":{"at":"2026-10-30T14:12:00.000Z","by":"Jordan Lee"},"editable":True,"readOnlyReason":reason,"editableCats":cats,"canRename":kindId=="permissionSet","canClone":kindId=="permissionSet"},
      "objects":[{"name":n,"label":l,"props":p} for n,l,p in [("Account","Account",P(read=True,create=True,edit=True)),("Campaign","Campaign",P(read=True)),("Case","Case",P(read=True)),
        ("Contact","Contact",P(read=True,create=True,edit=True,delete=True)),("Lead","Lead",P(read=True,create=True,edit=True,delete=True,viewAll=True)),("Opportunity","Opportunity",P(read=True,create=True,edit=True,delete=True)),
        ("Order","Order",P(read=True,create=True,edit=True,delete=True,viewAll=True,modifyAll=True)),("Quote","Quote",P(read=True,edit=True)),("Product2","Product",P(read=True)),("Contract","Contract",P(read=True,create=True))]],
      "system":[{"name":n,"label":l,"enabled":e} for n,l,e in [("ApiEnabled","API Enabled",True),("ManageUsers","Manage Users",False),("ModifyAllData","Modify All Data",False),("ViewAllData","View All Data",False),
        ("RunReports","Run Reports",True),("ExportReport","Export Reports",True),("EditTask","Edit Tasks",True),("EditEvent","Edit Events",True),("ManageDashboards","Manage Dashboards in Public Folders",False),
        ("ViewSetup","View Setup and Configuration",True),("AuthorApex","Author Apex",False),("ConvertLeads","Convert Leads",True),("TransferAnyLead","Transfer Leads",True),("MassInlineEdit","Mass Edits from Lists",True)]],
      "objectColumns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"]}}
F=lambda a,l,t,r,e,c=True: {"name":"Lead."+a,"apiName":a,"label":l,"type":t,"canEdit":c,"read":r,"edit":e}
LEAD={"type":"objectDetail","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","label":"Lead","props":P(read=True,create=True,edit=True,delete=True,viewAll=True),"columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],
  "fields":[F("AnnualRevenue","Annual Revenue","currency",True,False),F("Region__c","Sales Region","picklist",False,False),F("Description","Description","textarea",True,True),F("Industry","Industry","picklist",True,True),
    F("LeadSource","Lead Source","picklist",True,True),F("NumberOfEmployees","Employees","int",True,False),F("Rating","Rating","picklist",True,False),F("Score__c","Lead Score","double",True,False,False),
    F("Status","Lead Status","picklist",True,True),F("Website","Website","url",False,False),F("Tier__c","Account Tier","picklist",False,False)]}}
RT={"type":"recordTypes","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","profile":False,"items":[{"name":"Lead.Direct","developerName":"Direct","label":"Direct Lead","active":True,"visible":True},{"name":"Lead.Partner","developerName":"Partner","label":"Partner Lead","active":True,"visible":False}]}}

async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    async def open_frame(theme="dark", prod=False, alias="acme-dev"):
      pg=await b.new_page(viewport={"width":1600,"height":1000},device_scale_factor=1.5)
      await pg.goto((HERE / f"frame-{theme}.html").as_uri()); await pg.wait_for_timeout(300)
      fr=pg.frames[1]
      post=lambda m: fr.evaluate("m=>window.postMessage(m,'*')",m)
      await post(favs); await post(ctx(prod, alias)); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now-60000,"refreshing":False}); await fr.wait_for_timeout(80)
      return pg, fr, post
    async def shot(pg, name): await pg.wait_for_timeout(120); await pg.screenshot(path=f"{OUT}/{name}.png")

    # 1 overview
    for theme in ["dark","light"]:
      pg,fr,post=await open_frame(theme)
      await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await shot(pg, "overview" if theme=="dark" else "light-theme"); await pg.close()

    # 2 editing a Lead page
    pg,fr,post=await open_frame()
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(60)
    await fr.click("td:has-text('Lead') >> nth=0"); await post(LEAD); await post(RT); await fr.wait_for_timeout(60)
    await fr.click("[aria-label='Read Sales Region']"); await fr.click("[aria-label='Edit Rating']"); await fr.click("[aria-label='Assign Partner Lead']")
    await fr.evaluate("document.querySelector('main.record').scrollTop=0"); await shot(pg,"editing")
    # 3 review (keep same page, open review)
    await fr.click(".docked-footer button.brand"); await shot(pg,"review-sandbox"); await pg.close()

    # 3b review on production
    pg,fr,post=await open_frame(prod=True, alias="acme-prod")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(60)
    await fr.click("td:has-text('Lead') >> nth=0"); await post(LEAD); await post(RT); await fr.wait_for_timeout(60)
    await fr.click("[aria-label='Read Sales Region']"); await fr.click("[aria-label='Edit Rating']")
    await fr.click(".docked-footer button.brand"); await fr.fill("#confirm","acme-prod"); await fr.dispatch_event("#confirm","input"); await shot(pg,"review"); await pg.close()

    # 6 groups
    pg,fr,post=await open_frame()
    await fr.click("button.kind:has-text('Groups')"); await fr.click(".split-item:has-text('Sales Team Bundle')")
    g=detail(key="group:1",label="Sales Team Bundle",api="Sales_Team_Bundle",kind="Permission Set Group",kindId="group",cats=["assignment","groupComponent"],status="Updating",
      reason="",desc="Everything the sales team needs, in one assignment.")
    await post(g); await fr.wait_for_timeout(40)
    await fr.click(".nav-item:has-text('Permission Sets')")
    await post({"type":"components","key":"group:1","savedAt":now,"refreshing":False,"data":{"status":"Updating","components":[
      {"permissionSetId":"1","label":"Sales Operations","apiName":"Sales_Operations","muting":False,"managed":False},{"permissionSetId":"6","label":"Quote Approver","apiName":"Quote_Approver","muting":False,"managed":False},
      {"permissionSetId":"7","label":"Report Builder","apiName":"acmeapps__Report_Builder","muting":False,"managed":True},{"permissionSetId":"0QM1","label":"Sales Team Muting","apiName":"Sales_Team_Muting","muting":True,"managed":False}]}}); await fr.wait_for_timeout(40)
    await fr.click("[data-fid='search.compadd']"); await fr.type("[data-fid='search.compadd']","data",delay=30); await fr.wait_for_timeout(250)
    await fr.click("ul.results button:has-text('Add')"); await fr.fill("[data-fid='search.compadd']",""); await fr.wait_for_timeout(250)
    await shot(pg,"groups"); await pg.close()

    await b.close()
asyncio.run(main())
