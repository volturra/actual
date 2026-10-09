import * as monthUtils from '@actual-app/core/shared/months';
import type {
  GroupedEntity,
  IntervalEntity,
} from '@actual-app/core/types/models';

import type { UncategorizedEntity } from '#components/reports/ReportOptions';

import type { ItemAmountsByDate } from './filterHiddenItems';

type recalculateProps = {
  item: UncategorizedEntity;
  intervals: Array<string>;
  // The item's sums from `sumItemAmountsByDate`.
  amountsByDate: ItemAmountsByDate;
  startDate: string;
  endDate: string;
};

export function recalculate({
  item,
  intervals,
  amountsByDate: { assets: assetsByDate, debts: debtsByDate },
  startDate,
  endDate,
}: recalculateProps): GroupedEntity {
  let totalAssets = 0;
  let totalDebts = 0;
  const intervalData = intervals.reduce(
    (arr: IntervalEntity[], intervalItem, index) => {
      const last = arr.length === 0 ? null : arr[arr.length - 1];

      const intervalAssets = assetsByDate.get(intervalItem) ?? 0;
      totalAssets += intervalAssets;

      const intervalDebts = debtsByDate.get(intervalItem) ?? 0;
      totalDebts += intervalDebts;

      const intervalTotals = intervalAssets + intervalDebts;

      const change = last ? intervalTotals - last.totalTotals : 0;

      arr.push({
        date: intervalItem,
        totalAssets: intervalAssets,
        totalDebts: intervalDebts,
        netAssets: intervalTotals > 0 ? intervalTotals : 0,
        netDebts: intervalTotals < 0 ? intervalTotals : 0,
        totalTotals: intervalTotals,
        totalBudgeted: intervalTotals,
        change,
        intervalStartDate: index === 0 ? startDate : intervalItem,
        intervalEndDate:
          index + 1 === intervals.length
            ? endDate
            : monthUtils.subDays(intervals[index + 1], 1),
      });

      return arr;
    },
    [],
  );

  const totalTotals = totalAssets + totalDebts;

  return {
    id: item.id || '',
    name: item.name,
    uncategorizedId: item.uncategorized_id,
    bucketTagNames: item.bucketTagNames,
    totalAssets,
    totalDebts,
    netAssets: totalTotals > 0 ? totalTotals : 0,
    netDebts: totalTotals < 0 ? totalTotals : 0,
    totalTotals,
    totalBudgeted: totalTotals,
    intervalData,
  };
}
