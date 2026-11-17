#!/usr/bin/env python3
"""Supervise only this project's SSH control tunnels; never change proxy settings."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess, json, argparse, importlib.util, fcntl, os, signal, socket, time, tempfile
ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'

def ensure_relay():
    transport_file=LOCAL/'control-transport.json'
    if not transport_file.exists(): return
    transport=json.loads(transport_file.read_text())
    config=LOCAL/'control-proxy.yaml'
    with open(LOCAL/'control-proxy.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        pidfile=LOCAL/'control-proxy.pid'
        pid=int(pidfile.read_text()) if pidfile.exists() else 0
        command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout if pid else ''
        if str(config) in command and transport['binary'] in command:return
        fd=os.open(LOCAL/'control-proxy.log',os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600)
        with os.fdopen(fd,'a') as log:
            process=subprocess.Popen([transport['binary'],'-d',str(LOCAL/'control-proxy-data'),'-f',str(config)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        pidfile.write_text(str(process.pid));pidfile.chmod(0o600)
        for _ in range(30):
            if process.poll() is not None: raise RuntimeError('CONTROL_RELAY_START_FAILED')
            try:
                with socket.create_connection(('127.0.0.1',int(transport['socksPort'])),timeout=.1):return
            except OSError:time.sleep(.1)
        raise RuntimeError('CONTROL_RELAY_START_TIMEOUT')

def run_node(item):
    index, node, command = item
    control = str(LOCAL / f'tunnel-{node["code"]}.sock')
    base = ['/usr/bin/ssh', '-S', control, '-i', str(LOCAL/'node_ssh'), '-o', 'UserKnownHostsFile='+str(LOCAL/'known_hosts'), '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
    transport_file=LOCAL/'control-transport.json'
    if transport_file.exists():
        port=int(json.loads(transport_file.read_text())['socksPort'])
        if not 1024<=port<=65535:raise ValueError('Invalid local control port')
        base += ['-o',f'ProxyCommand=/usr/bin/nc -X 5 -x 127.0.0.1:{port} %h %p']
    with open(LOCAL/f'tunnel-{node["code"]}.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Read overrides inside the lock, so a queued health check cannot resurrect an old IP.
        overrides=LOCAL/'ip-address-overrides.json'
        override=(json.loads(overrides.read_text()) if overrides.exists() else {}).get(node['name'])
        address=override['address'] if override else node['address']
        destination='xrayzoo@'+address
        endpoint_file=LOCAL/f'tunnel-{node["code"]}.address'
        previous=endpoint_file.read_text() if endpoint_file.exists() else (node['address'] if not override else None)
        check = subprocess.run(base+['-O','check',destination], capture_output=True, timeout=10)
        active = check.returncode == 0
        error = None
        if active and previous!=address:
            if command != 'status':
                subprocess.run(base+['-O','exit',destination], capture_output=True, timeout=10)
            active=False
        if command == 'stop' and active:
            subprocess.run(base+['-O','exit',destination], capture_output=True, timeout=10)
            active = False
        if command in ('start','ensure') and not active:
            try:
                # ssh -f children retain stderr. PIPE/communicate waits for their EOF and falsely times out.
                with tempfile.TemporaryFile() as errors:
                    port=int(node.get('controlPort',22221+index))
                    if not 1024<=port<=65535:raise ValueError('Invalid forwarding port')
                    result = subprocess.run(base+['-M','-f','-N','-L',f'127.0.0.1:{port}:127.0.0.1:2222','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',destination], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, timeout=15)
                    active = result.returncode == 0
                    if not active:
                        errors.seek(0)
                        error = 'SSH_AUTH_FAILED' if b'Permission denied' in errors.read() else 'SSH_UNREACHABLE'
            except subprocess.TimeoutExpired:
                error = 'SSH_TIMEOUT'
        if active:
            endpoint_file.write_text(address);endpoint_file.chmod(0o600)
        return {'id':node['name'], 'connected':active, 'error':error}

def main():
    p=argparse.ArgumentParser()
    p.add_argument('command', choices=['start','ensure','status','stop'])
    p.add_argument('--node')
    p.add_argument('--json', action='store_true')
    args=p.parse_args()
    nodes=json.loads((LOCAL/'azure-inventory.json').read_text())['nodes']
    extra=LOCAL/'provisioned-tunnels.json'
    if extra.exists():nodes+=json.loads(extra.read_text())
    selected=[(i,n,args.command) for i,n in enumerate(nodes) if args.node is None or n['name']==args.node]
    if not selected: raise SystemExit('Unknown managed node')
    if args.command in ('start','ensure'):ensure_relay()
    if args.command=='start':
        spec=importlib.util.spec_from_file_location('engine', ROOT/'scripts/engine-p0.py')
        engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
        state=json.loads((LOCAL/'engine-nodes.json').read_text())
        response=engine.request('/nodes'); current=response if isinstance(response,list) else response['nodes']
        for i,n,_ in selected:
            if n['code'] not in state:continue  # New operations register their explicit control endpoint.
            uuid=state[n['code']]['engineNodeId']; desired={'address':n['code']+'.xray-zoo.control','port':22221+i}
            observed=next((v for v in current if v['uuid']==uuid),{})
            if any(observed.get(k)!=v for k,v in desired.items()): engine.request('/nodes','PATCH',{'uuid':uuid,**desired})
    with ThreadPoolExecutor(max_workers=5) as pool: results=list(pool.map(run_node, selected))
    if args.command=='stop' and args.node is None:
        pidfile=LOCAL/'control-proxy.pid'
        if pidfile.exists():
            pid=int(pidfile.read_text());command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
            if str(LOCAL/'control-proxy.yaml') in command:os.kill(pid,signal.SIGTERM)
    if args.json: print(json.dumps(results))
    else:
        for n in results: print(n['id'], 'connected' if n['connected'] else n['error'] or 'stopped')

if __name__=='__main__': main()
