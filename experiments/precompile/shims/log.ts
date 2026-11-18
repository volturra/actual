// The workloads never log; this stands in for #platform/server/log.
function ignore(..._args: unknown[]) {
  return undefined;
}
export const logger = {
  log: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
  debug: ignore,
  group: ignore,
  groupEnd: ignore,
};
