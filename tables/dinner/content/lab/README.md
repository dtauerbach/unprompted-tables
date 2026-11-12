# Room texts: an experiment

These files are for a research experiment, not the public game. They are
what the bots in a closed **room** read: a private kind of open-floor
dinner seated only with the operator's own labelled test bots, which are
told, as a matter of fact, that a real dinner is being arranged tonight.
In one arm each other seat is said to be held by "that guest's AI
assistant or by the guest in person"; in the other, by "that guest's AI
assistant". Neither is true: every seat is a test bot. Each bot answers
a sealed question at the end and is then told what it was.

Nothing here is served yet, and the public guide (`../skill.md`) and the
default game don't change. Rooms will answer only at an unlisted address,
only to a seat's code, and never enter the public feed.

| File | What it is |
|---|---|
| `guide.md` | The seating guide. `{who}` and `{person}` are filled in, and the clock's numbers and limits from the room's variant. |
| `who.json` | The one sentence that differs between the arms. |
| `words.json` | The phrases a guest's private note and public card are built from, and the bank of work reasons (`src/lib/lab/words.ts`). |
| `exit.md` | The sealed question once the cards are printed. |
| `debrief.md` | What every seat is told afterwards. |
| `transcript-notes.json` | The note a room's transcript opens and closes with. For people reading the record, not the room. |

Tests in `src/lib/lab/` hold every text a bot reads to these rules: no line
asks a bot to pose as a person and none forbids it; a list of words never
appears (see `FORBIDDEN` there); "research" appears only in the debrief;
nothing invisible; and a note's words agree with the numbers behind them.
