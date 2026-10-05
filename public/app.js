// Mission Control front end: a small hash router and one render function per page.
const app = document.getElementById('app');

// Page state lives in memory only, so every switch is back to its default on reload.
const state = { config: null, showPrivate: false, hideClosed: false, hideSuggested: true, owner: '', boardOwner: '' };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COULD_NOT_READ = '<span class="cnr">could not read</span>';

// Today on this computer's calendar, as YYYY-MM-DD. The core checks "not in the future" against the same date.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return COULD_NOT_READ;
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

function showError(err) {
  app.innerHTML = `<div class="notice notice-error"><strong>Something went wrong.</strong> ${esc(err.message)}</div>`;
}

function warningsPanel(warnings) {
  if (!warnings?.length) return '';
  return `
    <details class="notice notice-warn">
      <summary><strong>${warnings.length} thing${warnings.length === 1 ? '' : 's'} could not be read.</strong> Shown as "could not read" below.</summary>
      <ul>${warnings.map((w) => `<li><code>${esc(w.file)}</code>: ${esc(w.message)}</li>`).join('')}</ul>
    </details>`;
}

// A page whose file isn't in the workspace shows this plain notice instead of an error, as the Agents page
// does for a missing agents folder. A file that is there but can't be read is still an error.
function missingFile(file, what) {
  return `<div class="notice">There is no <code>${esc(file)}</code> in this workspace, so there are ${what} to show.</div>`;
}

// A meeting name that is not one of the summaries in meeting-notes/ (the core says so with noSummary) shows this
// plain notice instead of an error, as missingFile does for a missing file. The Node version never sends noSummary,
// so it shows its error as before.
function noSummary(err) {
  if (typeof err.data?.noSummary !== 'string') return false;
  app.innerHTML = `
    <p><a class="back" href="#/meetings">← All meetings</a></p>
    <div class="notice" id="no-summary">There is no summary named "<code>${esc(err.data.noSummary)}</code>" in <code>meeting-notes/</code>.</div>`;
  return true;
}

function privateSwitch() {
  return `
    <label class="switch">
      <input type="checkbox" id="private-switch" role="switch" ${state.showPrivate ? 'checked' : ''}>
      <span class="switch-track" aria-hidden="true"></span>
      <span>Show private notes</span>
    </label>`;
}

// ---------- Meetings ----------

async function renderMeetings() {
  const data = await api('/api/meetings');
  const asOf = data.asOfIsNewestMeeting
    ? `as of ${fmtDate(data.asOf)}, the newest meeting`
    : `as of today, ${fmtDate(data.asOf)}`;

  app.innerHTML = `
    <div class="page-head">
      <h1>Meetings</h1>
      ${privateSwitch()}
    </div>
    ${warningsPanel(data.warnings)}

    <section class="panel" aria-labelledby="tracked-h">
      <div class="panel-head">
        <div>
          <h2 id="tracked-h">Tracked items across all meetings</h2>
          <p class="muted"><strong id="tracked-count" class="count"></strong> · age in days ${esc(asOf)} · latest status word for word</p>
        </div>
        <div class="filters">
          <label class="check">
            <input type="checkbox" id="hide-closed" ${state.hideClosed ? 'checked' : ''}>
            Hide closed
          </label>
          <label class="check">
            <input type="checkbox" id="hide-suggested" ${state.hideSuggested ? 'checked' : ''}>
            Hide suggested
          </label>
          <label class="select">
            Owner
            <select id="owner-filter">
              <option value="">Everyone</option>
              ${data.owners.map((o) => `<option value="${esc(o)}" ${o === state.owner ? 'selected' : ''}>${esc(o)}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
      <div class="table-wrap tracked-wrap">
        <table class="data tracked">
          <colgroup>
            <col class="c-item"><col class="c-owner"><col class="c-first"><col class="c-age"><col class="c-status"><col class="c-from">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Owner</th>
              <th scope="col">First seen</th>
              <th scope="col" class="num">Age</th>
              <th scope="col">Latest status</th>
              <th scope="col">From meetings</th>
            </tr>
          </thead>
          <tbody id="tracked-body"></tbody>
        </table>
      </div>
      <p class="muted small legend">
        <span class="tag tag-suggested">suggested</span> not said in the meeting ·
        <span class="tag tag-unmatched">unmatched</span> couldn't be linked to an action item in the meeting it came from, so it's listed on its own
      </p>
    </section>

    <section aria-labelledby="summaries-h">
      <h2 id="summaries-h">Summaries <span class="muted">· newest first</span></h2>
      <ul class="meeting-list">
        ${data.meetings.map((m) => `
          <li>
            <a class="meeting-card" href="#/meetings/${encodeURIComponent(m.file)}">
              <span class="meeting-date">${fmtDate(m.date)}</span>
              <span class="meeting-people">${m.people ? esc(m.people.join(', ')) : COULD_NOT_READ}</span>
              <span class="meeting-type">${m.type ? esc(m.type) : COULD_NOT_READ}</span>
            </a>
          </li>`).join('')}
      </ul>
    </section>`;

  const renderRows = () => {
    const rows = data.tracked.filter((r) =>
      !(state.hideClosed && r.closed) &&
      !(state.hideSuggested && r.suggested) &&
      !(state.owner && !r.owners.includes(state.owner)));
    document.getElementById('tracked-count').textContent = `Showing ${rows.length} of ${data.tracked.length}`;
    document.getElementById('tracked-body').innerHTML = rows.map((r) => `
      <tr class="${r.closed ? 'is-closed' : ''}">
        <td class="item">
          <span>${r.textHtml}</span>
          ${r.suggested ? '<span class="tag tag-suggested">suggested</span>' : ''}
          ${r.unmatched ? '<span class="tag tag-unmatched">unmatched</span>' : ''}
        </td>
        <td>${r.owner ? esc(r.owner) : COULD_NOT_READ}</td>
        <td>${r.firstSeen ? fmtDate(r.firstSeen) : `${COULD_NOT_READ}<div class="muted small">${esc(r.firstSeenText)}</div>`}</td>
        <td class="num">${r.ageDays ?? COULD_NOT_READ}</td>
        <td class="status">${r.latestStatusHtml}</td>
        <td class="sources">${r.sources.map((s) => `<a href="#/meetings/${encodeURIComponent(s.file)}" title="${esc(s.kind)} in ${esc(s.file)}">${fmtDate(s.date, { month: 'short', day: 'numeric' })}</a>`).join('')}</td>
      </tr>`).join('');
  };
  renderRows();

  document.getElementById('hide-closed').addEventListener('change', (e) => { state.hideClosed = e.target.checked; renderRows(); });
  document.getElementById('hide-suggested').addEventListener('change', (e) => { state.hideSuggested = e.target.checked; renderRows(); });
  document.getElementById('owner-filter').addEventListener('change', (e) => { state.owner = e.target.value; renderRows(); });
  document.getElementById('private-switch').addEventListener('change', (e) => { state.showPrivate = e.target.checked; });
}

async function renderMeeting(file) {
  const load = () => api(`/api/meeting?file=${encodeURIComponent(file)}${state.showPrivate ? '&private=1' : ''}`);
  let m;
  try { m = await load(); } catch (err) { if (noSummary(err)) return; throw err; }

  const draw = () => {
    const privateLine = m.privateNotes
      ? (state.showPrivate
          ? `<span class="private-status is-shown">Showing ${m.privateNotes} private note${m.privateNotes === 1 ? '' : 's'}</span>`
          : `<span class="private-status">${m.privateNotes} private note${m.privateNotes === 1 ? '' : 's'} hidden</span>`)
      : '';
    app.innerHTML = `
      <div class="reader-bar">
        <a class="back" href="#/meetings">← All meetings</a>
        <div class="reader-private">${privateLine}${privateSwitch()}</div>
      </div>
      <article class="prose">${m.html}</article>`;
    document.getElementById('private-switch').addEventListener('change', async (e) => {
      state.showPrivate = e.target.checked;
      try { m = await load(); draw(); } catch (err) { if (!noSummary(err)) showError(err); }
    });
  };
  draw();
}

// ---------- Board ----------

async function renderBoard() {
  let view = await api('/api/board');
  const columns = view.columns;

  app.innerHTML = `
    <div class="page-head board-head">
      <div class="board-title">
        <h1>Board</h1>
        <p class="board-count" id="board-count"></p>
        <p class="board-status" id="board-status" role="status" aria-live="polite"></p>
      </div>
      <div class="board-tools">
        <label class="select">
          Owner
          <select id="board-owner"></select>
        </label>
        <label class="check">
          <input type="checkbox" id="include-suggested">
          Include suggested items
        </label>
        <button type="button" class="btn" id="import-btn">Import action items</button>
        <button type="button" class="btn btn-primary" id="add-btn">Add card</button>
      </div>
    </div>
    <div class="board" id="board"></div>

    <dialog class="dialog" id="card-dialog" aria-labelledby="card-dialog-h">
      <form id="card-form" novalidate>
        <h2 id="card-dialog-h">Add card</h2>
        <label class="field">
          <span>Title</span>
          <textarea name="title" rows="3" maxlength="500" required></textarea>
        </label>
        <label class="field">
          <span>Owner <span class="muted">(optional)</span></span>
          <input name="owner" list="owner-options" maxlength="120" autocomplete="off">
          <datalist id="owner-options"></datalist>
        </label>
        <label class="field">
          <span>Meeting <span class="muted">(optional)</span></span>
          <select name="meeting"></select>
        </label>
        <label class="field" id="column-field">
          <span>Column</span>
          <select name="column">${columns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        </label>
        <p class="form-error" id="card-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>

    <dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-h">
      <h2 id="confirm-h">Delete this card?</h2>
      <p id="confirm-title" class="confirm-title"></p>
      <p id="confirm-note" class="muted"></p>
      <p class="form-error" id="confirm-error" role="alert"></p>
      <div class="dialog-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn btn-danger" id="confirm-delete">Delete</button>
      </div>
    </dialog>`;

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('board-status');
  const ownerSelect = document.getElementById('board-owner');
  const setStatus = (msg, isError = false) => {
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', isError);
  };

  const columnIndex = (id) => columns.findIndex((c) => c.id === id);
  // The Owner filter only changes what is shown; board.json is never touched by it.
  const isShown = (c) => !state.boardOwner || (view.ownersById[c.id] || []).includes(state.boardOwner);

  function applyResult(result) {
    view.board = result.board;
    view.ownersById = result.ownersById;
    view.owners = result.owners;
  }

  function drawOwnerOptions() {
    if (state.boardOwner && !view.owners.includes(state.boardOwner)) state.boardOwner = '';
    ownerSelect.innerHTML = '<option value="">Everyone</option>' +
      view.owners.map((o) => `<option value="${esc(o)}" ${o === state.boardOwner ? 'selected' : ''}>${esc(o)}</option>`).join('');
  }

  function cardHtml(c) {
    const col = columnIndex(c.column);
    const left = columns[col - 1];
    const right = columns[col + 1];
    const short = c.title.length > 60 ? c.title.slice(0, 57) + '…' : c.title;
    const owner = c.owner ? esc(c.owner) : '<span class="muted">No owner</span>';
    const meeting = c.meeting
      ? `<a href="#/meetings/${encodeURIComponent(c.meeting)}" title="Open the ${esc(fmtDate(c.meetingDate))} meeting">${fmtDate(c.meetingDate)}</a>`
      : '<span class="muted">No meeting</span>';
    return `
      <li class="card card-${c.source}" draggable="true" data-id="${esc(c.id)}">
        <p class="card-title">${esc(c.title)}</p>
        <p class="card-title-full" aria-hidden="true">${esc(c.title)}</p>
        <div class="card-foot">
          <p class="card-meta" title="${esc(c.owner || 'No owner')}">
            <span class="card-owner">${owner}</span><span class="sep" aria-hidden="true">·</span>${meeting}
            ${c.suggested ? '<span class="tag tag-suggested">suggested</span>' : ''}
            ${c.source === 'manual' ? '<span class="tag tag-own">yours</span>' : ''}
          </p>
          <div class="card-actions">
            <button type="button" class="icon-btn" data-act="move" data-to="${left?.id || ''}" ${left ? '' : 'disabled'}
              title="${left ? `Move to ${esc(left.name)}` : ''}"
              aria-label="${left ? `Move “${esc(short)}” to ${esc(left.name)}` : 'Already in the first column'}">←</button>
            <button type="button" class="icon-btn" data-act="move" data-to="${right?.id || ''}" ${right ? '' : 'disabled'}
              title="${right ? `Move to ${esc(right.name)}` : ''}"
              aria-label="${right ? `Move “${esc(short)}” to ${esc(right.name)}` : 'Already in the last column'}">→</button>
            ${c.source === 'manual' ? `<button type="button" class="icon-btn" data-act="edit" title="Edit" aria-label="Edit “${esc(short)}”">✎</button>` : ''}
            <button type="button" class="icon-btn icon-danger" data-act="delete" title="Delete" aria-label="Delete “${esc(short)}”">✕</button>
          </div>
        </div>
      </li>`;
  }

  // A board with no cards at all says where cards come from; the To do column is where imports land.
  function emptyText(col, all) {
    if (all.length) return 'No cards for this owner';
    if (!view.board.cards.length && col.id === 'todo') return 'No cards yet. Use “Import action items” to add the action items from your meeting notes.';
    return 'No cards';
  }

  function draw() {
    const shown = view.board.cards.filter(isShown);
    document.getElementById('board-count').textContent = `Showing ${shown.length} of ${view.board.cards.length} cards`;
    // Keep each column's scroll position across redraws.
    const scrolls = Object.fromEntries([...boardEl.querySelectorAll('.column')].map((c) => [c.dataset.column, c.querySelector('.cards').scrollTop]));
    boardEl.innerHTML = columns.map((col) => {
      const all = view.board.cards.filter((c) => c.column === col.id);
      const cards = all.filter(isShown);
      const count = cards.length === all.length ? `${all.length}` : `${cards.length} of ${all.length}`;
      return `
        <section class="column" data-column="${col.id}" aria-labelledby="col-${col.id}">
          <h2 id="col-${col.id}">${esc(col.name)} <span class="column-count">${count}</span></h2>
          <ol class="cards">
            ${cards.map(cardHtml).join('') || `<li class="column-empty">${emptyText(col, all)}</li>`}
          </ol>
        </section>`;
    }).join('');
    boardEl.querySelectorAll('.column').forEach((c) => { c.querySelector('.cards').scrollTop = scrolls[c.dataset.column] || 0; });
    markClamped();
  }

  // Titles cut off at two lines show their full text on hover and focus.
  function markClamped() {
    boardEl.querySelectorAll('.card').forEach((card) => {
      const t = card.querySelector('.card-title');
      card.classList.toggle('is-clamped', t.scrollHeight > t.clientHeight + 1);
    });
  }
  const resizeObserver = new ResizeObserver(() => { fitBoard(); markClamped(); });
  resizeObserver.observe(boardEl);

  // The columns fill the rest of the window and scroll their own cards.
  function fitBoard() {
    boardEl.style.setProperty('--board-top', `${boardEl.getBoundingClientRect().top + window.scrollY}px`);
  }

  async function mutate(request, { focus } = {}) {
    try {
      const result = await request();
      applyResult(result);
      drawOwnerOptions();
      draw();
      if (focus) focus();
      return result;
    } catch (err) {
      setStatus(err.message, true);
      // The file may have changed underneath us; show what is really saved.
      try { view = await api('/api/board'); drawOwnerOptions(); draw(); } catch { /* keep the error visible */ }
      return null;
    }
  }

  function moveCard(id, column, beforeId = null, { keepFocus } = {}) {
    return mutate(() => api(`/api/board/cards/${encodeURIComponent(id)}/move`, { method: 'POST', body: { column, beforeId } }), {
      focus: keepFocus && (() => {
        const card = boardEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
        if (!card) return;
        card.scrollIntoView({ block: 'nearest' });
        const btns = [...card.querySelectorAll('[data-act="move"]')];
        const same = btns[keepFocus === 'left' ? 0 : 1];
        (same && !same.disabled ? same : btns.find((b) => !b.disabled))?.focus();
      }),
    });
  }

  ownerSelect.addEventListener('change', () => { state.boardOwner = ownerSelect.value; draw(); });

  // ----- import -----
  document.getElementById('import-btn').addEventListener('click', async (e) => {
    const includeSuggested = document.getElementById('include-suggested').checked;
    e.target.disabled = true;
    const result = await mutate(() => api('/api/board/import', { method: 'POST', body: { includeSuggested } }));
    e.target.disabled = false;
    if (!result) return;
    const n = result.counts;
    const parts = [`Added ${n.added} card${n.added === 1 ? '' : 's'}.`];
    if (n.alreadyOnBoard) parts.push(`${n.alreadyOnBoard} already on the board.`);
    if (n.previouslyDeleted) parts.push(`${n.previouslyDeleted} deleted earlier, not re-added.`);
    if (n.suggestedLeftOut) parts.push(`${n.suggestedLeftOut} suggested left out.`);
    if (result.warnings?.length) parts.push(`${result.warnings.length} row${result.warnings.length === 1 ? '' : 's'} could not be read (see Meetings).`);
    setStatus(parts.join(' '));
  });

  // ----- add / edit -----
  const dialog = document.getElementById('card-dialog');
  const form = document.getElementById('card-form');
  const formError = document.getElementById('card-error');
  let editingId = null;

  function openCardDialog(card) {
    editingId = card?.id || null;
    document.getElementById('card-dialog-h').textContent = card ? 'Edit card' : 'Add card';
    document.getElementById('column-field').hidden = Boolean(card);
    const owners = [...new Set([...view.meetings.flatMap((m) => m.people || []), ...view.board.cards.map((c) => c.owner).filter(Boolean)])].sort();
    document.getElementById('owner-options').innerHTML = owners.map((o) => `<option value="${esc(o)}">`).join('');
    form.meeting.innerHTML = '<option value="">None</option>' + view.meetings
      .map((m) => `<option value="${esc(m.file)}">${fmtDate(m.date)} · ${esc((m.people || []).join(', '))}</option>`).join('');
    form.title.value = card?.title || '';
    form.owner.value = card?.owner || '';
    form.meeting.value = card?.meeting || '';
    form.column.value = 'todo';
    formError.textContent = '';
    dialog.showModal();
    form.title.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.title.value.trim()) { formError.textContent = 'Give the card a title.'; form.title.focus(); return; }
    const body = { title: form.title.value, owner: form.owner.value, meeting: form.meeting.value || null, column: form.column.value };
    try {
      const result = editingId
        ? await api(`/api/board/cards/${encodeURIComponent(editingId)}`, { method: 'PUT', body })
        : await api('/api/board/cards', { method: 'POST', body });
      applyResult(result);
      drawOwnerOptions();
      draw();
      dialog.close();
      const hidden = !isShown(result.card) ? ' It is hidden by the Owner filter.' : '';
      setStatus((editingId ? 'Card saved.' : 'Card added at the top of its column.') + hidden);
      if (!editingId && !hidden) boardEl.querySelector(`[data-column="${result.card.column}"] .cards`).scrollTop = 0;
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  document.getElementById('add-btn').addEventListener('click', () => openCardDialog(null));

  // ----- delete -----
  const confirmDialog = document.getElementById('confirm-dialog');
  let deletingId = null;
  function openConfirm(card) {
    deletingId = card.id;
    document.getElementById('confirm-title').textContent = card.title;
    document.getElementById('confirm-note').textContent = card.source === 'import'
      ? 'It came from the meeting notes. It won’t come back when you import again. The notes themselves are not changed.'
      : 'This card was added by you and will be removed for good.';
    document.getElementById('confirm-error').textContent = '';
    confirmDialog.showModal();
    confirmDialog.querySelector('[data-close]').focus();
  }
  document.getElementById('confirm-delete').addEventListener('click', async () => {
    try {
      const result = await api(`/api/board/cards/${encodeURIComponent(deletingId)}`, { method: 'DELETE' });
      applyResult(result);
      drawOwnerOptions();
      draw();
      confirmDialog.close();
      setStatus('Card deleted.');
      document.getElementById('add-btn').focus();
    } catch (err) {
      document.getElementById('confirm-error').textContent = err.message;
    }
  });

  for (const d of [dialog, confirmDialog]) {
    d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close(); });
  }

  // ----- card buttons -----
  boardEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    const card = view.board.cards.find((c) => c.id === id);
    if (!card) return;
    if (btn.dataset.act === 'move' && btn.dataset.to) {
      const goingLeft = columnIndex(btn.dataset.to) < columnIndex(card.column);
      moveCard(id, btn.dataset.to, null, { keepFocus: goingLeft ? 'left' : 'right' });
    }
    if (btn.dataset.act === 'edit') openCardDialog(card);
    if (btn.dataset.act === 'delete') openConfirm(card);
  });

  // ----- drag and drop -----
  let dragId = null;
  const marker = document.createElement('li');
  marker.className = 'drop-marker';
  marker.setAttribute('aria-hidden', 'true');

  // The visible card the drop lands in front of (null = end of the column), not counting the dragged card.
  function dropBefore(list, y) {
    const cards = [...list.querySelectorAll('.card')].filter((el) => el.dataset.id !== dragId);
    return cards.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top + r.height / 2;
    }) || null;
  }

  boardEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    boardEl.classList.add('is-dragging');
    requestAnimationFrame(() => card.classList.add('dragging'));
  });

  boardEl.addEventListener('dragover', (e) => {
    const column = e.target.closest('.column');
    if (!column || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const list = column.querySelector('.cards');
    const before = dropBefore(list, e.clientY);
    list.querySelector('.column-empty')?.setAttribute('hidden', '');
    if (before) list.insertBefore(marker, before);
    else list.appendChild(marker);
    boardEl.querySelectorAll('.column').forEach((c) => c.classList.toggle('drop-target', c === column));
  });

  boardEl.addEventListener('drop', (e) => {
    const column = e.target.closest('.column');
    if (!column || !dragId) return;
    e.preventDefault();
    const before = dropBefore(column.querySelector('.cards'), e.clientY);
    const id = dragId;
    cleanupDrag();
    moveCard(id, column.dataset.column, before ? before.dataset.id : null);
  });

  function cleanupDrag() {
    dragId = null;
    marker.remove();
    boardEl.classList.remove('is-dragging');
    boardEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    boardEl.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    boardEl.querySelectorAll('.column-empty[hidden]').forEach((el) => el.removeAttribute('hidden'));
  }
  boardEl.addEventListener('dragend', cleanupDrag);

  drawOwnerOptions();
  fitBoard();
  draw();
}

// ---------- Library ----------

const CNR = (v) => v && typeof v === 'object' && v.cnr;

const LIBRARY_COLUMNS = [
  { key: 'title', label: 'Title', value: (b) => (CNR(b.title) ? null : b.title.toLowerCase()) },
  { key: 'author', label: 'Author', value: (b) => (CNR(b.author) ? null : b.author.toLowerCase()) },
  { key: 'rating', label: 'My rating', value: (b) => (CNR(b.rating) ? null : b.rating) },
  { key: 'read', label: 'Read', value: (b) => (CNR(b.read) ? null : b.read) },
  { key: 'dateRead', label: 'Date read', value: (b) => (CNR(b.dateRead) ? null : b.dateRead) },
  { key: 'usedBy', label: 'Used by', value: (b) => (CNR(b.usedBy) || !b.usedBy.length ? null : b.usedBy.join(', ').toLowerCase()) },
  { key: 'notes', label: 'My notes', value: (b) => b.notes?.file || null },
];

// Empty values always sort last, whichever direction is chosen.
function sortBooks(books, { key, dir }) {
  if (!key) return books;
  const col = LIBRARY_COLUMNS.find((c) => c.key === key);
  return [...books].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    if (x === null && y === null) return a.index - b.index;
    if (x === null) return 1;
    if (y === null) return -1;
    const cmp = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return (dir === 'desc' ? -cmp : cmp) || a.index - b.index;
  });
}

function ratingHtml(r) {
  if (CNR(r)) return COULD_NOT_READ;
  if (r === null) return '<span class="muted">Not rated</span>';
  return `<span class="stars" role="img" aria-label="${r} out of 5">${'★'.repeat(r)}<span class="stars-off">${'★'.repeat(5 - r)}</span></span>`;
}

async function renderLibrary() {
  let view = await api('/api/library');
  state.librarySort ??= { key: null, dir: 'asc' };

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Library</h1>
        <p class="muted page-sub">My ratings and my own notes. The app shows only what is in your own notes files.</p>
      </div>
      <button type="button" class="btn btn-primary" id="add-book">Add book</button>
    </div>
    <div id="library-warnings"></div>
    <div id="library-missing"></div>
    <p class="board-status" id="library-status" role="status" aria-live="polite"></p>
    <div class="table-wrap" id="library-table">
      <table class="data library">
        <thead><tr id="library-head"></tr></thead>
        <tbody id="library-body"></tbody>
      </table>
    </div>
    <div id="library-other-checks"></div>
    <p class="muted small legend" id="library-legend">A <span class="check-legend">⚑ check</span> mark means a book's Used by and an agent's Sources line disagree. It is shown only; neither file is changed.</p>

    <dialog class="dialog" id="book-dialog" aria-labelledby="book-dialog-h">
      <form id="book-form" novalidate>
        <h2 id="book-dialog-h">Add book</h2>
        <p class="form-note" id="book-cnr" hidden></p>
        <label class="field"><span>Title</span><input name="title" maxlength="300" required></label>
        <label class="field"><span>Author</span><input name="author" maxlength="200" required></label>
        <div class="field-row">
          <fieldset class="field">
            <legend>Read</legend>
            <div class="radios">
              <label class="check"><input type="radio" name="read" value="Yes"> Yes</label>
              <label class="check"><input type="radio" name="read" value="No"> No</label>
            </div>
          </fieldset>
          <label class="field"><span>Date read</span><input type="date" name="date_read"></label>
          <label class="field"><span>My rating</span>
            <select name="rating">
              <option value="">Not rated</option>
              ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} – ${'★'.repeat(n)}</option>`).join('')}
            </select>
          </label>
        </div>
        <fieldset class="field">
          <legend>Used by</legend>
          <div class="checks" id="used-by-options"></div>
        </fieldset>
        <label class="field"><span>My notes file</span><select name="notes"></select></label>
        <p class="form-error" id="book-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>`;

  const statusEl = document.getElementById('library-status');

  function draw() {
    const missing = view.booksFileFound === false;
    document.getElementById('library-missing').innerHTML = missing ? missingFile(view.booksFile, 'no books') : '';
    document.getElementById('library-table').hidden = missing;
    document.getElementById('library-legend').hidden = missing;
    document.getElementById('library-warnings').innerHTML = warningsPanel(view.warnings);
    document.getElementById('library-other-checks').innerHTML = view.otherChecks?.length
      ? `<div class="notice"><strong>Check:</strong> <ul>${view.otherChecks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : '';
    const known = new Set(view.agents);
    const sort = state.librarySort;
    document.getElementById('library-head').innerHTML = LIBRARY_COLUMNS.map((c) => {
      const active = sort.key === c.key;
      const aria = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" aria-sort="${aria}"><button type="button" class="sort-btn" data-sort="${c.key}">${esc(c.label)}<span class="sort-icon" aria-hidden="true">${active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span></button></th>`;
    }).join('') + '<th scope="col"><span class="visually-hidden">Edit</span></th>';

    document.getElementById('library-body').innerHTML = sortBooks(view.books, sort).map((b) => `
      <tr>
        <td class="book-title">
          <span>${CNR(b.title) ? COULD_NOT_READ : esc(b.title)}</span>
          ${b.checks?.length ? `
            <details class="check-mark">
              <summary><span aria-hidden="true">⚑</span> check<span class="visually-hidden">: ${b.checks.length} thing${b.checks.length === 1 ? '' : 's'} to look at</span></summary>
              <ul>${b.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
            </details>` : ''}
        </td>
        <td>${CNR(b.author) ? COULD_NOT_READ : esc(b.author)}</td>
        <td class="nowrap">${ratingHtml(b.rating)}</td>
        <td>${CNR(b.read) ? COULD_NOT_READ : `<span class="pill ${b.read === 'Yes' ? 'pill-yes' : 'pill-no'}">${esc(b.read)}</span>`}</td>
        <td class="nowrap">${CNR(b.dateRead) ? COULD_NOT_READ : b.dateRead ? fmtDate(b.dateRead) : '<span class="muted">—</span>'}</td>
        <td>${CNR(b.usedBy) ? COULD_NOT_READ : b.usedBy.length
          ? b.usedBy.map((u) => known.has(u)
              ? `<span class="chip-agent">${esc(u)}</span>`
              : `<span class="chip-agent chip-unknown" title="No agent with this name on the Agents page">${esc(u)} ?</span>`).join(' ')
          : '<span class="muted">—</span>'}</td>
        <td class="notes-cell">${CNR(b.notes) ? COULD_NOT_READ
          : b.notes?.missing ? `<span class="cnr" title="${esc(b.notes.missing)}">file not found</span>`
          : b.notes ? `<a href="#/library/notes/${encodeURIComponent(b.notes.file)}">${esc(b.notes.file)}</a>`
          : '<span class="muted">—</span>'}</td>
        <td class="edit-cell"><button type="button" class="icon-btn" data-edit="${b.index}" title="Edit" aria-label="Edit ${CNR(b.title) ? 'book' : esc(b.title)}">✎</button></td>
      </tr>`).join('');
  }

  document.getElementById('library-head').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const key = btn.dataset.sort;
    state.librarySort = state.librarySort.key === key
      ? { key, dir: state.librarySort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' };
    draw();
    document.querySelector(`[data-sort="${key}"]`).focus();
  });

  // ----- add / edit form -----
  const dialog = document.getElementById('book-dialog');
  const form = document.getElementById('book-form');
  const formError = document.getElementById('book-error');
  let editing = null;

  function syncReadFields() {
    const unread = form.read.value === 'No';
    form.date_read.disabled = unread;
    form.rating.disabled = unread;
    if (unread) { form.date_read.value = ''; form.rating.value = ''; }
  }
  form.addEventListener('change', (e) => { if (e.target.name === 'read') syncReadFields(); });

  function openBookDialog(book) {
    editing = book;
    document.getElementById('book-dialog-h').textContent = book ? 'Edit book' : 'Add book';
    const value = (v, fallback) => (CNR(v) ? fallback : v ?? fallback);
    const unreadable = book ? ['title', 'author', 'rating', 'read', 'dateRead', 'usedBy', 'notes'].filter((k) => CNR(book[k])) : [];
    const note = document.getElementById('book-cnr');
    note.hidden = !unreadable.length;
    note.textContent = unreadable.length ? `Some fields could not be read (${unreadable.join(', ')}). They start empty here, and saving replaces them.` : '';

    form.title.value = book ? value(book.title, '') : '';
    form.author.value = book ? value(book.author, '') : '';
    const read = book ? value(book.read, '') : 'No';
    form.querySelectorAll('[name=read]').forEach((r) => { r.checked = r.value === read; });
    form.date_read.max = localToday();
    form.date_read.value = book ? value(book.dateRead, '') || '' : '';
    form.rating.value = book ? String(value(book.rating, '') ?? '') : '';
    const used = book ? value(book.usedBy, []) : [];
    // Keep any name already on the book, even one with no matching agent, so saving never drops it.
    const options = [...new Set([...view.agents, ...used])];
    document.getElementById('used-by-options').innerHTML = options.map((o) => `
      <label class="check"><input type="checkbox" name="used_by" value="${esc(o)}" ${used.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('');
    form.notes.innerHTML = '<option value="">None</option>' + view.notesFiles.map((f) => `<option value="library/${esc(f)}">${esc(f)}</option>`).join('');
    form.notes.value = book && book.notes && !CNR(book.notes) ? (book.notes.path || '') : '';
    syncReadFields();
    formError.textContent = '';
    dialog.showModal();
    form.title.focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: form.title.value,
      author: form.author.value,
      read: form.read.value,
      date_read: form.date_read.value || null,
      rating: form.rating.value || null,
      used_by: [...form.querySelectorAll('[name=used_by]:checked')].map((c) => c.value),
      notes: form.notes.value || null,
    };
    if (!body.title.trim() || !body.author.trim()) { formError.textContent = 'Title and author are required.'; return; }
    if (!body.read) { formError.textContent = 'Choose whether you have read it.'; return; }
    try {
      if (editing) body.original = { title: editing.title, author: editing.author };
      view = editing
        ? await api(`/api/library/books/${editing.index}`, { method: 'PUT', body })
        : await api('/api/library/books', { method: 'POST', body });
      dialog.close();
      draw();
      statusEl.textContent = editing ? 'Book saved.' : 'Book added.';
    } catch (err) {
      formError.textContent = err.message;
    }
  });

  dialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dialog.close(); });
  document.getElementById('add-book').addEventListener('click', () => openBookDialog(null));
  document.getElementById('library-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (btn) openBookDialog(view.books.find((b) => b.index === Number(btn.dataset.edit)));
  });

  draw();
}

async function renderNotes(file) {
  const n = await api(`/api/library/notes?file=${encodeURIComponent(file)}`);
  app.innerHTML = `
    <p><a class="back" href="#/library">← Library</a></p>
    <div class="notes-head">
      <p class="muted">My notes on ${n.books.map((b) => `<strong>${esc(b.title)}</strong> (${esc(b.author)})`).join(', ')} · <code>${esc(n.path)}</code></p>
    </div>
    <article class="prose">${n.html}</article>`;
}

// ---------- Agents ----------

async function renderAgents() {
  const data = await api('/api/agents');
  const field = (label, html) => `<dt>${label}</dt><dd>${html ?? COULD_NOT_READ}</dd>`;
  const agentCount = data.cards.filter((c) => c.role === 'agent').length;
  const folderNote = !data.agentsFolderFound
    ? `<div class="notice">There is no <code>${esc(data.agentsFolder)}/</code> folder in the data folder, so only the coach is shown.</div>`
    : !agentCount ? `<div class="notice">The <code>${esc(data.agentsFolder)}/</code> folder has no agent files.</div>` : '';

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Agents</h1>
        <p class="muted page-sub">Read-only. From <code>CLAUDE.md</code> and <code>${esc(data.agentsFolder)}/</code>. “Review due” after ${data.reviewAfterDays} days.</p>
      </div>
    </div>
    ${warningsPanel(data.warnings)}
    ${folderNote}
    <div class="agent-grid">
      ${data.cards.map((c) => {
        const reviewed = c.lastReviewed
          ? `${fmtDate(c.lastReviewed)} <span class="muted">· ${c.daysSince === 0 ? 'today' : c.daysSince === 1 ? '1 day ago' : `${c.daysSince} days ago`}</span>`
          : null;
        const badge = !c.lastReviewed
          ? '<span class="badge badge-unknown">Review date unknown</span>'
          : c.reviewDue ? '<span class="badge badge-due">Review due</span>' : '<span class="badge badge-ok">Reviewed</span>';
        return `
          <article class="agent-card ${c.reviewDue ? 'is-due' : ''}">
            <header class="agent-head">
              <div>
                <h2>${c.name ? esc(c.name) : COULD_NOT_READ}</h2>
                <p class="agent-file"><code>${esc(c.file)}</code>${c.role === 'coach' ? ' · the coach' : ''}</p>
              </div>
              ${badge}
            </header>
            <dl class="agent-fields">
              ${field('Purpose', c.purposeHtml)}
              ${field('Sources it may read', c.sourcesHtml)}
              ${field('Last reviewed', reviewed)}
              ${c.tools ? field('Tools', esc(c.tools)) : ''}
            </dl>
            <h3>Rules</h3>
            ${c.rulesCaption ? `<p class="muted rules-caption">${esc(c.rulesCaption)}</p>` : ''}
            ${c.rulesHtml.length ? `<ol class="rules">${c.rulesHtml.map((r) => `<li>${r}</li>`).join('')}</ol>` : `<p>${COULD_NOT_READ}</p>`}
          </article>`;
      }).join('')}
    </div>`;
}

// ---------- Corrections ----------

function correctionDate(d) {
  if (CNR(d)) return COULD_NOT_READ;
  // Full dates are formatted like the rest of the site; partial ones ("2026-09") are shown as written.
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? fmtDate(d) : esc(d);
}

async function renderCorrections() {
  let view = await api('/api/corrections');
  const cell = (v) => (CNR(v) ? COULD_NOT_READ : esc(v));

  app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Corrections</h1>
        <p class="muted page-sub">What went wrong, who caught it, what I decided, and the rule it became. Newest first.</p>
      </div>
      <button type="button" class="btn btn-primary" id="add-correction">Add entry</button>
    </div>
    <div class="total-row">
      <span class="total-num" id="corrections-total"></span>
      <span id="corrections-total-label"></span>
    </div>
    <div id="corrections-warnings"></div>
    <div id="corrections-missing"></div>
    <p class="board-status" id="corrections-status" role="status" aria-live="polite"></p>
    <div class="table-wrap" id="corrections-table">
      <table class="data corrections">
        <colgroup><col class="c-date"><col class="c-where"><col class="c-what"><col class="c-who"><col class="c-decision"><col class="c-rule"></colgroup>
        <thead><tr>
          <th scope="col">Date</th><th scope="col">Where</th><th scope="col">What happened</th>
          <th scope="col">Who caught it</th><th scope="col">My decision</th><th scope="col">The rule it became</th>
        </tr></thead>
        <tbody id="corrections-body"></tbody>
      </table>
    </div>
    ${view.note ? `<p class="muted small file-note">Note in the file: ${esc(view.note)}</p>` : ''}

    <dialog class="dialog dialog-wide" id="correction-dialog" aria-labelledby="correction-h">
      <form id="correction-form" novalidate>
        <h2 id="correction-h">Add a correction</h2>
        <div class="field-row field-row-2">
          <label class="field"><span>Date</span>
            <input name="date" maxlength="10" placeholder="YYYY-MM-DD" aria-describedby="date-hint">
            <small class="muted" id="date-hint">YYYY-MM-DD</small>
          </label>
          <label class="field"><span>Who caught it</span>
            <input name="caught_by" maxlength="200" list="caught-by-options" autocomplete="off">
            <datalist id="caught-by-options"></datalist>
          </label>
        </div>
        <label class="field"><span>Where</span><input name="where" maxlength="200" placeholder="Which video, scene or step"></label>
        <label class="field"><span>What happened</span><textarea name="what" rows="3" maxlength="1500"></textarea></label>
        <label class="field"><span>My decision</span><textarea name="decision" rows="2" maxlength="1500"></textarea></label>
        <label class="field"><span>The rule it became</span><textarea name="rule" rows="2" maxlength="500"></textarea></label>
        <p class="form-error" id="correction-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">Add entry</button>
        </div>
      </form>
    </dialog>`;

  function draw() {
    const missing = view.fileFound === false;
    document.getElementById('corrections-missing').innerHTML = missing ? missingFile(view.file, 'no corrections') : '';
    document.getElementById('corrections-table').hidden = missing;
    document.getElementById('corrections-total').textContent = view.total;
    document.getElementById('corrections-total-label').textContent = view.total === 1 ? 'correction logged' : 'corrections logged';
    document.getElementById('corrections-warnings').innerHTML = warningsPanel(view.warnings);
    const rows = [...view.entries].sort((a, b) => {
      const x = CNR(a.date) ? '' : a.date, y = CNR(b.date) ? '' : b.date;
      return y.localeCompare(x) || b.index - a.index;
    });
    document.getElementById('corrections-body').innerHTML = rows.map((e) => `
      <tr>
        <td class="nowrap">${correctionDate(e.date)}</td>
        <td>${cell(e.where)}</td>
        <td>${cell(e.what)}</td>
        <td>${cell(e.caught_by)}</td>
        <td>${cell(e.decision)}</td>
        <td class="rule">${cell(e.rule)}</td>
      </tr>`).join('');
  }

  const dialog = document.getElementById('correction-dialog');
  const form = document.getElementById('correction-form');
  const errorEl = document.getElementById('correction-error');

  document.getElementById('add-correction').addEventListener('click', () => {
    form.reset();
    form.date.value = localToday();
    const catchers = [...new Set(view.entries.map((e) => e.caught_by).filter((c) => typeof c === 'string'))].sort();
    document.getElementById('caught-by-options').innerHTML = catchers.map((c) => `<option value="${esc(c)}">`).join('');
    errorEl.textContent = '';
    dialog.showModal();
    form.where.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(['date', 'where', 'what', 'caught_by', 'decision', 'rule'].map((f) => [f, form[f].value]));
    const missing = Object.entries(body).find(([, v]) => !v.trim());
    if (missing) { errorEl.textContent = 'Fill in every field.'; form[missing[0]].focus(); return; }
    try {
      view = await api('/api/corrections', { method: 'POST', body });
      dialog.close();
      draw();
      document.getElementById('corrections-status').textContent = 'Entry added.';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
  dialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dialog.close(); });

  draw();
}

// ---------- router ----------

const pages = {
  meetings: (arg) => (arg ? renderMeeting(arg) : renderMeetings()),
  board: renderBoard,
  library: (arg) => (arg?.startsWith('notes/') ? renderNotes(arg.slice(6)) : renderLibrary()),
  agents: renderAgents,
  corrections: renderCorrections,
};

async function route() {
  const [, page = 'meetings', ...rest] = location.hash.split('/');
  const name = pages[page] ? page : 'meetings';
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  document.querySelectorAll('.site-nav a').forEach((a) => {
    if (a.dataset.page === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.page = name;
  app.innerHTML = '<p class="muted loading">Loading…</p>';
  try {
    await pages[name](arg);
  } catch (err) {
    showError(err);
  }
  window.scrollTo(0, 0);
}

// Sticky table headers sit just below the sticky site header, whatever height it wraps to.
function trackHeaderHeight() {
  const header = document.querySelector('.site-header');
  const set = () => document.documentElement.style.setProperty('--sticky-top', `${header.offsetHeight}px`);
  new ResizeObserver(set).observe(header);
  set();
}

async function start() {
  trackHeaderHeight();
  try {
    state.config = await api('/api/config');
    document.getElementById('demo-badge').hidden = !state.config.demo;
  } catch { /* the page still works without the badge */ }
  window.addEventListener('hashchange', route);
  route();
}

start();
