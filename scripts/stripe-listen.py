#!/usr/bin/env python3
"""Use the project's sandbox credentials, not the machine's global Stripe profile."""
from pathlib import Path
import os, subprocess, re
ROOT=Path(__file__).resolve().parents[1];p=ROOT/'.local/stripe.env'
values=dict(line.split('=',1) for line in p.read_text().splitlines() if '=' in line and not line.startswith('#'))
key=values.get('STRIPE_SECRET_KEY','').strip().strip('"\'')
if not key.startswith(('sk_test_','rk_test_')):raise SystemExit('Sandbox key required')
env=dict(os.environ,STRIPE_API_KEY=key)
result=subprocess.run(['stripe','listen','--print-secret','--skip-update'],env=env,capture_output=True,text=True,timeout=40)
match=re.search(r'whsec_[A-Za-z0-9]+',result.stdout)
if result.returncode or not match:raise SystemExit('Stripe listener authentication failed')
values['STRIPE_WEBHOOK_SECRET']=match.group()
p.write_text(''.join(k+'='+v+'\n' for k,v in values.items()));p.chmod(0o600)
print('Sandbox signing secret configured. Forwarding invoice.paid to localhost:3101.',flush=True)
# The CLI log contains its signing secret; write only to a private file.
log=ROOT/'.local/stripe-listener.log';fd=os.open(log,os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600)
with os.fdopen(fd,'a') as output:
    process=subprocess.Popen(['stripe','listen','--events','invoice.paid','--forward-to','http://127.0.0.1:3101/webhooks/stripe','--skip-update'],env=env,stdout=output,stderr=output,start_new_session=True)
(ROOT/'.local/stripe-listener.pid').write_text(str(process.pid))
print('Stripe local listener started')
