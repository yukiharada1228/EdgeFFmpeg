#!/usr/bin/env python3
"""Offline, fail-closed build of the pinned libFLAC decoder reactor."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
PIN = json.loads((HERE / 'inputs.json').read_text())

def digest(data):
    return hashlib.sha256(data).hexdigest()

def verify_source(source, archive):
    if digest(archive.read_bytes()) != PIN['archiveSha256']:
        raise ValueError('Official archive SHA256 mismatch')
    members = {}
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or name.parts[0] != 'flac-1.5.0':
                raise ValueError('Unsafe archive path: ' + member.name)
            relative = Path(*name.parts[1:])
            target = source / relative
            if member.isdir():
                if not target.is_dir() or target.is_symlink():
                    raise ValueError('Source directory mismatch: ' + str(relative))
                continue
            if str(relative) in members:
                raise ValueError('Duplicate archive member')
            if member.issym():
                link = PurePosixPath(member.linkname)
                if link.is_absolute() or '..' in link.parts:
                    raise ValueError('Unsafe archive symlink')
                if not target.is_symlink() or os.readlink(target) != member.linkname:
                    raise ValueError('Source symlink mismatch')
                members[str(relative)] = 'symlink:' + member.linkname
            elif member.isfile() or member.islnk():
                if member.islnk():
                    link = PurePosixPath(member.linkname)
                    if link.is_absolute() or '..' in link.parts or link.parts[0] != 'flac-1.5.0':
                        raise ValueError('Unsafe archive hardlink')
                expected = digest(tar.extractfile(member).read())
                if not target.is_file() or target.is_symlink() or digest(target.read_bytes()) != expected:
                    raise ValueError('Source content mismatch: ' + str(relative))
                members[str(relative)] = expected
            else:
                raise ValueError('Unsupported archive member')
    actual = {str(p.relative_to(source)) for p in source.rglob('*') if p.is_file() or p.is_symlink()}
    if actual != set(members):
        raise ValueError('Unexpected/missing source files')
    return members

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'archive', 'emsdk', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    source, archive, emsdk, out = (getattr(args, n).resolve() for n in ('source', 'archive', 'emsdk', 'out'))
    if out.exists():
        raise ValueError('Refusing existing output')
    for name, expected in PIN['files'].items():
        path = HERE / name
        if digest(path.read_bytes()) != expected:
            raise ValueError('Build input changed: ' + name)
    members = verify_source(source, archive)
    git = lambda *a: subprocess.check_output(['git', '-C', str(emsdk), *a], text=True).strip()
    if Path(git('rev-parse', '--show-toplevel')).resolve() != emsdk or git('rev-parse', 'HEAD') != PIN['emsdkCommit']:
        raise ValueError('Not the pinned real emsdk checkout')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Modified emsdk checkout')
    if (emsdk / 'upstream/emscripten/emscripten-version.txt').read_text().strip() != '"7.0.0"':
        raise ValueError('Expected Emscripten 7.0.0')
    out.mkdir(parents=True, exist_ok=False)
    # Seed an isolated cache from the installed offline SDK; never mutate it.
    shutil.copytree(emsdk / 'upstream/emscripten/cache', out / 'cache', symlinks=False)
    (out / 'source-verification.json').write_text(json.dumps(members, indent=2) + '\n')
    subprocess.run(['bash', str(HERE / 'recipe.sh'), str(source), str(out), str(emsdk)], check=True)
    wasm = (out / 'edge-flac.wasm').read_bytes()
    metadata = {**PIN, 'actualSha256': digest(wasm), 'actualBytes': len(wasm), 'verifiedFiles': len(members), 'sourceIdentity': 'official archive bytes, not ancestor git HEAD'}
    (out / 'build-metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    if digest(wasm) != PIN['wasmSha256'] or len(wasm) != PIN['wasmBytes']:
        raise ValueError('Deterministic output mismatch; inspect build-metadata.json')

if __name__ == '__main__':
    main()
