import type { Query } from '@actual-app/core/shared/query';

import { aqlQuery } from '#queries/aqlQuery';

/**
 * Sum of the amounts matched by the register's current filter or search.
 * The register only shows it while a filter or search is active, so no
 * query is run otherwise.
 */
export async function getFilteredAmount(
  query: Query | undefined,
  isFiltered: boolean,
): Promise<number | null> {
  if (!isFiltered || !query) {
    return null;
  }

  const { data } = await aqlQuery(query.calculate({ $sum: '$amount' }));
  return data;
}
