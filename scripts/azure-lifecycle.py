#!/usr/bin/env python3
"""Durable, scoped deletion of disposable nodes. Never deletes a resource group.
The immutable manifest is saved by the control plane before the first DELETE.
Every retry rechecks resource identity, ownership and attachments.
"""
from pathlib import Path
import importlib.util, json, re, sys, fcntl, subprocess
spec=importlib.util.spec_from_file_location('nodes',Path(__file__).with_name('azure-node.py'))
nodes=importlib.util.module_from_spec(spec);spec.loader.exec_module(nodes)
KINDS={'Microsoft.Compute/virtualMachines':'2024-07-01','Microsoft.Compute/disks':'2024-03-02','Microsoft.Network/networkInterfaces':'2024-05-01','Microsoft.Network/publicIPAddresses':'2024-05-01','Microsoft.Network/virtualNetworks':'2024-05-01','Microsoft.Network/networkSecurityGroups':'2024-05-01','Microsoft.Resources/deployments':'2022-09-01'}

def url(conn,rid,kind):
    prefix=f'/subscriptions/{conn["subscription"]}/resourceGroups/{conn["resourceGroup"]}/providers/{kind}/'
    if kind not in KINDS or not rid.lower().startswith(prefix.lower()) or not re.fullmatch(r'[A-Za-z0-9_.-]+',rid[len(prefix):]):raise ValueError('RELEASE_RESOURCE_CONFLICT')
    return 'https://management.azure.com'+rid+'?api-version='+KINDS[kind]

def owned(r,name):
    tags=r.get('tags',{});aliases=[name]+([name[6:]] if name.startswith('xz-p0-') else [])
    if tags.get('managed-by')!='xray-zoo' or tags.get('node') not in aliases:raise ValueError('RELEASE_RESOURCE_CONFLICT')

def identity(r):
    p=r.get('properties',{})
    return {k:p[k] for k in ('vmId','uniqueId','resourceGuid') if p.get(k)}

def belongs(r,name):
    try:owned(r,name);return True
    except ValueError:return False

def inspect(api,conn,data):
    nodes.scope(api,conn);name=data['nodeName']
    if not re.fullmatch(r'xz-[a-z0-9-]{2,54}',name):raise ValueError('INVALID_NODE_NAME')
    prefix=f'/subscriptions/{conn["subscription"]}/resourceGroups/{conn["resourceGroup"]}/providers/'
    vmid=prefix+'Microsoft.Compute/virtualMachines/'+name
    if data.get('vmId') and data['vmId'].lower()!=vmid.lower():raise ValueError('RELEASE_RESOURCE_CONFLICT')
    resources=[]
    def add(r,kind):
        if not r:return
        if kind!='Microsoft.Resources/deployments':owned(r,name)
        url(conn,r['id'],kind)
        if not any(x['id'].lower()==r['id'].lower() for x in resources):resources.append({'id':r['id'],'kind':kind,'identity':identity(r)})
    vm=api.request(url(conn,vmid,'Microsoft.Compute/virtualMachines'),allow404=True)
    if vm:
        owned(vm,name)
        if vm['properties']['storageProfile'].get('dataDisks'):raise ValueError('RELEASE_RESOURCE_CONFLICT')
        if len(vm['properties']['networkProfile'].get('networkInterfaces',[]))!=1:raise ValueError('RELEASE_SHARED_NETWORK')
        add(vm,'Microsoft.Compute/virtualMachines')
    # Include detached remnants (e.g. a rotated IP) owned exclusively by this node.
    for kind in ['Microsoft.Network/networkInterfaces','Microsoft.Compute/disks','Microsoft.Network/publicIPAddresses','Microsoft.Network/virtualNetworks','Microsoft.Network/networkSecurityGroups']:
        rows=api.list(f'/resourceGroups/{conn["resourceGroup"]}/providers/{kind}?api-version={KINDS[kind]}')
        for r in rows:
            if belongs(r,name):add(r,kind)
    # Ensure every live VM reference is in the manifest, including an untagged disk.
    ids={r['id'].lower() for r in resources}
    if vm:
        refs=[x['id'] for x in vm['properties']['networkProfile']['networkInterfaces']]
        refs.append(vm['properties']['storageProfile']['osDisk']['managedDisk']['id'])
        if any(x.lower() not in ids for x in refs):raise ValueError('RELEASE_RESOURCE_CONFLICT')
    depid=prefix+'Microsoft.Resources/deployments/'+name
    dep=api.request(url(conn,depid,'Microsoft.Resources/deployments'),allow404=True)
    if dep:
        tags=dep.get('tags',{});p=dep.get('properties',{})
        # P0 deployments predate tags. Accept only a completed deployment whose output is this VM.
        output=p.get('outputs',{}).get('vmId',{}).get('value','')
        if not belongs(dep,name) and output.lower()!=vmid.lower():raise ValueError('RELEASE_RESOURCE_CONFLICT')
        if p.get('provisioningState') not in ('Succeeded','Failed','Canceled'):raise ValueError('NODE_BUSY')
        add(dep,'Microsoft.Resources/deployments')
    result={**conn,'nodeName':name,'vmId':vmid,'resources':resources,'region':(vm or {}).get('location') or data['region'],'size':(vm or {}).get('properties',{}).get('hardwareProfile',{}).get('vmSize') or data.get('size','Standard_B2ats_v2')}
    checked(api,conn,result)
    return result

def checked(api,conn,snapshot):
    if any(snapshot.get(k)!=v for k,v in conn.items()):raise ValueError('CONNECTION_CHANGED')
    nodes.scope(api,conn)
    name=snapshot['nodeName'];items=snapshot['resources'];live=[]
    ids={i['id'].lower() for i in items}
    for item in items:
        r=api.request(url(conn,item['id'],item['kind']),allow404=True)
        if not r:continue
        if item['kind']!='Microsoft.Resources/deployments':owned(r,name)
        elif not belongs(r,name) and r.get('properties',{}).get('outputs',{}).get('vmId',{}).get('value','').lower()!=snapshot['vmId'].lower():raise ValueError('RELEASE_RESOURCE_CONFLICT')
        if identity(r)!=item['identity']:raise ValueError('RELEASE_RESOURCE_CONFLICT')
        p=r.get('properties',{});kind=item['kind']
        if kind=='Microsoft.Compute/virtualMachines':
            refs=[x['id'] for x in p['networkProfile']['networkInterfaces']]+[p['storageProfile']['osDisk']['managedDisk']['id']]
            if p['storageProfile'].get('dataDisks') or any(x.lower() not in ids for x in refs):raise ValueError('RELEASE_RESOURCE_CONFLICT')
        elif kind=='Microsoft.Compute/disks':
            if r.get('managedBy') and r['managedBy'].lower()!=snapshot['vmId'].lower():raise ValueError('RELEASE_RESOURCE_CONFLICT')
        elif kind=='Microsoft.Network/networkInterfaces':
            owner=p.get('virtualMachine',{}).get('id')
            if owner and owner.lower()!=snapshot['vmId'].lower():raise ValueError('RELEASE_RESOURCE_CONFLICT')
            for cfg in p.get('ipConfigurations',[]):
                cp=cfg['properties']
                if any(cp.get(k) for k in ('loadBalancerBackendAddressPools','loadBalancerInboundNatRules','applicationGatewayBackendAddressPools','applicationSecurityGroups')):raise ValueError('RELEASE_SHARED_NETWORK')
                ref=cp.get('publicIPAddress',{}).get('id')
                subnet=cp.get('subnet',{}).get('id','').rsplit('/subnets/',1)[0]
                if (ref and ref.lower() not in ids) or (subnet and subnet.lower() not in ids):raise ValueError('RELEASE_SHARED_NETWORK')
        elif kind=='Microsoft.Network/publicIPAddresses':
            owner=p.get('ipConfiguration',{}).get('id')
            if owner and owner.lower().split('/ipconfigurations/')[0] not in ids:raise ValueError('RELEASE_RESOURCE_CONFLICT')
        elif kind=='Microsoft.Network/virtualNetworks':
            if p.get('virtualNetworkPeerings'):raise ValueError('RELEASE_SHARED_NETWORK')
            for sub in p.get('subnets',[]):
                sp=sub.get('properties',{})
                if sp.get('delegations') or sp.get('serviceAssociationLinks'):raise ValueError('RELEASE_SHARED_NETWORK')
                for ref in sp.get('ipConfigurations',[]):
                    if ref['id'].lower().split('/ipconfigurations/')[0] not in ids:raise ValueError('RELEASE_SHARED_NETWORK')
        elif kind=='Microsoft.Network/networkSecurityGroups':
            for ref in p.get('networkInterfaces',[])+p.get('subnets',[]):
                if ref['id'].lower().split('/subnets/')[0] not in ids:raise ValueError('RELEASE_SHARED_NETWORK')
        live.append((item,r))
    return live

def release(api,conn,data,verify=False):
    live=checked(api,conn,data['snapshot'])
    if not live:return {'done':True,'remaining':0}
    if verify:return {'done':False,'remaining':len(live)}
    order=list(KINDS)
    # VM -> disks/NIC -> IP -> VNet -> NSG -> deployment metadata.
    order=['Microsoft.Compute/virtualMachines','Microsoft.Network/networkInterfaces','Microsoft.Compute/disks','Microsoft.Network/publicIPAddresses','Microsoft.Network/virtualNetworks','Microsoft.Network/networkSecurityGroups','Microsoft.Resources/deployments']
    item,r=min(live,key=lambda pair:order.index(pair[0]['kind']))
    p=r.get('properties',{})
    if p.get('provisioningState')!='Deleting':
        if item['kind']=='Microsoft.Compute/disks' and r.get('managedBy'):return {'done':False,'remaining':len(live)}
        if item['kind']=='Microsoft.Network/publicIPAddresses' and p.get('ipConfiguration'):return {'done':False,'remaining':len(live)}
        if item['kind']=='Microsoft.Network/networkInterfaces' and p.get('virtualMachine'):return {'done':False,'remaining':len(live)}
        api.request(url(conn,item['id'],item['kind']),'DELETE')
    return {'done':False,'remaining':len(live),'resource':item['kind'].split('/')[-1]}

def suspend(data):
    name=data['nodeName']
    if not re.fullmatch(r'xz-[a-z0-9-]{2,54}',name):raise ValueError('INVALID_NODE_NAME')
    with open(nodes.LOCAL/'released-nodes.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        path=nodes.LOCAL/'released-nodes.json';entries=json.loads(path.read_text()) if path.exists() else {}
        entries[name]=True;nodes.p0.save(path,entries)
    result=subprocess.run(['python3',str(nodes.ROOT/'scripts/control-tunnels.py'),'stop','--node',name,'--json'],capture_output=True,timeout=30)
    if result.returncode and b'Unknown managed node' not in result.stderr:raise ValueError('CONTROL_TRANSPORT_UNAVAILABLE')
    return {'suspended':True}

def main():
    data=json.load(sys.stdin);cmd=sys.argv[1]
    if cmd=='suspend':return suspend(data)
    conn=nodes.connection();api=nodes.p0.Azure(conn['subscription'])
    if cmd=='inspect':return inspect(api,conn,data)
    if cmd in ('release','verify'):return release(api,conn,data,cmd=='verify')
    raise ValueError('INVALID_COMMAND')
if __name__=='__main__':
    try:print(json.dumps({'ok':True,'result':main()}))
    except Exception as e:
        value=str(e);codes=re.findall(r'"code"\s*:\s*"([A-Za-z0-9_]+)"',value)
        code=codes[-1] if codes else value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}',value) else 'AZURE_CONNECTION_OR_REQUEST_FAILED'
        print(json.dumps({'ok':False,'error':code}));sys.exit(1)
