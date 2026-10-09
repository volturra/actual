import React from 'react';
import type { ComponentProps } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import { generateCategoryGroups } from '@actual-app/core/mocks';
import type { CategoryGroupEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';

import type * as Sort from '#components/sort';
import { TestProviders } from '#mocks';

import { BudgetCategories } from './BudgetCategories';
import { MonthsContext } from './MonthsContext';

const rowRuns = vi.hoisted(() => new Map<string, number>());

// Every category row and expense group row calls `useDraggable` with its
// item, so this counts how often each row component actually runs.
vi.mock('#components/sort', async importOriginal => {
  const actual = await importOriginal<typeof Sort>();
  return {
    ...actual,
    useDraggable: (args: Parameters<typeof actual.useDraggable>[0]) => {
      const { id } = args.item as { id: string };
      rowRuns.set(id, (rowRuns.get(id) ?? 0) + 1);
      return actual.useDraggable(args);
    },
  };
});

// Keep the notes queries and menus of the real sidebars out of the test.
vi.mock('./SidebarCategory', () => ({
  SidebarCategory: ({ category }: { category: { name: string } }) => (
    <div>{category.name}</div>
  ),
}));

vi.mock('./SidebarGroup', () => ({
  SidebarGroup: ({ group }: { group: { name: string } }) => (
    <div>{group.name}</div>
  ),
}));

vi.mock('./IncomeHeader', () => ({ IncomeHeader: () => null }));

const noop = vi.fn();

function renderCategories(categoryGroups: CategoryGroupEntity[]) {
  const props: ComponentProps<typeof BudgetCategories> = {
    categoryGroups,
    editingCell: null,
    onBudgetAction: noop,
    onShowActivity: noop,
    onEditName: noop,
    onEditMonth: noop,
    onSaveCategory: noop,
    onSaveGroup: noop,
    onDeleteCategory: noop,
    onDeleteGroup: noop,
    onApplyBudgetTemplatesInGroup: noop,
    onReorderCategory: noop,
    onReorderGroup: noop,
  };

  const ui = (groups: CategoryGroupEntity[]) => (
    <TestProviders>
      <DndProvider backend={HTML5Backend}>
        {/* No months, so the rows render no budget cells. */}
        <MonthsContext.Provider value={{ months: [], type: 'envelope' }}>
          <BudgetCategories {...props} categoryGroups={groups} />
        </MonthsContext.Provider>
      </DndProvider>
    </TestProviders>
  );

  const result = render(ui(categoryGroups));
  return {
    rerender: (groups: CategoryGroupEntity[]) => result.rerender(ui(groups)),
  };
}

describe('BudgetCategories', () => {
  beforeEach(() => {
    rowRuns.clear();
  });

  it('only re-renders the rows whose data changed', () => {
    const [bills, food, income] = generateCategoryGroups([
      { name: 'Bills', categories: [{ name: 'Rent' }, { name: 'Power' }] },
      { name: 'Food', categories: [{ name: 'Groceries' }] },
      {
        name: 'Income',
        is_income: true,
        categories: [{ name: 'Salary', is_income: true }],
      },
    ]);
    const { rerender } = renderCategories([bills, food, income]);

    // Income groups have no drag handle, so they are not counted.
    const draggableIds = [
      bills.id,
      ...(bills.categories ?? []).map(cat => cat.id),
      food.id,
      ...(food.categories ?? []).map(cat => cat.id),
      ...(income.categories ?? []).map(cat => cat.id),
    ];
    expect([...rowRuns.keys()].sort()).toEqual([...draggableIds].sort());
    rowRuns.clear();

    // A sync or rename replaces one category (and its group) with new
    // objects and keeps every other object as it was.
    const [rent, power] = bills.categories ?? [];
    const renamedBills = {
      ...bills,
      categories: [{ ...rent, name: 'Mortgage' }, power],
    };
    rerender([renamedBills, food, income]);

    expect(screen.getByText('Mortgage')).toBeInTheDocument();
    // The changed group re-renders, and so do its categories, which receive
    // the group as a prop. Food and Income keep their objects and skip.
    expect(Object.fromEntries(rowRuns)).toEqual({
      [bills.id]: 1,
      [rent.id]: 1,
      [power.id]: 1,
    });
  });
});
