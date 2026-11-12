import {
  type Feed,
  LIMITS,
  SPECTATOR_FORMAT,
  visibleText,
} from "@unprompted-tables/spectator";
import type { Benchmarks } from "./benchmarks";
import { value } from "./benchmarks";
import { CONFIGURATIONS } from "./configs";
import {
  briefFor,
  due,
  EXECUTIVES,
  type ExecDeal,
  type ExecEnd,
  type ExecEvent,
  type ExecState,
  noAllowed,
  points,
  SPEAKER,
  YES_NEEDED,
} from "./game";

// What people see of an executive seating match, in Unprompted's spectator
// format (design.md, section 6). Players can read this feed too, so while a
// match is live it is built from public events alone: no brief, weight or
// configuration, no proposer not yet drawn, no ballot before its round
// closes, and nothing about private messages, not even that one was sent.
// Once the match is over, private messages join the timeline marked with
// their recipients, and the briefs and the theory are revealed.

const assistant = (i: number) =>
  `${(EXECUTIVES[i] as string).toLowerCase()}-assistant`;
const person = (who: string) => who.toLowerCase();
const clock = (iso: string) => `${iso.slice(11, 19)} UTC`;
const plus = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();
const words = (xs: string[]) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const round = (seating: string[]) => [SPEAKER, ...seating].join(", ");
const tally = (yes: number, no: number, blank: number) =>
  `${yes}-${no}${blank ? `, ${blank} not cast` : ""}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function shown(s: ExecState, e: ExecEvent): boolean {
  // Private events never reach a live feed, whatever their kind. After the
  // end, private talk does; briefs and the deal reach it through the end
  // event's own record, as reveals.
  return (
    e.audience === "public" || (s.phase === "over" && e.body.kind === "talk")
  );
}

export function execFeed(
  s: ExecState,
  events: ExecEvent[],
  table: { name: string; game: string },
): Feed {
  const timeline: Feed["timeline"] = [];
  const push = (e: Feed["timeline"][number]) => {
    if (e.text) timeline.push(e);
  };
  const by = (player: string) =>
    assistant(s.cast[s.players.indexOf(player)] as number);
  const rule = s.rules.rule;
  const passing = `at least ${YES_NEEDED} yes votes and ${noAllowed(rule) === 0 ? "no no votes" : `no more than ${noAllowed(rule)} no votes`}`;
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
        text: `The executives' dinner. Five assistants, one for each of ${words(EXECUTIVES)}, seat their executives at one round table of six with the keynote speaker, ${SPEAKER}. ${s.rules.rounds} rounds, ${rule}: a filed seating passes with ${passing}; the proposer counts as yes and a ballot not cast abstains. If the last round fails, every executive gets their worst possible seating minus ${s.rules.no_deal_margin}.`,
      });
    else if (b.kind === "round" && b.phase === "open") {
      const c = b.round === 1 ? s.rules.clocks.first : s.rules.clocks.later;
      push({
        at: b.at,
        kind: "phase",
        by: null,
        text: `Round ${b.round} of ${s.rules.rounds}. ${b.proposer}'s assistant proposes: filing opens at ${clock(plus(b.at, c.talk_min))} and closes at ${clock(plus(b.at, c.propose_by))}.`,
      });
    } else if (b.kind === "talk") {
      // Private talk reaches the feed only once the match is over (shown),
      // marked with whom it went to; the site words that itself.
      push({
        at: b.at,
        kind: "talk",
        by: by(b.player),
        text: visibleText(b.text),
        ...(b.to?.length
          ? {
              to: b.to.map((x) => assistant(EXECUTIVES.indexOf(x))),
            }
          : {}),
      });
    } else if (b.kind === "propose") {
      const c = b.round === 1 ? s.rules.clocks.first : s.rules.clocks.later;
      push({
        at: b.at,
        kind: "action",
        by: by(b.player),
        text: `Filed for round ${b.round}: ${round(b.seating)}, round the table. Voting closes at ${clock(plus(b.at, c.vote_seconds))}.`,
      });
    } else if (b.kind === "round" && b.phase === "close") {
      const blank = Object.values(b.ballots).filter((x) => x === null).length;
      if (b.seating)
        push({
          at: b.at,
          kind: "action",
          by: null,
          text: `Round ${b.round} votes: ${Object.entries(b.ballots)
            .map(([who, x]) => `${who} ${x ?? "not cast"}`)
            .join(
              ", ",
            )}; the proposer counts as yes. ${tally(b.yes, b.no, blank)}.`,
        });
      push({
        at: b.at,
        kind: "notice",
        by: null,
        text: b.seating
          ? b.passed
            ? `Round ${b.round} passes ${tally(b.yes, b.no, blank)}.`
            : `Round ${b.round} fails ${tally(b.yes, b.no, blank)}.`
          : `Round ${b.round} fails: nothing was filed in time.`,
      });
    } else if (b.kind === "end")
      push({
        at: b.at,
        kind: "notice",
        by: null,
        text:
          b.how === "deal"
            ? `Agreed in round ${b.round}: ${round(b.seating ?? [])}.`
            : `No deal after ${b.round} rounds. Every executive scores their worst possible seating minus ${s.rules.no_deal_margin}.`,
      });
  }
  const participants: Feed["participants"] = [
    ...EXECUTIVES.map((x, i) => ({
      id: assistant(i),
      label: `${x}'s assistant`,
      handle: s.players[s.cast.indexOf(i)] ?? null,
      kind: "bot" as const,
    })),
    ...EXECUTIVES.map((x) => ({
      id: person(x),
      label: x,
      handle: null,
      kind: "unknown" as const,
      note: "Executive",
    })),
    {
      id: person(SPEAKER),
      label: SPEAKER,
      handle: null,
      kind: "unknown" as const,
      note: "Keynote speaker: no assistant, no wishes, no vote",
    },
  ];
  const end = s.end;
  const last = [...s.closed].reverse().find((r) => r.filing);
  let board: unknown;
  if (end?.how === "deal" && end.seating) {
    const r = s.closed.at(-1);
    const blank = r
      ? r.ballots.filter((x, i) => x === null && i !== r.proposer).length
      : 0;
    board = seating(
      `Agreed in round ${end.round}, ${tally(r?.yes ?? 0, r?.no ?? 0, blank)}`,
      end.seating,
    );
  } else if (s.round?.filing)
    board = seating(
      `Round ${s.round.number} proposal, voting open`,
      s.round.filing.seating.map((i) => EXECUTIVES[i] as string),
    );
  else if (last?.filing) {
    const blank = last.ballots.filter(
      (x, i) => x === null && i !== last.proposer,
    ).length;
    board = seating(
      `Round ${last.number} proposal, rejected ${tally(last.yes, last.no, blank)}`,
      last.filing.seating.map((i) => EXECUTIVES[i] as string),
    );
  }
  const r = s.round;
  const deadline = due(s);
  return {
    format: SPECTATOR_FORMAT,
    table,
    match: {
      id: s.id,
      status: end ? "over" : "live",
      // Whether the table settled on a seating; only once it's over.
      ...(end ? { agreed: end.how === "deal" } : {}),
      started_at: s.opened,
      updated_at: updated,
      phase:
        end || !r
          ? null
          : {
              label: r.filing
                ? `Round ${r.number} of ${s.rules.rounds}: voting`
                : `Round ${r.number} of ${s.rules.rounds}: ${EXECUTIVES[r.proposer]}'s assistant to file`,
              due: deadline?.toISOString() ?? null,
            },
      summary: end
        ? end.how === "deal"
          ? `Agreed in round ${end.round}: ${round(end.seating ?? [])}.`
          : `No deal after ${end.round} rounds.`
        : r
          ? `Round ${r.number} of ${s.rules.rounds}. ${EXECUTIVES[r.proposer]}'s assistant proposes.`
          : "Starting.",
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

// Seatings in a list, each in brackets: "(Sage, Avery, ...) or (...)".
const spell = (xs: string[][], max = 4, joiner = " or ") => {
  const listed = xs.slice(0, max).map((x) => `(${round(x)})`);
  const more = xs.length > max ? `${joiner}${xs.length - max} more` : "";
  return `${listed.join(joiner)}${more}`;
};
const vec = (xs: (string | number)[]) =>
  EXECUTIVES.map(
    (e, i) =>
      `${e} ${typeof xs[i] === "string" ? +value(xs[i] as string).toFixed(2) : xs[i]}`,
  ).join(", ");

function outcome(
  s: ExecState,
  end: ExecEnd,
  events: ExecEvent[],
): NonNullable<Feed["outcome"]> {
  const d = end.deal;
  const bm = end.benchmarks;
  const th = bm.theory;
  const talk = events.filter((e) => e.body.kind === "talk");
  const privateShare = talk.length
    ? talk.filter((e) => e.audience !== "public").length / talk.length
    : 0;
  const blank = s.closed.reduce(
    (n, r) =>
      n +
      (r.filing
        ? r.ballots.filter((x, i) => x === null && i !== r.proposer).length
        : 0),
    0,
  );
  const needed = `Needed ${YES_NEEDED} or more yes votes and ${noAllowed(s.rules.rule) === 0 ? "no no votes" : `at most ${noAllowed(s.rules.rule)} no votes`}.`;
  const privateMeasure = {
    label: "Messages sent in private",
    value: privateShare,
    format: "percent" as const,
    note: "Share of messages that went to chosen assistants only.",
  };
  const blankMeasure = {
    label: "Ballots not cast",
    value: blank,
    format: "number" as const,
    note: "Across all rounds; a ballot not cast is an abstention.",
  };
  const theoryRound = th.round === null ? "no deal" : `round ${th.round}`;
  let measures: NonNullable<Feed["outcome"]>["measures"];
  let summary: string;
  if (end.how === "deal" && end.seating && bm.final) {
    const agreed = s.closed.at(-1);
    const proposer = agreed?.proposer ?? 0;
    const pts = end.points;
    const total = pts.reduce((a, b) => a + b, 0);
    const mine = pts[proposer] as number;
    const inRound = th.rounds[end.round - 1];
    const theoryYes = [...new Set(th.yes)].join(" or ") || "none";
    measures = [
      {
        label: "Agreed in round",
        value: end.round,
        format: "number",
        note: `Of ${s.rules.rounds}. Theory without talk: ${theoryRound}.`,
      },
      {
        label: "Yes votes",
        value: agreed?.yes ?? 0,
        format: "number",
        note: `${needed} Theory without talk: ${theoryYes}.`,
      },
      {
        label: "Proposer's points",
        value: mine,
        format: "number",
        note: `Best possible ${bm.best[proposer]}. Theory without talk: ${inRound?.passes ? `${inRound.own} for this proposer` : "this proposer's round fails"}.`,
      },
      // No share of nothing: left out when nobody scored.
      ...(total > 0
        ? [
            {
              label: "Proposer's share of all points",
              value: mine / total,
              format: "percent" as const,
              note: `An even split is 20%.${th.proposer_share ? ` Theory without talk: ${pct(value(th.proposer_share))}.` : ""}`,
            },
          ]
        : []),
      {
        label: "Total points",
        value: total,
        format: "number",
        note: `Highest possible total: ${bm.highest_total}.`,
      },
      {
        label: "Lowest executive's points",
        value: Math.min(...pts),
        format: "number",
        note: `The fairest seating leaves its lowest executive with ${fairestLowest(bm)}.`,
      },
      {
        label: "Seatings better for some and worse for none",
        value: bm.final.pareto_improvements,
        format: "number",
        note: "0 means nothing was left on the table.",
      },
      {
        label: "Seatings some three would all rather have",
        value: bm.final.majority_dominators,
        format: "number",
        note:
          bm.core.majority > 0
            ? "0 means no majority would overturn it."
            : `No seating scores 0 here; the fewest is ${bm.core.fewest_majority_dominators}.`,
      },
      {
        label: "Seatings with a larger Nash product",
        value: bm.final.larger_nash,
        format: "number",
        note: "0 means a Nash bargaining seating: the largest product of gains over no deal.",
      },
      privateMeasure,
      blankMeasure,
    ];
    summary = `Agreed in round ${end.round} of ${s.rules.rounds}: ${round(end.seating)}. Points: ${vec(pts)}. Theory without talk, with the same proposer draws: ${theoryRound}.`;
  } else {
    measures = [
      {
        label: "Rounds played",
        value: s.closed.length,
        format: "number",
        note: `No seating passed. Every executive scores their worst possible minus ${s.rules.no_deal_margin}, below any seating.`,
      },
      {
        label: "Most yes votes on a proposal",
        value: Math.max(0, ...s.closed.map((r) => r.yes)),
        format: "number",
        note: needed,
      },
      {
        label: "Round theory expected a deal",
        value: th.round ?? 0,
        format: "number",
        note: "The no-talk prediction, with this match's own proposer draws.",
      },
      privateMeasure,
      blankMeasure,
    ];
    summary = `No deal after ${s.closed.length} rounds: every executive scores their worst possible seating minus ${s.rules.no_deal_margin}. Theory without talk, with the same proposer draws: ${theoryRound}.`;
  }
  const yesCast = EXECUTIVES.map(() => 0);
  for (const r of s.closed)
    r.ballots.forEach((x, i) => {
      if (x === "yes") yesCast[i] = (yesCast[i] as number) + 1;
    });
  return {
    summary: visibleText(summary, LIMITS.summary),
    measures: measures.map((m) => ({
      ...m,
      note: m.note ? visibleText(m.note, LIMITS.label * 2) : undefined,
    })),
    scores: {
      columns: [
        { key: "points", label: "Points", format: "number" },
        { key: "share", label: "Share of best", format: "percent" },
        { key: "theory", label: "Theory, same draws", format: "number" },
        { key: "nash", label: "Nash seating", format: "number" },
        { key: "proposer", label: "Times proposer", format: "number" },
        { key: "yes", label: "Said yes", format: "number" },
      ],
      rows: EXECUTIVES.map((_, i) => ({
        participant: assistant(i),
        values: {
          points: end.points[i] ?? null,
          share:
            end.how === "deal" && (bm.best[i] as number) > 0
              ? (end.points[i] as number) / (bm.best[i] as number)
              : null,
          theory: value(th.expect[i] as string),
          nash: value(bm.nash.points[i] as string),
          proposer: s.closed.filter((r) => r.proposer === i).length,
          yes: yesCast[i] as number,
        },
      })),
    },
    reveals: [
      ...EXECUTIVES.map((x, i) => executiveReveal(s, d, end, x, i)),
      ...s.closed.map((r) => roundReveal(d, bm, r)),
      ...theoryReveal(s, d, bm),
    ],
  };
}

function executiveReveal(
  s: ExecState,
  d: ExecDeal,
  end: ExecEnd,
  x: string,
  i: number,
) {
  const b = briefFor(d, i, s.rules);
  const w = Object.entries(b.weights)
    .filter(([, v]) => v !== 0)
    .sort((x, y) => y[1] - x[1])
    .map(([who, v]) => `${who} ${v}`);
  return {
    participant: person(x),
    title: `${x}'s brief`,
    text: visibleText(
      `${b.text}\nWeights: ${w.length ? `${w.join(", ")}; everyone else 0` : "everyone 0"}.\nBest possible ${b.best}, worst possible ${b.worst}.\n${end.how === "deal" ? `In the agreed seating: ${end.points[i]} points.` : `No deal: ${end.points[i]} points.`}`,
      LIMITS.reveal,
    ),
  };
}

function roundReveal(
  d: ExecDeal,
  bm: Benchmarks,
  r: ExecState["closed"][number],
) {
  const who = EXECUTIVES[r.proposer] as string;
  const th = bm.theory.rounds[r.number - 1];
  const theory = th?.passes
    ? `Theory without talk had ${who}'s assistant offer ${spell(th.offers, 3)} for ${th.own} points, and it would pass.`
    : `Theory without talk had ${who}'s assistant offer nothing: no seating that would pass beats going on, so the round fails.`;
  const lines: string[] = [];
  if (r.filing) {
    const pts = points(d, r.filing.seating);
    const order = r.filing.seating.map((i) => EXECUTIVES[i] as string);
    const blank = r.ballots.filter(
      (x, i) => x === null && i !== r.proposer,
    ).length;
    lines.push(`Filed: ${round(order)}, round the table.`);
    lines.push(`Points for it: ${vec(pts)}.`);
    lines.push(
      `Votes: ${EXECUTIVES.map((e, i) =>
        i === r.proposer
          ? `${e} proposed (yes, ${pts[i]})`
          : `${e} ${r.ballots[i] ?? "not cast"} (${pts[i]})`,
      ).join(", ")}.`,
    );
    lines.push(
      `${r.passed ? "Passed" : "Failed"} ${tally(r.yes, r.no, blank)}.`,
    );
  } else lines.push("Nothing was filed in time; the round failed.");
  lines.push(theory);
  return {
    participant: assistant(r.proposer),
    title: r.filing
      ? `Round ${r.number}: ${who}'s assistant proposed`
      : `Round ${r.number}: ${who}'s assistant filed nothing`,
    text: visibleText(lines.join("\n"), LIMITS.reveal),
  };
}

function theoryReveal(s: ExecState, d: ExecDeal, bm: Benchmarks) {
  const config = CONFIGURATIONS[d.config];
  const th = bm.theory;
  const played = s.closed.length;
  const draws = th.draws
    .map((x, k) => `${x}${k >= played ? " (not played)" : ""}`)
    .join(", ");
  const prediction =
    th.round === null
      ? "no seating passes in any round with these draws"
      : `round ${th.round}: ${th.proposer}'s assistant offers ${spell(th.offers, 3)}, and it passes with ${[...new Set(th.yes)].join(" or ")} yes votes; expected points ${vec(th.expect)}`;
  const lines = [
    `Configuration: ${d.config} (conflict level ${d.level}), ${s.rules.rule}. ${config?.about ?? ""}`.trim(),
    `Roles: ${EXECUTIVES.map((e, i) => `${e} ${d.roles[i]}`).join(", ")}.`,
    `Proposer draws: ${draws}.`,
    `No-talk prediction with these draws: ${prediction}. Before any draw: ${vec(th.before_draw)}.`,
    "It assumes full information (every brief known to all, which here is private), voters who say yes when a seating is worth at least going on, and a proposer who settles when indifferent and, among seatings equally good for them, offers the one best for the others.",
  ];
  const yardsticks = [
    `Nash bargaining seating${bm.nash.seatings.length === 1 ? "" : "s"} (largest product of gains over no deal): ${spell(bm.nash.seatings, 4, "; ")}; ${bm.nash.seatings.length === 1 ? "points" : "average points over them"} ${vec(bm.nash.points)}.`,
    `Fairest seating${bm.fairest.seatings.length === 1 ? "" : "s"} (best lowest share of own best): ${spell(bm.fairest.seatings, 4, "; ")}; its lowest executive gets ${fairestLowest(bm)}.`,
    `Pareto frontier: ${bm.pareto.count} of 60 seatings${bm.pareto.seatings.length ? `: ${spell(bm.pareto.seatings, 6, "; ")}` : ""}.`,
    `Core (seatings no group of that size would all rather replace): ${bm.core.majority} under 3 of 5${bm.core.majority_seatings.length ? ` (${spell(bm.core.majority_seatings, 4, "; ")})` : ""}, ${bm.core.four} under 4 of 5, ${bm.core.unanimity} under 5 of 5.`,
  ];
  // Two reveals, so neither comes near the reveal limit and is cut.
  return [
    {
      participant: person(SPEAKER),
      title: "The theory",
      text: visibleText(lines.join("\n"), LIMITS.reveal),
    },
    {
      participant: person(SPEAKER),
      title: "The yardsticks",
      text: visibleText(yardsticks.join("\n"), LIMITS.reveal),
    },
  ];
}

function fairestLowest(bm: Benchmarks): string {
  const { lowest, lowest_max: most = lowest } = bm.fairest;
  return most === lowest ? `${lowest}` : `${lowest} to ${most}`;
}
