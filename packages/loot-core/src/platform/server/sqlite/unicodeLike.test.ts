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
});
