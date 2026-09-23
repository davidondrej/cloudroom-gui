#!/usr/bin/env python3
"""Independent localhost previews. Standard-library control client and native OpenSSH transport."""
import argparse
import base64
import concurrent.futures
import contextlib
import fcntl
import http.client
import http.server
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import select
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as file:
        info = os.fstat(file.fileno())
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Preview configuration must be private and owned by this user')
        return json.load(file)


def save(path, value):
    temporary = path.with_suffix('.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(value, file); file.flush(); os.fsync(file.fileno())
    temporary.replace(path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Preview control requests cannot redirect')


class ControlError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__('Preview control returned HTTP ' + str(code))


class Core:
    def __init__(self, config):
        connection = private_json(config['connectionFile'])
        self.connection = connection
        self.url = connection['url'].rstrip('/')
        url = urllib.parse.urlsplit(self.url)
        if (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in {'localhost', '127.0.0.1', '::1'})) or url.username or url.password or url.query or url.fragment:
            raise ValueError('Use an authenticated HTTPS core connection')
        if config['binding'] != [self.url, (connection.get('account') or {}).get('id')]:
            raise ValueError('Preview connection belongs to another account or VM')
        token = connection.get('token', '')
        gate = connection.get('gateToken')
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('Sign in to Cloudroom again')
        if gate is not None and (not gate or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-' for c in gate)):
            raise ValueError('Invalid hosting credential')
        self.headers = {'Authorization': 'Bearer ' + token, **({'Cookie': '_port_auth=' + gate} if gate else {})}
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def prepare(self):
        account = (self.connection.get('account') or {}).get('id')
        if not account:
            return
        uuid.UUID(account)
        website = self.connection.get('websiteUrl', 'https://www.cloudroom.dev').rstrip('/')
        url = urllib.parse.urlsplit(website)
        if website != 'https://www.cloudroom.dev' and not (url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port and not url.path and not url.query and not url.fragment and not url.username):
            raise ValueError('Invalid managed preview service')
        credential = base64.b64encode((account + ':' + self.connection['token']).encode()).decode()
        return self.fetch(website + '/api/desktop/previews', {}, None, {'Authorization': 'Basic ' + credential})

    def request(self, path, body=None, method=None):
        return self.fetch(self.url + '/v1/previews' + path, body, method, self.headers)

    def fetch(self, url, body, method, headers):
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                        method=method, headers={**headers, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=5) as response:
                raw = response.read(256 * 1024 + 1)
                if len(raw) > 256 * 1024:
                    raise ValueError('Preview response is too large')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            error.close()
            raise ControlError(error.code) from None


class Upstream(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))
        self.transport = self.sock


class UpgradeResponse(http.client.HTTPResponse):
    def __init__(self, sock, *args, **kwargs):
        super().__init__(sock, *args, **kwargs)
        self.fp.close()
        # Do not consume WebSocket frames while parsing the HTTP upgrade headers.
        self.fp = sock.makefile('rb', buffering=0)


HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'}


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    rbufsize = 0

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        with self.server.tunnel.connections_lock:
            self.server.tunnel.connections.add(self.connection)

    def finish(self):
        with self.server.tunnel.connections_lock:
            self.server.tunnel.connections.discard(self.connection)
        super().finish()

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (OSError, ValueError, http.client.HTTPException):
            self.close_connection = True

    def forward(self):
        self.close_connection = True
        expected = self.server.authority
        origin = self.headers.get('Origin')
        if self.headers.get_all('Host') != [expected] or origin is not None and origin != 'http://' + expected:
            self.send_error(403, 'Preview origin is not allowed'); return
        if self.headers.get('Sec-Fetch-Site') == 'cross-site' and not (self.command in {'GET', 'HEAD'} and self.headers.get('Sec-Fetch-Mode') == 'navigate' and self.headers.get('Sec-Fetch-Dest') == 'document'):
            self.send_error(403, 'Cross-site preview request blocked'); return
        if not self.path.startswith('/') or self.path.startswith('//') or len(self.headers.get_all('Content-Length', [])) > 1:
            self.send_error(400, 'Invalid preview request'); return
        if self.headers.get('Transfer-Encoding'):
            self.send_error(411, 'Use a content length for preview uploads'); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self.send_error(400, 'Invalid content length'); return
        if length < 0:
            self.send_error(400, 'Invalid content length'); return
        websocket = self.headers.get('Upgrade', '').lower() == 'websocket'
        if websocket and origin != 'http://' + expected:
            self.send_error(403, 'WebSocket origin is required'); return
        connection_headers = {v.strip().lower() for v in self.headers.get('Connection', '').split(',')}
        upstream = Upstream(self.server.tunnel.socket_path)
        if websocket:
            upstream.response_class = UpgradeResponse
        response = None
        sent_headers = False
        try:
            upstream.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            for key, value in self.headers.items():
                if key.lower() not in HOP | connection_headers:
                    upstream.putheader(key, value)
            upstream.putheader('Connection', 'Upgrade' if websocket else 'close')
            if websocket:
                upstream.putheader('Upgrade', 'websocket')
            upstream.endheaders()
            while length:
                data = self.rfile.read(min(length, 64 * 1024))
                if not data:
                    return
                upstream.send(data); length -= len(data)
            response = upstream.getresponse()
            upstream.transport.settimeout(None)
            self.send_response_only(response.status)
            excluded = HOP | {v.strip().lower() for v in response.getheader('Connection', '').split(',')}
            for key, value in response.getheaders():
                if key.lower() not in excluded | {'x-cloudroom-preview'}:
                    self.send_header(key, value)
            self.send_header('X-Cloudroom-Preview', self.server.tunnel.generation)
            self.send_header('Content-Security-Policy', "frame-ancestors 'self'")
            self.send_header('Connection', 'Upgrade' if response.status == 101 else 'close')
            if response.status == 101:
                self.send_header('Upgrade', 'websocket')
            self.end_headers()
            sent_headers = True
            if response.status == 101:
                if not websocket or upstream.sock is None:
                    return
                self.connection.settimeout(30); upstream.sock.settimeout(30)
                while not self.server.tunnel.closed:
                    readable, _, _ = select.select([self.connection, upstream.sock], [], [], 1)
                    for source in readable:
                        data = source.recv(64 * 1024)
                        if not data:
                            return
                        (upstream.sock if source is self.connection else self.connection).sendall(data)
            else:
                while data := response.read1(64 * 1024):
                    self.wfile.write(data); self.wfile.flush()
        except (OSError, ValueError, http.client.HTTPException):
            if not sent_headers and not self.wfile.closed:
                with contextlib.suppress(OSError):
                    self.send_error(502, 'Cloud preview unavailable; reconnecting')
        finally:
            if response is not None:
                response.close()
            upstream.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = forward


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(15)
        return connection, address


class Tunnel:
    def __init__(self, folder, port, generation, device, metadata, allow_private, local_port):
        self.closed = False
        self.connections = set()
        self.connections_lock = threading.Lock()
        self.endpoint = metadata
        self.port, self.generation = port, generation
        address = ipaddress.ip_address(metadata['host'])
        if not address.is_global and not allow_private:
            raise ValueError('Private SSH addresses require explicit self-hosted setup')
        if metadata.get('user') != 'cloudroom-preview' or type(metadata.get('port')) is not int or not 1 <= metadata['port'] <= 65535:
            raise ValueError('Invalid preview SSH endpoint')
        key = metadata.get('host_key', '')
        if len(key) != 80 or not key.startswith('ssh-ed25519 ') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=' for c in key[12:]):
            raise ValueError('Invalid SSH host identity')
        self.socket_path = folder / f'p{port}.sock'
        self.socket_path.unlink(missing_ok=True)
        known = folder / 'known_hosts'
        known.write_text('cloudroom-preview ' + key + '\n'); known.chmod(0o600)
        self.log_path = folder / f'ssh-{port}.log'
        self.stderr = bytearray()
        command = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-i', str(folder / 'id_ed25519'),
                   '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'HostKeyAlias=cloudroom-preview', '-o', 'UserKnownHostsFile=' + str(known),
                   '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=5',
                   '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                   '-L', f'{self.socket_path}:127.0.0.1:{port}', '-p', str(metadata['port']), f'cloudroom-preview@{address}']
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        def capture():
            while data := self.process.stderr.read(1024):
                self.stderr.extend(data)
                del self.stderr[:-16384]
        self.capture = threading.Thread(target=capture, daemon=True)
        self.capture.start()
        try:
            try:
                self.server = Server(('127.0.0.1', local_port), Proxy)
            except OSError:
                self.server = Server(('127.0.0.1', 0), Proxy)
            self.server.authority = f'p{port}-{device[:8]}.localhost:{self.server.server_port}'
            self.server.tunnel = self
            self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
            self.thread.start()
        except BaseException:
            self.process.terminate(); self.process.wait(timeout=6)
            self.capture.join(timeout=1); self.process.stderr.close()
            raise

    def healthy(self):
        if self.process.poll() is not None or not self.socket_path.exists():
            return False
        try:
            with contextlib.closing(http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)) as connection:
                connection.request('HEAD', '/', headers={'Host': self.server.authority})
                response = connection.getresponse()
                return response.getheader('X-Cloudroom-Preview') == self.generation
        except (OSError, http.client.HTTPException):
            return False

    def close(self):
        self.closed = True
        self.server.shutdown(); self.server.server_close()
        with self.connections_lock:
            for connection in self.connections:
                with contextlib.suppress(OSError):
                    connection.shutdown(socket.SHUT_RDWR)
        self.process.terminate()
        try:
            self.process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.process.kill(); self.process.wait()
        self.capture.join(timeout=1); self.process.stderr.close()
        self.log_path.write_bytes(self.stderr); self.log_path.chmod(0o600)
        self.socket_path.unlink(missing_ok=True)


def identity(folder):
    key = folder / 'id_ed25519'
    public = folder / 'id_ed25519.pub'
    if not key.exists() and not public.exists():
        subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
    info = key.lstat()
    if key.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077 or public.is_symlink():
        raise ValueError('Unsafe preview SSH key')
    return ' '.join(public.read_text().split()[:2])


def run(folder):
    tunnels = {}
    ports_file = folder / 'ports.json'
    ports = private_json(ports_file) if ports_file.exists() else {}
    prepare_due, refresh, authenticated, delay = 0, True, 0, 2
    denied, credential = None, None
    def stop(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    with (folder / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            while True:
                try:
                    config = private_json(folder / 'config.json')
                    core = Core(config)
                    if credential != core.headers:
                        credential, prepare_due, refresh, denied = core.headers, 0, True, None
                    if config.pop('revoked', False):
                        save(folder / 'config.json', config)
                    if refresh and time.monotonic() >= prepare_due:
                        prepare_due = time.monotonic() + 60
                        try:
                            core.prepare()
                            refresh, denied = False, None
                        except (OSError, ValueError) as error:
                            if isinstance(error, ControlError) and error.code in (401, 403):
                                denied = error
                    if denied:
                        raise denied
                    metadata = core.request('/device', {'device': config['device'], 'public_key': identity(folder)})
                    previews = core.request('')['previews']
                    authenticated = time.monotonic()
                    desired = {}
                    for entry in previews:
                        port = entry['port']
                        if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(entry['generation'], str):
                            raise ValueError('Invalid preview registration')
                        desired[port] = entry['generation']
                    failed = {port for port, tunnel in tunnels.items() if tunnel.process.poll() is not None}
                    refresh = refresh or bool(failed)
                    for port, tunnel in list(tunnels.items()):
                        if desired.get(port) != tunnel.generation or port in failed or tunnel.endpoint != metadata:
                            tunnel.close(); del tunnels[port]
                    for port, generation in desired.items():
                        if port not in tunnels:
                            local_port = ports.get(str(port), port)
                            if type(local_port) is not int or not 1024 <= local_port <= 65535:
                                local_port = port
                            try:
                                tunnels[port] = Tunnel(folder, port, generation, config['device'], metadata, config.get('allowPrivateSsh', False), local_port)
                            except OSError:
                                core.request('/report', {'device': config['device'], 'port': port, 'generation': generation,
                                                         'local_port': None, 'error': 'Local preview port unavailable'})
                                continue
                            ports[str(port)] = tunnels[port].server.server_port
                            save(ports_file, ports)
                    def report(tunnel):
                        ready = tunnel.healthy()
                        error = None
                        if not ready:
                            if tunnel.port in failed or tunnel.process.poll() is not None:
                                error = 'SSH connection unavailable'
                            elif tunnel.socket_path.exists():
                                error = 'Cloud HTTP server unavailable'
                        try:
                            core.request('/report', {'device': config['device'], 'port': tunnel.port, 'generation': tunnel.generation,
                                                     'local_port': tunnel.server.server_port if ready else None, 'error': error})
                        except ControlError as failure:
                            if failure.code != 409:
                                raise
                        return ready
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        ready = sum(pool.map(report, tunnels.values()))
                    save(folder / 'status.json', {'state': 'connected', 'count': len(tunnels), 'ready': ready, 'checkedAt': int(time.time() * 1000)})
                    delay = 2
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                    refresh = True
                    transient = isinstance(error, (OSError, ControlError)) and not (isinstance(error, ControlError) and error.code not in (429, 500, 502, 503, 504))
                    if not transient or time.monotonic() - authenticated >= 15:
                        for tunnel in tunnels.values():
                            tunnel.close()
                        tunnels.clear()
                    save(folder / 'status.json', {'state': 'offline', 'message': str(error) if isinstance(error, ValueError) else 'Preview connection unavailable; reconnecting automatically', 'checkedAt': int(time.time() * 1000)})
                    delay = min(delay * 2, 30) if not tunnels else 2
                time.sleep(delay)
        except KeyboardInterrupt:
            pass
        finally:
            for tunnel in tunnels.values():
                tunnel.close()


def label(folder):
    import hashlib
    return 'dev.cloudroom.preview.' + hashlib.sha256(str(folder).encode()).hexdigest()[:16]


def launch(folder, stop=False):
    if sys.platform != 'darwin':
        raise ValueError('Use run for foreground helpers outside macOS')
    name = label(folder)
    domain = f'gui/{os.getuid()}'
    path = Path.home() / 'Library/LaunchAgents' / (name + '.plist')
    if stop:
        subprocess.run(['launchctl', 'bootout', domain + '/' + name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['launchctl', 'print', domain + '/' + name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            if time.monotonic() >= deadline:
                raise OSError('Preview helper did not stop')
            time.sleep(.1)
        with (folder / 'lock').open('a') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OSError('Previous preview helper is still shutting down')
                    time.sleep(.1)
        path.unlink(missing_ok=True); return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as file:
        plistlib.dump({'Label': name, 'ProgramArguments': [sys.executable, '-B', '-E', '-s', str(folder / 'client.py'), 'run', str(folder)],
                      'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5, 'ProcessType': 'Background'}, file)
    subprocess.run(['launchctl', 'bootstrap', domain, str(path)], check=True, capture_output=True)


def configure(folder, connection_file, activate, allow_private):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True); folder.chmod(0o700)
    connection = private_json(connection_file)
    binding = [connection['url'].rstrip('/'), (connection.get('account') or {}).get('id')]
    old = private_json(folder / 'config.json') if (folder / 'config.json').exists() else None
    if old and old['binding'] != binding:
        raise ValueError('Preview setup belongs to another account/core; use a separate directory')
    source = Path(__file__).resolve()
    target = folder / 'client.py'
    allow_private = bool(allow_private if allow_private is not None else (old or {}).get('allowPrivateSsh', False))
    if (activate and old and old.get('connectionFile') == str(connection_file)
            and old.get('allowPrivateSsh', False) == allow_private
            and target.is_file() and target.read_bytes() == source.read_bytes()):
        active = subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/' + label(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if active.returncode == 0:
            return {'enabled': True}
    if activate:
        launch(folder, stop=True)
    if source != target:
        temporary = folder / 'client.pending'
        temporary.write_bytes(source.read_bytes()); temporary.chmod(0o600); temporary.replace(target)
    config = {'device': old['device'] if old else uuid.uuid4().hex, 'binding': binding, 'connectionFile': str(connection_file), 'allowPrivateSsh': allow_private}
    save(folder / 'config.json', config)
    identity(folder)
    if activate:
        launch(folder)
    return {'enabled': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['configure', 'run', 'status', 'stop', 'pause'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--connection', type=Path)
    parser.add_argument('--no-start', action='store_true')
    parser.add_argument('--allow-private-ssh', action='store_true', default=None, help='Explicitly allow a self-hosted private/loopback SSH address')
    args = parser.parse_args()
    folder = args.directory.expanduser().resolve()
    if args.command == 'configure':
        if args.connection is None:
            raise ValueError('--connection is required')
        print(json.dumps(configure(folder, args.connection.expanduser().resolve(strict=True), not args.no_start, args.allow_private_ssh)))
    elif args.command == 'run':
        run(folder)
    elif args.command in {'stop', 'pause'}:
        launch(folder, stop=True)
        if args.command == 'pause':
            save(folder / 'status.json', {'state': 'offline', 'checkedAt': int(time.time() * 1000)})
            print('{"paused":true}')
            return
        config = private_json(folder / 'config.json')
        if not config.get('revoked', False):
            Core(config).request('/device/' + config['device'], method='DELETE')
            config['revoked'] = True
            save(folder / 'config.json', config)
        save(folder / 'status.json', {'state': 'offline', 'checkedAt': int(time.time() * 1000)})
        print('{"stopped":true}')
    else:
        print(json.dumps(private_json(folder / 'status.json')))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, ValueError) else 'Preview setup failed; inspect private configuration, SSH access, and macOS background-job permissions', file=sys.stderr)
        sys.exit(1)
