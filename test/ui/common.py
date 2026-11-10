"""Shared by the browser tests: where the page harnesses are, how to start the browser, and sample data.

The harnesses (harness/dark.html, harness/light.html) load the real media/app.js, media/app.css and
src/model/dependencies.js, with a stand-in for VS Code's webview API that records every message
the page sends (window.sent). Set CHROME to use a particular Chrome or Chromium; otherwise
Playwright's own Chromium is used (python -m playwright install chromium).
"""
import os, json, time, pathlib, tempfile
HERE = pathlib.Path(__file__).resolve().parent
DARK = (HERE / 'harness' / 'dark.html').as_uri()
LIGHT = (HERE / 'harness' / 'light.html').as_uri()
DATA = HERE / 'data'
OUT = pathlib.Path(os.environ.get('UI_OUT') or os.path.join(tempfile.gettempdir(), 'permission-studio-ui'))
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get('CHROME') or None
def launch_args():
    """Arguments for p.chromium.launch(): the Chrome in CHROME, or Playwright's own."""
    return dict(executable_path=CHROME, args=['--no-sandbox']) if CHROME else dict(args=['--no-sandbox'])

# ---------- sample data: lists, a permission set's detail, an object's detail ----------
now=int(time.time()*1000)
def row(k,kind,l,a,**kw): return dict(key=k,kind=kind,label=l,apiName=a,managed=kw.get('m',False),standard=kw.get('s',False),status=kw.get('st',''),license=kw.get('lic',''))
lists={"permissionSet":[row("permissionSet:1","permissionSet","Sales Operations","Sales_Operations"),row("permissionSet:2","permissionSet","Report Builder","acme__Report_Builder",m=True),row("permissionSet:3","permissionSet","Lead Management","Lead_Management"),row("permissionSet:4","permissionSet","API Integration User","API_Integration_User")],
 "group":[row("group:1","group","Sales Bundle","Sales_Bundle",st="Updating")],"profile":[row("profile:1","profile","System Administrator","System Administrator",s=True,lic="Salesforce")]}
ctx={"type":"context","status":"ready","message":"","projectDir":"/w/sales-app","org":{"alias":"uat","username":"dev.user@example.com.uat","location":"Local"},"production":True,"mode":"rest","connecting":False,"offline":False}
P=lambda **k: {**{"read":False,"create":False,"edit":False,"delete":False,"viewAll":False,"modifyAll":False,"viewAllFields":False},**k}
detail={"type":"detail","key":"permissionSet:1","savedAt":now-120000,"refreshing":False,"data":{"header":{"label":"Sales Operations","apiName":"Sales_Operations","kind":"Permission Set","kindId":"permissionSet","license":"Salesforce","status":"","activeAssignees":23,"managed":False,"standard":False,"description":"Access for the sales operations team to manage leads, opportunities and campaigns.","modified":{"at":"2026-10-28T09:12:00.000Z","by":"Admin User"},"editable":True,"readOnlyReason":"","editableCats":["object","field","user","assignment","apexClass","apexPage","customPermission","flow","app","connectedApp","customMetadata","customSetting","recordType","layoutAssignment","loginHours","loginIpRanges","tab"],"canRename":True,"canClone":True},
 "objects":[{"name":"Account","label":"Account","props":P(read=True,create=True,edit=True)},{"name":"Campaign","label":"Campaign","props":P(read=True)},{"name":"Lead","label":"Lead","props":P(read=True,create=True,edit=True,delete=True,viewAll=True)},{"name":"Opportunity","label":"Opportunity","props":P(read=True,create=True,edit=True)}],
 "system":[{"name":"ApiEnabled","label":"API Enabled","enabled":True},{"name":"ModifyAllData","label":"Modify All Data","enabled":False},{"name":"ViewSetup","label":"View Setup and Configuration","enabled":True},{"name":"RunReports","label":"Run Reports","enabled":True},{"name":"ExportReport","label":"Export Reports","enabled":False}],
 "objectColumns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"]}}
F=lambda a,l,t,r,e,c=True: {"name":"Lead."+a,"apiName":a,"label":l,"type":t,"canEdit":c,"read":r,"edit":e}
objd={"type":"objectDetail","key":"permissionSet:1","object":"Lead","savedAt":now,"refreshing":False,"data":{"object":"Lead","label":"Lead","props":P(read=True,create=True,edit=True,delete=True,viewAll=True),"columns":["read","create","edit","delete","viewAll","modifyAll","viewAllFields"],
 "fields":[F("AnnualRevenue","Annual Revenue","currency",True,False),F("Description","Description","textarea",False,False),F("Industry","Industry","picklist",True,True),F("LeadSource","Lead Source","picklist",True,True),F("Rating","Rating","picklist",True,False),F("Score__c","Score","double",True,False,False),F("Website","Website","url",False,False)]}}
