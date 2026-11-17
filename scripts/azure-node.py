#!/usr/bin/env python3
"""JSON adapter for the operator's Azure connection. Input is stdin, never a shell.
Only the configured subscription/resource group can be mutated. Secrets stay local
or in ARM protectedSettings; stdout contains allowlisted public results only.
"""
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
import base64, datetime, fcntl, hashlib, importlib.util, ipaddress, json, os, re, shlex, subprocess, sys, time, uuid

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
transport = LOCAL / 'control-transport.json'
if transport.exists():
    port = int(json.loads(transport.read_text())['socksPort'])
    if not 1024 <= port <= 65535: raise ValueError('INVALID_CONTROL_PORT')
    os.environ['HTTPS_PROXY'] = os.environ['HTTP_PROXY'] = f'http://127.0.0.1:{port}'
spec = importlib.util.spec_from_file_location('azure_p0', ROOT/'scripts/azure-p0.py')
p0 = importlib.util.module_from_spec(spec); spec.loader.exec_module(p0)
IMAGE = 'remnawave/node@sha256:3d5fde656a36920f53c5c080f2dc821df8318f453803b07c4e5242752a549d69'


def connection():
    source = LOCAL/'azure-provisioning.json'
    data = json.loads((source if source.exists() else LOCAL/'azure-plan.json').read_text())
    result = {k: data[k] for k in ('subscription', 'resourceGroup', 'managementSourceCidr')}
    if not re.fullmatch(r'[a-fA-F0-9-]{36}', result['subscription']): raise ValueError('INVALID_SUBSCRIPTION')
    if not re.fullmatch(r'[A-Za-z0-9_.()-]{1,80}', result['resourceGroup']): raise ValueError('INVALID_RESOURCE_GROUP')
    net = ipaddress.ip_network(result['managementSourceCidr'], strict=True)
    if net.version != 4 or net.num_addresses != 1: raise ValueError('MANAGEMENT_SINGLE_IP_REQUIRED')
    result['controlAddress'] = data.get('controlAddress')
    if not result['controlAddress']:
        for line in (LOCAL/'stack.env').read_text().splitlines():
            if line.startswith('P0_HOST_GATEWAY='): result['controlAddress'] = line.split('=', 1)[1].strip('"\'')
    if not result['controlAddress']: raise ValueError('CONTROL_GATEWAY_NOT_CONFIGURED')
    ipaddress.ip_address(result['controlAddress'])
    return result


def cached(name, ttl, fetch, fresh=False):
    path = LOCAL/'azure-catalog'/f'{name}.json'
    if not fresh and path.exists() and time.time()-path.stat().st_mtime < ttl:
        return json.loads(path.read_text())
    value = fetch()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.'+str(uuid.uuid4())+'.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out: json.dump(value, out)
    temporary.replace(path)
    return value


def country(location):
    meta = location.get('metadata', {})
    aliases = {'Asia Pacific': {'eastasia': 'HK', 'southeastasia': 'SG'}, 'Europe': {'westeurope': 'NL', 'northeurope': 'IE'}}
    geo = meta.get('geography', '')
    if geo in ('UAE',): return 'AE'
    if geo in ('Canary (US)', 'Stage (US)'): return 'US'
    mapping = {'United States': 'US', 'Japan': 'JP', 'Taiwan': 'TW', 'Australia': 'AU', 'Austria': 'AT', 'Belgium': 'BE', 'Brazil': 'BR', 'Canada': 'CA', 'Chile': 'CL', 'China': 'CN', 'Denmark': 'DK', 'Finland': 'FI', 'France': 'FR', 'Germany': 'DE', 'Greece': 'GR', 'India': 'IN', 'Indonesia': 'ID', 'Israel': 'IL', 'Italy': 'IT', 'Korea': 'KR', 'South Korea': 'KR', 'Malaysia': 'MY', 'Mexico': 'MX', 'New Zealand': 'NZ', 'Norway': 'NO', 'Poland': 'PL', 'Qatar': 'QA', 'Saudi Arabia': 'SA', 'Singapore': 'SG', 'South Africa': 'ZA', 'Spain': 'ES', 'Sweden': 'SE', 'Switzerland': 'CH', 'United Arab Emirates': 'AE', 'United Kingdom': 'GB'}
    return mapping.get(geo) or aliases.get(geo, {}).get(location['name']) or mapping.get(meta.get('physicalLocation', ''))


def locations(api):
    def fetch():
        provider = api.request('/providers/Microsoft.Compute?api-version=2021-04-01')
        vm = next((x for x in provider.get('resourceTypes', []) if x['resourceType']=='virtualMachines'), {})
        supported = set(vm.get('locations', []))
        rows = api.list('/locations?api-version=2022-12-01')
        return sorted([{'name': x['name'], 'displayName': x.get('displayName', x['name']), 'geography': x.get('metadata', {}).get('geography', ''), 'country': country(x), 'available': x.get('displayName') in supported, 'physicalLocation': x.get('metadata', {}).get('physicalLocation', '')} for x in rows if x.get('metadata', {}).get('regionType')=='Physical'], key=lambda x:x['displayName'])
    return cached('locations', 900, fetch)


def skus(api, location, fresh=False):
    if not re.fullmatch(r'[a-z0-9]{2,40}', location): raise ValueError('INVALID_REGION')
    raw = cached('skus-'+location, 300, lambda: api.list('/providers/Microsoft.Compute/skus?'+urlencode({'api-version':'2021-07-01', '$filter':f"location eq '{location}'"})), fresh)
    usages = api.list(f'/providers/Microsoft.Compute/locations/{location}/usages?api-version=2024-03-01')
    quota = {x['name']['value'].lower(): x for x in usages}
    result = []
    for s in raw:
        # ARM returns mixed-case names for some regions (e.g. KoreaCentral/UAENorth).
        # Match both SKU membership and restrictions using canonical region codes.
        if s.get('resourceType')!='virtualMachines' or location not in [x.lower() for x in (s.get('locations') or [])]: continue
        caps = {x['name']:x['value'] for x in s.get('capabilities', [])}
        cpu = int(caps.get('vCPUs', '0')); memory=float(caps.get('MemoryGB', '0'))
        family = s.get('family', '').lower(); reasons=[]
        for r in s.get('restrictions', []):
            restricted_locations = (r.get('values') or []) + ((r.get('restrictionInfo') or {}).get('locations') or [])
            if r.get('type')=='Location' and (not restricted_locations or location in [x.lower() for x in restricted_locations]): reasons.append(r.get('reasonCode', 'LocationRestricted'))
        if caps.get('CpuArchitectureType', 'x64').lower() not in ('x64', 'amd64'): reasons.append('当前镜像仅支持 x64')
        if caps.get('HyperVGenerations') and 'V2' not in caps['HyperVGenerations']: reasons.append('需要支持 Gen2 Ubuntu 镜像')
        if cpu < 1 or memory < 1: reasons.append('至少需要 1 vCPU / 1 GiB')
        if caps.get('HyperVGenerations') is None and caps.get('DiskControllerTypes')=='NVMe': reasons.append('需要核验镜像磁盘兼容性')
        for key in ('cores', family):
            q=quota.get(key)
            if not q: reasons.append('无法核验区域或规格族配额')
            elif q['limit']-q['currentValue'] < cpu: reasons.append('区域或规格族 vCPU 配额不足')
        result.append({'name':s['name'], 'vcpus':cpu, 'memoryGiB':memory, 'family':s.get('family'), 'available':not reasons, 'reasons':list(dict.fromkeys(reasons))})
    return {'items':sorted(result, key=lambda x:(not x['available'],x['vcpus'],x['memoryGiB'],x['name'])), 'quota':[{'name':x['name']['value'],'limit':x['limit'],'used':x['currentValue']} for x in usages], 'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}


def prices(region, size):
    def fetch():
        query = f"serviceName eq 'Virtual Machines' and armRegionName eq '{region}' and armSkuName eq '{size}' and priceType eq 'Consumption'"
        url='https://prices.azure.com/api/retail/prices?'+urlencode({'$filter':query,'currencyCode':"'USD'"})
        rows=[]
        for _ in range(10):
            with urlopen(url, timeout=20) as r: data=json.load(r)
            rows+=data.get('Items', []); url=data.get('NextPageLink')
            if not url: break
            if not url.startswith('https://prices.azure.com/'): raise ValueError('INVALID_PRICING_HOST')
        candidates=[x for x in rows if x.get('type')=='Consumption' and x.get('unitOfMeasure')=='1 Hour' and x.get('productName','').startswith('Virtual Machines') and not any(w in (x.get('productName','')+' '+x.get('skuName','')).lower() for w in ('windows','spot','low priority')) and x.get('isPrimaryMeterRegion',True)]
        rate=min((x['retailPrice'] for x in candidates),default=None)
        return {'currency':'USD','hoursPerMonth':730,'computeHourly':rate,'computeMonthly':round(rate*730,3) if rate is not None else None,'source':'https://prices.azure.com/api/retail/prices','excludes':['磁盘（32 GiB Standard HDD）','Standard 公网 IPv4','出网流量','磁盘操作、备份和税费']}
    try: return cached('price-hdd-'+region+'-'+size,3600,fetch)
    except Exception: return {'currency':'USD','computeHourly':None,'computeMonthly':None,'excludes':['价格暂不可用；VM、磁盘、公网 IP 和流量均会计费']}


def scope(api, conn):
    group=api.request(f'/resourcegroups/{conn["resourceGroup"]}?api-version=2022-09-01')
    if group.get('tags',{}).get('managed-by')!='xray-zoo': raise ValueError('RESOURCE_GROUP_NOT_OWNED')


def prepare(api, conn, data):
    region=data['region']; size=data['size']
    if not re.fullmatch(r'Standard_[A-Za-z0-9_-]{1,70}',size): raise ValueError('INVALID_SIZE')
    loc=next((x for x in locations(api) if x['name']==region and x['available']),None)
    if not loc: raise ValueError('REGION_UNAVAILABLE')
    if not loc['country']: raise ValueError('REGION_COUNTRY_MAPPING_REQUIRED')
    sku=next((x for x in skus(api,region,True)['items'] if x['name']==size),None)
    if not sku or not sku['available']: raise ValueError('SKU_OR_QUOTA_UNAVAILABLE')
    scope(api,conn)
    usage=api.list(f'/providers/Microsoft.Network/locations/{region}/usages?api-version=2024-05-01')
    ips=[x for x in usage if x['name']['value'].lower() in ('publicipaddresses','staticpublicipaddresses')]
    if not ips: raise ValueError('PUBLIC_IP_QUOTA_UNVERIFIED')
    if any(x['currentValue']>=x['limit'] for x in ips): raise ValueError('PUBLIC_IP_QUOTA_EXCEEDED')
    images=api.list(f'/providers/Microsoft.Compute/locations/{region}/publishers/Canonical/artifacttypes/vmimage/offers/ubuntu-24_04-lts/skus/server/versions?'+urlencode({'api-version':'2024-03-01','$top':'1','$orderby':'name desc'}))
    if not images: raise ValueError('UBUNTU_IMAGE_UNAVAILABLE')
    version=images[0]['name']
    image=api.request(f'/providers/Microsoft.Compute/locations/{region}/publishers/Canonical/artifacttypes/vmimage/offers/ubuntu-24_04-lts/skus/server/versions/{version}?api-version=2024-03-01')
    if image.get('properties',{}).get('osDiskImage',{}).get('sizeInGb',32)>32: raise ValueError('IMAGE_REQUIRES_LARGER_DISK')
    if not (LOCAL/'node_ssh.pub').exists(): raise ValueError('SSH_KEY_NOT_CONFIGURED')
    return {**conn,'region':region,'country':loc['country'],'regionName':loc['displayName'],'size':size,'vcpus':sku['vcpus'],'memoryGiB':sku['memoryGiB'],'imageVersion':version,'templateHash':hashlib.sha256((ROOT/'infra/azure/node.bicep').read_bytes()).hexdigest(),'cloudInitHash':hashlib.sha256((ROOT/'infra/azure/cloud-init.yaml').read_bytes()).hexdigest(),'nodeImage':IMAGE,'diskType':'Standard_LRS','diskSizeGiB':32,'cost':prices(region,size)}


def deployment(api, conn, data):
    plan=data['plan']; name=data['nodeName']
    if not re.fullmatch(r'[a-f0-9-]{36}',data['operationId']): raise ValueError('INVALID_OPERATION_ID')
    if not re.fullmatch(r'xz-[a-z0-9-]{5,54}',name): raise ValueError('INVALID_NODE_NAME')
    if any(plan.get(k)!=conn[k] for k in ('subscription','resourceGroup','managementSourceCidr','controlAddress')): raise ValueError('CONNECTION_CHANGED')
    if plan['templateHash']!=hashlib.sha256((ROOT/'infra/azure/node.bicep').read_bytes()).hexdigest() or plan['cloudInitHash']!=hashlib.sha256((ROOT/'infra/azure/cloud-init.yaml').read_bytes()).hexdigest(): raise ValueError('TEMPLATE_CHANGED')
    return f'/resourcegroups/{conn["resourceGroup"]}/providers/Microsoft.Resources/deployments/{name}?api-version=2022-09-01'


def submit(api,conn,data,validate=False):
    path=deployment(api,conn,data); plan=data['plan']; name=data['nodeName']; scope(api,conn)
    existing=api.request(path,allow404=True)
    if existing:
        if existing.get('tags',{}).get('operation-id')!=data['operationId']: raise ValueError('DEPLOYMENT_OWNERSHIP_CONFLICT')
        state=existing.get('properties',{}).get('provisioningState')
        if state not in ('Failed','Canceled'): return {'azureState':state}
    # Recheck quota immediately before an actual submission; retries keep the same resource names.
    sku=next((x for x in skus(api,plan['region'],True)['items'] if x['name']==plan['size']),None)
    if not existing and (not sku or not sku['available']): raise ValueError('SKU_OR_QUOTA_UNAVAILABLE')
    vmPath=f'/resourcegroups/{conn["resourceGroup"]}/providers/Microsoft.Compute/virtualMachines/{name}?api-version=2024-07-01'
    vm=api.request(vmPath,allow404=True)
    if vm and vm.get('tags',{}).get('operation-id')!=data['operationId']: raise ValueError('VM_OWNERSHIP_CONFLICT')
    for kind, suffix in [('networkSecurityGroups','nsg'),('virtualNetworks','vnet'),('publicIPAddresses','ip'),('networkInterfaces','nic')]:
        resource=api.request(f'/resourcegroups/{conn["resourceGroup"]}/providers/Microsoft.Network/{kind}/{name}-{suffix}?api-version=2024-05-01',allow404=True)
        if resource and resource.get('tags',{}).get('operation-id')!=data['operationId']: raise ValueError('NETWORK_OWNERSHIP_CONFLICT')
    disk=api.request(f'/resourcegroups/{conn["resourceGroup"]}/providers/Microsoft.Compute/disks/{name}-os?api-version=2024-03-02',allow404=True)
    if disk and (not vm or disk.get('managedBy','').lower()!=vm['id'].lower()): raise ValueError('DISK_OWNERSHIP_CONFLICT')
    work=LOCAL/'provisioning'/data['operationId']; work.mkdir(parents=True,exist_ok=True,mode=0o700)
    p0.az('bicep','build','--file',str(ROOT/'infra/azure/node.bicep'),'--outfile',str(work/'template.json'))
    tags={'managed-by':'xray-zoo','purpose':'operator-node','operation-id':data['operationId'],'node':name}
    values={'location':plan['region'],'nodeName':name,'vmSize':plan['size'],'sshPublicKey':(LOCAL/'node_ssh.pub').read_text().strip(),'managementSourceCidr':conn['managementSourceCidr'],'imageVersion':plan['imageVersion'],'cloudInit':(ROOT/'infra/azure/cloud-init.yaml').read_text(),'tags':tags}
    payload={'tags':tags,'properties':{'mode':'Incremental','template':json.loads((work/'template.json').read_text()),'parameters':{k:{'value':v} for k,v in values.items()}}}
    api.request(path.replace('?api-version','/validate?api-version'),'POST',payload)
    if validate: return {'validated':True}
    response=api.request(path,'PUT',payload)
    return {'azureState':response.get('properties',{}).get('provisioningState','Accepted')}


def poll(api,conn,data):
    result=api.request(deployment(api,conn,data),allow404=True)
    if not result: return {'azureState':'NotFound'}
    if result.get('tags',{}).get('operation-id')!=data['operationId']: raise ValueError('DEPLOYMENT_OWNERSHIP_CONFLICT')
    p=result.get('properties',{});outputs=p.get('outputs',{})
    return {'azureState':p.get('provisioningState'),'address':outputs.get('nodeAddress',{}).get('value'),'vmId':outputs.get('vmId',{}).get('value'),'errorCode':p.get('error',{}).get('code')}


def extension(api,conn,data,submit=False):
    deployment(api,conn,data);name=data['nodeName'];plan=data['plan']
    base=f'/resourcegroups/{conn["resourceGroup"]}/providers/Microsoft.Compute/virtualMachines/{name}'
    vm=api.request(base+'?api-version=2024-07-01')
    if vm.get('tags',{}).get('operation-id')!=data['operationId']: raise ValueError('VM_OWNERSHIP_CONFLICT')
    path=base+'/extensions/xray-zoo-node?api-version=2024-07-01'
    if submit:
        # No secret ever enters customData, command-line arguments, task events, or stdout.
        auth=json.loads((LOCAL/'engine-auth.json').read_text())
        encoded=base64.b64encode(('NODE_PORT=2222\nSECRET_KEY='+auth['nodeSecret']+'\n').encode()).decode()
        command='set -eu; for n in $(seq 1 60); do test -f /opt/xray-zoo/bootstrap-ready && break; sleep 5; done; test -f /opt/xray-zoo/bootstrap-ready; '
        command+='umask 077; install -d -m 700 /opt/xray-zoo; printf %s '+shlex.quote(encoded)+' | base64 -d > /opt/xray-zoo/node.env; '
        command+='docker pull '+shlex.quote(IMAGE)+' >/dev/null; '
        command+='if docker inspect xray-zoo-node >/dev/null 2>&1; then test "$(docker inspect --format=\'{{index .Config.Labels "managed-by"}}\' xray-zoo-node)" = xray-zoo; else docker run -d --name xray-zoo-node --label managed-by=xray-zoo --restart unless-stopped --network host --env-file /opt/xray-zoo/node.env --log-opt max-size=10m --log-opt max-file=3 '+shlex.quote(IMAGE)+' >/dev/null; fi; '
        command+='docker start xray-zoo-node >/dev/null; printf "XZ_HOST_KEY "; cat /etc/ssh/ssh_host_ed25519_key.pub'
        api.request(path,'PUT',{'location':plan['region'],'tags':{'managed-by':'xray-zoo','operation-id':data['operationId']},'properties':{'publisher':'Microsoft.Azure.Extensions','type':'CustomScript','typeHandlerVersion':'2.1','autoUpgradeMinorVersion':True,'forceUpdateTag':str(uuid.uuid4()),'settings':{},'protectedSettings':{'commandToExecute':command}}})
        return {'azureState':'Submitted'}
    result=api.request(path+'&$expand=instanceView',allow404=True)
    props=(result or {}).get('properties',{});view=props.get('instanceView',{})
    text='\n'.join(str(x.get('message','')) for x in view.get('statuses',[])+view.get('substatuses',[]))
    match=re.search(r'XZ_HOST_KEY\s+(ssh-ed25519\s+[A-Za-z0-9+/=]+)',text)
    return {'azureState':props.get('provisioningState','NotFound'),'hostKey':match.group(1) if match else None}


def register_tunnel(data):
    name=data['nodeName'];op=data['operationId'];address=data['address'];port=int(data['controlPort']);key=data['hostKey']
    if not re.fullmatch(r'[a-f0-9-]{36}',op) or not re.fullmatch(r'xz-[a-z0-9-]{5,54}',name): raise ValueError('INVALID_TUNNEL_ID')
    if not ipaddress.ip_address(address).is_global or not 22221<=port<23000: raise ValueError('INVALID_TUNNEL_TARGET')
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]{40,200}',key): raise ValueError('INVALID_HOST_KEY')
    with open(LOCAL/'provisioned-tunnels.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        hosts=LOCAL/'known_hosts';contents=hosts.read_text() if hosts.exists() else ''
        matches=[line for line in contents.splitlines() if line.split(' ',1)[0]==address]
        if matches and any(line.split(' ',1)[1].strip()!=key for line in matches):
            released=LOCAL/'released-nodes.json'
            if not data.get('rebuild') or not released.exists() or not json.loads(released.read_text()).get(name):raise ValueError('SSH_HOST_KEY_MISMATCH')
            # The replacement key comes from the new VM's authenticated ARM extension result.
            hosts.write_text('\n'.join(line for line in contents.splitlines() if line not in matches)+'\n');matches=[]
        if not matches:
            with open(hosts,'a') as h:h.write(address+' '+key+'\n')
            hosts.chmod(0o600)
        path=LOCAL/'provisioned-tunnels.json';items=json.loads(path.read_text()) if path.exists() else []
        # OpenSSH adds a temporary suffix; full UUID paths exceed macOS sun_path.
        entry={'code':'machine-'+str(port),'name':name,'address':address,'controlPort':port,'operationId':op}
        if any(x['code']==entry['code'] and x['name']!=name for x in items): raise ValueError('TUNNEL_OWNERSHIP_CONFLICT')
        other=next((x for x in items if x['name']==name),None)
        if other and other!=entry:
            released=LOCAL/'released-nodes.json'
            if not data.get('rebuild') or not released.exists() or not json.loads(released.read_text()).get(name):raise ValueError('TUNNEL_OWNERSHIP_CONFLICT')
            items=[x for x in items if x['name']!=name]
        if not other or other!=entry:items.append(entry)
        p0.save(path,items)
        if data.get('rebuild'):
            with open(LOCAL/'ip-address-overrides.lock','a') as route_lock:
                fcntl.flock(route_lock,fcntl.LOCK_EX)
                route=LOCAL/'ip-address-overrides.json';entries=json.loads(route.read_text()) if route.exists() else {}
                entries.pop(name,None);p0.save(route,entries)
            with open(LOCAL/'released-nodes.lock','a') as release_lock:
                fcntl.flock(release_lock,fcntl.LOCK_EX)
                released=LOCAL/'released-nodes.json';entries=json.loads(released.read_text()) if released.exists() else {}
                entries.pop(name,None);p0.save(released,entries)
    return {'registered':True}


def main():
    data=json.load(sys.stdin);cmd=sys.argv[1]
    if cmd=='tunnel': return register_tunnel(data)
    conn=connection();api=p0.Azure(conn['subscription'])
    if cmd=='catalog': return {'subscription':conn['subscription'],'resourceGroup':conn['resourceGroup'],'locations':locations(api)}
    if cmd=='skus': return skus(api,data['region'])
    if cmd=='prepare': return prepare(api,conn,data)
    if cmd=='submit': return submit(api,conn,data)
    if cmd=='validate': return submit(api,conn,data,True)
    if cmd=='poll': return poll(api,conn,data)
    if cmd=='install': return extension(api,conn,data,True)
    if cmd=='installed': return extension(api,conn,data)
    raise ValueError('INVALID_COMMAND')


if __name__=='__main__':
    try: print(json.dumps({'ok':True,'result':main()}))
    except Exception as error:
        value=str(error)
        codes=re.findall(r'"code"\s*:\s*"([A-Za-z0-9_]+)"',value)
        code=codes[-1] if codes else value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value) else 'AZURE_CONNECTION_OR_REQUEST_FAILED'
        print(json.dumps({'ok':False,'error':code}));sys.exit(1)
