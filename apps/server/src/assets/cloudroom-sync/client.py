#!/usr/bin/env python3
"""Skills/settings sync and one-way Codex login import. Project files never sync."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from files import Conflict, Tree, atomic_json, excluded


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('core redirects are not accepted')


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        if os.fstat(source.fileno()).st_mode & 0o077:
            raise ValueError('configuration must be private')
        return json.load(source)


class Remote:
    def __init__(self, connection, device):
        parsed = urllib.parse.urlsplit(connection['url'])
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'})) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('use an HTTPS core address')
        token = connection.get('token', '')
        gate = connection.get('gateToken')
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('sign in required')
        if gate is not None and (not gate or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-' for c in gate)):
            raise ValueError('invalid hosting gate token')
        self.url, self.device = connection['url'].rstrip('/'), device
        self.headers = {'Authorization': 'Bearer ' + token, **({'Cookie': '_port_auth=' + gate} if gate else {})}
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def request(self, path, body=None, method=None, headers=None, timeout=60):
        request = urllib.request.Request(self.url + path, data=body, method=method, headers={**self.headers, **(headers or {})})
        try:
            return self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in {409, 412}:
                raise Conflict('remote changed') from None
            raise OSError(f'Core returned HTTP {error.code} for {urllib.parse.urlsplit(path).path}') from None

    def json(self, path, value=None):
        body = json.dumps(value).encode() if value is not None else None
        with self.request(path, body, headers={'Content-Type': 'application/json'}) as response:
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError('core JSON response exceeds the existing client limit')
            return json.loads(data)

    def path(self, root, file=None, **args):
        return '/v1/sync/' + urllib.parse.quote(root, safe='') + ('/file' if file is not None else '') + '?' + urllib.parse.urlencode({'device': self.device, **({'path': file} if file is not None else {}), **{k: str(v).lower() if isinstance(v, bool) else v for k,v in args.items() if v is not None}})

    def scan(self, root):
        return self.json(self.path(root))

    def upload(self, root, path, expected, entry, data):
        url = self.path(root, path, expected=expected, **({'kind':entry['kind'], 'executable':entry['executable'], 'incoming':entry['tag'], 'size':entry['size']} if entry else {}))
        with self.request(url, data if entry else b'', method='PUT', headers={'Content-Length': str(entry['size'] if entry else 0), 'Content-Type': 'application/octet-stream'}) as response:
            return json.load(response)


def configuration_roots(roots):
    return [r for r in roots if r['tree']['kind'] in {'skills', 'codex', 'pi', 'claude', 'cursor'}]


def import_codex(config, connection, folder):
    folder = Path(folder)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (folder / 'codex-import.lock').open('a') as lock:
        os.chmod(folder / 'codex-import.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        remote = Remote(connection, config.get('device', ''))
        capabilities = remote.json('/v1/capabilities')
        if not capabilities.get('codex_auth_import'):
            return None
        status = remote.json('/v1/accounts/codex')
        if status['state'] != 'missing':
            return status
        home = config.get('codexHome') or os.environ.get('CODEX_HOME') or Path.home() / '.codex'
        path = Path(home).expanduser() / 'auth.json'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                    return status
                raw = source.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                return status
            value = json.loads(raw)
            if (not isinstance(value, dict) or value.get('auth_mode', 'chatgpt') != 'chatgpt'
                    or value.get('OPENAI_API_KEY') is not None or not isinstance(value.get('tokens'), dict)):
                return status
            keys = ['id_token', 'access_token', 'refresh_token', 'account_id']
            if any(not isinstance(value['tokens'].get(key), str) or not value['tokens'][key] for key in keys):
                return status
            credentials = {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None,
                           'tokens': {key: value['tokens'][key] for key in keys}}
            if isinstance(value.get('last_refresh'), str):
                credentials['last_refresh'] = value['last_refresh']
        except (OSError, ValueError):
            return status
        attempt = {'binding': [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')],
                   'fingerprint': hashlib.sha256(raw).hexdigest()}
        receipt = folder / 'codex-import.json'
        if receipt.exists() and private_json(receipt) == attempt:
            return status
        status = remote.json('/v1/accounts/codex/import', credentials)
        if status['state'] in {'connected', 'limited', 'missing'}:
            atomic_json(receipt, attempt)
        return status


def cycle(config, connection, state_dir):
    remote = Remote(connection, config['device'])
    try:
        import_codex(config, connection, state_dir)
    except (OSError, Conflict, ValueError, KeyError, TypeError):
        pass  # Login recovery must not stop independent skills/settings sync.
    roots = configuration_roots(config['roots'])
    remote.json('/v1/sync', {'device': config['device']})
    details = {}
    for root in roots:
        identity = root['id']
        state_path = state_dir / (identity + '.json')
        previous = private_json(state_path) if state_path.exists() else {'base': {}, 'cache': {}, 'conflicts': []}
        base = previous['base']
        tree = Tree(**root['tree'])
        conflicts = []
        try:
            local, cloud = tree.scan(previous.get('cache')), remote.scan(identity)
            skipped = local.get('skipped', []) + cloud.get('skipped', [])
            conflicts.extend(skipped)
            for path in sorted(set(base) | set(local['files']) | set(cloud['files'])):
                if excluded(path) or any(path == prefix or path.startswith(prefix + '/') for prefix in skipped):
                    continue
                left, right = local['files'].get(path), cloud['files'].get(path)
                a, b, old = (left or {}).get('tag'), (right or {}).get('tag'), base.get(path)
                if a == b:
                    base[path] = a
                    continue
                if a != old and b != old:
                    conflicts.append(path)
                    continue
                try:
                    if b == old:
                        if left:
                            with tree.snapshot(path) as (entry, data):
                                if entry['tag'] != a:
                                    raise Conflict('local changed')
                                remote.upload(identity, path, b, entry, data)
                        else:
                            remote.upload(identity, path, b, None, None)
                        base[path] = a
                    else:
                        if right:
                            with remote.request(remote.path(identity, path, expected=b)) as data:
                                tree.apply(path, a, right, data)
                        else:
                            tree.apply(path, a, None, None)
                        base[path] = b
                    atomic_json(state_path, {'base': base, 'cache': {}, 'conflicts': conflicts})
                except Conflict:
                    conflicts.append(path)
            atomic_json(state_path, {'base': base, 'cache': local['files'], 'conflicts': conflicts})
            details[identity] = {'state': 'conflict' if conflicts else 'synced', 'conflicts': len(conflicts)}
        except Conflict:
            details[identity] = {'state': 'conflict', 'issue': 'Resolve conflicting files or case collisions.'}
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            details[identity] = {'state': 'offline', 'issue': 'Check sync access, supported file types, and available disk space.'}
    states = {identity: detail['state'] for identity, detail in details.items()}
    remote.json('/v1/sync', {'device': config['device'], 'states': states})
    return {'state': 'conflict' if 'conflict' in states.values() else 'offline' if 'offline' in states.values() else 'synced', 'roots': details, 'checkedAt': int(time.time() * 1000)}


def load_connection(config):
    connection = private_json(config['connectionFile'])
    binding = [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')]
    if config['binding'] != binding:
        raise ValueError('connection changed; review sync setup again')
    return connection


def run(folder, once=False):
    folder = Path(folder).resolve(strict=True)
    with (folder / 'lock').open('a') as lock:
        os.chmod(folder / 'lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            started = time.monotonic()
            try:
                config = private_json(folder / 'config.json')
                status = cycle(config, load_connection(config), folder)
            except (OSError, Conflict, ValueError, KeyError, TypeError):
                status = {'state': 'offline', 'issue': 'Sync cannot connect. Check account setup and core access.', 'checkedAt': int(time.time() * 1000)}
            atomic_json(folder / 'status.json', status)
            if once:
                return status
            time.sleep(max(0, 5 - (time.monotonic() - started)))


def discover(home):
    codex = Path(os.environ.get('CODEX_HOME') or home / '.codex').expanduser()
    pi = Path(os.environ.get('PI_CODING_AGENT_DIR') or home / '.pi/agent').expanduser()
    claude = home / '.claude'
    roots = []
    for identity, path in [('shared', home / '.agents'), ('codex', codex), ('pi', pi), ('claude', claude), ('cursor', home / '.cursor')]:
        if (path / 'skills').is_dir():
            roots.append({'id': 'skills-' + identity, 'tree': {'root': str((path / 'skills').resolve()), 'kind': 'skills'}})
        filename = 'config.toml' if identity == 'codex' else 'cli-config.json' if identity == 'cursor' else 'settings.json'
        if identity == 'cursor' and (path / 'rules').is_dir():
            roots.append({'id': 'rules-cursor', 'tree': {'root': str((path / 'rules').resolve()), 'kind': 'skills'}})
        if identity != 'shared' and (path / filename).is_file():
            roots.append({'id': 'settings-' + identity, 'tree': {'root': str(path.resolve()), 'kind': identity, 'filename': filename}})
    return roots


def launch_identity(folder):
    return 'dev.cloudroom.sync.' + hashlib.sha256(str(folder).encode()).hexdigest()[:16]


def launch(folder, stop=False):
    if sys.platform != 'darwin':
        raise ValueError('automatic installation supports macOS; use run on other systems')
    label = launch_identity(folder)
    domain = f'gui/{os.getuid()}'
    path = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    if stop:
        subprocess.run(['launchctl', 'bootout', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['launchctl', 'print', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            if time.monotonic() >= deadline:
                raise OSError('Sync helper did not stop within 10 seconds')
            time.sleep(.1)
        with (folder / 'lock').open('a') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OSError('Previous sync helper is still shutting down')
                    time.sleep(.1)
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as output:
        plistlib.dump({'Label': label, 'ProgramArguments': [sys.executable, '-B', '-E', '-s', str(folder / 'client.py'), 'run', str(folder)], 'EnvironmentVariables': {'PATH': os.environ.get('PATH', os.defpath)}, 'RunAtLoad': True, 'KeepAlive': True, 'ProcessType': 'Background', 'ThrottleInterval': 5}, output)
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def configure(folder, connection_file, activate=True):
    folder = Path(folder).expanduser().resolve()
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    with (folder / 'configure.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        connection_file = Path(connection_file).expanduser().resolve(strict=True)
        connection = private_json(connection_file)
        binding = [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')]
        old = private_json(folder / 'config.json') if (folder / 'config.json').exists() else None
        if old and old['binding'] != binding:
            raise ValueError('sync belongs to another account/core; use a separate local sync directory')
        if activate:
            launch(folder, stop=True)
        # Keep old repository baselines and recovery copies on disk, but never use them again.
        roots = configuration_roots(old['roots']) if old else discover(Path.home())
        for name in ['client.py', 'files.py']:
            source, target = Path(__file__).parent / name, folder / name
            if source.resolve() != target.resolve():
                temporary = folder / ('.sync-' + name)
                shutil.copyfile(source, temporary); temporary.chmod(0o600); temporary.replace(target)
        legacy_home = next((r['tree']['root'] for r in (old or {}).get('roots', []) if r['id'] == 'auth-codex'), None)
        codex_home = os.environ.get('CODEX_HOME') or (old or {}).get('codexHome') or legacy_home or Path.home() / '.codex'
        config = {'device': old['device'] if old else uuid.uuid4().hex, 'connectionFile': str(connection_file), 'binding': binding, 'roots': roots, 'codexHome': str(Path(codex_home).expanduser().resolve())}
        atomic_json(folder / 'config.json', config)
        if activate:
            launch(folder)
        return {'enabled': True, 'roots': [r['id'] for r in roots]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'run', 'once', 'auth', 'status', 'stop'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--connection', type=Path)
    parser.add_argument('--no-start', action='store_true', help='Prepare configuration without installing a background job')
    args = parser.parse_args()
    if args.command == 'configure':
        result = configure(args.directory, args.connection, not args.no_start)
    elif args.command in {'run', 'once'}:
        result = run(args.directory, args.command == 'once')
    elif args.command == 'auth':
        config_path = args.directory / 'config.json'
        config = private_json(config_path) if config_path.exists() else {}
        connection = load_connection(config) if config else private_json(args.connection)
        result = import_codex(config, connection, args.directory)
    elif args.command == 'stop':
        launch(args.directory.resolve(), stop=True)
        result = {'state': 'offline'}
    else:
        result = private_json(args.directory / 'status.json')
    if result is not None:
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        message = f'Sync shutdown failed: {error}' if sys.argv[1:2] == ['stop'] else 'Sync setup failed. Check Python 3.11+, private connection settings, folder permissions, and macOS background-job access.'
        print(message, file=sys.stderr)
        sys.exit(1)
