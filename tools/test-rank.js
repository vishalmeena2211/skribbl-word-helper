// Pulls the real function sources out of content.js and exercises them.
const fs = require('fs');
const SRC = fs.readFileSync('/Users/vishalmeena111/Desktop/DIGISTAY/skribbl-helper/content.js', 'utf8');

function grab(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found: ' + name);
  let i = SRC.indexOf('{', at), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const consts = [/const W_CLOSE1[^;]+;/, /const W_GOOD = [^;]+;/, /const W_REST = [^;]+;/]
  .map((re) => SRC.match(re)[0]).join('\n');
const names = ['lev', 'fits', 'scored', 'chatKind', 'lineText', 'onChatLine'];

const api = new Function(`
  let pool = [], closeWord = null, store = { seen: {} };
  let BUILTIN = new Set(), customRoom = false, DICT = { good: {}, rest: {} };
  const ruledOut = new Set();
  const tried = new Set();
  function loadExtras() {}
  function extraBucket(tier, len) { return (DICT[tier] || {})[len] || []; }
  function schedule() {}
  ${consts}
  ${names.map(grab).join('\n')}
  return {
    lev, fits, scored, onChatLine, chatKind,
    reset(p, seen) {
      pool = p; BUILTIN = new Set(p); customRoom = false;
      DICT = { good: {}, rest: {} };
      ruledOut.clear(); tried.clear(); closeWord = null; store = { seen: seen || {} };
    },
    dict(d) { DICT = d; },
    setCustom(v) { customRoom = v; },
    sent(w) { tried.add(w); },
    close: () => closeWord,
    out: () => [...ruledOut],
  };`)();

/* ---- minimal stand-ins for the chat <p> nodes game.js builds ---- */
class El {
  constructor(tag, text) { this.tagName = tag.toUpperCase(); this.textContent = text || ''; this.kids = []; this.previousElementSibling = null; this.style = {}; }
  querySelector(sel) { return this.kids.find((k) => k.tagName === sel.toUpperCase()) || null; }
}
function chatLine(kind, name, text, isSystem) {
  const p = new El('p');
  p.style.color = 'var(--COLOR_CHAT_TEXT_' + kind + ')';
  p.kids.push(new El('b', isSystem ? name : name + ': '), new El('span', isSystem ? '' : text));
  return p;
}
function feed(lines) { lines.forEach((p, i) => { p.previousElementSibling = lines[i - 1] || null; api.onChatLine(p); }); }

/* ---- the game state for "hot dog": 7 slots, "3 3", h revealed ---- */
const ST = { slots: ['h', null, null, null, null, null, null], lengths: [3, 3] };
const POOL = ['hot dog', 'hat box', 'hip hop', 'ham bag', 'hot dogs'];

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) console.log('        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
};
const words = (l) => l.map((c) => c.w);
const pct = (l) => l.slice(0, 3).map((c) => c.w + ' ' + Math.round(c.share * 100) + '%');

// 1. baseline: only same-shape words survive ("hot dogs" is 8 chars, wrong shape)
api.reset(POOL);
check('shape filter', words(api.scored(ST)), ['ham bag', 'hat box', 'hip hop', 'hot dog']);

// 2. a wrong guess in chat is eliminated
api.reset(POOL);
feed([chatLine('BASE', 'Amy', 'hip hop')]);
check('chat guess ruled out', words(api.scored(ST)), ['ham bag', 'hat box', 'hot dog']);

// 3. "close" pins the answer: 1 edit from "hat dog" beats 2 edits
api.reset(POOL);
feed([chatLine('BASE', 'Bob', 'hat dog'), chatLine('CLOSE', 'Bob is close!', '', true)]);
check('close word captured', api.close(), 'hat dog');
check('close ranking', pct(api.scored(ST)), ['hot dog 86%', 'hat box 13%', 'ham bag 0%']);

// 4. the close line names the right player, not just the last speaker
api.reset(POOL);
feed([chatLine('BASE', 'Bob', 'hat dog'), chatLine('BASE', 'Amy', 'ham bag'), chatLine('CLOSE', 'Bob is close!', '', true)]);
check('attributes close to Bob', api.close(), 'hat dog');

// 5. translated close line still works (name is interpolated, colour is not translated)
api.reset(POOL);
feed([chatLine('BASE', 'Bob', 'hat dog'), chatLine('CLOSE', 'Bob ist nah dran!', '', true)]);
check('close in German', api.close(), 'hat dog');

// 6. GUESSCHAT (players who already guessed) must NEVER eliminate the answer
api.reset(POOL);
feed([chatLine('GUESSCHAT', 'Amy', 'hot dog')]);
check('guess-chat ignored', api.out(), []);

// 7. no evidence -> genuinely even odds
api.reset(POOL);
const flat = api.scored(ST);
check('flat when no signal', flat.every((c) => Math.abs(c.share - 0.25) < 1e-9), true);

// 8. seen-count prior tilts it
api.reset(POOL, { 'hat box': 3 });
check('seen prior', pct(api.scored(ST)), ['hat box 48%', 'ham bag 17%', 'hip hop 17%']);

// 9. a word you just guessed leaves the running at once, before chat echoes it
api.reset(POOL);
check('before guessing', words(api.scored(ST)), ['ham bag', 'hat box', 'hip hop', 'hot dog']);
api.sent('hat box');
check('your guess drops out immediately', words(api.scored(ST)), ['ham bag', 'hip hop', 'hot dog']);

// 10. the dictionary stays out of the way while skribbl's own list explains it
const SINGLE = { slots: ['c', null, null], lengths: [3] };
const DICT = { good: { 3: ['cap', 'cop', 'cub'] }, rest: { 3: ['caw', 'cel'] } };
api.reset(['cat', 'cow']); api.dict(DICT);
check('dictionary idle when skribbl fits', words(api.scored(SINGLE)), ['cat', 'cow']);

// 11. it opens up when nothing on skribbl's list fits
api.reset(['hot dog']); api.dict(DICT);
check('dictionary fills the gap', words(api.scored(SINGLE)), ['cap', 'cop', 'cub', 'caw', 'cel']);

// 12. and in a room known to use custom words, ranked below the real list
api.reset(['cat', 'cow']); api.dict(DICT); api.setCustom(true);
check('custom room mixes both, skribbl first',
  words(api.scored(SINGLE)), ['cat', 'cow', 'cap', 'cop', 'cub', 'caw', 'cel']);

// 13. a multi-word pattern can never be a dictionary word
api.reset(['hot dog']); api.dict({ good: { 7: ['hotdogs'] }, rest: {} });
check('multi-word skips the dictionary', words(api.scored(ST)), ['hot dog']);

// 14. levenshtein sanity
check('lev', [api.lev('hot dog', 'hat dog'), api.lev('hat box', 'hat dog'), api.lev('cat', 'cat')], [1, 2, 0]);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall green');
process.exit(fails ? 1 : 0);
