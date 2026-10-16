// Color for text on a terminal: ANSI codes when color is on, the text as is otherwise.
export const palette = (color: boolean) => (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
