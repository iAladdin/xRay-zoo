#!/usr/bin/env python3
"""Initialize and validate the isolated P0 engine, without printing credentials."""
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import argparse, json, os, secrets, subprocess, datetime, hashlib

ROOT=Path(__file__).resolve().parents[1]
LOCAL=ROOT/'.local'
AUTH=LOCAL/'engine-auth.json'

def save(path,value):
    temporary=Path(str(path)+'.tmp')
    fd=os.open(temporary,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2)
    temporary.replace(path)

def request(path,method='GET',body=None,auth=None):
    auth=auth or (json.loads(AUTH.read_text()) if AUTH.exists() else {'baseUrl':'http://127.0.0.1:3300'})
    headers={'Content-Type':'application/json','X-Forwarded-Proto':'https','X-Forwarded-For':'127.0.0.1'}
    if auth.get('apiToken') or auth.get('accessToken'):headers['Authorization']='Bearer '+(auth.get('apiToken') or auth['accessToken'])
    if auth.get('adminBootstrap'):headers['X-Remnawave-Client-Type']='browser'
    req=Request(auth['baseUrl']+'/api'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers=headers)
    try:
        with urlopen(req,timeout=30) as r:return json.load(r).get('response')
    except HTTPError as e:
        raw=e.read().decode()
        save(LOCAL/'engine-last-error.json',{'status':e.code,'path':path,'response':raw})
        raise RuntimeError(f'Engine HTTP {e.code} for {path}; private diagnostic saved') from None

def rows(value,key):
    if isinstance(value,list):return value
    return value.get(key,[])

def init(args):
    if AUTH.exists():a=json.loads(AUTH.read_text())
    else:
        a={'baseUrl':'http://127.0.0.1:3300','username':'xrayzoo_p0','password':'Xz9_'+secrets.token_urlsafe(36)}
        save(AUTH,a)
    state=request('/auth/status',auth={'baseUrl':a['baseUrl']})
    path='/auth/register' if state['isRegisterAllowed'] else '/auth/login'
    answer=request(path,'POST',{'username':a['username'],'password':a['password']},auth={'baseUrl':a['baseUrl']})
    a['accessToken']=answer['accessToken'];save(AUTH,a)
    if not a.get('apiToken'):
        admin={**a,'adminBootstrap':True}
        scopes=[x+':*' for x in ['keygen','config-profiles','internal-squads','nodes','hosts','users']]
        token=request('/tokens','POST',{'name':'xray-zoo-p0','expiresInDays':30,'scopes':scopes},auth=admin)
        a['apiToken']=token['token'];save(AUTH,a)
    a['nodeSecret']=request('/keygen',auth=a)['secretKey'];save(AUTH,a)
    print('P0 engine authenticated; Node trust credential saved privately')

def keys():
    code="const{generateKeyPairSync}=require('node:crypto');const p=generateKeyPairSync('x25519');process.stdout.write(JSON.stringify({privateKey:p.privateKey.export({format:'jwk'}).d,publicKey:p.publicKey.export({format:'jwk'}).x}));"
    return json.loads(subprocess.run(['node','-e',code],check=True,capture_output=True,text=True).stdout)

def configure(args):
    inventory=json.loads((LOCAL/'azure-inventory.json').read_text())
    path=LOCAL/'engine-nodes.json';state=json.loads(path.read_text()) if path.exists() else {}
    profiles=rows(request('/config-profiles'),'configProfiles')
    squads=rows(request('/internal-squads'),'internalSquads')
    enodes=rows(request('/nodes'),'nodes')
    hosts=rows(request('/hosts'),'hosts')
    for n in inventory['nodes']:
        if n['state']!='Succeeded':continue
        code=n['code'];name=n['name']
        s=state.setdefault(code,{'keys':keys(),'shortId':secrets.token_hex(8),'serverName':'www.cloudflare.com'})
        save(path,state)
        profile=next((p for p in profiles if p['name']==name),None)
        if not profile:
            cfg={'log':{'loglevel':'warning','access':'none'},'inbounds':[{'tag':name,'port':443,'listen':'0.0.0.0','protocol':'vless','settings':{'clients':[],'decryption':'none'},'sniffing':{'enabled':True,'destOverride':['http','tls'],'routeOnly':True},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'show':False,'target':s['serverName']+':443','serverNames':[s['serverName']],'privateKey':s['keys']['privateKey'],'shortIds':[s['shortId']]}}}], 'outbounds':[{'tag':'DIRECT','protocol':'freedom','settings':{},'streamSettings':{'sockopt':{'domainStrategy':'UseIP'}}},{'tag':'BLOCK','protocol':'blackhole'}], 'routing':{'domainStrategy':'IPIfNonMatch','rules':[{'type':'field','ip':['geoip:private','169.254.169.254','168.63.129.16'],'outboundTag':'BLOCK'}]}}
            profile=request('/config-profiles','POST',{'name':name,'config':cfg})
        s['configProfileId']=profile['uuid']
        inbound=next(i for i in profile['inbounds'] if i['tag']==name)
        s['inboundId']=inbound['uuid'];save(path,state)
        squad=next((q for q in squads if q['name']==name),None)
        if not squad:squad=request('/internal-squads','POST',{'name':name,'inbounds':[s['inboundId']]})
        s['squadId']=squad['uuid'];save(path,state)
        en=next((x for x in enodes if x['name']==name),None)
        if not en:en=request('/nodes','POST',{'name':name,'address':n['address'],'port':2222,'countryCode':code.upper(),'configProfile':{'activeConfigProfileUuid':s['configProfileId'],'activeInbounds':[s['inboundId']]}})
        s['engineNodeId']=en['uuid'];save(path,state)
        host=next((h for h in hosts if h['remark']==name),None)
        if not host:host=request('/hosts','POST',{'remark':name,'address':n['address'],'port':443,'sni':s['serverName'],'fingerprint':'chrome','inbound':{'configProfileUuid':s['configProfileId'],'configProfileInboundUuid':s['inboundId']},'nodes':[s['engineNodeId']]})
        s['hostId']=host['uuid'];save(path,state)
        print(json.dumps({'node':name,'profile':'configured','engineNode':'registered'}),flush=True)
    export(args)

def export(args):
    inventory=json.loads((LOCAL/'azure-inventory.json').read_text());state=json.loads((LOCAL/'engine-nodes.json').read_text())
    enodes=rows(request('/nodes'),'nodes');result=[]
    for n in inventory['nodes']:
        s=state.get(n['code'])
        if not s:continue
        en=next((x for x in enodes if x['uuid']==s.get('engineNodeId')),{})
        # Connectivity is an engine observation; the separate client probe is required before delivery.
        connected=bool(en.get('isConnected',False))
        result.append({'id':n['name'],'name':n['name'],'country':n['code'].upper(),'region':n['region'],'address':n['address'],'port':443,'publicKey':s['keys']['publicKey'],'shortId':s['shortId'],'serverName':s['serverName'],'engineNodeId':s['engineNodeId'],'configProfileId':s['configProfileId'],'inboundId':s['inboundId'],'squadId':s['squadId'],'ready':connected,'engineConnected':connected})
    save(LOCAL/'nodes.json',{'nodes':result})
    print(json.dumps([{'name':n['name'],'connected':n['ready']} for n in result]))

def customer(args):
    state=json.loads((LOCAL/'engine-nodes.json').read_text())
    allusers=rows(request('/users?size=100&start=0'),'users')
    user=next((u for u in allusers if u['username']=='xz_p0_customer'),None)
    if not user:
        user=request('/users','POST',{'username':'xz_p0_customer','status':'ACTIVE','trafficLimitBytes':20000000000,'trafficLimitStrategy':'NO_RESET','expireAt':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30)).isoformat(),'activeInternalSquads':[n['squadId'] for n in state.values()]})
    save(LOCAL/'p0-access.json',{'engineUserId':user['id'],'vlessUuid':user['vlessUuid'],'expireAt':user['expireAt'],'quotaBytes':user['trafficLimitBytes']})
    print('P0 access identity saved privately; 20 GB shared quota, 30-day service period')

if __name__ == "__main__":
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    for name,fn in [('init',init),('configure',configure),('export',export),('customer',customer)]:sub.add_parser(name).set_defaults(func=fn)
    args=p.parse_args();args.func(args)
