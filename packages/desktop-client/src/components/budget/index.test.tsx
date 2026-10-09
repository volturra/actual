import React from 'react';
import { MemoryRouter } from 'react-router';

import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpreadsheetProvider } from '#hooks/useSpreadsheet';
import { resetTestProviders, TestProviders } from '#mocks';

import { Budget } from './index';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

// The real table needs a sized container and the whole spreadsheet; this
// stand-in records every `onBudgetAction` it is rendered with instead.
const tableRenders = vi.hoisted(
  () => [] as Array<(month: string, type: string, args: unknown) => void>,
);
vi.mock('./DynamicBudgetTable', () => ({
  AutoSizingBudgetTable: ({
    onBudgetAction,
  }: {
    onBudgetAction: (month: string, type: string, args: unknown) => void;
  }) => {
    tableRenders.push(onBudgetAction);
    return <div data-testid="budget-table" />;
  },
}));

vi.mock('./util', () => ({
  prewarmAllMonths: () => Promise.resolve(),
  prewarmMonth: () => Promise.resolve(),
}));

function renderBudget() {
  return render(
    <TestProviders>
      <MemoryRouter>
        <SpreadsheetProvider>
          <Budget />
        </SpreadsheetProvider>
      </MemoryRouter>
    </TestProviders>,
  );
}

describe('Budget', () => {
  beforeEach(() => {
    tableRenders.length = 0;
    resetTestProviders();
  });

  afterEach(async () => {
    await clearServer();
  });

  // Every budget row and month cell receives `onBudgetAction`. If it changed
  // identity while a save is pending or once it succeeds, saving a single
  // budget amount would re-render the whole budget table.
  it('keeps `onBudgetAction` stable while a budget amount is saved', async () => {
    let resolveSave: (() => void) | undefined;
    const saveBudgetAmount = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveSave = resolve;
        }),
    );
    initServer({
      'get-budget-bounds': async () => ({ start: '2024-01', end: '2024-12' }),
      'get-categories': async () => ({ grouped: [], list: [] }),
      'budget/budget-amount': saveBudgetAmount,
    });

    renderBudget();
    await screen.findByTestId('budget-table');

    const onBudgetAction = tableRenders[tableRenders.length - 1];
    const rendersBeforeSave = tableRenders.length;

    act(() => {
      onBudgetAction('2024-01', 'budget-amount', {
        category: 'cat-1',
        amount: 1000,
      });
    });
    await waitFor(() => expect(saveBudgetAmount).toHaveBeenCalled());

    // Let the mutation settle and every resulting render flush.
    await act(async () => {
      resolveSave?.();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(new Set(tableRenders.slice(rendersBeforeSave - 1))).toEqual(
      new Set([onBudgetAction]),
    );
  });
});
