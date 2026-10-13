import { render, screen } from '@testing-library/react';

import { SelectCell } from './table';

function renderSelectCell(props: Partial<Parameters<typeof SelectCell>[0]>) {
  return render(
    <SelectCell
      exposed
      focused={false}
      selected
      onSelect={vi.fn()}
      onEdit={vi.fn()}
      {...props}
    />,
  );
}

describe('SelectCell', () => {
  it('shows a checkmark by default when selected', () => {
    renderSelectCell({});
    expect(
      screen.getByTestId('cell-button').querySelector('svg'),
    ).not.toBeNull();
  });

  it('shows no icon when not selected', () => {
    renderSelectCell({ selected: false });
    expect(screen.getByTestId('cell-button').querySelector('svg')).toBeNull();
  });

  it('renders a custom icon instead of the checkmark', () => {
    renderSelectCell({ icon: <span data-testid="custom-icon" /> });
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
    expect(screen.getByTestId('cell-button').querySelector('svg')).toBeNull();
  });

  it('renders no icon when the icon is explicitly null', () => {
    renderSelectCell({ icon: null });
    expect(screen.getByTestId('cell-button').querySelector('svg')).toBeNull();
  });
});
