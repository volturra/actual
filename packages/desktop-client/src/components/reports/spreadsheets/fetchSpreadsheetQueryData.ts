import { listen } from '@actual-app/core/platform/client/connection';
import type {
  balanceTypeOpType,
  CategoryEntity,
  CategoryGroupEntity,
  RuleConditionEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

import type { QueryDataEntity } from '#components/reports/ReportOptions';
import { aqlQuery } from '#queries/aqlQuery';

import { fetchBudgetData } from './budgetDataQuery';
import { makeQuery } from './makeQuery';

type FetchSpreadsheetQueryDataArgs = {
  balanceTypeOp: balanceTypeOpType | undefined;
  startDate: string;
  endDate: string;
  interval: string;
  categories: CategoryEntity[];
  categoryGroups: CategoryGroupEntity[];
  conditions: RuleConditionEntity[];
  conditionsOp: string;
  conditionsOpKey: string;
  filters: unknown[];
  budgetType?: SyncedPrefs['budgetType'];
  groupBy?: string;
};

type SpreadsheetQueryData = {
  assets: QueryDataEntity[];
  debts: QueryDataEntity[];
};

const inFlightQueries = new Map<string, Promise<SpreadsheetQueryData>>();

// Bumped whenever the data may have changed, so a call made after a sync or
// an undo never joins a call whose queries ran against the old data.
let dataGeneration = 0;
let isListening = false;

function listenForDataChanges() {
  if (isListening) {
    return;
  }
  isListening = true;
  listen('sync-event', event => {
    if (event.type === 'applied' || event.type === 'success') {
      dataGeneration++;
    }
  });
  listen('undo-event', () => {
    dataGeneration++;
  });
}

/**
 * Loads the rows a custom report is built from.
 *
 * The graph and the table of a custom report load at the same time and ask
 * for the same rows. While a call is in flight, a call with the same
 * arguments shares its result instead of running the queries again. Nothing
 * is kept once the call settles, and a sync or an undo stops later calls from
 * joining calls that started before it, so later calls always see fresh data.
 *
 * Callers share the returned rows, so they must not mutate them.
 */
export function fetchSpreadsheetQueryData(
  args: FetchSpreadsheetQueryDataArgs,
): Promise<SpreadsheetQueryData> {
  listenForDataChanges();
  const key = JSON.stringify({
    ...args,
    dataGeneration,
    // The queries only depend on `groupBy` when grouping by tag.
    groupBy: args.groupBy === 'Tag' ? args.groupBy : undefined,
  });
  const inFlight = inFlightQueries.get(key);
  if (inFlight) {
    return inFlight;
  }

  const promise = runSpreadsheetQueries(args).finally(() => {
    inFlightQueries.delete(key);
  });
  inFlightQueries.set(key, promise);
  return promise;
}

async function runSpreadsheetQueries({
  balanceTypeOp,
  startDate,
  endDate,
  interval,
  categories,
  categoryGroups,
  conditions,
  conditionsOp,
  conditionsOpKey,
  filters,
  budgetType,
  groupBy,
}: FetchSpreadsheetQueryDataArgs): Promise<SpreadsheetQueryData> {
  if (balanceTypeOp === 'totalBudgeted') {
    return fetchBudgetData({
      startDate,
      endDate,
      interval,
      categories,
      categoryGroups,
      conditions,
      conditionsOp: conditionsOp === 'or' ? 'or' : 'and',
      budgetType,
    });
  }

  const [assets, debts] = await Promise.all([
    aqlQuery(
      makeQuery(
        'assets',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
        groupBy,
      ),
    ).then(({ data }) => data),
    aqlQuery(
      makeQuery(
        'debts',
        startDate,
        endDate,
        interval,
        conditionsOpKey,
        filters,
        groupBy,
      ),
    ).then(({ data }) => data),
  ]);

  return { assets, debts };
}
