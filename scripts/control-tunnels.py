#!/usr/bin/env python3
"""Local P0 control-plane transport: SSH tunnel + Remnawave mTLS.
Avoids the workstation network resetting the engine's derived TLS SNI.
Public VLESS endpoints remain the regional VM IPv4 addresses.
"""
from pathlib import Path
import subprocess, json, argparse, importlib.util
ROOT=Path(__file__).resolve().parents[1]; LOCAL=ROOT/'.local'
spec=importlib.util.spec_from_file_location('engine',ROOT/'scripts/engine-p0.py')
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
p=argparse.ArgumentParser();p.add_argument('command',choices=['start','status','stop']);args=p.parse_args()
nodes=json.loads((LOCAL/'azure-inventory.json').read_text())['nodes']
state=json.loads((LOCAL/'engine-nodes.json').read_text())
for index,node in enumerate(nodes):
    control=str(LOCAL/f'tunnel-{node["code"]}.sock');destination='xrayzoo@'+node['address'];port=22221+index
    base=['ssh','-S',control,'-i',str(LOCAL/'node_ssh'),'-o','UserKnownHostsFile='+str(LOCAL/'known_hosts'),'-o','StrictHostKeyChecking=accept-new','-o','BatchMode=yes','-o','ConnectTimeout=12']
    check=subprocess.run(base+['-O','check',destination],capture_output=True)
    if args.command=='stop':
        if check.returncode==0:subprocess.run(base+['-O','exit',destination],check=True,capture_output=True)
        print(node['name'],'tunnel stopped');continue
    if args.command=='start':
        if check.returncode:
            subprocess.run(base+['-M','-f','-N','-L',f'127.0.0.1:{port}:127.0.0.1:2222','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',destination],check=True)
        engine.request('/nodes','PATCH',{'uuid':state[node['code']]['engineNodeId'],'address':node['code']+'.xray-zoo.control','port':port})
        print(node['name'],'control tunnel ready')
    else:print(node['name'],'connected' if check.returncode==0 else 'stopped')
