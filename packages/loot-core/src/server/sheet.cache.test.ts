import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as sqlite from '#platform/server/sqlite';

import * as db from './db';
import * as sheet from './sheet';

let cachePath: string;

beforeEach(async () => {
  // The cache is off in tests by default
  vi.stubEnv('NODE_ENV', 'development');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await global.emptyDatabase()();
  // Like the desktop app: the cache is in its own database next to the
  // budget's
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'actual-cache-'));
  cachePath = path.join(dir, 'cache.sqlite');
  vi.spyOn(db, 'getDatabasePath').mockReturnValue(path.join(dir, 'db.sqlite'));
  await db.insertCategoryGroup({ id: 'group1', name: 'group1' });
  await db.insertCategory({ id: 'cat1', name: 'cat1', cat_group: 'group1' });
  setBudgetRow(100);
});

afterEach(() => {
  // Before the cache's database goes away
  sheet.unloadSpreadsheet();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  nodeFs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
});

const budgetCell = 'budget202401!budget-cat1';
const doubledCell = 'budget202401!doubled';

function setBudgetRow(amount: number) {
  db.runQuery(
    'INSERT OR REPLACE INTO zero_budgets (id, month, category, amount) VALUES (?, ?, ?, ?)',
    ['202401-cat1', 202401, 'cat1', amount],
  );
}

// Read what's stored, through a connection of its own
async function readCache<T>(
  read: (cacheDb: Awaited<ReturnType<typeof sqlite.openDatabase>>) => T,
): Promise<T> {
  const cacheDb = await sqlite.openDatabase(cachePath);
  try {
    return read(cacheDb);
  } finally {
    sqlite.closeDatabase(cacheDb);
  }
}

function storedValue(name: string) {
  return readCache(cacheDb => {
    const rows = sqlite.runQuery<{ value: string }>(
      cacheDb,
      'SELECT value FROM kvcache WHERE key = ?',
      [name],
      true,
    );
    return rows.length > 0 ? JSON.parse(rows[0].value) : undefined;
  });
}

// What loading checks: the same marker in both databases
async function isMarkedClean() {
  const cacheKey = await readCache(
    cacheDb =>
      sqlite.runQuery<{ key: number }>(
        cacheDb,
        'SELECT key FROM kvcache_key WHERE id = 1',
        [],
        true,
      )[0]?.key,
  );
  const mainKey = db.runQuery<{ key: number }>(
    'SELECT key FROM kvcache_key WHERE id = 1',
    [],
    true,
  )[0]?.key;
  return cacheKey != null && cacheKey === mainKey;
}

async function loadSheet() {
  const spreadsheet = await sheet.loadSpreadsheet(db);
  spreadsheet.createDynamic('budget202401', 'doubled', {
    initialValue: 0,
    dependencies: ['budget-cat1'],
    run: (amount: number) => amount * 2,
  });
  await sheet.waitOnSpreadsheet();
  return spreadsheet;
}

// What syncing a change does: mark the cache dirty, change the data, then
// update the sheet
async function changeBudget(
  spreadsheet: Awaited<ReturnType<typeof loadSheet>>,
  amount: number,
) {
  spreadsheet.startCacheBarrier();
  setBudgetRow(amount);
  spreadsheet.set(budgetCell, amount);
  spreadsheet.endCacheBarrier();
  await sheet.waitOnSpreadsheet();
}

describe('Spreadsheet cache', () => {
  test('a fresh load saves the cache right away', async () => {
    await loadSheet();
    expect(await isMarkedClean()).toBe(true);
    expect(await storedValue(budgetCell)).toBe(100);
    expect(await storedValue(doubledCell)).toBe(200);
  });

  test('saves cells computed while marked dirty once idle', async () => {
    const spreadsheet = await loadSheet();

    await changeBudget(spreadsheet, 300);
    expect(spreadsheet.getValue(doubledCell)).toBe(600);
    // Not saved yet, but marked dirty so it isn't trusted meanwhile
    expect(await isMarkedClean()).toBe(false);
    expect(await storedValue(doubledCell)).toBe(200);

    vi.advanceTimersByTime(999);
    expect(await isMarkedClean()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await isMarkedClean()).toBe(true);
    expect(await storedValue(budgetCell)).toBe(300);
    expect(await storedValue(doubledCell)).toBe(600);
  });

  test('waits until nothing is computing or changing', async () => {
    const spreadsheet = await loadSheet();
    await changeBudget(spreadsheet, 300);

    spreadsheet.startCacheBarrier();
    vi.advanceTimersByTime(5000);
    expect(await isMarkedClean()).toBe(false);
    setBudgetRow(400);
    spreadsheet.set(budgetCell, 400);
    spreadsheet.endCacheBarrier();
    await sheet.waitOnSpreadsheet();
    expect(await isMarkedClean()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(await isMarkedClean()).toBe(true);
    expect(await storedValue(doubledCell)).toBe(800);
  });

  test("doesn't mark the cache dirty again while it is", async () => {
    const spreadsheet = await loadSheet();
    const setCacheStatus = vi.fn(
      spreadsheet.setCacheStatus as (status: { clean: boolean }) => void,
    );
    spreadsheet.setCacheStatus = setCacheStatus;

    await changeBudget(spreadsheet, 300);
    await changeBudget(spreadsheet, 400);
    expect(setCacheStatus.mock.calls).toEqual([[{ clean: false }]]);

    vi.advanceTimersByTime(1000);
    // Marked clean together with the cells, not through `setCacheStatus`
    expect(await isMarkedClean()).toBe(true);

    await changeBudget(spreadsheet, 500);
    expect(setCacheStatus.mock.calls).toEqual([
      [{ clean: false }],
      [{ clean: false }],
    ]);
  });

  test('saves the cache when the budget closes', async () => {
    const spreadsheet = await loadSheet();
    await changeBudget(spreadsheet, 300);
    expect(await isMarkedClean()).toBe(false);

    sheet.unloadSpreadsheet();
    expect(await isMarkedClean()).toBe(true);
    expect(await storedValue(doubledCell)).toBe(600);
    expect(vi.getTimerCount()).toBe(0);

    // The next load uses the cache
    const reloaded = await sheet.loadSpreadsheet(db);
    expect(reloaded.getValue(doubledCell)).toBe(600);
  });

  test("doesn't save on close while data is changing", async () => {
    const spreadsheet = await loadSheet();
    await changeBudget(spreadsheet, 300);

    spreadsheet.startCacheBarrier();
    sheet.unloadSpreadsheet();
    expect(await isMarkedClean()).toBe(false);
  });

  test('recomputes everything when closed without saving', async () => {
    const spreadsheet = await loadSheet();
    await changeBudget(spreadsheet, 300);

    // The worker is killed before the cache was saved
    vi.clearAllTimers();
    spreadsheet.unloaded = true;

    const reloaded = await loadSheet();
    expect(reloaded).not.toBe(spreadsheet);
    expect(reloaded.getValue(budgetCell)).toBe(300);
    expect(reloaded.getValue(doubledCell)).toBe(600);
    // And the fresh values are saved
    expect(await isMarkedClean()).toBe(true);
    expect(await storedValue(doubledCell)).toBe(600);
  });

  test('stays dirty when told to, even with cells waiting to be saved', async () => {
    const spreadsheet = await loadSheet();
    await changeBudget(spreadsheet, 300);

    // E.g. an import changed data without going through the sheet
    spreadsheet.markCacheDirty();
    expect(await storedValue(doubledCell)).toBe(600);
    sheet.unloadSpreadsheet();
    expect(await isMarkedClean()).toBe(false);
  });
});
