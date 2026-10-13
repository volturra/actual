import { Timestamp } from '@actual-app/crdt';

import * as connection from '#platform/server/connection';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { app as mainApp } from '#server/main-app';
import { runHandler } from '#server/mutators';
import { app as schedulesApp } from '#server/schedules/app';
import { receiveMessages } from '#server/sync';
import type { ServerEvents } from '#types/server-events';

type SyncEvent = ServerEvents['sync-event'];

// The reports dashboard shares in-flight `get-earliest-transaction`,
// `get-latest-transaction` and `make-filters-from-conditions` requests
// (desktop-client `#reports/sharedRequests`). A request made after a write
// must not join one that started before it. The client learns about writes
// only from an applied or successful `sync-event` (and an `undo-event` for
// undo and redo), so every path that can move the earliest or latest
// transaction date must emit one listing the transactions table.

let events: SyncEvent[];
const onSync = (event: SyncEvent) => {
  events.push(event);
};

beforeEach(async () => {
  await global.emptyDatabase()();
  await db.insertAccount({ id: 'acct', name: 'Checking' });
  await db.insertPayee({ id: 'payee', name: 'Shop' });
  events = [];
  mainApp.events.on('sync', onSync);
});

afterEach(() => {
  mainApp.events.off('sync', onSync);
  vi.mocked(connection.send).mockClear();
});

function announcedTransactionChange() {
  return events.some(
    event =>
      (event.type === 'applied' || event.type === 'success') &&
      event.tables.includes('transactions'),
  );
}

async function dateRange() {
  const [earliest, latest] = await Promise.all([
    runHandler(handlers['get-earliest-transaction']),
    runHandler(handlers['get-latest-transaction']),
  ]);
  return { earliest: earliest?.date ?? null, latest: latest?.date ?? null };
}

async function addTransaction(id: string, date: string) {
  await runHandler(handlers['transaction-add'], {
    id,
    account: 'acct',
    amount: -100,
    date,
  });
}

function resetEvents() {
  events = [];
  vi.mocked(connection.send).mockClear();
}

describe('writes that move the transaction date range', () => {
  it('adding a transaction', async () => {
    await addTransaction('t1', '2024-01-15');
    expect(announcedTransactionChange()).toBe(true);
    expect(await dateRange()).toEqual({
      earliest: '2024-01-15',
      latest: '2024-01-15',
    });
  });

  it('editing a transaction date', async () => {
    await addTransaction('t1', '2024-01-15');
    resetEvents();

    await runHandler(handlers['transaction-update'], {
      id: 't1',
      account: 'acct',
      amount: -100,
      date: '2024-03-01',
    });

    expect(announcedTransactionChange()).toBe(true);
    expect(await dateRange()).toEqual({
      earliest: '2024-03-01',
      latest: '2024-03-01',
    });
  });

  it('editing in a batch', async () => {
    await addTransaction('t1', '2024-01-15');
    resetEvents();

    await runHandler(handlers['transactions-batch-update'], {
      updated: [{ id: 't1', date: '2023-12-31' }],
    });

    expect(announcedTransactionChange()).toBe(true);
    expect((await dateRange()).earliest).toBe('2023-12-31');
  });

  it('deleting a transaction', async () => {
    await addTransaction('t1', '2024-01-15');
    await addTransaction('t2', '2024-02-15');
    resetEvents();

    await runHandler(handlers['transaction-delete'], { id: 't2' });

    expect(announcedTransactionChange()).toBe(true);
    expect((await dateRange()).latest).toBe('2024-01-15');
  });

  it('importing transactions', async () => {
    await runHandler(handlers['transactions-import'], {
      accountId: 'acct',
      transactions: [
        { account: 'acct', amount: -100, date: '2024-05-05' },
        { account: 'acct', amount: -200, date: '2022-02-02' },
      ],
      isPreview: false,
    });

    expect(announcedTransactionChange()).toBe(true);
    expect(await dateRange()).toEqual({
      earliest: '2022-02-02',
      latest: '2024-05-05',
    });
  });

  it('applying rule actions', async () => {
    await addTransaction('t1', '2024-01-15');
    const [transaction] = await db.getTransactions('acct');
    resetEvents();

    await runHandler(handlers['rule-apply-actions'], {
      transactions: [transaction],
      actions: [
        {
          op: 'set',
          field: 'date',
          value: '2025-06-01',
          type: 'date',
        },
      ],
    });

    expect(announcedTransactionChange()).toBe(true);
    expect((await dateRange()).latest).toBe('2025-06-01');
  });

  it('posting a schedule', async () => {
    // Tracks where the schedule's account and payee live in its rule.
    schedulesApp.startServices();
    onTestFinished(() => schedulesApp.stopServices());
    const id = await runHandler(handlers['schedule/create'], {
      conditions: [
        { op: 'is', field: 'date', value: '2026-04-10' },
        { op: 'is', field: 'account', value: 'acct' },
        { op: 'is', field: 'payee', value: 'payee' },
        { op: 'is', field: 'amount', value: -500 },
      ],
    });
    resetEvents();

    await runHandler(handlers['schedule/post-transaction'], { id });

    expect(announcedTransactionChange()).toBe(true);
    expect(await dateRange()).toEqual({
      earliest: '2026-04-10',
      latest: '2026-04-10',
    });
  });

  it('a sync from another device', async () => {
    await addTransaction('t1', '2024-01-15');
    resetEvents();

    const timestamp = Timestamp.parse(
      `${new Date(Date.now() + 1000).toISOString()}-0000-0123456789abcdef`,
    );
    if (timestamp == null) throw new Error('bad timestamp');
    await receiveMessages([
      {
        dataset: 'transactions',
        row: 't1',
        column: 'date',
        value: 20200101,
        timestamp,
      },
    ]);

    expect(announcedTransactionChange()).toBe(true);
    expect((await dateRange()).earliest).toBe('2020-01-01');
  });

  it('undo and redo', async () => {
    await runHandler(handlers['transaction-add'], {
      id: 't1',
      account: 'acct',
      amount: -100,
      date: '2024-01-15',
    });
    // `transaction-add` is not undoable on its own; batch updates are.
    await runHandler(handlers['transactions-batch-update'], {
      updated: [{ id: 't1', date: '2024-09-09' }],
    });
    expect((await dateRange()).latest).toBe('2024-09-09');
    resetEvents();

    await runHandler(handlers['undo']);
    expect(announcedTransactionChange()).toBe(true);
    expect(connection.send).toHaveBeenCalledWith(
      'undo-event',
      expect.objectContaining({ tables: ['transactions'] }),
    );
    expect((await dateRange()).latest).toBe('2024-01-15');
    resetEvents();

    await runHandler(handlers['redo']);
    expect(announcedTransactionChange()).toBe(true);
    expect(connection.send).toHaveBeenCalledWith(
      'undo-event',
      expect.objectContaining({ tables: ['transactions'] }),
    );
    expect((await dateRange()).latest).toBe('2024-09-09');
  });
});
