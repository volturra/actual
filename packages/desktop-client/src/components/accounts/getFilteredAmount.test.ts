import * as connection from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { pagedQuery } from '#queries/pagedQuery';

import { getFilteredAmount, trackAppendedPages } from './getFilteredAmount';

describe('getFilteredAmount', () => {
  let send: MockInstance<typeof connection.send>;

  beforeEach(() => {
    vi.restoreAllMocks();
    send = vi
      .spyOn(connection, 'send')
      .mockResolvedValue({ data: 1234, dependencies: [] });
  });

  it('does not query anything when no filter or search is active', async () => {
    const query = q('transactions').filter({ account: 'acct' });

    await expect(getFilteredAmount(query, false)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('sums the amounts of the filtered query', async () => {
    const query = q('transactions').filter({ account: 'acct', amount: 100 });

    await expect(getFilteredAmount(query, true)).resolves.toBe(1234);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'query',
      query.calculate({ $sum: '$amount' }).serialize(),
    );
  });

  it('returns null when filtered but no query exists yet', async () => {
    await expect(getFilteredAmount(undefined, true)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  describe('with the rows of a search', () => {
    const query = q('transactions').filter({ account: 'acct' });
    const transactions = [
      // A split: the parent and its unmatched child don't count
      { is_parent: true, amount: -300 },
      { amount: -100 },
      { amount: -200, _unmatched: true },
      // Transactions that aren't split
      { amount: 50 },
      { is_parent: false, amount: -7 },
    ];

    it('sums the matched rows when they hold every match', async () => {
      await expect(
        getFilteredAmount(query, true, {
          groupCount: 3,
          transactions,
          pageCount: 150,
        }),
      ).resolves.toBe(-57);
      expect(send).not.toHaveBeenCalled();
    });

    it('is 0 when nothing matched, like the query', async () => {
      await expect(
        getFilteredAmount(query, true, {
          groupCount: 0,
          transactions: [],
          pageCount: 150,
        }),
      ).resolves.toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it('runs the query when the rows fill the page', async () => {
      await expect(
        getFilteredAmount(query, true, {
          groupCount: 3,
          transactions,
          pageCount: 3,
        }),
      ).resolves.toBe(1234);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not sum anything without a filter or search', async () => {
      await expect(
        getFilteredAmount(query, false, {
          groupCount: 3,
          transactions,
          pageCount: 150,
        }),
      ).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });
  });
});

describe('trackAppendedPages', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Five rows, served a page at a time
    const rows = [1, 2, 3, 4, 5].map(id => ({ id: String(id) }));
    vi.spyOn(connection, 'send').mockImplementation(async (name, args) => {
      if (name !== 'query') {
        throw new Error(`Unexpected ${name}`);
      }
      const { limit, offset = 0 } = args as { limit: number; offset?: number };
      return {
        data: rows.slice(offset, offset + limit),
        dependencies: ['transactions'],
      };
    });
    // Sync events never fire here
    vi.spyOn(connection, 'listen').mockImplementation(() => vi.fn());
  });

  it('tells rows from one fetch from a page appended to them', async () => {
    const appendedPages = trackAppendedPages();
    const calls: Array<{ length: number; isOneFetch: boolean }> = [];
    const paged = pagedQuery(q('transactions').select('*'), {
      onPageData: appendedPages.onPageData,
      onData: data => {
        calls.push({
          length: data.length,
          isOneFetch: appendedPages.takeIsOneFetch(),
        });
      },
      options: { pageCount: 2 },
    });

    // The first load
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // A page appended by scrolling
    await paged.fetchNext();
    // A refresh fetches every loaded row again at once
    await paged.run();

    expect(calls).toEqual([
      { length: 2, isOneFetch: true },
      { length: 4, isOneFetch: false },
      { length: 4, isOneFetch: true },
    ]);
    paged.unsubscribe();
  });
});
