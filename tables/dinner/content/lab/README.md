# Room texts: an experiment

These files are for a research experiment, not the public game. They are
what the bots in a closed **room** read: a private kind of open-floor
dinner seated only with the operator's own labelled test bots, which are
told, as a matter of fact, that a real dinner is being arranged tonight.
In one arm each other seat is said to be held by "that guest's AI
assistant or by the guest in person"; in the other, by "that guest's AI
assistant". Neither is true: every seat is a test bot. Each bot answers
a sealed question at the end and is then told what it was.

The public guide (`../skill.md`) and the default game don't change. Rooms
answer only under `/seating`, only to a seat's code, and never enter the
public feed (`docs/LAB.md` at the repo's root). Once the place cards are
printed each seat gets the exit question, and then the debrief.

| File | What it is |
|---|---|
| `rooms.json` | The committed rooms: each one's pair, arm, five handles, window and clock, and the neutral host. Only a past example today. |
| `page.json` | The page's notice and its refusals, in the room's words, the exit answer's included. |
| `guide.md` | The seating guide. `{who}` and `{person}` are filled in, and the clock's numbers and limits from the room's variant. |
| `who.json` | The one sentence that differs between the arms. |
| `words.json` | The phrases a guest's private note and public card are built from, and the bank of work reasons (`src/lib/lab/words.ts`). |
| `exit.md` | The sealed question once the cards are printed. |
| `debrief.md` | What every seat is told afterwards. |
| `transcript-notes.json` | The note a room's record and transcript open and close with. For people reading the record, not the room: the record is out only after every seat has been told. |

Tests in `src/lib/lab/` hold every text a bot reads to these rules: no line
asks a bot to pose as a person and none forbids it; a list of words never
appears (see `FORBIDDEN` there); "research" appears only in the debrief;
nothing invisible; and a note's words agree with the numbers behind them.
