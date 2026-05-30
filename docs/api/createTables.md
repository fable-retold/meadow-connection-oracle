# createTables(pMeadowSchema, fCallback)

Creates all tables defined in a Meadow schema object by calling `createTable()` for each table sequentially. Delegated to the schema provider.

## Signature

```javascript
createTables(pMeadowSchema, fCallback)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pMeadowSchema` | object | Yes | Schema with a `Tables` array of table schema objects |
| `fCallback` | function | Yes | Callback `(pError)` |

### Schema Object Format

```javascript
{
	Tables:
	[
		{
			TableName: 'Author',
			Columns:
			[
				{ Column: 'IDAuthor', DataType: 'ID' },
				{ Column: 'Name', DataType: 'String', Size: '200' }
			]
		},
		{
			TableName: 'Book',
			Columns:
			[
				{ Column: 'IDBook', DataType: 'ID' },
				{ Column: 'Title', DataType: 'String', Size: '256' },
				{ Column: 'IDAuthor', DataType: 'ForeignKey' }
			]
		}
	]
}
```

## Return Value

None (result provided via callback).

## Behavior

1. Iterates `pMeadowSchema.Tables` using `fable.Utility.eachLimit()` with a concurrency of 1 (serial).
2. Calls `createTable()` for each table (which itself retries and is idempotent on `ORA-00955`).
3. If any table fails terminally, logs the error and passes it to the final callback.
4. On completion, logs "Done creating tables!" and calls `fCallback(pError)` (with `pError` null on success).

## Basic Usage

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
				{ Column: 'Name', DataType: 'String', Size: '200' },
				{ Column: 'Bio', DataType: 'Text' }
			]
		},
		{
			TableName: 'Book',
			Columns:
			[
				{ Column: 'IDBook', DataType: 'ID' },
				{ Column: 'GUIDBook', DataType: 'GUID' },
				{ Column: 'Title', DataType: 'String', Size: '256' },
				{ Column: 'Year', DataType: 'Numeric' },
				{ Column: 'Price', DataType: 'Decimal', Size: '10,2' },
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

## Serial Execution

Tables are created one at a time (concurrency of 1), in the order they appear in the `Tables` array. On a legacy (11g) connection, each table's sequence and trigger are created as part of that table's step.

## Error Handling

If a table fails with a terminal (non-retryable, non-"already exists") error, iteration stops and the error is passed to the callback. Tables created before the failure remain in the database.

## Related

- [createTable](createTable.md) -- Create a single table
- [generateCreateTableStatement](generateCreateTableStatement.md) -- Generate DDL without executing
- [Schema &amp; Table Creation](../schema.md) -- Full walkthrough
