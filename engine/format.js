/**
 * Text that a formatting editor changes while it is typed.
 */

/* A run of lines that all open the same way. The editor numbers the rest of the
   run itself once the first line has started it. */
const NUMBER_ITEM = /^([ \t]*)(\d+)[.)]([ \t]+)(.*)$/;
const BULLET_ITEM = /^([ \t]*)[-*+]([ \t]+)(.*)$/;

const kindOf = (line) => {
  if (NUMBER_ITEM.test(line)) return "number";
  if (BULLET_ITEM.test(line)) return "bullet";
  return null;
};

const stripMarker = (line) => {
  const num = line.match(NUMBER_ITEM);
  if (num) return num[1] + num[4];
  const bullet = line.match(BULLET_ITEM);
  if (bullet) return bullet[1] + bullet[3];
  return line;
};

/* Remove the list markers the editor will supply on its own. */
export function deferListMarkers(text) {
  const lines = text.split("\n");
  let removed = 0;
  let previous = null;

  const out = lines.map((line) => {
    const kind = kindOf(line);
    if (!kind) { previous = null; return line; }
    if (kind === previous) { removed++; return stripMarker(line); }
    previous = kind;
    return line;
  });

  return { text: out.join("\n"), removed };
}

/** True if the text has a run of two or more list items. */
export function hasList(text) {
  return deferListMarkers(text).removed > 0;
}

/* Substitutions that are not list markers, and the preference that stops each.
   These have no equivalent of the trick above: the editor rewrites what you
   typed rather than adding to it, so the only cure is the checkbox. */
const SUBSTITUTIONS = [
  [/["']/, "straight quotes become curly", "Use smart quotes"],
  [/(?:^|\s)(?:https?:\/\/|www\.)\S/i, "web addresses become links",
   "Automatically detect links"],
  [/--|\.\.\.|\((?:c|r|tm)\)|\b\d\/\d\b/i, "some characters become symbols",
   "Automatic substitution, on the Substitutions tab"],
];

/**
 * One sentence about what the editor will change, or null.
 *
 * A warning and not a repair. These are account settings with no interface for
 * anything outside the editor to reach, and rewriting the text to dodge a
 * substitution would be a worse surprise than saying what will happen.
 */
export function substitutionRisk(text) {
  const hits = SUBSTITUTIONS.filter(([re]) => re.test(text));
  if (!hits.length) return null;
  const why = hits.map(([, reason]) => reason);
  const fixes = [...new Set(hits.map(([, , fix]) => fix))];
  const list = why.length === 1 ? why[0]
    : `${why.slice(0, -1).join(", ")} and ${why[why.length - 1]}`;
  return `Google Docs changes text as you type, so ${list}. To keep the text ` +
         `exactly as written, turn off ${fixes.join(" and ")} under ` +
         `Tools → Preferences.`;
}

/** What to say when the editor is expected to number a list itself. */
export const LIST_NOTE =
  "Numbering and bullets are left to the editor, the same as typing them by " +
  "hand. This needs Automatically detect lists switched on under " +
  "Tools → Preferences, which is the default.";
