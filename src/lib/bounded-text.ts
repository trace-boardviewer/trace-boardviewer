/**
 * Text that comes from an input file and is quoted in an error message, a warning or a diagnostic is cut: a token of a few hundred
 * kilobytes would otherwise reach the dialog, the report and the log as it is. The cut keeps the start (what identifies the problem),
 * never splits a surrogate pair and ends with an ellipsis.
 */

/** The most characters of one error message, warning text or diagnostic. */
export const MAX_MESSAGE_CHARS = 1000;
/** The most characters of one value that a structured message quotes (a name, a token). */
export const MAX_QUOTED_CHARS = 200;

export function boundText(text: string, max: number = MAX_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
