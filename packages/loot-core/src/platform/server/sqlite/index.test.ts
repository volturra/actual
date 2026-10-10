// @ts-strict-ignore
import { patchFetchForSqlJS } from '#mocks/util';

import {
  _getModule,
  execQuery,
  init,
  openDatabase,
  prepare,
  runQuery,
  transaction,
} from './index';

beforeAll(async () => {
  const baseURL = `${__dirname}/../../../../../../node_modules/@jlongster/sql.js/dist/`;
  patchFetchForSqlJS(baseURL);

  return init({ baseURL });
});

// Two connections to one file, so one can hold a lock the other runs into.
// In the browser this is another tab or worker on the same budget file.
function openTwoConnections(name: string) {
  const SQL = _getModule();
  // @ts-expect-error 2nd argument missed in sql.js types
  const db = new SQL.Database(`/${name}.sqlite`, { filename: true });
  execQuery(db, 'PRAGMA journal_mode=MEMORY;' + initSQL);
  // @ts-expect-error 2nd argument missed in sql.js types
  const other = new SQL.Database(`/${name}.sqlite`, { filename: true });
  return { db, other };
}

function insertNumber(id: string, number: number) {
  return `INSERT INTO numbers (id, number) VALUES ('${id}', ${number})`;
}

const initSQL = `
CREATE TABLE numbers (id TEXT PRIMARY KEY, number INTEGER);
CREATE TABLE textstrings (id TEXT PRIMARY KEY, string TEXT);
`;

describe('Web sqlite', () => {
  it('should rollback transactions', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 4)");

    let rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    expect(() => {
      transaction(db, () => {
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 5)");
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 6)");
        // Insert an invalid one that will error
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
      });
    }).toThrow(/constraint failed/);
    consoleSpy.mockRestore();

    // Nothing should have changed in the db
    rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);
  });

  it('should support nested transactions', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 4)");

    let rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);

    transaction(db, () => {
      runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 5)");
      runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 6)");

      // Only this transaction should fail
      const consoleSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => null);
      expect(() => {
        transaction(db, () => {
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id4', 7)");
          // Insert an invalid one that will error
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        });
      }).toThrow(/constraint failed/);
      consoleSpy.mockRestore();
    });

    // Nothing should have changed in the db
    rows = runQuery(db, 'SELECT * FROM numbers', null, true);
    expect(rows.length).toBe(3);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[0].number).toBe(4);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[1].number).toBe(5);
    // @ts-expect-error Property 'number' does not exist on type 'unknown'
    expect(rows[2].number).toBe(6);
  });

  it('should support immediate transactions with rollback and nesting', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    transaction(
      db,
      () => {
        runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        // Nested transactions become savepoints regardless of the mode
        transaction(
          db,
          () => {
            runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id2', 2)");
          },
          { immediate: true },
        );
      },
      { immediate: true },
    );
    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(2);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    expect(() => {
      transaction(
        db,
        () => {
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id3', 3)");
          runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id1', 1)");
        },
        { immediate: true },
      );
    }).toThrow(/constraint failed/);
    consoleSpy.mockRestore();

    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(2);
    // The failed transaction must have released the write lock
    runQuery(db, "INSERT INTO numbers (id, number) VALUES ('id4', 4)");
    expect(runQuery(db, 'SELECT * FROM numbers', null, true).length).toBe(3);
  });

  it('should use the crdt index for a batched cell lookup', async () => {
    // Mirrors the query `compareMessages` in server/sync builds for a
    // full chunk. If the planner ever falls back to a table scan on the
    // web build's SQLite, bulk edits get slow again.
    const db = await openDatabase();
    execQuery(
      db,
      `
      CREATE TABLE messages_crdt (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL UNIQUE,
        dataset TEXT NOT NULL,
        row TEXT NOT NULL,
        column TEXT NOT NULL,
        value BLOB NOT NULL
      );
      CREATE INDEX messages_crdt_search ON messages_crdt(dataset, row, column, timestamp);
      `,
    );

    const termCount = 100;
    const term = '(dataset = ? AND row = ? AND column = ? AND timestamp >= ?)';
    const sql =
      'SELECT dataset, row, column, timestamp FROM messages_crdt WHERE ' +
      Array(termCount).fill(term).join(' OR ');
    const params = Array.from({ length: termCount }, (_, index) => [
      'transactions',
      `row${index}`,
      'amount',
      '2024-01-01T00:00:00.000Z-0000-0000000000000000',
    ]).flat();

    const plan = runQuery<{ detail: string }>(
      db,
      'EXPLAIN QUERY PLAN ' + sql,
      params,
      true,
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some(step => step.detail.includes('SCAN'))).toBe(false);
    expect(
      plan.some(step => step.detail.includes('messages_crdt_search')),
    ).toBe(true);

    // And the query itself runs within the parameter limits
    expect(runQuery(db, sql, params, true)).toEqual([]);
  });

  it('should match regex on text fields', async () => {
    const db = await openDatabase();
    execQuery(db, initSQL);

    runQuery(
      db,
      "INSERT INTO textstrings (id, string) VALUES ('id1', 'not empty string')",
    );
    runQuery(db, "INSERT INTO textstrings (id) VALUES ('id2')");

    const rows = runQuery(
      db,
      'SELECT id FROM textstrings where REGEXP("n.", string)',
      null,
      true,
    );
    expect(rows.length).toBe(1);
    // @ts-expect-error Property 'id' does not exist on type 'unknown'
    expect(rows[0].id).toBe('id1');
  });

  describe('when a statement fails part way', () => {
    let consoleSpy;
    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => null);
    });
    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it.each([
      ['a sql string', (db, sql) => runQuery(db, sql)],
      ['a prepared statement', (db, sql) => runQuery(db, prepare(db, sql))],
    ])(
      'should still commit transactions after a busy write (%s)',
      (label, write) => {
        const { db, other } = openTwoConnections(
          'busy-write-' + label.replace(/ /g, '-'),
        );

        other.exec('BEGIN EXCLUSIVE');
        expect(() => write(db, insertNumber('id1', 1))).toThrow(/locked/);
        other.exec('ROLLBACK');

        // The failed write must not stay running, or every COMMIT fails
        // with "cannot commit transaction - SQL statements in progress"
        transaction(db, () => {
          runQuery(db, insertNumber('id2', 2));
        });
        transaction(
          db,
          () => {
            runQuery(db, insertNumber('id3', 3));
          },
          { immediate: true },
        );
        expect(runQuery(db, 'SELECT id FROM numbers', [], true)).toEqual([
          { id: 'id2' },
          { id: 'id3' },
        ]);
      },
    );

    it('should release the lock of a read that fails part way', () => {
      const { db, other } = openTwoConnections('failed-read');
      other.exec(insertNumber('id1', 1));

      // Reading a row throws after the first step, while the read holds
      // its shared lock
      const stmt = prepare(db, 'SELECT * FROM numbers');
      stmt.getAsObject = () => {
        throw new Error('read failed');
      };
      expect(() => runQuery(db, stmt, [], true)).toThrow('read failed');

      // A read left running keeps its shared lock, so the other connection
      // could never commit a write again
      other.exec('BEGIN');
      other.exec(insertNumber('id2', 2));
      other.exec('COMMIT');
      expect(runQuery(db, 'SELECT id FROM numbers', [], true)).toEqual([
        { id: 'id1' },
        { id: 'id2' },
      ]);
    });
  });
});
