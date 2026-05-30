# Quickstart

This guide walks through setting up Meadow Connection Oracle from scratch: install, configure, connect, run queries, create tables (with the 12c+ or legacy identity path), and integrate with the Meadow ORM.

---

## Prerequisites

- Node.js 14 or later
- A running Oracle Database instance (11g through 23ai are supported)
- A database user with privileges to create tables, sequences, triggers, and indices in its own schema

No Oracle Instant Client is required &mdash; the provider uses the `oracledb` Thin driver.

### Optional: a local test database

The module ships a Docker helper that boots a disposable Oracle instance (gvenzl/oracle-free 23ai) on port 21521:

```bash
npm run docker-oracle-start
```

This creates a `bookstore` user inside the `FREEPDB1` pluggable database with password `Retold1234567890!`. Stop it with `npm run docker-oracle-stop`.

---

## Install

```bash
npm install meadow-connection-oracle fable
```

---

## Step 1: Configure and Connect

Oracle connects asynchronously, so configure the service, instantiate it, then call `connectAsync()`:

```javascript
const libFable = require('fable');
const libMeadowConnectionOracle = require('meadow-connection-oracle');

let _Fable = new libFable(
	{
		"Product": "BookstoreExample",
		"ProductVersion": "1.0.0",
		"UUID": { "DataCenter": 0, "Worker": 0 },
		"LogStreams": [{ "streamtype": "console" }],
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
	});

_Fable.serviceManager.addServiceType('MeadowOracleProvider', libMeadowConnectionOracle);
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider');

_Fable.MeadowOracleProvider.connectAsync(
	(pError, pPool) =>
	{
		if (pError)
		{
			console.error('Connection failed:', pError);
			return;
		}
		console.log('Connected:', _Fable.MeadowOracleProvider.connected);
		// => Connected: true
	});
```

On a successful connect the provider also auto-detects the server version and resolves any unset `LegacyPagination` / `LegacyIdentity` flags before the callback fires, so your first DDL or query already uses the correct syntax.

---

## Step 2: Run a Query

Acquire a pooled connection with `getConnection()` and use the oracledb connection's `execute()`:

```javascript
_Fable.MeadowOracleProvider.getConnection(
	(pConnError, pConnection) =>
	{
		if (pConnError)
		{
			console.error('Could not acquire a connection:', pConnError);
			return;
		}

		pConnection.execute(
			'SELECT IDFableTest, Title FROM FableTest WHERE ROWNUM <= 5',
			[],
			{ outFormat: _Fable.MeadowOracleProvider.oracledb.OUT_FORMAT_OBJECT })
			.then((pResult) =>
			{
				for (let i = 0; i < pResult.rows.length; i++)
				{
					// Unquoted identifiers fold to UPPERCASE in Oracle
					console.log(`  [${pResult.rows[i].IDFABLETEST}] ${pResult.rows[i].TITLE}`);
				}
				return pConnection.close();
			})
			.catch((pError) =>
			{
				console.error('Query failed:', pError);
				pConnection.close();
			});
	});
```

Always call `pConnection.close()` to return the connection to the pool.

> **Identifier case:** in the default unquoted mode, Oracle folds identifiers to UPPERCASE, so result keys come back UPPERCASE (`TITLE`, not `Title`). When Meadow runs the query, its Oracle provider's marshaller remaps these back to the PascalCase column names from your schema. Set `QuoteIdentifiers: true` to preserve case instead.

---

## Step 3: The Connect String

If you do not pass an explicit `connectString`, the provider builds an Easy Connect string from your settings:

```javascript
// connectionType: 'ServiceName' (default) -> host:port/service
//   127.0.0.1:1521/FREEPDB1

// connectionType: 'SID' -> host:port:sid
//   127.0.0.1:1521:ORCL
```

To use a TNS alias or a full descriptor instead, set `connectString` directly &mdash; it overrides `server`, `port`, and `serviceName`:

```javascript
let _Fable = new libFable(
	{
		"Oracle":
		{
			"user": "bookstore",
			"password": "secret",
			"connectString": "myalias_high",
			"ConnectionPoolLimit": 10
		}
	});
```

---

## Step 4: Create Tables from Schema

Define a Meadow table schema (using `DataType`) and generate the DDL:

```javascript
let tmpBookSchema =
{
	TableName: 'Book',
	Columns:
	[
		{ Column: 'IDBook', DataType: 'ID' },
		{ Column: 'GUIDBook', DataType: 'GUID' },
		{ Column: 'Title', DataType: 'String', Size: '256' },
		{ Column: 'Author', DataType: 'String', Size: '128' },
		{ Column: 'Year', DataType: 'Numeric' },
		{ Column: 'Price', DataType: 'Decimal', Size: '10,2' },
		{ Column: 'Synopsis', DataType: 'Text' },
		{ Column: 'PublishDate', DataType: 'DateTime' },
		{ Column: 'InPrint', DataType: 'Boolean' },
		{ Column: 'IDAuthor', DataType: 'ForeignKey' }
	]
};

// Generate the SQL without executing it
let tmpSQL = _Fable.MeadowOracleProvider.generateCreateTableStatement(tmpBookSchema);
console.log(tmpSQL);
```

Execute it against the database (with retry, treating "already exists" as success):

```javascript
_Fable.MeadowOracleProvider.createTable(tmpBookSchema,
	(pError) =>
	{
		if (pError)
		{
			console.error('Table creation failed:', pError);
			return;
		}
		console.log('Book table created.');
	});
```

For multiple tables, use `createTables()` with a schema containing a `Tables` array:

```javascript
let tmpFullSchema =
{
	Tables:
	[
		{
			TableName: 'Author',
			Columns:
			[
				{ Column: 'IDAuthor', DataType: 'ID' },
				{ Column: 'GUIDAuthor', DataType: 'GUID' },
				{ Column: 'Name', DataType: 'String', Size: '200' }
			]
		},
		{
			TableName: 'Book',
			Columns:
			[
				{ Column: 'IDBook', DataType: 'ID' },
				{ Column: 'GUIDBook', DataType: 'GUID' },
				{ Column: 'Title', DataType: 'String', Size: '256' },
				{ Column: 'IDAuthor', DataType: 'ForeignKey' }
			]
		}
	]
};

_Fable.MeadowOracleProvider.createTables(tmpFullSchema,
	(pError) =>
	{
		if (pError)
		{
			console.error('Schema creation failed:', pError);
			return;
		}
		console.log('All tables created.');
	});
```

Tables are created sequentially (one at a time). On a legacy (11g) connection, each `ID` column also gets a `CREATE SEQUENCE` and a `BEFORE INSERT` trigger automatically.

---

## Step 5: Create Indices

The schema provider derives indices from your columns (a unique index for each `GUID`, a regular index for each `ForeignKey`) plus any explicit `Indices` you declare, and creates them only if they do not already exist:

```javascript
_Fable.MeadowOracleProvider.createIndices(tmpBookSchema,
	(pError) =>
	{
		if (pError)
		{
			console.error('Index creation failed:', pError);
			return;
		}
		console.log('Indices created.');
	});
```

To create indices for every table in a schema, use `createAllIndices(tmpFullSchema, fCallback)`.

---

## Step 6: Inspect an Existing Database

The provider can reverse-engineer a Meadow schema from the live data dictionary:

```javascript
_Fable.MeadowOracleProvider.listTables(
	(pError, pTableNames) =>
	{
		console.log('Tables:', pTableNames);
	});

_Fable.MeadowOracleProvider.introspectDatabaseSchema(
	(pError, pSchema) =>
	{
		if (pError) return console.error(pError);
		console.log(JSON.stringify(pSchema.Tables, null, 4));
	});
```

---

## Step 7: Meadow ORM Integration

With the provider connected, Meadow entities can query through it. FoxHound's Oracle dialect generates the SQL &mdash; identity inserts use `RETURNING` to return the generated key, and reads paginate with OFFSET/FETCH (or ROWNUM when `LegacyPagination` is on).

The live test suite (`test/Oracle-Live_tests.js`) demonstrates the full round trip: connect, create the table, INSERT with `RETURNING INTO`, READ, paginate, and soft-delete.

---

## Summary

| Step | What It Does |
|------|-------------|
| Configure | Set `Oracle` settings in Fable config or provider options |
| Connect | Call `connectAsync()` (oracledb is asynchronous; `connect()` is parity-only) |
| Query | Use `getConnection()` then the oracledb connection's `execute()` |
| DDL | Generate and execute `CREATE TABLE` (+ sequence/trigger on 11g) from Meadow schemas |
| Indices | Derive and create indices from GUID/ForeignKey/Indexed columns |
| Introspect | Read the `USER_*` views back into Meadow schema objects |
| Meadow | Use standard CRUD; FoxHound emits Oracle-dialect SQL |
