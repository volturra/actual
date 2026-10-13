import React from 'react';
import { I18nextProvider } from 'react-i18next';

import type { PayeeEntity } from '@actual-app/core/types/models';
import { act, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';

import { TestProviders } from '#mocks';

import { PayeesList } from './PayeesList';

vi.mock('@use-gesture/react', () => ({
  useDrag: vi.fn().mockReturnValue(() => ({})),
}));

const payees: PayeeEntity[] = [
  { id: 'payee-1', name: 'Grocery Store', favorite: false },
  {
    id: 'payee-2',
    name: 'Savings',
    favorite: false,
    transfer_acct: 'account-1',
  },
];

async function createI18n() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    nsSeparator: false,
    keySeparator: false,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      fr: { translation: { 'Transfer: {{name}}': 'Virement : {{name}}' } },
    },
  });
  return i18n;
}

function renderPayeesList(i18n: Awaited<ReturnType<typeof createI18n>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TestProviders>
        <PayeesList
          payees={payees}
          ruleCounts={new Map([['payee-1', 2]])}
          onPayeePress={vi.fn()}
          onPayeeDelete={vi.fn()}
          onPayeeRuleAction={vi.fn()}
        />
      </TestProviders>
    </I18nextProvider>,
  );
}

describe('PayeesList', () => {
  it('labels transfer payees and regular payees', async () => {
    renderPayeesList(await createI18n());

    expect(
      screen.getByRole('row', { name: 'Grocery Store' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: 'Transfer: Savings' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('Transfer: Savings')).toHaveTextContent(
      'Transfer: Savings',
    );
  });

  it('updates the transfer label when the language changes', async () => {
    const i18n = await createI18n();
    renderPayeesList(i18n);

    expect(screen.getByTitle('Transfer: Savings')).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    expect(
      screen.getByRole('row', { name: 'Virement : Savings' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('Virement : Savings')).toHaveTextContent(
      'Virement : Savings',
    );
    expect(screen.queryByText('Transfer: Savings')).not.toBeInTheDocument();
  });
});
