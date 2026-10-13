import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { batchMessages, setSyncingMode } from '#server/sync';

import { getTransferAccounts } from './transfer';

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

  describe('transfer payee lookup', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function countPayeeLookups() {
      const isPayeeLookup = (sql: string) => sql.includes('FROM v_payees');
      const first = vi.spyOn(db, 'first');
      const all = vi.spyOn(db, 'all');
      return () =>
        [...first.mock.calls, ...all.mock.calls].filter(([sql]) =>
          isPayeeLookup(sql),
        ).length;
    }

    async function prepare() {
      await db.insertAccount({ id: 'one', name: 'one' });
      await db.insertAccount({ id: 'two', name: 'two' });
      await db.insertAccount({ id: 'deleted', name: 'deleted' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await db.insertPayee({ id: 'to-two', name: '', transfer_acct: 'two' });
      await db.insertPayee({
        id: 'to-deleted',
        name: '',
        transfer_acct: 'deleted',
      });
      await db.insertPayee({ id: 'shop', name: 'Shop' });
      await db.insertPayee({ id: 'gone', name: 'Gone' });
      await db.deletePayee({ id: 'gone' });
      // Transfer payees of a deleted account are hidden by `v_payees`
      await db.deleteAccount({ id: 'deleted' });

      await db.insertTransaction({
        id: 'was-transfer',
        account: 'one',
        amount: -10,
        date: '2024-01-01',
      });
      await batchUpdateTransactions({
        updated: [{ id: 'was-transfer', payee: 'to-two' }],
      });
      await db.insertTransaction({
        id: 'becomes-transfer',
        account: 'one',
        amount: -20,
        date: '2024-01-02',
        payee: 'shop',
      });
    }

    function getTransactions() {
      return db.all<{
        id: string;
        account: string;
        amount: number;
        payee: string | null;
        has_transfer: number;
        tombstone: number;
      }>(
        `SELECT id, account, amount, payee, tombstone,
                transfer_id IS NOT NULL AS has_transfer
           FROM v_transactions_internal
          WHERE account = 'one'
          ORDER BY id`,
      );
    }

    it('handles every kind of payee in a mixed batch with one lookup', async () => {
      await prepare();
      const lookups = countPayeeLookups();

      const result = await batchUpdateTransactions({
        added: [
          {
            id: 'to-two-add',
            account: 'one',
            amount: -1,
            date: '2024-02-01',
            payee: 'to-two',
          },
          {
            id: 'shop-add',
            account: 'one',
            amount: -2,
            date: '2024-02-01',
            payee: 'shop',
          },
          {
            id: 'none-add',
            account: 'one',
            amount: -3,
            date: '2024-02-01',
            payee: null,
          },
          {
            id: 'gone-add',
            account: 'one',
            amount: -4,
            date: '2024-02-01',
            payee: 'gone',
          },
          {
            id: 'deleted-add',
            account: 'one',
            amount: -5,
            date: '2024-02-01',
            payee: 'to-deleted',
          },
        ],
        updated: [
          { id: 'was-transfer', payee: 'shop' },
          { id: 'becomes-transfer', payee: 'to-two' },
        ],
      });

      expect(lookups()).toBe(1);
      expect(
        result.updated.map(update => ({
          id: update?.id,
          has_transfer: Boolean(
            update && 'transfer_id' in update && update.transfer_id,
          ),
        })),
      ).toEqual([
        { id: 'was-transfer', has_transfer: false },
        { id: 'becomes-transfer', has_transfer: true },
      ]);
      // Only the transactions with a transfer payee of an open account
      // get (or keep) a transfer; the old transfer of `was-transfer` is
      // removed
      expect(await getTransactions()).toEqual([
        {
          id: 'becomes-transfer',
          account: 'one',
          amount: -20,
          payee: 'to-two',
          has_transfer: 1,
          tombstone: 0,
        },
        {
          id: 'deleted-add',
          account: 'one',
          amount: -5,
          payee: 'to-deleted',
          has_transfer: 0,
          tombstone: 0,
        },
        {
          id: 'gone-add',
          account: 'one',
          amount: -4,
          payee: 'gone',
          has_transfer: 0,
          tombstone: 0,
        },
        {
          id: 'none-add',
          account: 'one',
          amount: -3,
          payee: null,
          has_transfer: 0,
          tombstone: 0,
        },
        {
          id: 'shop-add',
          account: 'one',
          amount: -2,
          payee: 'shop',
          has_transfer: 0,
          tombstone: 0,
        },
        {
          id: 'to-two-add',
          account: 'one',
          amount: -1,
          payee: 'to-two',
          has_transfer: 1,
          tombstone: 0,
        },
        {
          id: 'was-transfer',
          account: 'one',
          amount: -10,
          payee: 'shop',
          has_transfer: 0,
          tombstone: 0,
        },
      ]);
      // ...and the other sides of the transfers in account two
      expect(
        await db.all<{ amount: number; payee: string; tombstone: number }>(
          "SELECT amount, payee, tombstone FROM v_transactions_internal WHERE account = 'two' ORDER BY amount",
        ),
      ).toEqual([
        { amount: 1, payee: 'to-one', tombstone: 0 },
        { amount: 10, payee: 'to-one', tombstone: 1 },
        { amount: 20, payee: 'to-one', tombstone: 0 },
      ]);
    });

    it('removes transfers in a delete-only batch without a lookup', async () => {
      await prepare();
      const lookups = countPayeeLookups();

      await batchUpdateTransactions({ deleted: [{ id: 'was-transfer' }] });

      expect(lookups()).toBe(0);
      expect(
        await db.all<{ amount: number; tombstone: number }>(
          "SELECT amount, tombstone FROM v_transactions_internal WHERE account = 'two' ORDER BY amount",
        ),
      ).toEqual([{ amount: 10, tombstone: 1 }]);
    });

    it('maps every payee to the account the single-payee lookup gives', async () => {
      // The single-payee lookup getTransferredAccount falls back to
      const lookUpOne = async (payee: string) =>
        (
          await db.first<{ transfer_acct: string | null }>(
            'SELECT transfer_acct FROM v_payees WHERE id = ?',
            [payee],
          )
        )?.transfer_acct || null;
      const compare = async (payees: string[]) => {
        const transferAccounts = await getTransferAccounts();
        for (const payee of payees) {
          expect({
            payee,
            account: transferAccounts.get(payee) ?? null,
          }).toEqual({ payee, account: await lookUpOne(payee) });
        }
        return transferAccounts;
      };

      await db.insertAccount({ id: 'open', name: 'open' });
      await db.insertAccount({ id: 'closed', name: 'closed', closed: 1 });
      await db.insertAccount({ id: 'deleted', name: 'deleted' });
      await db.insertPayee({ id: 'to-open', name: '', transfer_acct: 'open' });
      await db.insertPayee({
        id: 'to-closed',
        name: '',
        transfer_acct: 'closed',
      });
      await db.insertPayee({
        id: 'to-deleted',
        name: '',
        transfer_acct: 'deleted',
      });
      await db.deleteAccount({ id: 'deleted' });
      await db.insertAccount({ id: 'other', name: 'other' });
      await db.insertPayee({
        id: 'to-other-gone',
        name: '',
        transfer_acct: 'other',
      });
      // `deletePayee` refuses transfer payees, so tombstone it directly
      db.runQuery('UPDATE payees SET tombstone = 1 WHERE id = ?', [
        'to-other-gone',
      ]);
      await db.insertPayee({ id: 'shop', name: 'Shop' });
      await db.insertPayee({ id: 'gone', name: 'Gone' });
      await db.deletePayee({ id: 'gone' });

      const payees = [
        'to-open',
        'to-closed',
        'to-deleted',
        'to-other-gone',
        'shop',
        'gone',
        'unknown',
        'new-transfer',
        'new-shop',
      ];
      const transferAccounts = await compare(payees);
      expect(Object.fromEntries(transferAccounts)).toEqual({
        'to-open': 'open',
        'to-closed': 'closed',
        'to-other-gone': 'other',
      });

      // Payees created earlier in the same batch
      await batchMessages(async () => {
        await db.insertAccount({ id: 'new', name: 'new' });
        await db.insertPayee({
          id: 'new-transfer',
          name: '',
          transfer_acct: 'new',
        });
        await db.insertPayee({ id: 'new-shop', name: 'New shop' });
        await compare(payees);
      });
      expect((await compare(payees)).get('new-transfer')).toBe('new');
    });
  });
});
