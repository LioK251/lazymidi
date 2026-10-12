document.getElementById('pair').addEventListener('submit',async event=>{
  event.preventDefault();const status=document.getElementById('status');
  const base=document.getElementById('endpoint').value.trim();const code=document.getElementById('code').value.trim().toUpperCase();
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)){status.textContent='Use the loopback endpoint displayed in lazymidi.';return;}
  try{const response=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(!response.ok)throw new Error('Invalid or expired pairing code.');const result=await response.json();await chrome.storage.session.set({serverUrl:base,token:result.token});status.textContent='Paired. Supported media pages will show a converter button.';}catch(error){status.textContent=error.message;}
});

let timer;
let closed=false;
window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);});
(async()=>{
  const stored=await chrome.storage.session.get(['serverUrl','token']);
  document.getElementById('endpoint').value=stored.serverUrl||'';
  if(stored.token)document.getElementById('status').textContent='Paired for this browser session.';
})();
async function progress(){
  const job=document.getElementById('job');
  try{
    const stored=await chrome.storage.session.get(['lastJobId','jobError']);
    if(stored.jobError){job.textContent=stored.jobError;await chrome.action.setBadgeText({text:''});return;}
    if(stored.lastJobId){
      const result=await chrome.runtime.sendMessage({action:'convertStatus',taskId:stored.lastJobId});
      if(!result?.success)throw new Error(result?.error||'Could not check conversion.');
      const data=result.data;
      job.textContent=data.error||data.progress||data.midi_name||data.status;
      if(['completed','error','cancelled'].includes(data.status)){await chrome.action.setBadgeText({text:''});return;}
    }
  }catch(error){job.textContent=error.message;}
  if(!closed)timer=setTimeout(progress,2000);
}
void progress();
