import { beforeEach, describe, expect, it, vi } from 'vitest';

import { send } from '#server/main-app';
import { makeChild } from '#shared/transactions';

import {
  doImport,
  getBudgetNotes,
  importPayees,
  importTransactions,
} from './ynab4';
import type { MonthlyBudget, MonthlySubCategoryBudget } from './ynab4-types';
import type * as YNAB4 from './ynab4-types';

vi.mock('#server/main-app', () => ({
  send: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(send).mockReset();
});

describe('importTransactions', () => {
  it('gives non-transfer split children the parent payee and keeps transfer children on the transfer payee', async () => {
    const entityIdMap = new Map<string, string>([
      ['ynab-account-1', 'actual-account-1'],
      ['ynab-account-2', 'actual-account-2'],
      ['ynab-payee-1', 'actual-payee-1'],
      ['ynab-category-1', 'actual-category-1'],
    ]);

    // Shaped like a real YNAB4 export: the payee lives on the parent only,
    // sub transactions carry no payeeId.
    const split = {
      entityId: 'txn-split',
      accountId: 'ynab-account-1',
      payeeId: 'ynab-payee-1',
      categoryId: 'Category/__Split__',
      amount: -1000,
      date: '2024-10-07',
      cleared: 'Uncleared',
      subTransactions: [
        {
          entityId: 'sub-1',
          amount: -50,
          categoryId: 'ynab-category-1',
        },
        {
          entityId: 'sub-2',
          amount: -950,
          categoryId: null,
          targetAccountId: 'ynab-account-2',
          transferTransactionId: 'txn-transfer-in',
        },
      ],
    };
    const transferIn = {
      entityId: 'txn-transfer-in',
      accountId: 'ynab-account-2',
      amount: 950,
      date: '2024-10-07',
      cleared: 'Uncleared',
      targetAccountId: 'ynab-account-1',
      transferTransactionId: 'sub-2',
    };

    vi.mocked(send).mockImplementation(async (name: string) => {
      switch (name) {
        case 'api/categories-get':
          return [{ id: 'income-id', name: 'Income' }];
        case 'api/accounts-get':
          return [
            { id: 'actual-account-1', offbudget: false },
            { id: 'actual-account-2', offbudget: false },
          ];
        case 'api/payees-get':
          return [
            { id: 'transfer-payee-1', transfer_acct: 'actual-account-1' },
            { id: 'transfer-payee-2', transfer_acct: 'actual-account-2' },
          ];
        case 'api/transactions-add':
          return null;
        default:
          throw new Error(`Unexpected send call: ${name}`);
      }
    });

    await importTransactions(
      {
        payees: [{ entityId: 'ynab-payee-1', name: 'Some Payee' }],
        accounts: [],
        transactions: [split, transferIn],
      } as unknown as YNAB4.YFull,
      entityIdMap,
      vi.fn(),
    );

    const imported = vi
      .mocked(send)
      .mock.calls.filter(([name]) => name === 'api/transactions-add')
      .flatMap(([, args]) => args.transactions);
    const parent = imported.find(t => t.id === entityIdMap.get('txn-split'));

    expect(parent.payee).toBe('actual-payee-1');
    expect(parent.imported_payee).toBe('Some Payee');

    const [child, transferChild] = parent.subtransactions;
    // No payee key at all, so makeChild falls back to the parent payee
    expect(child).not.toHaveProperty('payee');
    expect(child.transfer_id).toBeNull();
    expect(makeChild(parent, child).payee).toBe('actual-payee-1');

    expect(transferChild.payee).toBe('transfer-payee-2');
    expect(transferChild.transfer_id).toBe(entityIdMap.get('txn-transfer-in'));
  });

  it('gives a transfer whose other side was deleted an ordinary payee', async () => {
    const entityIdMap = new Map<string, string>([
      ['ynab-account-1', 'actual-account-1'],
      ['ynab-account-2', 'actual-account-2'],
      // importPayees maps YNAB4 transfer payees onto Actual's
      ['ynab-transfer-payee-2', 'transfer-payee-2'],
    ]);
    let createdPayees = 0;

    vi.mocked(send).mockImplementation(async (name: string) => {
      switch (name) {
        case 'api/categories-get':
          return [{ id: 'income-id', name: 'Income' }];
        case 'api/accounts-get':
          return [
            { id: 'actual-account-1', offbudget: false },
            { id: 'actual-account-2', offbudget: false },
          ];
        case 'api/payees-get':
          return [
            { id: 'transfer-payee-1', transfer_acct: 'actual-account-1' },
            { id: 'transfer-payee-2', transfer_acct: 'actual-account-2' },
          ];
        case 'api/payee-create':
          createdPayees++;
          return 'one-sided-payee';
        case 'api/transactions-add':
          return null;
        default:
          throw new Error(`Unexpected send call: ${name}`);
      }
    });

    await importTransactions(
      {
        payees: [
          {
            entityId: 'ynab-transfer-payee-2',
            name: 'Transfer : Savings',
            targetAccountId: 'ynab-account-2',
          },
        ],
        accounts: [],
        transactions: [
          {
            entityId: 'txn-out',
            accountId: 'ynab-account-1',
            payeeId: 'ynab-transfer-payee-2',
            amount: -100,
            date: '2024-10-07',
            cleared: 'Uncleared',
            targetAccountId: 'ynab-account-2',
            transferTransactionId: 'txn-in',
          },
          {
            entityId: 'txn-in',
            accountId: 'ynab-account-2',
            amount: 100,
            date: '2024-10-07',
            cleared: 'Uncleared',
            targetAccountId: 'ynab-account-1',
            transferTransactionId: 'txn-out',
            isTombstone: true,
          },
        ],
      } as unknown as YNAB4.YFull,
      entityIdMap,
      vi.fn(),
    );

    const imported = vi
      .mocked(send)
      .mock.calls.filter(([name]) => name === 'api/transactions-add')
      .flatMap(([, args]) => args.transactions);
    expect(imported).toHaveLength(1);
    expect(imported[0].transfer_id).toBeNull();
    expect(imported[0].payee).toBe('one-sided-payee');
    expect(imported[0].imported_payee).toBe('Transfer : Savings');
    expect(createdPayees).toBe(1);
  });
});

describe('importPayees', () => {
  it("maps YNAB4 transfer payees onto Actual's transfer payees", async () => {
    const entityIdMap = new Map<string, string>([
      ['ynab-account-2', 'actual-account-2'],
    ]);

    vi.mocked(send).mockImplementation(async (name: string) => {
      switch (name) {
        case 'api/payees-get':
          return [
            { id: 'transfer-payee-2', transfer_acct: 'actual-account-2' },
          ];
        case 'api/payee-create':
          return 'created-payee';
        default:
          throw new Error(`Unexpected send call: ${name}`);
      }
    });

    await importPayees(
      {
        payees: [
          {
            entityId: 'ynab-transfer-payee',
            name: 'Transfer : Savings',
            targetAccountId: 'ynab-account-2',
          },
          { entityId: 'ynab-normal-payee', name: 'Coffee Shop' },
        ],
      } as unknown as YNAB4.YFull,
      entityIdMap,
      vi.fn(),
    );

    expect(entityIdMap.get('ynab-transfer-payee')).toBe('transfer-payee-2');
    expect(entityIdMap.get('ynab-normal-payee')).toBe('created-payee');
    const created = vi
      .mocked(send)
      .mock.calls.filter(([name]) => name === 'api/payee-create')
      .map(([, args]) => args.payee.name);
    expect(created).toEqual(['Coffee Shop']);
  });
});

function categoryBudget(
  overrides: Partial<MonthlySubCategoryBudget> = {},
): MonthlySubCategoryBudget {
  return {
    entityType: 'monthlyCategoryBudget',
    categoryId: 'A5',
    budgeted: 100,
    entityVersion: 'A-1',
    entityId: 'category-budget',
    parentMonthlyBudgetId: 'october',
    ...overrides,
  };
}

const entityIdMap = new Map([
  ['A5', 'actual-category'],
  ['deleted', 'actual-deleted'],
  ['empty', 'actual-empty'],
  ['missing-note', 'actual-missing-note'],
]);

describe('doImport', () => {
  it('preserves group notes alongside month and category budget notes', async () => {
    const data = {
      accounts: [],
      payees: [],
      transactions: [],
      scheduledTransactions: [],
      fileMetaData: {
        entityType: 'fileMetaData',
        budgetDataVersion: '4.2',
        currentKnowledge: 'A-1',
      },
      budgetMetaData: {
        entityType: 'budgetMetaData',
        strictBudget: 'true',
        entityVersion: 'A-1',
        currencyLocale: 'en_US',
        budgetType: 'Personal',
        dateLocale: 'en_US',
        entityId: 'budget',
      },
      masterCategories: [
        {
          entityType: 'masterCategory',
          entityId: 'A4',
          entityVersion: 'A-1',
          name: 'Sample Category',
          note: 'SAMPLE GROUP NOTE',
          type: 'OUTFLOW',
          expanded: true,
          deleteable: true,
          sortableIndex: 0,
          subCategories: [
            {
              entityType: 'subCategory',
              entityId: 'A5',
              entityVersion: 'A-1',
              masterCategoryId: 'A4',
              name: 'Sample Subcategory',
              type: 'OUTFLOW',
              sortableIndex: 0,
            },
          ],
        },
      ],
      monthlyBudgets: [
        {
          entityType: 'monthlyBudget',
          entityId: 'october',
          entityVersion: 'A-1',
          month: '2026-10-01',
          note: 'SAMPLE NOTE 1',
          monthlySubCategoryBudgets: [
            categoryBudget({ note: 'SAMPLE NOTE 2' }),
          ],
        },
      ],
    } satisfies YNAB4.YFull;

    vi.mocked(send).mockImplementation(async name => {
      switch (name) {
        case 'api/category-group-create':
          return 'actual-group';
        case 'api/category-create':
          return 'actual-category';
        case 'api/categories-get':
          return [{ id: 'income', name: 'Income' }];
        case 'api/accounts-get':
        case 'api/payees-get':
          return [];
        default:
          return null;
      }
    });

    await doImport(data);

    expect(
      vi.mocked(send).mock.calls.filter(([name]) => name === 'notes-save'),
    ).toEqual([
      ['notes-save', { id: 'actual-group', note: 'SAMPLE GROUP NOTE' }],
      ['notes-save', { id: 'budget-2026-10', note: 'SAMPLE NOTE 1' }],
      ['notes-save', { id: 'actual-category-2026-10', note: 'SAMPLE NOTE 2' }],
    ]);
    expect(send).toHaveBeenCalledWith('api/budget-set-amount', {
      month: '2026-10',
      categoryId: 'actual-category',
      amount: 10000,
    });
  });
});

describe('getBudgetNotes', () => {
  it('imports month and mapped category notes, skipping tombstones and empty or unmapped notes', () => {
    const budget = {
      entityType: 'monthlyBudget',
      month: '2026-10-01',
      note: 'SAMPLE NOTE 1',
      entityVersion: 'A-1',
      entityId: 'october',
      monthlySubCategoryBudgets: [
        categoryBudget({ note: 'SAMPLE NOTE 2' }),
        categoryBudget({
          categoryId: 'deleted',
          note: 'Deleted note',
          isTombstone: true,
        }),
        categoryBudget({ categoryId: 'empty', note: '' }),
        categoryBudget({ categoryId: 'missing-note', budgeted: 0 }),
        categoryBudget({ categoryId: 'unmapped', note: 'Unmapped note' }),
      ],
    } satisfies MonthlyBudget;

    expect(getBudgetNotes(budget, entityIdMap)).toEqual([
      { id: 'budget-2026-10', note: 'SAMPLE NOTE 1' },
      { id: 'actual-category-2026-10', note: 'SAMPLE NOTE 2' },
    ]);
  });

  it.each([undefined, ''])('skips a month note of %s', note => {
    const budget = {
      entityType: 'monthlyBudget',
      month: '2026-10-01',
      note,
      entityVersion: 'A-1',
      entityId: 'october',
      monthlySubCategoryBudgets: [],
    } satisfies MonthlyBudget;

    expect(getBudgetNotes(budget, entityIdMap)).toEqual([]);
  });
});
