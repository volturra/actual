// @ts-strict-ignore
import mitt from 'mitt';

import { logger } from '#platform/server/log';
import {
  aqlCompiledQuery,
  compileQuery,
  schema,
  schemaConfig,
} from '#server/aql';
import type { BudgetType } from '#server/prefs';
import type { QueryState } from '#shared/query';

import { Graph } from './graph-data-structure';
import { resolveName, unresolveName } from './util';

export type Node = {
  name: string;
  expr: string | number | boolean;
  value: string | number | boolean;
  sheet: unknown;
  query?: QueryState;
  /** `query` serialized, to recognise the same query being sent again */
  queryKey?: string;
  sql?: { sqlPieces: unknown; state: { dependencies: unknown[] } };
  dynamic?: boolean;
  _run?: unknown;
  _dependencies?: string[];
};

/**
 * Run `callback` once pending requests and messages have had a turn. Unlike a
 * chain of `setTimeout(0)` calls, this isn't clamped to 4ms per call by
 * browsers, nor throttled in hidden tabs. Returns a function that cancels it.
 */
function yieldToOtherTasks(callback: () => void): () => void {
  if (typeof globalThis.setImmediate === 'function') {
    const handle = globalThis.setImmediate(callback);
    return () => globalThis.clearImmediate(handle);
  }

  if (typeof globalThis.MessageChannel === 'function') {
    let cancelled = false;
    const channel = new globalThis.MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      if (!cancelled) {
        callback();
      }
    };
    channel.port2.postMessage(null);
    return () => {
      cancelled = true;
      channel.port1.close();
    };
  }

  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

/**
 * How long the backend has to stay idle before the cells computed while the
 * stored cache is marked dirty are written to it (see `pendingCacheNames`).
 */
const CACHE_SAVE_DELAY_MS = 1000;

type WriteCache = (
  nodes: Map<string, Node>,
  names: string[],
  options: { markClean: boolean },
) => void;

export class Spreadsheet {
  _meta: {
    createdMonths: Set<string>;
    budgetType: BudgetType;
  };
  cacheBarrier;
  computeQueue;
  dirtyCells;
  events;
  graph;
  nodes: Map<string, Node>;
  running;
  // While query cells are being recomputed, the worker gives other requests
  // a turn between them. This holds the pending resume while it does.
  pausedComputation: {
    idx: number;
    cancel: () => void;
  } | null;
  // Query cells in `computeQueue` that haven't started computing yet
  pendingQueries: Set<string>;
  // Whether this run queued any cell that isn't a query cell
  queuedOtherCells: boolean;
  // Whether cells were queued after this run started
  extended: boolean;
  // Total number of queued cells that finished (or were dropped) so far,
  // across runs. `onFinish` uses it to wait for the cells queued before it.
  computedCount: number;
  // Set once the sheet is closed; any query cells still to run are dropped
  unloaded: boolean;
  saveCache;
  setCacheStatus;
  // Writes cells to the cache and optionally marks it clean, in one
  // transaction. Throws if that fails. Without it every run saves its cells
  // right away.
  writeCache: WriteCache | null;
  // Set once this sheet marked the stored cache dirty, cleared once it marks
  // it clean again. Only ever true while the stored cache is marked dirty
  // (nothing else marks it clean), which is what makes it safe to skip the
  // dirty write and to put off saving computed cells while it's set.
  cacheMarkedDirty: boolean;
  // Cells computed since the stored cache was marked dirty that aren't
  // written to it yet. The cache isn't marked clean while there are any.
  pendingCacheNames: Set<string>;
  cacheSaveTimer: ReturnType<typeof setTimeout> | null;
  transactionDepth;

  constructor(
    saveCache?: unknown,
    setCacheStatus?: unknown,
    writeCache?: WriteCache,
  ) {
    // @ts-expect-error Graph should be converted to class
    this.graph = new Graph();
    this.nodes = new Map<string, Node>();
    this.transactionDepth = 0;
    this.saveCache = saveCache;
    this.setCacheStatus = setCacheStatus;
    this.writeCache = writeCache ?? null;
    this.cacheMarkedDirty = false;
    this.pendingCacheNames = new Set();
    this.cacheSaveTimer = null;
    this.dirtyCells = [];
    this.computeQueue = [];
    this.pausedComputation = null;
    this.pendingQueries = new Set();
    this.queuedOtherCells = false;
    this.extended = false;
    this.computedCount = 0;
    this.unloaded = false;
    this.events = mitt();
    this._meta = {
      createdMonths: new Set(),
      budgetType: 'envelope',
    };
  }

  meta() {
    return this._meta;
  }

  setMeta(meta) {
    this._meta = meta;
  }

  // Spreadsheet interface

  _getNode(name: string): Node {
    const { sheet } = unresolveName(name);

    if (!this.nodes.has(name)) {
      this.nodes.set(name, {
        name,
        expr: null,
        value: null,
        sheet,
      });
    }
    return this.nodes.get(name);
  }

  getNode(name) {
    return this._getNode(name);
  }

  hasCell(name) {
    return this.nodes.has(name);
  }

  add(name, expr) {
    this.set(name, expr);
  }

  getNodes() {
    return this.nodes;
  }

  serialize() {
    return {
      graph: this.graph.getEdges(),
      nodes: [...this.nodes.entries()],
    };
  }

  transaction(func) {
    this.startTransaction();
    try {
      func();
    } catch (e) {
      logger.log(e);
    }
    return this.endTransaction();
  }

  startTransaction() {
    this.transactionDepth++;
  }

  endTransaction() {
    this.transactionDepth--;

    if (this.transactionDepth === 0) {
      const cells = this.dirtyCells;
      this.dirtyCells = [];

      this.queueComputation(this.graph.topologicalSort(cells));
    }

    return [];
  }

  queueComputation(cellNames) {
    // TODO: Formally write out the different cases when the existing
    // queue is not empty. There should be cases where we can easily
    // optimize this by skipping computations if we know they are
    // going to be computed again. The hard thing is to ensure that
    // the order of computations stays correct

    // A query cell that is still waiting to run is computed against the
    // latest data anyway, so don't queue it twice. Nothing in the sheet
    // depends on query cells, so this doesn't change the order of anything.
    // A query cell that is computing (or done) may have read stale data, so
    // queue it again.
    const added = cellNames.filter(name => {
      if (this.getNode(name).sql == null) {
        this.queuedOtherCells = true;
        return true;
      }
      if (this.pendingQueries.has(name)) {
        return false;
      }
      this.pendingQueries.add(name);
      return true;
    });
    if (this.running && added.length > 0) {
      this.extended = true;
    }
    this.computeQueue = this.computeQueue.concat(added);

    // Begin running on the next tick so we guarantee that it doesn't finish
    // within the same tick. Since some computations are async, this makes it
    // consistent (otherwise it would only sometimes finish sync)
    void Promise.resolve().then(() => {
      if (!this.running) {
        this.runComputations();
      } else if (this.pausedComputation && !this.onlyQueriesQueued()) {
        // Other cells were queued while query cells were giving way. Compute
        // them now, before any other request runs, like an idle sheet would.
        this.resumeComputations();
      }
    });
  }

  /**
   * Whether this run computes nothing but query cells. Nothing in the sheet
   * depends on query cells (only the client binds them) and they aren't
   * cached, so other requests can run in between them without seeing a
   * half-updated sheet or a stale cache.
   */
  onlyQueriesQueued(): boolean {
    return !this.queuedOtherCells;
  }

  /**
   * Continue with the cell at `idx` after an SQL query cell finished. Each
   * query cell can take a while (a full scan of transactions), and computing
   * them all in one go blocks every other request, so let pending requests
   * through first when that is safe.
   */
  continueAfterQuery(idx: number): void {
    if (idx < this.computeQueue.length && this.onlyQueriesQueued()) {
      if (this.unloaded) {
        // The query that just finished was in flight when the sheet was
        // closed. Don't run the rest against whatever database is open now.
        this.stopComputations();
        return;
      }
      if (this.extended) {
        // Report what's done so far, so data that keeps changing while the
        // run gives way can't hold off `change` forever
        const names = this.computeQueue.slice(0, idx);
        this.computeQueue = this.computeQueue.slice(idx);
        this.computedCount += names.length;
        this.extended = false;
        idx = 0;
        this.events.emit('change', { names });
      }
      this.pausedComputation = {
        idx,
        cancel: yieldToOtherTasks(() => this.resumeComputations()),
      };
    } else {
      this.runComputations(idx);
    }
  }

  resumeComputations(): void {
    const paused = this.pausedComputation;
    if (paused) {
      paused.cancel();
      this.pausedComputation = null;
      this.runComputations(paused.idx);
    }
  }

  stopComputations(): void {
    if (this.pausedComputation) {
      this.pausedComputation.cancel();
      this.pausedComputation = null;
    }
    this.clearQueue();
  }

  clearQueue(): void {
    this.computedCount += this.computeQueue.length;
    this.running = false;
    this.computeQueue = [];
    this.pendingQueries.clear();
    this.queuedOtherCells = false;
    this.extended = false;
  }

  runComputations(idx = 0) {
    if (this.unloaded) {
      // The sheet was closed while this run was going. Don't compute the
      // rest against whatever database is open now.
      this.stopComputations();
      return;
    }

    this.running = true;

    while (idx < this.computeQueue.length) {
      const name = this.computeQueue[idx];
      this.pendingQueries.delete(name);
      let node;
      let result;

      try {
        node = this.getNode(name);

        if (node._run) {
          const args = node._dependencies.map(dep => {
            return this.getNode(dep).value;
          });

          result = node._run(...args);

          if (result instanceof Promise) {
            logger.warn(
              `dynamic cell ${name} returned a promise! this is discouraged because errors are not handled properly`,
            );
          }
        } else if (node.sql) {
          result = aqlCompiledQuery(
            node.query,
            node.sql.sqlPieces,
            node.sql.state,
          );
        } else {
          idx++;
          continue;
        }
      } catch (e) {
        logger.log('Error while evaluating ' + name + ':', e);
        // If an error happens, bail on the rest of the computations. The
        // cells computed so far have new values, so still notify about them
        // (`createQuery` no longer reruns an unchanged query to heal them).
        const computed = this.computeQueue.slice(0, idx);
        // Forget the query of every cell left uncomputed so the next
        // `createQuery` for it runs it again.
        for (const skipped of this.computeQueue.slice(idx)) {
          const skippedNode = this.nodes.get(skipped);
          if (skippedNode) {
            skippedNode.queryKey = undefined;
          }
        }
        // Clear the queue before notifying: `onFinish` listeners check
        // `computedCount`, which `clearQueue` brings up to date
        this.clearQueue();
        if (this.isCacheSaveDeferred()) {
          // These cells have new values too, so they must be saved before
          // the cache is marked clean
          this.deferCacheSave(computed);
        }
        if (computed.length > 0) {
          this.events.emit('change', { names: computed });
        }
        return;
      }

      if (result instanceof Promise) {
        // When the cell is finished computing, finish computing the
        // rest
        result.then(
          value => {
            node.value = value;
            if (node.sql) {
              this.continueAfterQuery(idx + 1);
            } else {
              this.runComputations(idx + 1);
            }
          },
          err => {
            // TODO: use captureException here
            logger.warn(`Failed running ${node.name}!`, err);
            // Let the next `createQuery` for this cell try again
            node.queryKey = undefined;
            if (node.sql) {
              this.continueAfterQuery(idx + 1);
            } else {
              this.runComputations(idx + 1);
            }
          },
        );

        return;
      } else {
        node.value = result;
      }

      idx++;
    }

    // If everything computed in one loop (no async operations) notify
    // the user and empty the queue
    if (idx === this.computeQueue.length) {
      const names = this.computeQueue;
      this.computedCount += names.length;
      this.computeQueue = [];
      this.events.emit('change', { names });

      // Cache the updated cells
      if (this.isCacheSaveDeferred()) {
        this.deferCacheSave(names);
      } else {
        this.saveCachedCells(names);
        this.markCacheSafe();
      }

      this.clearQueue();
    }
  }

  saveCachedCells(names: string[]): void {
    if (typeof this.saveCache === 'function') {
      this.saveCache(names);
    }
  }

  markCacheSafe() {
    if (!this.cacheBarrier) {
      if (this.pendingCacheNames.size > 0) {
        // Cells computed since the cache was marked dirty aren't saved yet.
        // They're saved together with the clean marker once idle.
        this.scheduleCacheSave();
        return;
      }
      if (this.setCacheStatus) {
        this.setCacheStatus({ clean: true });
        this.cacheMarkedDirty = false;
      }
    }
  }

  /**
   * Mark the stored cache as not to be trusted, e.g. after data was changed
   * without going through the sheet. The cache stays dirty until a later
   * computation or cache barrier finishes.
   */
  markCacheDirty() {
    this.writeCacheDirty();
    if (this.pendingCacheNames.size > 0) {
      // Otherwise saving them, once idle or when closing, would mark the
      // cache clean right away. Write them now without marking it clean.
      try {
        this.writeCache(this.nodes, [...this.pendingCacheNames], {
          markClean: false,
        });
        this.pendingCacheNames.clear();
      } catch (e) {
        // Keep them pending and stop saving, so this sheet never marks the
        // cache clean again
        logger.warn('Failed saving the spreadsheet cache', e);
        this.writeCache = null;
      }
    }
  }

  writeCacheDirty() {
    if (this.setCacheStatus) {
      this.setCacheStatus({ clean: false });
      // Only after the write succeeded
      this.cacheMarkedDirty = true;
    }
  }

  /**
   * Whether cells computed now can be saved later: the stored cache is
   * already marked dirty, so until they are saved (with the clean marker, in
   * one transaction) loading the budget recomputes everything anyway.
   */
  isCacheSaveDeferred(): boolean {
    return this.cacheMarkedDirty && this.writeCache != null && !this.unloaded;
  }

  deferCacheSave(names: string[]): void {
    for (const name of names) {
      this.pendingCacheNames.add(name);
    }
    this.scheduleCacheSave();
  }

  scheduleCacheSave(): void {
    if (this.unloaded || this.writeCache == null) {
      return;
    }
    if (this.cacheSaveTimer !== null) {
      clearTimeout(this.cacheSaveTimer);
    }
    const timer = setTimeout(() => {
      this.cacheSaveTimer = null;
      if (this.unloaded) {
        return;
      }
      if (
        this.running ||
        this.computeQueue.length > 0 ||
        this.cacheBarrier ||
        this.transactionDepth > 0
      ) {
        // Still computing or changing data, so wait until that's done
        this.scheduleCacheSave();
        return;
      }
      this.flushCacheSave();
    }, CACHE_SAVE_DELAY_MS);
    // Don't keep a Node process (e.g. an API script) alive just for this; if
    // it exits first the cache just stays dirty
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      timer.unref();
    }
    this.cacheSaveTimer = timer;
  }

  /**
   * Save the cells computed since the cache was marked dirty and mark it
   * clean, in one transaction. Only call this when no cell other than a
   * query cell is computing or queued, so the sheet is consistent with the
   * data.
   */
  flushCacheSave(): void {
    if (
      this.pendingCacheNames.size === 0 ||
      this.cacheBarrier ||
      this.writeCache == null
    ) {
      return;
    }
    const names = [...this.pendingCacheNames];
    try {
      this.writeCache(this.nodes, names, { markClean: true });
    } catch (e) {
      // Nothing was written, so the stored cache is still marked dirty. Keep
      // the cells pending so it isn't marked clean without them.
      logger.warn('Failed saving the spreadsheet cache', e);
      return;
    }
    this.pendingCacheNames.clear();
    this.cacheMarkedDirty = false;
  }

  startCacheBarrier() {
    this.cacheBarrier = true;
    if (!this.cacheMarkedDirty) {
      // Otherwise it's already marked dirty, and nothing marks it clean
      // while the barrier is up
      this.writeCacheDirty();
    }
  }

  endCacheBarrier() {
    this.cacheBarrier = false;

    const pendingChange = this.running || this.computeQueue.length > 0;
    if (!pendingChange) {
      this.markCacheSafe();
    }
  }

  addEventListener(name, func) {
    this.events.on(name, func);
    return () => this.events.off(name, func);
  }

  onFinish(func) {
    if (this.transactionDepth !== 0) {
      throw new Error(
        'onFinish called while inside a spreadsheet transaction. This is not allowed as it will lead to race conditions',
      );
    }

    if (!this.running && this.computeQueue.length === 0) {
      func([]);
      return () => {
        // The remove function does nothing
      };
    }

    // Wait for the cells queued so far. A run that gives way between query
    // cells can report them in several `change`s.
    const target = this.computedCount + this.computeQueue.length;
    const remove = this.addEventListener('change', (...args) => {
      if (this.computedCount < target) {
        return;
      }
      remove();
      return func(...args);
    });
    return remove;
  }

  unload() {
    if (this.cacheSaveTimer !== null) {
      clearTimeout(this.cacheSaveTimer);
      this.cacheSaveTimer = null;
    }
    const pendingChange = this.running || this.computeQueue.length > 0;
    if (!pendingChange || this.onlyQueriesQueued()) {
      if (this.pendingCacheNames.size > 0) {
        // Save the cells still waiting to be saved now, while the database
        // is open. Query cells aren't cached, so ones still left to run
        // don't matter. Under a cache barrier (or mid-transaction) nothing
        // is saved and the cache stays dirty.
        if (this.transactionDepth === 0) {
          this.flushCacheSave();
        }
      } else if (pendingChange) {
        // Query cells aren't cached, so the cache is up to date even though
        // they'll never finish. Mark it as such, as finishing the run would.
        this.markCacheSafe();
      }
    }
    this.unloaded = true;
    // Only query cells are left, so there is nothing to cache or notify
    if (this.pausedComputation) {
      this.stopComputations();
    }
    this.events.all.clear();
  }

  getValue(name) {
    return this.getNode(name).value;
  }

  getExpr(name) {
    return this.getNode(name).expr;
  }

  getCellValue(sheet, name) {
    return this.getNode(resolveName(sheet, name)).value;
  }

  getCellExpr(sheet, name) {
    return this.getNode(resolveName(sheet, name)).expr;
  }

  getCellValueLoose(sheetName, cellName) {
    const name = resolveName(sheetName, cellName);
    if (this.nodes.has(name)) {
      return this.getNode(name).value;
    }
    return null;
  }

  bootup(onReady) {
    this.onFinish(() => {
      onReady();
    });
  }

  load(name: string, value: string | number | boolean): void {
    const node = this._getNode(name);
    node.expr = value;
    node.value = value;
  }

  create(name: string, value: string | number | boolean) {
    return this.transaction(() => {
      const node = this._getNode(name);
      node.expr = value;
      node.value = value;
      this._markDirty(name);
    });
  }

  set(name: string, value: string | number | boolean): void {
    this.create(name, value);
  }

  recompute(name: string): void {
    this.transaction(() => {
      this.dirtyCells.push(name);
    });
  }

  recomputeAll(): void {
    // Recompute everything!
    this.transaction(() => {
      this.dirtyCells = [...this.nodes.keys()];
    });
  }

  createQuery(sheetName: string, cellName: string, query: QueryState): void {
    const name = resolveName(sheetName, cellName);
    const node = this._getNode(name);
    // Every component binding the cell sends its query again, as a new
    // object. The cell's value already stays up to date through
    // `triggerDatabaseChanges`, so only a different query needs a rerun.
    const queryKey = JSON.stringify(query);

    if (node.queryKey !== queryKey) {
      // Compile before touching the node, so a query that fails to compile
      // leaves the previous query, its SQL and its key consistent
      const { sqlPieces, state } = compileQuery(query, schema, schemaConfig);
      node.query = query;
      node.sql = { sqlPieces, state };
      node.queryKey = queryKey;

      this.transaction(() => {
        this._markDirty(name);
      });
    }
  }

  createStatic(
    sheetName: string,
    cellName: string,
    initialValue: number | boolean,
  ): void {
    const name = resolveName(sheetName, cellName);
    const exists = this.nodes.has(name);
    if (!exists) {
      this.create(name, initialValue);
    }
  }

  createDynamic(
    sheetName: string,
    cellName: string,
    {
      dependencies = [],
      run,
      initialValue,
      refresh = false,
    }: {
      dependencies?: string[];
      run?: unknown;
      initialValue: number | boolean;
      refresh?: boolean;
    },
  ): void {
    const name = resolveName(sheetName, cellName);
    const node = this._getNode(name);

    if (node.dynamic) {
      // If it already exists, do nothing
      return;
    }

    node.dynamic = true;
    node._run = run;

    dependencies = dependencies.map(dep => {
      let resolved;
      if (!unresolveName(dep).sheet) {
        resolved = resolveName(sheetName, dep);
      } else {
        resolved = dep;
      }

      return resolved;
    });

    node._dependencies = dependencies;

    // TODO: diff these
    this.graph.removeIncomingEdges(name);
    dependencies.forEach(dep => {
      this.graph.addEdge(dep, name);
    });

    if (node.value == null || refresh) {
      this.transaction(() => {
        node.value = initialValue;
        this._markDirty(name);
      });
    }
  }

  clearSheet(sheetName: string): void {
    for (const [name, node] of this.nodes.entries()) {
      if (node.sheet === sheetName) {
        this.nodes.delete(name);
      }
    }
  }

  voidCell(sheetName: string, name: string, voidValue = null): void {
    const node = this.getNode(resolveName(sheetName, name));
    node._run = null;
    node.dynamic = false;
    node.value = voidValue;
  }

  deleteCell(sheetName: string, name: string): void {
    this.voidCell(sheetName, name);
    this.nodes.delete(resolveName(sheetName, name));
  }

  addDependencies(sheetName: string, cellName: string, deps: string[]): void {
    const name = resolveName(sheetName, cellName);

    deps = deps.map(dep => {
      if (!unresolveName(dep).sheet) {
        return resolveName(sheetName, dep);
      }
      return dep;
    });

    const node = this.getNode(name);
    const newDeps = deps.filter(
      dep => (node._dependencies || []).indexOf(dep) === -1,
    );

    if (newDeps.length > 0) {
      node._dependencies = (node._dependencies || []).concat(newDeps);
      newDeps.forEach(dep => {
        this.graph.addEdge(dep, name);
      });
      this.recompute(name);
    }
  }

  removeDependencies(
    sheetName: string,
    cellName: string,
    deps: string[],
  ): void {
    const name = resolveName(sheetName, cellName);

    deps = deps.map(dep => {
      if (!unresolveName(dep).sheet) {
        return resolveName(sheetName, dep);
      }
      return dep;
    });

    const node = this.getNode(name);

    node._dependencies = (node._dependencies || []).filter(
      dep => deps.indexOf(dep) === -1,
    );

    deps.forEach(dep => {
      this.graph.removeEdge(dep, name);
    });
    this.recompute(name);
  }

  _markDirty(name) {
    this.dirtyCells.push(name);
  }

  triggerDatabaseChanges(oldValues, newValues) {
    const tables = new Set([...oldValues.keys(), ...newValues.keys()]);

    this.startTransaction();
    // TODO: Create an index of deps so we don't have to iterate
    // across all nodes
    this.nodes.forEach(node => {
      if (
        node.sql &&
        node.sql.state.dependencies.some(dep => tables.has(dep))
      ) {
        this._markDirty(node.name);
      }
    });
    this.endTransaction();
  }
}
