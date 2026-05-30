# generateDropTableStatement(pTableName)

Generates a PL/SQL block that drops a table. Oracle has no `DROP TABLE IF EXISTS`, so the block swallows `ORA-00942` (table or view does not exist) and re-raises everything else, making the drop idempotent. Delegated to the schema provider.

## Signature

```javascript
generateDropTableStatement(pTableName)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pTableName` | string | Yes | The name of the table to drop |

## Return Value

A string containing the PL/SQL `DROP TABLE` block (no trailing semicolon after the block in the returned string beyond the `END;`).

## Basic Usage

```javascript
let tmpSQL = _Fable.MeadowOracleProvider.generateDropTableStatement('FableTest');
console.log(tmpSQL);
```

Produces (default, unquoted mode):

```sql
BEGIN
    EXECUTE IMMEDIATE 'DROP TABLE FableTest CASCADE CONSTRAINTS';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLCODE != -942 THEN RAISE; END IF;
END;
```

`CASCADE CONSTRAINTS` drops any foreign-key constraints that reference the table. `SQLCODE != -942` lets a "table does not exist" error pass silently while still raising real errors.

## Quoted Identifiers

With `Oracle.QuoteIdentifiers: true`, the table name is double-quoted to match a case-preserved table:

```sql
BEGIN
    EXECUTE IMMEDIATE 'DROP TABLE "FableTest" CASCADE CONSTRAINTS';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLCODE != -942 THEN RAISE; END IF;
END;
```

## Executing the Statement

This method only generates the SQL. Execute it against a pooled connection yourself:

```javascript
let tmpDropSQL = _Fable.MeadowOracleProvider.generateDropTableStatement('FableTest');

_Fable.MeadowOracleProvider.getConnection(
	(pConnError, pConnection) =>
	{
		if (pConnError) return console.error(pConnError);
		pConnection.execute(tmpDropSQL, [], { autoCommit: true })
			.then(() => pConnection.close())
			.then(() => console.log('Table dropped (or did not exist).'))
			.catch((pError) => { console.error(pError); pConnection.close(); });
	});
```

## Recreating a Table

Combine with `createTable()` to drop and recreate:

```javascript
let tmpDropSQL = _Fable.MeadowOracleProvider.generateDropTableStatement('FableTest');

_Fable.MeadowOracleProvider.getConnection(
	(pConnError, pConnection) =>
	{
		if (pConnError) return console.error(pConnError);
		pConnection.execute(tmpDropSQL, [], { autoCommit: true })
			.then(() => pConnection.close())
			.then(() =>
			{
				_Fable.MeadowOracleProvider.createTable(tmpTableSchema,
					(pCreateError) =>
					{
						if (pCreateError) return console.error(pCreateError);
						console.log('Table recreated.');
					});
			})
			.catch((pError) => { console.error(pError); pConnection.close(); });
	});
```

## Related

- [generateCreateTableStatement](generateCreateTableStatement.md) -- Generate CREATE TABLE DDL
- [createTable](createTable.md) -- Create a table from schema
- [getConnection](getConnection.md) -- Acquire a connection to execute the drop
