# Actual for Linux (experimental)

A native Linux desktop client for Actual Budget, written in Rust with GTK 4 and
libadwaita. It feels like a classic desktop budgeting app (month columns side by
side, a register with an editor bar, keyboard-first editing) and syncs with an
Actual sync server using the same protocol as the web app, so both can work on
the same budget at the same time.

## What it does

- Signs in to an Actual server with a password, lists the server's budgets, and
  downloads them. Encrypted budgets are unlocked with their encryption password.
- Syncs both ways with the web app and other devices: HULC timestamps, the
  merkle trie, protobuf messages, AES-256-GCM encryption, and deferral of
  changes from newer Actual versions, all as loot-core does them.
- Envelope budget: 1 to 3 months side by side, To Be Budgeted banner and its
  breakdown, budgeted / activity / available per category, rollover, cover
  overspending, move money, hold for next month, copy last month, averages,
  notes, and creating, renaming, hiding and deleting categories and groups.
- Accounts: on- and off-budget accounts, starting balances, transfers (with
  their paired transaction), splits, cleared state, reconcile with an
  adjustment, close and reopen, search, and a running balance.
- Undo and redo of every edit, offline work with automatic sync when the
  network returns.

Not yet supported: rules, schedules, reports, bank sync, tracking budgets and
OpenID login. A budget whose database was migrated by a newer or older Actual
than this client was built against opens read-only.

## Layout

| Path | What's there |
| --- | --- |
| `crates/actual-sync` | The sync protocol: timestamps, merkle, protobuf, crypto, server client, file download and upload. |
| `crates/actual-budget` | The budget engine: data model, envelope math (ported from loot-core), edits, transfers, undo. |
| `app` | The GTK app (`actual-linux`). |
| `interop` | A Node helper that drives the real loot-core engine through `@actual-app/api`, for interop tests. |

## Building

Needs Rust 1.87+, GTK 4.14+ and libadwaita 1.5+ development files (on Debian or
Ubuntu: `apt install libgtk-4-dev libadwaita-1-dev`).

```sh
cd packages/desktop-linux
cargo build --release
./target/release/actual-linux
```

Budgets and settings live in `$XDG_DATA_HOME/actual-linux` (usually
`~/.local/share/actual-linux`). Use `--data-dir DIR` or `ACTUAL_LINUX_DATA_DIR`
to put them elsewhere. The session token and encryption keys are stored in
`config.json` there with owner-only permissions.

## Tests

```sh
cargo test
```

The interop tests start a real sync server and check that the Rust client and
the web engine converge on the same data (balances, transactions and every
budget-month figure). Build the server and API first, from the repository root:

```sh
yarn install
yarn workspace @actual-app/sync-server build
yarn workspace @actual-app/api build
cd packages/desktop-linux
cargo test -p actual-budget --test interop -- --ignored --test-threads=1
```

For manual testing, `node interop/web-client.mjs demo '{"dataDir":"/tmp/web","serverURL":"http://localhost:5006","password":"..."}'`
uploads the "View demo" budget to a server.
