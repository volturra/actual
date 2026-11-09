import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type { TransObjectLiteral } from '@actual-app/core/types/util';

import { Information } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import type { Modal as ModalType } from '#modals/modalsSlice';
import {
  addGenericErrorNotification,
  addNotification,
} from '#notifications/notificationsSlice';
import { aqlQuery } from '#queries/aqlQuery';
import { useDispatch } from '#redux';

const highlightStyle = { color: theme.pageTextPositive };

type CategorizeRelatedTransactionsModalProps = Extract<
  ModalType,
  { name: 'categorize-related-transactions' }
>['options'];

export function CategorizeRelatedTransactionsModal({
  payee,
  category,
  editedIds,
  uncategorizedCount,
  fromCategories,
}: CategorizeRelatedTransactionsModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [isSaving, setIsSaving] = useState(false);

  return (
    <Modal name="categorize-related-transactions">
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Categorize related transactions')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ maxWidth: 500, lineHeight: 1.5 }}>
            <Paragraph style={{ marginBottom: 10 }}>
              <Trans>
                Also categorize these other{' '}
                <Text style={highlightStyle}>
                  {{ payee: payee.name } as TransObjectLiteral}
                </Text>{' '}
                transactions as{' '}
                <Text style={highlightStyle}>
                  {{ category: category.name } as TransObjectLiteral}
                </Text>
                ?
              </Trans>
            </Paragraph>
            <ul style={{ margin: 0, marginBottom: 10 }}>
              {uncategorizedCount > 0 && (
                <li>
                  <Trans>
                    Uncategorized:{' '}
                    {{ count: uncategorizedCount } as TransObjectLiteral}
                  </Trans>
                </li>
              )}
              {fromCategories.map(fromCategory => (
                <li key={fromCategory.id}>
                  <Trans>
                    In{' '}
                    <Text style={highlightStyle}>
                      {{ category: fromCategory.name } as TransObjectLiteral}
                    </Text>
                    : {{ count: fromCategory.count } as TransObjectLiteral}
                  </Trans>
                </li>
              ))}
            </ul>
            <Information>
              <Trans>
                This also changes the spending in the months these transactions
                are in. You can undo it afterwards.
              </Trans>
            </Information>
            <ModalButtons style={{ marginTop: 20 }} focusButton>
              <Button
                variant="primary"
                autoFocus
                isDisabled={isSaving}
                style={{ marginRight: 10 }}
                onPress={async () => {
                  setIsSaving(true);
                  try {
                    // Look the transactions up now: the offer may be a while
                    // old, and the user may have changed some since
                    const ids = await getMatchingIds(
                      payee.id,
                      fromCategories.map(fromCategory => fromCategory.id),
                      editedIds,
                    );
                    if (ids.length > 0) {
                      await send('transactions-batch-update', {
                        updated: ids.map(id => ({ id, category: category.id })),
                      });
                    } else {
                      dispatch(
                        addNotification({
                          notification: {
                            type: 'message',
                            message: t(
                              'These transactions have changed since, so there is nothing left to categorize.',
                            ),
                          },
                        }),
                      );
                    }
                  } catch {
                    dispatch(addGenericErrorNotification());
                  } finally {
                    // Closing the modal refreshes the transaction list. If
                    // the user dismisses it while saving, the list may only
                    // show the change after its next refresh, as with the
                    // merge payees modal
                    state.close();
                  }
                }}
              >
                <Trans>Categorize</Trans>
              </Button>
              <Button onPress={() => state.close()}>
                <Trans>Do nothing</Trans>
              </Button>
            </ModalButtons>
          </View>
        </>
      )}
    </Modal>
  );
}

/**
 * The payee's on-budget transactions that are uncategorized or in one of
 * `fromCategoryIds`, matching what the server offered
 */
async function getMatchingIds(
  payeeId: string,
  fromCategoryIds: string[],
  editedIds: string[],
) {
  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        payee: payeeId,
        is_parent: false,
        'account.offbudget': false,
        'account.closed': false,
        'account.tombstone': false,
        $or: [{ category: null }, { category: { $oneof: fromCategoryIds } }],
      })
      // Like the server's count: no split parents, and no lines of a
      // deleted split
      .options({ splits: 'inline' })
      .select('id'),
  );
  // Left out like on the server, so an edit the user undid is not redone
  const edited = new Set(editedIds);
  return Array.isArray(data)
    ? data.flatMap(row =>
        typeof row?.id === 'string' && !edited.has(row.id) ? [row.id] : [],
      )
    : [];
}
