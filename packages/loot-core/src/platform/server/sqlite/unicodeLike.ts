import { LRUCache } from 'lru-cache';

import { normalise } from './normalise';

const likePatternCache = new LRUCache<string, RegExp>({ max: 500 });

const REGEX_SPECIAL = /[.*+^${}()|[\]\\?]/g;

function likePatternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === '%' || next === '?' || next === '\\') {
        // escaped wildcard — treat as literal character
        regexStr += next.replace(REGEX_SPECIAL, '\\$&'); // ? added here
        i += 2;
        continue;
      }
    }
    if (ch === '%') {
      regexStr += '.*';
    } else if (ch === '?') {
      regexStr += '.';
    } else {
      regexStr += ch.replace(REGEX_SPECIAL, '\\$&');
    }
    i++;
  }
  return new RegExp(regexStr, 'i');
}

export function unicodeLike(
  pattern: string | null,
  value: string | null,
): number {
  if (!pattern) return 0;
  if (!value) value = '';

  let cachedRegExp = likePatternCache.get(pattern);
  if (!cachedRegExp) {
    cachedRegExp = likePatternToRegex(pattern);
    likePatternCache.set(pattern, cachedRegExp);
  }

  return cachedRegExp.test(value) ? 1 : 0;
}

// Normalised forms of recently matched values. A search evaluates the same
// payee, category and account names once per transaction row. Normalising is
// a pure function of the string, so a cached entry can never be stale.
const normalisedCache = new LRUCache<string, string>({ max: 5000 });

// Longer values are normalised on every call instead of being cached. Names
// are far shorter than this and repeat on every row, while long values are
// mostly notes, which rarely repeat; caching them would evict the names and
// keep large strings alive. 5000 entries of at most 256 characters, plus
// their normalised copies, stay under about 5 MB.
const NORMALISED_CACHE_MAX_LENGTH = 256;

/**
 * Same result as `UNICODE_LIKE(pattern, NORMALISE(value))`, in one SQL
 * function call per row instead of two, and normalising each distinct short
 * value only once.
 */
export function normalisedLike(
  pattern: string | null,
  value: string | null,
): number {
  if (!value) {
    return unicodeLike(pattern, null);
  }
  if (value.length > NORMALISED_CACHE_MAX_LENGTH) {
    return unicodeLike(pattern, normalise(value));
  }
  let normalised = normalisedCache.get(value);
  if (normalised === undefined) {
    normalised = normalise(value) ?? '';
    normalisedCache.set(value, normalised);
  }
  return unicodeLike(pattern, normalised);
}
