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
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(**launch_args())
    async def frame(title, width=1440, prod=False, alias="acme-dev", sandbox=True):
      pg=await b.new_page(viewport={"width":1600,"height":1060},device_scale_factor=1.5)
      await pg.goto((HERE / "frame-dark.html").as_uri()); await pg.wait_for_timeout(250)
      await pg.evaluate("""([t,w])=>{document.body.style.flexDirection='column';document.body.style.gap='18px';const c=document.createElement('div');c.textContent=t;
        c.style.cssText='color:#dbe6fb;font:600 20px \"Noto Sans CJK JP\",sans-serif;width:'+w+'px';document.body.insertBefore(c,document.body.firstChild);
        document.querySelector('.win').style.width=w+'px';document.querySelector('iframe').style.width=w+'px'}""",[title,width])
      fr=pg.frames[1]; post=lambda m: fr.evaluate("m=>window.postMessage(m,'*')",m)
      c=ctx(prod, alias); c["sandbox"]=sandbox and not prod
      await post(favs); await post(c); await post({"type":"lists","lists":lists,"kinds":["permissionSet","group","profile"],"savedAt":now-60000,"refreshing":False}); await fr.wait_for_timeout(80)
      return pg, fr, post
    async def lead(fr, post):
      await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(50)
      await fr.click("td:has-text('Lead') >> nth=0"); await post(LEAD); await post(RT); await fr.wait_for_timeout(60)
    async def shot(pg,n): await pg.wait_for_timeout(200); await pg.screenshot(path=f"{OUT}/readme-{n}.png")

    # review
    pg,fr,post=await frame("")
    await post({"type":"permDeps","system":{"ModifyAllData":["ViewAllData"]},"custom":{}})
    await lead(fr, post)
    for a in ['Read Sales Region','Edit Rating','Read Website','Assign Partner Lead']: await fr.click(f"[aria-label='{a}']")
    await fr.click(".breadcrumb button"); await fr.click(".nav-item:has-text('System Permissions')"); await fr.wait_for_timeout(30)
    await fr.click("[aria-label='Modify All Data']"); await fr.wait_for_timeout(30)
    await fr.click(".docked-footer button.brand"); await fr.wait_for_timeout(60)
    await shot(pg,"1-review"); await pg.close()

    # Find access
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('Find access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead","objectPerms":True},{"name":"Opportunity","label":"Opportunity","objectPerms":True}]})
    await fr.click("[data-fid='lk.target']"); await pg.keyboard.type("Lead.Rating", delay=10); await fr.wait_for_timeout(30)
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead.Rating","apiName":"Rating","label":"Rating","type":"picklist","custom":False,"canEdit":True}]})
    await fr.dispatch_event("[data-fid='lk.target']","change"); await fr.select_option("[aria-label='Access']","edit"); await fr.click(".lk-bar button.brand")
    S=[("ps1","permissionSet:1","permissionSet","Sales Operations",["object"],["field"],18,None),("ps6","permissionSet:6","permissionSet","Quote Approver",["object"],["field"],6,None),
       ("pr1","profile:1","profile","Custom: Sales",["object"],[],31,None),("pr3","profile:3","profile","System Administrator",["ModifyAllData"],["field"],4,None),("g1","group:1","group","Sales Team Bundle",["object"],["field"],12,["Quote Approver"])]
    U=[("Avery Chen","avery@acme.example","Custom: Sales",["ps1","pr1"],["ps1"]),("Blake Morgan","blake@acme.example","Custom: Sales",["pr1","g1"],["g1"]),("Casey Patel","casey@acme.example","System Administrator",["pr3"],["pr3"]),
       ("Devon Ruiz","devon@acme.example","Custom: Sales",["ps6","pr1"],["ps6"]),("Emery Walsh","emery@acme.example","Custom: Sales",["ps1"],["ps1"]),("Finley Okoro","finley@acme.example","Custom: Service",["g1"],["g1"])]
    res={"object":"Lead","field":"Lead.Rating","level":"edit","sources":[dict(permissionSetId=a,key=k,kind=kd,label=l,apiName=l,objectVia=ov,fieldVia=fv,users=n,**({"includes":inc} if inc else {})) for a,k,kd,l,ov,fv,n,inc in S],
      "users":[{"userId":str(i),"name":n,"username":u,"profile":pf,"license":"Salesforce","objectFrom":o,"fieldFrom":f} for i,(n,u,pf,o,f) in enumerate(U)],
      "partial":[{"userId":"p1","name":"Harper Quinn","objectFrom":["pr1"],"fieldFrom":[]},{"userId":"p2","name":"Jules Kim","objectFrom":["pr1"],"fieldFrom":[]}],"inactive":[]}
    await post({"type":"lookupResult","result":res}); await fr.wait_for_timeout(40)
    await fr.select_option("[aria-label='Profile']","Custom: Sales"); await fr.wait_for_timeout(30)
    await fr.click("tr:has-text('Blake Morgan') button:has-text('Why?')")
    await fr.click("[aria-label='Select Sales Operations']")
    await shot(pg,"2-find-access"); await pg.close()

    # Grant field access
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('Grant field access')"); await post({"type":"objectCatalog","objects":[{"name":"Lead","label":"Lead","objectPerms":True}]})
    await fr.fill("[data-fid='wz.obj']","Lead"); await fr.dispatch_event("[data-fid='wz.obj']","change")
    await post({"type":"wizardFields","object":"Lead","fields":[{"name":"Lead."+a,"apiName":a,"label":l,"type":t,"custom":True,"canEdit":c} for a,l,t,c in [("Region__c","Sales Region","picklist",True),("Score__c","Lead Score","double",False),("Tier__c","Account Tier","picklist",True),("Segment__c","Segment","picklist",True)]]}); await fr.wait_for_timeout(30)
    for f in ["Sales Region","Account Tier"]: await fr.click(f"[aria-label='{f}']")
    await fr.click("text=Read and Edit")
    bk={"permissionSet:1":{"users":18,"objectRead":True,"fields":{"Lead.Tier__c":{"read":True,"edit":False}}},"permissionSet:2":{"users":9,"objectRead":False,"fields":{}},
        "permissionSet:6":{"users":6,"objectRead":True,"fields":{"Lead.Region__c":{"read":True,"edit":True}}},"profile:1":{"users":31,"objectRead":True,"fields":{"Lead.Region__c":{"read":True,"edit":False},"Lead.Tier__c":{"read":True,"edit":False}}},
        "permissionSet:3":{"users":14,"objectRead":True,"fields":{}},"permissionSet:4":{"users":3,"objectRead":True,"fields":{}}}
    await post({"type":"wizardCurrent","object":"Lead","fields":["Lead.Region__c","Lead.Tier__c"],"byKey":bk}); await fr.wait_for_timeout(30)
    await fr.click("button:has-text('Add favorites')")
    for n in ["Quote Approver","Custom: Sales"]: await fr.click(f"[aria-label='{n}']")
    await shot(pg,"3-grant-fields"); await pg.close()

    # Grant object access
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('Grant object access')"); await post({"type":"objectCatalog","objects":[{"name":"Quote","label":"Quote","objectPerms":True}]})
    await fr.fill("[data-fid='ow.obj']","Quote"); await fr.dispatch_event("[data-fid='ow.obj']","change")
    await post({"type":"objWizardInfo","object":"Quote","columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],"recordTypes":[{"name":"Quote.Standard","developerName":"Standard","label":"Standard Quote","active":True}]})
    await post({"type":"objWizardCurrent","object":"Quote","byKey":{"permissionSet:1":{"users":18,"props":{"read":True,"edit":True}},"permissionSet:6":{"users":6,"props":{"read":True,"create":True,"edit":True}},"permissionSet:2":{"users":9,"props":{}},"profile:1":{"users":31,"props":{}},"permissionSet:3":{"users":14,"props":{}}}}); await fr.wait_for_timeout(40)
    await fr.click("[aria-label='Standard Quote']"); await fr.click("[aria-label='Default Standard Quote']")
    await fr.click("[aria-label='Grant create to Sales Operations']"); await fr.click("[aria-label='Grant viewAll to Quote Approver']"); await fr.click("[aria-label='Grant delete to Quote Approver']")
    await fr.click("[aria-label='Grant read to Service Agent']"); await fr.click("[aria-label='Grant edit to Custom: Sales']"); await fr.click("[aria-label='Grant create to Custom: Sales']")
    await shot(pg,"4-grant-object"); await pg.close()

    # History
    pg,fr,post=await frame("")
    await fr.click(".split-item:has-text('Sales Operations')"); await post(detail()); await fr.wait_for_timeout(40)
    await fr.click(".globalbar button:has-text('History')")
    tdy=time.strftime('%Y-%m-%dT', time.gmtime()); yd=time.strftime('%Y-%m-%dT', time.gmtime(time.time()-86400))
    H=[(tdy+"11:42:00","Sales_Operations","permissionSet:1","records",3,"saved","s5","ADO US 11581701",[("field:Lead.Rating","Rating",{"read":True,"edit":False},{"read":True,"edit":True}),("field:Lead.Region__c","Sales Region",None,{"read":True,"edit":False}),("field:Lead.Website","Website",{"read":True},{"read":False,"edit":False})]),
       (tdy+"11:05:00","Sales_Team_Bundle","group:1","records",1,"saved","s4","ADO US 11581701",[("groupComponent:8","Data Steward",{"included":False},{"included":True})]),
       (yd+"16:48:00","Custom: Sales","profile:1","records + deploy",2,"saved","s3",None,[("recordType:Lead.Partner","Partner Lead",None,{"visible":True}),("object:Quote","Quote",None,{"read":True})]),
       (yd+"15:02:00","Quote_Approver","permissionSet:6","records",1,"failed","s1",None,[("user:ExportReport","Export Reports",{"enabled":False},{"enabled":True})])]
    await post({"type":"history","entries":[{"at":a+".000Z","target":t,"key":k,"path":pth,"count":n,"result":r,"snapshot":sn,"ticket":tk,"error":"DELETE_FAILED: The Sales_Team_Bundle permission set group is updating." if r=="failed" else None,
      "changes":[{"key":ck,"label":cl,"from":f,"to":to} for ck,cl,f,to in ch]} for a,t,k,pth,n,r,sn,tk,ch in H]}); await fr.wait_for_timeout(30)
    await fr.click("label.toggle:has-text('Include changes made in Setup'), .toggle:has-text('Include changes made in Setup')")
    await post({"type":"historySetup","entries":[{"at":tdy+"10:31:00.000Z","by":"Jordan Lee","section":"Manage Users","display":"Changed profile Custom: Sales: field-level security for Lead: Rating was changed","delegate":"","name":"Custom: Sales","key":"profile:1"}]}); await fr.wait_for_timeout(30)
    await fr.click("[aria-label='Select save of Sales_Operations']"); await fr.click("[aria-label='Select save of Sales_Team_Bundle']")
    await shot(pg,"5-history"); await pg.close()

    await b.close(); return
    # kept changes + narrow
    pg,fr,post=await frame("Built: unsaved changes kept, in a narrow window", width=820)
    await post({"type":"persisted","values":{"pending":{"key":"permissionSet:1","entries":[["field:Lead.Rating",{"before":{"read":True,"edit":False},"after":{"read":True,"edit":True},"label":"Rating","cat":"field","touched":["edit"]}],["user:ApiEnabled",{"before":{"enabled":False},"after":{"enabled":True},"label":"API Enabled","cat":"user","touched":["enabled"]}]]}}})
    await fr.wait_for_timeout(40); await post(detail()); await fr.wait_for_timeout(60)
    await shot(pg,"6-kept-narrow"); await pg.close()
    await b.close()
asyncio.run(main())
