# pool (getter)

Returns the underlying `oracledb` connection pool. Most application code should acquire connections through [getConnection()](getConnection.md) instead, which also sets the per-call timeout; the `pool` getter is available for advanced use (custom pool statistics, manual `close()`, etc.).

## Signature

```javascript
get pool()
```

## Return Value

| Type | Description |
|------|-------------|
| oracledb Pool | The connection pool instance (after a successful `connectAsync()`) |
| `false` | Before connection |

## Basic Usage

```javascript
_Fable.MeadowOracleProvider.connectAsync(
	(pError) =>
	{
		if (pError) { return; }

		let tmpPool = _Fable.MeadowOracleProvider.pool;

		tmpPool.getConnection()
			.then((pConnection) =>
			{
				return pConnection.execute(
					'SELECT COUNT(*) AS TOTAL FROM FableTest',
					[],
					{ outFormat: _Fable.MeadowOracleProvider.oracledb.OUT_FORMAT_OBJECT })
					.then((pResult) =>
					{
						console.log('Total:', pResult.rows[0].TOTAL);
						return pConnection.close();
					});
			})
			.catch((pError) => console.error(pError));
	});
```

## Checking Connection State

Verify the pool exists before using it, or check the `connected` property:

```javascript
if (!_Fable.MeadowOracleProvider.connected)
{
	console.error('Not connected to Oracle.');
	return;
}

let tmpPool = _Fable.MeadowOracleProvider.pool;
```

## oracledb Pool Methods

The pool is a standard oracledb pool. The methods most relevant here:

### getConnection()

Returns a promise that resolves to a pooled connection. Prefer the provider's [getConnection()](getConnection.md) callback wrapper, which also applies `callTimeout`.

### close([drainTime])

Closes the pool. `close(0)` drops connections immediately without draining; this is what [recyclePool()](recyclePool.md) uses. Useful for clean shutdown:

```javascript
_Fable.MeadowOracleProvider.pool.close(0)
	.then(() => console.log('Pool closed.'))
	.catch((pError) => console.error(pError));
```

## Related

- [getConnection](getConnection.md) -- The recommended way to run statements
- [connectAsync](connectAsync.md) -- Create the pool
- [recyclePool](recyclePool.md) -- Destroy and recreate the pool
