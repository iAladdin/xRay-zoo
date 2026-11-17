#!/usr/bin/env python3
"""Generate local-only secrets once, never print their values."""
from pathlib import Path
import secrets
import os

root = Path(__file__).resolve().parents[1]
local = root / '.local'
local.mkdir(mode=0o700, exist_ok=True)
local.chmod(0o700)
path = local / 'stack.env'
if path.exists():
    print('Keeping existing .local/stack.env')
else:
    values = {
        'POSTGRES_PASSWORD': secrets.token_hex(24),
        'ENGINE_DB_PASSWORD': secrets.token_hex(24),
        'ENGINE_APP_SECRET': secrets.token_hex(64),
        'ENGINE_METRICS_PASSWORD': secrets.token_hex(32),
        'ENGINE_WEBHOOK_SECRET': secrets.token_hex(32),
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(''.join(f'{k}={v}\n' for k, v in values.items()))
    print('Created .local/stack.env with mode 0600')

values = dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))
app = local / 'app.env'
if not app.exists():
    settings = {
        'APP_ENV': 'local', 'APP_ORIGIN': 'http://localhost:3100',
        'API_ORIGIN': 'http://localhost:3101', 'SUBSCRIPTION_ORIGIN': 'http://localhost:3101',
        'DATABASE_URL': f'postgresql://xrayzoo:{values["POSTGRES_PASSWORD"]}@127.0.0.1:15432/xrayzoo',
        'REDIS_URL': 'redis://127.0.0.1:16379', 'ENCRYPTION_KEY': secrets.token_hex(32),
        'PAYMENT_PROVIDER': 'dev',
    }
    with os.fdopen(os.open(app, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
        out.write(''.join(f'{k}={v}\n' for k, v in settings.items()))
    print('Created .local/app.env; dev payments are local simulation only')
