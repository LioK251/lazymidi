import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Include the checked-in registry license texts, rather than just SPDX labels.
const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--offline','--format-version','1'],{encoding:'utf8',maxBuffer:16*1024*1024}));
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
let html='<!doctype html><meta charset="utf-8"><title>lazymidi dependency notices</title><style>body{font:14px system-ui;max-width:1000px;margin:40px auto}pre{white-space:pre-wrap;border:1px solid #ccc;padding:16px}h2{margin-top:48px}</style><h1>lazymidi Rust dependency notices</h1><p>Generated from Cargo.lock; includes cross-platform and build dependencies. Licenses apply to the relevant upstream components.</p>';
let missing=[];
const fallbackFile='docs/license-sources.json';
const fallback=existsSync(fallbackFile)?JSON.parse(readFileSync(fallbackFile,'utf8')):{};
for(const p of metadata.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name))) {
  const root=dirname(p.manifest_path);
  const files=readdirSync(root,{withFileTypes:true}).filter(e=>e.isFile()&&/^(licen[sc]e|copying|notice|unlicense)/i.test(e.name)).map(e=>join(root,e.name));
  for(const directory of ['license','licenses','LICENSES']) if(existsSync(join(root,directory)) && readdirSync(root,{withFileTypes:true}).some(e=>e.name===directory&&e.isDirectory())) for(const entry of readdirSync(join(root,directory),{withFileTypes:true})) if(entry.isFile()) files.push(join(root,directory,entry.name));
  if(p.license_file && existsSync(join(root,p.license_file)) && !files.includes(join(root,p.license_file))) files.push(join(root,p.license_file));
  for(const file of fallback[`${p.name}@${p.version}`]?.files??[]) if(existsSync(file.path)) files.push(file.path);
  html+=`<h2>${escape(p.name)} ${escape(p.version)}</h2><p>${escape(p.license??'See license text')} · ${escape(p.repository??p.source)}</p>`;
  if(!files.length) missing.push(`${p.name} ${p.version}: ${p.license}`);
  for(const file of files) html+=`<h3>${escape(file.startsWith(root)?file.slice(root.length+1):file)}</h3><pre>${escape(readFileSync(file,'utf8'))}</pre>`;
}
if(missing.length) {console.error('Missing published license texts:\n'+missing.join('\n')); process.exitCode=1;}
writeFileSync('THIRD_PARTY_DEPENDENCIES.html',html);
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
let frontend='lazymidi production frontend dependency notices\n';
for(const [path,p] of Object.entries(lock.packages).filter(([path,p])=>path&&!p.dev)) {
  frontend+=`\n${path.replace(/^node_modules\//,'')} ${p.version} · ${p.license??''}\n`;
  const licenses=readdirSync(path).filter(name=>/^(licen[sc]e|copying|notice)/i.test(name));
  if(!licenses.length) throw new Error(`No frontend license text for ${path}`);
  for(const file of licenses) frontend+=readFileSync(join(path,file),'utf8')+'\n';
}
writeFileSync('THIRD_PARTY_FRONTEND_NOTICES.txt',frontend);
console.log(`Collected notices for ${metadata.packages.filter(p=>p.source).length} Rust dependencies and production npm dependencies.`);
