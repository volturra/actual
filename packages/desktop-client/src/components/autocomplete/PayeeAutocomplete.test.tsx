import type { ComponentPropsWithoutRef } from 'react';

import { generateAccount } from '@actual-app/core/mocks';
import type {
  AccountEntity,
  NearbyPayeeEntity,
  PayeeEntity,
} from '@actual-app/core/types/models';
import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { Screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { AuthProvider } from '#auth/AuthProvider';
import { useAccounts } from '#hooks/useAccounts';
import { useNearbyPayees } from '#hooks/useNearbyPayees';
import { usePayees } from '#hooks/usePayees';
import { createTestQueryClient, TestProviders } from '#mocks';
import { payeeQueries } from '#payees';

import { CreatePayeeButton, PayeeAutocomplete } from './PayeeAutocomplete';
import type { PayeeAutocompleteProps } from './PayeeAutocomplete';

const PAYEE_SELECTOR = '[data-testid][role=option]';
const PAYEE_SECTION_SELECTOR = '[data-testid$="-item-group"]';
const ALL_PAYEE_ITEMS_SELECTOR = '[data-testid$="-payee-item"]';

const payees = [
  makePayee('Bob', { favorite: true }),
  makePayee('Alice', { favorite: true }),
  makePayee('This guy on the side of the road'),
];

const accounts: AccountEntity[] = [
  generateAccount('Bank of Montreal', false, false),
];
const defaultProps = {
  value: null,
  embedded: true,
  payees,
  accounts,
};

function makePayee(name: string, options?: { favorite: boolean }): PayeeEntity {
  return {
    id: name.toLowerCase() + '-id',
    name,
    favorite: options?.favorite ? true : false,
    transfer_acct: undefined,
  };
}

function makeNearbyPayee(name: string, distance: number): NearbyPayeeEntity {
  const id = name.toLowerCase() + '-id';
  return {
    payee: {
      id,
      name,
      favorite: false,
      transfer_acct: undefined,
    },
    location: {
      id: id + '-loc',
      payee_id: id,
      latitude: 0,
      longitude: 0,
      created_at: 0,
      distance,
    },
  };
}

function extractPayeesAndHeaderNames(
  screen: Screen,
  itemSelector: string = PAYEE_SELECTOR,
) {
  const autocompleteElement = screen.getByTestId('autocomplete');

  // Get all elements that match either selector, but query them separately
  // and then sort by their position in the DOM to maintain document order
  const headers = [
    ...autocompleteElement.querySelectorAll(PAYEE_SECTION_SELECTOR),
  ];
  const items = [...autocompleteElement.querySelectorAll(itemSelector)];

  // Combine all elements and sort by their position in the DOM
  const allElements = [...headers, ...items];
  allElements.sort((a, b) => {
    // Compare document position to maintain DOM order
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1;
  });

  return allElements
    .map(e => e.getAttribute('data-testid'))
    .map(firstOrIncorrect);
}

// Not good, see `Autocomplete.js` for details
function waitForAutocomplete() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function clickAutocomplete(autocomplete: HTMLElement) {
  const input = autocomplete.querySelector(`input`);
  if (input != null) {
    await userEvent.click(input);
  }
  await waitForAutocomplete();
}

vi.mock('#hooks/useLocationPermission', () => ({
  useLocationPermission: vi.fn(() => ({
    isGranted: true,
    isPending: false,
    requestPermission: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('#hooks/useNearbyPayees', () => ({
  useNearbyPayees: vi.fn(),
}));

// Pass through to the real hooks unless a test overrides them.
vi.mock('#hooks/usePayees', async importOriginal => {
  const actual = await importOriginal<{ usePayees: typeof usePayees }>();
  return { ...actual, usePayees: vi.fn(actual.usePayees) };
});

vi.mock('#hooks/useAccounts', async importOriginal => {
  const actual = await importOriginal<{ useAccounts: typeof useAccounts }>();
  return { ...actual, useAccounts: vi.fn(actual.useAccounts) };
});

function firstOrIncorrect(id: string | null): string {
  return id?.split('-', 1)[0] || 'incorrect';
}

function mockNearbyPayeesResult(
  data: NearbyPayeeEntity[],
): UseQueryResult<NearbyPayeeEntity[], Error> {
  return mockQueryResult(data);
}

function mockQueryResult<T>(data: T): UseQueryResult<T, Error> {
  return {
    data,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: 'idle',
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    isEnabled: true,
    refetch: vi.fn(),
    status: 'success',
  };
}

function mockPendingQueryResult<T>(): UseQueryResult<T, Error> {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: 'fetching',
    isError: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isFetching: true,
    isInitialLoading: true,
    isLoading: true,
    isLoadingError: false,
    isPaused: false,
    isPending: true,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: true,
    isSuccess: false,
    isEnabled: true,
    refetch: vi.fn(),
    status: 'pending',
  };
}

function renderCreatePayeeButtonWithMarker(
  props: ComponentPropsWithoutRef<typeof CreatePayeeButton>,
) {
  return (
    <CreatePayeeButton
      {...props}
      data-highlighted={props.highlighted || undefined}
    />
  );
}

// The create-payee button plus every payee item, in render order.
function renderedItems() {
  // Queried from the document: the autocomplete menu is not rendered at all
  // when there is nothing to show.
  return [
    ...document.body.querySelectorAll(
      `[data-testid="create-payee-button"], ${ALL_PAYEE_ITEMS_SELECTOR}`,
    ),
  ];
}

function itemName(e: Element) {
  return firstOrIncorrect(e.getAttribute('data-testid'));
}

function highlightedItemNames() {
  return renderedItems()
    .filter(e => e.hasAttribute('data-highlighted'))
    .map(itemName);
}

describe('PayeeAutocomplete.getPayeeSuggestions', () => {
  const queryClient = createTestQueryClient();

  beforeEach(() => {
    vi.mocked(usePayees).mockReset();
    vi.mocked(useAccounts).mockReset();
    vi.mocked(useNearbyPayees).mockReturnValue(mockNearbyPayeesResult([]));
    queryClient.setQueryData(payeeQueries.listCommon().queryKey, []);
  });

  function renderPayeeAutocomplete(
    props?: Partial<PayeeAutocompleteProps>,
    onSelect: (id: string, value: string) => void = vi.fn(),
    value: string | null = null,
  ): HTMLElement {
    const autocompleteProps = {
      ...defaultProps,
      ...props,
    };

    render(
      <TestProviders queryClient={queryClient}>
        <AuthProvider>
          <div data-testid="autocomplete-test">
            <PayeeAutocomplete
              {...autocompleteProps}
              onSelect={onSelect}
              type="single"
              value={value}
              embedded={false}
            />
          </div>
        </AuthProvider>
      </TestProviders>,
    );
    return screen.getByTestId('autocomplete-test');
  }

  test('favorites get sorted alphabetically', async () => {
    const autocomplete = renderPayeeAutocomplete();
    await clickAutocomplete(autocomplete);

    expect(
      [
        ...screen.getByTestId('autocomplete').querySelectorAll(PAYEE_SELECTOR),
      ].map(e => e.getAttribute('data-testid')),
    ).toStrictEqual([
      'Alice-payee-item',
      'Bob-payee-item',
      'This guy on the side of the road-payee-item',
    ]);
  });

  test('list with less than the maximum favorites adds common payees', async () => {
    //Note that the payees list assumes the payees are already sorted
    const payees: PayeeEntity[] = [
      makePayee('Alice'),
      makePayee('Bob'),
      makePayee('Eve', { favorite: true }),
      makePayee('Bruce'),
      makePayee('Carol'),
      makePayee('Natasha'),
      makePayee('Steve'),
      makePayee('Tony'),
    ];
    queryClient.setQueryData(payeeQueries.listCommon().queryKey, [
      makePayee('Bruce'),
      makePayee('Natasha'),
      makePayee('Steve'),
      makePayee('Tony'),
      makePayee('Carol'),
    ]);
    const expectedPayeeOrder = [
      'Suggested Payees',
      'Eve',
      'Bruce',
      'Natasha',
      'Steve',
      'Tony',
      'Payees',
      'Alice',
      'Bob',
      'Carol',
    ];
    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    expect(extractPayeesAndHeaderNames(screen)).toStrictEqual(
      expectedPayeeOrder,
    );
  });

  test('list with more than the maximum favorites only lists favorites', async () => {
    //Note that the payees list assumes the payees are already sorted
    const payees = [
      makePayee('Alice', { favorite: true }),
      makePayee('Bob', { favorite: true }),
      makePayee('Eve', { favorite: true }),
      makePayee('Bruce', { favorite: true }),
      makePayee('Carol', { favorite: true }),
      makePayee('Natasha'),
      makePayee('Steve'),
      makePayee('Tony', { favorite: true }),
    ];
    queryClient.setQueryData(payeeQueries.listCommon().queryKey, [
      makePayee('Bruce'),
      makePayee('Natasha'),
      makePayee('Steve'),
      makePayee('Tony'),
      makePayee('Carol'),
    ]);
    const expectedPayeeOrder = [
      'Suggested Payees',
      'Alice',
      'Bob',
      'Bruce',
      'Carol',
      'Eve',
      'Tony',
      'Payees',
      'Natasha',
      'Steve',
    ];
    const autocomplete = renderPayeeAutocomplete({ payees });
    await clickAutocomplete(autocomplete);

    expect(extractPayeesAndHeaderNames(screen)).toStrictEqual(
      expectedPayeeOrder,
    );
  });

  test('nearby payees appear in their own section before other payees', async () => {
    const nearbyPayees = [
      makeNearbyPayee('Coffee Shop', 0.3),
      makeNearbyPayee('Grocery Store', 1.2),
    ];
    const payees = [makePayee('Alice'), makePayee('Bob')];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    expect(
      extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
    ).toStrictEqual([
      'Nearby Payees',
      'Coffee Shop',
      'Grocery Store',
      'Payees',
      'Alice',
      'Bob',
    ]);
  });

  test('nearby payees are filtered by search input', async () => {
    const nearbyPayees = [
      makeNearbyPayee('Coffee Shop', 0.3),
      makeNearbyPayee('Grocery Store', 1.2),
    ];
    const payees = [makePayee('Alice'), makePayee('Bob')];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    const autocomplete = renderPayeeAutocomplete({ payees });
    await clickAutocomplete(autocomplete);

    const input = autocomplete.querySelector('input')!;
    await userEvent.type(input, 'Coffee');
    await waitForAutocomplete();

    const names = extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR);
    expect(names).toContain('Nearby Payees');
    expect(names).toContain('Coffee Shop');
    expect(names).not.toContain('Grocery Store');
    expect(names).not.toContain('Alice');
    expect(names).not.toContain('Bob');
  });

  test('nearby payees coexist with favorites and common payees', async () => {
    const nearbyPayees = [makeNearbyPayee('Coffee Shop', 0.3)];
    const payees = [
      makePayee('Alice'),
      makePayee('Bob'),
      makePayee('Eve', { favorite: true }),
      makePayee('Carol'),
    ];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );
    queryClient.setQueryData(payeeQueries.listCommon().queryKey, [
      makePayee('Bob'),
      makePayee('Carol'),
    ]);

    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    expect(
      extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
    ).toStrictEqual([
      'Nearby Payees',
      'Coffee Shop',
      'Suggested Payees',
      'Eve',
      'Bob',
      'Carol',
      'Payees',
      'Alice',
    ]);
  });

  test('a payee appearing in both nearby and favorites shows in both sections', async () => {
    const nearbyPayees = [makeNearbyPayee('Eve', 0.5)];
    const payees = [makePayee('Alice'), makePayee('Eve', { favorite: true })];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    expect(
      extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
    ).toStrictEqual([
      'Nearby Payees',
      'Eve',
      'Suggested Payees',
      'Eve',
      'Payees',
      'Alice',
    ]);
  });

  test('list with no favorites shows just the payees list', async () => {
    //Note that the payees list assumes the payees are already sorted
    const payees = [
      makePayee('Alice'),
      makePayee('Bob'),
      makePayee('Eve'),
      makePayee('Natasha'),
      makePayee('Steve'),
    ];
    const expectedPayeeOrder = ['Alice', 'Bob', 'Eve', 'Natasha', 'Steve'];
    const autocomplete = renderPayeeAutocomplete({ payees });
    await clickAutocomplete(autocomplete);

    expect(
      [
        ...screen
          .getByTestId('autocomplete')
          .querySelectorAll('[data-testid][role=option]'),
      ]
        .map(e => e.getAttribute('data-testid'))
        .flatMap(firstOrIncorrect),
    ).toStrictEqual(expectedPayeeOrder);
    expect(
      [
        ...screen
          .getByTestId('autocomplete')
          .querySelectorAll('[data-testid$="-item-group"]'),
      ]
        .map(e => e.getAttribute('data-testid'))
        .flatMap(firstOrIncorrect),
    ).toStrictEqual(['Payees']);
  });

  test('arrow keys highlight items in render order across all sections', async () => {
    const nearbyPayees = [
      makeNearbyPayee('Coffee Shop', 0.3),
      makeNearbyPayee('Grocery Store', 1.2),
    ];
    const payees: PayeeEntity[] = [
      makePayee('Alice'),
      makePayee('Bob'),
      makePayee('Eve', { favorite: true }),
      {
        id: 'transfer-id',
        name: 'Bank of Montreal',
        favorite: false,
        transfer_acct: accounts[0].id,
      },
    ];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    const items = () => [
      ...screen
        .getByTestId('autocomplete')
        .querySelectorAll(ALL_PAYEE_ITEMS_SELECTOR),
    ];
    const highlightedNames = () =>
      items()
        .filter(e => e.hasAttribute('data-highlighted'))
        .map(e => firstOrIncorrect(e.getAttribute('data-testid')));
    const allNames = items().map(e =>
      firstOrIncorrect(e.getAttribute('data-testid')),
    );

    expect(allNames).toStrictEqual([
      'Coffee Shop',
      'Grocery Store',
      'Eve',
      'Alice',
      'Bob',
      'Bank of Montreal',
    ]);

    const visited: string[][] = [];
    for (let i = 0; i < allNames.length; i++) {
      await userEvent.keyboard('{ArrowDown}');
      visited.push(highlightedNames());
    }
    expect(visited).toStrictEqual(allNames.map(name => [name]));
  });

  test('arrow keys highlight the create-payee item first, then the matches', async () => {
    const nearbyPayees = [
      makeNearbyPayee('Corner Shop', 0.3),
      makeNearbyPayee('Bakery', 1.2),
    ];
    const payees = [
      makePayee('Alice'),
      makePayee('Cora', { favorite: true }),
      makePayee('Coral'),
    ];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    const autocomplete = renderPayeeAutocomplete({
      payees,
      renderCreatePayeeButton: renderCreatePayeeButtonWithMarker,
    });
    await clickAutocomplete(autocomplete);
    await userEvent.type(autocomplete.querySelector('input')!, 'cor');
    await waitForAutocomplete();

    const allNames = renderedItems().map(itemName);
    expect(allNames).toStrictEqual(['create', 'Corner Shop', 'Cora', 'Coral']);

    // The first match starts highlighted, one above it is the create item.
    expect(highlightedItemNames()).toStrictEqual(['Corner Shop']);
    await userEvent.keyboard('{ArrowUp}');
    expect(highlightedItemNames()).toStrictEqual(['create']);

    const visited: string[][] = [];
    for (let i = 1; i < allNames.length; i++) {
      await userEvent.keyboard('{ArrowDown}');
      visited.push(highlightedItemNames());
    }
    expect(visited).toStrictEqual(allNames.slice(1).map(name => [name]));
  });

  test('arrow keys highlight the create-payee item when nothing matches', async () => {
    const autocomplete = renderPayeeAutocomplete({
      renderCreatePayeeButton: renderCreatePayeeButtonWithMarker,
    });
    await clickAutocomplete(autocomplete);
    await userEvent.type(autocomplete.querySelector('input')!, 'Zzz');
    await waitForAutocomplete();

    expect(renderedItems().map(itemName)).toStrictEqual(['create']);
    await userEvent.keyboard('{ArrowDown}');
    expect(highlightedItemNames()).toStrictEqual(['create']);
  });

  test('arrow keys skip an empty suggested section between nearby and payees', async () => {
    const nearbyPayees = [
      makeNearbyPayee('Coffee Shop', 0.3),
      makeNearbyPayee('Grocery Store', 1.2),
    ];
    const payees: PayeeEntity[] = [
      makePayee('Alice'),
      makePayee('Bob'),
      {
        id: 'transfer-id',
        name: 'Bank of Montreal',
        favorite: false,
        transfer_acct: accounts[0].id,
      },
    ];
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult(nearbyPayees),
    );

    await clickAutocomplete(renderPayeeAutocomplete({ payees }));

    expect(
      extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
    ).not.toContain('Suggested Payees');
    const allNames = renderedItems().map(itemName);
    expect(allNames).toStrictEqual([
      'Coffee Shop',
      'Grocery Store',
      'Alice',
      'Bob',
      'Bank of Montreal',
    ]);

    const visited: string[][] = [];
    for (let i = 0; i < allNames.length; i++) {
      await userEvent.keyboard('{ArrowDown}');
      visited.push(highlightedItemNames());
    }
    expect(visited).toStrictEqual(allNames.map(name => [name]));
  });

  test('falls back to an empty list when the payee and account hooks have no data', async () => {
    vi.mocked(usePayees).mockReturnValue(mockPendingQueryResult());
    vi.mocked(useAccounts).mockReturnValue(mockPendingQueryResult());

    await clickAutocomplete(
      renderPayeeAutocomplete({ payees: undefined, accounts: undefined }),
    );

    expect(screen.getByLabelText('Payee')).toBeInTheDocument();
    expect(renderedItems()).toStrictEqual([]);
  });

  test('uses the hook data when payees and accounts are omitted', async () => {
    vi.mocked(usePayees).mockReturnValue(
      mockQueryResult([makePayee('Hook Payee')]),
    );
    vi.mocked(useAccounts).mockReturnValue(mockQueryResult(accounts));

    await clickAutocomplete(
      renderPayeeAutocomplete({ payees: undefined, accounts: undefined }),
    );

    expect(renderedItems().map(itemName)).toStrictEqual(['Hook Payee']);
  });

  test('does not use the hook data when empty lists are passed explicitly', async () => {
    vi.mocked(usePayees).mockReturnValue(
      mockQueryResult([makePayee('Hook Payee')]),
    );
    vi.mocked(useAccounts).mockReturnValue(mockQueryResult(accounts));

    await clickAutocomplete(
      renderPayeeAutocomplete({ payees: [], accounts: [] }),
    );

    expect(screen.getByLabelText('Payee')).toBeInTheDocument();
    expect(renderedItems()).toStrictEqual([]);
  });

  describe('when the user has typed a search', () => {
    // A frequent payee that only matches 'Nation' as a scattered
    // subsequence (n…a…t…i…o…n), the case that prompted this fix.
    const scatteredMatch = makePayee(
      'Requested Transfer to Andrey Taran (First New York Fcu Savings)',
    );
    const typedPayees = [
      makePayee('National Aquarium'),
      makePayee('National Grid'),
      scatteredMatch,
      makePayee('Third Generation Lawn and Landscape'),
    ];

    async function typeInto(autocomplete: HTMLElement, text: string) {
      await clickAutocomplete(autocomplete);
      await userEvent.type(autocomplete.querySelector('input')!, text);
      await waitForAutocomplete();
    }

    test('ranks a weak common-payee match below stronger matches', async () => {
      queryClient.setQueryData(payeeQueries.listCommon().queryKey, [
        scatteredMatch,
      ]);
      await typeInto(
        renderPayeeAutocomplete({ payees: typedPayees }),
        'Nation',
      );

      expect(
        extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
      ).toStrictEqual([
        'Payees',
        'National Grid',
        'National Aquarium',
        'Third Generation Lawn and Landscape',
        'Requested Transfer to Andrey Taran (First New York Fcu Savings)',
      ]);
    });

    test('ranks a weak favorite match below stronger matches', async () => {
      await typeInto(
        renderPayeeAutocomplete({
          payees: typedPayees.map(p =>
            p === scatteredMatch ? { ...p, favorite: true } : p,
          ),
        }),
        'Nation',
      );

      expect(
        extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
      ).toStrictEqual([
        'Payees',
        'National Grid',
        'National Aquarium',
        'Third Generation Lawn and Landscape',
        'Requested Transfer to Andrey Taran (First New York Fcu Savings)',
      ]);
    });

    test('Enter selects the best match, not a weak common-payee match', async () => {
      queryClient.setQueryData(payeeQueries.listCommon().queryKey, [
        scatteredMatch,
      ]);
      const onSelect = vi.fn();
      await typeInto(
        renderPayeeAutocomplete({ payees: typedPayees }, onSelect),
        'Nation',
      );
      await userEvent.keyboard('{Enter}');

      expect(onSelect).toHaveBeenCalledWith(
        'national grid-id',
        'National Grid',
      );
    });

    test('the highlighted item is the value the field reports', async () => {
      // Leaving the field (e.g. with Tab) commits the value from onUpdate,
      // while Enter selects the highlighted row. Both must agree.
      const onUpdate = vi.fn();
      const onSelect = vi.fn();
      const transfer: PayeeEntity = {
        id: 'transfer-id',
        name: 'National Bank',
        favorite: false,
        transfer_acct: accounts[0].id,
      };
      // fzf ranks the transfer ahead of 'Nationwide Insurance' (tied score,
      // shorter name), but it is rendered after it in its own section.
      await typeInto(
        renderPayeeAutocomplete(
          {
            payees: [makePayee('Nationwide Insurance'), transfer],
            onUpdate,
          },
          onSelect,
        ),
        'Nation',
      );

      expect(
        extractPayeesAndHeaderNames(screen, ALL_PAYEE_ITEMS_SELECTOR),
      ).toStrictEqual([
        'Payees',
        'Nationwide Insurance',
        'Transfer To/From',
        'National Bank',
      ]);
      expect(highlightedItemNames()).toStrictEqual(['Nationwide Insurance']);
      expect(onUpdate.mock.lastCall?.[0]).toBe('nationwide insurance-id');

      await userEvent.keyboard('{ArrowDown}');
      expect(highlightedItemNames()).toStrictEqual(['National Bank']);
      expect(onUpdate.mock.lastCall?.[0]).toBe('transfer-id');

      await userEvent.keyboard('{Enter}');
      expect(onSelect).toHaveBeenCalledWith('transfer-id', 'National Bank');
    });
  });

  describe('the reported value follows the highlighted row', () => {
    test('when nearby payees are shown while typing', async () => {
      const onUpdate = vi.fn();
      const onSelect = vi.fn();
      vi.mocked(useNearbyPayees).mockReturnValue(
        mockNearbyPayeesResult([makeNearbyPayee('Nationwide Insurance', 0.3)]),
      );
      const autocomplete = renderPayeeAutocomplete(
        {
          payees: [
            makePayee('National Grid'),
            makePayee('Nationwide Insurance'),
          ],
          onUpdate,
          renderCreatePayeeButton: renderCreatePayeeButtonWithMarker,
        },
        onSelect,
      );
      await clickAutocomplete(autocomplete);
      await userEvent.type(autocomplete.querySelector('input')!, 'Nation');
      await waitForAutocomplete();

      expect(renderedItems().map(itemName)).toStrictEqual([
        'create',
        'Nationwide Insurance',
        'National Grid',
        'Nationwide Insurance',
      ]);
      expect(highlightedItemNames()).toStrictEqual(['Nationwide Insurance']);
      expect(onUpdate.mock.lastCall?.[0]).toBe('nationwide insurance-id');

      await userEvent.keyboard('{ArrowDown}');
      expect(highlightedItemNames()).toStrictEqual(['National Grid']);
      expect(onUpdate.mock.lastCall?.[0]).toBe('national grid-id');

      await userEvent.keyboard('{Enter}');
      expect(onSelect).toHaveBeenCalledWith(
        'national grid-id',
        'National Grid',
      );
    });

    test('when a favorite is a transfer and nothing is typed', async () => {
      const onUpdate = vi.fn();
      const payees: PayeeEntity[] = [
        makePayee('Alice'),
        makePayee('Zed', { favorite: true }),
        {
          id: 'transfer-id',
          name: 'Savings',
          favorite: true,
          transfer_acct: accounts[0].id,
        },
      ];
      await clickAutocomplete(renderPayeeAutocomplete({ payees, onUpdate }));

      const allNames = renderedItems().map(itemName);
      expect(allNames).toStrictEqual(['Zed', 'Alice', 'Savings']);

      const ids: Record<string, string> = {
        Zed: 'zed-id',
        Alice: 'alice-id',
        Savings: 'transfer-id',
      };
      for (const name of allNames) {
        await userEvent.keyboard('{ArrowDown}');
        expect(highlightedItemNames()).toStrictEqual([name]);
        expect(onUpdate.mock.lastCall?.[0]).toBe(ids[name]);
      }
    });

    test('when the field already has a payee and nothing is typed', async () => {
      const onUpdate = vi.fn();
      const payees = [
        makePayee('Alice'),
        makePayee('Bob'),
        makePayee('National Grid'),
      ];
      await clickAutocomplete(
        renderPayeeAutocomplete(
          { payees, onUpdate },
          vi.fn(),
          'national grid-id',
        ),
      );

      const allNames = renderedItems().map(itemName);
      expect(allNames).toStrictEqual(['Alice', 'Bob', 'National Grid']);

      const ids: Record<string, string> = {
        Alice: 'alice-id',
        Bob: 'bob-id',
        'National Grid': 'national grid-id',
      };
      for (const name of allNames) {
        await userEvent.keyboard('{ArrowDown}');
        expect(highlightedItemNames()).toStrictEqual([name]);
        expect(onUpdate.mock.lastCall?.[0]).toBe(ids[name]);
      }
    });
  });

  test('hides the create item for an existing payee when a nearby payee matches first', async () => {
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult([
        makeNearbyPayee('Nationwide Insurance Agency', 0.3),
      ]),
    );
    const autocomplete = renderPayeeAutocomplete({
      payees: [
        makePayee('Nationwide Insurance'),
        makePayee('Nationwide Insurance Agency'),
      ],
      renderCreatePayeeButton: renderCreatePayeeButtonWithMarker,
    });
    await clickAutocomplete(autocomplete);
    await userEvent.type(
      autocomplete.querySelector('input')!,
      'Nationwide Insurance',
    );
    await waitForAutocomplete();

    expect(renderedItems().map(itemName)).toStrictEqual([
      'Nationwide Insurance Agency',
      'Nationwide Insurance',
      'Nationwide Insurance Agency',
    ]);
  });

  test('transfer mode leaves out nearby payees that are not transfers', async () => {
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult([makeNearbyPayee('Coffee Shop', 0.3)]),
    );
    const transfer: PayeeEntity = {
      id: 'transfer-id',
      name: 'Bank of Montreal',
      favorite: false,
      transfer_acct: accounts[0].id,
    };
    const autocomplete = renderPayeeAutocomplete({
      payees: [makePayee('Alice'), transfer],
    });
    await clickAutocomplete(autocomplete);
    expect(renderedItems().map(itemName)).toStrictEqual([
      'Coffee Shop',
      'Alice',
      'Bank of Montreal',
    ]);

    await userEvent.click(
      screen.getByRole('button', { name: 'Make transfer' }),
    );
    // Switching modes remounts the field, so open it again.
    await clickAutocomplete(autocomplete);

    expect(renderedItems().map(itemName)).toStrictEqual(['Bank of Montreal']);
  });

  test('leaves out a nearby transfer payee for a closed account', async () => {
    const closedAccount: AccountEntity = {
      ...generateAccount('Old Checking'),
      closed: 1,
    };
    vi.mocked(useNearbyPayees).mockReturnValue(
      mockNearbyPayeesResult([
        {
          ...makeNearbyPayee('Old Checking', 0.3),
          payee: {
            id: 'closed-transfer-id',
            name: 'Old Checking',
            favorite: false,
            transfer_acct: closedAccount.id,
          },
        },
        makeNearbyPayee('Coffee Shop', 0.5),
      ]),
    );
    await clickAutocomplete(
      renderPayeeAutocomplete({
        payees: [makePayee('Alice')],
        accounts: [...accounts, closedAccount],
      }),
    );

    expect(renderedItems().map(itemName)).toStrictEqual([
      'Coffee Shop',
      'Alice',
    ]);
  });

  describe('the "more payees" hint', () => {
    const hint = 'More payees are available, search to find them';
    const manyPayees = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makePayee(`Payee ${String(i).padStart(3, '0')}`),
      );

    test('does not count nearby payees', async () => {
      vi.mocked(useNearbyPayees).mockReturnValue(
        mockNearbyPayeesResult([makeNearbyPayee('Coffee Shop', 0.3)]),
      );
      await clickAutocomplete(
        renderPayeeAutocomplete({ payees: manyPayees(99) }),
      );

      expect(renderedItems()).toHaveLength(100);
      expect(screen.queryByText(hint)).not.toBeInTheDocument();
    });

    test('shows when 100 payees are listed', async () => {
      await clickAutocomplete(
        renderPayeeAutocomplete({ payees: manyPayees(100) }),
      );

      expect(screen.getByText(hint)).toBeInTheDocument();
    });
  });

  test('ranks an exact payee match above a longer tied substring match', async () => {
    // Payees are already alpha-sorted, so 'AAA Google' is listed first;
    // a stable sort on a tied fzf score would otherwise leave it ahead of
    // the exact 'Google' match.
    const payees = [makePayee('AAA Google'), makePayee('Google')];
    const autocomplete = renderPayeeAutocomplete({ payees });
    await clickAutocomplete(autocomplete);

    const input = autocomplete.querySelector('input')!;
    await userEvent.type(input, 'Google');
    await waitForAutocomplete();

    expect(
      [
        ...screen
          .getByTestId('autocomplete')
          .querySelectorAll(ALL_PAYEE_ITEMS_SELECTOR),
      ]
        .map(e => e.getAttribute('data-testid'))
        .flatMap(firstOrIncorrect),
    ).toStrictEqual(['Google', 'AAA Google']);
  });
});
