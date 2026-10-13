// Test-only disposable signer: private key stays in memory, only temporary packages are written.
const fs=require('fs'),crypto=require('crypto'),cp=require('child_process'),path=require('path');
const [root,binary,platform,arch]=process.argv.slice(2);
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const keyId=crypto.randomBytes(8),pub=publicKey.export({format:'der',type:'spki'}).subarray(-32);
const sign=bytes=>{const sig=crypto.sign(null,crypto.createHash('blake2b512').update(bytes).digest(),privateKey),comment='temporary iteration 14 fixture';
return 'untrusted comment: disposable fixture\n'+Buffer.concat([Buffer.from('ED'),keyId,sig]).toString('base64')+'\ntrusted comment: '+comment+'\n'+crypto.sign(null,Buffer.concat([sig,Buffer.from(comment)]),privateKey).toString('base64')+'\n';};
const executable=fs.readFileSync(binary),html=Buffer.from('<p>isolated fixture</p>');
const manifest={schema:1,id:'dota2',name:'Temporary IPC fixture',description:'Never published',version:'0.1.0',platform,arch,minApi:1,maxApi:1,executable:'bin/dota',ui:'ui/index.html',permissions:['ui','dota.match.execute','dota.sound.play','dota.obs.scene','dota.overlay.update'],files:{'bin/dota':crypto.createHash('sha256').update(executable).digest('hex'),'ui/index.html':crypto.createHash('sha256').update(html).digest('hex')},execution:'live'};
fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(root,'manifest.minisig'),sign(Buffer.from(JSON.stringify(manifest))));
fs.writeFileSync(path.join(root,'index.html'),html);
cp.execFileSync('python3',['-c',`import zipfile,sys,os
root,binary=sys.argv[1:]
with zipfile.ZipFile(os.path.join(root,'fixture.zip'),'w',zipfile.ZIP_DEFLATED) as z:
 for source,name in [(binary,'bin/dota'),(os.path.join(root,'index.html'),'ui/index.html'),(os.path.join(root,'manifest.json'),'manifest.json'),(os.path.join(root,'manifest.minisig'),'manifest.minisig')]: z.write(source,name)
`,root,binary]);
const zip=fs.readFileSync(path.join(root,'fixture.zip'));
fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({manifest,url:'https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/test/never-published.zip',sha256:crypto.createHash('sha256').update(zip).digest('hex'),signature:sign(zip)}));
fs.writeFileSync(path.join(root,'fixture.pub'),'untrusted comment: temporary fixture\n'+Buffer.concat([Buffer.from('Ed'),keyId,pub]).toString('base64')+'\n');
