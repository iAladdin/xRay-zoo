"""Contract tests: no Azure calls or real credentials are used."""
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import hashlib, importlib.util, json, tempfile, uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('adapter', ROOT/'scripts/azure-node.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)

class FakeAzure:
    def __init__(self): self.calls=[]; self.resources={}; self.items={}
    def request(self,path,method='GET',body=None,allow404=False):
        self.calls.append((path,method,body))
        return self.resources.get(path)
    def list(self,path): return self.items.get(path,[])

class AdapterTests(TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.local=Path(self.temp.name)
        self.patcher=patch.object(adapter,'LOCAL',self.local);self.patcher.start();self.addCleanup(self.patcher.stop)
        self.conn={'subscription':str(uuid.uuid4()),'resourceGroup':'qa-only','managementSourceCidr':'192.0.2.1/32','controlAddress':'127.0.0.1'}
        self.data={'operationId':str(uuid.uuid4()),'nodeName':'xz-eastus2-12345678','plan':{**self.conn,'region':'eastus2','size':'Standard_B2ats_v2','imageVersion':'qa','templateHash':hashlib.sha256((ROOT/'infra/azure/node.bicep').read_bytes()).hexdigest(),'cloudInitHash':hashlib.sha256((ROOT/'infra/azure/cloud-init.yaml').read_bytes()).hexdigest()}}
        self.api=FakeAzure()
        self.base='/resourcegroups/qa-only/providers/Microsoft.Compute/virtualMachines/'+self.data['nodeName']

    def test_refuses_scope_or_template_change(self):
        altered={**self.data,'plan':{**self.data['plan'],'resourceGroup':'foreign'}}
        with self.assertRaisesRegex(ValueError,'CONNECTION_CHANGED'):adapter.deployment(self.api,self.conn,altered)
        altered={**self.data,'plan':{**self.data['plan'],'cloudInitHash':'changed'}}
        with self.assertRaisesRegex(ValueError,'TEMPLATE_CHANGED'):adapter.deployment(self.api,self.conn,altered)
        self.assertEqual(self.api.calls,[])

    def test_unowned_deployment_cannot_be_overwritten(self):
        path=adapter.deployment(self.api,self.conn,self.data)
        self.api.resources[path]={'tags':{'operation-id':'foreign'},'properties':{'provisioningState':'Failed'}}
        with patch.object(adapter,'scope'), self.assertRaisesRegex(ValueError,'DEPLOYMENT_OWNERSHIP_CONFLICT'):
            adapter.submit(self.api,self.conn,self.data)
        self.assertFalse(any(method!='GET' for _,method,_ in self.api.calls))

    def test_existing_accepted_deployment_is_resumed(self):
        path=adapter.deployment(self.api,self.conn,self.data)
        self.api.resources[path]={'tags':{'operation-id':self.data['operationId']},'properties':{'provisioningState':'Running'}}
        with patch.object(adapter,'scope'):self.assertEqual(adapter.submit(self.api,self.conn,self.data),{'azureState':'Running'})
        self.assertEqual(len(self.api.calls),1)

    def test_extension_secret_is_protected_and_host_key_can_be_read(self):
        (self.local/'engine-auth.json').write_text(json.dumps({'nodeSecret':'QA_SECRET_SENTINEL'}))
        self.api.resources[self.base+'?api-version=2024-07-01']={'tags':{'operation-id':self.data['operationId']}}
        adapter.extension(self.api,self.conn,self.data,True)
        payload=self.api.calls[-1][2];props=payload['properties']
        self.assertEqual(props['settings'],{})
        self.assertIn('commandToExecute',props['protectedSettings'])
        self.assertNotIn('QA_SECRET_SENTINEL',json.dumps(payload))
        self.assertIn('base64 -d',props['protectedSettings']['commandToExecute'])
        path=self.base+'/extensions/xray-zoo-node?api-version=2024-07-01&$expand=instanceView'
        key='ssh-ed25519 '+('a'*48)
        self.api.resources[path]={'properties':{'provisioningState':'Succeeded','instanceView':{'substatuses':[{'message':'[stdout]\nXZ_HOST_KEY '+key+' root@qa\n'}]}}}
        self.assertEqual(adapter.extension(self.api,self.conn,self.data)['hostKey'],key)

    def test_tunnel_host_key_pinning_and_port_ownership(self):
        entry={'operationId':self.data['operationId'],'nodeName':self.data['nodeName'],'address':'8.8.8.8','controlPort':22300,'hostKey':'ssh-ed25519 '+('a'*48)}
        adapter.register_tunnel(entry);adapter.register_tunnel(entry)
        values=json.loads((self.local/'provisioned-tunnels.json').read_text())
        self.assertEqual(len(values),1);self.assertEqual(values[0]['code'],'machine-22300')
        with self.assertRaisesRegex(ValueError,'SSH_HOST_KEY_MISMATCH'):adapter.register_tunnel({**entry,'hostKey':'ssh-ed25519 '+('b'*48)})
        with self.assertRaisesRegex(ValueError,'TUNNEL_OWNERSHIP_CONFLICT'):adapter.register_tunnel({**entry,'nodeName':'xz-eastus2-87654321'})

    def test_quota_architecture_and_location_restrictions(self):
        sku={'resourceType':'virtualMachines','locations':['eastus2'],'family':'standardBSFamily','capabilities':[{'name':'vCPUs','value':'2'},{'name':'MemoryGB','value':'1'},{'name':'HyperVGenerations','value':'V2'}]}
        rows=[{**sku,'name':'good'},{**sku,'name':'restricted','restrictions':[{'type':'Location','values':['eastus2'],'reasonCode':'NotAvailableForSubscription'}]},{**sku,'name':'arm','capabilities':sku['capabilities']+[{'name':'CpuArchitectureType','value':'Arm64'}]}]
        usage=[{'name':{'value':name},'limit':10,'currentValue':5} for name in ('cores','standardBSFamily')]
        self.api.items['/providers/Microsoft.Compute/locations/eastus2/usages?api-version=2024-03-01']=usage
        with patch.object(adapter,'cached',return_value=rows):
            result={x['name']:x for x in adapter.skus(self.api,'eastus2')['items']}
            self.assertTrue(result['good']['available']);self.assertFalse(result['restricted']['available']);self.assertFalse(result['arm']['available'])
            usage[0]['currentValue']=10
            self.assertFalse(any(x['available'] for x in adapter.skus(self.api,'eastus2')['items']))

if __name__=='__main__':main()
