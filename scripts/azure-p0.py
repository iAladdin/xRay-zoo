#!/usr/bin/env python3
"""Azure P0 provisioning. Authentication uses an isolated az CLI session.
Secrets are never part of cloud-init or printed. Repeated deployment names converge.
"""
from pathlib import Path
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import argparse, hashlib, json, os, subprocess, sys, datetime, ipaddress, base64, shlex, time

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
REGIONS = {'jp': 'japaneast', 'sg': 'southeastasia', 'us': 'eastus2', 'hk': 'eastasia', 'tw': 'taiwannorth'}
ENV = dict(os.environ, AZURE_CONFIG_DIR=str(LOCAL / 'azure'))


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(value, f, indent=2)
    temporary.replace(path)


def az(*args):
    result = subprocess.run(['az', *args], env=ENV, capture_output=True, text=True, timeout=120)
    if result.returncode: raise RuntimeError(result.stderr[-2000:])
    return json.loads(result.stdout) if result.stdout.strip() else None


class Azure:
    def __init__(self, subscription):
        self.subscription = subscription
        self.base = f'https://management.azure.com/subscriptions/{subscription}'
        self.token = az('account', 'get-access-token', '--resource', 'https://management.azure.com/', '-o', 'json')['accessToken']

    def request(self, path, method='GET', body=None, allow404=False):
        url = path if path.startswith('https://') else self.base + path
        if urlparse(url).hostname != 'management.azure.com': raise ValueError('Unexpected ARM host')
        data = None if body is None else json.dumps(body).encode()
        request = Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        for attempt in range(4):
            try:
                with urlopen(request, timeout=90) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else {}
            except HTTPError as error:
                if error.code == 404 and allow404: return None
                if error.code in (429, 500, 502, 503, 504) and attempt < 3:
                    delay = min(15, int(error.headers.get('Retry-After', 2 ** (attempt + 1))))
                    time.sleep(delay)
                    continue
                detail = error.read().decode()[:2500]
                raise RuntimeError(f'ARM {error.code}: {detail}') from None

    def list(self, path):
        result = []
        while path:
            data = self.request(path)
            if isinstance(data, list): return data
            result += data.get('value', [])
            path = data.get('nextLink')
        return result


def digest(plan):
    return hashlib.sha256(json.dumps({k: v for k, v in plan.items() if k != 'sha256'}, sort_keys=True).encode()).hexdigest()


def plan(args):
    api = Azure(args.subscription)
    management_cidr = str(ipaddress.ip_network(args.management_cidr, strict=True))
    if ipaddress.ip_network(management_cidr).num_addresses != 1: raise ValueError('P0 management must be a single operator IP')
    nodes = []
    for code, region in REGIONS.items():
        cache = LOCAL / f'arm-skus-{region}.json'
        skus = json.loads(cache.read_text()) if cache.exists() else api.list('/providers/Microsoft.Compute/skus?' + urlencode({'api-version': '2021-07-01', '$filter': f"location eq '{region}'"}))
        sku = next((x for x in skus if x['name'] == args.size and x['resourceType'] == 'virtualMachines'), None)
        if not sku or any(r.get('type') == 'Location' for r in sku.get('restrictions', [])):
            raise RuntimeError(f'{region}: {args.size} unavailable for this subscription')
        usage = api.list(f'/providers/Microsoft.Compute/locations/{region}/usages?api-version=2024-03-01')
        needed = {'cores', sku.get('family', '').lower()}
        relevant = [u for u in usage if u['name']['value'].lower() in needed]
        if len(relevant) < 2: raise RuntimeError(f'{region}: could not verify both regional and family CPU quota')
        cpu = int(next(c['value'] for c in sku['capabilities'] if c['name'] == 'vCPUs'))
        if any(u['limit'] - u['currentValue'] < cpu for u in relevant): raise RuntimeError(f'{region}: insufficient CPU quota')
        images = api.list(f'/providers/Microsoft.Compute/locations/{region}/publishers/Canonical/artifacttypes/vmimage/offers/ubuntu-24_04-lts/skus/server/versions?' + urlencode({'api-version': '2024-03-01', '$top': '1', '$orderby': 'name desc'}))
        if not images: raise RuntimeError(f'{region}: Ubuntu image unavailable')
        print(f'Preflight passed: {region}', flush=True)
        nodes.append({'code': code, 'region': region, 'name': f'xz-p0-{code}', 'size': args.size, 'imageVersion': images[0]['name'], 'quota': relevant})
    p = {'schemaVersion': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'subscription': args.subscription, 'resourceGroup': args.resource_group, 'managementSourceCidr': management_cidr, 'nodes': nodes, 'purpose': 'xray-zoo-p0', 'templateSha256': hashlib.sha256((ROOT/'infra/azure/node.bicep').read_bytes()).hexdigest()}
    p['sha256'] = digest(p)
    save(LOCAL / 'azure-plan.json', p)
    print(json.dumps({'plan': str(LOCAL/'azure-plan.json'), 'regions': list(REGIONS.values()), 'nodeCount': len(nodes), 'vmSize': args.size, 'sha256': p['sha256']}))


def load_plan():
    p = json.loads((LOCAL/'azure-plan.json').read_text())
    if p['sha256'] != digest(p): raise ValueError('Plan hash mismatch')
    if p['templateSha256'] != hashlib.sha256((ROOT/'infra/azure/node.bicep').read_bytes()).hexdigest(): raise ValueError('Template changed; plan again')
    age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(p['createdAt'])
    if age.total_seconds() > 86400: raise ValueError('Plan expired; preflight again')
    return p


def deploy(args):
    p = load_plan(); api = Azure(p['subscription']); group = p['resourceGroup']
    existing = api.request(f'/resourcegroups/{group}?api-version=2022-09-01', allow404=True)
    if existing and existing.get('tags', {}).get('managed-by') != 'xray-zoo': raise RuntimeError('Refusing to use unowned resource group')
    if not existing: api.request(f'/resourcegroups/{group}?api-version=2022-09-01', 'PUT', {'location': 'eastus2', 'tags': {'managed-by': 'xray-zoo', 'purpose': 'p0'}})
    key = LOCAL/'node_ssh'
    if not key.exists(): subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'xray-zoo-p0', '-f', str(key)], check=True)
    az('bicep', 'build', '--file', str(ROOT/'infra/azure/node.bicep'), '--outfile', str(LOCAL/'node.arm.json'))
    template = json.loads((LOCAL/'node.arm.json').read_text())
    results = []
    for node in p['nodes']:
        values = {'location': node['region'], 'nodeName': node['name'], 'vmSize': node['size'], 'sshPublicKey': key.with_suffix('.pub').read_text().strip(), 'managementSourceCidr': p['managementSourceCidr'], 'imageVersion': node['imageVersion'], 'cloudInit': (ROOT/'infra/azure/cloud-init.yaml').read_text(), 'tags': {'managed-by': 'xray-zoo', 'purpose': 'p0', 'cluster': 'p0-five-regions', 'node': node['code']}}
        payload = {'properties': {'mode': 'Incremental', 'template': template, 'parameters': {k: {'value': v} for k, v in values.items()}}}
        path = f'/resourcegroups/{group}/providers/Microsoft.Resources/deployments/{node["name"]}?api-version=2022-09-01'
        try:
            api.request(path.replace('?api-version', '/validate?api-version'), 'POST', payload)
            response = api.request(path, 'PUT', payload)
            results.append({'node': node['name'], 'state': response.get('properties', {}).get('provisioningState', 'Submitted')})
        except Exception as error:
            results.append({'node': node['name'], 'state': 'Failed', 'error': str(error)})
        save(LOCAL/'azure-deploy-results.json', results)
        print(json.dumps(results[-1]), flush=True)


def status(args):
    p = load_plan(); api = Azure(p['subscription']); rows = []
    for node in p['nodes']:
        d = api.request(f'/resourcegroups/{p["resourceGroup"]}/providers/Microsoft.Resources/deployments/{node["name"]}?api-version=2022-09-01', allow404=True)
        props = (d or {}).get('properties', {})
        outputs = props.get('outputs', {})
        rows.append({**node, 'state': props.get('provisioningState', 'NotSubmitted'), 'address': outputs.get('nodeAddress', {}).get('value'), 'vmId': outputs.get('vmId', {}).get('value'), 'error': props.get('error')})
    save(LOCAL/'azure-inventory.json', {'resourceGroup': p['resourceGroup'], 'nodes': rows})
    print(json.dumps([{k: v for k, v in n.items() if k in ['code','region','name','state','address','error']} for n in rows], indent=2))


def install(args):
    p = load_plan(); api = Azure(p['subscription']); inventory = json.loads((LOCAL/'azure-inventory.json').read_text())
    auth = json.loads((LOCAL/'engine-auth.json').read_text())
    # The upstream Node trust credential stays in a protected ARM extension payload.
    env_body = f'NODE_PORT=2222\nSECRET_KEY={auth["nodeSecret"]}\n'
    encoded = base64.b64encode(env_body.encode()).decode()
    image = args.node_image
    if not image.startswith('remnawave/node@sha256:'): raise ValueError('A pinned official Node image digest is required')
    command = 'set -eu; for n in $(seq 1 60); do test -f /opt/xray-zoo/bootstrap-ready && break; sleep 5; done; test -f /opt/xray-zoo/bootstrap-ready; '
    command += 'umask 077; install -d -m 700 /opt/xray-zoo; printf %s ' + shlex.quote(encoded) + ' | base64 -d > /opt/xray-zoo/node.env; '
    command += 'docker pull ' + shlex.quote(image) + '; '
    command += 'if docker inspect xray-zoo-node >/dev/null 2>&1; then test "$(docker inspect --format=\'{{index .Config.Labels "managed-by"}}\' xray-zoo-node)" = xray-zoo; docker rm -f xray-zoo-node; fi; '
    command += 'docker run -d --name xray-zoo-node --label managed-by=xray-zoo --restart unless-stopped --network host --env-file /opt/xray-zoo/node.env --log-opt max-size=10m --log-opt max-file=3 ' + shlex.quote(image) + ' >/dev/null; echo node-container-started'
    for node in inventory['nodes']:
        if node['state'] != 'Succeeded': continue
        payload = {'location': node['region'], 'properties': {'publisher': 'Microsoft.Azure.Extensions', 'type': 'CustomScript', 'typeHandlerVersion': '2.1', 'autoUpgradeMinorVersion': True, 'settings': {}, 'protectedSettings': {'commandToExecute': command}}}
        api.request(node['vmId'] + '/extensions/xray-zoo-node?api-version=2024-07-01' if node['vmId'].startswith('https://') else 'https://management.azure.com' + node['vmId'] + '/extensions/xray-zoo-node?api-version=2024-07-01', 'PUT', payload)
        print(json.dumps({'node': node['name'], 'extension': 'Submitted'}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('plan'); p.add_argument('--subscription', required=True); p.add_argument('--management-cidr', required=True); p.add_argument('--resource-group', default='xray-zoo-p0'); p.add_argument('--size', default='Standard_B2ats_v2'); p.set_defaults(func=plan)
    for name, func in [('deploy',deploy),('status',status)]: commands.add_parser(name).set_defaults(func=func)
    p = commands.add_parser('install'); p.add_argument('--node-image', required=True); p.set_defaults(func=install)
    args = parser.parse_args()
    try: args.func(args)
    except Exception as error:
        print(str(error), file=sys.stderr); sys.exit(1)
