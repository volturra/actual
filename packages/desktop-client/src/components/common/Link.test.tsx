import React from 'react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Link } from './Link';

function renderInRouter(element: ReactNode) {
  const router = createMemoryRouter([{ path: '*', element }], {
    initialEntries: ['/budget'],
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Link variant="button"', () => {
  it('navigates when `to` is set', async () => {
    const onPress = vi.fn();
    const router = renderInRouter(
      <Link variant="button" to="/accounts" onPress={onPress}>
        Go
      </Link>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/accounts');
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('does not navigate when `to` is not set, but still calls onPress', async () => {
    const onPress = vi.fn();
    const router = renderInRouter(
      <Link variant="button" onPress={onPress}>
        Next
      </Link>,
    );
    const initialKey = router.state.location.key;

    const button = screen.getByRole('button', { name: 'Next' });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(onPress).toHaveBeenCalledTimes(2);
    // No history entry was pushed or replaced by the clicks.
    expect(router.state.location.pathname).toBe('/budget');
    expect(router.state.location.key).toBe(initialKey);
    expect(router.state.historyAction).toBe('POP');
  });
});
