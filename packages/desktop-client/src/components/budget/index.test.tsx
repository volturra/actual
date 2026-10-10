import React from 'react';
import { MemoryRouter } from 'react-router';

import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpreadsheetProvider, useSpreadsheet } from '#hooks/useSpreadsheet';
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
const tableProps = vi.hoisted(() => ({
  startMonth: '',
  onMonthSelect: null as
    | null
    | ((month: string, numDisplayed: number) => Promise<void> | void),
}));
vi.mock('./DynamicBudgetTable', () => ({
  AutoSizingBudgetTable: ({
    onBudgetAction,
    startMonth,
    onMonthSelect,
  }: {
    onBudgetAction: (month: string, type: string, args: unknown) => void;
    startMonth: string;
    onMonthSelect: (month: string, numDisplayed: number) => void;
  }) => {
    tableRenders.push(onBudgetAction);
    tableProps.startMonth = startMonth;
    tableProps.onMonthSelect = onMonthSelect;
    return <div data-testid="budget-table" data-month={startMonth} />;
  },
}));

// Each `prewarmMonth` call waits until the test resolves it
const prewarms = vi.hoisted(() => [] as Array<() => void>);
const prewarmAllMonths = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('./util', () => ({
  prewarmAllMonths,
  prewarmMonth: () =>
    new Promise<void>(resolve => {
      prewarms.push(resolve);
    }),
}));

// What the budget file actions requested when the budget was loaded
const takeInitialBudgetData = vi.hoisted(() =>
  vi.fn((): Promise<unknown> => Promise.resolve(null)),
);
vi.mock('./initialBudgetData', () => ({ takeInitialBudgetData }));

let spreadsheet: ReturnType<typeof useSpreadsheet> | undefined;
function SpreadsheetProbe() {
  spreadsheet = useSpreadsheet();
  return null;
}

function renderBudget() {
  return render(
    <TestProviders>
      <MemoryRouter>
        <SpreadsheetProvider>
          <SpreadsheetProbe />
          <Budget />
        </SpreadsheetProvider>
      </MemoryRouter>
    </TestProviders>,
  );
}

describe('Budget', () => {
  beforeEach(() => {
    tableRenders.length = 0;
    prewarms.length = 0;
    prewarmAllMonths.mockClear();
    // An earlier test may have stored another start month
    localStorage.clear();
    takeInitialBudgetData.mockReset();
    takeInitialBudgetData.mockImplementation(() => Promise.resolve(null));
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

  // Clicking "next month" twice quickly starts two prewarms. When the first
  // one finishes last, it must not move the budget back to its month.
  it('stays on the latest selected month when prewarms finish out of order', async () => {
    initServer({
      'get-budget-bounds': async () => ({ start: '2024-01', end: '2024-12' }),
      'get-categories': async () => ({ grouped: [], list: [] }),
    });

    renderBudget();
    await screen.findByTestId('budget-table');
    const start = tableProps.startMonth;
    const next = monthUtils.addMonths(start, 1);
    const nextNext = monthUtils.addMonths(start, 2);

    act(() => {
      void tableProps.onMonthSelect?.(next, 1);
    });
    await waitFor(() => expect(tableProps.startMonth).toBe(next));
    act(() => {
      void tableProps.onMonthSelect?.(nextNext, 1);
    });
    await waitFor(() => expect(tableProps.startMonth).toBe(nextNext));
    expect(prewarms).toHaveLength(2);

    // The second prewarm finishes first, then the first one
    await act(async () => {
      prewarms[1]();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => {
      prewarms[0]();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(tableProps.startMonth).toBe(nextNext);
    expect(screen.getByTestId('budget-table')).toHaveAttribute(
      'data-month',
      nextNext,
    );
  });
  it('renders from the data requested when the budget loaded', async () => {
    const getBudgetBounds = vi.fn(async () => ({
      start: '2024-01',
      end: '2024-12',
    }));
    initServer({
      'get-budget-bounds': getBudgetBounds,
      'get-categories': async () => ({ grouped: [], list: [] }),
    });
    takeInitialBudgetData.mockImplementation(() =>
      Promise.resolve({
        bounds: { start: '2024-01', end: '2024-12' },
        monthValues: [[{ name: 'budget202401!to-budget', value: 500 }]],
      }),
    );

    renderBudget();
    await screen.findByTestId('budget-table');

    expect(takeInitialBudgetData).toHaveBeenCalledWith({
      budgetId: undefined,
      budgetType: 'envelope',
      startMonth: monthUtils.currentMonth(),
    });
    expect(prewarmAllMonths).not.toHaveBeenCalled();
    expect(spreadsheet?.getCachedValue('budget202401', 'to-budget')).toEqual({
      name: 'budget202401!to-budget',
      value: 500,
    });
    // Only the refresh that runs on every mount
    expect(getBudgetBounds).toHaveBeenCalledTimes(1);
  });

  it('requests the data itself when none was requested for it', async () => {
    const getBudgetBounds = vi.fn(async () => ({
      start: '2024-01',
      end: '2024-12',
    }));
    initServer({
      'get-budget-bounds': getBudgetBounds,
      'get-categories': async () => ({ grouped: [], list: [] }),
    });

    renderBudget();
    await screen.findByTestId('budget-table');

    expect(prewarmAllMonths).toHaveBeenCalledWith(
      'envelope',
      spreadsheet,
      { start: '2024-01', end: '2024-12' },
      monthUtils.currentMonth(),
    );
    expect(getBudgetBounds).toHaveBeenCalledTimes(2);
  });
});
