"""Shared, dependency-free file operations for the core and its local sync client."""
import contextlib
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import uuid
import unicodedata
try:
    import tomllib
except ImportError:
    tomllib = None

# Never replicate live Git databases, caches, or our own recovery state.
EXCLUDED = {'.git', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.pnpm-store', 'target', '.DS_Store', '.cloudroom-imported'}
PENDING = '.cloudroom-sync-pending'
CHUNK = 64 * 1024
MAX_FILE_BYTES = 4 * 1024**3
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
PORTABLE = {
    'pi': {'defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'hideThinkingBlock', 'quietStartup'},
    'claude': {'model', 'effortLevel', 'language'},
    'codex': {'model', 'model_reasoning_effort', 'model_verbosity', 'personality'},
}


class Conflict(Exception):
    pass


def excluded(path):
    return any(part in EXCLUDED or part.startswith('.cloudroom-sync-') for part in path.split('/'))


def atomic_json(path, value):
    path = Path(path)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.sync-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        with directory(path.parent) as parent:
            os.fsync(parent)
    finally:
        Path(name).unlink(missing_ok=True)


@contextlib.contextmanager
def directory(path, create=False):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('absolute root required')
    fd = os.open('/', DIRECTORY)
    try:
        for part in path.parts[1:]:
            if part in {'.', '..'}:
                raise ValueError('invalid root')
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def safe_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('invalid relative path')
    parts = value.split('/')
    if any(p in {'', '.', '..'} or p in EXCLUDED or p.startswith('.cloudroom-sync-') for p in parts):
        raise ValueError('excluded or invalid relative path')
    return parts


def transfer(data, kind, executable, output=None, limit=MAX_FILE_BYTES):
    digest = hashlib.sha256((kind + str(executable)).encode())
    size = 0
    while chunk := data.read(CHUNK):
        size += len(chunk)
        if size > limit:
            raise Conflict('source exceeds the transfer size')
        digest.update(chunk)
        if output is not None:
            output.write(chunk)
    return {'tag': digest.hexdigest(), 'kind': kind, 'executable': executable, 'size': size}


def swap(fd, first, second):
    # Exchange preserves the displaced inode, including writes through an already-open fd.
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, 'renameatx_np' if sys.platform == 'darwin' else 'renameat2')
    if function(fd, os.fsencode(first), fd, os.fsencode(second), 2) != 0:
        raise OSError(ctypes.get_errno(), 'atomic exchange failed')


class Tree:
    def __init__(self, root, kind='skills', filename=None, create=False):
        self.root, self.kind, self.filename = Path(root), kind, filename
        self.create = create

    @contextlib.contextmanager
    def parent(self, relative, create=False):
        parts = safe_path(relative)
        if excluded(relative):
            raise ValueError('file is excluded from sync')
        if self.filename and relative != self.filename:
            raise ValueError('file is outside the selected settings')
        with directory(self.root, self.create) as root:
            fd = os.dup(root)
            try:
                for part in parts[:-1]:
                    if create:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                    child = os.open(part, DIRECTORY, dir_fd=fd)
                    os.close(fd)
                    fd = child
                yield fd, parts[-1]
            finally:
                os.close(fd)

    def projected(self, data):
        if self.kind == 'auth':
            if not isinstance(json.loads(data), dict):
                raise ValueError('invalid credential file')
            return data
        if self.kind not in PORTABLE:
            return data
        if self.kind == 'codex' and tomllib is None:
            raise ValueError('Codex settings require Python 3.11+')
        value = tomllib.loads(data.decode()) if self.kind == 'codex' else json.loads(data)
        if not isinstance(value, dict):
            raise ValueError('invalid settings')
        return json.dumps({k: v for k, v in value.items() if k in PORTABLE[self.kind]}, sort_keys=True, separators=(',', ':')).encode()

    def merged(self, incoming, original):
        if self.kind not in PORTABLE:
            return self.projected(incoming)
        values = json.loads(incoming)
        if not isinstance(values, dict) or values.keys() - PORTABLE[self.kind]:
            raise ValueError('unsupported settings')
        if any(not isinstance(v, (str, bool, int)) for v in values.values()):
            raise ValueError('unsupported setting value')
        if self.kind == 'codex':
            tomllib.loads(original.decode())
            lines, in_table = [], False
            for line in original.decode().splitlines():
                in_table = in_table or bool(re.match(r'^\s*\[', line))
                key = re.match(r'^\s*([a-z_]+)\s*=', line)
                if in_table or not key or key[1] not in PORTABLE['codex']:
                    lines.append(line)
            prefix = [f'{k} = {json.dumps(v)}' for k, v in sorted(values.items())]
            return ('\n'.join(prefix + lines) + '\n').encode()
        values_before = json.loads(original or b'{}')
        for key in PORTABLE[self.kind]:
            values_before.pop(key, None)
        values_before.update(values)
        return (json.dumps(values_before, indent=2) + '\n').encode()

    def inspect(self, fd, name, relative, output=None, project=True):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_size > MAX_FILE_BYTES:
            raise ValueError('file exceeds the project transfer limit')
        if stat.S_ISLNK(info.st_mode):
            if self.filename:
                raise ValueError('settings file must not be a symlink')
            target = os.readlink(name, dir_fd=fd)
            self.check_link(relative, target)
            return transfer(io.BytesIO(target.encode()), 'symlink', False, output)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('unsupported file type')
        with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), 'rb') as data:
            before = self.signature(os.fstat(data.fileno()))
            source = io.BytesIO(self.projected(data.read())) if project and (self.kind in PORTABLE or self.kind == 'auth') else data
            entry = transfer(source, 'file', bool(info.st_mode & 0o111) and not self.filename, output)
            if before != self.signature(os.fstat(data.fileno())):
                raise Conflict('file changed during scan')
            return entry

    @contextlib.contextmanager
    def snapshot(self, relative):
        with self.parent(relative) as (fd, name), tempfile.TemporaryFile() as output:
            entry = self.inspect(fd, name, relative, output)
            output.seek(0)
            yield entry, output

    @staticmethod
    def signature(info):
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode]

    def check_link(self, relative, target):
        if not target or Path(target).is_absolute():
            raise ValueError('external symlink')
        # Lexical validation plus no-follow parent opens prevent traversal through other links.
        resolved = os.path.normpath(str(PurePosixPath(relative).parent / target))
        safe_path(resolved)

    def settle(self):
        # Only this version's pending area is collected. Existing recovery archives stay intact.
        if not (self.root / PENDING).exists():
            return
        with directory(self.root / PENDING) as fd:
            for name in os.listdir(fd):
                if not re.fullmatch('[a-f0-9]{32}\\.json', name):
                    continue
                with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)) as source:
                    saved = json.load(source)
                safe_path(saved['path'])
                backup = name[:-5]
                try:
                    entry = self.inspect(fd, backup, saved['path'], project=False)
                except FileNotFoundError:
                    entry = None
                if entry is not None:
                    if entry['tag'] != saved['fingerprint']:
                        raise Conflict('concurrent edit preserved in pending recovery')
                    os.unlink(backup, dir_fd=fd)
                os.unlink(name, dir_fd=fd)
            os.fsync(fd)

    def scan(self, cache=None):
        self.settle()
        files, folded, cache, skipped = {}, {}, cache or {}, []
        def visit(fd, prefix=''):
            for name in sorted(os.listdir(fd)):
                path = prefix + name
                if excluded(path):
                    continue
                if self.filename and path != self.filename:
                    continue
                key = unicodedata.normalize('NFC', path).casefold()
                if key in folded and folded[key] != path:
                    raise Conflict('case-colliding filenames')
                folded[key] = path
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not self.filename and stat.S_ISLNK(info.st_mode):
                    try:
                        self.check_link(path, os.readlink(name, dir_fd=fd))
                    except ValueError:
                        skipped.append(path)
                        continue
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                    skipped.append(path)
                    continue
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, DIRECTORY, dir_fd=fd)
                    try:
                        visit(child, path + '/')
                    finally:
                        os.close(child)
                else:
                    signature = self.signature(info)
                    saved = cache.get(path)
                    if saved and saved.get('signature') == signature:
                        files[path] = saved
                    else:
                        files[path] = {**self.inspect(fd, name, path), 'signature': signature}
        with directory(self.root, self.create) as fd:
            visit(fd)
        if self.kind in PORTABLE:
            empty = hashlib.sha256(b'fileFalse{}').hexdigest()
            files = {p: e for p, e in files.items() if e['tag'] != empty}
        return {'files': files, 'skipped': skipped}

    def logical_tag(self, entry):
        if self.kind in PORTABLE and entry['tag'] == hashlib.sha256(b'fileFalse{}').hexdigest():
            return None
        return entry['tag']

    def tag(self, relative):
        try:
            with self.parent(relative) as (fd, name):
                return self.logical_tag(self.inspect(fd, name, relative))
        except FileNotFoundError:
            return None

    def apply(self, relative, expected, entry, stream):
        safe_path(relative)
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected)):
            raise ValueError('invalid baseline')
        if entry is not None:
            if (entry.get('kind') not in {'file', 'symlink'} or type(entry.get('executable')) is not bool
                    or type(entry.get('size')) is not int or not 0 <= entry['size'] <= MAX_FILE_BYTES
                    or not isinstance(entry.get('tag'), str) or not re.fullmatch('[a-f0-9]{64}', entry['tag'])):
                raise ValueError('invalid file metadata')
        if entry is None and self.kind in PORTABLE:
            if expected is None:
                return
            entry = {'kind': 'file', 'executable': False, 'size': 2, 'tag': hashlib.sha256(b'fileFalse{}').hexdigest()}
            stream = io.BytesIO(b'{}')
        with self.parent(relative, create=entry is not None) as (fd, name):
            if any(other != name and unicodedata.normalize('NFC', other).casefold() == unicodedata.normalize('NFC', name).casefold() for other in os.listdir(fd)):
                raise Conflict('case-colliding filenames')
            temporary = '.cloudroom-sync-' + uuid.uuid4().hex
            backup = uuid.uuid4().hex
            with directory(self.root / PENDING, create=True) as recovery:
                if self.tag(relative) != expected:
                    raise Conflict('destination changed')
                try:
                    os.stat(name, dir_fd=fd, follow_symlinks=False)
                    exists = True
                except FileNotFoundError:
                    exists = False
                if exists:
                    info = os.open(backup + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=recovery)
                    with os.fdopen(info, 'w') as metadata:
                        json.dump({'path': relative, 'fingerprint': self.inspect(fd, name, relative, project=False)['tag']}, metadata)
                        metadata.flush(); os.fsync(metadata.fileno())
                if entry is None:
                    if expected is None:
                        return
                    os.rename(name, backup, src_dir_fd=fd, dst_dir_fd=recovery)
                    os.fsync(fd); os.fsync(recovery)
                    if self.logical_tag(self.inspect(recovery, backup, relative)) != expected:
                        raise Conflict('concurrent edit preserved in recovery')
                    return
                original_signature = None
                try:
                    if entry['kind'] == 'symlink':
                        if entry['size'] > os.pathconf(self.root, 'PC_PATH_MAX'):
                            raise ValueError('symlink is too long')
                        target = stream.read(entry['size'] + 1).decode()
                        if len(target.encode()) != entry['size']:
                            raise Conflict('incomplete symlink')
                        self.check_link(relative, target)
                        os.symlink(target, temporary, dir_fd=fd)
                    elif entry['kind'] == 'file':
                        output_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                        with os.fdopen(output_fd, 'wb') as output:
                            if self.kind in PORTABLE or self.kind == 'auth':
                                try:
                                    original_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                                    with os.fdopen(original_fd, 'rb') as original:
                                        original_signature = self.signature(os.fstat(original.fileno()))
                                        previous = original.read()
                                except FileNotFoundError:
                                    previous = b''
                                if entry['size'] > 16 * 1024 * 1024:
                                    raise ValueError('settings exceed the existing API JSON limit')
                                incoming = stream.read(entry['size'] + 1)
                                if len(incoming) != entry['size']:
                                    raise Conflict('incomplete settings')
                                output.write(self.merged(incoming, previous))
                            else:
                                received = transfer(stream, 'file', entry['executable'], output, entry['size'])
                                if received['size'] != entry['size'] or received['tag'] != entry['tag']:
                                    raise Conflict('incomplete or changed transfer')
                            output.flush(); os.fsync(output.fileno())
                            os.fchmod(output.fileno(), 0o600 if self.filename else 0o755 if entry['executable'] else 0o644)
                    else:
                        raise ValueError('unsupported entry')
                    if (self.filename or entry['kind'] == 'symlink') and self.inspect(fd, temporary, relative)['tag'] != entry['tag']:
                        raise Conflict('incomplete or changed transfer')
                    if (self.tag(relative) != expected or (original_signature is not None
                            and self.signature(os.stat(name, dir_fd=fd, follow_symlinks=False)) != original_signature)):
                        raise Conflict('destination changed during transfer')
                    if not exists:
                        os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                    else:
                        swap(fd, temporary, name)
                        os.rename(temporary, backup, src_dir_fd=fd, dst_dir_fd=recovery)
                        os.fsync(recovery)
                        if self.logical_tag(self.inspect(recovery, backup, relative)) != expected:
                            raise Conflict('concurrent edit preserved in recovery')
                    os.fsync(fd)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=fd)
                    except FileNotFoundError:
                        pass


def worker():
    request = json.loads(sys.stdin.buffer.readline())
    tree = Tree(**request['tree'])
    op = request['op']
    if op == 'mkdir':
        with directory(tree.root, create=True):
            pass
        result = {}
    elif op == 'scan':
        result = tree.scan(request.get('cache'))
    elif op == 'read':
        with tree.snapshot(request['path']) as (entry, data):
            if entry['tag'] != request['expected']:
                raise Conflict('source changed')
            print(json.dumps({'ok': True, **entry}), flush=True)
            shutil.copyfileobj(data, sys.stdout.buffer, CHUNK)
        return
    elif op == 'apply':
        tree.apply(request['path'], request['expected'], request.get('entry'), sys.stdin.buffer)
        result = {}
    else:
        raise ValueError('unknown operation')
    print(json.dumps({'ok': True, **result}), flush=True)


if __name__ == '__main__':
    try:
        worker()
    except Conflict:
        print(json.dumps({'ok': False, 'error': 'conflict'}), flush=True)
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({'ok': False, 'error': 'files_unavailable'}), flush=True)
