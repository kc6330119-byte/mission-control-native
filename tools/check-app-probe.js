// Run inside the app window by tools/check-app.mjs (app built with --features probe). It uses the pages the
// way a person would: clicks, form fields, the switch, a reload. It reports by requesting /__probe/<what>,
// which the app prints. MODE is replaced by the check script: "session", "restart", "welcome" or "missing".
(async () => {
  if (window.__probed) return;
  window.__probed = true;
  const MODE = '__MODE__';
  const report = (what, data) => fetch(`/__probe/${what}?${encodeURIComponent(JSON.stringify(data ?? null))}`).catch(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (f, label, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); }
    throw new Error(`timed out waiting for ${label}`);
  };
  const app = document.getElementById('app');
  const go = async (hash) => {
    location.hash = hash;
    await sleep(80);
    await waitFor(() => !app.querySelector('.loading'), `${hash} to load`);
    await sleep(150);
  };
  const pageState = (name) => ({
    name,
    error: app.querySelector('.notice-error')?.textContent.trim() || null,
    invalidDate: document.body.innerText.includes('Invalid Date'),
    couldNotRead: (document.body.innerText.match(/could not read/g) || []).length,
    title: document.title,
    demoBadge: !document.getElementById('demo-badge').hidden,
    textLength: app.innerText.length,
  });
  // A screenshot is never taken while a private note is on the page or the switch is on.
  const shot = async (name) => {
    const privateOnScreen = !!document.querySelector('.private-note') || document.getElementById('private-switch')?.checked === true;
    if (privateOnScreen) { await report('shot-refused', { name }); return; }
    await report('shot', name);
    await sleep(1200);
  };
  const json = async (path) => (await fetch(path, { cache: 'no-store' })).json();
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  const privateMeeting = async () => {
    for (const m of (await json('/api/meetings')).meetings) {
      if ((await json(`/api/meeting?file=${encodeURIComponent(m.file)}`)).privateNotes > 0) return m.file;
    }
    return null;
  };
  const switchState = () => ({ on: document.getElementById('private-switch')?.checked ?? null, privateNotesShown: app.querySelectorAll('.private-note').length });

  // The page must not be able to call the app: every Tauri command is refused.
  const appCalls = async () => {
    const t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== 'function') return { bridge: false };
    const attempt = async (cmd, args) => { try { await t.invoke(cmd, args); return 'ALLOWED'; } catch (e) { return `refused: ${String(e).slice(0, 90)}`; } };
    return {
      bridge: true,
      dialog: await attempt('plugin:dialog|open', { options: { directory: true } }),
      opener: await attempt('plugin:opener|open_url', { url: 'https://example.com/from-the-page' }),
      fs: await attempt('plugin:fs|read_text_file', { path: '/etc/hosts' }),
    };
  };

  try {
    if (document.body.classList.contains('welcome')) {
      const shown = (sel) => [...document.querySelectorAll(sel)].filter((el) => !el.closest('[hidden]'));
      await report('welcome', {
        mode: MODE,
        name: document.getElementById('welcome-name').textContent,
        title: document.title,
        text: shown('.welcome-text p').map((p) => p.textContent.trim()),
        buttons: shown('.welcome-actions a').map((a) => a.textContent.trim()),
        primary: [...document.querySelectorAll('.welcome-actions .btn-primary')].map((a) => a.textContent.trim()),
        focused: document.activeElement?.textContent.trim() ?? null,
        appCalls: await appCalls(),
      });
      await shot(MODE === 'missing' ? 'welcome-missing-folder' : 'welcome');
      const button = document.querySelector(MODE === 'missing' ? 'a[href="/welcome/quit"]' : 'a[href="/welcome/choose"]');
      await report('welcome-click', button.textContent.trim());
      button.click();
      return;
    }
    await waitFor(() => document.querySelector('.site-nav'), 'the page');
    if (MODE === 'missing-files' || MODE === 'unreadable-files') {
      const page = async (hash, missingId, tableId) => {
        await go(hash);
        return {
          error: app.querySelector('.notice-error')?.textContent.trim() || null,
          notice: document.getElementById(missingId)?.textContent.trim() || null,
          tableShown: document.getElementById(tableId) ? !document.getElementById(tableId).hidden : null,
        };
      };
      const library = await page('#/library', 'library-missing', 'library-table');
      const corrections = await page('#/corrections', 'corrections-missing', 'corrections-table');
      const result = { library, corrections };
      if (MODE === 'missing-files') {
        // What adding does today in such a workspace (the saving rules are unchanged).
        await go('#/library');
        document.getElementById('add-book').click();
        const bf = document.getElementById('book-form');
        bf.title.value = 'Radical Candor';
        bf.author.value = 'Kim Scott';
        bf.querySelector('[name=read][value=No]').checked = true;
        bf.requestSubmit();
        await waitFor(() => document.getElementById('book-error').textContent || document.getElementById('library-status').textContent, 'the book answer');
        result.addBook = document.getElementById('book-error').textContent || document.getElementById('library-status').textContent;
        await go('#/corrections');
        document.getElementById('add-correction').click();
        const cf = document.getElementById('correction-form');
        for (const [k, v] of [['where', 'App check'], ['what', 'Adding to a workspace without the log.'], ['caught_by', 'check-app'], ['decision', 'See what happens.'], ['rule', 'None.']]) cf[k].value = v;
        cf.requestSubmit();
        await waitFor(() => document.getElementById('correction-error').textContent || document.getElementById('corrections-status').textContent, 'the correction answer');
        result.addCorrection = document.getElementById('correction-error').textContent || document.getElementById('corrections-status').textContent;
      }
      await report(MODE, result);
      await report('done');
      return;
    }
    if (MODE === 'welcome') {
      await report('main-after-welcome', { url: location.href, appCalls: await appCalls() });
      await report('done');
      return;
    }
    await report('ready', { url: location.href, mode: MODE });

    if (MODE === 'restart') {
      await go(`#/meetings/${encodeURIComponent(await privateMeeting())}`);
      await report('switch-after-restart', switchState());
      await report('done');
      return;
    }

    if (sessionStorage.getItem('probe-phase') !== 'reloaded') {
      // ---- every page ----
      for (const [hash, name] of [['#/meetings', 'meetings'], ['#/board', 'board'], ['#/library', 'library'], ['#/agents', 'agents'], ['#/corrections', 'corrections']]) {
        await go(hash);
        await report('page', pageState(name));
        await shot(name);
      }
      for (const m of (await json('/api/meetings')).meetings) {
        await go(`#/meetings/${encodeURIComponent(m.file)}`);
        await report('page', pageState(`meeting ${m.file}`));
      }
      for (const f of (await json('/api/library')).notesFiles) {
        await go(`#/library/notes/${encodeURIComponent(f)}`);
        await report('page', pageState(`notes ${f}`));
      }

      // ---- board: import, move with the → button, then a drag to Done ----
      await go('#/board');
      await report('board-empty', { cards: app.querySelectorAll('.card').length, todo: app.querySelector('.column[data-column=todo] .column-empty')?.textContent ?? null });
      await shot('board-empty');
      document.getElementById('import-btn').click();
      await waitFor(() => /^Added/.test(document.getElementById('board-status').textContent), 'the import');
      const first = app.querySelector('.column[data-column=todo] .card');
      const movedId = first.dataset.id;
      first.querySelector('button[data-act=move][data-to=doing]').click();
      await waitFor(() => app.querySelector(`.column[data-column=doing] .card[data-id="${movedId}"]`), 'the moved card');
      const afterMove = (await json('/api/board')).board.cards.find((c) => c.id === movedId);
      await report('card-moved', { id: movedId, column: afterMove.column });
      const dragged = app.querySelector('.column[data-column=todo] .card');
      const draggedId = dragged.dataset.id;
      const done = app.querySelector('.column[data-column=done] .cards');
      const box = done.getBoundingClientRect();
      const dt = new DataTransfer();
      dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await sleep(100);
      for (const type of ['dragover', 'drop']) done.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 10, dataTransfer: dt }));
      dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      await waitFor(() => app.querySelector(`.column[data-column=done] .card[data-id="${draggedId}"]`), 'the dragged card');
      await report('card-dragged', { id: draggedId, column: (await json('/api/board')).board.cards.find((c) => c.id === draggedId).column });
      await shot('board-after-moves');

      // ---- library: add a book through the form ----
      await go('#/library');
      document.getElementById('add-book').click();
      const bf = document.getElementById('book-form');
      bf.title.value = 'Radical Candor';
      bf.author.value = 'Kim Scott';
      const yes = bf.querySelector('[name=read][value=Yes]');
      yes.checked = true;
      yes.dispatchEvent(new Event('change', { bubbles: true }));
      bf.date_read.value = '2024-03-01';
      bf.rating.value = '4';
      bf.requestSubmit();
      await waitFor(() => document.getElementById('library-status').textContent === 'Book added.' || document.getElementById('book-error').textContent, 'the book');
      await report('book-saved', { status: document.getElementById('library-status').textContent, error: document.getElementById('book-error').textContent, max: bf.date_read.max });

      // ---- corrections: add an entry through the form ----
      await go('#/corrections');
      document.getElementById('add-correction').click();
      const cf = document.getElementById('correction-form');
      const presetDate = cf.date.value;
      cf.where.value = 'App check';
      cf.what.value = 'Checked that a correction saves from the app window.';
      cf.caught_by.value = 'check-app';
      cf.decision.value = 'Keep the check.';
      cf.rule.value = 'Run the app check before each step review.';
      cf.requestSubmit();
      await waitFor(() => document.getElementById('corrections-status').textContent === 'Entry added.' || document.getElementById('correction-error').textContent, 'the correction');
      await report('correction-saved', { status: document.getElementById('corrections-status').textContent, error: document.getElementById('correction-error').textContent, presetDate });

      // ---- private notes: off on load, on with the switch, off again after a reload ----
      await go(`#/meetings/${encodeURIComponent(await privateMeeting())}`);
      await report('switch-on-load', switchState());
      document.getElementById('private-switch').click();
      await waitFor(() => app.querySelector('.private-note'), 'the private note');
      await report('switch-turned-on', switchState());
      sessionStorage.setItem('probe-phase', 'reloaded');
      location.reload();
      return;
    }

    // ---- after the reload ----
    sessionStorage.removeItem('probe-phase');
    await waitFor(() => document.getElementById('private-switch'), 'the meeting after the reload');
    await sleep(300);
    await report('switch-after-reload', switchState());

    // ---- links to websites open in the browser, not in this window ----
    const before = location.href;
    const a = Object.assign(document.createElement('a'), { href: 'https://example.com/', textContent: 'example' });
    app.append(a);
    a.click();
    await sleep(1200);
    await report('external-link', { stayed: location.href === before, href: location.href });
    window.open('https://example.com/', '_blank');
    await sleep(1200);
    await report('external-window-open', { stayed: location.href === before });
    a.remove();

    // ---- content security policy: nothing from elsewhere, no inline script ----
    new Image().src = 'https://example.com/csp-check.png';
    fetch('https://example.com/csp-check').catch(() => {});
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.body.append(s);
    await sleep(1200);
    await report('csp', { violations, inlineScriptRan: window.__inlineRan === true });
  } catch (e) {
    await report('error', String((e && e.stack) || e));
  }
  await report('done');
})();
