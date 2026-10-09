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

  return showHide.filter(query => {
    if (!groupByCategory) return true;

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
  });
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

/**
 * Sums the amounts of the rows that belong to `item`, keyed by row date.
 *
 * This gives the same per-date totals as filtering `data` with
 * `filterHiddenItems` and the `groupByLabel` match once per interval, but it
 * goes over the rows a single time, so callers can look up each interval with
 * `sums.get(interval) ?? 0`.
 */
export function sumItemAmountsByDate(
  item: UncategorizedEntity,
  data: QueryDataEntity[],
  groupByLabel: GroupByLabel,
  showOffBudget?: boolean,
  showHiddenCategories?: boolean,
  showUncategorized?: boolean,
): Map<string, number> {
  const groupsByCategory =
    groupByLabel === 'category' || groupByLabel === 'categoryGroup';
  const itemId = item.id ?? null;
  // The uncategorized buckets are already narrowed down by filterHiddenItems.
  const matchesEveryRow = !!item.uncategorized_id && groupsByCategory;

  const rows = filterHiddenItems(
    item,
    data,
    showOffBudget,
    showHiddenCategories,
    showUncategorized,
    groupsByCategory,
  );

  const sums = new Map<string, number>();
  for (const row of rows) {
    if (matchesEveryRow || row[groupByLabel] === itemId) {
      sums.set(row.date, (sums.get(row.date) ?? 0) + row.amount);
    }
  }
  return sums;
}
