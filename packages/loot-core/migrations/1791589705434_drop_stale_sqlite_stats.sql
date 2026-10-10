BEGIN TRANSACTION;

-- Migrations 1612625548236 and 1632571489012 ran ANALYZE while a budget
-- was still nearly empty, so every budget file carries planner stats
-- saying, for example, that `categories` has 7 rows. SQLite then picks
-- plans that rescan `v_categories` once per transaction row. Plans are
-- better with no stats at all than with these (or with a fresh ANALYZE).
DROP TABLE IF EXISTS sqlite_stat1;
DROP TABLE IF EXISTS sqlite_stat4;

COMMIT;

-- Dropping the tables doesn't clear the stats this connection already
-- loaded, and ANALYZE only reloads the index stats, not the table row
-- counts. Rolling back a schema change makes SQLite reload the whole
-- schema, so the connection plans as if the file were opened afresh.
BEGIN TRANSACTION;
CREATE TABLE reload_schema (id TEXT);
ROLLBACK;
