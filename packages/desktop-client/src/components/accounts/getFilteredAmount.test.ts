import * as connection from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getFilteredAmount } from './getFilteredAmount';

describe('getFilteredAmount', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    send = vi.fn(async () => ({ data: 1234, dependencies: [] }));
    vi.spyOn(connection, 'send').mockImplementation(
      send as unknown as typeof connection.send,
    );
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

  it('returns 0 when filtered but no query exists yet', async () => {
    await expect(getFilteredAmount(undefined, true)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
