import { initServer } from '@actual-app/core/platform/client/connection';
import { describe, expect, it, vi } from 'vitest';

import { prewarmAllMonths } from './util';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

describe('prewarmAllMonths', () => {
  it('loads the bounds and the months around the start month in one request', async () => {
    const requests: string[] = [];
    const getInitialData = vi.fn(async (_args: unknown) => ({
      bounds: { start: '2024-01', end: '2024-12' },
      values: [{ name: 'budget202405!to-budget', value: 500 }],
    }));
    initServer({
      'budget/get-initial-data': args => {
        requests.push('budget/get-initial-data');
        return getInitialData(args);
      },
    });
    const prewarmCache = vi.fn();

    const bounds = await prewarmAllMonths(
      'tracking',
      { prewarmCache } as unknown as Parameters<typeof prewarmAllMonths>[1],
      '2024-05',
    );

    expect(requests).toEqual(['budget/get-initial-data']);
    expect(getInitialData).toHaveBeenCalledWith({
      budgetType: 'tracking',
      months: [
        '2024-04',
        '2024-05',
        '2024-06',
        '2024-07',
        '2024-08',
        '2024-09',
      ],
    });
    expect(bounds).toEqual({ start: '2024-01', end: '2024-12' });
    expect(prewarmCache).toHaveBeenCalledWith('budget202405!to-budget', {
      name: 'budget202405!to-budget',
      value: 500,
    });
  });
});
