import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { sendCatch } from '@actual-app/core/platform/client/connection';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import type { Modal as ModalType } from '#modals/modalsSlice';

type ApiKeyModalProps = Extract<ModalType, { name: 'api-key' }>['options'];

export function ApiKeyModal({ fileId, apiKey, onChange }: ApiKeyModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // No try/finally here: React Compiler skips components that use one.
  // sendCatch reports failures in `error` instead of throwing.
  async function submit(close: () => void) {
    setBusy(true);
    setError('');
    if (apiKey) {
      const result = await sendCatch('api-keys-revoke', { id: apiKey.id });
      setBusy(false);
      if (result.error) {
        setError(t('Could not revoke the API key. Please try again.'));
        return;
      }
      close();
    } else {
      const result = await sendCatch('api-keys-create', {
        fileIds: [fileId],
        name: name.trim(),
      });
      setBusy(false);
      if (result.error) {
        setError(t('Could not create the API key. Please try again.'));
        return;
      }
      setSecret(result.data.key);
    }
    onChange();
  }

  return (
    <Modal
      name="api-key"
      ariaLabelledBy="api-key-modal-title"
      containerProps={{ style: { width: apiKey ? 600 : undefined } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={
              <span id="api-key-modal-title">
                {apiKey ? t('Revoke API key') : t('Add API key')}
              </span>
            }
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <form
            onSubmit={event => {
              event.preventDefault();
              if (!busy && !secret && (apiKey || name.trim())) {
                void submit(() => state.close());
              }
            }}
          >
            <View style={{ gap: spacing.md }}>
              {secret ? (
                <>
                  <label htmlFor="new-api-key">
                    <Trans>
                      Make sure to copy this token now. You won't be able to see
                      it again.
                    </Trans>
                  </label>
                  <Input
                    key="secret"
                    id="new-api-key"
                    autoFocus
                    value={secret}
                    readOnly
                    onFocus={event => event.target.select()}
                    style={{ width: '100%' }}
                  />
                </>
              ) : apiKey ? (
                <Text style={{ overflowWrap: 'anywhere' }}>
                  <Trans>
                    Are you sure you want to revoke "{{ name: apiKey.name }}"?
                    Any integrations using it will stop working, but previously
                    downloaded data will not be deleted.
                  </Trans>
                </Text>
              ) : (
                <>
                  <label htmlFor="api-key-name">
                    <Trans>Key name</Trans>
                  </label>
                  <Input
                    id="api-key-name"
                    autoFocus
                    value={name}
                    maxLength={100}
                    required
                    onChange={event => setName(event.target.value)}
                    placeholder={t('e.g. Transaction importer')}
                  />
                </>
              )}
              {error && (
                <Text role="alert" style={{ color: theme.errorText }}>
                  {error}
                </Text>
              )}
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: spacing.sm,
                }}
              >
                {secret ? (
                  <Button onPress={() => state.close()}>
                    <Trans>Done</Trans>
                  </Button>
                ) : (
                  <>
                    <Button
                      autoFocus={!!apiKey}
                      isDisabled={busy}
                      onPress={() => state.close()}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button
                      variant="primary"
                      style={
                        apiKey
                          ? { border: 0, backgroundColor: theme.errorText }
                          : undefined
                      }
                      type="submit"
                      isDisabled={busy || (!apiKey && !name.trim())}
                    >
                      {apiKey ? t('Revoke key') : t('Create key')}
                    </Button>
                  </>
                )}
              </View>
            </View>
          </form>
        </>
      )}
    </Modal>
  );
}
