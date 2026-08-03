const ESC = "\x1b";
// CSI (ESC [ ... letter) と OSC (ESC ] ... BEL または ESC \) の両方にマッチする。
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[a-zA-Z]|\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\))`,
  "g",
);

/** ANSIエスケープシーケンス（CSI/OSC）を除去する。`\n`/`\t`はそのまま保持する。 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}
