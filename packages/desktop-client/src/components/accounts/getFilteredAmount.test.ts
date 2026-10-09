import * as connection from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { getFilteredAmount } from './getFilteredAmount';

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
});
