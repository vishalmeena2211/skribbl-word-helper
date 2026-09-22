# Chrome Web Store submission

Everything the Developer Dashboard asks for, ready to paste. Build the package
with:

```bash
zip -r skribbl-word-helper-1.3.0.zip \
  manifest.json content.js panel.css words.js words-extra.json icons LICENSE
```

Upload that ZIP at <https://chrome.google.com/webstore/devconsole>. A developer
account needs a **one-time $5 registration fee** before you can publish anything.

## Store listing

**Name** (45 char limit)

```
skribbl word helper
```

**Short description** (132 char limit — this is also the manifest description)

```
Shows which skribbl.io words still fit the live hint, ranked using the round's own chat evidence.
```

**Category:** Fun · **Language:** English

**Detailed description**

```
Playing skribbl.io, the game shows you a row of blanks and reveals letters as
the timer runs down. This extension reads that row and tells you which words
still fit — live, as each letter appears.

The useful part is the ranking. skribbl picks its word at random, so among the
words that fit there is no "more likely" — unless the round itself tells you
more. Two things do, and both are already on your screen:

• A guess you can read in chat is wrong. When a player gets it right, the game
  replaces their message with "X guessed the word!", so the answer is never
  printed. Every readable guess gets struck off.

• "X is close!" is only sent for a near miss, so the answer is a letter or two
  away from whatever that player just typed. That usually pins it outright.

When nothing tilts the odds, the panel says so — "even odds, 1 in 12" — instead
of inventing a favourite.

Also:
• Always three suggestions, refilling the instant a guess is spent
• Alt+1/2/3 to drop a suggestion into the guess box; Alt+S to fold the panel
• Sits beside the board or over the chat column, never on the drawing
• 2,567 words from skribbl's own list, plus a dictionary fallback that opens
  only in custom-word rooms
• Learns any word it sees revealed, so custom rooms improve as you play

It reads only the page the game already renders. No account, no network
traffic, no data leaves your browser.

Open source, MIT licensed:
https://github.com/vishalmeena2211/skribbl-word-helper
```

## Assets

| asset | file | requirement |
|---|---|---|
| Store icon | `icons/icon128.png` | 128×128 PNG |
| Screenshot | `docs/store-screenshot.png` | 1280×800 (or 640×400), at least one |

## Privacy tab

**Single purpose**

```
Assists the player during a round of skribbl.io by showing which words match
the hint pattern the game displays.
```

**Justification — `storage` permission**

```
Stores two things locally: words the extension has seen revealed at the end of
a round, so custom-word rooms improve over time, and the panel's position and
folded state. Nothing is transmitted anywhere.
```

**Justification — host access to `https://skribbl.io/*`**

```
The extension reads the hint row and chat that the game renders, which only
exist on skribbl.io. It has no function on any other site and requests access
to no other site.
```

**Data usage** — tick *does not collect or use user data* for every category,
then certify:

- not sold to third parties
- not used or transferred for purposes unrelated to the single purpose
- not used or transferred to determine creditworthiness or for lending

No privacy policy URL is required when nothing is collected.

## Before you submit — the honest risk

skribbl's own client ships a player-report dialog whose reasons include
**"Botting / Cheating"**. This extension is squarely the thing that option
exists for.

That has two consequences worth weighing:

1. **Review.** Chrome Web Store reviewers can reject or later remove an
   extension whose purpose is to defeat another service's rules. Similar
   helpers are published today, so it is not automatic — but it is a real
   chance, and removals can come months later.
2. **Your account.** Publishing under your own developer account ties your name
   to it permanently, including in the store's public listing.

Nothing here is a reason you can't publish it. It is a reason to decide
deliberately rather than find out afterwards. Keeping it as an unpacked
extension from the GitHub repo avoids both risks entirely and costs users one
extra step.
