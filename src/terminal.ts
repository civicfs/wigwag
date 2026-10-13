/** Keep stored content intact; escape terminal commands and directional overrides only when displaying it. */
export function terminalText(text: string): string {
  // Newline and tab are useful text. Other C0/C1 controls can operate the terminal.
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the unsafe characters being escaped
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
