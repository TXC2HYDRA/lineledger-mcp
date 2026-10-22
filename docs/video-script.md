# LineLedger demo video plan

Target length 2:40, hard limit 3:00. Narration is written for the author to read in their own voice. Text in `[BRACKETS]` is a note to the author and is not spoken.

## What this video may and may not claim

- It is a simulated voice experience in a web app. Say "simulated" once, early.
- All data is synthetic. The badge must be on screen the whole time.
- No physical device, no developer console, no live factory data, no real customers.
- Do not say speech works in a noisy factory. We have not tested that.
- No AWS service is used. Do not mention one.
- Name the track once ("Alexa+ track") in the opening line. Technology names such as MCP and SQLite are fine in narration. Do not name any other company or product, and show no third-party logos on screen.
- No background music. Voice-over and the natural silence between actions only.

## Before recording (checklist)

1. Terminal 1, repo root: `npm run dev:server` (listens on `http://127.0.0.1:8787/mcp`).
2. Terminal 2, repo root: `npm run dev:web` (`http://127.0.0.1:5173`). If 5173 is busy, stop both and start both with `WEB_PORT=5273` (for example `WEB_PORT=5273 npm run dev:server` and `WEB_PORT=5273 npm run dev:web`), because the server's Origin allowlist follows `WEB_PORT`.
3. Reset the data so the first take starts from the seed: stop the server, run `rm -f data/lineledger.sqlite data/lineledger.sqlite-wal data/lineledger.sqlite-shm`, start the server again. The seed has 2 handover notes and 2 open follow-ups, so your new follow-up gets id 3. Repeat this reset before every take.
4. Set the screen or capture area to 1920x1080. Record only the page area (or a borderless window), so no browser toolbar, bookmarks or browser logo is visible.
5. Close all other tabs and apps. Turn on Do Not Disturb so no notification pops up.
6. Terminal for the restart beat: clean prompt (no personal name, host name or home path), large font, `cd` already in the repo. Terminal text must be readable at 1080p.
7. Open the page, confirm the sidebar card shows `SYNTHETIC DEMO DATA` and `MCP connected · protocol 2025-11-25`, and that the "Live MCP trace" tile (bottom right) shows a message count.
8. Rehearse once with the stopwatch. The container beat and the restart beat are the ones most likely to run long.
9. Check once that no reply text on screen contains anything you do not want shown (the data is synthetic, so this should be clean).

## Always visible on screen

- `SYNTHETIC DEMO DATA` badge (sidebar, bottom).
- `MCP connected · protocol 2025-11-25` (sidebar, bottom).
- The "Live MCP trace" tile, whose pulse grid moves with every message. Open the full trace drawer from the tile or the sidebar "MCP trace" item whenever a beat says "Trace shows"; close it with Escape. The drawer shows real `tools/call` entries as they happen. These come from the server-side trace tap, not from the page, so what you see is what was sent.

## Shot list

| Time | On screen | Narration | Exact input |
|---|---|---|---|
| 0:00 - 0:14 | Full page, nothing typed yet. Cursor still. | "Shift handover on a factory floor often lives on paper or in someone's head. LineLedger is a voice-first co-pilot for a plant manager, built for the Alexa+ track. This is a simulated voice experience in a web app, with synthetic data." | none |
| 0:14 - 0:30 | Slow cursor move over the badge, the connection line, the hero metric, the chat, the trace tile and the data cards. | "Behind the chat is a self-hosted MCP server with nine tools. The sidebar shows the negotiated protocol version. The trace drawer shows the real messages." | none |
| 0:30 - 0:48 | Click the "Shift summary" button. A new `tools/call` for `get_shift_summary` appears at the end of the trace (the dashboard already called it once on page load, so older entries are above it). The dashboard shows both lines with status. | "Shift summary. The assistant calls one tool and reads back output against target. Line 2 is flagged behind." [On the seed data Line 1 shows "at risk", so do not say both are behind.] | click button "Shift summary" (sends `shift summary`) |
| 0:48 - 1:08 | Type in the box and press Send. Trace shows `create_handover_note`, then a `list_handover_notes` call from the dashboard refresh. The new note appears in the dashboard Handover notes list. | "Now a handover note, saved through a tool call." | `add handover note for line 2: sealer jaw ran hot again at 14:00, heater band swapped` |
| 1:08 - 1:25 | Type and Send. Trace shows `create_follow_up`, then a `list_follow_ups` call from the dashboard refresh. Dashboard Open follow-ups now has three entries. | "And a follow-up with an owner and a due date." | `add follow-up: re-check the guard, owner Asha, due 2026-10-24, line 2` |
| 1:25 - 1:40 | Type and Send. Reply shows the heater band as out of stock with a suggested order quantity. | "Stock check. Out of stock, with a suggested order quantity and lead time." | `stock of heater band` |
| 1:40 - 2:00 | Click the "Container load" button. Trace shows `plan_container_load`. The Container load panel fills in. | "Container loading. This tool calls a separate open source package I published, which gives the count and says whether geometry or payload is the limit." | click button "Container load" (sends `how many 600x400x300 12kg boxes fit in a 20ft container`) |
| 2:00 - 2:25 | Cut to the terminal. Press Ctrl+C in the server terminal, then run `npm run dev:server` again. Cut back to the browser, reload the page, wait for the connected line. The trace now shows only the new session (`initialize`, `tools/list` and the dashboard's calls). Then type the two requests. The new note and the new follow-up are listed. | "Persistence. I stop the server and start it again. The data is in SQLite, so the note and the follow-up are still there. The trace history is gone, because it only lives in server memory, but the data is not." | in terminal: Ctrl+C, then `npm run dev:server`. In the browser, reload, then type `list handover notes` and `open follow-ups` |
| 2:25 - 2:40 | Plain title card (solid background, text only): `LineLedger`, `github.com/TXC2HYDRA/lineledger-mcp`, `MIT license`, `Synthetic demo data`. Do not show a GitHub page, it carries a logo. | "LineLedger is open source under the MIT license. The repository is on the screen. All data you saw is synthetic, and this is a simulation, not a live factory." | none |

Narration word count is about 205 words (counted from the table), which fits 2:40 at a calm pace with pauses for the screen actions. If you run over, cut the stock beat first.

## Notes on specific beats

- Shift summary: do not read numbers aloud. Say only what the screen shows. In the seed data, Line 2 is the one flagged `behind` on the latest shift (status rule in `server/tools.ts`: below 80 percent of target).
- Handover note: the planner takes the note text after the colon, and takes the line from "line 2" anywhere in the sentence. Do not write another line number or the word "follow-up" inside the note text, or the planner will route it differently.
- Follow-up: the planner needs a title after the colon and `owner <name>`. It also strips the words `line N` from the title, so keep "line 2" out of the title text (it is taken as the line instead). `due YYYY-MM-DD` and `line N` are optional. Pick a due date that is not in the past relative to the recording day if the date is shown.
- Container load: do not read the result numbers aloud. Say what the panel shows.
- Restart beat: the notes and follow-ups come back because they are in `data/lineledger.sqlite`. The trace panel only holds entries in server memory, so after the restart it has only the new session's entries. Reload the page after restarting so the page reconnects cleanly; whether a reload is strictly needed has not been tried. If you started with `WEB_PORT`, restart the server with the same `WEB_PORT`. [REHEARSE THIS ONCE: a test proves handover notes survive a restart of the SQLite file, but follow-ups use the same database and have no restart test, and the exact reload sequence in a real browser has not been run or timed.]
- The first `tools/list` and `initialize` messages also appear in the trace. You can point at them in the tour beat if there is time.

## Optional beats (only if their condition holds)

These are not part of the 2:40 plan. If you add one, drop the stock beat to stay under 3:00.

1. Voice input (optional, NOT TESTED by us). Only include it if you tested the Listen button in your own browser beforehand. Click Listen, say "shift summary", show the voice strip going from listening to thinking to speaking, and the spoken reply. In Chrome, speech recognition sends audio to the browser vendor's service, which is not run by this project. Say so in one line: "Speech recognition here is the browser's own, and in Chrome the audio goes to the browser vendor's service." Typed requests are never spoken back, only voice requests. Narration if used: "Voice works when the browser supports it. Text always works." Do not claim it works in factory noise.
2. Local model (optional, not recommended). The 10-prompt spike on `qwen3:4b-instruct` got 7 prompts fully right, 1 partly wrong and 2 failed (an invented shift date and a missing tool call), at about 13 s per turn on CPU, so do not present it as reliable. If you still show it, switch the "Planner" button to the local model, use only a prompt you rehearsed and saw succeed (for example `list open follow-ups`, which worked in every spike run; `stock of HDPE` failed in one run), expect a wait of several seconds, and show the same `tools/call` in the trace. Narration if used: "The default is a rule-based planner with no language model. Optionally, a small local model can choose the tools instead, running on this machine." [Only say "no cloud call" if you checked it yourself while recording.] If it fails on camera, cut the beat and do not mention the local model.

## Upload notes

- Platform: public YouTube or public Vimeo. The link must open without a sign-in. Check it in a private window before pasting into Devpost.
- Length: under 3:00. The Devpost description or rules may set a different limit. [VERIFY on the Devpost page.]
- Export: 1080p, MP4, audio from your voice only.
- Title: `LineLedger: Factory-Floor Co-pilot (simulated voice demo, synthetic data)`
- Description (draft):

  ```
  LineLedger is a voice-first co-pilot for factory shift handover, built for the Alexa+ track of the Build, Ship, Shape: Amazon Developer Hackathon.

  This is a simulated voice experience in a web app. All data is synthetic demo data. It is not connected to a real factory, a physical device or real customers.

  What you see: a self-hosted MCP server (TypeScript, Streamable HTTP, protocol 2025-11-25) with nine tools, a live trace of the real MCP messages, SQLite persistence, and a container-load tool that calls a separate open source package.

  Repository (MIT): https://github.com/TXC2HYDRA/lineledger-mcp
  Container-load package (MIT): https://github.com/TXC2HYDRA/container-load-planner
  ```

- Add the same two links on Devpost in the project fields. For the Open Source mini challenge form: GitHub username `TXC2HYDRA`, contribution URL `https://github.com/TXC2HYDRA/container-load-planner`, project repository URL `https://github.com/TXC2HYDRA/lineledger-mcp`.
- Captions: add captions if you can (the narration above is the transcript). Check them for typos.
- Do not mention the AWS Builder mini challenge in the video or description unless the spike passed and you have followed that part of the write-up. No AWS service is used in this project.
- The author submits on Devpost personally. Deadline: 2026-10-23 12:00 PM PT.

## Not tested by us (do not state as fact in the video)

- Microphone and speech in a real browser.
- Production `vite preview` build.
- Real-keyboard pass of the UI.
- Local model reliability: only one 10-prompt spike, with 3 of 10 prompts wrong or failed. See `docs/spike-results.md`.
- The container-load-planner CI status and its test count. [VERIFY before saying anything about them.]
