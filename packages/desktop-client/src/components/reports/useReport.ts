import { useEffect, useState } from 'react';

import { useSpreadsheet } from '#hooks/useSpreadsheet';

/**
 * Runs `getData` and returns its results, or null while they load. Pass null
 * as `getData` to hold off loading until the report's inputs are settled.
 */
export function useReport<T>(
  sheetName: string,
  getData:
    | ((
        spreadsheet: ReturnType<typeof useSpreadsheet>,
        setData: (results: T) => void,
      ) => Promise<void>)
    | null,
): T | null {
  const spreadsheet = useSpreadsheet();
  const [results, setResults] = useState<T | null>(null);

  useEffect(() => {
    let didCancel = false;

    // Reset results whenever a new data function is provided so callers
    // can reliably show a loading state instead of stale/partial data.
    setResults(null);

    if (!getData) {
      return;
    }

    void getData(spreadsheet, results => {
      if (!didCancel) {
        setResults(results);
      }
    });

    return () => {
      didCancel = true;
    };
  }, [getData, spreadsheet]);
  return results;
}
