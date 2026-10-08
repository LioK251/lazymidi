import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';

const data=JSON.parse(execFileSync('cargo',['metadata','--locked','--offline','--format-version','1'],{encoding:'utf8',maxBuffer:16*1024*1024}));
mkdirSync('docs/licenses',{recursive:true});
const manifest={};const cache=new Map();
for(const p of data.packages.filter(p=>p.source)) {
  const root=dirname(p.manifest_path);
  if(readdirSync(root).some(name=>/^(licen[sc]e|copying|notice|unlicense)/i.test(name)) || (p.license_file&&existsSync(join(root,p.license_file)))) continue;
  const repo=p.repository?.match(/github\.com\/([^/]+\/[^/#]+)/)?.[1]?.replace(/\.git$/,'');
  if(!repo){console.error('Non-GitHub missing license:',p.name);continue;}
  const vcsFile=join(root,'.cargo_vcs_info.json');const vcs=existsSync(vcsFile)?JSON.parse(readFileSync(vcsFile,'utf8')):{};
  const revision=vcs.git?.sha1;if(!revision){console.error('Missing revision:',p.name);continue;}
  const cacheKey=`${repo}@${revision}`;
  let files=cache.get(cacheKey);
  if(!files){
    files=[];
    for(const filename of ['LICENSE','LICENSE-MIT','LICENSE-APACHE','LICENSE.txt','LICENSE.md','COPYING','COPYING.txt']) {
      const url=`https://raw.githubusercontent.com/${repo}/${revision}/${filename}`;
      const response=await fetch(url);if(!response.ok)continue;
      const text=await response.text();
      const path=`docs/licenses/${repo.replaceAll('/','-')}-${revision.slice(0,8)}-${filename.replaceAll('.','-')}.txt`;
      writeFileSync(path,text);files.push({path,url});
    }
    cache.set(cacheKey,files);
  }
  if(files.length) manifest[`${p.name}@${p.version}`]={license:p.license,revision,files};else console.error('No pinned license:',p.name,repo,revision);
}
writeFileSync('docs/license-sources.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`Recorded ${Object.keys(manifest).length} pinned upstream license sources.`);
