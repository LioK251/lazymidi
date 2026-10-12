let timer;
let closed=false;
window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);});
async function progress(){
  const status=document.getElementById('status');const job=document.getElementById('job');
  try{
    const connection=await chrome.runtime.sendMessage({action:'ping'});
    status.textContent=connection?.alive?'Connected to lazymidi.':'Open lazymidi with Converter enabled and a compatible Python environment selected.';
    const stored=await chrome.storage.session.get(['lastJobId','jobError']);
    if(stored.jobError){job.textContent=stored.jobError;await chrome.action.setBadgeText({text:''});}
    else if(stored.lastJobId&&connection?.alive){
      const result=await chrome.runtime.sendMessage({action:'convertStatus',taskId:stored.lastJobId});
      if(!result?.success)throw new Error(result?.error||'Could not check conversion.');
      const data=result.data;
      job.textContent=data.error||data.progress||data.midi_name||data.status;
      if(['completed','error','cancelled'].includes(data.status))await chrome.action.setBadgeText({text:''});
    }
  }catch(error){job.textContent=error.message;}
  if(!closed)timer=setTimeout(progress,2000);
}
void progress();
