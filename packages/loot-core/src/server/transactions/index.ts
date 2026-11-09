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
 * Selects from the alive, non-parent rows of the `transactions` table (as
 * `t`) whose payee maps to the bound payee id. Same rows as
 * `v_transactions_internal_alive` with `payee = ? AND is_parent = 0` (or
 * without `is_parent = 0` when `includeParents` is set), but it
 * reads the table directly: the view joins every transaction before
 * filtering, which is about three times slower on a large budget (4 ms
 * instead of 12 ms for 50,000 transactions), and this runs on edits
 */
function aliveTransactionsOfPayee(
  select: string,
  { includeParents = false }: { includeParents?: boolean } = {},
) {
  return `SELECT ${select} FROM transactions t
    LEFT JOIN transactions parent ON t.isChild = 1 AND parent.id = t.parent_id
    WHERE t.description IN (SELECT id FROM payee_mapping WHERE targetId = ?)
      AND t.date IS NOT NULL AND t.acct IS NOT NULL
      AND IFNULL(t.tombstone, 0) = 0
      ${includeParents ? '' : 'AND t.isParent = 0'}
      AND (t.isChild = 0 OR parent.tombstone = 0)`;
}

/**
 * When the user moves transactions from one payee to another (for example
 * renaming "AMZN MKTP US*1A2B3C" to "Amazon" on one transaction), the old
 * payee usually still has other transactions. Find those so the client can
 * offer to merge the old payee into the new one, which renames it
 * everywhere. A payee left without transactions is handled by the
 * `orphaned-payees` prompt instead.
 */
async function findRelatedPayees(
  updated: TransactionEntity[],
  oldPayeeByTransaction: Map<TransactionEntity['id'], PayeeEntity['id']>,
): Promise<ServerEvents['related-payees'] | null> {
  const fromIds = new Set<PayeeEntity['id']>();
  const targetIds = new Set<PayeeEntity['id']>();
  const updatedIds = new Set(updated.map(transaction => transaction.id));
  for (const transaction of updated) {
    if (transaction.is_child) {
      // Changing a split's payee also changes its lines: the split itself
      // stands for them. A line changed on its own says little about the
      // payee's other transactions
      if (updatedIds.has(transaction.parent_id)) {
        continue;
      }
      return null;
    }
    const oldPayee = oldPayeeByTransaction.get(transaction.id);
    if (oldPayee && transaction.payee && oldPayee !== transaction.payee) {
      fromIds.add(oldPayee);
      targetIds.add(transaction.payee);
    }
  }

  // Only offer this for one payee renamed to another. A bulk edit that
  // moves several payees to one is usually a fix for those rows, and merging
  // all of them in one click would be too easy to get wrong
  if (fromIds.size !== 1 || targetIds.size !== 1) {
    return null;
  }
  const [fromId] = fromIds;
  const [targetId] = targetIds;

  // One query: both payees, and the old payee's remaining transactions
  const rows = await db.all<
    Pick<db.DbPayee, 'id' | 'name' | 'transfer_acct'> & {
      count: number | null;
    }
  >(
    `SELECT p.id, p.name, p.transfer_acct,
       CASE WHEN p.id = ? THEN (${aliveTransactionsOfPayee(
         // A split counts once, however many of its rows use the payee
         'COUNT(DISTINCT CASE WHEN t.isChild = 1 THEN t.parent_id ELSE t.id END)',
         // A split whose own payee is this one still uses it, like the
         // orphaned payees check counts it
         { includeParents: true },
       )}) END AS count
     FROM payees p
     WHERE p.id IN (?, ?) AND p.tombstone = 0`,
    [fromId, fromId, fromId, targetId],
  );
  const from = rows.find(row => row.id === fromId);
  const target = rows.find(row => row.id === targetId);
  // Transfer payees are never merged
  if (
    !from ||
    !target ||
    from.transfer_acct != null ||
    target.transfer_acct != null ||
    !from.count
  ) {
    return null;
  }

  return {
    payee: { id: from.id, name: from.name, transactionCount: from.count },
    targetPayee: { id: target.id, name: target.name },
  };
}

/**
 * Selects from the payee's (bound twice) alive, non-parent transactions in
 * open on-budget accounts, leaving out `excludeIds`. Joins `c`, the
 * transaction's category, which is null for a deleted category as in the
 * register. Transfer payees match nothing: transfers between on-budget
 * accounts have no category. Shared by the category offer and applying it,
 * so what is counted is what gets changed
 */
function onBudgetTransactionsOfPayee(select: string, excludeIds: string[]) {
  return `SELECT ${select}
     FROM (${aliveTransactionsOfPayee('t.*')}) t
     JOIN accounts a ON a.id = t.acct
     JOIN payees p ON p.id = ?
     LEFT JOIN category_mapping cm ON cm.id = t.category
     LEFT JOIN categories c ON c.id = cm.transferId AND c.tombstone = 0
     WHERE p.tombstone = 0 AND p.transfer_acct IS NULL
       AND a.offbudget = 0 AND a.closed = 0 AND a.tombstone = 0
       AND NOT ${whereIn(excludeIds, 't.id')}`;
}

/**
 * Applies an accepted `related-category` offer: gives `categoryId` to the
 * payee's on-budget transactions that are uncategorized or in one of
 * `fromCategoryIds`, except `excludeIds` (the edited ones, so an edit the
 * user undid is not redone). The transactions are selected now, as the
 * offer may be a while old. Returns how many were changed
 */
export async function categorizeRelatedTransactions({
  payeeId,
  categoryId,
  fromCategoryIds,
  excludeIds,
}: {
  payeeId: PayeeEntity['id'];
  categoryId: NonNullable<TransactionEntity['category']>;
  fromCategoryIds: Array<NonNullable<TransactionEntity['category']>>;
  excludeIds: Array<TransactionEntity['id']>;
}): Promise<number> {
  // The category may have been deleted while the offer was open
  const category = await db.first<{ id: string }>(
    'SELECT id FROM categories WHERE id = ? AND tombstone = 0',
    [categoryId],
  );
  if (!category) {
    return 0;
  }

  const rows = await db.all<{ id: string }>(
    `${onBudgetTransactionsOfPayee('t.id', excludeIds)}
       AND (c.id IS NULL OR ${whereIn(fromCategoryIds, 'c.id')})`,
    [payeeId, payeeId],
  );
  if (rows.length > 0) {
    await batchUpdateTransactions({
      updated: rows.map(row => ({ id: row.id, category: categoryId })),
    });
  }
  return rows.length;
}

/**
 * When the user changes the category of a payee's transactions (for example
 * moving one "Netflix" transaction from "Entertainment" to "Subscriptions"),
 * find the payee's other transactions that should likely follow, so the
 * client can offer to categorize them too:
 *
 * - the uncategorized ones
 * - the ones still in the category the edited transactions came from, but
 *   only when that category holds at least half of the payee's categorized
 *   transactions. For a mixed-use payee (a supermarket used for groceries
 *   and household things) moving one transaction is a one-off fix, not a
 *   reclassification of the payee
 *
 * Only counts are returned: when the user accepts, the server selects the
 * transactions again with the same query (see
 * `categorizeRelatedTransactions`), so the offer is never applied to stale
 * data.
 */
async function findRelatedCategoryChange(
  updates: Partial<TransactionEntity>[],
  updated: TransactionEntity[],
  oldCategoryByTransaction: Map<
    TransactionEntity['id'],
    TransactionEntity['category']
  >,
): Promise<ServerEvents['related-category'] | null> {
  // A payee change is answered by the related payees offer; asking about
  // categories in the same edit would be one prompt too many
  if (updates.some(update => update.payee)) {
    return null;
  }
  const categoryUpdateIds = new Set(
    updates.filter(update => update.category).map(update => update.id),
  );
  const edited = updated.filter(transaction =>
    categoryUpdateIds.has(transaction.id),
  );
  // One line of a split says little about the payee's other transactions
  if (edited.length === 0 || edited.some(transaction => transaction.is_child)) {
    return null;
  }

  // Only offer this when every edit is the same payee and category
  const payeeIds = new Set(edited.map(transaction => transaction.payee));
  const categoryIds = new Set(edited.map(transaction => transaction.category));
  if (payeeIds.size !== 1 || categoryIds.size !== 1) {
    return null;
  }
  const [payeeId] = payeeIds;
  const [categoryId] = categoryIds;
  // A transaction moved to an off-budget account has its category cleared
  if (!payeeId || !categoryId) {
    return null;
  }

  // One query: the payee's other on-budget transactions per category, with
  // the names the client shows
  const rows = await db.all<{
    category: string | null;
    count: number;
    category_name: string | null;
    payee_name: string;
    target_name: string | null;
  }>(
    `${onBudgetTransactionsOfPayee(
      `c.id AS category, COUNT(*) AS count,
       c.name AS category_name, p.name AS payee_name,
       (SELECT name FROM categories WHERE id = ?) AS target_name`,
      edited.map(transaction => transaction.id),
    )}
     GROUP BY c.id`,
    [categoryId, payeeId, payeeId],
  );
  if (rows.length === 0) {
    return null;
  }

  const oldCategoryIds = new Set(
    edited.map(transaction => oldCategoryByTransaction.get(transaction.id)),
  );
  const categorizedCount = rows
    .filter(row => row.category != null)
    .reduce((sum, row) => sum + row.count, 0);
  const uncategorizedCount = rows.find(row => row.category == null)?.count ?? 0;
  const fromCategories = rows.flatMap(row =>
    row.category != null &&
    row.category !== categoryId &&
    oldCategoryIds.has(row.category) &&
    row.count * 2 >= categorizedCount
      ? [{ id: row.category, name: row.category_name ?? '', count: row.count }]
      : [],
  );
  if (uncategorizedCount === 0 && fromCategories.length === 0) {
    return null;
  }

  return {
    payee: { id: payeeId, name: rows[0].payee_name },
    category: { id: categoryId, name: rows[0].target_name ?? '' },
    editedIds: edited.map(transaction => transaction.id),
    uncategorizedCount,
    fromCategories,
  };
}

export async function batchUpdateTransactions({
  added,
  deleted,
  updated,
  learnCategories = false,
  detectOrphanPayees = true,
  detectRelatedChanges = false,
  runTransfers = true,
}: Partial<Diff<TransactionEntity>> & {
  learnCategories?: boolean;
  detectOrphanPayees?: boolean;
  /**
   * Offer to repeat the user's edit on related transactions: renaming a
   * payee everywhere (see `findRelatedPayees`) or categorizing the payee's
   * other transactions (see `findRelatedCategoryChange`)
   */
  detectRelatedChanges?: boolean;
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
  const oldCategoryByTransaction = new Map<
    TransactionEntity['id'],
    TransactionEntity['category']
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
    const payeeUpdateIds = new Set(
      updated.filter(update => update.payee).map(update => update.id),
    );
    const transactions = await getTransactionsByIds([...payeeUpdateIds]);

    for (let i = 0; i < transactions.length; i++) {
      oldPayees.add(transactions[i].payee);
      oldPayeeByTransaction.set(transactions[i].id, transactions[i].payee);
    }

    // Read the old categories only when a category offer is possible: one
    // category set on every edited transaction, and no payee change (so
    // this never adds to the read above). A direct primary key lookup, as a
    // bulk edit can cover thousands of rows
    const categoryUpdates = updated.filter(update => update.category);
    if (
      detectRelatedChanges &&
      payeeUpdateIds.size === 0 &&
      new Set(categoryUpdates.map(update => update.category)).size === 1
    ) {
      const rows = await db.all<{ id: string; category: string | null }>(
        `SELECT t.id, cm.transferId AS category FROM transactions t
         LEFT JOIN category_mapping cm ON cm.id = t.category
         WHERE ${whereIn(
           categoryUpdates.map(update => update.id),
           't.id',
         )}`,
      );
      for (const row of rows) {
        oldCategoryByTransaction.set(row.id, row.category);
      }
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
      }
    }
  }

  if (detectRelatedChanges && updated) {
    const relatedPayees = await findRelatedPayees(
      allUpdated,
      oldPayeeByTransaction,
    );
    if (relatedPayees) {
      connection.send('related-payees', relatedPayees);
    }

    const related = await findRelatedCategoryChange(
      updated,
      allUpdated,
      oldCategoryByTransaction,
    );
    if (related) {
      connection.send('related-category', related);
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
