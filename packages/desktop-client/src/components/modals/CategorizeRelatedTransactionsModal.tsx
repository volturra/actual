import React, { useState } from 'react';
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

const highlightStyle = { color: theme.pageTextPositive };

type CategorizeRelatedTransactionsModalProps = Extract<
  ModalType,
  { name: 'categorize-related-transactions' }
>['options'];

export function CategorizeRelatedTransactionsModal({
  payee,
  category,
  transactionIds,
  uncategorizedCount,
  fromCategories,
}: CategorizeRelatedTransactionsModalProps) {
  const { t } = useTranslation();
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
                This also changes the spending of past months in these
                categories. You can undo it afterwards.
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
                    await send('transactions-batch-update', {
                      updated: transactionIds.map(id => ({
                        id,
                        category: category.id,
                      })),
                      // This is the follow-up the user just accepted
                      detectRelatedChanges: false,
                    });
                  } finally {
                    // Closing the modal refreshes the transaction list
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
