// @ts-strict-ignore
import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Database } from '@jlongster/sql.js';

import * as sqlite from '#platform/server/sqlite';
import * as db from '#server/db';

import {
  applyMigration,
  getAppliedMigrations,
  getMigrationId,
  getMigrationList,
  getMigrationsDir,
  getPending,
  migrate,
  withMigrationsDir,
} from './migrations';

beforeEach(global.emptyDatabase(true));

describe('Migrations', () => {
  test('gets the latest migrations', async () => {
    const applied = await getAppliedMigrations(db.getDatabase());
    const available = await getMigrationList(
      __dirname + '/../../mocks/migrations',
    );

    expect(applied.length).toBe(0);
    expect(available).toMatchSnapshot();
    expect(getPending(applied, available)).toMatchSnapshot();
  });

  test('applied migrations are returned in order', async () => {
    return withMigrationsDir(
      __dirname + '/../../mocks/migrations',
      async () => {
        await migrate(db.getDatabase());

        const migrations = await getAppliedMigrations(db.getDatabase());
        const last = 0;
        for (const migration of migrations) {
          if (migration <= last) {
            throw new Error('Found older migration out of order');
          }
        }
      },
    );
  });

  test('checks if there are unknown migrations', async () => {
    return withMigrationsDir(
      __dirname + '/../../mocks/migrations',
      async () => {
        // Insert a random migration id
        db.runQuery('INSERT INTO __migrations__ (id) VALUES (1000)');

        try {
          await migrate(db.getDatabase());
        } catch (e) {
          expect(e.message).toBe('out-of-sync-migrations');
          return;
        }
        expect('should never reach here').toBe(null);
      },
    );
  });

  test('tolerates migrations applied by a newer version of the app', async () => {
    return withMigrationsDir(
      __dirname + '/../../mocks/migrations',
      async () => {
        await migrate(db.getDatabase());

        // Simulate a migration applied by a newer version of the app
        // (its id is newer than anything this version knows about)
        db.runQuery('INSERT INTO __migrations__ (id) VALUES (9999999999999)');

        // Should not throw
        await migrate(db.getDatabase());

        const applied = await getAppliedMigrations(db.getDatabase());
        expect(applied).toContain(9999999999999);
      },
    );
  });

  test('rejects a newer unknown migration when a known one is missing', async () => {
    return withMigrationsDir(
      __dirname + '/../../mocks/migrations',
      async () => {
        // A database that skipped known migrations but somehow contains
        // one from a newer version — impossible via any legitimate flow
        // (append-only migrations mean the newer version knew ours too),
        // so it must be treated as corrupt, not migrated further
        db.runQuery('INSERT INTO __migrations__ (id) VALUES (1508717984291)');
        db.runQuery('INSERT INTO __migrations__ (id) VALUES (9999999999999)');

        await expect(migrate(db.getDatabase())).rejects.toThrow(
          'out-of-sync-migrations',
        );
      },
    );
  });

  test('applies a pending migration whose id sorts below an applied one', async () => {
    const dir = nativeFs.mkdtempSync(
      path.join(os.tmpdir(), 'interleaved-migrations-'),
    );
    try {
      nativeFs.writeFileSync(
        path.join(dir, '1790000000001_a.sql'),
        'CREATE TABLE interleave_a (id TEXT PRIMARY KEY);',
      );
      nativeFs.writeFileSync(
        path.join(dir, '1790000000003_c.sql'),
        'CREATE TABLE interleave_c (id TEXT PRIMARY KEY);',
      );
      await withMigrationsDir(dir, async () => {
        await migrate(db.getDatabase());
      });

      // A later release ships a migration authored earlier: its id
      // sorts between two already-applied ones. The upgrade must treat
      // it as pending, not as an out-of-sync database.
      nativeFs.writeFileSync(
        path.join(dir, '1790000000002_b.sql'),
        'CREATE TABLE interleave_b (id TEXT PRIMARY KEY);',
      );
      await withMigrationsDir(dir, async () => {
        await migrate(db.getDatabase());
      });

      const applied = await getAppliedMigrations(db.getDatabase());
      expect(applied).toContain(1790000000002);
      const desc = await db.first<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name = 'interleave_b'",
      );
      expect(desc?.name).toBe('interleave_b');
    } finally {
      nativeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a migrated database when no migrations exist on disk', async () => {
    await withMigrationsDir(__dirname + '/../../mocks/migrations', async () => {
      await migrate(db.getDatabase());
    });

    // An empty migrations directory — a broken install must not pass
    // validation just because every applied id looks unknown
    const dir = nativeFs.mkdtempSync(
      path.join(os.tmpdir(), 'empty-migrations-'),
    );
    try {
      await withMigrationsDir(dir, async () => {
        await expect(migrate(db.getDatabase())).rejects.toThrow(
          'out-of-sync-migrations',
        );
      });
    } finally {
      nativeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('app runs database migrations', async () => {
    return withMigrationsDir(
      __dirname + '/../../mocks/migrations',
      async () => {
        let desc = await db.first<{ sql: string }>(
          "SELECT * FROM sqlite_master WHERE name = 'poop'",
        );
        expect(desc).toBe(null);

        await migrate(db.getDatabase());

        desc = await db.first<{ sql: string }>(
          "SELECT * FROM sqlite_master WHERE name = 'poop'",
        );
        expect(desc).toBeDefined();
        expect(desc.sql.indexOf('is_income')).toBe(-1);
        expect(desc.sql.indexOf('is_expense')).not.toBe(-1);
      },
    );
  });

  describe('stale planner stats', () => {
    const dropStatsId = 1791589705434;

    async function statTables() {
      const rows = await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%' ORDER BY name",
      );
      return rows.map(row => row.name);
    }

    async function unapplyDropStats() {
      db.runQuery('DELETE FROM __migrations__ WHERE id = ?', [dropStatsId]);
    }

    test('a new budget carries no planner stats', async () => {
      // Earlier migrations run ANALYZE on the empty tables
      await migrate(db.getDatabase());

      expect(await statTables()).toEqual([]);
      expect(await getAppliedMigrations(db.getDatabase())).toContain(
        dropStatsId,
      );
    });

    test('drops stats an existing budget already has', async () => {
      await migrate(db.getDatabase());
      await unapplyDropStats();
      await db.insertCategoryGroup({ id: 'group1', name: 'group1' });
      db.execQuery('ANALYZE');
      expect(await statTables()).toContain('sqlite_stat1');

      await migrate(db.getDatabase());

      expect(await statTables()).toEqual([]);
      expect(await getAppliedMigrations(db.getDatabase())).toContain(
        dropStatsId,
      );
    });

    test('the open connection plans as if the file were opened afresh', async () => {
      // A join whose plan depends on how many rows SQLite thinks
      // `categories` and `category_mapping` have
      const query = `EXPLAIN QUERY PLAN
        SELECT t.id FROM transactions t
        LEFT JOIN category_mapping cm ON cm.id = t.category
        LEFT JOIN categories c ON c.id = cm.transferId
        LEFT JOIN accounts a ON a.id = t.acct
        WHERE a.offbudget = 0 AND c.id IS NULL`;
      const planOf = (database: Database) =>
        sqlite
          .runQuery<{ detail: string }>(database, query, [], true)
          .map(row => row.detail);

      await migrate(db.getDatabase());
      await unapplyDropStats();
      // The stats old budgets carry, loaded into this connection
      db.execQuery(`
        ANALYZE;
        DELETE FROM sqlite_stat1;
        INSERT INTO sqlite_stat1 VALUES
          ('categories', 'sqlite_autoindex_categories_1', '7 1'),
          ('category_mapping', 'sqlite_autoindex_category_mapping_1', '7 1');
        ANALYZE sqlite_master;
      `);
      const stalePlan = planOf(db.getDatabase());

      await migrate(db.getDatabase());

      // A connection that never loaded any stats, on the same schema
      const fresh = await sqlite.openDatabase(':memory:');
      const schema = await db.all<{ sql: string }>(
        `SELECT sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`,
      );
      sqlite.execQuery(fresh, schema.map(row => row.sql + ';').join('\n'));
      const freshPlan = planOf(fresh);
      sqlite.closeDatabase(fresh);

      expect(freshPlan).not.toEqual(stalePlan);
      expect(planOf(db.getDatabase())).toEqual(freshPlan);
    });

    test('runs on a budget without stat tables, and runs again cleanly', async () => {
      await migrate(db.getDatabase());
      await unapplyDropStats();
      expect(await statTables()).toEqual([]);

      await migrate(db.getDatabase());
      // Apply it a second time, as a renumbered or re-run migration would
      const name = (await getMigrationList(getMigrationsDir())).find(
        m => getMigrationId(m) === dropStatsId,
      );
      await unapplyDropStats();
      await applyMigration(db.getDatabase(), name, getMigrationsDir());

      expect(await statTables()).toEqual([]);
      expect(
        (await getAppliedMigrations(db.getDatabase())).filter(
          id => id === dropStatsId,
        ),
      ).toEqual([dropStatsId]);
    });
  });
});
