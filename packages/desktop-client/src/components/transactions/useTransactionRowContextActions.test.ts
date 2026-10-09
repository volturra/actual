import { createRef } from 'react';

import type {
  ScheduleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMenuItem } from '#contextmenu/types';
import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useContextMenu } from '#hooks/useContextMenu';
import { useSelectedItems } from '#hooks/useSelected';

import { useTransactionRowContextActions } from './useTransactionRowContextActions';

vi.mock('#redux', () => ({
  useDispatch: () => vi.fn(),
}));

vi.mock('#hooks/useContextMenu', () => ({
  useContextMenu: vi.fn(),
}));

vi.mock('#hooks/useSelected', () => ({
  useSelectedItems: vi.fn(),
}));

vi.mock('#hooks/useCachedSchedules', () => ({
  useCachedSchedules: vi.fn(),
}));

function makeTransaction(
  id: string,
  fields: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id,
    account: 'acct',
    amount: -1000,
    date: '2024-01-01',
    ...fields,
  } satisfies TransactionEntity;
}

const transactions = [
  makeTransaction('plain-1'),
  makeTransaction('plain-2'),
  makeTransaction('linked-1', { schedule: 'sched-1' }),
  makeTransaction('linked-2', { schedule: 'sched-2' }),
  makeTransaction('parent', { is_parent: true }),
  makeTransaction('child-1', { is_child: true, parent_id: 'parent' }),
  makeTransaction('child-2', { is_child: true, parent_id: 'parent' }),
  makeTransaction('reconciled-parent', { is_parent: true, reconciled: true }),
];
const transactionsById = new Map(transactions.map(t => [t.id, t]));

const recurringSchedule = {
  id: 'recurring',
  _conditions: [
    {
      op: 'isapprox',
      field: 'date',
      value: {
        start: '2024-01-01',
        frequency: 'monthly',
        interval: 1,
        patterns: [],
        skipWeekend: false,
        weekendSolveMode: 'after',
        endMode: 'never',
      },
    },
  ],
} as unknown as ScheduleEntity;

const oneOffSchedule = {
  id: 'one-off',
  _conditions: [{ op: 'is', field: 'date', value: '2024-01-01' }],
} as unknown as ScheduleEntity;

function renderRow({
  id,
  selected = [],
  selection = new Set(selected),
  schedules = [],
}: {
  id: string;
  selected?: string[];
  selection?: Set<string>;
  schedules?: ScheduleEntity[];
}) {
  vi.mocked(useSelectedItems).mockReturnValue(selection);
  vi.mocked(useCachedSchedules).mockReturnValue({
    schedules,
    statuses: new Map(),
    statusLabels: new Map(),
    isLoading: false,
  });

  const getTransaction = vi.fn((txId: string) => transactionsById.get(txId));
  const handlers = {
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onLinkSchedule: vi.fn(),
    onUnlinkSchedule: vi.fn(),
    onCreateRule: vi.fn(),
    onScheduleAction: vi.fn(),
    onMakeAsNonSplitTransactions: vi.fn(),
  };
  const transaction = transactionsById.get(id) ?? makeTransaction(id);

  const hook = renderHook(() =>
    useTransactionRowContextActions({
      rowRef: createRef<HTMLElement>(),
      transaction,
      getTransaction,
      ...handlers,
    }),
  );

  // Open the menu: call the items the hook passed in its latest render.
  function openMenu(): ContextMenuItem[] {
    const lastCall = vi.mocked(useContextMenu).mock.lastCall;
    if (!lastCall) {
      throw new Error('useContextMenu was not called');
    }
    const { items } = lastCall[0];
    const all = typeof items === 'function' ? items() : items;
    return all.filter(
      (item): item is ContextMenuItem =>
        !!item && (typeof item === 'symbol' || !item.hidden),
    );
  }

  function visibleNames() {
    return openMenu().map(item =>
      typeof item === 'symbol' ? item : item.name,
    );
  }

  function click(name: string) {
    const item = openMenu().find(
      item => typeof item !== 'symbol' && item.name === name,
    );
    if (!item || typeof item === 'symbol') {
      throw new Error(`No visible item named ${name}`);
    }
    item.onClick?.();
  }

  return { ...hook, getTransaction, handlers, visibleNames, click };
}

describe('useTransactionRowContextActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not read the selected transactions until the menu opens', () => {
    const { getTransaction, rerender, visibleNames } = renderRow({
      id: 'plain-1',
      selected: transactions.map(t => t.id),
    });
    rerender();

    expect(getTransaction).not.toHaveBeenCalled();

    visibleNames();
    expect(getTransaction).toHaveBeenCalled();
  });

  it('does not iterate the selection during render', () => {
    // "Select all" re-renders every visible row, so any per-row work that
    // walks the selection makes it rows x selected.
    let iterations = 0;
    class CountingSet extends Set<string> {
      override [Symbol.iterator]() {
        iterations++;
        return super[Symbol.iterator]();
      }
      override forEach(...args: Parameters<Set<string>['forEach']>): void {
        iterations++;
        super.forEach(...args);
      }
    }
    const selection = new CountingSet(transactions.map(t => t.id));
    iterations = 0;

    const { rerender, visibleNames } = renderRow({
      id: 'plain-1',
      selection,
    });
    rerender();
    expect(iterations).toBe(0);

    visibleNames();
    expect(iterations).toBeGreaterThan(0);
  });

  it('treats selected ids that are not loaded like unlinked transactions', () => {
    // "Select all" can select transactions beyond the loaded page, which
    // getTransaction cannot find.
    const { visibleNames, click, handlers } = renderRow({
      id: 'linked-1',
      selected: ['linked-1', 'not-loaded'],
    });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'link-schedule',
      'create-rule',
    ]);

    click('duplicate');
    expect(handlers.onDuplicate).toHaveBeenCalledWith([
      'linked-1',
      'not-loaded',
    ]);
  });

  it('does not offer unsplit when a selected split is not loaded', () => {
    const { visibleNames } = renderRow({
      id: 'parent',
      selected: ['parent', 'child-1', 'not-loaded'],
    });

    expect(visibleNames()).toEqual(['delete', 'link-schedule', 'create-rule']);
  });

  it('only uses the cached schedules that are selected', () => {
    const { visibleNames } = renderRow({
      id: 'preview/recurring/2024-02-01',
      schedules: [recurringSchedule, oneOffSchedule],
    });

    expect(visibleNames()).toEqual([
      'view-schedule',
      'post-transaction',
      'post-transaction-today',
      'skip',
    ]);
  });

  it('acts on the row itself when nothing is selected', () => {
    const { visibleNames, click, handlers } = renderRow({ id: 'plain-1' });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'link-schedule',
      'create-rule',
    ]);

    click('duplicate');
    expect(handlers.onDuplicate).toHaveBeenCalledWith(['plain-1']);
  });

  it('acts on the whole selection when there is one', () => {
    const { visibleNames, click, handlers } = renderRow({
      id: 'plain-1',
      selected: ['plain-1', 'plain-2'],
    });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'link-schedule',
      'create-rule',
    ]);

    click('delete');
    expect(handlers.onDelete).toHaveBeenCalledWith(['plain-1', 'plain-2']);
    click('link-schedule');
    expect(handlers.onLinkSchedule).toHaveBeenCalledWith([
      'plain-1',
      'plain-2',
    ]);
  });

  it('offers view and unlink for a single linked transaction', () => {
    const { visibleNames } = renderRow({ id: 'linked-1' });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'view-schedule',
      'unlink-schedule',
    ]);
  });

  it('offers unlink but not view for several linked transactions', () => {
    const { visibleNames, click, handlers } = renderRow({
      id: 'linked-1',
      selected: ['linked-1', 'linked-2'],
    });

    expect(visibleNames()).toEqual(['duplicate', 'delete', 'unlink-schedule']);

    click('unlink-schedule');
    expect(handlers.onUnlinkSchedule).toHaveBeenCalledWith([
      'linked-1',
      'linked-2',
    ]);
  });

  it('treats a mix of linked and unlinked transactions as not linked', () => {
    const { visibleNames } = renderRow({
      id: 'linked-1',
      selected: ['linked-1', 'plain-1'],
    });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'link-schedule',
      'create-rule',
    ]);
  });

  it('hides duplicate and offers unsplit when split children are selected', () => {
    const { visibleNames, click, handlers } = renderRow({
      id: 'parent',
      selected: ['parent', 'child-1', 'child-2'],
    });

    expect(visibleNames()).toEqual([
      'delete',
      'link-schedule',
      'create-rule',
      'unsplit-transactions',
    ]);

    click('unsplit-transactions');
    expect(handlers.onMakeAsNonSplitTransactions).toHaveBeenCalledWith([
      'parent',
      'child-1',
      'child-2',
    ]);
  });

  it('offers unsplit for a split parent on its own', () => {
    const { visibleNames } = renderRow({ id: 'parent' });

    expect(visibleNames()).toContain('unsplit-transactions');
    expect(visibleNames()).toContain('duplicate');
  });

  it('does not offer unsplit for reconciled or non-split transactions', () => {
    expect(renderRow({ id: 'reconciled-parent' }).visibleNames()).not.toContain(
      'unsplit-transactions',
    );
    expect(
      renderRow({
        id: 'parent',
        selected: ['parent', 'plain-1'],
      }).visibleNames(),
    ).not.toContain('unsplit-transactions');
  });

  it('shows schedule actions for a single recurring preview row', () => {
    const { visibleNames, click, handlers } = renderRow({
      id: 'preview/recurring/2024-02-01',
      schedules: [recurringSchedule],
    });

    expect(visibleNames()).toEqual([
      'view-schedule',
      'post-transaction',
      'post-transaction-today',
      'skip',
    ]);

    click('post-transaction');
    expect(handlers.onScheduleAction).toHaveBeenCalledWith('post-transaction', [
      'preview/recurring/2024-02-01',
    ]);
  });

  it('shows complete for a one-off preview row', () => {
    const { visibleNames } = renderRow({
      id: 'preview/one-off/2024-01-01',
      schedules: [oneOffSchedule],
    });

    expect(visibleNames()).toEqual([
      'view-schedule',
      'post-transaction',
      'post-transaction-today',
      'complete',
    ]);
  });

  it('hides view, skip and complete for mixed preview rows', () => {
    const { visibleNames } = renderRow({
      id: 'preview/recurring/2024-02-01',
      selected: ['preview/recurring/2024-02-01', 'preview/one-off/2024-01-01'],
      schedules: [recurringSchedule, oneOffSchedule],
    });

    expect(visibleNames()).toEqual([
      'post-transaction',
      'post-transaction-today',
    ]);
  });

  it('shows transaction actions, never linked, when previews and transactions are mixed', () => {
    const { visibleNames } = renderRow({
      id: 'linked-1',
      selected: ['linked-1', 'preview/recurring/2024-02-01'],
      schedules: [recurringSchedule],
    });

    expect(visibleNames()).toEqual([
      'duplicate',
      'delete',
      'link-schedule',
      'create-rule',
    ]);
  });

  it('uses the selection from the latest render', () => {
    vi.mocked(useSelectedItems).mockReturnValue(new Set());
    const { rerender, visibleNames, click, handlers } = renderRow({
      id: 'plain-1',
    });

    vi.mocked(useSelectedItems).mockReturnValue(
      new Set(['plain-1', 'child-1']),
    );
    rerender();

    expect(visibleNames()).not.toContain('duplicate');
    click('delete');
    expect(handlers.onDelete).toHaveBeenCalledWith(['plain-1', 'child-1']);
  });
});
