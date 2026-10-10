import React from 'react';
import { MemoryRouter } from 'react-router';

import { generateCategory } from '@actual-app/core/mocks';
import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import * as monthUtils from '@actual-app/core/shared/months';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SheetNameProvider } from '#hooks/useSheetName';
import { SpreadsheetProvider } from '#hooks/useSpreadsheet';
import { createTestQueryClient, TestProviders } from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';
import { configureAppStore } from '#redux/store';

import { ExpenseCategoryMonth } from './EnvelopeBudgetComponents';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

// No schedules: keeps the schedules query out of the test.
vi.mock('#hooks/useCategoryScheduleGoalTemplateIndicator', () => ({
  useCategoryScheduleGoalTemplateIndicator: () => ({
    schedule: null,
    scheduleStatus: null,
    isScheduleRecurring: false,
    description: '',
  }),
}));

const month = '2024-01';
const sheetName = monthUtils.sheetForMonth(month);
const category = generateCategory('Groceries', 'group-id');

function setUp({
  notes = {},
  cells = {},
}: {
  notes?: Record<string, string>;
  cells?: Record<string, number | null>;
}) {
  initServer({
    query: async () => ({
      data: Object.entries(notes).map(([id, note]) => ({ id, note })),
      dependencies: [],
    }),
    'get-cell': async (args: unknown) => {
      const name =
        args &&
        typeof args === 'object' &&
        'name' in args &&
        typeof args.name === 'string'
          ? args.name
          : '';
      return { name: `${sheetName}!${name}`, value: cells[name] ?? 0 };
    },
  });

  const queryClient = createTestQueryClient();
  const store = configureAppStore({ queryClient });
  store.dispatch(mergeSyncedPrefs({ 'flags.goalTemplatesEnabled': 'true' }));

  return render(
    <TestProviders store={store} queryClient={queryClient}>
      <MemoryRouter>
        <SpreadsheetProvider>
          <SheetNameProvider name={sheetName}>
            <div data-testid="cell">
              <ExpenseCategoryMonth
                month={month}
                category={category}
                editing={false}
                onEdit={vi.fn()}
                onBudgetAction={vi.fn()}
                onShowActivity={vi.fn()}
              />
            </div>
          </SheetNameProvider>
        </SpreadsheetProvider>
      </MemoryRouter>
    </TestProviders>,
  );
}

// The cell's own root element, which shows the hover-only buttons on hover
function cellRoot() {
  const root = screen.getByTestId('cell').firstElementChild;
  if (!(root instanceof HTMLElement)) {
    throw new Error('No budget cell rendered');
  }
  return root;
}

async function flush() {
  // Let the notes query and the cell requests resolve
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('ExpenseCategoryMonth', () => {
  afterEach(async () => {
    await clearServer();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('mounts the hover-only buttons the first time the cell is hovered', async () => {
    setUp({});
    await flush();

    // Only the balance button is mounted up front
    expect(
      screen.queryByRole('button', { name: 'View notes' }),
    ).not.toBeInTheDocument();
    expect(within(cellRoot()).getAllByRole('button')).toHaveLength(1);

    fireEvent.mouseEnter(cellRoot());
    await flush();

    expect(
      screen.getByRole('button', { name: 'View notes' }),
    ).toBeInTheDocument();
    // notes, budget menu and balance
    expect(within(cellRoot()).getAllByRole('button')).toHaveLength(3);

    // They stay mounted (hidden by CSS) once the pointer leaves
    fireEvent.mouseLeave(cellRoot());
    await flush();
    expect(within(cellRoot()).getAllByRole('button')).toHaveLength(3);
  });

  it('always shows the notes button of a cell with a note', async () => {
    setUp({ notes: { [`${category.id}-${month}`]: 'Birthday party' } });

    expect(
      await screen.findByRole('button', { name: 'View notes' }),
    ).toBeInTheDocument();
  });

  it('opens the budget and balance menus', async () => {
    setUp({});
    await flush();
    fireEvent.mouseEnter(cellRoot());
    await flush();

    const [, budgetMenuButton, balanceButton] =
      within(cellRoot()).getAllByRole('button');

    expect(
      screen.queryByText("Copy last month's budget"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Rollover overspending')).not.toBeInTheDocument();
    fireEvent.click(budgetMenuButton);
    expect(
      await screen.findByText("Copy last month's budget"),
    ).toBeInTheDocument();

    fireEvent.click(balanceButton);
    expect(
      await screen.findByText('Rollover overspending'),
    ).toBeInTheDocument();
  });

  it('shows the goal status tooltip when hovering the balance', async () => {
    setUp({
      cells: {
        [`leftover-${category.id}`]: 2000,
        [`goal-${category.id}`]: 5000,
        [`budget-${category.id}`]: 3000,
      },
    });
    await flush();

    const balance = screen.getByTestId(`${sheetName}!leftover-${category.id}`);
    expect(balance).toHaveTextContent('20.00');
    expect(screen.queryByText(/Underfunded/)).not.toBeInTheDocument();

    fireEvent.mouseEnter(balance.closest('div') ?? balance);
    await waitFor(
      () => expect(screen.getByText(/Underfunded/)).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(screen.getByText(/Underfunded/)).toHaveTextContent(
      'Underfunded (-20.00)',
    );
  });
});
