# Mission Control Native

A Mac app that shows what is in a Mission Control workspace: a folder of plain files that an AI assistant
keeps for a manager. Meeting summaries in Markdown, a board of action items, the books the manager draws on,
the assistant's own instructions and agents, and a log of corrections. The files are the source of truth;
the app reads them and changes only three of them.

It is native in this sense: a Rust core reads and writes the files and answers every request, and the
interface is drawn with HTML, CSS and JavaScript inside a native macOS window (the system's own WebKit,
through Tauri). There is no server, no browser and no network port.

Source code and releases: [the repository][repo].

## Download and open

Download the `.dmg` from the Releases section of [the repository][repo], open it and drag the app to
Applications. It runs on macOS 13 or later, on Apple silicon and Intel Macs. It is signed and notarized. The
first time you open it, macOS asks you to confirm, and says that Apple checked it for malicious software and
found none. It also opens on a Mac that is offline. This was tested once, on a second Mac with Wi-Fi off.

On first launch the app asks for your workspace folder. You can:

- **Choose Folder…** to open your own workspace.
- **Open Sample…** to save a copy of the sample workspace to a folder you name, and open it. The sample is
  fictional: an invented company and team. Its three book-notes files are placeholders. While it is open,
  the header shows "Recreated demo data". The sample never replaces a file or folder that already exists.
- **Quit.**

The app remembers the folder. To switch, use File ▸ Choose Workspace… (⌘O) or File ▸ Open Sample
Workspace…. The window title shows which folder is open.

## What it shows

- **Meetings**: every summary, newest first, and "Tracked items across all meetings": each action item with
  its owner, first-seen date, age and latest status, word for word. Anything marked "Manager-only note" is
  hidden until you turn on "Show private notes"; the switch is off every time a page loads.
- **Board**: To do, Doing, Done. "Import action items" adds a card per action item, never twice; drag cards
  or use the arrow buttons; add, edit and delete your own cards.
- **Library**: your books, your ratings and your own notes. The sample contains no text from any book, and
  the Library shows only what is in your own notes files.
- **Agents**: the assistant's instructions (`CLAUDE.md`) and each agent in `.claude/agents/`, with a "Review
  due" mark after 30 days. Read-only.
- **Corrections**: the log of what went wrong, who caught it and the rule it became.

When a table, field or date can't be read reliably, the app shows "could not read" and lists the problem.
It never guesses.

## Using it with Claude Code

The app shows the workspace and changes only three of its files. The summaries and the coaching come from
Claude Code, run in the same folder. You need Claude Code installed and signed in.

1. In Terminal, go to your workspace folder and start `claude`. The app's window title shows which folder
   that is.
2. `CLAUDE.md` is the coach. It is active as soon as the session opens. `/agents` lists the other two,
   `negotiation-prep` and `blind-spot-check`, along with any built-in agents and any of your own.

### Prompts to try

| To do this | Type this |
|---|---|
| Turn a transcript into a meeting summary | `Review the transcript transcripts/2026-10-05_kevin-sam_1on1.txt` |
| Prepare before you ask someone for something | `Use the negotiation-prep agent. I want to ask Praveen to run pairing sessions with Riley.` |
| Check a plan against your own coaching points | `Use the blind-spot-check agent on this plan: <your plan or draft message>` |

After a review, click Meetings in the app to see the new summary. If the Meetings page is already showing,
reload it with View ▸ Reload (⌘R). On the Board, "Import action items" adds its action items as cards. Items
marked "(suggested)" are added only when "Include suggested items" is ticked.

### Before you start

- Create a `transcripts/` folder in the workspace and put your transcript in it. The sample has none.
- Start the transcript's file name with the meeting date, for example
  `2026-10-05_kevin-sam_1on1.txt`. The coach saves the summary under the same name, ending in .md, and the
  app reads the meeting's date from the start of that name.
- Version 0.1.0 could open a summary only if its file name used letters, digits, dots, hyphens and
  underscores. A space, an apostrophe, an ampersand or an accented letter stopped it. 0.1.1 has no such limit.
- The sample's book notes are placeholders. In one test the coach said so and coached from the meeting
  alone. Expect that until you write your own notes in `library/`.
- The sample is written for a fictional team. To make it yours, edit `CLAUDE.md`, the summary template and
  the two agent files, put your own goals in `goals/`, and remove the sample's summaries from
  `meeting-notes/`. The coach and both agents read the summaries there.

## What it reads and writes

It reads `meeting-notes/*.md`, `CLAUDE.md`, `.claude/agents/*.md`, `library/books.json` and the notes files
it lists, `corrections/corrections.json` and `board/board.json`.

It writes only three files in the workspace:

- `board/board.json` (created the first time you open the Board)
- `library/books.json`
- `corrections/corrections.json`

Each save goes to a temporary file that is then renamed over the old one, and fields the app doesn't use
are kept as they were. If one of these files can't be read, the app refuses to save it rather than
overwrite it.

Outside the workspace it writes one small file, holding the workspace folder's path and nothing else:
`~/Library/Application Support/com.practicalaishift.missioncontrolnative/settings.json`.

## Privacy and the network

The app opens no network port and makes no network calls. Its pages can load nothing from outside the app,
and links to websites open in your default browser, not in the app. Private notes are removed by the core
before a page receives them, unless you turn the switch on.

## Build from source

You need macOS 13 or later, [Rust](https://rustup.rs) and Node.js 22 (for the Tauri command-line tool and
the tests). A universal build also needs the Intel target: `rustup target add x86_64-apple-darwin`.

```sh
npm install
npm test              # the test suite (see below)
npm run app           # run the app while developing
npm run build:app     # the release app, universal, in target/universal-apple-darwin/release/bundle/macos/
npm run check:app     # builds the app and checks it in a real window (takes a few minutes)
```

`npm run build:app` signs the app with a "Developer ID Application" identity if one is in your keychain, and
otherwise signs it ad-hoc and says so; an ad-hoc build runs on the Mac that built it. `npm run package` makes
the `.dmg`, and with a Developer ID also notarizes and staples it, using a notarytool keychain profile named
`mc-notary`. `npm run check:release` checks the result.

### Tests

`npm test` runs the test suite against the Rust core, using the sample workspace in `sample-workspace/` as
its data (set `MC_TEST_DATA` to use another folder). The tests reach the core through a small test server
that listens on 127.0.0.1 while they run; it is never part of the app.

The repository also keeps the earlier Node.js version of the same site (`server.js`, `lib/`) as the
"before": `node tools/compare.mjs` compares the two, and `npm run measure` prints a table comparing them on
your Mac. `SPEC.md` records every decision made while building it.

## Known limits

- In a folder with no `library/books.json` or `corrections/corrections.json`, the Library or Corrections page
  shows a notice naming the missing file. Adding a book or a correction there is refused, and the app does
  not create those files. An assistant that keeps the workspace, or a copy of the sample, provides them.
- A page does not update by itself when a file changes on disk. Click another page and back, or use View ▸
  Reload (⌘R).
- The Meetings page lists only files in `meeting-notes/` whose names end in `.md`.
- A notes file in `library/` is listed only if its name uses letters, digits, `.`, `-` and `_`. A notes file
  whose name has a space or an accented letter is not shown. (Meeting summaries have no such limit since
  0.1.1.)

## As is

This app is shared as it is, with no support and no warranty. Questions, issues and pull requests may go
unanswered.

[repo]: https://github.com/kc6330119-byte/mission-control-native
