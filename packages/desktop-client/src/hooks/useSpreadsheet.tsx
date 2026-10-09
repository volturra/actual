import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

import { listen, send } from '@actual-app/core/platform/client/connection';
import type { Query } from '@actual-app/core/shared/query';
import { LRUCache } from 'lru-cache';

type SpreadsheetContextValue = ReturnType<typeof makeSpreadsheet>;
const SpreadsheetContext = createContext<SpreadsheetContextValue | undefined>(
  undefined,
);

export function useSpreadsheet() {
  const context = useContext(SpreadsheetContext);
  if (!context) {
    throw new Error('useSpreadsheet must be used within a SpreadsheetProvider');
  }
  return context;
}

// TODO: Make this generic and replace the Binding type in the desktop-client package.
type Binding = string | { name: string; query?: Query | undefined };

type CellCacheValue = { name: string; value: string | number | boolean | null };
type CellCache = { [name: string]: Promise<CellCacheValue> | null };
type CellObserverCallback = (node: CellCacheValue) => void;
type CellObservers = { [name: string]: CellObserverCallback[] };

const GLOBAL_SHEET_NAME = '__global';

// Most recently seen cell values, used to render a cell's value
// synchronously when it is (re)bound instead of waiting for a `get-cell`
// round-trip. The budget page prewarms several months at once (about 700
// cells per month on a large budget, see `prewarmAllMonths`), so this has
// to hold several thousand entries or the prewarmed values are evicted
// before they are used. An entry is a short name plus a primitive value
// (a few hundred bytes at most), so a full cache stays in the low MBs.
const VALUE_CACHE_SIZE = 10_000;

function resolveBindingName(sheetName: string, binding: Binding): string {
  const name = typeof binding === 'string' ? binding : binding.name;
  return `${sheetName}!${name}`;
}

function makeSpreadsheet() {
  const cellObservers: CellObservers = {};
  const LRUValueCache = new LRUCache<string, CellCacheValue>({
    max: VALUE_CACHE_SIZE,
  });
  const cellCache: CellCache = {};
  let observersDisabled = false;

  class Spreadsheet {
    observeCell(name: string, callback: CellObserverCallback): () => void {
      if (!cellObservers[name]) {
        cellObservers[name] = [];
      }
      cellObservers[name].push(callback);

      return () => {
        cellObservers[name] = cellObservers[name].filter(cb => cb !== callback);

        if (cellObservers[name].length === 0) {
          cellCache[name] = null;
        }
      };
    }

    disableObservers(): void {
      observersDisabled = true;
    }

    enableObservers(): void {
      observersDisabled = false;
    }

    /**
     * Synchronously returns the last known value of a cell, if it is still
     * in the value cache. It can briefly be out of date (e.g. right after
     * switching budgets); `bind` always fetches or receives the current
     * value afterwards.
     */
    getCachedValue(
      sheetName: string = GLOBAL_SHEET_NAME,
      binding: Binding,
    ): CellCacheValue | undefined {
      return LRUValueCache.get(resolveBindingName(sheetName, binding));
    }

    prewarmCache(name: string, value: CellCacheValue): void {
      LRUValueCache.set(name, value);
    }

    listen(): () => void {
      return listen('cells-changed', event => {
        if (!observersDisabled) {
          // TODO: batch react so only renders once
          event.forEach(node => {
            const observers = cellObservers[node.name];
            if (observers) {
              observers.forEach(func => func(node));
              cellCache[node.name] = Promise.resolve(node);
              LRUValueCache.set(node.name, node);
            } else if (LRUValueCache.has(node.name)) {
              // Keep prewarmed values of cells nobody observes right now
              // up to date so they are not rendered stale later.
              LRUValueCache.set(node.name, node);
            }
          });
        }
      });
    }

    bind(
      sheetName: string = GLOBAL_SHEET_NAME,
      binding: Binding,
      callback: CellObserverCallback,
    ): () => void {
      binding = typeof binding === 'string' ? { name: binding } : binding;

      if (binding.query) {
        void this.createQuery(sheetName, binding.name, binding.query);
      }

      const resolvedName = resolveBindingName(sheetName, binding);
      const cleanup = this.observeCell(resolvedName, callback);

      // Always synchronously call with the existing value if it has one.
      // This is a display optimization to avoid flicker. The LRU cache
      // will keep a number of recent nodes in memory.
      if (LRUValueCache.has(resolvedName)) {
        const node = LRUValueCache.get(resolvedName);
        if (node) {
          callback(node);
        }
      }

      if (cellCache[resolvedName] != null) {
        void cellCache[resolvedName].then(callback);
      } else {
        const req = this.get(sheetName, binding.name);
        cellCache[resolvedName] = req;

        void req.then(result => {
          // We only want to call the callback if it's still waiting on
          // the same request. If we've received a `cells-changed` event
          // for this already then it's already been called and we don't
          // need to call it again (and potentially could be calling it
          // with an old value depending on the order of messages)
          if (cellCache[resolvedName] === req) {
            LRUValueCache.set(resolvedName, result);
            callback(result);
          }
        });
      }

      return cleanup;
    }

    get(sheetName: string, name: string) {
      return send('get-cell', { sheetName, name });
    }

    getCellNames(sheetName: string) {
      return send('get-cell-names', { sheetName });
    }

    createQuery(sheetName: string, name: string, query: Query) {
      return send('create-query', {
        sheetName,
        name,
        query: query.serialize(),
      });
    }
  }

  return new Spreadsheet();
}

type SpreadsheetProviderProps = {
  children: ReactNode;
};

export function SpreadsheetProvider({ children }: SpreadsheetProviderProps) {
  const spreadsheet = useMemo(() => makeSpreadsheet(), []);

  useEffect(() => {
    return spreadsheet.listen();
  }, [spreadsheet]);

  return (
    <SpreadsheetContext.Provider value={spreadsheet}>
      {children}
    </SpreadsheetContext.Provider>
  );
}
