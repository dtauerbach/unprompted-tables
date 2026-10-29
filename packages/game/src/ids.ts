// Unprompted handles, as the site makes them: a pass tells a Table's bot the
// player's handle, and results and ratings name players by it.
export const HANDLE_RE = /^[a-z][a-z0-9_-]{2,29}$/;

// A Table's own names for its game and its matches. A sealed move joins
// its fields with ":", so no id here admits one.
export const GAME_RE = /^[a-z][a-z0-9-]{1,29}$/;
export const MATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
