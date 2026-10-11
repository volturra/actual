import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { setSyncingMode } from '#server/sync';

import { batchUpdateTransactions } from './index';

beforeEach(global.emptyDatabase());

describe('batchUpdateTransactions', () => {
  it('returns the added, updated and deleted transactions separately', async () => {
    await db.insertAccount({ id: 'one', name: 'one' });
    await db.insertTransaction({
      id: 'to-update',
      account: 'one',
      amount: 100,
      date: '2024-01-01',
    });
    await db.insertTransaction({
      id: 'to-delete',
      account: 'one',
      amount: 200,
      date: '2024-01-02',
    });

    const result = await batchUpdateTransactions({
      added: [{ id: 'added', account: 'one', amount: 300, date: '2024-01-03' }],
      updated: [{ id: 'to-update', amount: 150 }],
      deleted: [{ id: 'to-delete' }],
      // With transfers enabled the returned updates only carry
      // transfer changes; this test is about the partitioning
      runTransfers: false,
    });

    expect(result.added.map(transaction => transaction.id)).toEqual(['added']);
    expect(result.updated.map(transaction => transaction?.id)).toEqual([
      'to-update',
    ]);
    expect(result.deleted.map(transaction => transaction.id)).toEqual([
      'to-delete',
    ]);
    expect(result.errors).toEqual([]);

    const remaining = await db.all<{ id: string; amount: number }>(
      'SELECT id, amount FROM v_transactions_internal WHERE tombstone = 0 ORDER BY id',
    );
    expect(remaining).toEqual([
      { id: 'added', amount: 300 },
      { id: 'to-update', amount: 150 },
    ]);
  });

  it('does not add any transactions when only editing a field', async () => {
    await db.insertAccount({ id: 'one', name: 'one' });
    await db.insertTransaction({
      id: 't1',
      account: 'one',
      amount: 100,
      date: '2024-01-01',
    });

    const result = await batchUpdateTransactions({
      updated: [{ id: 't1', notes: 'hello' }],
      runTransfers: false,
    });

    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.updated.map(transaction => transaction?.id)).toEqual(['t1']);
    const updated = await db.first<{ notes: string }>(
      'SELECT notes FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(updated?.notes).toBe('hello');
  });

  describe('split parents', () => {
    async function prepareSplit() {
      await db.insertAccount({ id: 'one', name: 'one' });
      await db.insertAccount({ id: 'two', name: 'two' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await db.insertPayee({ id: 'to-two', name: '', transfer_acct: 'two' });
      await db.insertTransaction({
        id: 'parent',
        account: 'one',
        amount: -300,
        date: '2024-01-01',
        is_parent: true,
      });
      await db.insertTransaction({
        id: 'child',
        account: 'one',
        amount: -300,
        date: '2024-01-01',
        is_child: true,
        parent_id: 'parent',
      });
      await db.insertTransaction({
        id: 'plain',
        account: 'one',
        amount: -100,
        date: '2024-01-02',
      });
    }

    function getMessages() {
      return db.all<{ row: string; column: string }>(
        "SELECT row, column FROM messages_crdt WHERE dataset = 'transactions' ORDER BY row, column",
      );
    }

    it('does not rewrite the transfer of a split parent that has none', async () => {
      await prepareSplit();

      // Record the CRDT messages of the batch only
      setSyncingMode('offline');
      let result: Awaited<ReturnType<typeof batchUpdateTransactions>>;
      try {
        result = await batchUpdateTransactions({
          updated: [
            { id: 'parent', notes: 'note' },
            { id: 'plain', notes: 'note' },
          ],
        });
      } finally {
        setSyncingMode('disabled');
      }

      expect(await getMessages()).toEqual([
        { row: 'parent', column: 'notes' },
        { row: 'plain', column: 'notes' },
      ]);
      // The client still gets the parent's (unchanged) transfer state back
      expect(result.updated).toEqual([{ id: 'parent', transfer_id: null }]);
    });

    it('still removes the transfer of a transaction turned into a split parent', async () => {
      await prepareSplit();
      await batchUpdateTransactions({
        updated: [{ id: 'plain', payee: 'to-two' }],
      });
      const { transfer_id: otherSide } = await db.getTransaction('plain');
      expect(otherSide).toBeTruthy();

      const result = await batchUpdateTransactions({
        updated: [{ id: 'plain', is_parent: true }],
      });

      expect(result.updated).toEqual([{ id: 'plain', transfer_id: null }]);
      expect((await db.getTransaction('plain')).transfer_id).toBeNull();
      expect(
        await db.first<{ tombstone: number }>(
          'SELECT tombstone FROM transactions WHERE id = ?',
          [otherSide],
        ),
      ).toEqual({ tombstone: 1 });
    });

    it('undoes and redoes a batch edit that includes a split parent', async () => {
      await prepareSplit();

      await runHandler(handlers['transactions-batch-update'], {
        updated: [
          { id: 'parent', notes: 'note' },
          { id: 'plain', notes: 'note' },
        ],
      });

      const notes = async () =>
        (
          await db.all<{ id: string; notes: string | null }>(
            "SELECT id, notes FROM transactions WHERE id IN ('parent', 'plain') ORDER BY id",
          )
        ).map(row => row.notes);

      expect(await notes()).toEqual(['note', 'note']);
      await runHandler(handlers['undo']);
      expect(await notes()).toEqual([null, null]);
      await runHandler(handlers['redo']);
      expect(await notes()).toEqual(['note', 'note']);
    });
  });
});
