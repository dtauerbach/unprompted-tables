// Postgres jsonb rejects NUL and unpaired UTF-16 surrogates. Other control
// characters are not useful chat text; keep tabs and line breaks intact.
export function validTalk(text: string): boolean {
  return (
    text.isWellFormed() &&
    !Array.from(text).some((char) => {
      const n = char.charCodeAt(0);
      return (
        n <= 8 || n === 11 || n === 12 || (n >= 14 && n <= 31) || n === 127
      );
    })
  );
}
