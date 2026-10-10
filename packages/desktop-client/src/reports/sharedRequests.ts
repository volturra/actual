import { listen, send } from '@actual-app/core/platform/client/connection';
import type { Handlers } from '@actual-app/core/types/handlers';

import {
  forgetInFlightReportRequests,
  getReportRequestGeneration,
} from './requestGeneration';

// Every local write (transactions added, edited, deleted or imported, rules
// applied, schedules posted) and every change synced from another device is
// announced by a `sync-event`; undo and redo also send an `undo-event`.
// Switching budgets calls `forgetInFlightReportRequests` directly.
let isListening = false;

function listenForDataChanges() {
  if (isListening) {
    return;
  }
  isListening = true;
  listen('sync-event', event => {
    if (event.type === 'applied' || event.type === 'success') {
      forgetInFlightReportRequests();
    }
  });
  listen('undo-event', () => {
    forgetInFlightReportRequests();
  });
}

/**
 * Returns a function that shares one in-flight request between callers that
 * ask for the same key at the same time, such as the cards of the reports
 * dashboard mounting together. Nothing is kept once the request settles, so
 * a later call always runs the request again, and a write, sync, undo or
 * budget switch stops later calls from joining a request that started before
 * it.
 *
 * Callers share the resolved value, so they must not mutate it.
 */
export function createInFlightSharing<T>() {
  const inFlightRequests = new Map<string, Promise<T>>();

  return function shareInFlight(
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    listenForDataChanges();
    const generationKey = `${getReportRequestGeneration()}:${key}`;
    const inFlight = inFlightRequests.get(generationKey);
    if (inFlight) {
      return inFlight;
    }

    const promise = run().finally(() => {
      inFlightRequests.delete(generationKey);
    });
    inFlightRequests.set(generationKey, promise);
    return promise;
  };
}

type EarliestOrLatestTransaction = Awaited<
  ReturnType<Handlers['get-earliest-transaction']>
>;

type MakeFiltersArgs = Parameters<Handlers['make-filters-from-conditions']>[0];
type MakeFiltersResult = Awaited<
  ReturnType<Handlers['make-filters-from-conditions']>
>;

const shareEarliestTransaction =
  createInFlightSharing<EarliestOrLatestTransaction>();
const shareLatestTransaction =
  createInFlightSharing<EarliestOrLatestTransaction>();
const shareFilters = createInFlightSharing<MakeFiltersResult>();

// Every caller gets its own copy, so no caller can change another's result.

/** `get-earliest-transaction`, shared between concurrent callers. */
export async function getEarliestTransaction(): Promise<EarliestOrLatestTransaction> {
  return structuredClone(
    await shareEarliestTransaction('', () => send('get-earliest-transaction')),
  );
}

/** `get-latest-transaction`, shared between concurrent callers. */
export async function getLatestTransaction(): Promise<EarliestOrLatestTransaction> {
  return structuredClone(
    await shareLatestTransaction('', () => send('get-latest-transaction')),
  );
}

/**
 * `make-filters-from-conditions`, shared between concurrent callers with the
 * same arguments.
 */
export async function makeFiltersFromConditions(
  args: MakeFiltersArgs,
): Promise<MakeFiltersResult> {
  return structuredClone(
    await shareFilters(JSON.stringify(args), () =>
      send('make-filters-from-conditions', args),
    ),
  );
}
