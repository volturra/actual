import { compareLikeSQL, likePatterns, likeValues } from '#mocks/like-cases';
import type { CompareLikeRow } from '#mocks/like-cases';

// oxlint-disable-next-line no-restricted-imports -- compares the better-sqlite3 build
import { openDatabase, runQuery } from './index.electron';

// The sql.js build is compared in index.test.ts
describe('NORMALISED_LIKE on better-sqlite3', () => {
  it('gives the same results as UNICODE_LIKE of NORMALISE', () => {
    const db = openDatabase(':memory:');
    runQuery(db, 'CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT)');
    likeValues.forEach((value, id) => {
      runQuery(db, 'INSERT INTO strings (id, value) VALUES (?, ?)', [
        id,
        value,
      ]);
    });

    let matches = 0;
    for (const pattern of likePatterns) {
      const rows = runQuery(
        db,
        compareLikeSQL,
        [pattern, pattern, pattern, pattern],
        true,
      ) as Array<CompareLikeRow>;
      expect(rows).toHaveLength(likeValues.length);
      for (const row of rows) {
        const value = likeValues[row.id];
        expect({ pattern, value, like: row.new_like }).toEqual({
          pattern,
          value,
          like: row.old_like,
        });
        expect({ pattern, value, notLike: row.new_not_like }).toEqual({
          pattern,
          value,
          notLike: row.old_not_like,
        });
        matches += row.old_like;
      }
    }
    // The cases exercise both outcomes
    expect(matches).toBeGreaterThan(30);
    expect(matches).toBeLessThan(likePatterns.length * likeValues.length);
  });
});
