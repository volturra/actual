import type { DataEntity } from '@actual-app/core/types/models';
import { renderHook } from '@testing-library/react';

import type { QueryDataEntity } from '#components/reports/ReportOptions';
import { SpreadsheetProvider, useSpreadsheet } from '#hooks/useSpreadsheet';

import { createCustomSpreadsheet } from './custom-spreadsheet';
import { fetchSpreadsheetQueryData } from './fetchSpreadsheetQueryData';
import { createGroupedSpreadsheet } from './grouped-spreadsheet';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn().mockResolvedValue({ filters: [] }),
  listen: vi.fn(() => vi.fn()),
}));
vi.mock('./fetchSpreadsheetQueryData');

const transaction: QueryDataEntity = {
  date: '2026-01',
  category: 'category',
  categoryHidden: false,
  categoryGroup: 'group',
  categoryGroupHidden: false,
  account: 'account',
  accountOffBudget: false,
  payee: 'payee',
  transferAccount: '',
  notes: '#red #circle',
  amount: -100,
};

it('checks each row against the visibility filters once, not once per group', async () => {
  let hiddenChecks = 0;
  const countingRow = (row: QueryDataEntity) =>
    Object.defineProperty({ ...row }, 'categoryHidden', {
      get() {
        hiddenChecks++;
        return row.categoryHidden;
      },
    });
  const debts = [
    countingRow({ ...transaction, category: 'food', amount: -100 }),
    countingRow({ ...transaction, category: 'rent', amount: -50 }),
    countingRow({ ...transaction, category: 'rent', date: '2026-02' }),
  ];
  vi.mocked(fetchSpreadsheetQueryData).mockResolvedValue({
    assets: [],
    debts,
  });
  const { result } = renderHook(useSpreadsheet, {
    wrapper: SpreadsheetProvider,
  });
  const setData = vi.fn<(data: DataEntity) => void>();
  await createCustomSpreadsheet({
    startDate: '2026-01',
    endDate: '2026-02',
    interval: 'Monthly',
    categories: {
      list: [
        { id: 'food', name: 'Food', group: 'group' },
        { id: 'rent', name: 'Rent', group: 'group' },
      ],
      grouped: [{ id: 'group', name: 'Group' }],
    },
    conditions: [],
    conditionsOp: 'and',
    showEmpty: false,
    showOffBudget: false,
    showHiddenCategories: false,
    showUncategorized: false,
    trimIntervals: false,
    groupBy: 'Category',
  })(result.current, setData);

  const data = setData.mock.calls[0][0];
  expect(data.totalDebts).toBe(-250);
  expect(data.data?.map(group => [group.name, group.totalDebts])).toEqual([
    ['Rent', -150],
    ['Food', -100],
  ]);
  expect(hiddenChecks).toBe(debts.length);
});

it.each([
  { categoryHidden: true },
  { categoryGroupHidden: true },
  { accountOffBudget: true },
  { category: null },
])(
  'does not create empty combinations from excluded transactions %j',
  async excluded => {
    vi.mocked(fetchSpreadsheetQueryData).mockResolvedValue({
      assets: [],
      debts: [
        { ...transaction, ...excluded },
        { ...transaction, notes: '#red', amount: -50 },
        { ...transaction, notes: '#red', amount: -25, date: '2026-02' },
      ],
    });
    const { result } = renderHook(useSpreadsheet, {
      wrapper: SpreadsheetProvider,
    });
    const setData = vi.fn<(data: DataEntity) => void>();
    await createCustomSpreadsheet({
      startDate: '2026-01',
      endDate: '2026-02',
      interval: 'Monthly',
      categories: { list: [], grouped: [] },
      conditions: [],
      conditionsOp: 'and',
      showEmpty: true,
      showOffBudget: false,
      showHiddenCategories: false,
      showUncategorized: false,
      trimIntervals: false,
      groupBy: 'Tag',
      tags: [
        { id: 'red', tag: 'red' },
        { id: 'circle', tag: 'circle' },
      ],
    })(result.current, setData);

    const data = setData.mock.calls[0][0];
    expect(data.data?.map(group => group.name)).toEqual(
      expect.arrayContaining(['#red', '#circle', 'Untagged']),
    );
    expect(data.data).toHaveLength(3);
    expect(data.totalDebts).toBe(-75);
    expect(data.intervalData.map(interval => interval.totalDebts)).toEqual([
      -50, -25,
    ]);
  },
);

it.each(['Category', 'Group', 'Payee', 'Account', 'Interval', 'Tag'])(
  'does not mutate the shared rows when grouping by %s',
  async groupBy => {
    // The graph and the table share these rows, so neither may change them.
    // Writing to a frozen row throws in strict mode.
    const rows = [
      { ...transaction },
      { ...transaction, amount: -50, payee: 'other', date: '2026-02' },
      { ...transaction, amount: 300, notes: '#red', date: '2026-02' },
      { ...transaction, amount: 200, account: 'other', notes: '' },
    ];
    const assets = rows.filter(row => row.amount > 0);
    const debts = rows.filter(row => row.amount < 0);
    [...rows, assets, debts].forEach(value => Object.freeze(value));
    vi.mocked(fetchSpreadsheetQueryData).mockResolvedValue({ assets, debts });
    const { result } = renderHook(useSpreadsheet, {
      wrapper: SpreadsheetProvider,
    });
    const options: Parameters<typeof createCustomSpreadsheet>[0] = {
      startDate: '2026-01',
      endDate: '2026-02',
      interval: 'Monthly',
      categories: { list: [], grouped: [] },
      conditions: [],
      conditionsOp: 'and',
      showEmpty: true,
      showOffBudget: false,
      showHiddenCategories: false,
      showUncategorized: true,
      trimIntervals: false,
      groupBy,
      balanceTypeOp: 'totalTotals',
      tags: [{ id: 'red', tag: 'red' }],
    };

    const setGraphData = vi.fn();
    const setTableData = vi.fn();
    await Promise.all([
      createCustomSpreadsheet(options)(result.current, setGraphData),
      createGroupedSpreadsheet(options)(result.current, setTableData),
    ]);

    expect(setGraphData).toHaveBeenCalledTimes(1);
    expect(setTableData).toHaveBeenCalledTimes(1);
  },
);
