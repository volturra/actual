import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as connection from '#platform/server/connection';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { batchMessages, setSyncingMode } from '#server/sync';
import type { TransactionEntity } from '#types/models';
import type { ServerEvents } from '#types/server-events';

import { getTransferAccounts } from './transfer';

import {
  batchUpdateTransactions,
  categorizeRelatedTransactions,
} from './index';

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

  describe('related payees', () => {
    afterEach(() => {
      vi.mocked(connection.send).mockClear();
    });

    async function prepare() {
      await db.insertAccount({ id: 'one', name: 'one' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await db.insertPayee({ id: 'amzn', name: 'AMZN MKTP US' });
      await db.insertPayee({ id: 'amzn-2', name: 'AMZN Digital' });
      await db.insertPayee({ id: 'amazon', name: 'Amazon' });
      await db.insertPayee({ id: 'other', name: 'Other' });
      for (const [id, payee] of [
        ['a1', 'amzn'],
        ['a2', 'amzn'],
        ['a3', 'amzn'],
        ['b1', 'amzn-2'],
        ['b2', 'amzn-2'],
        ['lonely', 'other'],
      ]) {
        await db.insertTransaction({
          id,
          account: 'one',
          amount: -10,
          date: '2024-01-01',
          payee,
        });
      }
      vi.mocked(connection.send).mockClear();
    }

    function relatedPayeesEvents() {
      return vi
        .mocked(connection.send)
        .mock.calls.filter(([name]) => name === 'related-payees')
        .map(([, args]) => args as ServerEvents['related-payees']);
    }

    it('offers to rename the rest of the old payee transactions', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([
        {
          payee: { id: 'amzn', name: 'AMZN MKTP US', transactionCount: 2 },
          targetPayee: { id: 'amazon', name: 'Amazon' },
        },
      ]);
    });

    it('counts the transactions of payees merged into the old payee', async () => {
      await prepare();
      // `amzn-2` lives on as `amzn` through the payee mapping
      await db.mergePayees('amzn', ['amzn-2']);

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([
        {
          payee: { id: 'amzn', name: 'AMZN MKTP US', transactionCount: 4 },
          targetPayee: { id: 'amazon', name: 'Amazon' },
        },
      ]);
    });

    it('does not count deleted transactions', async () => {
      await prepare();
      await db.deleteTransaction({ id: 'a2' });

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()[0].payee.transactionCount).toBe(1);
    });

    async function insertSplit(
      id: string,
      lines: number,
      { tombstone = false }: { tombstone?: boolean } = {},
    ) {
      await db.insertTransaction({
        id,
        account: 'one',
        amount: -10 * lines,
        date: '2024-01-01',
        payee: 'amzn',
        is_parent: true,
      });
      for (let line = 0; line < lines; line++) {
        await db.insertTransaction({
          id: `${id}-${line}`,
          account: 'one',
          amount: -10,
          date: '2024-01-01',
          payee: 'amzn',
          is_child: true,
          parent_id: id,
        });
      }
      if (tombstone) {
        // Delete only the split itself, as a partial sync could leave it
        await db.update('transactions', { id, tombstone: 1 });
      }
    }

    it('counts a split once and leaves out lines of a deleted split', async () => {
      await prepare();
      await insertSplit('split', 3);
      await insertSplit('deleted-split', 2, { tombstone: true });

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      // a2, a3 and the split
      expect(relatedPayeesEvents()[0].payee.transactionCount).toBe(3);
    });

    it('counts a split whose own payee is the old payee', async () => {
      await prepare();
      await db.insertTransaction({
        id: 'split',
        account: 'one',
        amount: -10,
        date: '2024-01-01',
        payee: 'other',
        is_parent: true,
      });
      await db.insertTransaction({
        id: 'split-0',
        account: 'one',
        amount: -10,
        date: '2024-01-01',
        payee: 'amzn-2',
        is_child: true,
        parent_id: 'split',
      });

      await batchUpdateTransactions({
        updated: [{ id: 'lonely', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      // "Other" is not orphaned (the split uses it), so this offer covers it
      expect(relatedPayeesEvents()).toEqual([
        {
          payee: { id: 'other', name: 'Other', transactionCount: 1 },
          targetPayee: { id: 'amazon', name: 'Amazon' },
        },
      ]);
    });

    it('offers to rename when the payee of a whole split changes', async () => {
      await prepare();
      await insertSplit('split', 2);

      await batchUpdateTransactions({
        updated: [
          { id: 'split', payee: 'amazon' },
          { id: 'split-0', payee: 'amazon' },
          { id: 'split-1', payee: 'amazon' },
        ],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([
        {
          payee: { id: 'amzn', name: 'AMZN MKTP US', transactionCount: 3 },
          targetPayee: { id: 'amazon', name: 'Amazon' },
        },
      ]);
    });

    it('does not offer anything when one line of a split changes payee', async () => {
      await prepare();
      await db.insertTransaction({
        id: 'split',
        account: 'one',
        amount: -20,
        date: '2024-01-01',
        payee: 'amzn',
        is_parent: true,
      });
      await db.insertTransaction({
        id: 'line',
        account: 'one',
        amount: -20,
        date: '2024-01-01',
        payee: 'amzn',
        is_child: true,
        parent_id: 'split',
      });

      await batchUpdateTransactions({
        updated: [{ id: 'line', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([]);
    });

    it('does not offer to merge several payees at once', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [
          { id: 'a1', payee: 'amazon' },
          { id: 'b1', payee: 'amazon' },
        ],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([]);
    });

    it('leaves payees without transactions to the orphaned payees prompt', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 'lonely', payee: 'amazon' }],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([]);
      expect(connection.send).toHaveBeenCalledWith('orphaned-payees', {
        orphanedIds: ['other'],
        updatedPayeeIds: ['amazon'],
      });
    });

    it('does not offer anything when the changes go to different payees', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [
          { id: 'a1', payee: 'amazon' },
          { id: 'a2', payee: 'other' },
        ],
        detectRelatedChanges: true,
      });

      expect(relatedPayeesEvents()).toEqual([]);
    });

    it('does not offer to merge into a transfer payee', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'to-one' }],
        detectRelatedChanges: true,
        runTransfers: false,
      });

      expect(relatedPayeesEvents()).toEqual([]);
    });

    it('only looks for related payees when asked to', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 'a1', payee: 'amazon' }],
      });

      expect(relatedPayeesEvents()).toEqual([]);
    });

    it('is offered through the batch update handler only when asked', async () => {
      await prepare();

      await runHandler(handlers['transactions-batch-update'], {
        updated: [{ id: 'a1', payee: 'amazon' }],
      });
      expect(relatedPayeesEvents()).toEqual([]);

      await runHandler(handlers['transactions-batch-update'], {
        updated: [{ id: 'a2', payee: 'amazon' }],
        detectRelatedChanges: true,
      });
      expect(relatedPayeesEvents()).toHaveLength(1);
    });
  });

  describe('related category', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.mocked(connection.send).mockClear();
    });

    async function insert(
      transactions: Array<Partial<TransactionEntity> & { id: string }>,
    ) {
      for (const transaction of transactions) {
        await db.insertTransaction({
          account: 'one',
          amount: -10,
          date: '2024-01-01',
          payee: 'netflix',
          category: null,
          ...transaction,
        });
      }
    }

    async function prepare() {
      await db.insertAccount({ id: 'one', name: 'one' });
      await db.insertAccount({ id: 'off', name: 'off', offbudget: 1 });
      await db.insertAccount({ id: 'closed', name: 'closed', closed: 1 });
      const group = await db.insertCategoryGroup({ name: 'group' });
      await db.insertCategory({ id: 'fun', name: 'Fun', cat_group: group });
      await db.insertCategory({ id: 'subs', name: 'Subs', cat_group: group });
      await db.insertCategory({ id: 'food', name: 'Food', cat_group: group });
      await db.insertPayee({ id: 'netflix', name: 'Netflix' });
      await db.insertPayee({ id: 'shop', name: 'Shop' });
      await db.insertPayee({ id: 'to-one', name: '', transfer_acct: 'one' });
      await insert([
        { id: 'n1', category: 'fun' },
        { id: 'n2', category: 'fun' },
        { id: 'n3', category: 'fun' },
        { id: 'n4' },
        { id: 'n5', category: 'food' },
        { id: 'n6', category: 'subs' },
        { id: 'n-off', account: 'off' },
        { id: 'n-closed', account: 'closed' },
        { id: 'n-deleted', tombstone: true },
        { id: 's1', payee: 'shop' },
        { id: 't1', payee: 'to-one' },
        { id: 't2', payee: 'to-one' },
      ]);
      vi.mocked(connection.send).mockClear();
    }

    function relatedCategoryEvents() {
      return vi
        .mocked(connection.send)
        .mock.calls.filter(([name]) => name === 'related-category')
        .map(([, args]) => args as ServerEvents['related-category']);
    }

    it('offers the uncategorized ones and the old category when it is the main one', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });

      // Of the other on-budget transactions, n2 and n3 are in Fun (2 of 4
      // categorized) and n4 is uncategorized. Off-budget, closed and
      // deleted ones don't count
      expect(relatedCategoryEvents()).toEqual([
        {
          payee: { id: 'netflix', name: 'Netflix' },
          category: { id: 'subs', name: 'Subs' },
          editedIds: ['n1'],
          uncategorizedCount: 1,
          fromCategories: [{ id: 'fun', name: 'Fun', count: 2 }],
        },
      ]);
    });

    it('offers only the uncategorized ones for a mixed-use payee', async () => {
      await prepare();
      await insert([
        { id: 'n7', category: 'food' },
        { id: 'n8', category: 'food' },
        { id: 'n9', category: 'food' },
      ]);

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });

      // Fun holds 2 of the 7 other categorized transactions
      expect(relatedCategoryEvents()).toEqual([
        {
          payee: { id: 'netflix', name: 'Netflix' },
          category: { id: 'subs', name: 'Subs' },
          editedIds: ['n1'],
          uncategorizedCount: 1,
          fromCategories: [],
        },
      ]);
    });

    it('counts transactions already in the new category toward the share', async () => {
      await prepare();
      await insert([
        { id: 'n7', category: 'subs' },
        { id: 'n8', category: 'subs' },
      ]);

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });

      // Fun now holds 2 of 6 other categorized transactions; the 3 in Subs
      // are not offered again but still count
      expect(relatedCategoryEvents()[0].fromCategories).toEqual([]);
    });

    it('checks each old category of a bulk edit on its own', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [
          { id: 'n1', category: 'subs' },
          { id: 'n5', category: 'subs' },
        ],
        detectRelatedChanges: true,
      });

      // Fun keeps 2 of 3 other categorized transactions; Food has none left
      expect(relatedCategoryEvents()[0].fromCategories).toEqual([
        { id: 'fun', name: 'Fun', count: 2 },
      ]);
    });

    it('counts split children but not split parents', async () => {
      await prepare();
      await insert([
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent' },
      ]);

      await batchUpdateTransactions({
        updated: [{ id: 'n5', category: 'subs' }],
        detectRelatedChanges: true,
      });

      const [event] = relatedCategoryEvents();
      expect(event.uncategorizedCount).toBe(2);
    });

    it('counts transactions in a deleted category as uncategorized', async () => {
      await prepare();
      await insert([{ id: 'n7', category: 'food' }]);
      await db.update('categories', { id: 'food', tombstone: 1 });

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });

      // n4, n5 and n7; Fun now holds 2 of 3 other categorized ones
      expect(relatedCategoryEvents()[0]).toMatchObject({
        uncategorizedCount: 3,
        fromCategories: [{ id: 'fun', name: 'Fun', count: 2 }],
      });
    });

    it('applies the offer to exactly the transactions it counted', async () => {
      await prepare();
      await insert([
        { id: 'n7', category: 'food' },
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent' },
      ]);
      await db.update('categories', { id: 'food', tombstone: 1 });

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });
      const [offer] = relatedCategoryEvents();
      // Undone before accepting: the edited transaction stays as it was
      await db.update('transactions', { id: 'n1', category: 'fun' });

      const changed = await runHandler(
        handlers['transactions-categorize-related'],
        {
          payeeId: offer.payee.id,
          categoryId: offer.category.id,
          fromCategoryIds: offer.fromCategories.map(category => category.id),
          excludeIds: offer.editedIds,
        },
      );

      const offered =
        offer.uncategorizedCount +
        offer.fromCategories.reduce((sum, category) => sum + category.count, 0);
      expect(changed).toBe(offered);
      const rows = await db.all<{ id: string; category: string | null }>(
        `SELECT id, category FROM v_transactions_internal
         WHERE payee = 'netflix' AND is_parent = 0 AND tombstone = 0
         ORDER BY id`,
      );
      expect(
        Object.fromEntries(rows.map(row => [row.id, row.category])),
      ).toEqual({
        child: 'subs',
        n1: 'fun',
        n2: 'subs',
        n3: 'subs',
        n4: 'subs',
        // In the deleted category: shown and counted as uncategorized
        n5: 'subs',
        n7: 'subs',
        // Already there
        n6: 'subs',
        // Not on budget: left alone
        'n-off': null,
        'n-closed': null,
      });
    });

    it('applies nothing when the category was deleted since', async () => {
      await prepare();
      await db.update('categories', { id: 'subs', tombstone: 1 });

      expect(
        await categorizeRelatedTransactions({
          payeeId: 'netflix',
          categoryId: 'subs',
          fromCategoryIds: ['fun'],
          excludeIds: [],
        }),
      ).toBe(0);
      const n4 = await db.first<{ category: string | null }>(
        'SELECT category FROM transactions WHERE id = ?',
        ['n4'],
      );
      expect(n4?.category).toBeNull();
    });

    it('binds the ids it is given instead of splicing them into SQL', async () => {
      await prepare();

      expect(
        await categorizeRelatedTransactions({
          payeeId: 'netflix',
          categoryId: 'subs',
          fromCategoryIds: ["fun') OR ('1' = '1"],
          excludeIds: ["n1') OR ('1' = '1"],
        }),
      ).toBe(1);
    });

    it('applies nothing when only the edited transactions match', async () => {
      await prepare();

      expect(
        await categorizeRelatedTransactions({
          payeeId: 'shop',
          categoryId: 'subs',
          fromCategoryIds: [],
          excludeIds: ['s1'],
        }),
      ).toBe(0);
    });

    it('leaves out lines of a deleted split', async () => {
      await prepare();
      await insert([
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent' },
      ]);
      await db.update('transactions', { id: 'parent', tombstone: 1 });

      await batchUpdateTransactions({
        updated: [{ id: 'n5', category: 'subs' }],
        detectRelatedChanges: true,
      });

      // Only n4
      expect(relatedCategoryEvents()[0].uncategorizedCount).toBe(1);
    });

    it('judges a bulk edit that includes a split by its other transactions', async () => {
      await prepare();
      await insert([
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent' },
      ]);

      await batchUpdateTransactions({
        updated: [
          { id: 'n1', category: 'subs' },
          { id: 'parent', category: 'subs' },
        ],
        detectRelatedChanges: true,
      });

      expect(relatedCategoryEvents()).toHaveLength(1);
    });

    it('offers only the uncategorized ones when the old categories cannot be read', async () => {
      await prepare();
      const all = db.all;
      vi.spyOn(db, 'all').mockImplementation((sql: string, params) => {
        if (sql.includes('cm.transferId AS category FROM transactions t')) {
          return Promise.reject(new Error('read failed'));
        }
        return all(sql, params);
      });

      await batchUpdateTransactions({
        updated: [{ id: 'n1', category: 'subs' }],
        detectRelatedChanges: true,
      });
      vi.restoreAllMocks();

      const n1 = await db.first<{ category: string }>(
        'SELECT category FROM transactions WHERE id = ?',
        ['n1'],
      );
      expect(n1?.category).toBe('subs');
      expect(relatedCategoryEvents()).toEqual([
        expect.objectContaining({ uncategorizedCount: 1, fromCategories: [] }),
      ]);
    });

    it('judges a bulk edit of a whole split, lines included, by its other transactions', async () => {
      await prepare();
      await insert([
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent', category: 'fun' },
      ]);

      await batchUpdateTransactions({
        updated: [
          { id: 'n1', category: 'subs' },
          { id: 'parent', category: 'subs' },
          { id: 'child', category: 'subs' },
        ],
        detectRelatedChanges: true,
      });

      // The split's line is left out like n1: Fun keeps n2 and n3, 2 of the
      // 4 other categorized transactions (with the line counted in Subs it
      // would be 2 of 5, and Fun would not be offered)
      expect(relatedCategoryEvents()).toEqual([
        expect.objectContaining({
          editedIds: ['n1', 'child'],
          uncategorizedCount: 1,
          fromCategories: [{ id: 'fun', name: 'Fun', count: 2 }],
        }),
      ]);
    });

    it('still saves the edit when looking for an offer fails', async () => {
      await prepare();
      vi.spyOn(db, 'all').mockImplementation(async (sql: string) => {
        if (sql.includes('GROUP BY c.id')) {
          throw new Error('too many SQL variables');
        }
        return [];
      });

      await expect(
        batchUpdateTransactions({
          updated: [{ id: 'n1', category: 'subs' }],
          detectRelatedChanges: true,
          runTransfers: false,
        }),
      ).resolves.toBeDefined();
      vi.restoreAllMocks();

      const n1 = await db.first<{ category: string }>(
        'SELECT category FROM transactions WHERE id = ?',
        ['n1'],
      );
      expect(n1?.category).toBe('subs');
      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('does not offer anything when editing a line of a split', async () => {
      await prepare();
      await insert([
        { id: 'parent', is_parent: true },
        { id: 'child', is_child: true, parent_id: 'parent' },
      ]);

      await batchUpdateTransactions({
        updated: [{ id: 'child', category: 'subs' }],
        detectRelatedChanges: true,
      });

      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('does not offer anything when nothing else matches', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 's1', category: 'food' }],
        detectRelatedChanges: true,
      });

      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('does not offer anything when the payee changed in the same edit', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 's1', payee: 'netflix', category: 'subs' }],
        detectRelatedChanges: true,
      });

      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('does not offer anything for edits to different categories', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [
          { id: 'n1', category: 'subs' },
          { id: 'n2', category: 'food' },
        ],
        detectRelatedChanges: true,
      });

      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('does not offer anything for transfers', async () => {
      await prepare();

      await batchUpdateTransactions({
        updated: [{ id: 't1', category: 'food' }],
        detectRelatedChanges: true,
        runTransfers: false,
      });

      expect(relatedCategoryEvents()).toEqual([]);
    });

    it('is offered through the batch update handler only when asked', async () => {
      await prepare();

      await runHandler(handlers['transactions-batch-update'], {
        updated: [{ id: 'n1', category: 'subs' }],
      });
      expect(relatedCategoryEvents()).toEqual([]);

      await runHandler(handlers['transactions-batch-update'], {
        updated: [{ id: 'n2', category: 'subs' }],
        detectRelatedChanges: true,
      });
      expect(relatedCategoryEvents()).toHaveLength(1);
    });

    it('costs two queries for a category edit and one for a payee edit', async () => {
      // The same edit on the same data, with and without detection
      async function countQueries(
        update: Partial<TransactionEntity>,
        detectRelatedChanges: boolean,
      ) {
        await global.emptyDatabase()();
        await prepare();
        await db.insertPayee({ id: 'amazon', name: 'Amazon' });
        const spies = [
          vi.spyOn(db, 'all'),
          vi.spyOn(db, 'first'),
          vi.spyOn(db, 'selectWithSchema'),
        ];
        await batchUpdateTransactions({
          updated: [update],
          detectRelatedChanges,
          detectOrphanPayees: false,
          runTransfers: false,
        });
        const count = spies.reduce(
          (sum, spy) => sum + spy.mock.calls.length,
          0,
        );
        spies.forEach(spy => spy.mockRestore());
        return count;
      }

      const categoryEdit = { id: 'n1', category: 'subs' };
      const payeeEdit = { id: 'n1', payee: 'amazon' };
      // The old categories are read, then one query finds the candidates
      expect(
        (await countQueries(categoryEdit, true)) -
          (await countQueries(categoryEdit, false)),
      ).toBe(2);
      // The old payees are already read; one query checks both payees
      expect(
        (await countQueries(payeeEdit, true)) -
          (await countQueries(payeeEdit, false)),
      ).toBe(1);
    });
  });
});
