import { q } from './query';

export type SpendingTotalsRow = {
  date: string;
  // NULL for a transaction with no category, or whose category or account
  // was deleted
  categoryIncome: boolean | null;
  accountOffBudget: boolean | null;
  amount: number;
};

/**
 * Daily totals of the positive (`assets`) or negative (`debts`) transactions
 * from `startDate` to `endDate`, split only by whether the category is an
 * income category and whether the account is off budget. The spending report
 * reads nothing else.
 *
 * Income and off-budget rows are dropped in JS, not in SQL: for a
 * transaction with no category, or whose category or account was deleted,
 * the joined flag is NULL, which JS reads as false but a SQL comparison with
 * false (`= 0`) does not match.
 */
export function makeSpendingTotalsQuery(
  name: 'assets' | 'debts',
  startDate: string,
  endDate: string,
  conditionsOpKey: '$and' | '$or',
  filters: unknown[],
) {
  return q('transactions')
    .filter({ [conditionsOpKey]: filters })
    .filter({
      $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
    })
    .filter(name === 'assets' ? { amount: { $gt: 0 } } : { amount: { $lt: 0 } })
    .groupBy([
      'date',
      { $id: '$category.is_income' },
      { $id: '$account.offbudget' },
    ])
    .select([
      'date',
      { categoryIncome: { $id: '$category.is_income' } },
      { accountOffBudget: { $id: '$account.offbudget' } },
      { amount: { $sum: '$amount' } },
    ]);
}
