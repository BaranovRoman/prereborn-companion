import base64, importlib.util, json, pathlib, re, tempfile, unittest, zipfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('package',pathlib.Path(__file__).parents[1]/'package.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PackageTests(unittest.TestCase):
    def test_api2_signed_ui_policy_is_part_of_the_manifest_not_lost_by_packaging(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();(ui/'index.html').write_text('installed UI')
            binary=root/'worker.exe';binary.write_bytes(b'unit executable')
            manifest=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())
            manifest.update(version='0.2.0',minApi=2,maxApi=2,author='Prereborn',uiCommands=['status','sound.summary','asset.import'],permissions=['ui','data.legacy','audio.play','backend.access','obs.scene','overlay.publish'],uiFrameOrigins=['http://127.0.0.1:3666'],obsBindings={'phase':{'legacyField':'phase_scene','defaultScene':'Package scene'}},backendResources={'account':{'path':'/stream/companion/account-settings','method':'GET','queryKeys':[],'maxRequest':0,'maxResponse':24576}})
            template=root/'manifest.json';template.write_text(json.dumps(manifest))
            # Serialization only; no signing secret or distributable is produced.
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,'0.2.0','windows','x86_64',root/'out',root/'key','https://github.com/example',template)
            for field in ['author','uiCommands','permissions','minApi','maxApi','backendResources','obsBindings','uiFrameOrigins']:
                self.assertEqual(release['manifest'][field],manifest[field])
            with zipfile.ZipFile(root/'out/dota2-0.2.0-windows-x86_64.zip') as archive:
                self.assertEqual(json.loads(archive.read('manifest.json')),release['manifest'])
    def test_signed_archive_reconstruction_is_exact_and_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'dota/ui/dist';ui.mkdir(parents=True);(ui/'index.html').write_text('test')
            binary=root/'target/release/companion-dota-plugin.exe';binary.parent.mkdir(parents=True);binary.write_bytes(b'unit fixture')
            version=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())['version']
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,version,'windows','x86_64',root/'original',root/'key','https://github.com/example',p.ROOT/'plugins/dota/manifest.windows-live.json')
            original=root/f'original/dota2-{version}-windows-x86_64.zip'
            with zipfile.ZipFile(original) as archive:
                self.assertTrue(all(i.date_time==(1980,1,1,0,0,0) for i in archive.infolist()))
                meta={'release':release,'manifest_bytes':base64.b64encode(archive.read('manifest.json')).decode(),'manifest_signature':archive.read('manifest.minisig').decode(),'catalog_bytes':base64.b64encode(p.encode({'schema':1,'releases':[release]})).decode(),'catalog_signature':'unit-test-placeholder'}
            metadata=root/'metadata.json';metadata.write_text(json.dumps(meta))
            rebuilt=p.assemble(root,metadata,root/'rebuilt');self.assertEqual(original.read_bytes(),rebuilt.read_bytes())
            binary.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'CI payload differs'):
                p.assemble(root,metadata,root/'damaged')
    def test_pubg_candidate_reconstructs_from_its_own_artifact_layout(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'pubg/ui/dist';(ui/'widget').mkdir(parents=True);(ui/'index.html').write_text('ui');(ui/'widget/index.html').write_text('widget');(ui/'icon.png').write_bytes(b'png')
            binary=root/'target/release/companion-pubg-plugin.exe';binary.parent.mkdir(parents=True);binary.write_bytes(b'pubg fixture')
            template=p.ROOT/'plugins/pubg/manifest.windows-live.json';version=json.loads(template.read_text())['version']
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,version,'windows','x86_64',root/'original',root/'key','https://github.com/example',template)
            self.assertEqual(release['manifest']['id'],'pubg')
            self.assertIn('ui/widget/index.html',release['manifest']['files'])
            original=root/f'original/pubg-{version}-windows-x86_64.zip'
            with zipfile.ZipFile(original) as archive:
                meta={'release':release,'manifest_bytes':base64.b64encode(archive.read('manifest.json')).decode(),'manifest_signature':archive.read('manifest.minisig').decode(),'catalog_bytes':base64.b64encode(p.encode({'schema':1,'releases':[release]})).decode(),'catalog_signature':'unit-test-placeholder'}
            metadata=root/'metadata.json';metadata.write_text(json.dumps(meta))
            rebuilt=p.assemble(root,metadata,root/'rebuilt');self.assertEqual(original.read_bytes(),rebuilt.read_bytes())
            meta['release']['manifest']['id']='other';meta['manifest_bytes']=base64.b64encode(p.encode(meta['release']['manifest'])).decode();metadata.write_text(json.dumps(meta))
            with self.assertRaisesRegex(ValueError,'Unexpected candidate identity'):
                p.assemble(root,metadata,root/'denied')
    def test_live_identity_protocol_and_file_hashes_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();(ui/'index.html').write_text('test');(ui/'icon.png').write_bytes(b'png')
            binary=root/'worker.exe';binary.write_bytes(b'executable fixture')
            manifest=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())
            cargo=re.search(r'^version = "([^"]+)"',(p.ROOT/'plugins/dota/Cargo.toml').read_text(),re.M).group(1)
            self.assertEqual(manifest['version'],cargo,'worker refuses a launch whose package version differs from its own')
            template=root/'manifest.json';template.write_text(json.dumps(manifest))
            # Unit serialization test only: NOT a signed distribution or trust-root override.
            with patch.object(p,'sign',return_value='unit-test-placeholder'):
                release=p.package(binary,ui,manifest['version'],'windows','x86_64',root/'out',root/'key','https://github.com/example',template)
            m=release['manifest']
            self.assertEqual((m['execution'],m['minApi'],m['maxApi']),('live',2,2))
            self.assertEqual(m['permissions'],['ui','data.legacy','audio.play','obs.scene','overlay.publish','backend.access','chat.read'])
            self.assertEqual(m['uiFrameOrigins'],['http://127.0.0.1:3666']);self.assertEqual(m['icon'],'ui/icon.png');self.assertIn('ui/icon.png',m['files'])
            # The existing 0.5.94 OBS config keys and defaults, never invented names.
            # Two OBS scenes; a draft is shown inside Between Matches.
            self.assertEqual({k:(v['legacyField'],v['defaultScene']) for k,v in m['obsBindings'].items()},{
                'betweenMatches':('between_matches_scene','Dota — Между матчами'),'gameplay':('gameplay_scene','Dota — Игра')})
            self.assertLessEqual(len(m['backendResources']),16);self.assertFalse(any(c.startswith('host.') for c in m['uiCommands']))
            with zipfile.ZipFile(root/f"out/dota2-{manifest['version']}-windows-x86_64.zip") as archive:
                for name,h in m['files'].items():
                    self.assertEqual(p.digest(archive.read(name)),h)
                self.assertNotIn('key',archive.namelist())
    def test_signed_policy_matches_what_the_package_actually_calls(self):
        manifest=json.loads((p.ROOT/'plugins/dota/manifest.windows-live.json').read_text())
        sources=[f for f in (p.ROOT/'plugins/dota/ui/src').rglob('*.ts*') if '.test.' not in f.name]
        text='\n'.join(f.read_text(encoding='utf-8') for f in sources)
        called=set(re.findall(r'(?:invoke|read|pages)(?:<[^>]*>)?\(\s*"([a-z0-9._]+)"',text))
        called|=set(re.findall(r'read<[^>]*>\("([a-z.]+)"',text))
        self.assertEqual(called,set(manifest['uiCommands']))
        worker=(p.ROOT/'plugins/dota/src/worker.rs').read_text(encoding='utf-8')
        used=set(re.findall(r'resource:"([a-z-]+)"',worker))|set(re.findall(r'\("([a-z-]+)",\d+\)',worker))|set(re.findall(r'"(sync-event|gsi-state|commands)"',worker))
        used|=set(re.findall(r'(?:readBackendResource|read|save)(?:<[^>]*>)?\("([a-z-]+)"',text))
        self.assertEqual(used,set(manifest['backendResources']))
    def test_signing_key_inside_ui_is_rejected_before_signing(self):
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);ui=root/'ui';ui.mkdir();binary=root/'worker';binary.write_bytes(b'x')
            with patch.object(p,'sign') as signer:
                with self.assertRaises(ValueError):
                    p.package(binary,ui,'0.1.0','windows','x86_64',root/'out',ui/'key','https://github.com/example')
                signer.assert_not_called()
if __name__=='__main__':unittest.main()
