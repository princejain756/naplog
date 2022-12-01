(() => {
  const input = document.getElementById('log-input');
  const countEl = document.getElementById('line-count');
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

  input.addEventListener('input', updateCount);
  updateCount();
})();
