# createTable(pMeadowTableSchema, fCallback)

Generates and executes the create-table statements for a single table against the connected Oracle pool, with retry. On a legacy (11g) connection this includes the sequence and trigger needed for auto-increment keys. Delegated to the schema provider.

## Signature

```javascript
createTable(pMeadowTableSchema, fCallback)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pMeadowTableSchema` | object | Yes | Schema with `TableName` and `Columns` array |
| `fCallback` | function | Yes | Callback `(pError)` |

## Return Value

None (result provided via callback).

## Behavior

1. Calls `generateCreateTableStatements()` to build the ordered statement list (just the `CREATE TABLE` on 12c+; `CREATE TABLE` + `CREATE SEQUENCE` + `CREATE OR REPLACE TRIGGER` on legacy).
2. Runs the statements through the retry helper. Each statement executes sequentially with `autoCommit`.
3. `ORA-00955` (object already exists) is swallowed per statement, so the operation is idempotent.
4. Retryable failures (lock contention, network drops) are retried with backoff, recycling the pool when the failure mode recommends it.
5. On success, logs and calls `fCallback()` with no error. On terminal failure, calls `fCallback(pError)`.

## Basic Usage

```javascript
let tmpSchema =
{
	TableName: 'FableTest',
	Columns:
	[
		{ Column: 'IDFableTest', DataType: 'ID' },
		{ Column: 'GUIDFableTest', DataType: 'GUID' },
		{ Column: 'Title', DataType: 'String', Size: '256' },
		{ Column: 'IDAuthor', DataType: 'ForeignKey' }
	]
};

_Fable.MeadowOracleProvider.createTable(tmpSchema,
	(pError) =>
	{
		if (pError)
		{
			console.error('Table creation failed:', pError);
			return;
		}
		console.log('FableTest table created successfully.');
	});
```

## Idempotent Operation

Because `ORA-00955` is treated as success per statement, calling `createTable()` for a table (or sequence/trigger) that already exists does not produce an error. This makes it safe to call during application startup without checking for pre-existing objects.

## Prerequisites

The pool must be connected before calling `createTable()`:

```javascript
_Fable.MeadowOracleProvider.connectAsync(
	(pError) =>
	{
		if (pError) { return; }

		_Fable.MeadowOracleProvider.createTable(tmpSchema,
			(pCreateError) =>
			{
				if (pCreateError) { console.error(pCreateError); }
			});
	});
```

## DDL Retry Tuning

Override the DDL retry behavior with `Oracle.DDLRetryOptions`:

```javascript
Oracle:
{
	// ...
	DDLRetryOptions: { MaxAttempts: 3, InitialDelayMs: 2000, MaxDelayMs: 20000, BackoffFactor: 2 }
}
```

## Related

- [generateCreateTableStatement](generateCreateTableStatement.md) -- Generate DDL without executing
- [createTables](createTables.md) -- Create multiple tables sequentially
- [generateDropTableStatement](generateDropTableStatement.md) -- Generate the DROP TABLE block
- [Schema &amp; Table Creation](../schema.md) -- Full walkthrough
