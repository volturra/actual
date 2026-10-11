// @ts-strict-ignore
import * as db from '#server/db';

import { runRules } from './transaction-rules';

async function getPayee(acct) {
  return db.first<db.DbPayee>('SELECT * FROM payees WHERE transfer_acct = ?', [
    acct,
  ]);
}

// Payee id -> the account it transfers to (null for a regular payee)
export type TransferAccounts = Map<string, string | null>;

// Stays well below SQLite's bound-parameter limit
const PAYEE_LOOKUP_CHUNK_SIZE = 500;

/**
 * Looks up the transfer account of every payee of `transactions` with one
 * query per chunk, for callers that run `onInsert`/`onUpdate` over many
 * transactions at once. Same view and same rules as the single-transaction
 * lookup in `getTransferredAccount`: a payee missing from the view (unknown,
 * or a transfer payee of a deleted account) maps to null. Split parents
 * are left out.
 */
export async function getTransferAccounts(
  transactions: ReadonlyArray<{ payee?: string | null; is_parent?: boolean }>,
): Promise<TransferAccounts> {
  const ids = [
    ...new Set(
      transactions
        // Split parents never use their payee's transfer account
        .filter(t => !t.is_parent)
        .map(t => t.payee)
        .filter((payee): payee is string => Boolean(payee)),
    ),
  ];
  const result: TransferAccounts = new Map(ids.map(id => [id, null]));

  for (let i = 0; i < ids.length; i += PAYEE_LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + PAYEE_LOOKUP_CHUNK_SIZE);
    const rows = await db.all<Pick<db.DbViewPayee, 'id' | 'transfer_acct'>>(
      `SELECT id, transfer_acct FROM v_payees WHERE id IN (${chunk
        .map(() => '?')
        .join(', ')})`,
      chunk,
    );
    for (const row of rows) {
      result.set(row.id, row.transfer_acct || null);
    }
  }
  return result;
}

async function getTransferredAccount(
  transaction,
  transferAccounts?: TransferAccounts,
) {
  // A split parent is never a transfer itself: `onUpdate` only removes
  // its old transfer and `addTransfer` skips it, so the batch lookup
  // leaves parents out
  if (transferAccounts && transaction.is_parent) {
    return null;
  }
  if (transaction.payee && transferAccounts?.has(transaction.payee)) {
    return transferAccounts.get(transaction.payee);
  }
  if (transaction.payee) {
    const result = await db.first<Pick<db.DbViewPayee, 'transfer_acct'>>(
      'SELECT transfer_acct FROM v_payees WHERE id = ?',
      [transaction.payee],
    );

    return result?.transfer_acct || null;
  }
  return null;
}

async function clearCategory(transaction, transferAcct) {
  const { offbudget: fromOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transaction.account]);
  const { offbudget: toOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transferAcct]);

  // If the transfer is between two on budget or two off budget accounts,
  // we should clear the category, because the category is not relevant
  if (fromOffBudget === toOffBudget) {
    await db.updateTransaction({ id: transaction.id, category: null });
    if (transaction.transfer_id) {
      await db.updateTransaction({
        id: transaction.transfer_id,
        category: null,
      });
    }
    return true;
  }
  return false;
}

export async function addTransfer(transaction, transferredAccount) {
  if (transaction.is_parent) {
    // For split transactions, we should create transfers using child transactions.
    // This is to ensure that the amounts received by the transferred account
    // reflects the amounts in the child transactions and not the parent transaction
    // amount which is the total amount.
    return null;
  }

  const { id: fromPayee } = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [transaction.account],
  );

  const transferTransaction = {
    account: transferredAccount,
    amount: -transaction.amount,
    payee: fromPayee,
    date: transaction.date,
    transfer_id: transaction.id,
    notes: transaction.notes || null,
    schedule: transaction.schedule,
    cleared: false,
  };
  const { notes, cleared, schedule } = await runRules(transferTransaction);
  const matchedSchedule = schedule ?? transaction.schedule;

  const id = await db.insertTransaction({
    ...transferTransaction,
    notes,
    cleared,
    schedule: matchedSchedule,
  });

  await db.updateTransaction({
    id: transaction.id,
    transfer_id: id,
    ...(matchedSchedule ? { schedule: matchedSchedule } : {}),
  });
  const categoryCleared = await clearCategory(transaction, transferredAccount);

  return {
    id: transaction.id,
    transfer_id: id,
    ...(categoryCleared ? { category: null } : {}),
  };
}

export async function removeTransfer(transaction) {
  const transferTrans = await db.getTransaction(transaction.transfer_id);

  // Perform operations on the transfer transaction only
  // if it is found. For example: when users delete both
  // (in & out) transfer transactions at the same time -
  // transfer transaction will not be found.
  if (transferTrans) {
    if (transferTrans.is_child) {
      // If it's a child transaction, we don't delete it because that
      // would invalidate the whole split transaction. Instead of turn
      // it into a normal transaction
      await db.updateTransaction({
        id: transaction.transfer_id,
        transfer_id: null,
        payee: null,
      });
    } else {
      await db.deleteTransaction({ id: transaction.transfer_id });
    }
  }
  await db.updateTransaction({ id: transaction.id, transfer_id: null });
  return { id: transaction.id, transfer_id: null };
}

export async function updateTransfer(transaction, transferredAccount) {
  const payee = await getPayee(transaction.account);

  await db.updateTransaction({
    id: transaction.transfer_id,
    account: transferredAccount,
    // Make sure to update the payee on the other side in case the
    // user moved this transaction into another account
    payee: payee.id,
    notes: transaction.notes,
    amount: -transaction.amount,
    schedule: transaction.schedule,
  });

  const categoryCleared = await clearCategory(transaction, transferredAccount);
  if (categoryCleared) {
    return { id: transaction.id, category: null };
  }
}

export async function onInsert(
  transaction,
  transferAccounts?: TransferAccounts,
) {
  const transferredAccount = await getTransferredAccount(
    transaction,
    transferAccounts,
  );

  if (transferredAccount) {
    return addTransfer(transaction, transferredAccount);
  }
}

export async function onDelete(transaction) {
  if (transaction.transfer_id) {
    await removeTransfer(transaction);
  }
}

export async function onUpdate(
  transaction,
  transferAccounts?: TransferAccounts,
) {
  if (transaction.is_parent) {
    // A split parent is never a transfer itself (its children can be).
    // Only write when there is an old transfer to remove: rewriting a
    // `transfer_id` that is already null changes nothing but still sends
    // a sync message and adds an undo entry
    if (transaction.transfer_id) {
      return removeTransfer(transaction);
    }
    return { id: transaction.id, transfer_id: null };
  }

  const transferredAccount = await getTransferredAccount(
    transaction,
    transferAccounts,
  );

  if (transferredAccount && !transaction.transfer_id) {
    return addTransfer(transaction, transferredAccount);
  }

  if (!transferredAccount && transaction.transfer_id) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && transaction.transfer_id) {
    return updateTransfer(transaction, transferredAccount);
  }
}
