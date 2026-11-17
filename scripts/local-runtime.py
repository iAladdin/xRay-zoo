#!/usr/bin/env python3
"""Start/stop only this project's local API, web and worker processes."""
from pathlib import Path
import os, sys, json, subprocess, signal, shutil
ROOT=Path(__file__).resolve().parents[1]; LOCAL=ROOT/'.local'; LOCAL.mkdir(exist_ok=True,mode=0o700)
file=LOCAL/'runtime.json';state=json.loads(file.read_text()) if file.exists() else {}
node=shutil.which('node')
commands={
 'api':[node,str(ROOT/'node_modules/tsx/dist/cli.mjs'),str(ROOT/'apps/api/src/main.ts')],
 'worker':[node,str(ROOT/'node_modules/tsx/dist/cli.mjs'),str(ROOT/'apps/worker/src/main.ts')],
 'web':[node,str(ROOT/'node_modules/next/dist/bin/next'),'dev',str(ROOT/'apps/web'),'-p','3100','-H','127.0.0.1'],
}
def own(name,item):
 if not item:return False
 r=subprocess.run(['ps','-p',str(item['pid']),'-o','command='],capture_output=True,text=True)
 return r.returncode==0 and str(ROOT/('apps/web' if name=='web' else f'apps/{name}/src/main.ts')) in r.stdout
action=sys.argv[1] if len(sys.argv)>1 else 'status'
if action not in ['start','stop','status']:raise SystemExit('Usage: local-runtime.py start|stop|status')
for name,cmd in commands.items():
 active=own(name,state.get(name))
 if action=='start' and not active:
  fd=os.open(LOCAL/f'{name}.log',os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600)
  with os.fdopen(fd,'a') as log:p=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=log,start_new_session=True)
  state[name]={'pid':p.pid};active=True
 elif action=='stop' and active:
  os.killpg(state[name]['pid'],signal.SIGTERM);state.pop(name);active=False
 print(name,'running' if active else 'stopped')
file.write_text(json.dumps(state));file.chmod(0o600)
