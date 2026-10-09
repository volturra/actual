import React from 'react';
import type { ComponentProps } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';

import { generateCategoryGroups } from '@actual-app/core/mocks';
import type { CategoryGroupEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';

import { TestProviders } from '#mocks';

import { BudgetCategories } from './BudgetCategories';
import { MonthsContext } from './MonthsContext';

const sidebarRenders = vi.hoisted(() => new Map<string, number>());

function countRender(id: string) {
  sidebarRenders.set(id, (sidebarRenders.get(id) ?? 0) + 1);
}

// The sidebars render once per row render, so they count row renders without
// pulling in the notes queries and menus of the real components.
vi.mock('./SidebarCategory', () => ({
  SidebarCategory: ({
    category,
  }: {
    category: { id: string; name: string };
  }) => {
    countRender(category.id);
    return <div>{category.name}</div>;
  },
}));

vi.mock('./SidebarGroup', () => ({
  SidebarGroup: ({ group }: { group: { id: string; name: string } }) => {
    countRender(group.id);
    return <div>{group.name}</div>;
  },
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
    sidebarRenders.clear();
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

    const allIds = [bills, food, income].flatMap(group => [
      group.id,
      ...(group.categories ?? []).map(cat => cat.id),
    ]);
    expect([...sidebarRenders.keys()].sort()).toEqual([...allIds].sort());
    sidebarRenders.clear();

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
    expect([...sidebarRenders.keys()].sort()).toEqual(
      [bills.id, rent.id, power.id].sort(),
    );
  });
});
