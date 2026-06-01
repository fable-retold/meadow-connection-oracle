# getConnection(fCallback)

Acquires a connection from the oracledb pool. The Meadow Oracle provider uses this to run statements (oracledb has no separate prepared-statement class - statements are prepared implicitly per `execute()`, with pool statement caching).

## Signature

```javascript
getConnection(fCallback)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | Yes | Callback `(pError, pConnection)` |

## Return Value

None (result provided via callback).

## Callback Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `pError` | Error or null | An error if disconnected, if there is no pool, or if acquisition fails |
| `pConnection` | oracledb Connection | A pooled connection with `callTimeout` set |

## Behavior

1. If the provider is not connected or has no pool, calls back with an `Error` ("could not acquire a connection; disconnected or no valid connection pool").
2. Acquires a connection via `pool.getConnection()`.
3. Sets the connection's `callTimeout` from `RequestTimeoutMs` (default 120000 ms). Drivers that do not support `callTimeout` are tolerated.
4. Calls back with the connection.

## Basic Usage

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
				console.log(pResult.rows);
				return pConnection.close();
			})
			.catch((pError) =>
			{
				console.error(pError);
				pConnection.close();
			});
	});
```

## Always Close the Connection

Call `pConnection.close()` when you are done to return the connection to the pool. Failing to close leaks connections and can exhaust `poolMax`, after which new acquisitions wait up to `queueTimeout` (from `ConnectionTimeoutMs`) before failing.

## Bind Parameters and RETURNING

The oracledb connection's `execute(sql, binds, options)` accepts bind objects. For CLOB binds and identity `RETURNING` out-binds, use the oracledb constants from the `oracledb` getter:

```javascript
let tmpOracleDB = _Fable.MeadowOracleProvider.oracledb;

let tmpBinds = {
	Title: 'Dune',
	RETURNING_ID: { dir: tmpOracleDB.BIND_OUT, type: tmpOracleDB.NUMBER }
};

pConnection.execute(
	'INSERT INTO FableTest (Title) VALUES (:Title) RETURNING IDFableTest INTO :RETURNING_ID',
	tmpBinds,
	{ autoCommit: true, outFormat: tmpOracleDB.OUT_FORMAT_OBJECT })
	.then((pResult) =>
	{
		console.log('New ID:', pResult.outBinds.RETURNING_ID[0]);
		pConnection.close();
	});
```

## Related

- [connectAsync](connectAsync.md) -- Create the connection pool first
- [pool](pool.md) -- The pool the connection comes from
- [recyclePool](recyclePool.md) -- Recreate the pool after failures
