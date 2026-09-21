/* Paste this into the DevTools console on skribbl.io (F12 -> Console) while a
   round is running. It prints what the panel can see, which is everything
   needed to work out why it is misbehaving. Read-only: it changes nothing. */
(() => {
  const host = document.getElementById('skribbl-word-helper');
  const sr = host && host.shadowRoot;
  const hints = [...document.querySelectorAll('#game-word .hints .container .hint')];
  const out = {
    extensionLoaded: !!host,
    stylesLoaded: sr ? !!sr.querySelector('link') && getComputedStyle(sr.querySelector('.panel')).width : null,
    mode: sr && sr.querySelector('.panel').dataset.mode,

    // what the game is showing
    hintSlots: hints.map((h) => h.textContent).join(''),
    wordLength: (document.querySelector('#game-word .hints .container .word-length') || {}).textContent,
    youAreDrawing: (document.querySelector('#game-word .word') || {}).textContent,

    // what the panel concluded
    count: sr && sr.querySelector('.count').textContent,
    heading: sr && sr.querySelector('.label').textContent,
    state: sr && sr.querySelector('.state').textContent,
    picks: sr ? [...sr.querySelectorAll('.pick')].map((p) =>
      [p.querySelector('.w').textContent, p.querySelector('.pc').textContent,
       p.querySelector('.why').textContent].join(' | ')) : null,
    evidence: sr ? [...sr.querySelectorAll('.pill')].map((p) => p.textContent) : null,

    // the chat colours the evidence is read from
    lastChat: [...document.querySelectorAll('#game-chat .chat-content p')].slice(-6)
      .map((p) => (p.style.color || '?').replace('var(--COLOR_CHAT_TEXT_', '').replace(')', '')
        + '  ' + p.textContent),

    // where it parked itself
    panelBox: host ? (({ left, top, width, height }) =>
      [left, top, width, height].map(Math.round).join(', '))(host.getBoundingClientRect()) : null,
    viewport: innerWidth + 'x' + innerHeight,
  };
  console.log(out);
  return out;
})();
