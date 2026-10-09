import { fireEvent, render, screen } from '@testing-library/react';

import { Value } from './Value';

const payees = [
  { id: 'payee-1', name: 'Grocery Store' },
  { id: 'payee-2', name: 'Landlord' },
];
const categories = [{ id: 'cat-1', name: 'Food' }];
const categoryGroups = [{ id: 'group-1', name: 'Essentials' }];
const accounts = [{ id: 'acct-1', name: 'Checking' }];

vi.mock('#hooks/usePayees', () => ({
  usePayees: () => ({ data: payees }),
}));
vi.mock('#hooks/useCategories', () => ({
  useCategories: () => ({
    data: { list: categories, grouped: categoryGroups },
  }),
}));
vi.mock('#hooks/useAccounts', () => ({
  useAccounts: () => ({ data: accounts }),
}));
vi.mock('#hooks/useFormat', () => ({
  useFormat: () => (value: unknown, type: string) => `${type}:${value}`,
}));
vi.mock('#hooks/useDateFormat', () => ({
  useDateFormat: () => 'MM/dd/yyyy',
}));
vi.mock('#hooks/useLocale', () => ({
  useLocale: () => undefined,
}));

describe('Value', () => {
  it('describes an item by its name', () => {
    render(<Value value="payee-1" field="payee" />);
    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
  });

  it.each([
    ['category', 'cat-1', 'Food'],
    ['category_group', 'group-1', 'Essentials'],
    ['account', 'acct-1', 'Checking'],
  ])('describes a %s by its name', (field, value, name) => {
    render(<Value value={value} field={field} />);
    expect(screen.getByText(name)).toBeInTheDocument();
  });

  it('describes each item of a list by its name', () => {
    const { container } = render(
      <Value value={['payee-1', 'payee-2']} field="payee" inline />,
    );
    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    expect(screen.getByText('Landlord')).toBeInTheDocument();
    expect(container).toHaveTextContent('[Grocery Store, Landlord]', {
      normalizeWhitespace: false,
    });
  });

  it('shows an empty list as empty', () => {
    render(<Value value={[]} field="payee" />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('collapses lists of more than 4 items until expanded', () => {
    const value = ['a', 'b', 'c', 'd', 'e'];
    render(<Value value={value} field="notes" inline />);
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.queryByText('d')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('2 more items...'));

    for (const item of value) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
    expect(screen.queryByText('2 more items...')).not.toBeInTheDocument();
  });

  it('formats a date with the date format', () => {
    render(<Value value="2024-03-05" field="date" />);
    expect(screen.getByText('03/05/2024')).toBeInTheDocument();
  });

  it('formats an amount as financial', () => {
    render(<Value value={1234} field="amount" />);
    expect(screen.getByText('financial:1234')).toBeInTheDocument();
  });

  it('shows a between value as both numbers', () => {
    const { container } = render(
      <Value value={{ num1: 100, num2: 200 }} field="amount" />,
    );
    expect(screen.getByText('financial:100')).toBeInTheDocument();
    expect(screen.getByText('financial:200')).toBeInTheDocument();
    expect(container).toHaveTextContent('financial:100 and financial:200');
  });

  it('returns the raw value without describing it when valueIsRaw is set', () => {
    render(<Value value="payee-1" field="payee" valueIsRaw />);
    expect(screen.getByText('payee-1')).toBeInTheDocument();
    expect(screen.queryByText('Grocery Store')).not.toBeInTheDocument();
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
