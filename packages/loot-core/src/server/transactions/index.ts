// @ts-strict-ignore

import * as connection from '#platform/server/connection';
import * as db from '#server/db';
import { incrFetch, whereIn } from '#server/db/util';
import { batchMessages } from '#server/sync';
import type { Diff } from '#shared/util';
import type { PayeeEntity, TransactionEntity } from '#types/models';
import type { ServerEvents } from '#types/server-events';

import * as rules from './transaction-rules';
import * as transfer from './transfer';

async function idsWithChildren(ids: string[]) {
  const whereIds = whereIn(ids, 'parent_id');
  const rows = await db.all<Pick<db.DbViewTransactionInternal, 'id'>>(
    `SELECT id FROM v_transactions_internal WHERE ${whereIds}`,
  );
  const set = new Set(ids);
  for (const row of rows) {
    set.add(row.id);
  }
  return [...set];
}

async function getTransactionsByIds(
  ids: string[],
): Promise<TransactionEntity[]> {
  // TODO: convert to whereIn
  //
  // or better yet, use ActualQL
  return incrFetch(
    (query, params) => db.selectWithSchema('transactions', query, params),
    ids,

    id => `id = '${id}'`,
    where => `SELECT * FROM v_transactions_internal WHERE ${where}`,
  );
}

/**
 * When the user moves transactions from one payee to another (for example
 * renaming "AMZN MKTP US*1A2B3C" to "Amazon" on one transaction), the old
 * payee usually still has other transactions. Find those so the client can
 * offer to merge the old payee into the new one, which renames it
 * everywhere. Payees left without transactions are handled by the
 * `orphaned-payees` prompt instead.
 */
async function findRelatedPayees(
  updated: TransactionEntity[],
  oldPayeeByTransaction: Map<TransactionEntity['id'], PayeeEntity['id']>,
  orphanedIds: Set<PayeeEntity['id']>,
): Promise<ServerEvents['related-payees'] | null> {
  const fromIds = new Set<PayeeEntity['id']>();
  const targetIds = new Set<PayeeEntity['id']>();
  for (const transaction of updated) {
    const oldPayee = oldPayeeByTransaction.get(transaction.id);
    if (oldPayee && transaction.payee && oldPayee !== transaction.payee) {
      fromIds.add(oldPayee);
      targetIds.add(transaction.payee);
    }
  }

  // Only offer this when every change went to the same payee; otherwise it
  // is not clear what the old payees should be renamed to
  if (targetIds.size !== 1) {
    return null;
  }
  const [targetId] = targetIds;
  const candidateIds = [...fromIds].filter(
    id => id !== targetId && !orphanedIds.has(id),
  );
  if (candidateIds.length === 0) {
    return null;
  }

  const payeeIds = [targetId, ...candidateIds];
  const payees = await db.all<Pick<db.DbPayee, 'id' | 'name'>>(
    `SELECT id, name FROM payees
     WHERE ${whereIn(payeeIds, 'id')} AND tombstone = 0
       AND transfer_acct IS NULL`,
  );
  const target = payees.find(payee => payee.id === targetId);
  if (!target) {
    // Transfers are never merged
    return null;
  }

  const counts = await db.all<{ payee: string; count: number }>(
    `SELECT payee, COUNT(*) AS count FROM v_transactions_internal_alive
     WHERE ${whereIn(candidateIds, 'payee')} AND is_parent = 0
     GROUP BY payee`,
  );
  const countByPayee = new Map(counts.map(row => [row.payee, row.count]));

  const related = payees
    .filter(payee => payee.id !== targetId && countByPayee.get(payee.id) > 0)
    .map(payee => ({
      id: payee.id,
      name: payee.name,
      transactionCount: countByPayee.get(payee.id),
    }));
  if (related.length === 0) {
    return null;
  }

  return {
    payees: related,
    targetPayee: { id: target.id, name: target.name },
  };
}

export async function batchUpdateTransactions({
  added,
  deleted,
  updated,
  learnCategories = false,
  detectOrphanPayees = true,
  detectRelatedPayees = false,
  runTransfers = true,
}: Partial<Diff<TransactionEntity>> & {
  learnCategories?: boolean;
  detectOrphanPayees?: boolean;
  /**
   * Offer to rename a payee everywhere when the user moves some of its
   * transactions to another payee (see `findRelatedPayees`)
   */
  detectRelatedPayees?: boolean;
  runTransfers?: boolean;
}) {
  // Track the ids of each type of transaction change (see below for why)
  let addedIds = [];
  const updatedIds = updated ? updated.map(u => u.id) : [];
  const deletedIds = deleted
    ? await idsWithChildren(deleted.map(d => d.id))
    : [];

  const oldPayees = new Set<PayeeEntity['id']>();
  const oldPayeeByTransaction = new Map<
    TransactionEntity['id'],
    PayeeEntity['id']
  >();

  // Accounts are only needed to clear the category of off-budget
  // transactions, so skip the read for edits that don't set an account
  const needsAccounts =
    (added?.length ?? 0) > 0 ||
    (updated?.some(transaction => transaction.account) ?? false);
  const accounts = needsAccounts
    ? await db.all<db.DbAccount>('SELECT * FROM accounts WHERE tombstone = 0')
    : [];

  // We need to get all the payees of updated transactions _before_
  // making changes
  if (updated) {
    const descUpdatedIds = updated
      .filter(update => update.payee)
      .map(update => update.id);

    const transactions = await getTransactionsByIds(descUpdatedIds);

    for (let i = 0; i < transactions.length; i++) {
      oldPayees.add(transactions[i].payee);
      oldPayeeByTransaction.set(transactions[i].id, transactions[i].payee);
    }
  }

  // Apply all the updates. We can batch this now! This is important
  // and makes bulk updates much faster
  await batchMessages(async () => {
    if (added) {
      addedIds = await Promise.all(
        added.map(async t => {
          // Offbudget account transactions and parent transactions should not have categories.
          const account = accounts.find(acct => acct.id === t.account);
          if (t.is_parent || account?.offbudget === 1) {
            t.category = null;
          }
          return db.insertTransaction(t);
        }),
      );
    }

    if (deleted) {
      await Promise.all(
        // It's important to use `deletedIds` and not `deleted` here
        // because we've expanded it to include children above. The
        // inconsistency of the delete APIs is annoying and should
        // be fixed (it should only take an id)
        deletedIds.map(async id => {
          await db.deleteTransaction({ id });
        }),
      );
    }

    if (updated) {
      await Promise.all(
        updated.map(async t => {
          if (t.account) {
            // Moving transactions off budget should always clear the
            // category. Parent transactions should not have categories.
            const account = accounts.find(acct => acct.id === t.account);
            if (t.is_parent || account?.offbudget === 1) {
              t.category = null;
            }
          }

          await db.updateTransaction(t);
        }),
      );
    }
  });

  // Get all of the full transactions that were changed. This is
  // needed to run any cascading logic that depends on the full
  // transaction. Things like transfers, analyzing rule updates, and
  // more
  //
  // One read for all of them: on the web backend every query is a
  // separate lock/commit cycle against IndexedDB
  const changedTransactions = await getTransactionsByIds([
    ...new Set([...addedIds, ...updatedIds, ...deletedIds]),
  ]);
  const changedById = new Map(
    changedTransactions.map(transaction => [transaction.id, transaction]),
  );
  const pickTransactions = (ids: string[]) =>
    [...new Set(ids)]
      .map(id => changedById.get(id))
      .filter((transaction): transaction is TransactionEntity =>
        Boolean(transaction),
      );
  const allAdded = pickTransactions(addedIds);
  const allUpdated = pickTransactions(updatedIds);
  const allDeleted = pickTransactions(deletedIds);

  // Post-processing phase: first do any updates to transfers.
  // Transfers update the transactions and we need to return updates
  // to the client so that can apply them. Note that added
  // transactions just return the full transaction.
  const resultAdded = allAdded;
  const resultUpdated = allUpdated;
  let transfersUpdated: Awaited<ReturnType<typeof transfer.onUpdate>>[];

  if (runTransfers) {
    // Every transfer payee, read once for the whole batch. The transfer
    // writes below are batched and only applied after they all ran, and
    // they never change payees, so the map holds for every transaction.
    // Deletes don't need it
    const transferAccounts =
      allAdded.length > 0 || allUpdated.length > 0
        ? await transfer.getTransferAccounts()
        : new Map<string, string>();
    await batchMessages(async () => {
      await Promise.all(
        allAdded.map(t => transfer.onInsert(t, transferAccounts)),
      );

      // Return any updates from here
      transfersUpdated = (
        await Promise.all(
          allUpdated.map(t => transfer.onUpdate(t, transferAccounts)),
        )
      ).filter(Boolean);

      await Promise.all(allDeleted.map(t => transfer.onDelete(t)));
    });
  }

  if (learnCategories) {
    // Analyze any updated categories and update rules to learn from
    // the user's activity
    const ids = new Set([
      ...(added ? added.filter(add => add.category).map(add => add.id) : []),
      ...(updated
        ? updated.filter(update => update.category).map(update => update.id)
        : []),
    ]);
    await rules.updateCategoryRules(
      allAdded.concat(allUpdated).filter(trans => ids.has(trans.id)),
    );
  }

  if (detectOrphanPayees) {
    // Look for any orphaned payees and notify the user about merging
    // them

    if (updated) {
      const newPayeeIds = updated.map(u => u.payee).filter(Boolean);
      if (newPayeeIds.length > 0) {
        const allOrphaned = new Set(await db.getOrphanedPayees());

        const orphanedIds = [...oldPayees].filter(id => allOrphaned.has(id));

        if (orphanedIds.length > 0) {
          connection.send('orphaned-payees', {
            orphanedIds,
            updatedPayeeIds: newPayeeIds,
          });
        }

        if (detectRelatedPayees) {
          const related = await findRelatedPayees(
            allUpdated,
            oldPayeeByTransaction,
            allOrphaned,
          );
          if (related) {
            connection.send('related-payees', related);
          }
        }
      }
    }
  }

  return {
    added: resultAdded,
    updated: runTransfers ? transfersUpdated : resultUpdated,
    deleted: allDeleted,
    errors: ((added || []) as Partial<TransactionEntity>[])
      .concat(updated || [])
      .flatMap(t => t._ruleErrors || []),
  };
}
