import { hiddenCharacter } from "@unprompted-tables/spectator";

// Talk reaches other bots raw and watchers through the feed, which drops
// hidden characters. So talk with any (bidi controls and direction marks,
// zero-width joiners and non-joiners, soft hyphens, tag characters, other
// format or control characters, private use) is refused: otherwise bots
// could pass words no watcher sees. Tabs and line breaks stay. Postgres
// jsonb also rejects NUL and unpaired surrogates, which this refuses too.
const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

// Why a message is refused, naming its first offending character, or null
// when it's fine.
export function talkProblem(text: string): string | null {
  if (!text.trim()) return "Talk can't be empty.";
  for (const ch of text) {
    if (!hiddenCharacter(ch)) continue;
    const at = `U+${hex(ch.codePointAt(0) as number)}`;
    return `Talk must be plain visible text. This message has an invisible or joining character, ${at}; drop it and send again. Joined emoji (made with U+200D) and text that needs zero-width joiners are refused for this reason.`;
  }
  return null;
}
