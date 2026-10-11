// Values and LIKE patterns that cover accents, case, special characters,
// wildcards and empty input, for comparing `$like` implementations on SQLite
export const likeValues: Array<string | null> = [
  null,
  '',
  ' ',
  'Coffee',
  'COFFEE shop',
  'Le Café',
  'LE CAFÉ',
  'Café decomposed',
  'Hauptstraße',
  'Łódź',
  'Øresund',
  'Œuvre',
  'Ñandú',
  'İstanbul',
  'Ångström',
  'naïve façade',
  '100% juice',
  '50%',
  'under_score',
  'question?',
  'back\\slash',
  'dots.and*stars',
  'emoji ☕ bar',
  '日本語',
  'multi\nline',
];

export const likePatterns: Array<string | null> = [
  null,
  '',
  '%',
  '%%',
  '%cafe%',
  '%café%',
  '%CAFE%',
  'coffee',
  'coffee%',
  '%shop',
  '%strasse%',
  '%straße%',
  '%lodz%',
  '%oresund%',
  '%oeuvre%',
  '%nandu%',
  '%istanbul%',
  '%angstrom%',
  '%naive facade%',
  '%\\%%',
  '%0\\%%',
  '%_%',
  'under_score',
  '%?%',
  'question\\?',
  '%t?n%',
  '%\\\\%',
  '%.%',
  '%*%',
  '%☕%',
  '%本%',
  '%multi%line%',
];

// One row per value: the old `$like`/`$notlike` expressions next to the
// `NORMALISED_LIKE` ones, for the pattern bound to each of the four `?`
export const compareLikeSQL = `
  SELECT id,
    UNICODE_LIKE(?, NORMALISE(value)) AS old_like,
    NORMALISED_LIKE(?, value) AS new_like,
    (NOT UNICODE_LIKE(?, NORMALISE(value)) OR value IS NULL) AS old_not_like,
    (NOT NORMALISED_LIKE(?, value) OR value IS NULL) AS new_not_like
  FROM strings ORDER BY id
`;

export type CompareLikeRow = {
  id: number;
  old_like: number;
  new_like: number;
  old_not_like: number;
  new_not_like: number;
};
