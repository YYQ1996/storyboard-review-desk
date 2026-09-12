#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import tarfile
import urllib.request
import zipfile


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest().upper()


def assert_child(path: Path, parent: Path) -> None:
    path.resolve().relative_to(parent.resolve())


def download(url: str, destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 0:
        return
    print(f'下载：{url}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(f'{destination}.part')
    temporary.unlink(missing_ok=True)
    destination.unlink(missing_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
        shutil.copyfileobj(response, output)
    temporary.replace(destination)


def copy_runtime(package_root: Path, cache_root: Path, version: str, arch: str, expected_hashes: dict[str, str]) -> None:
    archive_name = f'node-v{version}-darwin-{arch}.tar.gz'
    archive = cache_root / archive_name
    download(f'https://nodejs.org/dist/v{version}/{archive_name}', archive)
    actual_hash = sha256(archive)
    if actual_hash != expected_hashes.get(archive_name, '').upper():
        raise RuntimeError(f'Node.js 运行环境校验失败：{archive_name}')

    target_dir = package_root / 'runtime' / f'darwin-{arch}'
    (target_dir / 'bin').mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:gz') as source:
        prefix = f'node-v{version}-darwin-{arch}'
        node_member = source.getmember(f'{prefix}/bin/node')
        license_member = source.getmember(f'{prefix}/LICENSE')
        with source.extractfile(node_member) as node_source, (target_dir / 'bin' / 'node').open('wb') as node_target:
            shutil.copyfileobj(node_source, node_target)
        with source.extractfile(license_member) as license_source, (target_dir / 'NODE-LICENSE.txt').open('wb') as license_target:
            shutil.copyfileobj(license_source, license_target)
    os.chmod(target_dir / 'bin' / 'node', 0o755)


def make_zip(package_root: Path, zip_path: Path) -> None:
    executable_names = {'一键安装.command', '一键启动.command'}
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in sorted(package_root.rglob('*')):
            if not source.is_file():
                continue
            relative = source.relative_to(package_root.parent).as_posix()
            info = zipfile.ZipInfo.from_file(source, relative)
            info.create_system = 3
            executable = source.name in executable_names or source.name == 'node'
            mode = 0o755 if executable else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_package(package_root: Path, zip_path: Path) -> None:
    expected_cpu = {'darwin-arm64': 0x0100000C, 'darwin-x64': 0x01000007}
    for runtime, cpu_type in expected_cpu.items():
        node = package_root / 'runtime' / runtime / 'bin' / 'node'
        header = node.read_bytes()[:8]
        if header[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack('<I', header[4:8])[0] != cpu_type:
            raise RuntimeError(f'{runtime} Node.js 架构校验失败')

    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        if any('/data/' in f'/{name}/' for name in names):
            raise RuntimeError('macOS 包中不能包含用户 data 目录')
        for suffix in ('一键安装.command', '一键启动.command', 'runtime/darwin-arm64/bin/node', 'runtime/darwin-x64/bin/node'):
            entry = next((item for item in archive.infolist() if item.filename.endswith(suffix)), None)
            if entry is None or not ((entry.external_attr >> 16) & 0o111):
                raise RuntimeError(f'ZIP 中缺少可执行权限：{suffix}')
        forbidden = str(package_root.parent.parent.parent).encode('utf8')
        if any(forbidden in archive.read(item) for item in archive.infolist() if item.file_size < 5 * 1024 * 1024):
            raise RuntimeError('macOS 包包含开发机绝对路径')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--node-version', default='24.21.0')
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    release_root = project_root / 'release'
    staging_root = release_root / '.staging-macos'
    cache_root = release_root / 'cache'
    version = json.loads((project_root / 'package.json').read_text(encoding='utf8'))['version']
    package_name = f'分镜审核台-v{version}-macOS-universal'
    package_root = staging_root / package_name
    zip_path = release_root / f'{package_name}.zip'
    assert_child(staging_root, release_root)

    if staging_root.exists():
        shutil.rmtree(staging_root)
    package_root.mkdir(parents=True)

    for relative in (
        'app', 'server', 'plugin', 'node_modules', 'scripts/install.mjs', 'docs',
        'package.json', 'README.md', '一键安装.command', '一键启动.command',
    ):
        source = project_root / relative
        target = package_root / relative
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    shutil.copy2(project_root / 'docs' / '安装与使用-macOS.md', package_root / '使用说明.md')

    checksums_file = cache_root / f'node-v{args.node_version}-SHASUMS256.txt'
    download(f'https://nodejs.org/dist/v{args.node_version}/SHASUMS256.txt', checksums_file)
    expected_hashes = {
        parts[1]: parts[0]
        for line in checksums_file.read_text(encoding='utf8').splitlines()
        if len(parts := line.split()) == 2
    }
    for arch in ('arm64', 'x64'):
        copy_runtime(package_root, cache_root, args.node_version, arch, expected_hashes)

    for command in ('一键安装.command', '一键启动.command'):
        path = package_root / command
        path.write_text(path.read_text(encoding='utf8').replace('\r\n', '\n'), encoding='utf8', newline='\n')
        os.chmod(path, 0o755)

    if zip_path.exists():
        zip_path.unlink()
    make_zip(package_root, zip_path)
    verify_package(package_root, zip_path)
    package_hash = sha256(zip_path)
    hash_path = Path(f'{zip_path}.sha256.txt')
    hash_path.write_text(f'{package_hash}  {zip_path.name}\n', encoding='utf8', newline='\n')
    print(f'macOS 发布包已生成：{zip_path}')
    print(f'SHA256：{package_hash}')


if __name__ == '__main__':
    main()
