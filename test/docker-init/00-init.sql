-- Oracle test DB initialization.
--
-- The bookstore APP_USER and the XEPDB1 service are created automatically by
-- the gvenzl/oracle-xe image.  Table creation and seeding happen in the live
-- test suite via Meadow, so this script is intentionally a no-op.
SELECT 1 FROM DUAL;
