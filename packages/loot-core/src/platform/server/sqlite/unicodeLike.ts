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
const normalisedCache = new Map<string, string | null>();
const NORMALISED_CACHE_MAX = 5000;

/**
 * Same result as `UNICODE_LIKE(pattern, NORMALISE(value))`, in one SQL
 * function call per row instead of two, and normalising each distinct value
 * only once.
 */
export function normalisedLike(
  pattern: string | null,
  value: string | null,
): number {
  if (!value) {
    return unicodeLike(pattern, null);
  }
  let normalised = normalisedCache.get(value);
  if (normalised === undefined) {
    normalised = normalise(value);
    if (normalisedCache.size >= NORMALISED_CACHE_MAX) {
      normalisedCache.clear();
    }
    normalisedCache.set(value, normalised);
  }
  return unicodeLike(pattern, normalised);
}
