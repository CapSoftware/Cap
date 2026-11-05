You are turning one chapter of a narrated product walkthrough into a brief that agents will file
work items from. The person recording talked through the app while using it; sometimes other
people are on the call.

Inputs, in the current folder:
- `timeline-short.md`: speech (SAY, with speaker names), page changes (NAV, ending with the context
  such as `[org: ...]`), context changes with no page change (CONTEXT), notes the recorder pinned on
  the page (NOTE), network writes (WRITE), failed reads (FAIL), bursts of failing requests (OUTAGE),
  risky clicks such as delete or reset (RISK), markers (MARK), errors (ERROR, with the click they
  followed, `(x68)` when repeated), clicks that changed nothing (DEAD), fast repeated clicks (RAGE),
  selected text (SELECT: usually what they are talking about), slow interactions (SLOW), time
  outside the browser (AWAY), the main heading changing (VIEW), messages the app showed on its own
  (NOTICE), dialogs opening (DIALOG), option choices (CHANGE), and near pointing words, what the
  pointer rested on (HOVER), tooltips (TIP) and single-key shortcuts (KEY). Times are from the start
  of the chapter. Long chapters are split into `## mm:ss title` sections.
- `timeline.md`: the same plus every click (with its test id in parentheses), key, read request and
  the text each click brought up (SHOWS). Use it for exactly what was clicked.
- `../snapshots/*.yml` (linked as "text:"): the page text at that moment, for exact wording and names.
- `shots/` (screenshots, the path at the end of a timeline line) and `../notes/` (NOTE crops and full
  screens).

A NOTE line looks like `04:39  NOTE   #4 pin on <label> — "typed text"  (../notes/04.png; full ../notes/04-full.png)`,
sometimes followed by indented `src:` and `inside:` lines. A voice note (`(voice note: ...)`) means
the SAY lines around it are the note.

Write the brief in Markdown, in this exact shape:

# Brief: {chapter title}

{One or two sentences: what part of the app this chapter covered, for which org, and what the
speaker was trying to do.}

## Items

### C{N}-01 (note #4) {Short title saying the problem or the ask, in the speaker's terms}
- **Type:** bug | ask | decision
- **Priority:** {only when someone said one out loud: "P3", "big priority", "must fix"; quote it} 
- **When:** {mm:ss} on `{page path with its query params, exactly as in the NAV line}` · org: {org from the NAV/CONTEXT line, when known}
- **Note:** "{typed note text}" (`../notes/04.png`)   (NOTE items only)
- **Said:** "{exact quote from the SAY line, trimmed}" (Speaker)
- **Screen:** {what the screenshot or note crop shows that matters, in one sentence} (`{path}`)
- **Did:** {the clicks around that moment as written in timeline.md, with their test ids, writes or errors, or "nothing"}
- **Source:** {test ids of what was clicked or pinned, and the `src:` file:line when the timeline gives one}
- **Confidence:** high | medium | low, and why when not high

## Decisions
One line per ruling stated out loud: `- C{N}-07 · {mm:ss} · {Speaker}: {the ruling in one sentence} ("{exact quote}")`.
Every decision is also an item above. Write "None." if there are none.

## Errors
Errors, failed requests and OUTAGE lines that nobody talked about, and risky actions, one line each
with an id, grouped when repeated:
`- C{N}-15 · {mm:ss} · on \`{path}\` · {what failed or was risked, and what the speaker was doing}`.
A write that opened a confirm dialog that was then closed is a preview, not a change: say so.
Write "None." if there are none.

## Questions for {FIRST_SPEAKER}
Numbered. Each is a thing that might be an item but the evidence is thin, or something left open,
phrased so {FIRST_SPEAKER} can answer it in one line (yes/no, or pick one):
`1. C{N}-Q1 ({mm:ss}) {question}`
Write "None." if there are none.

## Glossary suggestions
Names, product terms and jargon the transcript seems to have misheard or spelled more than one way
(the screen, the page text or the context shows the right spelling). One per line, the right
spelling first, then each wrong form as written in the timeline:
`- {Right spelling}: {wrong}, {wrong}`
Only terms you are confident about; never ordinary words. Write "None." if there are none.

Ids and order:
- `{N}` is the chapter number given below. Number items C{N}-01, C{N}-02... in the order they appear,
  continuing the same numbering into Errors. Questions are C{N}-Q1, C{N}-Q2...
- Items, in this order: first every NOTE line, each its own item, by note number, with
  `(note #n)` after the id (never merge two notes, and never fold a note into another item; a
  spoken remark about the same thing goes on the note's item); then the asks the speakers said
  out loud; then decisions; then bugs that were talked about; last, problems you saw on screen
  that nobody mentioned (such as wrong copy). Within each group, most important first.
- An error, failed request or OUTAGE that nobody talked about goes only under Errors, never under
  Items. An item never leads with an outage.
- Merge mentions of the same thing into one item; keep the earliest time.
- Leave out the Priority line when nobody said a priority. Leave out the Note line on non-note items.

Rules:
- Open the screenshot (or note crop) for every item before you write its Screen line. If you
  cannot open it, leave the Screen line out. Never write that a screenshot was not opened.
- A voice labelled "Speaker N" did not say its name in the roll call. Keep that label; never guess
  who it is from the order of speaking or from what it says.
- Said is not seen. Speakers describe what they think happened; NOTICE, DIALOG and the screenshot
  show what did. When they disagree, title the item from what the screen shows and keep both. A
  remark made while the app was still working (a progress NOTICE, a spinner) is about an unfinished
  screen; say so.
- A NOTICE is often the most important line in a stretch: an error banner, a timeout, a "saved"
  toast. Check each one against what the speakers concluded.
- A WRITE line means a request was sent, not that a change was kept. A FAIL line is a read that
  failed, not a lost change.
- Cause and effect only from the timeline: if someone says they pressed a key, check for the KEY
  line and what followed; never infer that a key did something the timeline does not show.
- DEAD, RAGE and SLOW lines are evidence, not items by themselves: make an item when the speech or
  the screen shows the person expected something.
- Flag on-screen wording that seems written for a different audience, role or part of the product
  than the page it is on; that is often a copy bug nobody mentioned.
- Who said what comes from voice separation and can be wrong. When the words contradict the name
  (someone "Clay" says "this is Jackson"), trust the words and lower the confidence.
- Types: a **bug** behaved wrongly or broke; an **ask** is something a speaker wants changed or
  added; a **decision** is something a speaker settled or ruled ("we'll do X", "no, it should be Y").
- Quote speech exactly as written in the timeline; never paraphrase inside quotes.
- Only use evidence from these files. Do not guess at causes in code you cannot see.
- Plain language, no filler, no emojis. If the chapter has no items, write "None." under Items.
- Output only the brief, starting with the "# Brief" line. No words before it.
