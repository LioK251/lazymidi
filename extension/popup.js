document.getElementById('pair').addEventListener('submit',async event=>{
  event.preventDefault();const status=document.getElementById('status');
  const base=document.getElementById('endpoint').value.trim();const code=document.getElementById('code').value.trim().toUpperCase();
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)){status.textContent='Use the loopback endpoint displayed in lazymidi.';return;}
  try{const response=await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(!response.ok)throw new Error('Invalid or expired pairing code.');const result=await response.json();await chrome.storage.session.set({serverUrl:base,token:result.token});status.textContent='Paired. Supported media pages will show a converter button.';}catch(error){status.textContent=error.message;}
});
