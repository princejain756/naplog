(() => {
  const input = document.getElementById('log-input');
  const countEl = document.getElementById('line-count');
  const digestBtn = document.getElementById('digest');
  const statusEl = document.getElementById('status');
  const incidentsEl = document.getElementById('incidents');
  const loadSampleBtn = document.getElementById('load-sample');
  const badgeEl = document.getElementById('model-badge');
  const MAX_LINES = 120;

  function nonBlank(text) {
    return text.split('\n').filter((line) => line.trim().length > 0).length;
  }

  function updateCount() {
    const total = nonBlank(input.value);
    if (total === 0) {
      countEl.textContent = 'No lines pasted yet.';
      countEl.classList.remove('over');
      return;
    }
    countEl.textContent = `${total} nonempty line${total === 1 ? '' : 's'} of ${MAX_LINES} allowed.`;
    countEl.classList.toggle('over', total > MAX_LINES);
  }

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  async function refreshStatus() {
    badgeEl.className = 'badge badge-unknown';
    badgeEl.textContent = 'local model: checking...';
    try {
      const res = await fetch('/api/status');
      const body = await res.json();
      if (body.ready) {
        badgeEl.className = 'badge badge-ready';
        badgeEl.textContent = `local model: ${body.model}`;
      } else {
        badgeEl.className = 'badge badge-missing';
        badgeEl.textContent = 'local model: not ready';
      }
      badgeEl.title = body.message;
    } catch {
      badgeEl.className = 'badge badge-missing';
      badgeEl.textContent = 'local model: unreachable';
    }
  }

  function lineTextById(lines, id) {
    const found = lines.find((line) => line.id === id);
    return found ? found.text : '';
  }

  function renderIncidents(result) {
    incidentsEl.textContent = '';
    if (result.incidents.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No issues identified in this batch.';
      incidentsEl.appendChild(empty);
      return;
    }
    for (const incident of result.incidents) {
      const slip = document.createElement('article');
      slip.className = 'slip';

      const title = document.createElement('h3');
      title.textContent = incident.title;
      slip.appendChild(title);

      const observation = document.createElement('p');
      observation.textContent = incident.observation;
      slip.appendChild(observation);

      const check = document.createElement('p');
      check.className = 'check';
      check.textContent = `Suggested check: ${incident.nextCheck}`;
      slip.appendChild(check);

      const evidence = document.createElement('p');
      evidence.className = 'evidence';
      evidence.textContent = `Lines: ${incident.evidence.join(', ')}`;
      slip.appendChild(evidence);

      const source = document.createElement('ul');
      source.className = 'evidence-lines';
      for (const id of incident.evidence) {
        const li = document.createElement('li');
        li.textContent = `${id}: ${lineTextById(result.lines, id)}`;
        source.appendChild(li);
      }
      slip.appendChild(source);

      incidentsEl.appendChild(slip);
    }
  }

  async function digest() {
    digestBtn.disabled = true;
    input.readOnly = true;
    digestBtn.textContent = 'Reading logs...';
    setStatus('The local model is reading the batch...');
    incidentsEl.textContent = '';
    try {
      const res = await fetch('/api/digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: input.value }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus(body.error || 'The brief could not be made.', true);
        return;
      }
      renderIncidents(body);
      setStatus(`Brief ready in ${(body.elapsedMs / 1000).toFixed(1)}s.`);
    } catch {
      setStatus('The local server did not answer.', true);
    } finally {
      digestBtn.disabled = false;
      input.readOnly = false;
      digestBtn.textContent = 'Make my brief';
    }
  }

  loadSampleBtn.addEventListener('click', async () => {
    setStatus('Loading the synthetic sample...');
    try {
      const res = await fetch('/api/sample');
      const body = await res.json();
      input.value = body.text;
      updateCount();
      setStatus('Sample loaded. Ready when you are.');
    } catch {
      setStatus('Could not load the sample from the local server.', true);
    }
  });

  input.addEventListener('input', updateCount);
  digestBtn.addEventListener('click', digest);
  updateCount();
  refreshStatus();
})();