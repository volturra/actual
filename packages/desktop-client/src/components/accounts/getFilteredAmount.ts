import type { Query } from '@actual-app/core/shared/query';
import { sumMatchedAmounts } from '@actual-app/core/shared/transactions';

import { aqlQuery } from '#queries/aqlQuery';

/**
 * Rows of a search that one fetch returned, so they all come from the same
 * state of the database.
 */
type FetchedSearchRows = {
  /** The groups (transactions with their splits) the fetch returned */
  groupCount: number;
  /** The fetch's rows, with the splits ungrouped */
  transactions: Parameters<typeof sumMatchedAmounts>[0];
  /** The most groups the fetch could return */
  pageCount: number;
};

/**
 * Sum of the amounts matched by the register's current filter or search.
 * The register only shows it while a filter or search is active, so no
 * query is run otherwise. When a search's rows fetched together are fewer
 * than the page size, they hold every match, so the sum is taken from them
 * instead of running the search a second time.
 */
export async function getFilteredAmount(
  query: Query | undefined,
  isFiltered: boolean,
  fetchedSearchRows?: FetchedSearchRows,
): Promise<number | null> {
  if (!isFiltered || !query) {
    return null;
  }

  if (
    fetchedSearchRows &&
    fetchedSearchRows.groupCount < fetchedSearchRows.pageCount
  ) {
    return sumMatchedAmounts(fetchedSearchRows.transactions);
  }

  const { data } = await aqlQuery(query.calculate({ $sum: '$amount' }));
  return data;
}
