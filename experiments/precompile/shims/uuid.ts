// Deterministic stand-in for the uuid package: real ids are random, which
// would make checksums differ between runs and engines.
let n = 0;
export function v4(): string {
  n++;
  const hex = ('000000000000' + n.toString(16)).slice(-12);
  return '00000000-0000-4000-8000-' + hex;
}
