# Meadow Connection Oracle

> **[Read the Meadow-Connection-Oracle Documentation](https://fable-retold.github.io/meadow-connection-oracle/)** - interactive docs with the full API reference.

An Oracle Database connection provider for the Meadow ORM. Wraps [oracledb](https://github.com/oracle/node-oracledb) (in Thin mode - no Oracle Instant Client required) as a Fable service, providing connection pooling, retry-with-backoff on transient failures, server-version-aware DDL generation from Meadow table schemas, and data-dictionary introspection.

[meadow-connection-oracle on npm](https://www.npmjs.com/package/meadow-connection-oracle) | [MIT License](LICENSE)

---

## Features

- **oracledb Thin Mode** -- Connects with the pure-JavaScript [oracledb](https://github.com/oracle/node-oracledb) Thin driver. No Oracle Instant Client or other native client libraries are required.
- **Connection Pooling** -- Manages a single `oracledb` connection pool with a configurable pool limit, idle timeout, and connection-acquire queue timeout.
- **Fable Service Provider** -- Registers with a Fable instance for dependency injection, logging, and configuration.
- **Retry &amp; Reconnect** -- Classifies `oracledb` errors into well-known failure modes (network, request timeout, pool degraded, server error) and retries transient operations with exponential backoff, recycling the pool when a failure suggests a bad pooled connection.
- **Server-Version-Aware DDL** -- Generates `CREATE TABLE`, sequences, triggers, and indices from Meadow table schemas. Auto-detects the Oracle server version on connect and chooses 12c+ identity columns or the legacy (11g) sequence + trigger path.
- **Easy Connect Strings** -- Builds an Easy Connect string from `server` + `port` + `serviceName`, supports both `ServiceName` and `SID` connection types, or accepts a raw `connectString` / TNS descriptor override.
- **Schema Introspection** -- Reads the `USER_*` data dictionary views to list tables and reverse-engineer column, index, and foreign-key definitions back into Meadow schema objects.
- **Settings Coercion** -- Accepts both Meadow-style (`Server`, `Port`, `User`, `Password`) and `oracledb`-native (`server`, `port`, `user`, `password`) configuration formats.

## Installation

```bash
npm install meadow-connection-oracle
```

The `oracledb` driver is a dependency and is installed automatically. Because the provider uses oracledb's Thin mode, no Oracle Instant Client installation is needed.

## Quick Start

```javascript
const libFable = require('fable');
const libMeadowConnectionOracle = require('meadow-connection-oracle');

let _Fable = new libFable(
{
	Oracle:
	{
		server: '127.0.0.1',
		port: 1521,
		user: 'bookstore',
		password: 'PASSWORD',
		connectionType: 'ServiceName',
		serviceName: 'FREEPDB1',
		ConnectionPoolLimit: 10
	}
});

_Fable.serviceManager.addServiceType('MeadowOracleProvider', libMeadowConnectionOracle);
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider');

// oracledb connects asynchronously -- use connectAsync()
_Fable.MeadowOracleProvider.connectAsync(
	(pError, pPool) =>
	{
		if (pError) return console.error(pError);

		_Fable.MeadowOracleProvider.getConnection(
			(pConnError, pConnection) =>
			{
				if (pConnError) return console.error(pConnError);
				pConnection.execute('SELECT 1 AS ONE FROM DUAL', [],
					{ outFormat: _Fable.MeadowOracleProvider.oracledb.OUT_FORMAT_OBJECT })
					.then((pResult) =>
					{
						console.log(`Connected: ${pResult.rows[0].ONE}`);
						pConnection.close();
					});
			});
	});
```

## Configuration

The Oracle connection settings can be provided through Fable settings or the service provider options, under an `Oracle` key.

### Via Fable Settings

```javascript
let _Fable = new libFable(
{
	Oracle:
	{
		server: '127.0.0.1',
		port: 1521,
		user: 'bookstore',
		password: 'PASSWORD',
		connectionType: 'ServiceName',
		serviceName: 'FREEPDB1',
		ConnectionPoolLimit: 10
	}
});
```

### Via Provider Options

```javascript
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider',
{
	Oracle:
	{
		server: '127.0.0.1',
		port: 1521,
		user: 'bookstore',
		password: 'PASSWORD',
		serviceName: 'FREEPDB1',
		ConnectionPoolLimit: 10
	}
});
```

Both Meadow-style property names (`Server`, `Port`, `User`, `Password`, `ServiceName`, `ConnectionType`, `ConnectString`) and `oracledb`-native lowercase names (`server`, `port`, `user`, `password`, `serviceName`, `connectionType`, `connectString`) are accepted. The constructor coerces the PascalCase keys to the lowercase form the driver expects.

### Connect String

If no explicit `connectString` is supplied, the provider builds an Easy Connect string from the settings:

- `connectionType: 'ServiceName'` (default) produces `host:port/serviceName`
- `connectionType: 'SID'` produces `host:port:sid`

When `connectString` is set, it is passed through unchanged (use this for a TNS alias or a full descriptor). If `serviceName` is omitted, the provider defaults the service to `XEPDB1`.

## API

### `connectAsync(fCallback)`

Create the `oracledb` connection pool with retry and backoff, then resolve the server-version-dependent legacy flags. Always use this instead of `connect()` - the oracledb driver connects asynchronously.

| Parameter | Type | Description |
|-----------|------|-------------|
| `fCallback` | `Function` | Callback receiving `(error, connectionPool)` |

### `connect()`

Synchronous entry point retained for cross-provider parity. It logs a warning that the oracledb driver connects asynchronously and then calls `connectAsync()` without a callback. Prefer `connectAsync()`.

### `getConnection(fCallback)`

Acquire a pooled connection. The callback receives `(error, connection)`. The connection's `callTimeout` is set from `RequestTimeoutMs`. Always call `connection.close()` to return it to the pool.

### `recyclePool(fCallback)`

Destroy the current pool and create a fresh one. Used internally by the retry helper when a failure mode (request timeout, network error, pool degraded) suggests the pooled connection is bad. Idempotent; always resolves.

### `pool` (getter)

Returns the underlying `oracledb` connection pool, or `false` before connection.

### `oracledb` (getter)

Returns the `oracledb` module so callers can reference its constants (e.g. `OUT_FORMAT_OBJECT`, `CLOB`, `NUMBER`, `BIND_OUT`).

### `schemaProvider` (getter)

Returns the `MeadowSchemaOracle` instance that handles DDL generation and introspection.

### `connected` (property)

Boolean indicating whether the connection pool has been created.

### `generateCreateTableStatement(pMeadowTableSchema)`

Generate a single `CREATE TABLE` statement from a Meadow table schema object (delegated to the schema provider).

### `generateCreateTableStatements(pMeadowTableSchema)`

Generate the ordered array of statements needed to materialize a table. For the 12c+ identity path this is just the `CREATE TABLE`; for the legacy (11g) path it also includes a `CREATE SEQUENCE` and a `BEFORE INSERT` trigger.

### `createTable(pMeadowTableSchema, fCallback)`

Execute the create-table statements against the connected database, with retry. `ORA-00955` (object already exists) is treated as success.

### `createTables(pMeadowSchema, fCallback)`

Create all tables defined in a Meadow schema object (iterates `pMeadowSchema.Tables` sequentially).

### `generateDropTableStatement(pTableName)`

Generate a PL/SQL `DROP TABLE` block that swallows `ORA-00942` (table does not exist), since Oracle has no `DROP TABLE IF EXISTS`.

### Index &amp; Introspection methods

`getIndexDefinitionsFromSchema`, `generateCreateIndexStatements`, `createIndex`, `createIndices`, `createAllIndices`, `listTables`, `introspectTableColumns`, `introspectTableIndices`, `introspectTableForeignKeys`, `introspectTableSchema`, and `introspectDatabaseSchema` are all delegated to the schema provider. See the [API Reference](https://fable-retold.github.io/meadow-connection-oracle/) for details.

## Column Type Mapping

| Meadow Type | Oracle Column |
|-------------|---------------|
| `ID` | `NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` (12c+) or `NUMBER PRIMARY KEY` + sequence + trigger (legacy) |
| `GUID` | `VARCHAR2(size) DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL` (size defaults to 255) |
| `ForeignKey` | `NUMBER DEFAULT 0 NOT NULL` |
| `Numeric` | `NUMBER DEFAULT 0 NOT NULL` |
| `Decimal` | `NUMBER(size)` |
| `String` | `VARCHAR2(size) DEFAULT ' '` |
| `Text` | `CLOB` |
| `DateTime` | `TIMESTAMP` |
| `Boolean` | `NUMBER(1) DEFAULT 0` |
| `JSON` | `CLOB` |
| `JSONProxy` | `CLOB` (uses the column's `StorageColumn` name) |

## Part of the Retold Framework

Meadow Connection Oracle is a database connector for the Meadow data access layer:

- [meadow](https://github.com/fable-retold/meadow) -- ORM and data access framework
- [foxhound](https://github.com/fable-retold/foxhound) -- Query DSL used by Meadow (provides the Oracle dialect)
- [stricture](https://github.com/fable-retold/stricture) -- Schema definition tool
- [meadow-endpoints](https://github.com/fable-retold/meadow-endpoints) -- RESTful endpoint generation
- [meadow-connection-manager](https://github.com/fable-retold/meadow-connection-manager) -- Loads connection providers by `Type`
- [meadow-connection-mysql](https://github.com/fable-retold/meadow-connection-mysql) -- MySQL connector
- [fable](https://github.com/fable-retold/fable) -- Application services framework

## Testing

The no-database unit tests (DDL generation, index derivation, retry classification, form schema) run with no external dependencies:

```bash
npm test
```

The live end-to-end suite requires a running Oracle instance. A Docker helper is provided (gvenzl/oracle-free on port 21521):

```bash
npm run docker-oracle-start    # boot the test database (first boot pulls the image)
npm test
npm run docker-oracle-stop
```

Or run all three in one shot:

```bash
npm run test-docker
```

The live tests self-skip if Oracle is unreachable, so `npm test` is always safe to run.

Run with coverage:

```bash
npm run coverage
```

## Related Packages

- [meadow](https://github.com/fable-retold/meadow) -- Data access and ORM
- [meadow-connection-manager](https://github.com/fable-retold/meadow-connection-manager) -- Connection provider loader
- [fable](https://github.com/fable-retold/fable) -- Application services framework

## License

MIT

## Contributing

Pull requests are welcome. For details on our code of conduct, contribution process, and testing requirements, see the [Retold Contributing Guide](https://github.com/fable-retold/retold/blob/main/docs/contributing.md).
