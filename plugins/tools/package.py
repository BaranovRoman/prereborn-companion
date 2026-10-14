#!/usr/bin/env python3
"""Independent official plugin packaging. No build, download or publication side effects."""
import argparse, sys, base64, hashlib, json, os, pathlib, re, subprocess, tempfile, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[2]

def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()

def sign(path, key):
    env = dict(os.environ)
    for name in ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']:
        env.pop(name, None)
    env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = os.environ.get('PLUGIN_KEY_PASSWORD', '')
    subprocess.run(['pnpm.cmd' if sys.platform == 'win32' else 'pnpm', '--filter', '@prereborn/companion', 'exec', 'tauri', 'signer', 'sign',
                    '-f', str(pathlib.Path(key).resolve()), str(path.resolve())],
                   cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    result = pathlib.Path(str(path) + '.sig')
    text = base64.b64decode(result.read_text().strip()).decode()
    result.unlink()
    return text

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write_archive(path, files):
    # Reconstruct exactly the signed archive in Windows CI without sending a private key.
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)

def assemble(input_root, metadata, output):
    """Public signed metadata + exact CI bytes only; signing and launching are impossible here."""
    root = pathlib.Path(input_root).resolve(); meta = json.loads(pathlib.Path(metadata).read_text())
    manifest_bytes = base64.b64decode(meta['manifest_bytes'], validate=True)
    manifest = json.loads(manifest_bytes); release = meta['release']
    if manifest != release['manifest'] or manifest['id'] != 'dota2' or manifest['platform'] != 'windows' or manifest['arch'] != 'x86_64' or manifest['executable'] != 'bin/companion-dota-plugin.exe':
        raise ValueError('Unexpected candidate identity')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', manifest['version']):
        raise ValueError('Invalid candidate version')
    files = {}
    for name, expected in manifest['files'].items():
        parts = pathlib.PurePosixPath(name).parts
        if '\\' in name or ':' in name or name.startswith('/') or any(part in ('..', '.') for part in parts):
            raise ValueError('Unsafe payload path')
        if name == manifest['executable']:
            path = root / 'target/release/companion-dota-plugin.exe'
        elif name.startswith('ui/'):
            path = root / 'dota/ui/dist' / name[3:]
        else:
            raise ValueError('Unexpected payload path')
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Payload outside candidate')
        data = path.read_bytes()
        if digest(data) != expected:
            raise ValueError('CI payload differs from signed manifest')
        files[name] = data
    files['manifest.json'] = manifest_bytes; files['manifest.minisig'] = meta['manifest_signature'].encode()
    output = pathlib.Path(output); output.mkdir(parents=True, exist_ok=True)
    archive = output / f"dota2-{manifest['version']}-windows-x86_64.zip"
    write_archive(archive, files)
    if digest(archive.read_bytes()) != release['sha256']:
        archive.unlink(); raise ValueError('Reconstructed archive differs from signed candidate')
    archive.with_suffix('.release.json').write_bytes(encode(release))
    (output / 'catalog.json').write_bytes(base64.b64decode(meta['catalog_bytes'], validate=True))
    (output / 'catalog.minisig').write_text(meta['catalog_signature'])
    return archive

def package(binary, ui, version, platform, arch, output, key, url, manifest_template=None):
    output = pathlib.Path(output); output.mkdir(parents=True, exist_ok=True)
    binary = pathlib.Path(binary); ui = pathlib.Path(ui)
    if binary.is_symlink() or binary.resolve() == pathlib.Path(key).resolve() or pathlib.Path(key).resolve().is_relative_to(ui.resolve()):
        raise ValueError('Signing key / symlink must not enter package input')
    if output.resolve().is_relative_to(ui.resolve()):
        raise ValueError('Package output must be outside UI input')
    files = {'bin/' + binary.name: binary.read_bytes()}
    for path in sorted(ui.rglob('*')):
        if path.is_symlink():
            raise ValueError('UI symlinks are forbidden')
        if path.is_file():
            files['ui/' + path.relative_to(ui).as_posix()] = path.read_bytes()
    manifest = dict(schema=1, id='hello', name='Hello World', description='Официальный тестовый плагин Companion.',
                    version=version, platform=platform, arch=arch, minApi=1, maxApi=1,
                    executable='bin/' + binary.name, ui='ui/index.html', permissions=['ui'],
                    files={name: digest(data) for name, data in files.items()})
    if manifest_template:
        template = json.loads(pathlib.Path(manifest_template).read_text())
        if template['version'] != version:
            raise ValueError('Template version must match executable/CLI version')
        for field in ['schema', 'id', 'name', 'description', 'permissions', 'minApi', 'maxApi']:
            manifest[field] = template[field]
        if 'execution' in template:
            manifest['execution'] = template['execution']
    if not re.fullmatch(r'[a-z0-9-]{1,64}', manifest['id']) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?',version):
        raise ValueError('Unsafe package identity/version')
    with tempfile.TemporaryDirectory() as directory:
        source = pathlib.Path(directory) / 'manifest.json'; source.write_bytes(encode(manifest))
        files['manifest.json'] = source.read_bytes(); files['manifest.minisig'] = sign(source, key).encode()
    archive = output / f"{manifest['id']}-{version}-{platform}-{arch}.zip"
    write_archive(archive, files)
    release = dict(manifest=manifest, url=url.rstrip('/') + '/' + archive.name,
                   sha256=digest(archive.read_bytes()), signature=sign(archive, key))
    metadata = archive.with_suffix('.release.json'); metadata.write_bytes(encode(release))
    print(metadata)
    return release

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    pack = commands.add_parser('package')
    for arg in ['binary', 'ui', 'version', 'platform', 'arch', 'output', 'key', 'url']:
        pack.add_argument('--' + arg, required=True)
    pack.add_argument('--manifest-template')
    reconstruct = commands.add_parser('assemble')
    for arg in ['input-root', 'metadata', 'output']:
        reconstruct.add_argument('--' + arg, required=True)
    catalog = commands.add_parser('catalog')
    catalog.add_argument('--release', action='append', required=True)
    catalog.add_argument('--output', required=True); catalog.add_argument('--key', required=True)
    args = vars(parser.parse_args()); command = args.pop('command')
    if command == 'package':
        package(**args)
    elif command == 'assemble':
        assemble(**args)
    else:
        output = pathlib.Path(args['output']); output.parent.mkdir(parents=True, exist_ok=True)
        releases = [json.loads(pathlib.Path(path).read_text()) for path in args['release']]
        output.write_bytes(encode(dict(schema=1, releases=releases)))
        output.with_suffix('.minisig').write_text(sign(output, args['key']))
        print(output)
if __name__ == '__main__':
    main()
