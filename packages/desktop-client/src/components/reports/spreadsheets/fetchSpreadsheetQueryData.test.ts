import { aqlQuery } from '#queries/aqlQuery';

import { fetchSpreadsheetQueryData } from './fetchSpreadsheetQueryData';

vi.mock('#queries/aqlQuery');

type Args = Parameters<typeof fetchSpreadsheetQueryData>[0];

const args: Args = {
  balanceTypeOp: 'totalDebts',
  startDate: '2026-01',
  endDate: '2026-02',
  interval: 'Monthly',
  categories: [],
  categoryGroups: [],
  conditions: [],
  conditionsOp: 'and',
  conditionsOpKey: '$and',
  filters: [],
  budgetType: 'envelope',
};

// Each query waits until the test resolves it, so calls stay in flight.
let pendingQueries: Array<() => void> = [];

function resolvePendingQueries() {
  pendingQueries.forEach(resolve => resolve());
  pendingQueries = [];
}

beforeEach(() => {
  pendingQueries = [];
  vi.mocked(aqlQuery).mockReset();
  vi.mocked(aqlQuery).mockImplementation(
    () =>
      new Promise(resolve => {
        pendingQueries.push(() => resolve({ data: [], dependencies: [] }));
      }),
  );
});

describe('fetchSpreadsheetQueryData', () => {
  it('shares the queries of an in-flight call with the same arguments', async () => {
    // The graph passes the report's groupBy, the table passes none.
    const graph = fetchSpreadsheetQueryData({ ...args, groupBy: 'Category' });
    const table = fetchSpreadsheetQueryData(args);

    expect(table).toBe(graph);
    // One assets query and one debts query.
    expect(aqlQuery).toHaveBeenCalledTimes(2);

    resolvePendingQueries();
    expect(await graph).toBe(await table);
  });

  it('runs the queries again once the in-flight call settles', async () => {
    const first = fetchSpreadsheetQueryData(args);
    resolvePendingQueries();
    await first;

    const second = fetchSpreadsheetQueryData(args);
    expect(second).not.toBe(first);
    expect(aqlQuery).toHaveBeenCalledTimes(4);

    resolvePendingQueries();
    await second;
  });

  it('runs the queries again after an in-flight call fails', async () => {
    vi.mocked(aqlQuery).mockRejectedValueOnce(new Error('query failed'));
    const failed = fetchSpreadsheetQueryData(args);
    resolvePendingQueries();
    await expect(failed).rejects.toThrow('query failed');

    const retry = fetchSpreadsheetQueryData(args);
    expect(retry).not.toBe(failed);
    resolvePendingQueries();
    await expect(retry).resolves.toEqual({ assets: [], debts: [] });
  });

  it.each<Partial<Args>>([
    { groupBy: 'Tag' },
    { startDate: '2025-12' },
    { conditionsOpKey: '$or' },
    { filters: [{ amount: { $lt: 0 } }] },
  ])('does not share calls with different queries %j', async change => {
    const first = fetchSpreadsheetQueryData(args);
    const second = fetchSpreadsheetQueryData({ ...args, ...change });

    expect(second).not.toBe(first);
    expect(aqlQuery).toHaveBeenCalledTimes(4);
    resolvePendingQueries();
    await Promise.all([first, second]);
  });
});
