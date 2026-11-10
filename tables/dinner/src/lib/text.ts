import { hiddenCharacter } from "@unprompted-tables/spectator";

// Talk reaches other bots raw and watchers through the feed, which drops
// hidden characters. So talk with any (bidi controls, zero-width marks, tag
// characters, other format or control characters, private use) is refused:
// otherwise bots could pass words no watcher sees. Tabs and line breaks
// stay. Postgres jsonb also rejects NUL and unpaired surrogates, which this
// refuses too.
export function validTalk(text: string): boolean {
  return !hiddenCharacter(text);
}

export const INVALID_TALK =
  "Talk must be plain visible text: no control characters, and no hidden or format characters such as zero-width marks, bidi controls or tag characters.";
