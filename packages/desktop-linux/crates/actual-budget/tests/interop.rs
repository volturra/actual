//! Interop tests against a real actual-server and the real loot-core engine
//! (through `interop/web-client.mjs`, standing in for the web app).
//!
//! They need Node and a built sync-server and API:
//!   yarn install && yarn workspace @actual-app/sync-server build && yarn build:api
//!   cargo test -p actual-budget --test interop -- --ignored --test-threads=1

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use actual_budget::month::{today, Month};
use actual_budget::ops::{self, NewTransaction, SplitLine, TransactionUpdate};
use actual_budget::{model, unlock_key, Budget};
use actual_sync::client::ServerClient;
use actual_sync::files;
use serde_json::{json, Value as Json};

const PASSWORD: &str = "interop-pw";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().unwrap()
}

struct Server {
    child: Child,
    url: String,
    _dir: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_server() -> Server {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let app = repo_root().join("packages/sync-server/build/app.js");
    assert!(app.exists(), "build the sync server first: {}", app.display());
    let child = Command::new("node")
        .arg(&app)
        .current_dir(repo_root().join("packages/sync-server"))
        .env("ACTUAL_DATA_DIR", dir.path())
        .env("ACTUAL_PORT", port.to_string())
        .env("ACTUAL_HOSTNAME", "127.0.0.1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}");
    let client = ServerClient::new(&url).unwrap();
    for _ in 0..100 {
        if client.needs_bootstrap().is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _: Json = client.post_json("/account/bootstrap", json!({ "password": PASSWORD })).unwrap();
    Server { child, url, _dir: dir }
}

/// Runs one web-client command with a fresh engine data dir.
fn web(server: &Server, command: &str, mut args: Json) -> Json {
    let data = tempfile::tempdir().unwrap();
    args["dataDir"] = json!(data.path());
    args["serverURL"] = json!(server.url);
    args["password"] = json!(PASSWORD);
    let out = Command::new("node")
        .arg(repo_root().join("packages/desktop-linux/interop/web-client.mjs"))
        .arg(command)
        .arg(args.to_string())
        .current_dir(repo_root())
        .env("NO_PROXY", "127.0.0.1,localhost")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().last().unwrap_or("{}");
    let v: Json = serde_json::from_str(line).unwrap_or_else(|_| panic!("bad output: {stdout}"));
    assert!(
        v.get("error").is_none(),
        "web-client {command} failed: {v}\n{}",
        String::from_utf8_lossy(&out.stderr).lines().rev().take(30).collect::<Vec<_>>().join("\n")
    );
    v
}

fn client(server: &Server) -> ServerClient {
    let mut c = ServerClient::new(&server.url).unwrap();
    c.login_password(PASSWORD).unwrap();
    c
}

fn download(server: &Server, sync_id: &str, root: &Path, enc: Option<&str>) -> (Budget, ServerClient) {
    let c = client(server);
    let file = c.list_files().unwrap().into_iter().find(|f| f.group_id.as_deref() == Some(sync_id)).unwrap();
    let key = enc.map(|pw| unlock_key(&c, &file.file_id, pw).unwrap());
    let dir = files::download(&c, root, &file.file_id, key.as_ref(), None).unwrap();
    let mut budget = Budget::open(dir, key).unwrap();
    assert!(budget.is_writable(), "{:?}", budget.compat);
    budget.sync(&c).unwrap();
    (budget, c)
}

fn month_str() -> String {
    Month::current().to_string()
}

/// Compares Rust's envelope numbers with loot-core's for every month given.
fn assert_budget_matches(budget: &Budget, dump: &Json, months: &[String]) {
    let env = budget.envelope().unwrap();
    for m in months {
        let web = &dump["months"][m];
        let s = env.month(Month::parse(m).unwrap()).expect("month in range");
        let ctx = format!("month {m}");
        assert_eq!(web["toBudget"].as_i64().unwrap(), s.to_budget, "toBudget {ctx}");
        assert_eq!(web["incomeAvailable"].as_i64().unwrap(), s.available_funds, "available {ctx}");
        assert_eq!(web["lastMonthOverspent"].as_i64().unwrap(), s.last_month_overspent, "overspent {ctx}");
        assert_eq!(web["totalBudgeted"].as_i64().unwrap(), s.total_budgeted, "budgeted {ctx}");
        assert_eq!(web["fromLastMonth"].as_i64().unwrap(), s.from_last_month, "fromLast {ctx}");
        assert_eq!(web["totalIncome"].as_i64().unwrap(), s.total_income, "income {ctx}");
        assert_eq!(web["totalSpent"].as_i64().unwrap(), s.total_spent, "spent {ctx}");
        assert_eq!(web["totalBalance"].as_i64().unwrap(), s.total_balance, "balance {ctx}");
        assert_eq!(web["forNextMonth"].as_i64().unwrap(), s.buffered, "buffered {ctx}");
        for g in web["categoryGroups"].as_array().unwrap() {
            if g["is_income"].as_bool().unwrap_or(false) {
                continue;
            }
            for c in g["categories"].as_array().unwrap() {
                let id = c["id"].as_str().unwrap();
                let r = &s.categories[id];
                assert_eq!(c["budgeted"].as_i64().unwrap(), r.budgeted, "{id} budgeted {ctx}");
                assert_eq!(c["spent"].as_i64().unwrap(), r.spent, "{id} spent {ctx}");
                assert_eq!(c["balance"].as_i64().unwrap(), r.balance, "{id} balance {ctx}");
                assert_eq!(c["carryover"].as_bool().unwrap_or(false), r.carryover, "{id} carryover {ctx}");
            }
        }
    }
}

fn assert_accounts_match(budget: &Budget, dump: &Json) {
    let accounts = model::accounts(budget.conn()).unwrap();
    let web_accounts = dump["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), web_accounts.len(), "account count");
    for a in &accounts {
        let wa = web_accounts.iter().find(|w| w["id"] == a.id).expect("account on web");
        assert_eq!(wa["name"], a.name);
        assert_eq!(dump["balances"][&a.id].as_i64().unwrap(), a.balance, "balance of {}", a.name);
    }
    // Same set of live transactions (parents and children).
    let mut rs_ids: Vec<String> = model::transactions(budget.conn(), None)
        .unwrap()
        .into_iter()
        .flat_map(|t| std::iter::once(t.id.clone()).chain(t.subtransactions.into_iter().map(|s| s.id)))
        .collect();
    let mut web_ids: Vec<String> = dump["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| {
            std::iter::once(t["id"].as_str().unwrap().to_string()).chain(
                t["subtransactions"].as_array().into_iter().flatten().map(|s| s["id"].as_str().unwrap().to_string()),
            )
        })
        .collect();
    rs_ids.sort();
    rs_ids.dedup();
    web_ids.sort();
    web_ids.dedup();
    assert_eq!(rs_ids, web_ids, "transaction ids");
}

fn months_around() -> Vec<String> {
    let m = Month::current();
    vec![m.plus(-1).to_string(), m.to_string(), m.plus(1).to_string(), m.plus(2).to_string()]
}

#[test]
#[ignore]
fn web_to_rust_and_back() {
    let server = start_server();
    let created = web(&server, "create", json!({ "name": "Interop" }));
    let sync_id = created["syncId"].as_str().unwrap().to_string();
    let seeded = web(&server, "seed", json!({ "syncId": sync_id, "month": month_str() }));

    // 1. Rust sees exactly what the web engine wrote.
    let root = tempfile::tempdir().unwrap();
    let (mut budget, c) = download(&server, &sync_id, root.path(), None);
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around() }));
    assert_accounts_match(&budget, &dump);
    assert_budget_matches(&budget, &dump, &months_around());

    // 2. Rust edits: budget, a new category, a split, a transfer, a hold.
    let month = Month::current();
    let rent = seeded["rent"].as_str().unwrap();
    let power = seeded["power"].as_str().unwrap();
    let checking = seeded["checking"].as_str().unwrap().to_string();
    let savings = seeded["savings"].as_str().unwrap().to_string();
    let cs = ops::set_budget(budget.conn(), month, rent, 140000).unwrap();
    budget.apply(cs).unwrap();
    let group = seeded["groupId"].as_str().unwrap();
    let (fun, cs) = ops::create_category(budget.conn(), "Fun Money", group).unwrap();
    budget.apply(cs).unwrap();
    budget.apply(ops::set_budget(budget.conn(), month, &fun, 5000).unwrap()).unwrap();
    budget.apply(ops::set_budget(budget.conn(), month.next(), &fun, 7000).unwrap()).unwrap();

    let (payee, pcs) = ops::get_or_create_payee(budget.conn(), "Corner Shop").unwrap();
    let tx = NewTransaction {
        account: checking.clone(),
        date: today(),
        amount: -4200,
        payee: Some(payee),
        notes: Some("from rust".into()),
        splits: vec![
            SplitLine { amount: -3000, category: Some(fun.clone()), ..Default::default() },
            SplitLine { amount: -1200, category: Some(power.to_string()), notes: Some("bulbs".into()), ..Default::default() },
        ],
        ..Default::default()
    };
    let (ids, mut cs) = ops::insert_transaction(&tx).unwrap();
    cs.extend(pcs);
    budget.edit_transactions(cs, ids.clone(), vec![]).unwrap();

    let savings_payee = ops::transfer_payee(budget.conn(), &savings).unwrap().unwrap();
    let transfer = NewTransaction {
        account: checking.clone(),
        date: today(),
        amount: -25000,
        payee: Some(savings_payee),
        category: Some(rent.to_string()),
        ..Default::default()
    };
    let (tids, cs) = ops::insert_transaction(&transfer).unwrap();
    budget.edit_transactions(cs, tids.clone(), vec![]).unwrap();
    let t = model::transaction(budget.conn(), &tids[0]).unwrap().unwrap();
    let other = t.transfer_id.clone().expect("transfer created");
    assert_eq!(t.category, None, "on-budget transfer has no category");
    let o = model::transaction(budget.conn(), &other).unwrap().unwrap();
    assert_eq!((o.amount, o.account.as_deref()), (25000, Some(savings.as_str())));

    let env = budget.envelope().unwrap();
    let hold = ops::hold_for_next_month(budget.conn(), &env, month, 1000).unwrap();
    budget.apply(hold).unwrap();
    let (acct, cs) = ops::create_account(budget.conn(), "Wallet", 6000, false).unwrap();
    budget.apply(cs).unwrap();
    budget.sync(&c).unwrap();

    // 3. A fresh web engine sees the Rust edits and computes the same budget.
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around() }));
    assert_accounts_match(&budget, &dump);
    assert_budget_matches(&budget, &dump, &months_around());
    assert!(dump["accounts"].as_array().unwrap().iter().any(|a| a["id"] == acct.as_str()));
    let web_split = dump["transactions"].as_array().unwrap().iter().find(|t| t["id"] == ids[0].as_str()).unwrap();
    assert_eq!(web_split["is_parent"], true);
    assert_eq!(web_split["subtransactions"].as_array().unwrap().len(), 2);
    assert_eq!(web_split["error"], Json::Null, "balanced split");

    // 4. Web edits the transfer amount; Rust receives it, including the
    //    web's transfer bookkeeping on the other side.
    web(
        &server,
        "run",
        json!({ "syncId": sync_id, "calls": [["updateTransaction", tids[0], { "amount": -30000 }]] }),
    );
    budget.sync(&c).unwrap();
    let o = model::transaction(budget.conn(), &other).unwrap().unwrap();
    assert_eq!(o.amount, 30000);

    // 5. Rust edits and deletes; undo of a delete brings it back everywhere.
    let upd = TransactionUpdate { notes: Some(Some("edited in rust".into())), cleared: Some(false), ..Default::default() };
    let cs = ops::update_transaction(budget.conn(), &tids[0], &upd).unwrap();
    budget.edit_transactions(cs, vec![tids[0].clone()], vec![]).unwrap();
    let (del, cs) = ops::delete_transaction(budget.conn(), &ids[0]).unwrap();
    budget.edit_transactions(cs, vec![], del).unwrap();
    assert!(model::transaction(budget.conn(), &ids[0]).unwrap().is_none());
    budget.undo().unwrap();
    assert!(model::transaction(budget.conn(), &ids[0]).unwrap().is_some());
    budget.sync(&c).unwrap();
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around() }));
    assert_accounts_match(&budget, &dump);
    assert_budget_matches(&budget, &dump, &months_around());
    let wt = dump["transactions"].as_array().unwrap().iter().find(|t| t["id"] == tids[0].as_str()).unwrap();
    assert_eq!(wt["notes"], "edited in rust");
    assert_eq!(wt["cleared"], false);
    let wo = dump["transactions"].as_array().unwrap().iter().find(|t| t["id"] == other.as_str()).unwrap();
    assert_eq!(wo["notes"], "edited in rust", "web side sees transfer notes follow");
}

#[test]
#[ignore]
fn concurrent_edits_converge() {
    let server = start_server();
    let created = web(&server, "create", json!({ "name": "Concurrent" }));
    let sync_id = created["syncId"].as_str().unwrap().to_string();
    let seeded = web(&server, "seed", json!({ "syncId": sync_id, "month": month_str() }));
    let rent = seeded["rent"].as_str().unwrap();
    let root = tempfile::tempdir().unwrap();
    let (mut a, c) = download(&server, &sync_id, root.path(), None);
    let root_b = tempfile::tempdir().unwrap();
    let (mut b, c2) = download(&server, &sync_id, root_b.path(), None);
    assert_ne!(a.store.node_id(), b.store.node_id(), "each download gets its own node");

    // Both Rust copies edit the same cell offline; then the web edits it
    // last. Everyone converges on the newest write.
    let month = Month::current();
    a.apply(ops::set_budget(a.conn(), month, rent, 1).unwrap()).unwrap();
    b.apply(ops::set_budget(b.conn(), month, rent, 2).unwrap()).unwrap();
    a.sync(&c).unwrap();
    b.sync(&c2).unwrap();
    a.sync(&c).unwrap();
    let ea = a.envelope().unwrap().category(month, rent).budgeted;
    let eb = b.envelope().unwrap().category(month, rent).budgeted;
    assert_eq!(ea, 2);
    assert_eq!(eb, 2);
    std::thread::sleep(Duration::from_millis(5));
    web(&server, "run", json!({ "syncId": sync_id, "calls": [["setBudgetAmount", month_str(), rent, 3]] }));
    a.sync(&c).unwrap();
    b.sync(&c2).unwrap();
    assert_eq!(a.envelope().unwrap().category(month, rent).budgeted, 3);
    assert_eq!(b.envelope().unwrap().category(month, rent).budgeted, 3);
    assert_eq!(a.store.clock.merkle.hash, b.store.clock.merkle.hash, "same message set");

    // Many offline edits on both sides, then sync.
    for i in 0..50 {
        a.apply(ops::set_budget(a.conn(), month.plus(i % 5), rent, 100 + i as i64).unwrap()).unwrap();
        b.apply(ops::set_budget(b.conn(), month.plus(i % 7), rent, 200 + i as i64).unwrap()).unwrap();
    }
    a.sync(&c).unwrap();
    b.sync(&c2).unwrap();
    a.sync(&c).unwrap();
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around() }));
    assert_budget_matches(&a, &dump, &months_around());
    assert_budget_matches(&b, &dump, &months_around());
    assert_eq!(a.store.clock.merkle.hash, b.store.clock.merkle.hash);
}

#[test]
#[ignore]
fn encrypted_budget() {
    let server = start_server();
    let created = web(&server, "create", json!({ "name": "Secret", "encryptPassword": "s3cret" }));
    let sync_id = created["syncId"].as_str().unwrap().to_string();
    let seeded = web(&server, "seed", json!({ "syncId": sync_id, "month": month_str(), "encryptPassword": "s3cret" }));
    let c = client(&server);
    let file = c.list_files().unwrap().into_iter().find(|f| f.group_id.as_deref() == Some(&sync_id)).unwrap();
    assert!(file.encrypt_key_id.is_some());
    assert!(unlock_key(&c, &file.file_id, "wrong").is_err());

    let root = tempfile::tempdir().unwrap();
    let (mut budget, c) = download(&server, &sync_id, root.path(), Some("s3cret"));
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around(), "encryptPassword": "s3cret" }));
    assert_accounts_match(&budget, &dump);
    assert_budget_matches(&budget, &dump, &months_around());

    let rent = seeded["rent"].as_str().unwrap();
    budget.apply(ops::set_budget(budget.conn(), Month::current(), rent, 99900).unwrap()).unwrap();
    budget.sync(&c).unwrap();
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around(), "encryptPassword": "s3cret" }));
    assert_budget_matches(&budget, &dump, &months_around());

    // Without the key, sync refuses rather than sending plaintext.
    budget.set_key(None);
    budget.apply(ops::set_budget(budget.conn(), Month::current(), rent, 1).unwrap()).unwrap();
    let err = budget.sync(&c).unwrap_err();
    assert!(err.to_string().contains("encrypt") || err.to_string().contains("decrypt"), "{err}");
}

#[test]
#[ignore]
fn upload_from_rust_then_web_downloads() {
    let server = start_server();
    let created = web(&server, "create", json!({ "name": "Upload" }));
    let sync_id = created["syncId"].as_str().unwrap().to_string();
    web(&server, "seed", json!({ "syncId": sync_id, "month": month_str() }));
    let root = tempfile::tempdir().unwrap();
    let (mut budget, c) = download(&server, &sync_id, root.path(), None);
    budget.upload(&c).unwrap();
    // The web engine downloads the file Rust uploaded and syncs cleanly.
    let dump = web(&server, "dump", json!({ "syncId": sync_id, "months": months_around() }));
    assert_accounts_match(&budget, &dump);
    assert_budget_matches(&budget, &dump, &months_around());
}
