(() => {
  const input = document.getElementById('log-input');
  const loadSampleBtn = document.getElementById('load-sample');
  const digestBtn = document.getElementById('digest');
  const copyBtn = document.getElementById('copy');
  const clearBtn = document.getElementById('clear');
  const statusEl = document.getElementById('status');
  const incidentsEl = document.getElementById('incidents');
  const badgeEl = document.getElementById('model-badge');

  let lastResult = null;

  function clearResult() {
    lastResult = null;
    incidentsEl.textContent = '';
    copyBtn.disabled = true;
    setStatus('');
  }

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function setBusy(busy) {
    for (const btn of [loadSampleBtn, digestBtn, copyBtn, clearBtn]) {
      btn.disabled = busy || (btn === copyBtn && !lastResult);
    }
    input.readOnly = busy;
    digestBtn.setAttribute('aria-busy', String(busy));
    digestBtn.textContent = busy ? 'Reading logs...' : 'Make my brief';
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
        badgeEl.textContent = `local model: not ready`;
      }
      badgeEl.title = body.message;
    } catch {
      badgeEl.className = 'badge badge-missing';
      badgeEl.textContent = 'local model: unreachable';
    }
  }

  function errorMessage(code, fallback) {
    switch (code) {
      case 'ollama_unreachable':
        return 'The local model server is not running. Start Ollama on this machine and try again.';
      case 'upstream_http':
        return 'The model server answered with an error. If the model is missing, run: ollama pull gemma3:4b';
      case 'timeout':
        return 'The model took too long to answer. Try a smaller batch or try again.';
      case 'invalid_model_output':
        return 'The model reply could not be checked against the required format. No brief was produced.';
      case 'busy':
        return 'A digest is already running. Try again shortly.';
      case 'bad_input':
        return fallback || 'That log batch could not be used. Check it and try again.';
      default:
        return fallback || 'Something went wrong while making the brief.';
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
      empty.textContent = 'No issues identified in this batch. This is not a health check.';
      incidentsEl.appendChild(empty);
      return;
    }
    result.incidents.forEach((incident, index) => {
      const slip = document.createElement('article');
      slip.className = 'slip';
      slip.style.animationDelay = `${index * 60}ms`;

      const title = document.createElement('h3');
      title.textContent = incident.title;
      slip.appendChild(title);

      const observation = document.createElement('p');
      observation.textContent = incident.observation;
      slip.appendChild(observation);

      const check = document.createElement('p');
      check.className = 'check';
      const checkLabel = document.createElement('strong');
      checkLabel.textContent = 'Suggested check: ';
      check.appendChild(checkLabel);
      check.appendChild(document.createTextNode(incident.nextCheck));
      slip.appendChild(check);

      const evidence = document.createElement('div');
      evidence.className = 'evidence';
      const evidenceLabel = document.createElement('span');
      evidenceLabel.className = 'evidence-label';
      evidenceLabel.textContent = 'Lines:';
      evidence.appendChild(evidenceLabel);

      const lineList = document.createElement('ul');
      lineList.className = 'evidence-lines';
      lineList.hidden = true;

      for (const id of incident.evidence) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = String(id);
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', () => {
          const expanded = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', String(!expanded));
          const existing = lineList.querySelector(`[data-line-id="${id}"]`);
          if (expanded && existing) {
            existing.remove();
          } else if (!expanded && !existing) {
            const li = document.createElement('li');
            li.dataset.lineId = String(id);
            const idEl = document.createElement('span');
            idEl.className = 'line-id';
            idEl.textContent = `${id}:`;
            li.appendChild(idEl);
            li.appendChild(document.createTextNode(lineTextById(result.lines, id)));
            lineList.appendChild(li);
          }
          lineList.hidden = lineList.children.length === 0;
        });
        evidence.appendChild(btn);
      }

      slip.appendChild(evidence);
      slip.appendChild(lineList);
      incidentsEl.appendChild(slip);
    });
  }

  loadSampleBtn.addEventListener('click', async () => {
    setBusy(true);
    setStatus('Loading the synthetic sample...');
    try {
      const res = await fetch('/api/sample');
      const body = await res.json();
      input.value = body.text;
      clearResult();
      setStatus('Sample loaded. Ready when you are.');
    } catch {
      setStatus('Could not load the sample from the local server.', true);
    } finally {
      setBusy(false);
    }
  });

  input.addEventListener('input', clearResult);

  digestBtn.addEventListener('click', async () => {
    setBusy(true);
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
        setStatus(errorMessage(body.code, body.error), true);
        lastResult = null;
        return;
      }
      lastResult = body;
      renderIncidents(body);
      const suffix = body.cached ? " (from this session's cache)" : ` in ${(body.elapsedMs / 1000).toFixed(1)}s`;
      setStatus(`Brief ready${suffix}.`);
    } catch {
      setStatus('The local server did not answer. Is Naplog still running?', true);
      lastResult = null;
    } finally {
      setBusy(false);
    }
  });

  copyBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    const parts = [
      '# Naplog morning brief',
      '',
      '> AI draft. Check the source lines before acting.',
      '',
    ];
    if (lastResult.incidents.length === 0) {
      parts.push('No issues identified in this batch. This is not a health check.');
    }
    for (const incident of lastResult.incidents) {
      parts.push(`## ${incident.title}`);
      parts.push(incident.observation);
      parts.push(`Suggested check: ${incident.nextCheck}`);
      parts.push(`Evidence: lines ${incident.evidence.join(', ')}`);
      parts.push('');
    }
    try {
      await navigator.clipboard.writeText(parts.join('\n'));
      setStatus('Brief copied as Markdown.');
    } catch {
      setStatus('Clipboard copy failed in this browser.', true);
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearResult();
    setStatus('');
    setBusy(false);
    input.focus();
  });

  refreshStatus();
})();
