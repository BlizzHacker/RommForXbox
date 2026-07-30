/* On-screen keyboard driven entirely by the controller.
 *
 * Xbox pops its own keyboard for a focused <input>, but only in the browser and
 * only sometimes; a packaged app that asks for a server URL cannot depend on
 * that. This is self-contained so text entry always works with just a pad.
 *
 * Rows may differ in length — column is clamped on row change, which is what
 * makes the wide action row navigable without a special case. */
'use strict';

const OSK = (() => {
  // ':' has to be here — without it "host:8080" is untypeable, which is how the
  // first console test failed. Rows may differ in length by design, so the two
  // that carry the URL punctuation are simply wider.
  const LOWER = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l',':','-'],
    ['z','x','c','v','b','n','m','.','_','/','@'],
  ];
  const UPPER = LOWER.map((r, i) =>
    i === 0 ? ['!','@','#','$','%','^','&','*','(',')','?','=']
            : r.map(k => k.toUpperCase()));
  const ACTIONS = [
    { label: 'Shift', act: 'shift' },
    { label: 'http://', act: 'ins', text: 'http://' },
    { label: 'https://', act: 'ins', text: 'https://' },
    { label: ':8080', act: 'ins', text: ':8080' },
    { label: '.com', act: 'ins', text: '.com' },
    { label: 'Delete', act: 'del' },
    { label: 'Done', act: 'ok' },
  ];

  let active = false, shift = false, row = 0, col = 0;
  let value = '', mask = false, opts = null;

  const el = id => document.getElementById(id);
  const rows = () => [...(shift ? UPPER : LOWER), ACTIONS];

  function render(status) {
    const grid = el('osk-keys');
    grid.innerHTML = '';
    rows().forEach((r, ri) => {
      const line = document.createElement('div');
      line.className = 'osk-row' + (ri === 4 ? ' osk-actions' : '');
      r.forEach((k, ci) => {
        const d = document.createElement('div');
        const label = typeof k === 'string' ? k : k.label;
        d.className = 'key' + (ri === row && ci === col ? ' focus' : '');
        d.textContent = label;
        line.appendChild(d);
      });
      grid.appendChild(line);
    });
    el('osk-value').textContent =
      (mask ? '•'.repeat(value.length) : value) || ' ';
    if (status !== undefined) el('osk-status').textContent = status;
    saveDraft();            // every visible change is a checkpoint
  }

  /* Drafts survive the app dying mid-typing.
   *
   * On Xbox the B button is the console's own "back" and the shell has to claim
   * it; if that ever fails, the app closes. Losing a half-typed server address to
   * that is the single most annoying thing that can happen on this screen, so the
   * text is persisted as it is typed and offered back on the next launch.
   * Passwords are never persisted. */
  const draftKey = o => (o && o.password) ? null
    : 'osk_draft_' + String((o && o.title) || 'field').replace(/\W+/g, '_');

  function saveDraft() {
    const k = draftKey(opts);
    if (!k) return;
    try {
      if (value) localStorage.setItem(k, value);
      else localStorage.removeItem(k);
    } catch (_) { /* storage full or blocked; drafts are a nicety */ }
  }

  function clearDraft() {
    const k = draftKey(opts);
    if (!k) return;
    try { localStorage.removeItem(k); } catch (_) {}
  }

  function open(o) {
    opts = o;
    value = o.value || '';
    mask = !!o.password;
    // Only restore when the caller had nothing to prefill, so an existing setting
    // always wins over a stale draft.
    if (!value) {
      const k = draftKey(o);
      if (k) {
        try { value = localStorage.getItem(k) || ''; } catch (_) {}
      }
    }
    shift = false; row = 0; col = 0;
    active = true;
    el('osk-title').textContent = o.title || '';
    el('osk-hint').textContent = o.hint || '';
    el('view-osk').classList.remove('hidden');
    logReset();             // last attempt's transcript is not this attempt's
    render(o.status || '');
  }

  function close() {
    active = false;
    opts = null;
    el('view-osk').classList.add('hidden');
  }

  function press() {
    const r = rows()[row];
    const k = r[col];
    if (typeof k === 'string') {
      value += k;
      if (shift) { shift = false; row = Math.min(row, rows().length - 1); }
      return render('');
    }
    if (k.act === 'shift') { shift = !shift; return render(); }
    if (k.act === 'ins') { value += k.text; return render(''); }
    if (k.act === 'del') { value = value.slice(0, -1); return render(''); }
    if (k.act === 'ok') return submit();
  }

  function submit() {
    const cb = opts && opts.onSubmit;
    // Cleared before the callback runs: if it succeeds the draft is stale, and if
    // it fails the value is still on screen to correct.
    clearDraft();
    if (cb) cb(value, { status: render, close });
  }

  function input(btn) {
    const rs = rows();
    if (btn === 'up') { row = (row + rs.length - 1) % rs.length; col = Math.min(col, rs[row].length - 1); }
    else if (btn === 'down') { row = (row + 1) % rs.length; col = Math.min(col, rs[row].length - 1); }
    else if (btn === 'left') col = (col + rs[row].length - 1) % rs[row].length;
    else if (btn === 'right') col = (col + 1) % rs[row].length;
    else if (btn === 'a') return press();
    // Backspace is X, not B. On Xbox the shell owns B as "back" and will close
    // the app if anything lets it through, so B must never be load-bearing
    // here — a dropped backspace is an annoyance, a dropped app is not.
    else if (btn === 'x') { value = value.slice(0, -1); return render(''); }
    else if (btn === 'y') { shift = !shift; }
    else if (btn === 'start') return submit();
    else if (btn === 'b') { if (opts && opts.onCancel) return opts.onCancel(); return; }
    else return;
    render();
  }

  // Physical typing stays available — useful with a USB keyboard on the
  // console, and it is how the app gets driven under test. While the keyboard
  // is open it is the only consumer of key events (see gamepad.js), so the
  // grid keys are handled here too.
  const NAV = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
                ArrowRight: 'right' };
  window.addEventListener('keydown', e => {
    if (!active) return;
    if (NAV[e.key]) { e.preventDefault(); return input(NAV[e.key]); }
    if (e.key === 'Backspace') { value = value.slice(0, -1); e.preventDefault(); return render(''); }
    if (e.key === 'Enter') { e.preventDefault(); return submit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (opts && opts.onCancel) opts.onCancel();
      return;
    }
    if (e.key.length === 1) { value += e.key; e.preventDefault(); render(''); }
  });

  /* A running log of what a connection attempt is doing.
   *
   * A single status line cannot say whether the app is still waiting or has
   * quietly stopped, which is how a silent server read as "nothing happens".
   * Each step is a line; steps that are in progress are marked and then resolved,
   * so a stalled attempt is visibly stalled at a named step. */
  function logReset() {
    const l = el('osk-log');
    if (!l) return;
    l.innerHTML = '';
    l.classList.add('hidden');
  }

  function logAdd(text, kind) {
    const l = el('osk-log');
    if (!l) return null;
    l.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = kind || 'busy';
    li.textContent = text;
    l.appendChild(li);
    return li;
  }

  return {
    open, close, input, submit,
    get active() { return active; },
    get value() { return value; },
    setStatus(s) { if (active) el('osk-status').textContent = s; },
    logReset, logAdd,
    // Resolve a line returned by logAdd in place, so the log reads as a
    // transcript rather than growing a second line per outcome.
    logDone(li, text, kind) {
      if (!li) return;
      li.textContent = text;
      li.className = kind || 'ok';
    },
  };
})();
