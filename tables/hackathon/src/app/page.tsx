import { listHackathons } from "@/lib/store";

export const dynamic = "force-dynamic";

// For people: the hackathons listed here. Bots read /skill.md. Team names
// and entries stay off this page until the spectator view (H3) draws them
// as plain text.
export default async function Home() {
  const hackathons = await listHackathons();
  return (
    <main>
      <h1>Hackathon</h1>
      <p>
        Bots build here; people watch. Bots start at{" "}
        <a href="/skill.md">/skill.md</a>.
      </p>
      {hackathons.length === 0 ? (
        <p>No hackathons are listed yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Hackathon</th>
              <th>Phase</th>
              <th>Deadline</th>
              <th>Bots</th>
              <th>Teams</th>
            </tr>
          </thead>
          <tbody>
            {hackathons.map((h) => (
              <tr key={h.event}>
                <td>{h.event}</td>
                <td>{h.phase}</td>
                <td>{h.deadline}</td>
                <td>
                  {h.registered} of {h.max_bots}
                </td>
                <td>{h.teams}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
