// Memory viewer window. Talks only to window.pochiMemory (exposed by
// memoryPreload.js) — no direct file/IPC access, same isolation pattern
// as the main overlay's renderer.js.

const content = document.getElementById('content');
const emptyState = document.getElementById('empty-state');
const exportBtn = document.getElementById('export-btn');
const deleteAllBtn = document.getElementById('delete-all-btn');
const transparencyList = document.getElementById('transparency-list');

const CATEGORY_ORDER = ['milestones', 'preferences', 'habits', 'daily_summary'];
const CATEGORY_TITLES = {
  milestones: 'Milestones',
  preferences: 'Preferences',
  habits: 'Habits',
  daily_summary: 'Daily summaries'
};

function showToast(text) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('visible'), 2200);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Chapter 22.15: pulled fresh from window.pochiMemory.transparencyList()
// every render() call — same live-state read as the rest of this window,
// nothing hardcoded or cached here.
async function renderTransparency() {
  const lines = await window.pochiMemory.transparencyList();
  transparencyList.innerHTML = '';
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    transparencyList.appendChild(li);
  }
}

async function render() {
  renderTransparency();
  const entries = await window.pochiMemory.list();

  document.querySelectorAll('.category-section').forEach((el) => el.remove());
  emptyState.hidden = entries.length > 0;

  for (const cat of CATEGORY_ORDER) {
    const inCat = entries.filter((e) => e.category === cat);
    if (!inCat.length) continue;

    const section = document.createElement('section');
    section.className = 'category-section';

    const title = document.createElement('h2');
    title.className = 'category-title';
    title.textContent = `${CATEGORY_TITLES[cat]} (${inCat.length})`;
    section.appendChild(title);

    for (const entry of inCat) {
      section.appendChild(renderEntry(entry));
    }

    content.appendChild(section);
  }
}

function renderEntry(entry) {
  const row = document.createElement('div');
  row.className = 'entry';

  const body = document.createElement('div');
  body.className = 'entry-body';

  const summary = document.createElement('p');
  summary.className = 'entry-summary';
  summary.textContent = entry.summary;
  body.appendChild(summary);

  const meta = document.createElement('div');
  meta.className = 'entry-meta';

  const badge = document.createElement('span');
  badge.className = `importance-badge importance-${entry.importance}`;
  badge.textContent = entry.importance;
  meta.appendChild(badge);

  const date = document.createElement('span');
  date.textContent = formatDate(entry.updatedAt);
  meta.appendChild(date);

  body.appendChild(meta);
  row.appendChild(body);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'small';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    await window.pochiMemory.deleteEntry(entry.id);
    showToast('Deleted.');
    render();
  });
  row.appendChild(deleteBtn);

  return row;
}

exportBtn.addEventListener('click', async () => {
  const result = await window.pochiMemory.exportToFile();
  if (result && result.ok) {
    showToast(`Exported to ${result.path}`);
  } else if (result && result.error) {
    showToast('Export failed: ' + result.error);
  }
  // canceled: no toast, nothing happened, that's expected
});

deleteAllBtn.addEventListener('click', async () => {
  const confirmed = confirm('Delete everything Pochi remembers? This cannot be undone.');
  if (!confirmed) return;
  await window.pochiMemory.deleteAll();
  showToast('Everything deleted.');
  render();
});

render();
