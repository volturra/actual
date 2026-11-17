// Plays the part of the web client in interop tests: drives a real
// loot-core engine (through @actual-app/api) against a running
// actual-server, so the Rust client can be checked against it.
//
// Usage: node web-client.mjs <command> <json-args>
// Prints one JSON object on stdout.
import fs from 'node:fs';

// Not a workspace package: run from this repository, it uses the
// workspace build of the API (see the README).
// oxlint-disable-next-line actual/no-extraneous-dependencies
import * as api from '@actual-app/api';

const [command, rawArgs = '{}'] = process.argv.slice(2);
const args = JSON.parse(rawArgs);

const dataDir = args.dataDir;
fs.mkdirSync(dataDir, { recursive: true });

// Engine logs go to stdout; keep stdout for our JSON result.
const realLog = console.log;
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
console.warn = (...a) => console.error(...a);

function out(value) {
  realLog(JSON.stringify(value));
}

const lib = await api.init({
  dataDir,
  serverURL: args.serverURL,
  password: args.password,
});
const send = lib.send;

async function open() {
  await api.downloadBudget(
    args.syncId,
    args.encryptPassword ? { password: args.encryptPassword } : {},
  );
  await api.sync();
}

async function dump() {
  const accounts = await api.getAccounts();
  const groups = await api.getCategoryGroups();
  const payees = await api.getPayees();
  const transactions = [];
  for (const a of accounts) {
    const txs = await api.getTransactions(a.id, '1900-01-01', '2999-12-31');
    for (const t of txs) {
      transactions.push(t);
    }
  }
  const balances = {};
  for (const a of accounts) {
    balances[a.id] = await api.getAccountBalance(a.id);
  }
  const months = {};
  for (const m of args.months ?? []) {
    months[m] = await api.getBudgetMonth(m);
  }
  return { accounts, groups, payees, transactions, balances, months };
}

try {
  switch (command) {
    case 'create': {
      const res = await send('create-budget', {
        budgetName: args.name,
        avoidUpload: true,
      });
      if (res?.error) throw new Error(res.error);
      const up = await send('upload-budget');
      if (up?.error) throw new Error(JSON.stringify(up.error));
      if (args.encryptPassword) {
        const r = await send('key-make', { password: args.encryptPassword });
        if (r?.error) throw new Error(JSON.stringify(r.error));
      }
      const prefs = await send('load-prefs');
      out({ syncId: prefs.groupId, cloudFileId: prefs.cloudFileId });
      break;
    }
    case 'demo': {
      // The "View demo" budget (realistic sample data), uploaded so the
      // Linux client can download it. Used for manual testing.
      const res = await send('create-budget', {
        budgetName: args.name ?? 'Demo Budget',
        testMode: true,
      });
      if (res?.error) throw new Error(res.error);
      const up = await send('upload-budget');
      if (up?.error) throw new Error(JSON.stringify(up.error));
      const prefs = await send('load-prefs');
      out({ syncId: prefs.groupId, cloudFileId: prefs.cloudFileId });
      break;
    }
    case 'seed': {
      await open();
      const result = {};
      await api.batchBudgetUpdates(async () => {
        const groupId = await api.createCategoryGroup({ name: 'Bills' });
        result.groupId = groupId;
        result.rent = await api.createCategory({
          name: 'Rent',
          group_id: groupId,
        });
        result.power = await api.createCategory({
          name: 'Power',
          group_id: groupId,
        });
      });
      result.checking = await api.createAccount({ name: 'Checking' }, 250000);
      result.savings = await api.createAccount({ name: 'Savings' }, 1000000);
      result.payee = await api.createPayee({ name: 'Landlord' });
      await api.addTransactions(result.checking, [
        {
          date: args.month + '-03',
          amount: -120000,
          payee: result.payee,
          category: result.rent,
          notes: 'web rent',
        },
        {
          date: args.month + '-05',
          amount: -9000,
          payee_name: 'Power Co',
          subtransactions: [
            { amount: -6000, category: result.power, notes: 'split a' },
            { amount: -3000, category: result.rent, notes: 'split b' },
          ],
        },
      ]);
      await api.setBudgetAmount(args.month, result.rent, 130000);
      await api.setBudgetAmount(args.month, result.power, 10000);
      await api.sync();
      out(result);
      break;
    }
    case 'run': {
      // Runs a small script of API calls given as [method, ...args] arrays.
      await open();
      const results = [];
      for (const [method, ...callArgs] of args.calls) {
        results.push((await api[method](...callArgs)) ?? null);
      }
      await api.sync();
      out({ results });
      break;
    }
    case 'dump': {
      await open();
      out(await dump());
      break;
    }
    case 'dump-db': {
      // Raw rows, for exact comparison with what the Rust client wrote.
      await open();
      const tables = {};
      for (const t of args.tables) {
        tables[t] = await send('api/query', {
          query: api.q(t).select('*').serialize(),
        }).catch(() => null);
      }
      out(tables);
      break;
    }
    default:
      throw new Error('unknown command ' + command);
  }
} catch (e) {
  console.error(e);
  out({ error: String(e?.message ?? e) });
  process.exitCode = 1;
} finally {
  await api.shutdown();
}
