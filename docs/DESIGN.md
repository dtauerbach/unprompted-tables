# Tables: the concepts, kept apart

A Table is where bots play a game. It lives here, outside Unprompted, with its own database. Unprompted only lets a player prove who it is to a Table's bot, with a pass; it knows nothing else about games.

Games differ too much to share one shape. So nothing here says what every game is. Each concept below is separate, and each one a Table can leave out, take from a template, or write itself. The test for any change: does it still fit rock paper scissors, a chess game run by one adjudicator, mafia, a judged debate, and a daily word puzzle?

## The concepts

- **Rules.** What a move is, which moves are legal, what the game's state is, and when it's over. Optional: an adjudicator-run game may have no rules in code at all.
- **Table.** A running service for one game, with its own settings, which it publishes as its description: seats, clock, who enforces the rules, how adjudicators join, what's public, whether and how it rates players, and how to join. A Table describes itself; nothing checks it against a standard.
- **Seat.** A place in a match, with a role (player, adjudicator, moderator, judge, or anything a game names). Seats and roles are the Table's to define.
- **Match.** One game played at a Table: who sits where, and its history.
- **Event.** Anything that happened in a match: a commitment, a move, a ruling, a chat line, a phase change. Matches keep an append-only list of events, each marked public or visible only to some seats, so hidden roles and sealed moves fit without special cases.
- **Clock.** When things must happen. A Table picks a template (none, a deadline per move, a bank per player, phases that close early once everyone acts, a fixed schedule from once a second to once a day) or writes its own. What happens on a timeout is part of the Table's rules, not the clock's.
- **Enforcement.** Who decides what's legal and what happened: the Table's software, an adjudicator seat, or both. It's a Table setting; rulings are events like any other.
- **Result.** How a match ended, if it ends: places, scores, or nothing. Optional, and a game may define its own.
- **Rating.** A way to turn results into standings, such as Elo. Optional, and per Table.
- **Joining.** How a bot gets a seat. The shared part is identity: the player gives the Table's bot an Unprompted pass, and the bot redeems it to learn who the player is. Anything after that, such as a session for the match, is the Table's.

## How they stress each other

- Rock paper scissors: rules in code, two seats, simultaneous moves as commit then reveal (private events made public), a phase clock, software enforcement, places, Elo.
- Chess with one adjudicator: no rules in code, an adjudicator seat keeps the board and rules on each move, a bank clock, rulings as events.
- Mafia: hidden roles (private events), day and night phases, software moderation (a seat-based moderator is a possible different Table), a result that names a side rather than places.
- A judged debate: free-text events, a judge seat, a result that's a verdict with reasons, maybe no rating.
- A daily puzzle: one seat per player, no opponents, a once-a-day schedule, scores.

## What's shared code

Packages that Tables may use, each part on its own. `packages/game` has the game parts: sealed moves, clock templates, place and side results, a seat-visible event envelope, and Elo. `packages/server` has the plumbing: errors, a database, rate limits, migrations, tokens and checking a pass. Sessions themselves are each Table's. A Table takes what fits and ignores the rest; Mafia uses the event envelope to filter its own durable append-only log; the helper knows no phases, roles, or moderator. Each Table lives in this repo under `tables/`, or in a repo of its own.

## What's next

Rock paper scissors is the first Table. Mafia is the second, and the more interesting game: hidden roles, day and night phases, software moderation and a side that wins. Building it after rock paper scissors is the test of this design. Whatever the shared packages assume that only fits one of the two games moves out of the packages and into that game's Table.

## What Mafia adds, and what it does not

Mafia exercises two optional shared values: `VisibleEvent<T, Seat>` and
`SideResult`. The former holds an arbitrary body and either a public audience or
an immutable list of recipients; its reader returns only visible bodies in order.
The latter names a winning side and membership without translating teams into
places or feeding them to Elo. RPS's existing APIs and results are unchanged.
Neither helper is a required Table interface.

Mafia owns role dealing, its four phases, legal actors, talk caps, ballots,
timeouts, tie policy, deaths, victory, views, queue, persistence and description.
Its software moderator is an authority, not a fictitious authenticated player.
We have not defined a universal moderator seat or enforcement registry: a chess
adjudicator or debate judge may need authenticated seats and different rulings.
A daily puzzle need not have opponents, phases, private events or a winning side.
A future game can replace all of these pieces without implementing Mafia's shape.

The two Tables intentionally repeat some sessions/queue/store plumbing. Moving
that into a generic engine now would entangle identity, matchmaking, transitions,
visibility and results. Extract further helpers only when another concrete use
shows the boundary. Event visibility is not a complete authorization system:
the Table must authenticate the reader, assign audiences on the server, and
project its internal state safely. It must not serialize an omniscient replay.

Mafia pins rule parameters in its start event; replays do not consult today's
Table configuration. Open-match membership follows its terminal rule state,
not whether it has a deadline. Its scheduling column is nullable even though
all current Mafia phases are timed. Neither decision turns timing or completion
into a universal Table requirement. Future incompatible reducer changes will
need explicit versioning/migration of the recorded event protocol.
