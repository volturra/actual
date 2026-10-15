import { createApp } from '#server/app';
import * as sheet from '#server/sheet';
import type { QueryState } from '#shared/query';

import { resolveName, unresolveName } from './util';

export type SpreadsheetHandlers = {
  'get-cell': typeof getCell;
  'get-cells': typeof getCells;
  'get-cell-names': typeof getCellNames;
  'create-query': typeof createQuery;
};

// Expose functions to the client
export const app = createApp<SpreadsheetHandlers>();
app.method('get-cell', getCell);
app.method('get-cells', getCells);
app.method('get-cell-names', getCellNames);
app.method('create-query', createQuery);

type CellRef = { sheetName: string; name: string };

function readCell({ sheetName, name }: CellRef) {
  // Query cells are computed one at a time, with other requests running in
  // between, so mid-run this can return null (not computed yet) or an old
  // value for one. Its final value is sent to the client through `change`.
  const node = sheet.get()._getNode(resolveName(sheetName, name));
  return { name: node.name, value: node.value };
}

async function getCell(cell: CellRef) {
  return readCell(cell);
}

// Reads many cells in one request. The budget page binds hundreds of cells
// at once (every cell of a newly shown month), and one message per cell
// costs far more than reading the cells themselves.
async function getCells({ cells }: { cells: CellRef[] }) {
  return cells.map(readCell);
}

async function getCellNames({ sheetName }: { sheetName: string }) {
  const names = [];
  for (const name of sheet.get().getNodes().keys()) {
    const { sheet: nodeSheet, name: nodeName } = unresolveName(name);
    if (nodeSheet === sheetName) {
      names.push(nodeName);
    }
  }
  return names;
}

async function createQuery({
  sheetName,
  name,
  query,
}: {
  sheetName: string;
  name: string;
  query: QueryState;
}) {
  // The first call for a cell always runs the query, regardless of the cache:
  // we don't know whether anything changed between the cache value being
  // saved and now. Later calls with the same query reuse the live value.
  sheet.get().createQuery(sheetName, name, query);
  return 'ok';
}
