#!/usr/bin/env python3
"""Independent localhost previews and Mac access. Standard-library control client; OpenSSH (VMs) or HTTPS tunnels (sandboxes)."""
import argparse
import base64
import concurrent.futures
import contextlib
import fcntl
import http.client
import hashlib
import http.server
import io
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import pwd
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


OPENER = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def control(url, body, method, headers):
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers={**headers, 'Content-Type': 'application/json'})
    try:
        with OPENER.open(request, timeout=5) as response:
            raw = response.read(256 * 1024 + 1)
            if len(raw) > 256 * 1024:
                raise ValueError('Preview response is too large')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        error.close()
        raise ControlError(error.code) from None


def website(connection):
    base = connection.get('websiteUrl', 'https://www.cloudroom.dev').rstrip('/')
    url = urllib.parse.urlsplit(base)
    if base != 'https://www.cloudroom.dev' and not (url.scheme == 'http' and url.hostname == '127.0.0.1' and url.port and not url.path and not url.query and not url.fragment and not url.username):
        raise ValueError('Invalid managed preview service')
    return base


class Core:
    """The paired VM's core, or, with `url` and `token`, one awake cloud sandbox's core."""
    def __init__(self, config, url=None, token=None):
        connection = private_json(config['connectionFile'])
        self.connection = connection
        self.sandbox = url is not None
        self.url = (url or connection['url']).rstrip('/')
        parts = urllib.parse.urlsplit(self.url)
        if (parts.scheme != 'https' and not (parts.scheme == 'http' and parts.hostname in {'localhost', '127.0.0.1', '::1'})) or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('Use an authenticated HTTPS core connection')
        if not self.sandbox and config['binding'] != [self.url, (connection.get('account') or {}).get('id')]:
            raise ValueError('Preview connection belongs to another account or VM')
        token = token if self.sandbox else connection.get('token', '')
        gate = None if self.sandbox else connection.get('gateToken')
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('Sign in to Cloudroom again')
        if gate is not None and (not gate or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-' for c in gate)):
            raise ValueError('Invalid hosting credential')
        # Some sandbox proxies replace Authorization with their own login, so Core also reads X-Cloudroom-Token.
        self.headers = {'Authorization': 'Bearer ' + token, 'X-Cloudroom-Token': token, **({'Cookie': '_port_auth=' + gate} if gate else {})}
        self.opener = OPENER
        # A sandbox gets a new token on every wake, so its tunnels and streams are rebuilt.
        self.key = (self.url, token)

    def prepare(self):
        account = (self.connection.get('account') or {}).get('id')
        if not account:
            return
        uuid.UUID(account)
        credential = base64.b64encode((account + ':' + self.connection['token']).encode()).decode()
        return self.fetch(website(self.connection) + '/api/desktop/previews', {}, None, {'Authorization': 'Basic ' + credential})

    def request(self, path, body=None, method=None):
        return self.fetch(self.url + '/v1/previews' + path, body, method, self.headers)

    def fetch(self, url, body, method, headers):
        return control(url, body, method, headers)


AWAKE = {'at': 0.0, 'key': None, 'list': [], 'lock': threading.Lock()}


def cores(config):
    """The paired VM's core, if any, then every awake cloud sandbox's core (docs/scopes/sandboxes.md)."""
    connection = private_json(config['connectionFile'])
    found = [Core(config)] if connection.get('url') else []
    account, token = (connection.get('account') or {}).get('id'), connection.get('sandboxToken')
    if not account or not token:
        return found
    with AWAKE['lock']:
        if AWAKE['key'] != (account, token) or time.monotonic() - AWAKE['at'] > 10:
            AWAKE.update(at=time.monotonic(), key=(account, token))
            try:
                uuid.UUID(account)
                credential = base64.b64encode((account + ':' + token).encode()).decode()
                listed = control(website(connection) + '/api/desktop/sandboxes', {'action': 'awake'}, 'POST', {'Authorization': 'Basic ' + credential})
                AWAKE['list'] = [(entry['origin'], entry['token']) for entry in listed['sandboxes']]
            except (OSError, ValueError, KeyError, TypeError):
                pass  # Keep the last list; sandboxes are asked again shortly.
        awake = list(AWAKE['list'])
    for origin, secret in awake:
        with contextlib.suppress(ValueError):
            found.append(Core(config, origin, secret))
    return found


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


class Relay:
    """Sandbox previews (no SSH): each local connection becomes an HTTPS upgrade to the sandbox core, which
    joins it to the agent's port. It mimics the SSH process interface the tunnel code expects."""
    def __init__(self, core, port, device, path):
        self.core, self.port, self.device, self.stopped = core, port, device, False
        self.stderr = io.BytesIO()
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path)); os.chmod(path, 0o600); self.listener.listen(32)
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while not self.stopped:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.pipe, args=(client,), daemon=True).start()

    def open(self):
        url = urllib.parse.urlsplit(self.core.url)
        remote = socket.create_connection((url.hostname, url.port or (443 if url.scheme == 'https' else 80)), timeout=10)
        if url.scheme == 'https':
            remote = ssl.create_default_context().wrap_socket(remote, server_hostname=url.hostname)
        headers = ''.join(f'{key}: {value}\r\n' for key, value in self.core.headers.items())
        remote.sendall(f'GET /v1/previews/{self.port}/tunnel?device={self.device} HTTP/1.1\r\nHost: {url.netloc}\r\n'
                       f'Connection: Upgrade\r\nUpgrade: cloudroom-tunnel\r\n{headers}\r\n'.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = remote.recv(4096)
            if not chunk or len(head) > 16384:
                raise OSError('Preview tunnel closed')
            head += chunk
        status, rest = head.split(b'\r\n', 1)[0].split(), head.split(b'\r\n\r\n', 1)[1]
        if len(status) < 2 or status[1] != b'101':
            raise OSError('Preview tunnel refused')
        remote.settimeout(None)
        return remote, rest

    def pipe(self, client):
        try:
            remote, rest = self.open()
        except OSError:
            client.close(); return
        def copy(source, target):
            with contextlib.suppress(OSError):
                while data := source.recv(65536):
                    target.sendall(data)
            with contextlib.suppress(OSError):
                target.shutdown(socket.SHUT_WR)
        with contextlib.suppress(OSError):
            if rest:
                client.sendall(rest)
        back = threading.Thread(target=copy, args=(remote, client), daemon=True)
        back.start(); copy(client, remote); back.join()
        client.close(); remote.close()

    def poll(self):
        return 0 if self.stopped else None

    def terminate(self):
        self.stopped = True
        with contextlib.suppress(OSError):
            self.listener.close()
    kill = terminate

    def wait(self, timeout=None):
        return 0


class Tunnel:
    def __init__(self, folder, core, port, generation, device, metadata, allow_private, local_port):
        self.closed = False
        self.connections = set()
        self.connections_lock = threading.Lock()
        self.endpoint, self.core = metadata, core
        self.port, self.generation = port, generation
        self.relay = bool(metadata.get('tunnel'))
        suffix = hashlib.sha256(core.url.encode()).hexdigest()[:8] if core.sandbox else ''
        self.socket_path = folder / f'p{port}{suffix}.sock'
        self.socket_path.unlink(missing_ok=True)
        self.log_path = folder / f'ssh-{port}{suffix}.log'
        self.stderr = bytearray()
        if self.relay:
            self.process = Relay(core, port, device, self.socket_path)
        else:
            self.process = self.ssh(folder, port, metadata, allow_private)
        self.listen(port, device, local_port)

    def ssh(self, folder, port, metadata, allow_private):
        address = ipaddress.ip_address(metadata['host'])
        if not address.is_global and not allow_private:
            raise ValueError('Private SSH addresses require explicit self-hosted setup')
        if metadata.get('user') != 'cloudroom-preview' or type(metadata.get('port')) is not int or not 1 <= metadata['port'] <= 65535:
            raise ValueError('Invalid preview SSH endpoint')
        key = metadata.get('host_key', '')
        if len(key) != 80 or not key.startswith('ssh-ed25519 ') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=' for c in key[12:]):
            raise ValueError('Invalid SSH host identity')
        known = folder / 'known_hosts'
        known.write_text('cloudroom-preview ' + key + '\n'); known.chmod(0o600)
        command = ['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-i', str(folder / 'id_ed25519'),
                   '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'HostKeyAlias=cloudroom-preview', '-o', 'UserKnownHostsFile=' + str(known),
                   '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=5',
                   '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
                   '-L', f'{self.socket_path}:127.0.0.1:{port}', '-p', str(metadata['port']), f'cloudroom-preview@{address}']
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def listen(self, port, device, local_port):
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


MAC_LIMIT = 16 * 1024 * 1024
# Hex characters per result request: some sandbox proxies drop requests over about 8 MB.
MAC_PART = 4 * 1024 * 1024


def deliver(post, result):
    """Large output travels in parts, then `done` carries the rest. A core without parts (HTTP 422) gets it whole."""
    if len(result['stdout']) + len(result['stderr']) > MAC_PART:
        try:
            for name in ('stdout', 'stderr'):
                for offset in range(0, len(result[name]), MAC_PART):
                    post({'state': 'part', 'offset': offset, name: result[name][offset:offset + MAC_PART]})
            result = {**result, 'stdout': '', 'stderr': ''}
        except ControlError as error:
            if error.code != 422:
                raise
    post(result)


class MacJobs:
    """Mac access (ADR 0113): run commands from the user's cloud agents as this user, only while enabled."""
    def __init__(self, folder):
        self.folder, self.running, self.lock = folder, {}, threading.Lock()

    def enabled(self):
        config = private_json(self.folder / 'config.json')
        return config if config.get('macAccess') and not config.get('revoked') else None

    def serve(self):
        """One job stream per reachable core: the VM's, and each awake sandbox's while it stays awake."""
        self.wanted, streams = set(), {}
        while True:
            with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
                config = self.enabled()
                listed = {core.key: core for core in cores(config)} if config else {}
                self.wanted = set(listed)
                for key, core in listed.items():
                    if key not in streams or not streams[key].is_alive():
                        streams[key] = threading.Thread(target=self.follow, args=(core, config['device']), daemon=True)
                        streams[key].start()
            time.sleep(5)

    def follow(self, core, device):
        delay = 2
        while core.key in self.wanted:
            try:
                request = urllib.request.Request(core.url + '/v1/mac/jobs?device=' + device,
                                                 headers={**core.headers, 'Accept': 'text/event-stream'})
                with core.opener.open(request, timeout=60) as stream:
                    delay, event = 2, None
                    for raw in stream:
                        line = raw.decode().rstrip('\r\n')
                        if line.startswith('event:'):
                            event = line[6:].strip()
                        elif line.startswith('data:') and event == 'job':
                            threading.Thread(target=self.execute, args=(core, device, json.loads(line[5:])), daemon=True).start()
                        elif line.startswith('data:') and event == 'cancel':
                            self.cancel(json.loads(line[5:])['id'])
                        elif line.startswith(':') and (not self.enabled() or core.key not in self.wanted):
                            break
            except (OSError, ValueError, KeyError, TypeError):
                delay = min(delay * 2, 30)
            time.sleep(delay)

    def execute(self, core, device, job):
        def post(body):
            core.fetch(core.url + '/v1/mac/results/' + urllib.parse.quote(job['id']), {'device': device, **body}, None, core.headers)
        with contextlib.suppress(OSError, ValueError):
            post({'state': 'running'})
        result = {'state': 'done', 'code': 127, 'stdout': '', 'stderr': '', 'truncated': False}
        try:
            folder = Path.home() / os.path.expanduser(job.get('cwd') or '~')
            process = subprocess.Popen([pwd.getpwuid(os.getuid()).pw_shell or '/bin/zsh', '-lc', job['command']], cwd=folder,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as error:
            result['stderr'] = str(error).encode().hex()
        else:
            with self.lock:
                self.running[job['id']] = process
            output = {'stdout': bytearray(), 'stderr': bytearray()}
            def read(name):
                for chunk in iter(lambda: getattr(process, name).read1(65536), b''):
                    if len(output[name]) <= MAC_LIMIT:
                        output[name] += chunk
            def feed():
                with contextlib.suppress(OSError):
                    process.stdin.write(bytes.fromhex(job.get('stdin') or ''))
                    process.stdin.close()
            readers = [threading.Thread(target=read, args=(name,), daemon=True) for name in output]
            for thread in [*readers, threading.Thread(target=feed, daemon=True)]:
                thread.start()
            result['code'] = process.wait()
            for thread in readers:
                thread.join(2)  # A background process may keep the pipe open.
            with self.lock:
                self.running.pop(job['id'], None)
            result['truncated'] = any(len(value) > MAC_LIMIT for value in output.values())
            result.update({name: bytes(value[:MAC_LIMIT]).hex() for name, value in output.items()})
        # The result survives disconnects: retry until the VM accepts it, forgets the job, or an hour passes.
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            try:
                deliver(post, result)
                return
            except ControlError as error:
                if error.code in (403, 404, 409, 413):
                    return
            except (OSError, ValueError):
                pass
            time.sleep(5)

    def cancel(self, job):
        with self.lock:
            process = self.running.get(job)
        if process:
            def kill(signal_number):
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(process.pid, signal_number)
            kill(signal.SIGTERM)
            threading.Timer(2, kill, (signal.SIGKILL,)).start()


def run(folder):
    tunnels = {}
    ports_file = folder / 'ports.json'
    ports = private_json(ports_file) if ports_file.exists() else {}
    prepare_due, refresh, authenticated, delay = 0, True, 0, 2
    denied, credential = None, None
    def stop(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    threading.Thread(target=MacJobs(folder).serve, daemon=True).start()
    with (folder / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            while True:
                try:
                    config = private_json(folder / 'config.json')
                    listed = cores(config)
                    vm = next((core for core in listed if not core.sandbox), None)
                    if vm and credential != vm.headers:
                        credential, prepare_due, refresh, denied = vm.headers, 0, True, None
                    if config.pop('revoked', False):
                        save(folder / 'config.json', config)
                    if vm and refresh and time.monotonic() >= prepare_due:
                        prepare_due = time.monotonic() + 60
                        try:
                            vm.prepare()
                            refresh, denied = False, None
                        except (OSError, ValueError) as error:
                            if isinstance(error, ControlError) and error.code in (401, 403):
                                denied = error
                    if denied:
                        raise denied
                    desired = {}
                    # Sandboxes first, so a VM that turns this Mac away can't block their Mac access.
                    for core in sorted(listed, key=lambda core: not core.sandbox):
                        try:
                            metadata = core.request('/device', {'device': config['device'], 'public_key': identity(folder)})
                            for entry in core.request('')['previews']:
                                port = entry['port']
                                if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(entry['generation'], str):
                                    raise ValueError('Invalid preview registration')
                                desired[(core.key, port)] = (core, entry['generation'], metadata)
                        except (OSError, ValueError):
                            if not core.sandbox:
                                raise  # A sandbox may fall asleep at any moment; the others keep working.
                    authenticated = time.monotonic()
                    failed = {key for key, tunnel in tunnels.items() if tunnel.process.poll() is not None}
                    refresh = refresh or bool(failed)
                    for key, tunnel in list(tunnels.items()):
                        wanted = desired.get(key)
                        if not wanted or wanted[1] != tunnel.generation or key in failed or tunnel.endpoint != wanted[2]:
                            tunnel.close(); del tunnels[key]
                    for key, (core, generation, metadata) in desired.items():
                        if key in tunnels:
                            continue
                        port = key[1]
                        name = f'{urllib.parse.urlsplit(core.url).hostname}:{port}' if core.sandbox else str(port)
                        local_port = ports.get(name, port)
                        if type(local_port) is not int or not 1024 <= local_port <= 65535:
                            local_port = port
                        try:
                            tunnels[key] = Tunnel(folder, core, port, generation, config['device'], metadata, config.get('allowPrivateSsh', False), local_port)
                        except OSError:
                            with contextlib.suppress(OSError, ValueError):
                                core.request('/report', {'device': config['device'], 'port': port, 'generation': generation,
                                                         'local_port': None, 'error': 'Local preview port unavailable'})
                            continue
                        ports[name] = tunnels[key].server.server_port
                        save(ports_file, ports)
                    def report(tunnel):
                        ready = tunnel.healthy()
                        error = None
                        if not ready:
                            if tunnel.process.poll() is not None:
                                error = 'Tunnel unavailable' if tunnel.relay else 'SSH connection unavailable'
                            elif tunnel.socket_path.exists():
                                error = 'Cloud HTTP server unavailable'
                        try:
                            tunnel.core.request('/report', {'device': config['device'], 'port': tunnel.port, 'generation': tunnel.generation,
                                                            'local_port': tunnel.server.server_port if ready else None, 'error': error})
                        except ControlError as failure:
                            if failure.code != 409 and not tunnel.core.sandbox:
                                raise
                        except (OSError, ValueError):
                            if not tunnel.core.sandbox:
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


def systemd(folder, label, stop):
    unit = label + '.service'
    path = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'systemd/user' / unit
    def systemctl(*args):
        subprocess.run(['systemctl', '--user', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if stop:
        if path.exists():
            systemctl('disable', '--now', unit)
            path.unlink()
            systemctl('daemon-reload')
        return
    quote = lambda value: '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    command = ' '.join(quote(part) for part in [sys.executable, '-B', '-E', '-s', folder / 'client.py', 'run', folder])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'[Service]\nExecStart={command}\nEnvironment={quote("PATH=" + os.environ.get("PATH", os.defpath))}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n')
    systemctl('daemon-reload')
    systemctl('enable', '--now', unit)


def launch(folder, stop=False):
    if sys.platform.startswith('linux'):
        return systemd(folder, label(folder), stop)
    if sys.platform != 'darwin':
        raise ValueError('Use run for foreground helpers outside macOS and Linux')
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


def configure(folder, connection_file, activate, allow_private, mac_access=None):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True); folder.chmod(0o700)
    connection = private_json(connection_file)
    # Sandbox-only accounts have no VM address; their cores come from the website while awake.
    binding = [(connection.get('url') or 'sandboxes').rstrip('/'), (connection.get('account') or {}).get('id')]
    old = private_json(folder / 'config.json') if (folder / 'config.json').exists() else None
    if old and old['binding'] != binding:
        raise ValueError('Preview setup belongs to another account/core; use a separate directory')
    source = Path(__file__).resolve()
    target = folder / 'client.py'
    allow_private = bool(allow_private if allow_private is not None else (old or {}).get('allowPrivateSsh', False))
    mac_access = bool(mac_access if mac_access is not None else (old or {}).get('macAccess', False))
    if (activate and old and old.get('connectionFile') == str(connection_file)
            and old.get('allowPrivateSsh', False) == allow_private and old.get('macAccess', False) == mac_access
            and target.is_file() and target.read_bytes() == source.read_bytes()):
        check = ['systemctl', '--user', 'is-active', '--quiet', label(folder) + '.service'] if sys.platform.startswith('linux') else ['launchctl', 'print', f'gui/{os.getuid()}/' + label(folder)]
        active = subprocess.run(check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if active.returncode == 0:
            return {'enabled': True}
    if activate:
        launch(folder, stop=True)
    if source != target:
        temporary = folder / 'client.pending'
        temporary.write_bytes(source.read_bytes()); temporary.chmod(0o600); temporary.replace(target)
    config = {'device': old['device'] if old else uuid.uuid4().hex, 'binding': binding, 'connectionFile': str(connection_file),
              'allowPrivateSsh': allow_private, 'macAccess': mac_access}
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
    parser.add_argument('--mac-access', choices=['on', 'off'], help='Let cloud agents run commands on this Mac (ADR 0113)')
    args = parser.parse_args()
    folder = args.directory.expanduser().resolve()
    if args.command == 'configure':
        if args.connection is None:
            raise ValueError('--connection is required')
        print(json.dumps(configure(folder, args.connection.expanduser().resolve(strict=True), not args.no_start, args.allow_private_ssh,
                                   None if args.mac_access is None else args.mac_access == 'on')))
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
            for core in cores(config):
                if core.sandbox:
                    with contextlib.suppress(OSError, ValueError):
                        core.request('/device/' + config['device'], method='DELETE')
                else:
                    core.request('/device/' + config['device'], method='DELETE')
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
