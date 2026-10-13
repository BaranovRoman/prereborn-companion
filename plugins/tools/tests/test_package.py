import importlib.util, json, pathlib, tempfile, unittest, zipfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('package',pathlib.Path(__file__).parents[1]/'package.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PackageTests(unittest.TestCase):
    def test_live_identity_protocol_and_file_hashes_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();(ui/'index.html').write_text('test')
            binary=root/'worker.exe';binary.write_bytes(b'executable fixture')
            manifest=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())
            template=root/'manifest.json';template.write_text(json.dumps(manifest))
            # Unit serialization test only: NOT a signed distribution or trust-root override.
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,'0.1.0','windows','x86_64',root/'out',root/'key','https://github.com/example',template)
            self.assertEqual(release['manifest']['execution'],'live')
            self.assertEqual((release['manifest']['minApi'],release['manifest']['maxApi']),(1,1))
            with zipfile.ZipFile(root/'out/dota2-0.1.0-windows-x86_64.zip') as archive:
                for name,h in release['manifest']['files'].items():
                    self.assertEqual(p.digest(archive.read(name)),h)
                self.assertNotIn('key',archive.namelist())
    def test_signing_key_inside_ui_is_rejected_before_signing(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();binary=root/'worker';binary.write_bytes(b'x')
            with patch.object(p,'sign') as signer:
                with self.assertRaises(ValueError):
                    p.package(binary,ui,'0.1.0','windows','x86_64',root/'out',ui/'key','https://github.com/example')
                signer.assert_not_called()
if __name__=='__main__':unittest.main()
