import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type { ObjectExpression } from '@actual-app/core/shared/query';

export function makeQuery(
  name: string,
  startDate: string,
  endDate: string,
  interval: string,
  conditionsOpKey: string,
  filters: unknown[],
  groupBy?: string,
) {
  const intervalGroup =
    interval === 'Monthly'
      ? { $month: '$date' }
      : interval === 'Yearly'
        ? { $year: '$date' }
        : { $day: '$date' };
  const query = q('transactions')
    //Apply filters and split by "Group By"
    .filter({
      [conditionsOpKey]: filters,
    })
    //Apply date range filters
    .filter({ $and: dateRangeFilters(startDate, endDate, interval) })
    //Show assets or debts
    .filter(
      name === 'assets' ? { amount: { $gt: 0 } } : { amount: { $lt: 0 } },
    );

  const groupByFields: Array<ObjectExpression | string> = [
    intervalGroup,
    { $id: '$account' },
    { $id: '$payee' },
    { $id: '$category' },
    { $id: '$payee.transfer_acct.id' },
  ];
  const selectedFields: Array<ObjectExpression | string> = [
    { date: intervalGroup },
    { category: { $id: '$category.id' } },
    { categoryHidden: { $id: '$category.hidden' } },
    { categoryIncome: { $id: '$category.is_income' } },
    { categoryGroup: { $id: '$category.group.id' } },
    { categoryGroupHidden: { $id: '$category.group.hidden' } },
    { account: { $id: '$account.id' } },
    { accountOffBudget: { $id: '$account.offbudget' } },
    { payee: { $id: '$payee.id' } },
    { transferAccount: { $id: '$payee.transfer_acct.id' } },
    { amount: { $sum: '$amount' } },
  ];

  if (groupBy === 'Tag') {
    groupByFields.push('notes');
    selectedFields.push('notes');
  }

  return query.groupBy(groupByFields).select(selectedFields);
}

/**
 * Keeps the transactions dated from `startDate` to `endDate`, inclusive.
 * Monthly and yearly reports include every day of the start and end month
 * or year.
 *
 * Those bounds are widened to whole months or years here and compared with
 * the plain `date` column. Comparing `$month` or `$year` of the date instead
 * would wrap the column in a SQL function, which stops SQLite from using the
 * date index. Dates are stored as YYYYMMDD integers, so bounds with day
 * (and month) 00 and 99 cover every stored date of the month or year,
 * including out-of-range ones like 2024-01-00 that the API accepts.
 */
function dateRangeFilters(
  startDate: string,
  endDate: string,
  interval: string,
): ObjectExpression[] {
  if (interval === 'Monthly') {
    return [
      { date: { $gte: monthUtils.getMonth(startDate) + '-00' } },
      { date: { $lte: monthUtils.getMonth(endDate) + '-99' } },
    ];
  }
  if (interval === 'Yearly') {
    return [
      { date: { $gte: monthUtils.getYear(startDate) + '-00-00' } },
      { date: { $lte: monthUtils.getYear(endDate) + '-99-99' } },
    ];
  }
  return [{ date: { $gte: startDate } }, { date: { $lte: endDate } }];
}
