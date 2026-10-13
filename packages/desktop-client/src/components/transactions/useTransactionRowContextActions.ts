import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  extractScheduleConds,
  scheduleIsRecurring,
} from '@actual-app/core/shared/schedules';
import { isPreviewId } from '@actual-app/core/shared/transactions';
import type { TransactionEntity } from '@actual-app/core/types/models';

import type { ContextMenuItem } from '#contextmenu/types';
import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useContextMenu } from '#hooks/useContextMenu';
import { useSelectedItems } from '#hooks/useSelected';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type TransactionRowContextMenuProps = {
  rowRef: RefObject<HTMLElement | null>;
  transaction: TransactionEntity;
  getTransaction: (id: string) => TransactionEntity | undefined;
  onDuplicate: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onLinkSchedule: (ids: string[]) => void;
  onUnlinkSchedule: (ids: string[]) => void;
  onCreateRule: (ids: string[]) => void;
  onScheduleAction: (
    name: 'skip' | 'post-transaction' | 'post-transaction-today' | 'complete',
    ids: TransactionEntity['id'][],
  ) => void;
  onMakeAsNonSplitTransactions: (ids: string[]) => void;
};

export function useTransactionRowContextActions({
  rowRef,
  transaction,
  getTransaction,
  onDuplicate,
  onDelete,
  onLinkSchedule,
  onUnlinkSchedule,
  onCreateRule,
  onScheduleAction,
  onMakeAsNonSplitTransactions,
}: TransactionRowContextMenuProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const selectedItems = useSelectedItems();

  // Only the schedules are read during render: they come from the table's
  // shared cache, so a selection change costs each row O(1). Everything that
  // depends on the selection is computed when the menu opens.
  const { schedules } = useCachedSchedules();

  function getSelectedIds(): TransactionEntity['id'][] {
    const ids =
      selectedItems && selectedItems.size > 0
        ? selectedItems
        : [transaction.id];
    return Array.from(new Set(ids));
  }

  function onViewSchedule(selectedIds: TransactionEntity['id'][]) {
    const firstId = selectedIds[0];
    let scheduleId;
    if (isPreviewId(firstId)) {
      const parts = firstId.split('/');
      scheduleId = parts[1];
    } else {
      const trans = getTransaction(firstId);
      scheduleId = trans && trans.schedule;
    }

    if (scheduleId) {
      dispatch(
        pushModal({
          modal: { name: 'schedule-edit', options: { id: scheduleId } },
        }),
      );
    }
  }

  // Everything below reads every selected item, so it is computed only when
  // the menu opens. Doing it during render made each visible row scan the
  // whole selection whenever the selection changed (e.g. "select all").
  function getMenuItems(): ContextMenuItem[] {
    const selectedIds = getSelectedIds();
    const isPreviewSelected = selectedIds.some(id => isPreviewId(id));
    const isTransactionSelected = selectedIds.some(id => !isPreviewId(id));

    if (!isTransactionSelected) {
      const scheduleIds = new Set(selectedIds.map(id => id.split('/')[1]));
      const selectedSchedules = schedules.filter(s => scheduleIds.has(s.id));
      const canBeSkipped = selectedSchedules.every(s => {
        const { date: dateCond } = extractScheduleConds(s._conditions);
        return scheduleIsRecurring(dateCond);
      });
      const canBeCompleted = selectedSchedules.every(s => {
        const { date: dateCond } = extractScheduleConds(s._conditions);
        return !scheduleIsRecurring(dateCond);
      });

      return [
        {
          name: 'view-schedule',
          text: t('View Schedule'),
          onClick: () => onViewSchedule(selectedIds),
          hidden: selectedIds.length !== 1,
        },
        {
          name: 'post-transaction',
          text: t('Post transaction'),
          onClick: () => onScheduleAction('post-transaction', selectedIds),
        },
        {
          name: 'post-transaction-today',
          text: t('Post transaction today'),
          onClick: () =>
            onScheduleAction('post-transaction-today', selectedIds),
        },
        {
          name: 'skip',
          text: t('Skip next scheduled date'),
          onClick: () => onScheduleAction('skip', selectedIds),
          hidden: !canBeSkipped,
        },
        {
          name: 'complete',
          text: t('Mark as completed'),
          onClick: () => onScheduleAction('complete', selectedIds),
          hidden: !canBeCompleted,
        },
      ];
    }

    const transactions = selectedIds.map(id => getTransaction(id));
    const ambiguousDuplication = transactions.some(tx => tx && tx.is_child);
    const linked =
      !isPreviewSelected && transactions.every(tx => tx && tx.schedule);
    const canUnsplitTransactions =
      selectedIds.length > 0 &&
      !isPreviewSelected &&
      transactions.every(tx => tx && !tx.reconciled) &&
      transactions.every(tx => tx && (tx.is_parent || tx.is_child));

    return [
      {
        name: 'duplicate',
        text: t('Duplicate'),
        onClick: () => onDuplicate(selectedIds),
        hidden: ambiguousDuplication,
      },
      {
        name: 'delete',
        text: t('Delete'),
        onClick: () => onDelete(selectedIds),
      },
      {
        name: 'view-schedule',
        text: t('View Schedule'),
        onClick: () => onViewSchedule(selectedIds),
        hidden: !(selectedIds.length === 1 && linked),
      },
      {
        name: 'unlink-schedule',
        text: t('Unlink schedule'),
        onClick: () => onUnlinkSchedule(selectedIds),
        hidden: !linked,
      },
      {
        name: 'link-schedule',
        text: t('Link schedule'),
        onClick: () => onLinkSchedule(selectedIds),
        hidden: linked,
      },
      {
        name: 'create-rule',
        text: t('Create rule'),
        onClick: () => onCreateRule(selectedIds),
        hidden: linked,
      },
      {
        name: 'unsplit-transactions',
        text: t('Unsplit {{count}} transactions', {
          count: selectedIds.length,
        }),
        onClick: () => onMakeAsNonSplitTransactions(selectedIds),
        hidden: !canUnsplitTransactions,
      },
    ];
  }

  useContextMenu({
    triggerRef: rowRef,
    items: getMenuItems,
  });
}
