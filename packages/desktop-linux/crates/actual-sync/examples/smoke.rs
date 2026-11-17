//! Manual smoke test: download a budget, sync it, print row counts.
//! cargo run --example smoke -- <server> <password> <syncId> <dir>
use actual_sync::client::ServerClient;
use actual_sync::files;
use actual_sync::store::Store;
use actual_sync::sync::{full_sync, SyncTarget};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mut client = ServerClient::new(&args[1])?;
    client.login_password(&args[2])?;
    let file = client
        .list_files()?
        .into_iter()
        .find(|f| f.group_id.as_deref() == Some(args[3].as_str()))
        .ok_or("no such budget")?;
    let root = std::path::Path::new(&args[4]);
    let dir = files::download(&client, root, &file.file_id, None, None)?;
    let mut meta = dir.read_meta()?;
    let mut store = Store::open(rusqlite::Connection::open(dir.db_path())?)?;
    if meta.bool("resetClock") {
        store.reset_clock_node()?;
        meta.set("resetClock", false);
        dir.write_meta(&meta)?;
    }
    let target = SyncTarget {
        file_id: meta.cloud_file_id().unwrap(),
        group_id: meta.group_id().unwrap(),
        key: None,
        key_id: meta.encrypt_key_id(),
    };
    let res = full_sync(&mut store, &client, &target, meta.last_synced_timestamp())?;
    println!("passes={} received={} node={}", res.passes, res.received.len(), store.node_id());
    for t in ["accounts", "transactions", "categories", "zero_budgets", "messages_crdt"] {
        let n: i64 = store.conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))?;
        println!("{t}: {n}");
    }
    Ok(())
}
