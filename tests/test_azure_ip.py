"""Network adapter contracts, with in-memory ARM resources; no cloud mutations."""
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import copy, importlib.util, json, tempfile, uuid

spec=importlib.util.spec_from_file_location('rotate',Path(__file__).resolve().parents[1]/'scripts/azure-ip.py')
rotate=importlib.util.module_from_spec(spec);spec.loader.exec_module(rotate)

class FakeAzure:
    def __init__(self, resources):self.resources=resources;self.calls=[]
    def request(self,path,method='GET',body=None,allow404=False,headers=None):
        self.calls.append((path,method,body,headers))
        if method=='DELETE':self.resources.pop(path,None);return {}
        if method=='PUT':
            previous=self.resources.get(path,{})
            result={**previous,**copy.deepcopy(body),'id':path.split('?')[0].removeprefix('https://management.azure.com')}
            result['properties']={**previous.get('properties',{}),**result['properties'],'provisioningState':'Succeeded'}
            if '/publicIPAddresses/' in path:result['properties']['ipAddress']='8.8.4.4'
            self.resources[path]=result;return copy.deepcopy(result)
        value=self.resources.get(path)
        if value is None and not allow404:raise ValueError('ResourceNotFound')
        return copy.deepcopy(value)

class RotationAdapterTests(TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.local=Path(self.temp.name);self.patcher=patch.object(rotate,'LOCAL',self.local);self.patcher.start();self.addCleanup(self.patcher.stop)
        self.conn={'subscription':str(uuid.uuid4()),'resourceGroup':'qa-rotation','managementSourceCidr':'192.0.2.1/32','controlAddress':'127.0.0.1'}
        self.name='xz-p0-jp';prefix=f'/subscriptions/{self.conn["subscription"]}/resourceGroups/qa-rotation/providers/'
        self.vm_id=prefix+'Microsoft.Compute/virtualMachines/'+self.name
        self.nic_id=prefix+'Microsoft.Network/networkInterfaces/'+self.name+'-nic'
        self.old_id=prefix+'Microsoft.Network/publicIPAddresses/'+self.name+'-ip'
        tags={'managed-by':'xray-zoo','node':'jp'}
        self.vm={'id':self.vm_id,'location':'japaneast','tags':tags,'properties':{'networkProfile':{'networkInterfaces':[{'id':self.nic_id}]}}}
        self.nic={'id':self.nic_id,'location':'japaneast','tags':tags,'etag':'qa-etag','properties':{'provisioningState':'Succeeded','virtualMachine':{'id':self.vm_id},'enableIPForwarding':False,'enableAcceleratedNetworking':False,'ipConfigurations':[{'name':'primary','properties':{'publicIPAddress':{'id':self.old_id},'privateIPAddress':'10.90.1.4','privateIPAllocationMethod':'Dynamic','privateIPAddressVersion':'IPv4','subnet':{'id':prefix+'Microsoft.Network/virtualNetworks/qa/subnets/nodes'},'primary':True}}]}}
        self.old={'id':self.old_id,'location':'japaneast','tags':tags,'sku':{'name':'Standard','tier':'Regional'},'properties':{'provisioningState':'Succeeded','publicIPAddressVersion':'IPv4','publicIPAllocationMethod':'Static','ipAddress':'8.8.8.8'}}
        self.api=FakeAzure({self.url(self.vm_id,'Microsoft.Compute/virtualMachines'):self.vm,self.url(self.nic_id,'Microsoft.Network/networkInterfaces'):self.nic,self.url(self.old_id):self.old})
        self.snapshot={**self.conn,'nodeName':self.name,'vmId':self.vm_id,'nicId':self.nic_id,'ipConfigName':'primary','oldIpId':self.old_id,'oldAddress':'8.8.8.8','region':'japaneast','hostKey':'ssh-ed25519 '+('a'*48),'ipSettings':{'sku':self.old['sku'],'zones':None,'properties':{'publicIPAddressVersion':'IPv4','publicIPAllocationMethod':'Static','idleTimeoutInMinutes':15}}}
        self.data={'operationId':str(uuid.uuid4()),'snapshot':self.snapshot}
        self.scope=patch.object(rotate.nodes,'scope');self.scope.start();self.addCleanup(self.scope.stop)

    def url(self,id,kind='Microsoft.Network/publicIPAddresses'):return rotate.path(self.conn,id,kind)
    def new_id(self):return self.old_id.rsplit('/',1)[0]+'/'+self.name+'-ip-r-'+self.data['operationId'][:8]

    def test_allocate_is_idempotent_and_does_not_detach_original(self):
        for _ in range(2):self.assertEqual(rotate.allocated(self.api,self.conn,self.data,True)['address'],'8.8.4.4')
        writes=[x for x in self.api.calls if x[1]=='PUT']
        self.assertEqual(len(writes),1)
        self.assertEqual(writes[0][2]['tags']['rotation-id'],self.data['operationId'])
        self.assertEqual(rotate.public_id(self.nic),self.old_id)

    def test_binding_preserves_private_address_network_and_supports_restore(self):
        rotate.allocated(self.api,self.conn,self.data,True)
        self.assertFalse(rotate.bind(self.api,self.conn,self.data)['done'])
        write=[x for x in self.api.calls if x[1]=='PUT'][-1]
        self.assertEqual(write[3],{'If-Match':'qa-etag'})
        self.assertFalse(write[2]['properties']['enableIPForwarding'])
        self.assertEqual(write[2]['properties']['ipConfigurations'][0]['properties']['privateIPAddress'],'10.90.1.4')
        self.assertTrue(rotate.bind(self.api,self.conn,self.data)['done'])
        self.assertFalse(rotate.bind(self.api,self.conn,self.data,True)['done'])
        self.assertTrue(rotate.bind(self.api,self.conn,self.data,True)['done'])

    def test_cleanup_only_deletes_detached_owned_ip_and_recovers_lost_response(self):
        rotate.allocated(self.api,self.conn,self.data,True)
        with self.assertRaisesRegex(ValueError,'IP_BINDING_CONFLICT'):rotate.cleanup(self.api,self.conn,self.data)
        rotate.bind(self.api,self.conn,self.data)
        self.old['properties']['ipConfiguration']={'id':self.nic_id+'/ipConfigurations/primary'}
        self.assertFalse(rotate.cleanup(self.api,self.conn,self.data)['done'])
        self.assertFalse(any(x[1]=='DELETE' for x in self.api.calls))
        self.old['properties']['ipConfiguration']={'id':self.nic_id+'-foreign/ipConfigurations/primary'}
        with self.assertRaisesRegex(ValueError,'IP_STILL_ATTACHED'):rotate.cleanup(self.api,self.conn,self.data)
        self.old['properties'].pop('ipConfiguration')
        self.assertFalse(rotate.cleanup(self.api,self.conn,self.data)['done'])
        self.assertTrue(rotate.cleanup(self.api,self.conn,self.data)['done'])
        self.assertIn(self.url(self.new_id()),self.api.resources)

    def test_foreign_resource_binding_or_scope_cannot_be_overwritten(self):
        rotate.allocated(self.api,self.conn,self.data,True)
        new=self.api.resources[self.url(self.new_id())];new['tags']['rotation-id']='other'
        with self.assertRaisesRegex(ValueError,'IP_RESOURCE_OWNERSHIP_CONFLICT'):rotate.bind(self.api,self.conn,self.data)
        self.nic['properties']['ipConfigurations'][0]['properties']['publicIPAddress']['id']=self.old_id+'-foreign'
        with self.assertRaisesRegex(ValueError,'IP_BINDING_CONFLICT'):rotate.context(self.api,self.conn,self.data)
        with self.assertRaisesRegex(ValueError,'IP_RESOURCE_SCOPE_CONFLICT'):rotate.path(self.conn,self.old_id.replace('qa-rotation','foreign'),'Microsoft.Network/publicIPAddresses')

    def test_rollback_cleanup_only_releases_new_ip(self):
        rotate.allocated(self.api,self.conn,self.data,True)
        self.assertFalse(rotate.cleanup(self.api,self.conn,self.data,True)['done'])
        self.assertTrue(rotate.cleanup(self.api,self.conn,self.data,True)['done'])
        self.assertIn(self.url(self.old_id),self.api.resources)

    def test_control_override_uses_pinned_key_and_verified_binding(self):
        rotate.allocated(self.api,self.conn,self.data,True)
        with self.assertRaisesRegex(ValueError,'IP_BINDING_CONFLICT'):rotate.route(self.api,self.conn,self.data)
        rotate.bind(self.api,self.conn,self.data)
        with patch.object(rotate.subprocess,'run') as lookup:
            lookup.return_value.stdout=''
            rotate.route(self.api,self.conn,self.data)
            saved=json.loads((self.local/'ip-address-overrides.json').read_text())
            self.assertEqual(saved[self.name]['address'],'8.8.4.4')
            lookup.return_value.stdout='8.8.4.4 ssh-ed25519 '+('b'*48)
            with self.assertRaisesRegex(ValueError,'SSH_HOST_KEY_MISMATCH'):rotate.route(self.api,self.conn,self.data)

if __name__=='__main__':main()
