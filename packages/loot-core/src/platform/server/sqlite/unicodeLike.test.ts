import { normalisedLike, unicodeLike } from './unicodeLike';

describe('unicode LIKE functionality', () => {
  it('empty pattern should not match to a value', () => {
    const result = unicodeLike(null, 'value');

    expect(result).toBe(0);
  });

  it('empty pattern should not match to null', () => {
    const result = unicodeLike(null, null);

    expect(result).toBe(0);
  });

  it('should match special characters', () => {
    // oxlint-disable-next-line no-template-curly-in-string
    const result = unicodeLike('.*+^${}()|[]\\', '.*+^${}()|[]\\');

    expect(result).toBe(1);
  });

  it('should use ? as the single character placeholder', () => {
    const result = unicodeLike('t?st', 'test');

    expect(result).toBe(1);
  });

  it('should use % as the zero-or-more characters placeholder', () => {
    const result = unicodeLike('t%st', 'te123st');

    expect(result).toBe(1);
  });

  it('should ignore case for unicode', () => {
    const result = unicodeLike('á', 'Ábcdefg');

    expect(result).toBe(1);
  });

  it('should ignore case for ascii', () => {
    const result = unicodeLike('a', 'Abcdefg');

    expect(result).toBe(1);
  });

  it('should treat null value as empty string', () => {
    const result = unicodeLike('%', null);

    expect(result).toBe(1);
  });

  it('should not match null value to the string "null"', () => {
    const result = unicodeLike('null', null);

    expect(result).toBe(0);
  });

  it('should treat \\% as a literal % character instead of a wildcard', () => {
    expect(unicodeLike('100\\%', '100%')).toBe(1);
    expect(unicodeLike('100\\%', '1000')).toBe(0);
  });

  it('should treat \\? as a literal ? character instead of a wildcard', () => {
    expect(unicodeLike('what\\?', 'what?')).toBe(1);
    expect(unicodeLike('what\\?', 'what!')).toBe(0);
  });

  it('should treat \\\\ as a literal \\ character', () => {
    expect(unicodeLike('c:\\\\test', 'c:\\test')).toBe(1);
  });
});

describe('normalisedLike', () => {
  it('matches the normalised value', () => {
    expect(normalisedLike('%cafe%', 'Le Café')).toBe(1);
    expect(normalisedLike('%strasse%', 'Hauptstraße')).toBe(1);
    expect(normalisedLike('%lodz%', 'Łódź')).toBe(1);
    expect(normalisedLike('%tea%', 'Coffee')).toBe(0);
  });

  it('treats null and empty values like an empty string', () => {
    expect(normalisedLike('%', null)).toBe(1);
    expect(normalisedLike('%', '')).toBe(1);
    expect(normalisedLike('%a%', null)).toBe(0);
    expect(normalisedLike('%a%', '')).toBe(0);
  });

  it('never matches an empty pattern', () => {
    expect(normalisedLike(null, 'value')).toBe(0);
    expect(normalisedLike('', 'value')).toBe(0);
    expect(normalisedLike(null, null)).toBe(0);
  });

  it('gives the same results after its memo of values fills up', () => {
    for (let i = 0; i < 12000; i++) {
      const value = `Payée ${i}`;
      expect(normalisedLike(`%payee ${i}%`, value)).toBe(1);
      expect(normalisedLike(`%payee ${i}x%`, value)).toBe(0);
    }
  });

  it('matches long values, which it does not memoise, the same way', () => {
    const padding = 'Ünïcödé nötes '.repeat(40);
    // Fill the memo of values first, so long values meet a full memo
    for (let i = 0; i < 5000; i++) {
      expect(normalisedLike('%', `Fill ${i}`)).toBe(1);
    }
    // Long values are normalised on every call, so keep this loop short
    for (let i = 0; i < 400; i++) {
      // Alternate between long values and short ones that go in the memo
      const value = i % 2 ? `${padding}Café ${i}` : `Café ${i}`;
      expect(value.length > 256).toBe(i % 2 === 1);
      expect(normalisedLike(`%cafe ${i}%`, value)).toBe(1);
      expect(normalisedLike(`%unicode notes%cafe ${i}%`, value)).toBe(i % 2);
      expect(normalisedLike(`%cafe ${i}x%`, value)).toBe(0);
    }
    // Values just below, at and above the length cap
    for (const length of [255, 256, 257]) {
      const value = 'É'.repeat(length);
      expect(normalisedLike(`%${'e'.repeat(length)}%`, value)).toBe(1);
      expect(normalisedLike(`%${'e'.repeat(length + 1)}%`, value)).toBe(0);
    }
  });
});
