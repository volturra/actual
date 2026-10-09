import { useMemo } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { q } from '@actual-app/core/shared/query';
import {
  extractScheduleConds,
  scheduleIsRecurring,
} from '@actual-app/core/shared/schedules';
import { isPreviewId } from '@actual-app/core/shared/transactions';
import type { TransactionEntity } from '@actual-app/core/types/models';

import type { ContextMenuItem } from '#contextmenu/types';
import { useContextMenu } from '#hooks/useContextMenu';
import { useSchedules } from '#hooks/useSchedules';
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

  const selectedIds = useMemo(() => {
    const ids =
      selectedItems && selectedItems.size > 0
        ? selectedItems
        : [transaction.id];
    return Array.from(new Set(ids));
  }, [transaction, selectedItems]);

  const scheduleIds = useMemo(() => {
    return selectedIds
      .filter(id => isPreviewId(id))
      .map(id => id.split('/')[1]);
  }, [selectedIds]);

  const scheduleQuery = useMemo(() => {
    if (scheduleIds.length === 0) {
      return undefined;
    }
    return q('schedules')
      .filter({ id: { $oneof: scheduleIds } })
      .select('*');
  }, [scheduleIds]);

  const { schedules: selectedSchedules } = useSchedules({
    query: scheduleQuery,
  });

  function onViewSchedule() {
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

  // Everything below reads every selected transaction, so it is computed
  // only when the menu opens. Doing it during render made each visible row
  // scan the whole selection whenever the selection changed (e.g. "select
  // all").
  function getMenuItems(): ContextMenuItem[] {
    const isPreviewSelected = selectedIds.some(id => isPreviewId(id));
    const isTransactionSelected = selectedIds.some(id => !isPreviewId(id));

    if (!isTransactionSelected) {
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
          onClick: onViewSchedule,
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
        onClick: onViewSchedule,
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
