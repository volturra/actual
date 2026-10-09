// Kept apart from `sharedRequests` so the budget file actions can bump it
// without loading the client connection.
let generation = 0;

/**
 * Changes whenever the data may have changed. Shared report requests are
 * keyed on it, so a request made after a change never joins one that
 * started before it.
 */
export function getReportRequestGeneration() {
  return generation;
}

/**
 * Stops later report requests from joining requests that are in flight now.
 * Called on every write, sync and undo, and when a budget is closed or
 * loaded, since a request against the old budget must never answer one made
 * against the new budget.
 */
export function forgetInFlightReportRequests() {
  generation++;
}
