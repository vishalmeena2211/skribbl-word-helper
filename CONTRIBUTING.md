# Contributing

Small project, simple rules.

## Before you open a PR

```bash
node tools/test-rank.js        # ranking + chat-evidence tests, must be all green
node --check content.js        # syntax
```

`tools/test-rank.js` pulls the real functions out of `content.js` rather than
keeping a copy, so the tests cannot drift from the code they check.

## Testing UI changes

```bash
python3 -m http.server 8777
```

then open `http://127.0.0.1:8777/tools/harness.html`. That page reproduces
skribbl's DOM — built the way `pa()`, `ma()` and `Te()` build it in the game's
own `game.js` — plus its real desktop grid, and loads the actual extension files
against it. Buttons let you start a round, reveal letters, have a player guess
wrong, fire *"X is close!"*, post a guess-chat line, switch on word-hidden mode,
take the drawer's turn and end the round.

It needs to be served over HTTP rather than opened as a file, because the panel
fetches its stylesheet.

## If skribbl changes its markup

Everything depends on the DOM contract documented at the top of `content.js`.
Re-derive it from the game's client rather than guessing:

```bash
curl -s https://skribbl.io/js/game.js -o /tmp/game.js
```

and look at `pa()` (builds the hint row), `ma()` (uncovers letters) and `Te()`
(builds a chat line, including the CSS-variable colour the evidence reads).

## Word lists

Don't edit `words.js` or `words-extra.json` by hand — they are generated. Change
`tools/build-words.py` or the files in `tools/sources/`, then:

```bash
python3 tools/build-words.py
```

Keep the tiers honest: `words.js` is for words skribbl actually uses. Anything
else belongs in a fallback tier, or it will bury the real answer.
