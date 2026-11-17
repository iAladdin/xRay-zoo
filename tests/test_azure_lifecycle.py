"""Deletion boundaries and retry safety, entirely in memory."""
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import copy, importlib.util, uuid, tempfile, json
s=importlib.util.spec_from_file_location('lifecycle',Path(__file__).resolve().parents[1]/'scripts/azure-lifecycle.py')
l=importlib.util.module_from_spec(s);s.loader.exec_module(l)
class Azure:
 def __init__(self,resources):self.resources=resources;self.deletes=[]
 def request(self,path,method='GET',body=None,allow404=False):
  rid=path.split('?')[0].removeprefix('https://management.azure.com')
  if method=='DELETE':
   self.deletes.append(rid);self.resources.pop(rid,None)
   for r in self.resources.values():
    r.pop('managedBy',None);r.get('properties',{}).pop('virtualMachine',None);r.get('properties',{}).pop('ipConfiguration',None)
   return {}
  return copy.deepcopy(self.resources.get(rid))
 def list(self,path):
  kind=path.split('/providers/')[1].split('?')[0]
  return [copy.deepcopy(r) for r in self.resources.values() if '/providers/'+kind+'/' in r['id']]
class LifecycleTests(TestCase):
 def setUp(self):
  self.conn={'subscription':str(uuid.uuid4()),'resourceGroup':'qa','managementSourceCidr':'192.0.2.1/32','controlAddress':'127.0.0.1'}
  self.name='xz-p0-jp';prefix=f'/subscriptions/{self.conn["subscription"]}/resourceGroups/qa/providers/'
  self.ids={k:prefix+k+'/'+self.name+suffix for k,suffix in [('Microsoft.Compute/virtualMachines',''),('Microsoft.Compute/disks','-os'),('Microsoft.Network/networkInterfaces','-nic'),('Microsoft.Network/publicIPAddresses','-ip'),('Microsoft.Network/virtualNetworks','-vnet'),('Microsoft.Network/networkSecurityGroups','-nsg'),('Microsoft.Resources/deployments','')]}
  self.resources={rid:{'id':rid,'tags':{'managed-by':'xray-zoo','node':'jp'},'location':'japaneast','properties':{'provisioningState':'Succeeded'}} for rid in self.ids.values()}
  vm=self.resources[self.ids['Microsoft.Compute/virtualMachines']]
  vm['properties'].update({'vmId':str(uuid.uuid4()),'networkProfile':{'networkInterfaces':[{'id':self.ids['Microsoft.Network/networkInterfaces']}]},'storageProfile':{'osDisk':{'managedDisk':{'id':self.ids['Microsoft.Compute/disks']}}},'hardwareProfile':{'vmSize':'Standard_B2ats_v2'}})
  disk=self.resources[self.ids['Microsoft.Compute/disks']];disk['managedBy']=vm['id'];disk['properties']['uniqueId']=str(uuid.uuid4())
  nic=self.resources[self.ids['Microsoft.Network/networkInterfaces']];nic['properties'].update({'virtualMachine':{'id':vm['id']},'ipConfigurations':[{'properties':{'publicIPAddress':{'id':self.ids['Microsoft.Network/publicIPAddresses']},'subnet':{'id':self.ids['Microsoft.Network/virtualNetworks']+'/subnets/nodes'}}}]})
  self.resources[self.ids['Microsoft.Resources/deployments']]['tags']={}
  self.resources[self.ids['Microsoft.Resources/deployments']]['properties']['outputs']={'vmId':{'value':vm['id']}}
  self.api=Azure(self.resources);p=patch.object(l.nodes,'scope');p.start();self.addCleanup(p.stop)
  self.snapshot=l.inspect(self.api,self.conn,{'nodeName':self.name,'region':'japaneast'})
 def test_full_release_orders_dependencies_and_replay_never_deletes_twice(self):
  for i in range(8):result=l.release(self.api,self.conn,{'snapshot':self.snapshot})
  self.assertTrue(result['done']);self.assertEqual(len(self.api.deletes),7)
  self.assertEqual(self.api.deletes[0],self.ids['Microsoft.Compute/virtualMachines'])
  self.assertTrue(l.release(self.api,self.conn,{'snapshot':self.snapshot})['done'])
  self.assertEqual(len(self.api.deletes),7)
 def test_all_resources_are_checked_before_any_delete(self):
  self.resources[self.ids['Microsoft.Compute/disks']]['tags']['node']='another'
  with self.assertRaisesRegex(ValueError,'RELEASE_RESOURCE_CONFLICT'):l.release(self.api,self.conn,{'snapshot':self.snapshot})
  self.assertEqual(self.api.deletes,[])
 def test_replaced_vm_is_never_deleted_by_old_snapshot(self):
  self.resources[self.ids['Microsoft.Compute/virtualMachines']]['properties']['vmId']=str(uuid.uuid4())
  with self.assertRaisesRegex(ValueError,'RELEASE_RESOURCE_CONFLICT'):l.release(self.api,self.conn,{'snapshot':self.snapshot})
  self.assertEqual(self.api.deletes,[])
 def test_foreign_ip_attachment_prevents_entire_release(self):
  self.resources[self.ids['Microsoft.Network/publicIPAddresses']]['properties']['ipConfiguration']={'id':self.ids['Microsoft.Network/networkInterfaces']+'-foreign/ipConfigurations/primary'}
  with self.assertRaisesRegex(ValueError,'RELEASE_RESOURCE_CONFLICT'):l.release(self.api,self.conn,{'snapshot':self.snapshot})
  self.assertEqual(self.api.deletes,[])
 def test_shared_network_and_cross_scope_are_rejected(self):
  self.resources[self.ids['Microsoft.Network/virtualNetworks']]['properties']['subnets']=[{'properties':{'ipConfigurations':[{'id':self.ids['Microsoft.Network/networkInterfaces']+'-other/ipConfigurations/primary'}]}}]
  with self.assertRaisesRegex(ValueError,'RELEASE_SHARED_NETWORK'):l.release(self.api,self.conn,{'snapshot':self.snapshot})
  bad=copy.deepcopy(self.snapshot);bad['resources'][0]['id']=bad['resources'][0]['id'].replace('/qa/','/other/')
  with self.assertRaisesRegex(ValueError,'RELEASE_RESOURCE_CONFLICT'):l.release(self.api,self.conn,{'snapshot':bad})
 def test_read_only_verification_does_not_report_absent_vm_as_complete(self):
  self.resources.pop(self.ids['Microsoft.Compute/virtualMachines'])
  self.assertFalse(l.release(self.api,self.conn,{'snapshot':self.snapshot},True)['done'])
  self.assertEqual(self.api.deletes,[])

 def test_tunnel_rebuild_replaces_only_a_released_nodes_route_and_trusted_key(self):
  with tempfile.TemporaryDirectory() as temp,patch.object(l.nodes,'LOCAL',Path(temp)):
   local=Path(temp)
   old={'nodeName':'xz-p0-jp','operationId':str(uuid.uuid4()),'address':'8.8.8.8','controlPort':22300,'hostKey':'ssh-ed25519 '+'a'*48}
   l.nodes.register_tunnel(old)
   replacement={**old,'operationId':str(uuid.uuid4()),'hostKey':'ssh-ed25519 '+'b'*48,'rebuild':True}
   with self.assertRaisesRegex(ValueError,'SSH_HOST_KEY_MISMATCH'):l.nodes.register_tunnel(replacement)
   (local/'released-nodes.json').write_text(json.dumps({'xz-p0-jp':True}))
   (local/'ip-address-overrides.json').write_text(json.dumps({'xz-p0-jp':{'address':'1.1.1.1'}}))
   l.nodes.register_tunnel(replacement)
   l.nodes.register_tunnel(replacement)
   self.assertEqual(len(json.loads((local/'provisioned-tunnels.json').read_text())),1)
   self.assertEqual(json.loads((local/'released-nodes.json').read_text()),{})
   self.assertEqual(json.loads((local/'ip-address-overrides.json').read_text()),{})
   self.assertIn(replacement['hostKey'],(local/'known_hosts').read_text())

if __name__=='__main__':main()
