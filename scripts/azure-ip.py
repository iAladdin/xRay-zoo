#!/usr/bin/env python3
"""Rotate only a managed node's Standard IPv4. JSON stdin, sanitized stdout."""
from pathlib import Path
import copy, fcntl, importlib.util, ipaddress, json, re, subprocess, sys
spec=importlib.util.spec_from_file_location('nodes',Path(__file__).with_name('azure-node.py'))
nodes=importlib.util.module_from_spec(spec);spec.loader.exec_module(nodes)
LOCAL=nodes.LOCAL
VERSION='2024-05-01'

def path(conn, resource_id, kind):
    prefix=f'/subscriptions/{conn["subscription"]}/resourceGroups/{conn["resourceGroup"]}/providers/'
    if not resource_id.lower().startswith((prefix+kind+'/').lower()) or not re.fullmatch(r'[a-zA-Z0-9_.-]+',resource_id[len(prefix+kind+'/'):]):
        raise ValueError('IP_RESOURCE_SCOPE_CONFLICT')
    return 'https://management.azure.com'+resource_id+'?api-version='+('2024-07-01' if kind.endswith('virtualMachines') else VERSION)

def owned(resource, name):
    tags=resource.get('tags',{})
    allowed=[name]
    if name.startswith('xz-p0-'):allowed.append(name[6:])
    if tags.get('managed-by')!='xray-zoo' or tags.get('node') not in allowed:
        raise ValueError('IP_RESOURCE_OWNERSHIP_CONFLICT')

def public_id(nic):
    configs=nic['properties'].get('ipConfigurations',[])
    if len(configs)!=1:raise ValueError('IP_NETWORK_NOT_SUPPORTED')
    props=configs[0]['properties']
    if props.get('privateIPAddressVersion','IPv4')!='IPv4' or any(props.get(k) for k in ['loadBalancerBackendAddressPools','loadBalancerInboundNatRules','applicationGatewayBackendAddressPools','applicationSecurityGroups']):
        raise ValueError('IP_NETWORK_NOT_SUPPORTED')
    return props.get('publicIPAddress',{}).get('id')

def resources(api,conn,name,vm_id):
    vm=api.request(path(conn,vm_id,'Microsoft.Compute/virtualMachines'))
    owned(vm,name)
    if vm['id'].rsplit('/',1)[-1]!=name:raise ValueError('IP_VM_MISMATCH')
    refs=vm['properties']['networkProfile']['networkInterfaces']
    if len(refs)!=1:raise ValueError('IP_NETWORK_NOT_SUPPORTED')
    nic=api.request(path(conn,refs[0]['id'],'Microsoft.Network/networkInterfaces'))
    owned(nic,name)
    if nic['properties'].get('virtualMachine',{}).get('id','').lower()!=vm_id.lower():raise ValueError('IP_VM_MISMATCH')
    public_id(nic)
    return vm,nic

def host_key(address):
    answer=subprocess.run(['ssh-keygen','-F',address,'-f',str(LOCAL/'known_hosts')],capture_output=True,text=True,timeout=5)
    keys={line.split()[1]+' '+line.split()[2] for line in answer.stdout.splitlines() if not line.startswith('#') and len(line.split())>=3 and line.split()[1]=='ssh-ed25519'}
    if len(keys)!=1:raise ValueError('IP_PINNED_HOST_KEY_MISSING')
    return next(iter(keys))

def preview(api,conn,data):
    name=data['nodeName']
    if not re.fullmatch(r'xz-[a-z0-9-]{2,54}',name):raise ValueError('INVALID_NODE_NAME')
    nodes.scope(api,conn)
    vm_id=data.get('vmId') or f'/subscriptions/{conn["subscription"]}/resourceGroups/{conn["resourceGroup"]}/providers/Microsoft.Compute/virtualMachines/{name}'
    vm,nic=resources(api,conn,name,vm_id)
    if not public_id(nic):raise ValueError('IP_BINDING_CONFLICT')
    pip=api.request(path(conn,public_id(nic),'Microsoft.Network/publicIPAddresses'))
    owned(pip,name)
    p=pip['properties']
    if p.get('ipAddress')!=data['address']:raise ValueError('IP_BINDING_CONFLICT')
    if pip.get('sku')!={'name':'Standard','tier':'Regional'} or p.get('publicIPAddressVersion')!='IPv4' or p.get('publicIPAllocationMethod')!='Static' or p.get('dnsSettings'):
        raise ValueError('IP_NETWORK_NOT_SUPPORTED')
    region=vm['location'].lower()
    if nic['location'].lower()!=region or pip['location'].lower()!=region:raise ValueError('IP_VM_MISMATCH')
    usage=api.list(f'/providers/Microsoft.Network/locations/{region}/usages?api-version={VERSION}')
    quotas=[x for x in usage if x['name']['value'].lower() in ('publicipaddresses','staticpublicipaddresses')]
    if not quotas:raise ValueError('PUBLIC_IP_QUOTA_UNVERIFIED')
    if any(x['currentValue']>=x['limit'] for x in quotas):raise ValueError('PUBLIC_IP_QUOTA_EXCEEDED')
    return {**conn,'nodeName':name,'vmId':vm_id,'nicId':nic['id'],'ipConfigName':nic['properties']['ipConfigurations'][0]['name'],'oldIpId':pip['id'],'oldAddress':p['ipAddress'],'region':region,'hostKey':host_key(p['ipAddress']),
        'ipSettings':{'sku':pip['sku'],'zones':pip.get('zones'),'properties':{k:p[k] for k in ['publicIPAddressVersion','publicIPAllocationMethod','idleTimeoutInMinutes','ipTags','ddosSettings'] if k in p}}}

def context(api,conn,data):
    s=data['snapshot'];op=data['operationId']
    if not re.fullmatch(r'[a-f0-9-]{36}',op):raise ValueError('INVALID_OPERATION_ID')
    if any(s.get(k)!=conn[k] for k in conn):raise ValueError('CONNECTION_CHANGED')
    nodes.scope(api,conn)
    vm,nic=resources(api,conn,s['nodeName'],s['vmId'])
    if nic['id'].lower()!=s['nicId'].lower() or nic['properties']['ipConfigurations'][0]['name']!=s['ipConfigName']:raise ValueError('IP_BINDING_CONFLICT')
    new_id=s['oldIpId'].rsplit('/',1)[0]+'/'+s['nodeName']+'-ip-r-'+op[:8]
    if (public_id(nic) or '').lower() not in [s['oldIpId'].lower(),new_id.lower()]:raise ValueError('IP_BINDING_CONFLICT')
    return s,nic,new_id

def allocated(api,conn,data,submit=False):
    s,nic,new_id=context(api,conn,data)
    url=path(conn,new_id,'Microsoft.Network/publicIPAddresses')
    pip=api.request(url,allow404=True)
    if pip:
        owned(pip,s['nodeName'])
        if pip.get('tags',{}).get('rotation-id')!=data['operationId']:raise ValueError('IP_RESOURCE_OWNERSHIP_CONFLICT')
    state=(pip or {}).get('properties',{}).get('provisioningState','NotFound')
    if submit and state in ('NotFound','Failed'):
        body=copy.deepcopy(s['ipSettings']);body['location']=s['region']
        if not body.get('zones'):body.pop('zones',None)
        body['tags']={'managed-by':'xray-zoo','node':s['nodeName'],'rotation-id':data['operationId'],'purpose':'node-ip-rotation'}
        pip=api.request(url,'PUT',body);state=pip.get('properties',{}).get('provisioningState','Updating')
    address=(pip or {}).get('properties',{}).get('ipAddress')
    if state=='Succeeded' and (not address or address==s['oldAddress'] or not ipaddress.ip_address(address).is_global):raise ValueError('IP_ALLOCATION_INVALID')
    return {'state':state,'address':address}

def bind(api,conn,data,restore=False):
    s,nic,new_id=context(api,conn,data)
    target=s['oldIpId'] if restore else new_id
    pip=api.request(path(conn,target,'Microsoft.Network/publicIPAddresses'))
    owned(pip,s['nodeName'])
    if not restore and pip.get('tags',{}).get('rotation-id')!=data['operationId']:raise ValueError('IP_RESOURCE_OWNERSHIP_CONFLICT')
    p=pip['properties'];association=p.get('ipConfiguration',{}).get('id')
    expected=nic['id']+'/ipConfigurations/'+s['ipConfigName']
    if association and association.lower()!=expected.lower():raise ValueError('IP_BINDING_CONFLICT')
    state=nic['properties']['provisioningState']
    if public_id(nic).lower()==target.lower() and state=='Succeeded':return {'done':True}
    if state not in ('Succeeded','Failed'):return {'done':False}
    if p.get('provisioningState')!='Succeeded':raise ValueError('IP_ALLOCATION_NOT_READY')
    props=nic['properties']
    writable={k:copy.deepcopy(props[k]) for k in ['enableAcceleratedNetworking','enableIPForwarding','disableTcpStateTracking','networkSecurityGroup','nicType','auxiliaryMode','auxiliarySku'] if k in props}
    writable['dnsSettings']={k:v for k,v in props.get('dnsSettings',{}).items() if k in ['dnsServers','internalDnsNameLabel']}
    cfg=props['ipConfigurations'][0]
    ip_props={k:copy.deepcopy(v) for k,v in cfg['properties'].items() if k in ['privateIPAddress','privateIPAllocationMethod','privateIPAddressVersion','subnet','primary']}
    ip_props['publicIPAddress']={'id':target}
    writable['ipConfigurations']=[{'name':cfg['name'],'properties':ip_props}]
    api.request(path(conn,nic['id'],'Microsoft.Network/networkInterfaces'),'PUT',{'location':nic['location'],'tags':nic.get('tags',{}),'properties':writable},headers={'If-Match':nic['etag']})
    return {'done':False}

def cleanup(api,conn,data,rollback=False):
    s,nic,new_id=context(api,conn,data)
    target=new_id if rollback else s['oldIpId']
    retained=s['oldIpId'] if rollback else new_id
    if public_id(nic).lower()!=retained.lower() or nic['properties']['provisioningState']!='Succeeded':raise ValueError('IP_BINDING_CONFLICT')
    url=path(conn,target,'Microsoft.Network/publicIPAddresses')
    pip=api.request(url,allow404=True)
    if not pip:return {'done':True}
    owned(pip,s['nodeName'])
    if rollback and pip.get('tags',{}).get('rotation-id')!=data['operationId']:raise ValueError('IP_RESOURCE_OWNERSHIP_CONFLICT')
    association=pip['properties'].get('ipConfiguration',{}).get('id')
    if association:
        expected=nic['id']+'/ipConfigurations/'+s['ipConfigName']
        if association.lower()!=expected.lower():raise ValueError('IP_STILL_ATTACHED')
        return {'done':False}  # Wait for ARM's detached-IP view to catch up.
    if pip['properties'].get('provisioningState')!='Deleting':api.request(url,'DELETE')
    return {'done':False}

def route(api,conn,data,restore=False):
    s,nic,new_id=context(api,conn,data)
    target=s['oldIpId'] if restore else new_id
    if public_id(nic).lower()!=target.lower() or nic['properties']['provisioningState']!='Succeeded':raise ValueError('IP_BINDING_CONFLICT')
    pip=api.request(path(conn,target,'Microsoft.Network/publicIPAddresses'));owned(pip,s['nodeName'])
    address=pip['properties']['ipAddress'];key=s['hostKey']
    if not ipaddress.ip_address(address).is_global or not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]{40,200}',key):raise ValueError('IP_ALLOCATION_INVALID')
    with open(LOCAL/'ip-address-overrides.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        hosts=LOCAL/'known_hosts'
        # Never overwrite a known different host key.
        lookup=subprocess.run(['ssh-keygen','-F',address,'-f',str(hosts)],capture_output=True,text=True,timeout=5)
        keys={line.split()[1]+' '+line.split()[2] for line in lookup.stdout.splitlines() if not line.startswith('#') and len(line.split())>=3}
        if keys and keys!={key}:raise ValueError('SSH_HOST_KEY_MISMATCH')
        if not keys:
            with open(hosts,'a') as out:out.write(address+' '+key+'\n')
            hosts.chmod(0o600)
        file=LOCAL/'ip-address-overrides.json';entries=json.loads(file.read_text()) if file.exists() else {}
        entries[s['nodeName']]={'address':address,'operationId':data['operationId']}
        nodes.p0.save(file,entries)
    return {'address':address}

def main():
    data=json.load(sys.stdin);cmd=sys.argv[1];conn=nodes.connection();api=nodes.p0.Azure(conn['subscription'])
    if cmd=='preview':return preview(api,conn,data)
    if cmd=='allocate':return allocated(api,conn,data,True)
    if cmd=='allocated':return allocated(api,conn,data)
    if cmd in ('bind','restore'):return bind(api,conn,data,cmd=='restore')
    if cmd in ('route','restore-route'):return route(api,conn,data,cmd=='restore-route')
    if cmd in ('cleanup','rollback-cleanup'):return cleanup(api,conn,data,cmd=='rollback-cleanup')
    raise ValueError('INVALID_COMMAND')

if __name__=='__main__':
    try:print(json.dumps({'ok':True,'result':main()}))
    except Exception as error:
        value=str(error);codes=re.findall(r'"code"\s*:\s*"([A-Za-z0-9_]+)"',value)
        code=codes[-1] if codes else value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value) else 'AZURE_CONNECTION_OR_REQUEST_FAILED'
        print(json.dumps({'ok':False,'error':code}));sys.exit(1)
