import React from 'react';
import type { ReactNode } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestProviders, TestProviders } from '#mocks';

import { useBudgetActions } from './mutations';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <TestProviders>{children}</TestProviders>;
}

describe('useBudgetActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTestProviders();
  });

  // The budget pages pass `mutate` (not the whole mutation result) down to
  // every row and month cell. If `mutate` changed identity whenever the
  // mutation status changes, saving a single budget amount would re-render
  // the whole budget table.
  it('keeps `mutate` stable while the mutation goes pending and succeeds', async () => {
    let resolveSend: ((value: null) => void) | undefined;
    vi.mocked(send).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSend = resolve;
        }) as ReturnType<typeof send>,
    );

    const { result } = renderHook(() => useBudgetActions(), { wrapper });
    const idleResult = result.current;
    const { mutate } = idleResult;

    act(() => {
      mutate({
        month: '2024-01',
        type: 'budget-amount',
        args: { category: 'cat-1', amount: 1000 },
      });
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(send).toHaveBeenCalledWith('budget/budget-amount', {
      month: '2024-01',
      category: 'cat-1',
      amount: 1000,
    });
    // The result object itself changes on every status change...
    expect(result.current).not.toBe(idleResult);
    // ...but `mutate` does not.
    expect(result.current.mutate).toBe(mutate);

    act(() => resolveSend?.(null));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.mutate).toBe(mutate);
  });
});
