import React from 'react';
import type { ComponentProps } from 'react';
import { MemoryRouter } from 'react-router';

import { generateCategoryGroups } from '@actual-app/core/mocks';
import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetNameProvider } from '#hooks/useSheetName';
import { SpreadsheetProvider } from '#hooks/useSpreadsheet';
import { createTestQueryClient, TestProviders } from '#mocks';
import { configureAppStore } from '#redux/store';
import type { AppStore } from '#redux/store';

import { BudgetTable } from './BudgetTable';
import type * as ExpenseCategoryListItemModule from './ExpenseCategoryListItem';
import type * as ExpenseGroupListItemModule from './ExpenseGroupListItem';
import type * as IncomeCategoryListItemModule from './IncomeCategoryListItem';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

const itemRenders = vi.hoisted(() => ({ count: 0 }));

// The category lists are react-aria collections: when they are rebuilt, every
// item component runs again (and with it every row's buttons). This counts how
// often the item components of the expense groups, expense categories and
// income categories run.
vi.mock('./ExpenseGroupListItem', async importOriginal => {
  const actual = await importOriginal<typeof ExpenseGroupListItemModule>();
  return {
    ...actual,
    ExpenseGroupListItem: (
      props: ComponentProps<typeof actual.ExpenseGroupListItem>,
    ) => {
      itemRenders.count++;
      return <actual.ExpenseGroupListItem {...props} />;
    },
  };
});

vi.mock('./ExpenseCategoryListItem', async importOriginal => {
  const actual = await importOriginal<typeof ExpenseCategoryListItemModule>();
  return {
    ...actual,
    ExpenseCategoryListItem: (
      props: ComponentProps<typeof actual.ExpenseCategoryListItem>,
    ) => {
      itemRenders.count++;
      return <actual.ExpenseCategoryListItem {...props} />;
    },
  };
});

vi.mock('./IncomeCategoryListItem', async importOriginal => {
  const actual = await importOriginal<typeof IncomeCategoryListItemModule>();
  return {
    ...actual,
    IncomeCategoryListItem: (
      props: ComponentProps<typeof actual.IncomeCategoryListItem>,
    ) => {
      itemRenders.count++;
      return <actual.IncomeCategoryListItem {...props} />;
    },
  };
});

const january = '2024-01';
const february = '2024-02';

// Every cell of a month shows that month's amount, so a row showing another
// month's amount is easy to spot.
const amountByMonth: Record<string, number> = {
  [january]: 1111,
  [february]: 2222,
};

const [expenseGroup, incomeGroup] = generateCategoryGroups([
  { name: 'Food', categories: [{ name: 'Groceries' }] },
  {
    name: 'Income',
    is_income: true,
    categories: [{ name: 'Salary', is_income: true }],
  },
]);
const groceries = expenseGroup.categories![0];
const salary = incomeGroup.categories![0];

function getAmount(sheetName: string) {
  const month = Object.keys(amountByMonth).find(
    m => monthUtils.sheetForMonth(m) === sheetName,
  );
  return month ? amountByMonth[month] : 0;
}

function setUp() {
  initServer({
    query: async () => ({ data: [], dependencies: [] }),
    'get-cell': async (args: unknown) => {
      const { sheetName, name } = args as { sheetName: string; name: string };
      return { name: `${sheetName}!${name}`, value: getAmount(sheetName) };
    },
  });

  const queryClient = createTestQueryClient();
  const store = configureAppStore({ queryClient });
  const props = {
    onShowBudgetSummary: vi.fn(),
    onBudgetAction: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onEditCategoryGroup: vi.fn(),
    onEditCategory: vi.fn(),
  };

  const ui = (month: string) => (
    <TestProviders store={store} queryClient={queryClient}>
      <MemoryRouter>
        <SpreadsheetProvider>
          <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
            <BudgetTable
              categoryGroups={[expenseGroup, incomeGroup]}
              month={month}
              {...props}
            />
          </SheetNameProvider>
        </SpreadsheetProvider>
      </MemoryRouter>
    </TestProviders>
  );

  const result = render(ui(january));
  return {
    store,
    props,
    changeMonth: (month: string) => result.rerender(ui(month)),
  };
}

async function flush() {
  // Let the cell requests resolve
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function categoryRow(name: string) {
  const row = screen
    .getAllByTestId('category-row')
    .find(r => within(r).queryByText(name));
  if (!row) {
    throw new Error(`No row for category ${name}`);
  }
  return row;
}

function lastModal(store: AppStore) {
  const { modalStack } = store.getState().modals;
  return modalStack[modalStack.length - 1];
}

describe('mobile BudgetTable', () => {
  beforeEach(() => {
    itemRenders.count = 0;
  });

  afterEach(async () => {
    await clearServer();
  });

  it("shows the new month's amounts in every row after the month changes", async () => {
    const { changeMonth } = setUp();
    await flush();

    for (const name of [groceries.name, salary.name]) {
      expect(within(categoryRow(name)).getAllByText('11.11')).not.toHaveLength(
        0,
      );
    }

    changeMonth(february);
    await flush();

    for (const name of [groceries.name, salary.name]) {
      const row = categoryRow(name);
      expect(within(row).getAllByText('22.22')).not.toHaveLength(0);
      expect(within(row).queryByText('11.11')).not.toBeInTheDocument();
    }
  });

  it('does not rebuild the category lists when the month changes', async () => {
    const { changeMonth } = setUp();
    await flush();
    expect(itemRenders.count).toBeGreaterThan(0);

    itemRenders.count = 0;
    changeMonth(february);
    await flush();

    expect(itemRenders.count).toBe(0);
  });

  it('opens the category and group menus for the month on screen', async () => {
    const user = userEvent.setup();
    const { props, changeMonth } = setUp();
    await flush();

    changeMonth(february);
    await flush();

    await user.click(
      within(categoryRow(groceries.name)).getByText(groceries.name),
    );
    expect(props.onEditCategory).toHaveBeenLastCalledWith(
      groceries.id,
      february,
    );

    await user.click(within(categoryRow(salary.name)).getByText(salary.name));
    expect(props.onEditCategory).toHaveBeenLastCalledWith(salary.id, february);

    const groupNames = screen.getAllByTestId('category-group-name');
    for (const group of [expenseGroup, incomeGroup]) {
      const groupName = groupNames.find(n => n.textContent === group.name);
      await user.click(groupName!);
      expect(props.onEditCategoryGroup).toHaveBeenLastCalledWith(
        group.id,
        february,
      );
    }
  });

  it('runs the budget and balance actions of a row on the month on screen', async () => {
    const user = userEvent.setup();
    const { store, props, changeMonth } = setUp();
    await flush();

    changeMonth(february);
    await flush();

    await user.click(
      screen.getByRole('button', {
        name: `Open budget menu for ${groceries.name} category`,
      }),
    );
    expect(lastModal(store)).toMatchObject({
      name: 'envelope-budget-menu',
      options: { categoryId: groceries.id, month: february },
    });

    await user.click(
      screen.getByRole('button', {
        name: `Open balance menu for ${groceries.name} category`,
      }),
    );
    const balanceMenu = lastModal(store);
    expect(balanceMenu).toMatchObject({
      name: 'envelope-balance-menu',
      options: { categoryId: groceries.id, month: february },
    });
    if (balanceMenu.name !== 'envelope-balance-menu') {
      throw new Error('Expected the envelope balance menu');
    }
    const { onCarryover, onTransfer, onCover } = balanceMenu.options;
    if (!onCarryover || !onTransfer || !onCover) {
      throw new Error('Expected the carryover, transfer and cover actions');
    }

    onCarryover(true);
    expect(props.onBudgetAction).toHaveBeenLastCalledWith(
      february,
      'carryover',
      { category: groceries.id, flag: true },
    );

    act(() => onTransfer());
    expect(lastModal(store)).toMatchObject({
      name: 'transfer',
      options: { categoryId: groceries.id, month: february },
    });

    act(() => onCover());
    expect(lastModal(store)).toMatchObject({
      name: 'cover',
      options: { categoryId: groceries.id, month: february },
    });

    await user.click(
      screen.getByRole('button', {
        name: `Open balance menu for ${salary.name} category`,
      }),
    );
    const incomeMenu = lastModal(store);
    expect(incomeMenu).toMatchObject({
      name: 'envelope-income-balance-menu',
      options: { categoryId: salary.id, month: february },
    });
    if (incomeMenu.name !== 'envelope-income-balance-menu') {
      throw new Error('Expected the income balance menu');
    }
    const onIncomeCarryover = incomeMenu.options.onCarryover;
    if (!onIncomeCarryover) {
      throw new Error('Expected the carryover action');
    }

    onIncomeCarryover(false);
    expect(props.onBudgetAction).toHaveBeenLastCalledWith(
      february,
      'carryover',
      { category: salary.id, flag: false },
    );
  });
});
