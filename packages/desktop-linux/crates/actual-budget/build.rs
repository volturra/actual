//! Embeds the list of loot-core migration ids this build understands, so a
//! budget whose schema is newer (or older) than ours opens read-only.
use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../loot-core/migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut ids: Vec<u64> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let (id, _) = name.split_once('_')?;
            id.parse().ok()
        })
        .collect();
    ids.sort_unstable();
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("migrations.rs");
    std::fs::write(
        out,
        format!("/// Migration ids known to this build.\npub const KNOWN_MIGRATIONS: &[u64] = &{ids:?};\n"),
    )
    .unwrap();
}
