import { render, screen } from '@testing-library/react';

import { Value } from './Value';

const payees = [
  { id: 'payee-1', name: 'Grocery Store' },
  { id: 'payee-2', name: 'Landlord' },
];

vi.mock('../../hooks/usePayees', () => ({
  usePayees: () => ({ data: payees }),
}));
vi.mock('../../hooks/useCategories', () => ({
  useCategories: () => ({ data: { list: [], grouped: [] } }),
}));
vi.mock('../../hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [] }),
}));
vi.mock('../../hooks/useFormat', () => ({
  useFormat: () => (value: unknown) => String(value),
}));
vi.mock('../../hooks/useDateFormat', () => ({
  useDateFormat: () => 'MM/dd/yyyy',
}));
vi.mock('../../hooks/useLocale', () => ({
  useLocale: () => undefined,
}));

describe('Value', () => {
  it('describes an item by its name when no describe function is given', () => {
    render(<Value value="payee-1" field="payee" />);
    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
  });

  it('describes each item of a list by its name', () => {
    render(<Value value={['payee-1', 'payee-2']} field="payee" inline />);
    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    expect(screen.getByText('Landlord')).toBeInTheDocument();
  });

  it('uses the given describe function', () => {
    render(
      <Value value="payee-2" field="payee" describe={() => 'Described'} />,
    );
    expect(screen.getByText('Described')).toBeInTheDocument();
  });

  it('describes items from the data prop by name', () => {
    render(
      <Value
        value="rule-1"
        field="rule"
        data={[{ id: 'rule-1', name: 'My rule' }]}
      />,
    );
    expect(screen.getByText('My rule')).toBeInTheDocument();
  });

  it('shows deleted items as deleted', () => {
    render(<Value value="missing" field="payee" />);
    expect(screen.getByText('(deleted)')).toBeInTheDocument();
  });
});
