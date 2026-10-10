#!/usr/bin/env python3
"""Independent official plugin packaging. No build, download or publication side effects."""
import argparse, base64, hashlib, json, os, pathlib, subprocess, tempfile, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[2]

def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()

def sign(path, key):
    env = dict(os.environ)
    for name in ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']:
        env.pop(name, None)
    env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = os.environ.get('PLUGIN_KEY_PASSWORD', '')
    subprocess.run(['pnpm', '--filter', '@prereborn/companion', 'exec', 'tauri', 'signer', 'sign',
                    '-f', str(pathlib.Path(key).resolve()), str(path.resolve())],
                   cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
    result = pathlib.Path(str(path) + '.sig')
    text = base64.b64decode(result.read_text().strip()).decode()
    result.unlink()
    return text

def digest(data):
    return hashlib.sha256(data).hexdigest()

def package(binary, ui, version, platform, arch, output, key, url):
    output = pathlib.Path(output); output.mkdir(parents=True, exist_ok=True)
    binary = pathlib.Path(binary); ui = pathlib.Path(ui)
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
    with tempfile.TemporaryDirectory() as directory:
        source = pathlib.Path(directory) / 'manifest.json'; source.write_bytes(encode(manifest))
        files['manifest.json'] = source.read_bytes(); files['manifest.minisig'] = sign(source, key).encode()
    archive = output / f'hello-{version}-{platform}-{arch}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zip:
        for name, data in sorted(files.items()):
            zip.writestr(name, data)
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
    catalog = commands.add_parser('catalog')
    catalog.add_argument('--release', action='append', required=True)
    catalog.add_argument('--output', required=True); catalog.add_argument('--key', required=True)
    args = vars(parser.parse_args()); command = args.pop('command')
    if command == 'package':
        package(**args)
    else:
        output = pathlib.Path(args['output']); output.parent.mkdir(parents=True, exist_ok=True)
        releases = [json.loads(pathlib.Path(path).read_text()) for path in args['release']]
        output.write_bytes(encode(dict(schema=1, releases=releases)))
        output.with_suffix('.minisig').write_text(sign(output, args['key']))
        print(output)
if __name__ == '__main__':
    main()
