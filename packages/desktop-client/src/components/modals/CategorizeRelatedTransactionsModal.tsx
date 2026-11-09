import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
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
  const offeredCount = fromCategories.reduce(
    (sum, fromCategory) => sum + fromCategory.count,
    uncategorizedCount,
  );

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
              {offeredCount === 1 ? (
                <Trans>
                  Also categorize this other{' '}
                  <Text style={highlightStyle}>
                    {{ payee: payee.name } as TransObjectLiteral}
                  </Text>{' '}
                  transaction as{' '}
                  <Text style={highlightStyle}>
                    {{ category: category.name } as TransObjectLiteral}
                  </Text>
                  ?
                </Trans>
              ) : (
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
              )}
            </Paragraph>
            <ul style={{ margin: 0, marginBottom: 10 }}>
              {uncategorizedCount > 0 && (
                <li>
                  {uncategorizedCount === 1 ? (
                    <Trans>1 uncategorized</Trans>
                  ) : (
                    <Trans>
                      {{ count: uncategorizedCount } as TransObjectLiteral}{' '}
                      uncategorized
                    </Trans>
                  )}
                </li>
              )}
              {fromCategories.map(fromCategory => (
                <li key={fromCategory.id}>
                  <Trans>
                    {{ count: fromCategory.count } as TransObjectLiteral} in{' '}
                    <Text style={highlightStyle}>
                      {{ category: fromCategory.name } as TransObjectLiteral}
                    </Text>
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
                    // The server selects the transactions again with the
                    // query it counted them with: the offer may be a while
                    // old, and the user may have changed some since
                    const changedCount = await send(
                      'transactions-categorize-related',
                      {
                        payeeId: payee.id,
                        categoryId: category.id,
                        fromCategoryIds: fromCategories.map(
                          fromCategory => fromCategory.id,
                        ),
                        excludeIds: editedIds,
                      },
                    );
                    if (changedCount === 0) {
                      dispatch(
                        addNotification({
                          notification: {
                            type: 'message',
                            message: t(
                              'Nothing left to categorize: these transactions have changed since the offer was made.',
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
