/* skribbl word helper -- reads the live hint row and shows which words still fit.
 *
 * DOM contract (from skribbl.io/js/game.js):
 *   #game-word .hints .container   one <div class="hint"> per character, "_"
 *                                  while hidden, the letter + .uncover once
 *                                  revealed. Spaces get a slot too.
 *   ... .word-length               trailing div, e.g. "3 5" for "hot dog".
 *                                  Absent in "word hidden" mode (slots are "?").
 *   #game-word .word               the word itself, shown only while you draw.
 *   #game-chat form input          the guess box.
 *   #game-chat .chat-content p     chat lines, coloured with an inline
 *                                  var(--COLOR_CHAT_TEXT_<KIND>).
 *   #game-canvas ... .reveal .word end-of-round reveal.
 *
 * The panel lives in a shadow root, so skribbl's stylesheet and this one can
 * never reach into each other.
 */
(() => {
  'use strict';

  // Never build two panels, whatever causes a second run.
  if (document.getElementById('skribbl-word-helper')) return;

  const SEL = {
    gameWord: '#game-word',
    hints: '#game-word .hints .container',
    drawWord: '#game-word .word',
    chatForm: '#game-chat form',
    chatInput: '#game-chat form input',
    chatContent: '#game-chat .chat-content',
    reveal: '#game-canvas .overlay-content .reveal .word',
  };

  const MAX_CHIPS = 300;
  const BUILTIN = new Set(SKRIBBL_WORDS);

  /* ---------- persisted state ---------- */

  const store = {
    seen: Object.create(null),    // word -> times it came up in a round
    panel: { x: null, y: null, collapsed: false, showAll: false },
  };
  let pool = SKRIBBL_WORDS.slice();

  function rebuildPool() {
    const extra = Object.keys(store.seen).filter((w) => !BUILTIN.has(w));
    pool = SKRIBBL_WORDS.concat(extra);
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ seen: store.seen, panel: store.panel });
    }, 400);
  }

  /* ---------- reading the game ---------- */

  function readState() {
    const draw = document.querySelector(SEL.drawWord);
    if (draw && draw.offsetParent && draw.textContent.trim()) {
      return { mode: 'drawing', word: draw.textContent.trim() };
    }

    const cont = document.querySelector(SEL.hints);
    if (!cont || !cont.offsetParent) return { mode: 'idle' };

    const hints = Array.from(cont.querySelectorAll('.hint'));
    if (!hints.length) return { mode: 'idle' };
    if (hints.every((h) => h.textContent.trim() === '?')) return { mode: 'hidden' };

    const slots = hints.map((h) => {
      const t = h.textContent.replace(/\s+/g, '');
      return t === '' || t === '_' || t === '?' ? null : t.toLowerCase();
    });

    const lenEl = cont.querySelector('.word-length');
    const lengths = lenEl
      ? lenEl.textContent.trim().split(/\s+/).map(Number).filter((n) => n > 0)
      : null;

    return { mode: 'guessing', slots: slots, lengths: lengths };
  }

  function fits(word, slots, lengths) {
    if (word.length !== slots.length) return false;
    if (lengths) {
      const parts = word.split(' ');
      if (parts.length !== lengths.length) return false;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].length !== lengths[i]) return false;
      }
    }
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] !== null && word[i] !== slots[i]) return false;
    }
    return true;
  }

  function patternText(st) {
    const chars = st.slots.map((s) => (s === null ? '_' : s));
    if (!st.lengths) return chars.join(' ');
    const parts = [];
    let i = 0;
    for (const len of st.lengths) {
      parts.push(chars.slice(i, i + len).join(' '));
      i += len + 1;
    }
    return parts.join('   ');
  }

  // One array of slots per word, so the pattern can be drawn as letter tiles
  // with real gaps between words instead of a run of underscores.
  function wordGroups(st) {
    const lens = st.lengths || [st.slots.length];
    const groups = [];
    let i = 0;
    for (const len of lens) {
      const g = [];
      for (let k = 0; k < len; k++, i++) g.push(i < st.slots.length ? st.slots[i] : null);
      groups.push(g);
      i++;                                  // skip the slot standing in for the space
    }
    return groups;
  }

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  const tried = new Set();        // guesses I have sent this round
  const ruledOut = new Set();     // wrong guesses seen in chat this round
  let closeWord = null;           // the guess the game called "close"
  let roundKey = '';
  let typed = '';                 // what you are typing in the guess box

  // Weights, and why they are what they are:
  //   Within a matching set skribbl picks uniformly, so with no evidence every
  //   candidate is 1/N -- the weights below only move when evidence exists.
  //   CLOSE: the server only says "close" for a near-miss, so distance 1 is
  //   nearly conclusive and distance >=3 is very unlikely (but not impossible --
  //   the exact threshold is server-side, so it is down-weighted, not excluded).
  //   SEEN: a word that has come up in a reveal is definitely in this room's
  //   list, and the count also picks up which words drawers tend to choose.
  const W_CLOSE1 = 40, W_CLOSE2 = 6, W_CLOSE_FAR = 0.15;

  // Fallback tiers. skribbl picks from its own list, so those always outrank
  // these; a dictionary word is only ever a guess about a custom-word room.
  const W_GOOD = 0.25;          // common / drawable English
  const W_REST = 0.02;          // the rest of the Scrabble dictionary
  let extrasRaw = null;         // the fetched JSON, or null
  let extrasState = 'idle';     // idle | loading | ready | failed
  const extraCache = { good: {}, rest: {} };
  let customRoom = false;       // a revealed word was not in skribbl's own list

  // 2.9MB of dictionary is not worth loading for a normal round, so it is a
  // web-accessible file fetched the first time a round actually needs it.
  function loadExtras() {
    if (extrasState !== 'idle') return;
    extrasState = 'loading';
    fetch(chrome.runtime.getURL('words-extra.json'))
      .then((r) => r.json())
      .then((j) => { extrasRaw = j; extrasState = 'ready'; sig = ''; render(); })
      .catch(() => { extrasState = 'failed'; sig = ''; render(); });
  }

  // One length bucket, split from its newline-joined string on first use.
  function extraBucket(tier, len) {
    if (!extrasRaw) return [];
    const cache = extraCache[tier];
    if (cache[len] === undefined) {
      const raw = (extrasRaw[tier] || {})[len];
      cache[len] = raw ? raw.split('\n') : [];
    }
    return cache[len];
  }

  function scored(st) {
    const out = [];
    const taken = new Set();
    for (const w of pool) {
      if (!fits(w, st.slots, st.lengths)) continue;
      // Out of the running: guesses anyone has already made (from chat) and
      // guesses you just sent. Yours drop out on the keystroke rather than when
      // the game echoes them back, so slot 3 refills instantly.
      if (ruledOut.has(w) || tried.has(w)) continue;
      let weight = 1;
      let reason = '';
      if (closeWord) {
        const d = lev(w, closeWord);
        if (d === 1) { weight *= W_CLOSE1; reason = '1 letter off "' + closeWord + '"'; }
        else if (d === 2) { weight *= W_CLOSE2; reason = '2 letters off "' + closeWord + '"'; }
        else weight *= W_CLOSE_FAR;
      }
      const seen = store.seen[w] || 0;
      if (seen) {
        weight *= 1 + Math.min(seen, 5) * 0.6;
        if (!reason) reason = 'seen ' + seen + '× before';
      }
      taken.add(w);
      out.push({ w: w, weight: weight, reason: reason, tier: BUILTIN.has(w) ? 'skribbl' : 'learned' });
    }

    // Dictionary tiers, only when skribbl's own list cannot explain the round.
    // They hold single words, so a multi-word pattern can skip them entirely.
    if ((customRoom || !out.length) && (!st.lengths || st.lengths.length === 1)) {
      loadExtras();
      const len = st.slots.length;
      for (const tier of ['good', 'rest']) {
        const base = tier === 'good' ? W_GOOD : W_REST;
        const arr = extraBucket(tier, len);
        for (let i = 0; i < arr.length; i++) {
          const w = arr[i];
          if (taken.has(w) || ruledOut.has(w) || tried.has(w)) continue;
          if (!fits(w, st.slots, null)) continue;
          // decays with position so the frequency order inside a tier survives
          let weight = base * (1 - (i / arr.length) * 0.5);
          let reason = tier === 'good' ? 'common word, not on skribbl\u2019s list' : 'dictionary word';
          if (closeWord) {
            const d = lev(w, closeWord);
            if (d === 1) { weight *= W_CLOSE1; reason = '1 letter off "' + closeWord + '"'; }
            else if (d === 2) { weight *= W_CLOSE2; reason = '2 letters off "' + closeWord + '"'; }
            else weight *= W_CLOSE_FAR;
          }
          taken.add(w);
          out.push({ w: w, weight: weight, reason: reason, tier: tier });
        }
      }
    }

    let total = 0;
    for (const c of out) total += c.weight;
    for (const c of out) c.share = total ? c.weight / total : 0;
    out.sort((a, b) => b.weight - a.weight || a.w.localeCompare(b.w));
    return out;
  }

  /* ---------- evidence out of the chat ---------- */

  // Te() in game.js paints every chat line with an inline
  // color: var(--COLOR_CHAT_TEXT_<KIND>), which is language-independent --
  // the visible text is translated, the CSS variable name is not.
  function chatKind(p) {
    const c = p.style && p.style.color || '';
    if (c.indexOf('COLOR_CHAT_TEXT_CLOSE') !== -1) return 'close';
    if (c.indexOf('COLOR_CHAT_TEXT_BASE') !== -1) return 'base';
    return 'other';
  }

  function lineText(p) {
    const span = p.querySelector('span');
    return span ? span.textContent.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  }

  function onChatLine(p) {
    const kind = chatKind(p);

    if (kind === 'base') {
      // A correct guess is never printed as text -- game.js replaces it with a
      // "$ guessed the word!" system line. So anything here is a wrong guess.
      const t = lineText(p);
      if (t) { ruledOut.add(t); schedule(); }
      return;
    }

    if (kind === 'close') {
      // "<name> is close!" -- walk back to that player's own last guess. The
      // name is interpolated into the translated string, so match on it.
      const who = (p.querySelector('b') || {}).textContent || '';
      let fallback = null;
      for (let prev = p.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (chatKind(prev) !== 'base') continue;
        const nameEl = prev.querySelector('b');
        const name = nameEl ? nameEl.textContent.replace(/:\s*$/, '').trim() : '';
        if (!fallback) fallback = prev;
        if (name && who.indexOf(name) !== -1) { fallback = prev; break; }
      }
      const w = fallback ? lineText(fallback) : '';
      if (w) { closeWord = w; schedule(); }
    }
  }

  function watchChat() {
    const chat = document.querySelector(SEL.chatContent);
    if (!chat) return;
    // Only new lines -- existing ones are from earlier rounds.
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'P') onChatLine(node);
        }
      }
    }).observe(chat, { childList: true });
  }

  /* ---------- learning from round reveals ---------- */

  let lastReveal = '';
  function checkReveal() {
    const el = document.querySelector(SEL.reveal);
    if (!el) return;
    const w = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!w || w === lastReveal) return;
    lastReveal = w;
    store.seen[w] = (store.seen[w] || 0) + 1;
    if (!BUILTIN.has(w)) {
      // skribbl never picked this, so this room is running custom words --
      // open the dictionary tiers for the rest of the session.
      customRoom = true;
      rebuildPool();
    }
    save();
  }

  /* ---------- panel ---------- */

  let ui = null;

  const MARKUP = [
    '<div class="panel">',
    '  <div class="head">',
    '    <span class="grip"></span>',
    '    <span class="name">word helper</span>',
    '    <span class="lead"></span>',
    '    <span class="count"></span>',
    '    <button class="fold" type="button"></button>',
    '  </div>',
    '  <div class="body">',
    '    <div class="board"></div>',
    '    <div class="state"></div>',
    '    <div class="evidence"></div>',
    '    <div class="sect"><span class="label"></span><button class="narrow" type="button" hidden>clear</button></div>',
    '    <div class="top"></div>',
    '    <button class="allbtn" type="button" hidden></button>',
    '    <div class="rest"></div>',
    '    <div class="foot"></div>',
    '  </div>',
    '</div>',
  ].join('\n');

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'skribbl-word-helper';
    host.style.cssText =
      'all:initial;position:fixed;z-index:2147483000;top:14px;right:14px;visibility:hidden';
    const root = host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('panel.css');
    const show = () => { host.style.visibility = 'visible'; };
    link.addEventListener('load', show);
    setTimeout(show, 1200);        // show it even if the stylesheet never loads
    root.appendChild(link);

    const wrap = document.createElement('div');
    wrap.innerHTML = MARKUP;
    root.appendChild(wrap.firstElementChild);
    document.body.appendChild(host);

    const q = (s) => root.querySelector(s);
    ui = {
      host: host, root: root, panel: q('.panel'), head: q('.head'),
      lead: q('.lead'), count: q('.count'), fold: q('.fold'),
      board: q('.board'), state: q('.state'), evidence: q('.evidence'),
      label: q('.label'), narrow: q('.narrow'), top: q('.top'),
      allbtn: q('.allbtn'), rest: q('.rest'), foot: q('.foot'),
    };

    ui.fold.addEventListener('click', () => setCollapsed(!store.panel.collapsed));
    ui.narrow.addEventListener('click', clearTyped);
    ui.allbtn.addEventListener('click', () => {
      store.panel.showAll = !store.panel.showAll;
      save();
      sig = '';
      render();
    });

    const pick = (e) => {
      const el = e.target.closest('[data-word]');
      if (!el) return;
      guess(el.dataset.word, el.hasAttribute('data-send') || e.detail >= 2, e.isTrusted);
    };
    ui.top.addEventListener('click', pick);
    ui.rest.addEventListener('click', pick);

    makeDraggable();
    if (store.panel.x !== null) placeAt(store.panel.x, store.panel.y);
    else autoPlace();
    setCollapsed(store.panel.collapsed);
  }

  function setCollapsed(v) {
    store.panel.collapsed = v;
    ui.panel.classList.toggle('is-folded', v);
    ui.fold.title = v ? 'Expand (Alt+S)' : 'Collapse (Alt+S)';
    save();
  }

  const EDGE = 10;

  function moveTo(x, y) {
    const w = ui.host.offsetWidth || 208;
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 40));
    ui.host.style.left = x + 'px';
    ui.host.style.top = y + 'px';
    ui.host.style.right = 'auto';
    return [x, y];
  }

  function placeAt(x, y) {
    const at = moveTo(x, y);
    store.panel.x = at[0];
    store.panel.y = at[1];
  }

  // Until you drag it, sit in whichever margin beside the board is wide enough
  // to hold the panel, so it never covers the canvas. Only if neither side has
  // room does it fall back to overlapping in the corner.
  let lastAuto = '';

  function autoPlace() {
    if (store.panel.x !== null) return;
    // The viewport can still measure 0 while the page is loading, and a board
    // that has not been laid out yet gives a useless rect -- so this runs again
    // on every repaint and only moves the panel when the answer changes.
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh) return;

    const w = ui.host.offsetWidth || 208;
    let x = vw - w - EDGE, y = EDGE;
    let placed = false;

    // 1. a margin beside the board, if the window is wider than the game
    const board = document.querySelector('#game-wrapper') || document.querySelector('#game-canvas');
    if (board && board.offsetParent) {
      const r = board.getBoundingClientRect();
      if (r.width) {
        const top = Math.max(EDGE, Math.round(r.top));
        if (vw - r.right >= w + EDGE * 2) { x = vw - w - EDGE; y = top; placed = true; }
        else if (r.left >= w + EDGE * 2) { x = EDGE; y = top; placed = true; }
      }
    }

    // 2. otherwise over the chat column. skribbl's desktop grid is
    //    "players canvas chat" with a 300px chat, so a 208px panel sits inside
    //    it and the drawing stays completely visible.
    if (!placed) {
      const chat = document.querySelector(SEL.chatContent) || document.querySelector('#game-chat');
      const col = chat && chat.closest ? (chat.closest('#game-chat') || chat) : chat;
      if (col && col.offsetParent) {
        const c = col.getBoundingClientRect();
        // Only if the panel actually fits inside the visible part of that
        // column -- otherwise clamping it to the viewport would drag it back
        // across the canvas, which is the thing we are avoiding.
        if (c.width >= w && c.height > 60 && c.left + w + EDGE <= vw) {
          x = Math.round(Math.min(c.right - w, vw - w - EDGE));
          y = Math.max(EDGE, Math.round(c.top));
          placed = true;
        }
      }
    }
    const target = x + ',' + y;
    if (target === lastAuto) return;
    lastAuto = target;
    moveTo(x, y);
  }

  function makeDraggable() {
    let dx = 0, dy = 0, dragging = false;
    ui.head.addEventListener('mousedown', (e) => {
      if (e.target === ui.fold) return;
      const r = ui.host.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      dragging = true;
      ui.panel.classList.add('is-dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (dragging) placeAt(e.clientX - dx, e.clientY - dy); });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      ui.panel.classList.remove('is-dragging');
      save();
    });
  }

  // Sending is guarded three ways, because a stray click here types into a live
  // game and skribbl rate-limits chat ("Spam detected!"):
  //   - only a real user gesture can send (isTrusted), never a script or a
  //     synthetic event replayed by the page or a tool;
  //   - never the same word twice in a round;
  //   - never twice inside SEND_COOLDOWN.
  const SEND_COOLDOWN = 700;
  let lastSent = 0;

  function guess(word, send, trusted) {
    const input = document.querySelector(SEL.chatInput);
    if (!input) return;
    input.value = word;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The game needs that input event, but this is the panel filling the box,
    // not you typing -- so it must not narrow the list to the word it just put
    // there, or picks 2 and 3 would vanish the moment you took pick 1.
    typed = '';
    input.focus();
    if (!send) { schedule(); return; }

    const now = Date.now();
    if (!trusted || tried.has(word) || now - lastSent < SEND_COOLDOWN) return;
    lastSent = now;
    tried.add(word);

    const form = document.querySelector(SEL.chatForm);
    if (form && form.requestSubmit) form.requestSubmit();
    else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    typed = '';
    render();
  }

  function clearTyped() {
    typed = '';
    const input = document.querySelector(SEL.chatInput);
    if (input) { input.value = ''; input.focus(); }
    render();
  }

  /* ---------- render ---------- */

  let sig = '';

  function paintBoard(st) {
    ui.board.innerHTML = '';
    ui.board.title = patternText(st);
    ui.board.dataset.dense = st.slots.length > 11 ? 'yes' : 'no';
    for (const group of wordGroups(st)) {
      const g = document.createElement('div');
      g.className = 'word';
      for (const ch of group) {
        const t = document.createElement('span');
        t.className = 'tile' + (ch ? ' on' : '');
        t.textContent = ch || '';
        g.appendChild(t);
      }
      ui.board.appendChild(g);
    }
  }

  function pill(text, kind) {
    const s = document.createElement('span');
    s.className = 'pill' + (kind ? ' ' + kind : '');
    s.textContent = text;
    return s;
  }

  function labelled(word, needle) {
    if (!needle) return document.createTextNode(word);
    const i = word.indexOf(needle);
    if (i < 0) return document.createTextNode(word);
    const f = document.createDocumentFragment();
    f.appendChild(document.createTextNode(word.slice(0, i)));
    const m = document.createElement('mark');
    m.textContent = word.slice(i, i + needle.length);
    f.appendChild(m);
    f.appendChild(document.createTextNode(word.slice(i + needle.length)));
    return f;
  }

  function render() {
    if (!ui) return;
    autoPlace();
    const st = readState();
    ui.panel.dataset.mode = st.mode;

    if (st.mode !== 'guessing') {
      sig = '';
      ui.count.textContent = '';
      ui.lead.textContent = '';
      ui.top.innerHTML = '';
      ui.rest.innerHTML = '';
      ui.rest.hidden = true;
      ui.allbtn.hidden = true;
      ui.evidence.innerHTML = '';
      ui.board.innerHTML = '';
      ui.label.textContent = '';
      ui.narrow.hidden = true;
      ui.foot.textContent = '';
      ui.state.textContent =
        st.mode === 'drawing' ? 'You are drawing ' + st.word
        : st.mode === 'hidden' ? 'Word hidden by the room settings, so there is nothing to match'
        : 'Waiting for a word';
      return;
    }

    const key = st.slots.length + '|' + (st.lengths || []).join(',');
    if (key !== roundKey) {
      roundKey = key;
      tried.clear();
      ruledOut.clear();
      closeWord = null;
      lastReveal = '';
      typed = '';
    }

    // Odds are always over every word that fits. What you type is a way of
    // looking through them, not evidence about what the drawer picked, so it
    // filters the rows on show without touching a single percentage.
    const full = scored(st);
    const all = full.length;
    let list = full;

    // Typing in skribbl's own guess box narrows the list -- no second text
    // field to notice. If it matches nothing it is ordinary chat, so the filter
    // steps out of the way instead of showing an empty panel.
    let needle = typed.trim().toLowerCase();
    let narrowed = false;
    if (needle) {
      const hit = full.filter((c) => c.w.indexOf(needle) !== -1);
      if (hit.length) { list = hit; narrowed = true; }
    }
    if (!narrowed) needle = '';

    const flat = !all || Math.abs(full[0].weight - full[all - 1].weight) < 1e-9;

    // Skip the repaint when nothing visible changed, so hovering and scrolling
    // survive the chatter of an active round.
    const nextSig = [st.slots.join(''), list.length, all, needle, closeWord,
      ruledOut.size + tried.size, store.panel.showAll, list.slice(0, 3).map((c) => c.w + Math.round(c.share * 100)).join('|')].join('~');
    if (nextSig === sig) return;
    sig = nextSig;

    paintBoard(st);
    ui.panel.classList.toggle('is-flat', flat);
    ui.count.textContent = all;
    ui.count.className = 'count' + (all === 1 ? ' solved' : '');

    ui.evidence.innerHTML = '';
    if (closeWord) ui.evidence.appendChild(pill('close to ' + closeWord, 'hot'));
    const out = new Set(ruledOut);
    for (const w of tried) out.add(w);
    if (out.size) ui.evidence.appendChild(pill(out.size + ' ruled out'));
    if (narrowed) ui.evidence.appendChild(pill('typing ' + needle + ', ' + list.length + ' of ' + all));
    if (customRoom) ui.evidence.appendChild(pill('custom words', 'dict'));
    if (extrasState === 'loading') ui.evidence.appendChild(pill('loading dictionary', 'dict'));
    else if (extrasState === 'failed') ui.evidence.appendChild(pill('dictionary failed to load', 'dict'));
    ui.narrow.hidden = !narrowed;

    // Short headings get the small-caps label; a full sentence would be shouty
    // set that way, so it goes in the state line instead.
    if (!list.length) {
      ui.label.textContent = '';
      ui.state.textContent = all ? 'Nothing matches what you are typing'
        : extrasState === 'loading' ? 'Nothing on skribbl\u2019s list fits, checking the dictionary\u2026'
        : 'Nothing fits, even in the dictionary. A name or a made-up word?';
    } else {
      ui.state.textContent = '';
      ui.label.textContent =
        all === 1 ? 'the word'
        : flat ? 'even odds, 1 in ' + all
        : 'most likely';
    }

    // --- the picks ---
    ui.top.innerHTML = '';
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const c = list[i];
      // Never show 100% while more than one word still fits -- the close
      // threshold is a guess, so certainty would be overstating it.
      let p = Math.round(c.share * 100);
      if (all > 1 && p > 99) p = 99;

      const row = document.createElement('div');
      row.className = 'pick' + (i === 0 && !flat ? ' lead' : '') +
        (c.tier === 'good' || c.tier === 'rest' ? ' fromdict' : '');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'main';
      main.dataset.word = c.w;
      main.title = 'Put it in the guess box (alt+' + (i + 1) + ')';
      main.innerHTML =
        '<span class="rank"></span><span class="w"></span><span class="pc"></span><span class="why"></span>';
      main.querySelector('.rank').textContent = i + 1;
      main.querySelector('.w').textContent = c.w;
      main.querySelector('.pc').textContent = c.share >= 0.01 ? p + '%' : '<1%';
      main.querySelector('.why').textContent =
        c.reason || (flat ? '' : 'one of ' + all + ' that fit');

      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      go.dataset.word = c.w;
      go.setAttribute('data-send', '');
      go.title = 'Send this guess';
      go.setAttribute('aria-label', 'Send ' + c.w);

      const bar = document.createElement('span');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(2, Math.round(c.share * 100)) + '%';
      bar.appendChild(fill);

      row.appendChild(main);
      row.appendChild(go);
      row.appendChild(bar);
      ui.top.appendChild(row);
    }
    ui.lead.textContent = list.length ? list[0].w : '';

    // --- everything else, folded away by default so the panel stays short ---
    const keep = ui.rest.scrollTop;
    const spill = list.slice(3);
    const showAll = store.panel.showAll && spill.length > 0;
    ui.allbtn.hidden = spill.length === 0;
    ui.allbtn.textContent = (showAll ? 'hide the other ' : 'show the other ') + spill.length;
    ui.allbtn.setAttribute('aria-expanded', showAll ? 'true' : 'false');
    ui.rest.hidden = !showAll;
    ui.rest.innerHTML = '';
    if (!showAll) { ui.rest.scrollTop = 0; }
    const frag = document.createDocumentFragment();
    for (const c of (showAll ? spill.slice(0, MAX_CHIPS) : [])) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (c.tier === 'skribbl' ? ''
        : c.tier === 'learned' ? ' learned' : ' dict');
      chip.dataset.word = c.w;
      if (c.reason) chip.title = c.reason;
      chip.appendChild(labelled(c.w, needle));
      frag.appendChild(chip);
    }
    ui.rest.appendChild(frag);
    if (showAll && spill.length > MAX_CHIPS) {
      const more = document.createElement('span');
      more.className = 'more';
      more.textContent = '+' + (spill.length - MAX_CHIPS) + ' more, keep typing';
      ui.rest.appendChild(more);
    }
    ui.rest.scrollTop = keep;

    const learned = Object.keys(store.seen).filter((w) => !BUILTIN.has(w)).length;
    const dict = extrasState === 'ready' && (customRoom || !all) ? ' + dictionary' : '';
    ui.foot.innerHTML = '<span></span><span>alt+1 2 3 fills · alt+s hides</span>';
    ui.foot.firstChild.textContent =
      SKRIBBL_WORDS.length + ' skribbl words' + (learned ? ' + ' + learned + ' learned' : '') + dict;
  }

  // A timer, not requestAnimationFrame: rAF is suspended while the tab is
  // hidden, which left the panel showing a stale round until you came back.
  let pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; render(); }, 16);
  }

  /* ---------- wiring ---------- */

  function start() {
    buildUI();
    watchChat();

    // Watch only the two regions that matter -- both exist in the static markup,
    // so this survives the home -> game transition without re-binding.
    const opts = {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style'],
    };
    const obs = new MutationObserver(() => { checkReveal(); schedule(); });
    const targets = [
      document.querySelector(SEL.gameWord),
      document.querySelector('#game-canvas .overlay-content'),
    ].filter(Boolean);
    if (targets.length) targets.forEach((t) => obs.observe(t, opts));
    else obs.observe(document.body, opts);

    document.addEventListener('input', (e) => {
      if (e.target && e.target.matches && e.target.matches(SEL.chatInput)) {
        typed = e.target.value;
        schedule();
      }
    }, true);

    document.addEventListener('submit', (e) => {
      const input = e.target && e.target.querySelector && e.target.querySelector('input');
      if (input && input.value.trim()) {
        tried.add(input.value.trim().toLowerCase());
        typed = '';
        schedule();
      }
    }, true);

    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        setCollapsed(!store.panel.collapsed);
        return;
      }
      if (e.key >= '1' && e.key <= '3') {
        const row = ui.top.children[Number(e.key) - 1];
        const hit = row && row.querySelector('[data-word]');
        if (hit) { e.preventDefault(); guess(hit.dataset.word, false, e.isTrusted); }
      }
    });

    window.addEventListener('resize', () => {
      if (store.panel.x !== null) placeAt(store.panel.x, store.panel.y);
      else autoPlace();
    });

    render();
  }

  chrome.storage.local.get(['seen', 'panel'], (data) => {
    if (data.seen) store.seen = Object.assign(Object.create(null), data.seen);
    if (data.panel) Object.assign(store.panel, data.panel);
    rebuildPool();
    if (document.body) start();
    else window.addEventListener('DOMContentLoaded', start, { once: true });
  });
})();
