/**
 * How web text is kept from passing for this server's own output. One place, because two things
 * depend on it: the text view, which applies it, and the search packer, which has to know how
 * long a title or an excerpt becomes once it is applied in order to keep a response within its
 * budget.
 *
 * Two changes are made, and each one is counted: a "<" that opens anything a reader could take
 * for one of our untrusted-block tags is escaped, and a line that starts like a line this server
 * writes is prefixed with "| ".
 */

const ENVELOPE_TAG = /<(\/?)\s*(results|page)\b/giu
/** Every line shape this server writes: headers, footers, result lines, and passage headers. */
const PROTOCOL_LINE =
  /^\s*(web_search |web_fetch |page \d+ |sources:|note:|error |more:|read:|read more:|outline |size ~|title: |url: |\[output clamped|\[\.\.\. skipped |\[([a-z0-9]{3,12}:)?r\d{1,3}\]|(\d+\. (exact|normalized|closest \(not a match\)) (\| )?)?\[(s_[a-z0-9]+:)?\d+-\d+\])/u

export interface Neutralized {
  text: string
  count: number
}

/** Shown text differs from the stored snapshot only at the spots counted here. */
export function neutralize(text: string): Neutralized {
  let count = 0
  const escaped = text.replace(ENVELOPE_TAG, (_match, slash: string, tag: string) => {
    count += 1
    return `&lt;${slash}${tag}`
  })
  const lines = escaped.split('\n').map((line) => {
    if (!PROTOCOL_LINE.test(line)) return line
    count += 1
    return `| ${line}`
  })
  return { text: lines.join('\n'), count }
}
