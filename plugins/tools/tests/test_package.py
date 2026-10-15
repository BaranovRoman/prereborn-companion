import base64, importlib.util, json, pathlib, tempfile, unittest, zipfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('package',pathlib.Path(__file__).parents[1]/'package.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PackageTests(unittest.TestCase):
    def test_api2_signed_ui_policy_is_part_of_the_manifest_not_lost_by_packaging(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();(ui/'index.html').write_text('installed UI')
            binary=root/'worker.exe';binary.write_bytes(b'unit executable')
            manifest=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())
            manifest.update(version='0.2.0',minApi=2,maxApi=2,author='Prereborn',uiCommands=['status','sound.summary','asset.import'],permissions=['ui','data.legacy','audio.play'])
            template=root/'manifest.json';template.write_text(json.dumps(manifest))
            # Serialization only; no signing secret or distributable is produced.
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,'0.2.0','windows','x86_64',root/'out',root/'key','https://github.com/example',template)
            for field in ['author','uiCommands','permissions','minApi','maxApi']:
                self.assertEqual(release['manifest'][field],manifest[field])
            with zipfile.ZipFile(root/'out/dota2-0.2.0-windows-x86_64.zip') as archive:
                self.assertEqual(json.loads(archive.read('manifest.json')),release['manifest'])
    def test_signed_archive_reconstruction_is_exact_and_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'dota/ui/dist';ui.mkdir(parents=True);(ui/'index.html').write_text('test')
            binary=root/'target/release/companion-dota-plugin.exe';binary.parent.mkdir(parents=True);binary.write_bytes(b'unit fixture')
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,'0.1.0','windows','x86_64',root/'original',root/'key','https://github.com/example',p.ROOT/'plugins/dota/manifest.windows-live.json')
            original=root/'original/dota2-0.1.0-windows-x86_64.zip'
            with zipfile.ZipFile(original) as archive:
                self.assertTrue(all(i.date_time==(1980,1,1,0,0,0) for i in archive.infolist()))
                meta={'release':release,'manifest_bytes':base64.b64encode(archive.read('manifest.json')).decode(),'manifest_signature':archive.read('manifest.minisig').decode(),'catalog_bytes':base64.b64encode(p.encode({'schema':1,'releases':[release]})).decode(),'catalog_signature':'unit-test-placeholder'}
            metadata=root/'metadata.json';metadata.write_text(json.dumps(meta))
            rebuilt=p.assemble(root,metadata,root/'rebuilt');self.assertEqual(original.read_bytes(),rebuilt.read_bytes())
            binary.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'CI payload differs'):
                p.assemble(root,metadata,root/'damaged')
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
