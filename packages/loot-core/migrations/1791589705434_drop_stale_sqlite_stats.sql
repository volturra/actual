BEGIN TRANSACTION;

-- Migrations 1612625548236 and 1632571489012 ran ANALYZE while a budget
-- was still nearly empty, so every budget file carries planner stats
-- saying, for example, that `categories` has 7 rows. SQLite then picks
-- plans that rescan `v_categories` once per transaction row. Plans are
-- better with no stats at all than with these (or with a fresh ANALYZE).
DROP TABLE IF EXISTS sqlite_stat1;
DROP TABLE IF EXISTS sqlite_stat4;

-- Dropping the tables doesn't clear the stats this connection already
-- loaded. ANALYZE reloads every index's stats once it finishes, and on
-- sqlite_master it gathers nothing, so this resets them to the defaults.
-- It recreates the (empty) stat tables, which we drop again.
ANALYZE sqlite_master;
DROP TABLE IF EXISTS sqlite_stat1;
DROP TABLE IF EXISTS sqlite_stat4;

COMMIT;
