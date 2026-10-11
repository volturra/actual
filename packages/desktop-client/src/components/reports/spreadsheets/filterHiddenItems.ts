import type {
  QueryDataEntity,
  UncategorizedEntity,
} from '#components/reports/ReportOptions';

export function filterHiddenItems(
  item: UncategorizedEntity,
  data: QueryDataEntity[],
  showOffBudget?: boolean,
  showHiddenCategories?: boolean,
  showUncategorized?: boolean,
  groupByCategory?: boolean,
) {
  const showHide = filterReportTransactions(
    data,
    showOffBudget,
    showHiddenCategories,
    showUncategorized,
  );

  return showHide.filter(
    query => !groupByCategory || isInCategoryBucket(item, query),
  );
}

function isInCategoryBucket(item: UncategorizedEntity, query: QueryDataEntity) {
  const hasCategory = !!query.category;
  const isOffBudget = query.accountOffBudget;
  const isTransfer = !!query.transferAccount;

  if (hasCategory && !isOffBudget) {
    return item.uncategorized_id == null;
  }

  switch (item.uncategorized_id) {
    case 'off_budget':
      return isOffBudget;
    case 'transfer':
      return isTransfer && !isOffBudget;
    case 'other':
      return !isOffBudget && !isTransfer;
    case 'all':
      return true;
    default:
      return false;
  }
}

export function filterReportTransactions(
  data: QueryDataEntity[],
  showOffBudget?: boolean,
  showHiddenCategories?: boolean,
  showUncategorized?: boolean,
) {
  return data
    .filter(
      e =>
        showHiddenCategories ||
        (e.categoryHidden === false && e.categoryGroupHidden === false),
    )
    .filter(e => showOffBudget || e.accountOffBudget === false)
    .filter(
      e =>
        showUncategorized || e.category !== null || e.accountOffBudget === true,
    );
}

export type GroupByLabel =
  | 'category'
  | 'categoryGroup'
  | 'payee'
  | 'account'
  | 'tagBucketId';

export type RowsByLabel = Map<QueryDataEntity[GroupByLabel], QueryDataEntity[]>;

export type ItemAmountsByDate = {
  assets: Map<string, number>;
  debts: Map<string, number>;
};

/**
 * Groups rows by their `groupByLabel` value, keeping their order, so
 * `sumItemAmountsByDate` can go over only the rows of one item.
 */
export function groupRowsByLabel(
  visibleRows: QueryDataEntity[],
  groupByLabel: GroupByLabel,
): RowsByLabel {
  const rowsByLabel: RowsByLabel = new Map();
  for (const row of visibleRows) {
    const key = row[groupByLabel];
    const rows = rowsByLabel.get(key);
    if (rows) {
      rows.push(row);
    } else {
      rowsByLabel.set(key, [row]);
    }
  }
  return rowsByLabel;
}

/**
 * Sums the amounts of the rows that belong to `item`, keyed by row date.
 *
 * `visibleRows` must already have gone through `filterReportTransactions`.
 * That filter doesn't depend on the item, so callers run it once per dataset.
 * The result gives the same per-date totals as filtering the rows with
 * `filterHiddenItems` and the `groupByLabel` match once per interval, but it
 * goes over the rows a single time, so callers can look up each interval with
 * `sums.get(interval) ?? 0`.
 *
 * `rowsByLabel` must come from `groupRowsByLabel` on the same rows and label.
 * It lets it go over only the item's own rows instead of every row.
 */
export function sumItemAmountsByDate(
  item: UncategorizedEntity,
  visibleRows: QueryDataEntity[],
  groupByLabel: GroupByLabel,
  rowsByLabel: RowsByLabel,
): Map<string, number> {
  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';
  const itemId = item.id ?? null;
  // An uncategorized bucket takes every row its bucket check lets through.
  const matchesEveryRow = !!item.uncategorized_id && groupsByCategory;
  const itemRows = matchesEveryRow
    ? visibleRows
    : (rowsByLabel.get(itemId) ?? []);

  const sums = new Map<string, number>();
  for (const row of itemRows) {
    if (!groupsByCategory || isInCategoryBucket(item, row)) {
      sums.set(row.date, (sums.get(row.date) ?? 0) + row.amount);
    }
  }
  return sums;
}
