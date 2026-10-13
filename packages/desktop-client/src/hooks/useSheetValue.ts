import { useLayoutEffect, useRef, useState } from 'react';

import type {
  Binding,
  BindingObject,
  SheetFields,
  SheetNames,
  Spreadsheets,
} from '#spreadsheet';

import { useSheetName } from './useSheetName';
import { useSpreadsheet } from './useSpreadsheet';

type SheetValueResult<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = {
  name: string;
  value: Spreadsheets[SheetName][FieldName] | null;
};

export function useSheetValue<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>(
  binding: Binding<SheetName, FieldName>,
  onChange?: (result: SheetValueResult<SheetName, FieldName>) => void,
): SheetValueResult<SheetName, FieldName>['value'] {
  const { sheetName, fullSheetName } = useSheetName(binding);

  const memoizedBinding = useMemoizedBinding(
    () =>
      typeof binding === 'string'
        ? { name: binding, value: undefined, query: undefined }
        : binding,
    binding,
  );

  const spreadsheet = useSpreadsheet();
  const [state, setResult] = useState<SheetValueResult<SheetName, FieldName>>(
    () =>
      readInitialResult(spreadsheet, sheetName, fullSheetName, memoizedBinding),
  );

  let result = state;
  if (state.name !== fullSheetName) {
    // The binding now points at a different cell (e.g. the budget month
    // changed). Never render the previous cell's value for it: switch to the
    // new cell's cached value (or the binding's default) during this render,
    // instead of rendering the stale value and correcting it from the effect
    // below, which would render the whole subtree twice.
    result = readInitialResult(
      spreadsheet,
      sheetName,
      fullSheetName,
      memoizedBinding,
    );
    setResult(result);
  }

  // Refs are only written after commit (before the binding effect below
  // runs) and from the binding callback, never during render.
  const latestOnChange = useRef(onChange);
  const latestResult = useRef(result);
  useLayoutEffect(() => {
    latestOnChange.current = onChange;
    latestResult.current = result;
  });

  useLayoutEffect(() => {
    let isMounted = true;

    const unbind = spreadsheet.bind(sheetName, memoizedBinding, newResult => {
      if (!isMounted) {
        return;
      }

      // TODO: Spreadsheets, SheetNames, SheetFields, etc must be moved to the loot-core package
      const value = newResult.value as Spreadsheets[SheetName][FieldName];

      if (latestOnChange.current) {
        latestOnChange.current({ name: newResult.name, value });
      }

      // Skip scheduling a render when the value did not change.
      if (
        latestResult.current.name === fullSheetName &&
        latestResult.current.value === value
      ) {
        return;
      }

      const nextResult = { name: fullSheetName, value };
      // Remember the pending value so that a later update back to the
      // committed value is not skipped.
      latestResult.current = nextResult;
      setResult(nextResult);
    });

    return () => {
      isMounted = false;
      unbind();
    };
  }, [spreadsheet, sheetName, fullSheetName, memoizedBinding]);

  return result.value;
}

function readInitialResult<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>(
  spreadsheet: ReturnType<typeof useSpreadsheet>,
  sheetName: string,
  fullSheetName: string,
  binding: BindingObject<SheetName, FieldName>,
): SheetValueResult<SheetName, FieldName> {
  const cached = spreadsheet.getCachedValue(sheetName, binding);
  if (cached) {
    return {
      name: fullSheetName,
      // TODO: Spreadsheets, SheetNames, SheetFields, etc must be moved to the loot-core package
      value: cached.value as Spreadsheets[SheetName][FieldName],
    };
  }
  return {
    name: fullSheetName,
    value: binding.value ? binding.value : null,
  };
}

type MemoKey<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
> = {
  name: string;
  value?: Spreadsheets[SheetName][FieldName] | undefined;
  // We check the serialized query to see if it has changed
  serializedQuery?: string;
};

function useMemoizedBinding<
  SheetName extends SheetNames,
  FieldName extends SheetFields<SheetName>,
>(
  memoBinding: () => BindingObject<SheetName, FieldName>,
  key: Binding<SheetName, FieldName>,
): BindingObject<SheetName, FieldName> {
  const ref = useRef<{
    key: MemoKey<SheetName, FieldName>;
    value: BindingObject<SheetName, FieldName>;
  } | null>(null);

  const bindingName = typeof key === 'string' ? key : key.name;
  const bindingValue = typeof key === 'string' ? undefined : key.value;
  const serializedBindingQuery =
    typeof key === 'string' ? undefined : key.query?.serializeAsString();

  if (
    !ref.current ||
    bindingName !== ref.current.key.name ||
    bindingValue !== ref.current.key.value ||
    serializedBindingQuery !== ref.current.key.serializedQuery
  ) {
    // This should not update the binding reference if the binding name, value, and query values are the same.
    // Since query objects are immutable, we compare the serialized query string to make sure that we don't cause
    // a re-render whenever a new query object with the same parameter values (QueryState) is passed in.
    ref.current = {
      key: {
        name: bindingName,
        value: bindingValue,
        serializedQuery: serializedBindingQuery,
      },
      value: memoBinding(),
    };
  }

  return ref.current.value;
}
