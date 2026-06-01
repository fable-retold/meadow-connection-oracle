# API Reference

Complete method and property documentation for `MeadowConnectionOracle`.

---

## Class: MeadowConnectionOracle

Extends `FableServiceProviderBase` from [fable-serviceproviderbase](https://fable-retold.github.io/fable-serviceproviderbase/).

```javascript
const libMeadowConnectionOracle = require('meadow-connection-oracle');
```

The connection provider owns the `oracledb` pool and delegates all DDL and introspection to a companion `MeadowSchemaOracle` instance (exposed via the `schemaProvider` getter).

---

## Constructor

```javascript
new MeadowConnectionOracle(pFable, pManifest, pServiceHash)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pFable` | Fable instance | Yes | The Fable instance for DI and configuration |
| `pManifest` | object | No | Service options, may include an `Oracle` config object |
| `pServiceHash` | string | No | Service instance hash for multiple instances |

**Construction behavior:**

1. If `pManifest` contains an `Oracle` object, uses it directly and coerces common PascalCase keys (`Server`, `Port`, `User`, `Password`) to lowercase.
2. Else if `pManifest.user` is a string (flat options), gathers the flat keys into an `Oracle` block.
3. Else reads `Oracle` from `pFable.settings`, accepting either case for the core connection keys.
4. Constructs a `MeadowSchemaOracle` and gives it a back-reference (for pool recycling).

The constructor does **not** open a connection. Call `connectAsync()` afterward.

---

## Properties

### connected

- **Type:** `boolean`
- **Default:** `false`

Whether the connection pool has been created. Set to `true` after a successful `connectAsync()`.

```javascript
if (_Fable.MeadowOracleProvider.connected)
{
	console.log('Pool is ready.');
}
```

### pool

- **Type:** oracledb Pool instance (getter)
- **Default:** `false` before connection

Returns the underlying oracledb connection pool. See [pool](pool.md).

### oracledb

- **Type:** the `oracledb` module (getter)

Returns the loaded `oracledb` module so callers can reference its constants (`OUT_FORMAT_OBJECT`, `CLOB`, `NUMBER`, `BIND_OUT`, ...).

### schemaProvider

- **Type:** `MeadowSchemaOracle` (getter)

The schema provider that handles DDL generation, DDL execution, and introspection.

### serviceType

- **Type:** `string`
- **Value:** `'MeadowConnectionOracle'`

The service type identifier used by Fable's service manager.

---

## Connection Methods

### connectAsync(fCallback)

Creates the oracledb pool with retry and backoff, then auto-detects the server version and resolves unset legacy flags. See [connectAsync()](connectAsync.md).

```javascript
_Fable.MeadowOracleProvider.connectAsync(
	(pError, pPool) =>
	{
		if (pError) return console.error(pError);
		// pPool is the oracledb pool
	});
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | Recommended | Callback `(pError, pConnectionPool)`. A missing callback is replaced with a no-op (and a warning is logged) |

### connect()

Synchronous entry point retained for cross-provider parity. Logs a warning that oracledb connects asynchronously, then calls `connectAsync()` with no callback. Prefer `connectAsync()`. See [connect()](connect.md).

### getConnection(fCallback)

Acquires a pooled connection, setting its `callTimeout` from `RequestTimeoutMs`. See [getConnection()](getConnection.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | Yes | Callback `(pError, pConnection)` |

Errors if not connected. Always `close()` the connection to return it to the pool.

### recyclePool(fCallback)

Destroys the current pool (`close(0)`) and reconnects. Used internally by the retry helper on failures that suggest a bad pooled connection. Idempotent; always resolves. See [recyclePool()](recyclePool.md).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | No | Callback `(pError)` - the error is informational only |

---

## DDL Methods

All DDL methods are delegated to the schema provider.

### generateCreateTableStatement(pMeadowTableSchema)

Generates a single Oracle `CREATE TABLE` statement (no terminator). See [generateCreateTableStatement()](generateCreateTableStatement.md).

**Returns:** a string.

### generateCreateTableStatements(pMeadowTableSchema)

Generates the ordered array of statements needed to materialize a table. 12c+: just the `CREATE TABLE`. Legacy (11g): `CREATE TABLE` + `CREATE SEQUENCE` + `CREATE OR REPLACE TRIGGER`.

**Returns:** `Array<string>`.

### createTable(pMeadowTableSchema, fCallback)

Generates and executes the create-table statements against the pool, with retry. `ORA-00955` (already exists) is treated as success. See [createTable()](createTable.md).

| Parameter | Type | Description |
|-----------|------|-------------|
| `pMeadowTableSchema` | object | Schema with `TableName` and `Columns` array |
| `fCallback` | function | Callback `(pError)` |

### createTables(pMeadowSchema, fCallback)

Creates all tables in a Meadow schema sequentially. See [createTables()](createTables.md).

| Parameter | Type | Description |
|-----------|------|-------------|
| `pMeadowSchema` | object | Schema with a `Tables` array |
| `fCallback` | function | Callback `(pError)` |

### generateDropTableStatement(pTableName)

Generates a PL/SQL `DROP TABLE` block that swallows `ORA-00942`. See [generateDropTableStatement()](generateDropTableStatement.md).

**Returns:** a string.

---

## Index Methods

| Method | Description |
|--------|-------------|
| `getIndexDefinitionsFromSchema(pMeadowTableSchema)` | Derive index definition objects (unique for `GUID`, regular for `ForeignKey`, plus `Indexed` columns and explicit `Indices`) |
| `generateCreateIndexStatements(pMeadowTableSchema)` | Returns `[{ Name, Statement, CheckStatement }]`; `CheckStatement` is a `USER_INDEXES` count query |
| `createIndex(pIndexStatement, fCallback)` | Create one index (checks `USER_INDEXES` first), with retry |
| `createIndices(pMeadowTableSchema, fCallback)` | Create all indices for one table, sequentially |
| `createAllIndices(pMeadowSchema, fCallback)` | Create all indices for every table in a schema |

---

## Introspection Methods

All query the connecting user's own schema via the `USER_*` data dictionary views.

| Method | Callback Result |
|--------|-----------------|
| `listTables(fCallback)` | `(pError, pTableNames)` - array of names |
| `introspectTableColumns(pTableName, fCallback)` | `(pError, pColumns)` - Meadow column defs |
| `introspectTableIndices(pTableName, fCallback)` | `(pError, pIndices)` - non-constraint indices |
| `introspectTableForeignKeys(pTableName, fCallback)` | `(pError, pForeignKeys)` |
| `introspectTableSchema(pTableName, fCallback)` | `(pError, pTableSchema)` |
| `introspectDatabaseSchema(fCallback)` | `(pError, { Tables: [...] })` |

---

## Configuration Reference

Settings live under an `Oracle` key, in Fable settings or per-instance options.

```json
{
	"Oracle":
	{
		"server": "127.0.0.1",
		"port": 1521,
		"user": "bookstore",
		"password": "secret",
		"connectionType": "ServiceName",
		"serviceName": "FREEPDB1",
		"ConnectionPoolLimit": 10
	}
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `Oracle.server` / `Oracle.Server` | string | `localhost` | Oracle hostname |
| `Oracle.port` / `Oracle.Port` | number | 1521 | Listener port |
| `Oracle.user` / `Oracle.User` | string | -- | Database user (its own schema) |
| `Oracle.password` / `Oracle.Password` | string | -- | Database password |
| `Oracle.serviceName` / `Oracle.ServiceName` | string | `XEPDB1` | Service name or SID |
| `Oracle.connectionType` / `Oracle.ConnectionType` | string | `ServiceName` | `ServiceName` (`host:port/service`) or `SID` (`host:port:sid`) |
| `Oracle.connectString` / `Oracle.ConnectString` | string | -- | Raw Easy Connect string / TNS descriptor; overrides `server`/`port`/`serviceName` |
| `Oracle.ConnectionPoolLimit` | number | 10 | `poolMax` for the oracledb pool |
| `Oracle.RequestTimeoutMs` | number | 120000 | Per-call `callTimeout` (ms) |
| `Oracle.ConnectionTimeoutMs` | number | 60000 | `queueTimeout` to acquire a pooled connection (ms) |
| `Oracle.LegacyPagination` | boolean | auto-detect | Force ROWNUM pagination (11g) |
| `Oracle.LegacyIdentity` | boolean | auto-detect | Force sequence + trigger identity (11g) |
| `Oracle.QuoteIdentifiers` | boolean | false | Wrap identifiers in double quotes to preserve case |
| `Oracle.NumberAsString` | boolean | false | Fetch `NUMBER` columns as strings |
| `Oracle.ConnectRetryOptions` | object | see below | `{ MaxAttempts, InitialDelayMs, MaxDelayMs, BackoffFactor }` for connect |
| `Oracle.DDLRetryOptions` | object | see below | Same shape, for DDL operations |

Default retry tuning: connect uses `MaxAttempts: 5`, `InitialDelayMs: 3000`, `MaxDelayMs: 30000`, `BackoffFactor: 2`. DDL uses `MaxAttempts: 5`, `InitialDelayMs: 3000`, `MaxDelayMs: 30000`, `BackoffFactor: 2`.

### Fixed pool settings

Beyond `poolMax` and `queueTimeout`, the pool is created with `poolMin: 0`, `poolIncrement: 1`, and `poolTimeout: 30` (seconds idle before the pool shrinks). These are not currently configurable.

---

## Column Type Mapping

Used by `generateCreateTableStatement()`:

| Meadow DataType | Oracle Output | Default | Notes |
|-----------------|---------------|---------|-------|
| `ID` | `NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` | -- | Legacy: `NUMBER PRIMARY KEY` + sequence + trigger |
| `GUID` | `VARCHAR2(Size) ... NOT NULL` | `'00000000-0000-0000-0000-000000000000'` | Size defaults to 255 |
| `ForeignKey` | `NUMBER ... NOT NULL` | `0` | |
| `Numeric` | `NUMBER ... NOT NULL` | `0` | |
| `Decimal` | `NUMBER(Size)` | -- | Size is the precision spec |
| `String` | `VARCHAR2(Size)` | `' '` | Nullable (Oracle treats `''` as NULL) |
| `Text` | `CLOB` | -- | |
| `DateTime` | `TIMESTAMP` | -- | |
| `Boolean` | `NUMBER(1)` | `0` | |
| `JSON` | `CLOB` | -- | |
| `JSONProxy` | `CLOB` | -- | Uses `StorageColumn` |

Unrecognized data types are skipped.

---

## Multiple Instances

You can create multiple connection providers for different databases by giving each a distinct service hash:

```javascript
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider',
	{ Oracle: { server: 'primary-db', port: 1521, user: 'app', password: 'secret', serviceName: 'FREEPDB1' } },
	'Primary');

_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider',
	{ Oracle: { server: 'reporting-db', port: 1521, user: 'app', password: 'secret', serviceName: 'FREEPDB1' } },
	'Reporting');
```

---

## Loaded by Meadow Connection Manager

[meadow-connection-manager](https://fable-retold.github.io/meadow-connection-manager/) maps the provider `Type: 'Oracle'` to the `meadow-connection-oracle` module. It writes the provider config into `fable.settings.Oracle`, instantiates the provider, and calls `connectAsync()`. It also exposes this module's connection form via `getProviderFormSchema('Oracle')`, which loads `source/Meadow-Connection-Oracle-FormSchema.js`.

---

## Related

- [connectAsync()](connectAsync.md) -- Create the connection pool
- [connect()](connect.md) -- Parity-only synchronous entry point
- [getConnection()](getConnection.md) -- Acquire a pooled connection
- [recyclePool()](recyclePool.md) -- Destroy and recreate the pool
- [pool](pool.md) -- Access the oracledb pool
- [generateCreateTableStatement()](generateCreateTableStatement.md) -- Generate CREATE TABLE DDL
- [createTable()](createTable.md) -- Execute DDL for a single table
- [createTables()](createTables.md) -- Execute DDL for multiple tables
- [generateDropTableStatement()](generateDropTableStatement.md) -- Generate the DROP TABLE block
- [Schema &amp; Table Creation](../schema.md) -- Full schema walkthrough
