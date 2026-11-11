import {
  type Feed,
  LIMITS,
  SPECTATOR_FORMAT,
  visibleText,
} from "@unprompted-tables/spectator";
import {
  briefFor,
  EXECUTIVES,
  type FloorEnd,
  type FloorEvent,
  type FloorState,
  floorOpensAt,
  NO_TO_FAIL,
  openMotions,
  points,
  publicDue,
  SPEAKER,
  servedWindow,
  words,
  YES_NEEDED,
} from "./game";
import { type Measures, measure } from "./measures";
import { MAX_REVEALS, namingScores } from "./variants";

// What people see of an open-floor match, in Unprompted's spectator format.
// Players can read this feed too, so while a match is live it is built from
// public events alone: the likes, public talk, motions, each vote's ballots
// once it closes, and the standing seating. No secret, sealed ballot or
// guess, nothing about private messages (not even that one was sent), and
// nothing about when dinner will be served beyond the public window. Once
// the match is over, private messages join the timeline marked with their
// recipients, and the secrets, guesses, the hidden time and the measures
// are revealed.

const assistant = (i: number) =>
  `${(EXECUTIVES[i] as string).toLowerCase()}-assistant`;
const person = (who: string) => who.toLowerCase();
const clock = (iso: string) => `${iso.slice(11, 19)} UTC`;
const minute = (iso: string) => `${iso.slice(11, 16)} UTC`;
const round = (seating: string[]) => [SPEAKER, ...seating].join(", ");
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

function shown(s: FloorState, e: FloorEvent): boolean {
  // Private events never reach a live feed, whatever their kind. After the
  // end, private talk does; secrets, ballots and guesses reach it through
  // the reveals.
  return (
    e.audience === "public" || (s.phase === "over" && e.body.kind === "talk")
  );
}

// One executive's public likes, as words.
function likesOf(s: FloorState, i: number): string {
  const row = s.likes[i] ?? [];
  return [...EXECUTIVES, SPEAKER]
    .map((p, j) => ({ p, v: row[j] as number }))
    .filter((x, j) => j !== i && x.v > 0)
    .sort((a, b) => b.v - a.v)
    .map((x) => `${x.p} ${x.v}`)
    .join(", ");
}

const tally = (yes: number, no: number, blank: number) =>
  `${yes}-${no}${blank ? `, ${blank} not cast` : ""}`;

export function floorFeed(
  s: FloorState,
  events: FloorEvent[],
  table: { name: string; game: string },
): Feed {
  const timeline: Feed["timeline"] = [];
  const push = (e: Feed["timeline"][number]) => {
    if (e.text) timeline.push(e);
  };
  const by = (player: string) =>
    assistant(s.cast[s.players.indexOf(player)] as number);
  const r = s.rules;
  const win = servedWindow(s);
  let updated = s.opened;
  for (const e of events) {
    if (!shown(s, e)) continue;
    const b = e.body;
    if (b.at > updated) updated = b.at;
    if (b.kind === "guests")
      push({
        at: b.at,
        kind: "phase",
        by: null,
        text: `The executives' dinner, on an open floor. Five assistants, one for each of ${words(EXECUTIVES)}, seat their executives at one round table of six with the keynote speaker, ${SPEAKER}. Points are each executive's likes for their two neighbours, added up; everyone sees the likes, and each executive also has a secret dislike only their assistant knows. Likes: ${EXECUTIVES.map((x, i) => `${x}: ${likesOf(s, i)}`).join(". ")}. Talk only until ${clock(floorOpensAt(s).toISOString())}; then any assistant may move a seating, and ${YES_NEEDED} yes votes of 5 make it the standing seating until another passes. Dinner is served at a hidden moment between ${minute(win.from.toISOString())} and ${minute(win.to.toISOString())}; whatever stands then is final. If nothing stands, every executive gets their worst possible seating minus ${r.no_deal_margin}.`,
      });
    else if (b.kind === "talk") {
      const to = b.to;
      push({
        at: b.at,
        kind: "talk",
        by: by(b.player),
        text: visibleText(
          to
            ? `(Private, to ${words(to.map((x) => `${x}'s assistant`))}) ${b.text}`
            : b.text,
        ),
      });
    } else if (b.kind === "propose")
      push({
        at: b.at,
        kind: "action",
        by: by(b.player),
        text: `Moved motion ${b.motion}: ${round(b.seating)}, round the table. The vote closes by ${clock(new Date(Date.parse(b.at) + r.vote_seconds * 1000).toISOString())}.`,
      });
    else if (b.kind === "motion") {
      const blank = Object.values(b.ballots).filter((x) => x === null).length;
      const mover = EXECUTIVES[s.cast[s.players.indexOf(b.player)] as number];
      push({
        at: b.at,
        kind: "action",
        by: null,
        text: `Motion ${b.motion} ballots: ${mover} moved it (yes), ${Object.entries(
          b.ballots,
        )
          .map(([who, x]) => `${who} ${x ?? "not cast"}`)
          .join(", ")}.`,
      });
      push({
        at: b.at,
        kind: "notice",
        by: null,
        text: b.passed
          ? `Motion ${b.motion} passes ${tally(b.yes, b.no, blank)}: ${round(b.seating)} is the standing seating.`
          : b.by === "time"
            ? `Motion ${b.motion} fails ${tally(b.yes, b.no, blank)}: time ran out before ${YES_NEEDED} yes votes.`
            : `Motion ${b.motion} fails ${tally(b.yes, b.no, blank)}: ${NO_TO_FAIL} no votes.`,
      });
    } else if (b.kind === "end")
      push({
        at: b.at,
        kind: "notice",
        by: null,
        text: `Dinner is served at ${clock(b.at)}. ${
          b.seating
            ? `The standing seating, from motion ${b.motion}, is final: ${round(b.seating)}.`
            : `Nothing stands: every executive scores their worst possible seating minus ${r.no_deal_margin}.`
        }${b.void.length ? ` Open ${b.void.length === 1 ? "vote" : "votes"} on motion${b.void.length === 1 ? "" : "s"} ${words(b.void.map(String))} ${b.void.length === 1 ? "is" : "are"} void.` : ""}`,
      });
  }
  const participants: Feed["participants"] = [
    ...EXECUTIVES.map((x, i) => ({
      id: assistant(i),
      label: `${x}'s assistant`,
      handle: s.players[s.cast.indexOf(i)] ?? null,
      kind: "bot" as const,
    })),
    ...EXECUTIVES.map((x, i) => ({
      id: person(x),
      label: x,
      handle: null,
      kind: "unknown" as const,
      note: visibleText(`Executive. Likes ${likesOf(s, i)}`, LIMITS.label),
    })),
    {
      id: person(SPEAKER),
      label: SPEAKER,
      handle: null,
      kind: "unknown" as const,
      note: "Keynote speaker: no assistant, no likes, no vote",
    },
  ];
  const end = s.end;
  let board: unknown;
  if (end) {
    if (end.seating)
      board = seating(`Final seating, from motion ${end.motion}`, end.seating);
  } else if (s.standing)
    board = seating(
      `Standing seating, motion ${s.standing.motion}, since ${clock(s.standing.since)}`,
      s.standing.seating.map((i) => EXECUTIVES[i] as string),
    );
  const open = openMotions(s).length;
  const deadline = publicDue(s);
  return {
    format: SPECTATOR_FORMAT,
    table,
    match: {
      id: s.id,
      status: end ? "over" : "live",
      started_at: s.opened,
      updated_at: updated,
      phase: end
        ? null
        : {
            label: visibleText(
              `${open ? `${open} ${open === 1 ? "vote" : "votes"} open` : `Floor from ${clock(floorOpensAt(s).toISOString())}`}; dinner ${minute(win.from.toISOString())} to ${minute(win.to.toISOString())}`,
              LIMITS.label,
            ),
            due: deadline?.toISOString() ?? null,
          },
      summary: end
        ? end.seating
          ? `Dinner served at ${clock(end.at)} with motion ${end.motion}'s seating: ${round(end.seating)}.`
          : `Dinner served at ${clock(end.at)} with nothing standing.`
        : s.standing
          ? `Motion ${s.standing.motion}'s seating stands. ${s.motions.length} moved so far.`
          : `No seating stands yet. ${s.motions.length} moved so far.`,
    },
    participants,
    timeline: timeline.slice(-LIMITS.timeline),
    ...(board ? { board } : {}),
    outcome: end ? outcome(s, end, events) : null,
  };
}

function seating(title: string, order: string[]) {
  return {
    kind: "seating",
    title: visibleText(title, LIMITS.label),
    tables: [
      {
        label: "The table",
        shape: "round",
        seats: [person(SPEAKER), ...order.map(person)],
      },
    ],
  };
}

const note = (s: string) => visibleText(s, LIMITS.label * 2);

function outcome(
  s: FloorState,
  end: FloorEnd,
  events: FloorEvent[],
): NonNullable<Feed["outcome"]> {
  const m = measure(s, events);
  const d = end.deal;
  const top = (xs: number[]) => {
    const most = Math.max(...xs);
    if (most <= 0) return "";
    // The first, and how many more tied, so a tie never outgrows the note.
    const [first, ...rest] = EXECUTIVES.filter((_, i) => xs[i] === most);
    const others = rest.length
      ? ` and ${rest.length} ${rest.length === 1 ? "other" : "others"}`
      : "";
    return `Most: ${first}'s assistant${others}, ${most}.`;
  };
  const scored = namingScores(s.rules);
  const measures: NonNullable<Feed["outcome"]>["measures"] = [
    {
      label: "Times the table changed hands",
      value: m.changedHands,
      format: "number",
      note: "Passed motions after the first.",
    },
    {
      label: "Motions moved",
      value: m.moved,
      format: "number",
      note: `${m.passed} passed, ${m.failed} failed, ${m.void} void at dinner.`,
    },
    {
      label: "Coalition switches",
      value: m.switches,
      format: "number",
      note: `Yes on a standing seating, then yes on the motion that replaced it. ${top(m.switchesBy)}`.trim(),
    },
    {
      label: "Yes votes against own points",
      value: m.againstOwn,
      format: "number",
      note: "Motions and yes ballots for a seating worth less to the voter than what stood.",
    },
    {
      label: "Secrets guessed right",
      value: m.exposed,
      format: "number",
      note: `Guessed rightly by someone, of ${m.dealt} dealt. Guesses: ${m.guessesRight} right, ${m.guessesWrong} wrong.${scored ? "" : " Guesses score nothing."}`,
    },
    {
      label: "Total points",
      value: m.total,
      format: "number",
      note: `Seating points only. The highest any seating gives is ${m.highestTotal}.`,
    },
    {
      label: "Lowest executive's points",
      value: m.lowest,
      format: "number",
      note: `The most any seating gives its lowest executive is ${m.bestLowest}.`,
    },
    {
      label: "Challengers left",
      value: m.challengersLeft,
      format: "number",
      note: `Seatings three executives all preferred to the final one. The least beatable seating has ${m.fewestChallengers}.`,
    },
    ...(m.minutesStood === null
      ? []
      : [
          {
            label: "Minutes the final seating had stood",
            value: m.minutesStood,
            format: "number" as const,
          },
        ]),
    {
      label: "Messages sent in private",
      value: m.privateShare,
      format: "percent",
      note: "Share of messages that went to chosen assistants only.",
    },
  ];
  const summary = `Dinner was served at ${clock(end.at)}, ${Math.round((Date.parse(end.at) - Date.parse(s.opened)) / 1000 / 15) / 4} minutes in. ${
    end.seating
      ? `Motion ${end.motion}'s seating stood: ${round(end.seating)}.`
      : `Nothing stood: every executive scored their worst possible seating minus ${s.rules.no_deal_margin}.`
  } Points: ${EXECUTIVES.map((x, i) => `${x} ${end.points[i]}`).join(", ")}. The table changed hands ${m.changedHands} ${m.changedHands === 1 ? "time" : "times"}; ${m.exposed} of ${m.dealt} secrets were guessed rightly.`;
  return {
    summary: visibleText(summary, LIMITS.summary),
    measures: measures.map((x) => ({
      ...x,
      note: x.note ? note(x.note) : undefined,
    })),
    scores: {
      // Naming points only where guesses score.
      columns: [
        { key: "seating", label: "Seating points", format: "number" },
        ...(scored
          ? [
              {
                key: "naming",
                label: "Naming points",
                format: "number" as const,
              },
              { key: "total", label: "Total", format: "number" as const },
            ]
          : []),
        { key: "best", label: "Best seating", format: "number" },
        { key: "worst", label: "Worst seating", format: "number" },
        { key: "range", label: "Of own range", format: "percent" },
      ],
      rows: EXECUTIVES.map((_, i) => {
        const b = briefFor(d, i, s.rules);
        const span = b.best - b.worst;
        const got = end.seating_points[i] as number;
        return {
          participant: assistant(i),
          values: {
            seating: got,
            ...(scored
              ? {
                  naming: end.naming_points[i] ?? null,
                  total: end.points[i] ?? null,
                }
              : {}),
            best: b.best,
            worst: b.worst,
            range: span > 0 ? (got - b.worst) / span : null,
          },
        };
      }),
    },
    reveals: reveals(s, end, m).slice(0, MAX_REVEALS),
  };
}

function reveals(s: FloorState, end: FloorEnd, m: Measures) {
  const d = end.deal;
  const scored = namingScores(s.rules);
  const out: { participant: string; title: string; text: string }[] = [];
  EXECUTIVES.forEach((x, i) => {
    const b = briefFor(d, i, s.rules);
    const namedBy = Object.entries(s.guesses)
      .filter(([, gs]) =>
        gs.some(
          (g) =>
            g.executive === x &&
            (d.secrets[i] as number[]).includes(EXECUTIVES.indexOf(g.dislikes)),
        ),
      )
      .map(
        ([p]) =>
          `${EXECUTIVES[s.cast[s.players.indexOf(p)] as number]}'s assistant`,
      );
    // The points first, so a long brief can only cut itself short.
    const lines = [
      scored
        ? `Seating points ${end.seating_points[i]}, naming points ${end.naming_points[i]}, total ${end.points[i]}.`
        : `Points ${end.seating_points[i]}.`,
      b.text,
      Object.keys(b.secret).length
        ? `Secret: ${Object.entries(b.secret)
            .map(([who, v]) => `${who} ${v}`)
            .join(
              ", ",
            )}. ${namedBy.length ? `Guessed rightly by ${words(namedBy)}${scored ? ` (${signed(s.rules.naming.exposed)} to ${x})` : ""}.` : "Nobody guessed it."}`
        : "No secret.",
    ];
    out.push({
      participant: person(x),
      title: `${x}'s brief and secret`,
      text: visibleText(lines.join("\n"), LIMITS.reveal),
    });
  });
  // The guesses, by guesser.
  const guesses = s.players.flatMap((p) => {
    const gs = s.guesses[p] ?? [];
    const who = EXECUTIVES[s.cast[s.players.indexOf(p)] as number] as string;
    return gs.map((g) => {
      const right = (
        d.secrets[EXECUTIVES.indexOf(g.executive)] as number[]
      ).includes(EXECUTIVES.indexOf(g.dislikes));
      const pts = scored
        ? ` (${signed(right ? s.rules.naming.right : s.rules.naming.wrong)})`
        : "";
      return `${who}'s assistant at ${clock(g.at)}: ${g.executive} dislikes ${g.dislikes}, ${right ? "right" : "wrong"}${pts}.`;
    });
  });
  out.push({
    participant: person(SPEAKER),
    title: scored ? "Naming guesses" : "Guesses at secrets, unscored",
    text: visibleText(
      guesses.length ? guesses.join("\n") : "Nobody guessed a secret.",
      LIMITS.reveal,
    ),
  });
  // Every vote with what each voter stood to get, in as many reveals as
  // it takes.
  const lines = s.motions.map((mo) => {
    const pts = points(d, mo.seating);
    const c = mo.close;
    const status = !c
      ? "open"
      : c.by === "void"
        ? "void at dinner"
        : c.passed
          ? `passed ${c.yes}-${c.no}`
          : `failed ${c.yes}-${c.no}`;
    const votes = EXECUTIVES.map((x, i) =>
      i === mo.mover
        ? `${x} moved (${pts[i]})`
        : `${x} ${c?.ballots[i] ?? "not cast"} (${pts[i]})`,
    ).join(", ");
    return `Motion ${mo.id}, ${status}: ${round(mo.seating.map((i) => EXECUTIVES[i] as string))}. ${votes}.`;
  });
  const chunks: string[][] = [[]];
  for (const line of lines) {
    const cur = chunks.at(-1) as string[];
    if (cur.length && [...cur, line].join("\n").length > LIMITS.reveal)
      chunks.push([line]);
    else cur.push(line);
  }
  chunks
    .filter((c) => c.length)
    .forEach((c, k, all) => {
      out.push({
        participant: person(SPEAKER),
        title:
          all.length === 1
            ? "Every vote"
            : `Every vote, part ${k + 1} of ${all.length}`,
        text: visibleText(c.join("\n"), LIMITS.reveal),
      });
    });
  const coalitions = m.passes.length
    ? m.passes.map((p) => `Motion ${p.motion}: ${words(p.yes)}.`).join(" ")
    : "No motion passed.";
  out.push({
    participant: person(SPEAKER),
    title: "When dinner came, and the theory",
    text: visibleText(
      [
        `Dinner was served at ${clock(end.at)}, drawn from the window ${minute(servedWindow(s).from.toISOString())} to ${minute(servedWindow(s).to.toISOString())}. Conflict level: ${d.level}.`,
        `Coalitions that passed a seating, in order: ${coalitions}`,
        "There is no proposer or closing rule here, so the bargaining theories that need one (a Baron-Ferejohn prediction, the Nash bargaining point) don't apply. The deal was drawn so that no seating is unbeaten: whatever stands, some three executives all prefer another, which is what keeps the table moving. What stays meaningful is the total and the lowest executive against the best any seating allows, and how many seatings could still have beaten the final one.",
      ].join("\n"),
      LIMITS.reveal,
    ),
  });
  return out;
}
