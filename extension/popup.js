const connectionStatus = document.getElementById('status');
const jobError = document.getElementById('job-error');
const jobList = document.getElementById('jobs');
const rows = new Map();
let timer;
let closed = false;
window.addEventListener('pagehide', () => { closed = true; clearTimeout(timer); });

function jobRow({id, title}) {
  if (rows.has(id)) return rows.get(id);
  const item = document.createElement('li');
  const details = document.createElement('div');
  const label = document.createElement('strong');
  const status = document.createElement('p');
  const cancel = document.createElement('button');
  label.textContent = title;
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', `Cancel ${title}`);
  cancel.hidden = true;
  const row = {item, status, cancel};
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({action:'convertStop', taskId:id});
      if (!result?.success) throw new Error(result?.error || 'Could not cancel conversion.');
      status.textContent = 'Cancelled';
      cancel.hidden = true;
    } catch (error) {
      jobError.textContent = error.message;
      cancel.disabled = false;
    }
  });
  details.append(label, status);
  item.append(details, cancel);
  jobList.append(item);
  rows.set(id, row);
  return row;
}

async function updateJob(job, connected) {
  const {status, cancel} = jobRow(job);
  if (!connected) {
    status.textContent = 'Waiting for lazymidi…';
    cancel.hidden = true;
    return false;
  }
  try {
    const result = await chrome.runtime.sendMessage({action:'convertStatus', taskId:job.id});
    if (!result?.success) throw new Error(result?.error || 'Could not check conversion.');
    const data = result.data;
    const active = data.status === 'queued' || data.status === 'processing';
    if (active && cancel.disabled) return true;
    status.textContent = data.status === 'queued' ? 'Queued' : data.error || data.progress || data.midi_name || 'Added to Library';
    cancel.hidden = !active;
    cancel.disabled = false;
    return active;
  } catch (error) {
    status.textContent = error.message;
    cancel.hidden = true;
    return false;
  }
}

async function progress() {
  try {
    const connection = await chrome.runtime.sendMessage({action:'ping'});
    const connected = !!connection?.alive;
    connectionStatus.textContent = connected ? 'Connected to lazymidi.' : 'Open lazymidi with Converter enabled and a compatible Python environment selected.';
    const stored = await chrome.storage.session.get(['conversionJobs', 'lastJobId', 'jobError']);
    const jobs = stored.conversionJobs ?? (stored.lastJobId ? [{id:stored.lastJobId, title:'Conversion'}] : []);
    jobError.textContent = stored.jobError || '';
    const ids = new Set(jobs.map(job => job.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) { row.item.remove(); rows.delete(id); }
    }
    const active = await Promise.all(jobs.map(job => updateJob(job, connected)));
    if (connected || stored.jobError) await chrome.action.setBadgeText({text:active.some(Boolean) ? '…' : ''});
  } catch (error) {
    jobError.textContent = error.message;
  }
  if (!closed) timer = setTimeout(progress, 2000);
}
void progress();
