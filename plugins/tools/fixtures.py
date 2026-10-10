"""Regenerate signed installer fixtures with the local test signing key (never executes them)."""
import importlib.util, pathlib, tempfile, json, zipfile
spec = importlib.util.spec_from_file_location('pack', pathlib.Path(__file__).with_name('package.py'))
pack = importlib.util.module_from_spec(spec); spec.loader.exec_module(pack)
root = pack.ROOT; output = root/'plugins/manager/tests/fixtures'; key = root/'plugins/.signing/test.key'
with tempfile.TemporaryDirectory() as directory:
    work = pathlib.Path(directory); binary = work/'hello'; binary.write_bytes(b'fixture executable: never run')
    ui = work/'ui'; ui.mkdir(); (ui/'index.html').write_text('<h1>Hello</h1>'); (ui/'main.js').write_text('console.log("Hello")')
    for version in ['0.1.0', '0.2.0']:
        release = pack.package(binary, ui, version, 'macos', 'aarch64', output, key, 'https://github.com/BaranovRoman/prereborn-companion/releases/download/test')
        if version != '0.1.0': continue
        good = output/'hello-0.1.0-macos-aarch64.zip'
        damaged = output/'damaged.zip'; damaged.write_bytes(good.read_bytes()[:40])
        damaged.with_suffix('.json').write_bytes(pack.encode(dict(release, sha256=pack.digest(damaged.read_bytes()), signature=pack.sign(damaged,key))))
        for name, change in [('traversal', '../escape'), ('symlink', 'ui/main.js'), ('duplicate', 'UI/main.js'), ('oversized', 'ui/main.js')]:
            archive = output/(name+'.zip')
            with zipfile.ZipFile(good) as source, zipfile.ZipFile(archive,'w') as target:
                for info in source.infolist():
                    if info.filename == 'ui/main.js':
                        info.filename = change
                        if name == 'symlink': info.create_system=3; info.external_attr=(0o120777<<16)
                    data = source.read('ui/main.js' if info.filename==change else info.filename)
                    if name == 'oversized' and info.filename == 'ui/main.js':
                        data = b'x' * (32*1024*1024+1); info.compress_type = zipfile.ZIP_DEFLATED
                    target.writestr(info,data)
            meta = dict(release, sha256=pack.digest(archive.read_bytes()), signature=pack.sign(archive,key))
            archive.with_suffix('.json').write_bytes(pack.encode(meta))
    (output/'catalog.json').write_bytes(pack.encode(dict(schema=1,releases=[release])))
    (output/'catalog.minisig').write_text(pack.sign(output/'catalog.json',key))
