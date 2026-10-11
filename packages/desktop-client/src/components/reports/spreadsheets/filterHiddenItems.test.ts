import type {
  QueryDataEntity,
  UncategorizedEntity,
} from '#components/reports/ReportOptions';

import {
  filterHiddenItems,
  filterReportTransactions,
  groupRowsByLabel,
  sumItemAmountsByDate,
} from './filterHiddenItems';
import type { GroupByLabel } from './filterHiddenItems';

const intervals = ['2026-01', '2026-02', '2026-03'];

function row(overrides: Partial<QueryDataEntity>): QueryDataEntity {
  return {
    date: '2026-01',
    category: 'food',
    categoryHidden: false,
    categoryGroup: 'living',
    categoryGroupHidden: false,
    account: 'checking',
    accountOffBudget: false,
    payee: 'grocer',
    transferAccount: '',
    tagBucketId: 'red',
    amount: -100,
    ...overrides,
  };
}

// Covers every branch of filterHiddenItems: categorized, hidden category,
// hidden group, uncategorized, transfers, and off-budget rows, plus a row
// outside the requested intervals.
const debts: QueryDataEntity[] = [
  row({}),
  row({ date: '2026-02', amount: -40 }),
  row({ date: '2026-02', category: 'rent', payee: 'landlord', amount: -900 }),
  row({ date: '2026-03', categoryHidden: true, amount: -7 }),
  row({ date: '2026-03', categoryGroupHidden: true, amount: -11 }),
  row({ category: null, payee: 'unknown', amount: -13 }),
  row({
    date: '2026-02',
    category: null,
    transferAccount: 'savings',
    payee: 'transfer-savings',
    amount: -500,
  }),
  row({
    date: '2026-03',
    account: 'brokerage',
    accountOffBudget: true,
    tagBucketId: 'blue',
    amount: -23,
  }),
  row({
    date: '2026-03',
    category: null,
    account: 'brokerage',
    accountOffBudget: true,
    amount: -29,
  }),
  row({ date: '2025-12', amount: -1000 }),
];

const assets: QueryDataEntity[] = [
  row({ category: 'salary', payee: 'employer', amount: 3000 }),
  row({ date: '2026-02', category: 'salary', payee: 'employer', amount: 10 }),
  row({ date: '2026-03', category: null, payee: 'unknown', amount: 17 }),
  row({
    date: '2026-03',
    category: null,
    account: 'savings',
    transferAccount: 'checking',
    payee: 'transfer-checking',
    amount: 500,
  }),
  row({
    date: '2026-02',
    account: 'brokerage',
    accountOffBudget: true,
    amount: 31,
  }),
];

const uncategorizedItems: UncategorizedEntity[] = (
  ['off_budget', 'transfer', 'other', 'all'] as const
).map(uncategorized_id => ({
  id: '',
  name: uncategorized_id,
  hidden: false,
  uncategorized_id,
}));

const itemsByLabel: Record<GroupByLabel, UncategorizedEntity[]> = {
  category: [
    { id: 'food', name: 'Food', hidden: false },
    { id: 'rent', name: 'Rent', hidden: false },
    { id: 'salary', name: 'Salary', hidden: false },
    ...uncategorizedItems,
  ],
  categoryGroup: [
    { id: 'living', name: 'Living', hidden: false },
    { id: 'missing', name: 'Missing', hidden: false },
    ...uncategorizedItems,
  ],
  payee: [
    { id: 'grocer', name: 'Grocer', hidden: false },
    { id: 'transfer-savings', name: 'Savings', hidden: false },
  ],
  account: [
    { id: 'checking', name: 'Checking', hidden: false },
    { id: 'brokerage', name: 'Brokerage', hidden: false },
  ],
  tagBucketId: [
    { id: 'red', name: '#red', hidden: false },
    { id: 'blue', name: '#blue', hidden: false },
  ],
};

const flagCombinations = [false, true].flatMap(showOffBudget =>
  [false, true].flatMap(showHiddenCategories =>
    [false, true].map(showUncategorized => ({
      showOffBudget,
      showHiddenCategories,
      showUncategorized,
    })),
  ),
);

// The per-interval computation the custom report did before it summed each
// item's rows once.
function sumPerInterval(
  item: UncategorizedEntity,
  data: QueryDataEntity[],
  groupByLabel: GroupByLabel,
  flags: (typeof flagCombinations)[number],
) {
  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';
  return intervals.map(interval =>
    filterHiddenItems(
      item,
      data,
      flags.showOffBudget,
      flags.showHiddenCategories,
      flags.showUncategorized,
      groupsByCategory,
    )
      .filter(
        e =>
          e.date === interval &&
          (e[groupByLabel] === (item.id ?? null) ||
            (item.uncategorized_id && groupsByCategory)),
      )
      .reduce((a, v) => a + v.amount, 0),
  );
}

describe('sumItemAmountsByDate', () => {
  const cases = (Object.keys(itemsByLabel) as GroupByLabel[]).flatMap(
    groupByLabel =>
      itemsByLabel[groupByLabel].flatMap(item =>
        flagCombinations.map(flags => ({
          groupByLabel,
          item,
          flags,
          name: `${groupByLabel} ${item.uncategorized_id ?? item.id} ${JSON.stringify(flags)}`,
        })),
      ),
  );

  it.each(cases)(
    'matches the per-interval sums for $name',
    ({ groupByLabel, item, flags }) => {
      for (const data of [assets, debts]) {
        const visibleRows = filterReportTransactions(
          data,
          flags.showOffBudget,
          flags.showHiddenCategories,
          flags.showUncategorized,
        );
        const expected = sumPerInterval(item, data, groupByLabel, flags);
        const sums = sumItemAmountsByDate(
          item,
          visibleRows,
          groupByLabel,
          groupRowsByLabel(visibleRows, groupByLabel),
        );
        expect(intervals.map(interval => sums.get(interval) ?? 0)).toEqual(
          expected,
        );
      }
    },
  );

  it('sums a category by date and skips hidden and off-budget rows', () => {
    const visibleRows = filterReportTransactions(debts, false, false, false);
    const sums = sumItemAmountsByDate(
      { id: 'food', name: 'Food', hidden: false },
      visibleRows,
      'category',
      groupRowsByLabel(visibleRows, 'category'),
    );
    expect(Object.fromEntries(sums)).toEqual({
      '2025-12': -1000,
      '2026-01': -100,
      '2026-02': -40,
    });
  });

  it('puts uncategorized, transfer and off-budget rows in the "all" bucket', () => {
    const visibleRows = filterReportTransactions(debts, true, false, true);
    const sums = sumItemAmountsByDate(
      { id: '', name: 'All', hidden: false, uncategorized_id: 'all' },
      visibleRows,
      'category',
      groupRowsByLabel(visibleRows, 'category'),
    );
    expect(Object.fromEntries(sums)).toEqual({
      '2026-01': -13,
      '2026-02': -500,
      '2026-03': -52,
    });
  });

  it('returns an empty map when there are no rows', () => {
    expect(
      sumItemAmountsByDate(
        { id: 'food', name: 'Food', hidden: false },
        [],
        'category',
        new Map(),
      ).size,
    ).toBe(0);
  });
});

// Items whose id isn't a string, which `sumItemAmountsByDate` reads as null.
function itemWithId(
  id: string | null | undefined,
  uncategorized_id?: UncategorizedEntity['uncategorized_id'],
): UncategorizedEntity {
  const item: UncategorizedEntity = {
    id: '',
    name: 'Item',
    hidden: false,
    uncategorized_id,
  };
  return Object.assign(item, { id });
}

describe('groupRowsByLabel', () => {
  it('groups rows by label value and keeps their order', () => {
    const rows = [
      row({ payee: 'a', amount: 1 }),
      row({ payee: 'b', amount: 2 }),
      row({ payee: 'a', amount: 3 }),
      Object.assign(row({ amount: 4 }), { payee: null }),
      Object.assign(row({ amount: 5 }), { payee: undefined }),
      row({ payee: '', amount: 6 }),
      Object.assign(row({ amount: 7 }), { payee: null }),
    ];
    const rowsByLabel = groupRowsByLabel(rows, 'payee');
    const amountsByLabel = [...rowsByLabel].map(([label, labelRows]) => [
      label,
      labelRows.map(r => r.amount),
    ]);
    expect(amountsByLabel).toEqual([
      ['a', [1, 3]],
      ['b', [2]],
      [null, [4, 7]],
      [undefined, [5]],
      ['', [6]],
    ]);
  });

  it('keeps null and undefined labels apart, as the strict match does', () => {
    const rows = [
      row({ category: null, amount: -1 }),
      Object.assign(row({ amount: -2 }), { category: undefined }),
    ];
    const visibleRows = filterReportTransactions(rows, true, true, true);
    const nullItem = itemWithId(null);
    const undefinedItem = itemWithId(undefined);
    for (const item of [nullItem, undefinedItem]) {
      for (const label of ['payee', 'category'] as const) {
        const indexed = sumItemAmountsByDate(
          item,
          visibleRows,
          label,
          groupRowsByLabel(visibleRows, label),
        );
        expect([...indexed]).toStrictEqual([
          ...legacySumItemAmountsByDate(item, visibleRows, label),
        ]);
      }
    }
    // `id ?? null` only matches rows whose label is null.
    expect([
      ...sumItemAmountsByDate(
        nullItem,
        visibleRows,
        'payee',
        groupRowsByLabel(visibleRows, 'payee'),
      ),
    ]).toEqual([]);
  });
});

// Deterministic PRNG (mulberry32) so failures are reproducible.
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The loop `sumItemAmountsByDate` ran before it took a per-label index: every
// row is checked against every item. `filterHiddenItems` with every show flag
// on applies only the category bucket check.
function legacySumItemAmountsByDate(
  item: UncategorizedEntity,
  visibleRows: QueryDataEntity[],
  groupByLabel: GroupByLabel,
) {
  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';
  const itemId = item.id ?? null;
  const matchesEveryRow = !!item.uncategorized_id && groupsByCategory;
  const sums = new Map<string, number>();
  for (const row of visibleRows) {
    if (
      filterHiddenItems(item, [row], true, true, true, groupsByCategory)
        .length === 1 &&
      (matchesEveryRow || row[groupByLabel] === itemId)
    ) {
      sums.set(row.date, (sums.get(row.date) ?? 0) + row.amount);
    }
  }
  return sums;
}

describe('sumItemAmountsByDate with a per-label index (randomized)', () => {
  const labels: GroupByLabel[] = [
    'category',
    'categoryGroup',
    'payee',
    'account',
    'tagBucketId',
  ];
  // Includes values no item has, so some rows match no item.
  const labelValues = ['x1', 'x2', 'x3', 'x4', '', null, undefined, 'orphan'];
  const dates = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
  const uncategorizedIds = [
    undefined,
    undefined,
    undefined,
    'off_budget',
    'transfer',
    'other',
    'all',
  ] as const;

  it.each([1, 2, 3, 42, 1234, 99999])(
    'gives bit-identical sums in the same date order (seed %i)',
    seed => {
      const random = makeRandom(seed);
      const pick = <T>(values: readonly T[]): T =>
        values[Math.floor(random() * values.length)];

      const rows: QueryDataEntity[] = Array.from({ length: 400 }, () =>
        Object.assign(
          row({
            date: pick(dates),
            categoryHidden: random() < 0.15,
            categoryGroupHidden: random() < 0.1,
            accountOffBudget: random() < 0.2,
            transferAccount: random() < 0.2 ? 'other-account' : '',
            // Fractional amounts make the sum depend on the addition order.
            amount: (random() - 0.5) * 2000,
          }),
          Object.fromEntries(labels.map(label => [label, pick(labelValues)])),
        ),
      );
      const items = Array.from({ length: 30 }, () =>
        itemWithId(pick(labelValues), pick(uncategorizedIds)),
      );

      for (const flags of flagCombinations) {
        const visibleRows = filterReportTransactions(
          rows,
          flags.showOffBudget,
          flags.showHiddenCategories,
          flags.showUncategorized,
        );
        for (const label of labels) {
          const rowsByLabel = groupRowsByLabel(visibleRows, label);
          for (const item of items) {
            const expected = [
              ...legacySumItemAmountsByDate(item, visibleRows, label),
            ];
            expect([
              ...sumItemAmountsByDate(item, visibleRows, label, rowsByLabel),
            ]).toStrictEqual(expected);
          }
        }
      }
    },
  );
});
