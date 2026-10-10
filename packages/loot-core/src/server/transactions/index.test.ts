import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as db from '#server/db';

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
      await db.insertAccount({ id: 'closed', name: 'closed' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await db.insertPayee({ id: 'to-two', name: '', transfer_acct: 'two' });
      await db.insertPayee({
        id: 'to-closed',
        name: '',
        transfer_acct: 'closed',
      });
      await db.insertPayee({ id: 'shop', name: 'Shop' });
      await db.insertPayee({ id: 'gone', name: 'Gone' });
      await db.deletePayee({ id: 'gone' });
      // Transfer payees of a deleted account are hidden by `v_payees`
      await db.deleteAccount({ id: 'closed' });

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
            id: 'closed-add',
            account: 'one',
            amount: -5,
            date: '2024-02-01',
            payee: 'to-closed',
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
          id: 'closed-add',
          account: 'one',
          amount: -5,
          payee: 'to-closed',
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

    it('looks payees up in chunks', async () => {
      await db.insertAccount({ id: 'one', name: 'one' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await db.insertPayee({ id: 'shop', name: 'Shop' });
      const lookups = countPayeeLookups();

      const payees = [
        'to-one',
        'shop',
        ...Array.from({ length: 1100 }, (_, i) => `unknown-${i}`),
        null,
      ];
      const transferAccounts = await getTransferAccounts([
        ...payees.map(payee => ({ payee })),
        { payee: 'shop' },
      ]);

      // 1102 distinct payees in chunks of 500
      expect(lookups()).toBe(3);
      expect(transferAccounts.size).toBe(1102);
      expect(transferAccounts.get('to-one')).toBe('one');
      expect(transferAccounts.get('shop')).toBeNull();
      expect(transferAccounts.get('unknown-1099')).toBeNull();
    });
  });
});
