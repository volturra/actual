import type { Query } from '@actual-app/core/shared/query';
import { sumMatchedAmounts } from '@actual-app/core/shared/transactions';

import { aqlQuery } from '#queries/aqlQuery';

/**
 * Sum of the amounts matched by the register's current filter or search.
 * The register only shows it while a filter or search is active, so no
 * query is run otherwise. `allMatchedRows`, when given, are rows fetched
 * together that hold every match (with the splits ungrouped); the sum is
 * then taken from them instead of running the search a second time.
 */
export async function getFilteredAmount(
  query: Query | undefined,
  isFiltered: boolean,
  allMatchedRows?: Parameters<typeof sumMatchedAmounts>[0],
): Promise<number | null> {
  if (!isFiltered || !query) {
    return null;
  }

  if (allMatchedRows) {
    return sumMatchedAmounts(allMatchedRows);
  }

  const { data } = await aqlQuery(query.calculate({ $sum: '$amount' }));
  return data;
}

/**
 * Tells, at the start of a paged query's `onData`, whether its rows are the
 * result of one fetch, rather than the rows loaded before with a page
 * appended by `fetchNext`, which calls `onPageData` just before `onData`.
 */
export function trackAppendedPages() {
  let isAppendedPage = false;
  return {
    onPageData: () => {
      isAppendedPage = true;
    },
    /** Call once at the start of each `onData` */
    takeIsOneFetch: () => {
      const isOneFetch = !isAppendedPage;
      isAppendedPage = false;
      return isOneFetch;
    },
  };
}
