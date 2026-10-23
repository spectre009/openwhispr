// Parsing/serialization for hotkey lists (#936), stored as comma-separated
// strings — backward compatible with legacy single-value entries. The comma
// KEY is itself a valid hotkey (e.g. "Control+,"): no accelerator legitimately
// ends with "+", so a split segment ending in "+" gets its comma restored.
//
// Keep in sync with the renderer twin in src/utils/hotkeys.ts.

const HOTKEY_LIST_SEPARATOR = ",";

/**
 * Normalize a stored hotkey value (string, comma-separated string, or array)
 * into a clean array: trimmed, de-duplicated, empties removed, order preserved.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function parseHotkeyList(value) {
  if (value == null) return [];

  const raw = Array.isArray(value)
    ? value.flatMap((item) => String(item).split(HOTKEY_LIST_SEPARATOR))
    : String(value).split(HOTKEY_LIST_SEPARATOR);

  const seen = new Set();
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    let hotkey = raw[i].trim();
    // A non-final segment ending in "+" lost its comma key to the split only if
    // the next raw element was empty (the trailing comma key produced an empty string).
    if (hotkey.endsWith("+") && i < raw.length - 1 && raw[i + 1].trim() === "") {
      hotkey += HOTKEY_LIST_SEPARATOR;
    }
    if (!hotkey || seen.has(hotkey)) continue;
    seen.add(hotkey);
    result.push(hotkey);
  }
  return result;
}

/**
 * Serialize a hotkey value into the canonical comma-separated storage string.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string}
 */
function serializeHotkeyList(value) {
  return parseHotkeyList(value).join(HOTKEY_LIST_SEPARATOR);
}

// --- Style hotkeys (Stage 4): extra keys on the dictation slot -----------------

// Modifier spellings that name the same key, for duplicate checks only.
const MODIFIER_ALIASES = {
  control: "control",
  ctrl: "control",
  command: "command",
  cmd: "command",
  alt: "alt",
  option: "alt",
  shift: "shift",
  super: "super",
  meta: "super",
  win: "super",
};

/**
 * A spelling-independent form of one hotkey, for duplicate checks: modifiers
 * are case-insensitive, aliases collapse ("Ctrl" = "Control") and their order
 * doesn't matter, so "Shift+Ctrl+a" and "Control+Shift+A" are the same key.
 *
 * @param {string} hotkey
 * @param {string} [platform]
 * @returns {string}
 */
function canonicalHotkey(hotkey, platform = process.platform) {
  const parts = String(hotkey ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  // "Control++" is the plus key: the empty segment the split dropped was it.
  if (String(hotkey ?? "").endsWith("++")) parts.push("plus");
  const modifiers = new Set();
  const keys = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "commandorcontrol" || lower === "cmdorctrl") {
      modifiers.add(platform === "darwin" ? "command" : "control");
    } else if (MODIFIER_ALIASES[lower]) {
      modifiers.add(MODIFIER_ALIASES[lower]);
    } else {
      keys.push(lower);
    }
  }
  return [...[...modifiers].sort(), ...keys].join("+");
}

/**
 * The dictation slot's full key list, built in one place for startup, hotkey
 * and activation-mode changes and style edits: the dictation hotkey(s) first,
 * then each style's key. A style key that repeats a dictation key or an
 * earlier style key (any spelling) is left out and reported in `duplicates`,
 * so the dictation hotkey always wins.
 *
 * @param {string|string[]} dictationKeys
 * @param {Map<string,string>|Iterable<[string,string]>} styleKeys hotkey -> style id
 * @param {string} [platform]
 */
function buildDictationSlotKeys(dictationKeys, styleKeys, platform = process.platform) {
  const own = parseHotkeyList(dictationKeys);
  const holders = new Map();
  for (const hotkey of own) {
    const canonical = canonicalHotkey(hotkey, platform);
    if (!holders.has(canonical)) holders.set(canonical, { kind: "dictation", hotkey });
  }
  const style = [];
  const duplicates = [];
  for (const [hotkey, styleId] of styleKeys ?? []) {
    const canonical = canonicalHotkey(hotkey, platform);
    const holder = holders.get(canonical);
    if (holder) {
      duplicates.push({ hotkey, styleId, conflictsWith: holder });
      continue;
    }
    holders.set(canonical, { kind: "style", hotkey, styleId });
    style.push({ hotkey, styleId });
  }
  return {
    keys: [...own, ...style.map((entry) => entry.hotkey)],
    dictationKeys: own,
    styleKeys: style,
    duplicates,
  };
}

// Style ids as the renderer's style record makes them (config/styles/library.ts).
const STYLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PLAIN_STYLE_ID = "plain";
const STYLE_HOTKEY_MAX_LENGTH = 64;

function isValidStyleId(id) {
  return typeof id === "string" && STYLE_ID_PATTERN.test(id) && id !== PLAIN_STYLE_ID;
}

/** One hotkey (never a list), short and printable. */
function isValidStyleHotkey(hotkey) {
  if (typeof hotkey !== "string") return false;
  const trimmed = hotkey.trim();
  if (!trimmed || trimmed !== hotkey || trimmed.length > STYLE_HOTKEY_MAX_LENGTH) return false;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const list = parseHotkeyList(trimmed);
  return list.length === 1 && list[0] === trimmed;
}

/**
 * `DICTATION_STYLE_KEYS` from .env: a JSON object of hotkey -> style id. Bad
 * entries are skipped, and a style keeps only its first key.
 *
 * @param {string|null|undefined} raw
 * @returns {Map<string,string>}
 */
function parseStyleKeyMap(raw) {
  const map = new Map();
  if (typeof raw !== "string" || !raw.trim()) return map;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return map;
  const styles = new Set();
  for (const [hotkey, styleId] of Object.entries(data)) {
    if (!isValidStyleHotkey(hotkey) || !isValidStyleId(styleId) || styles.has(styleId)) continue;
    styles.add(styleId);
    map.set(hotkey, styleId);
  }
  return map;
}

/**
 * The .env value for a style key map, "" when empty (the line is then left
 * out). .env values are written unquoted, where "#" starts a comment, so it is
 * escaped; JSON keeps every other character (backtick, comma, quotes) intact.
 *
 * @param {Map<string,string>|Iterable<[string,string]>} map
 * @returns {string}
 */
function serializeStyleKeyMap(map) {
  const entries = [...(map ?? [])];
  if (entries.length === 0) return "";
  return JSON.stringify(Object.fromEntries(entries)).replace(/#/g, "\\u0023");
}

module.exports = {
  parseHotkeyList,
  serializeHotkeyList,
  canonicalHotkey,
  buildDictationSlotKeys,
  isValidStyleId,
  isValidStyleHotkey,
  parseStyleKeyMap,
  serializeStyleKeyMap,
};
