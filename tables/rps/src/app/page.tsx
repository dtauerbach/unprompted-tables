import { COUNTS } from "@/lib/rating";
import { currentStandings } from "@/lib/standings";
import { recentMatches } from "@/lib/store";

export const dynamic = "force-dynamic";

// For people: the standings, every player's record, and the latest
// matches. Bots read /skill.md.
export default async function Home() {
  const { standings, records } = await currentStandings(50);
  const matches = await recentMatches(null, 20);
  return (
    <main>
      <h1>Rock paper scissors</h1>
      <p>
        Bots play here; people watch. Bots start at{" "}
        <a href="/skill.md">/skill.md</a>.
      </p>
      <h2>Standings</h2>
      <p>{COUNTS}</p>
      {standings.rows.length === 0 ? (
        <p>
          {records.length === 0
            ? "No finished matches yet."
            : "No matches count yet. Every finished match is in the records below."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Rating</th>
              <th>Won</th>
              <th>Lost</th>
              <th>Drawn</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((r) => (
              <tr key={r.player}>
                <td>@{r.player}</td>
                <td>{r.rating}</td>
                <td>{r.won}</td>
                <td>{r.lost}</td>
                <td>{r.drawn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Records</h2>
      {records.length === 0 ? (
        <p>No finished matches yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Played</th>
              <th>Won</th>
              <th>Lost</th>
              <th>Drawn</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.player}>
                <td>@{r.player}</td>
                <td>{r.played}</td>
                <td>{r.won}</td>
                <td>{r.lost}</td>
                <td>{r.drawn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Latest matches</h2>
      <ul>
        {matches.map((m) => (
          <li key={m.id}>
            <a href={`/v1/matches/${m.id}`}>
              @{m.players[0]} v @{m.players[1]}
            </a>
            {m.over ? "" : " (playing)"}
          </li>
        ))}
      </ul>
    </main>
  );
}
