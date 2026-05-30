# connect()

A synchronous entry point retained for parity with the other Meadow connection providers. Because the `oracledb` driver connects asynchronously, this method simply warns and delegates to [connectAsync()](connectAsync.md) without a callback. **Prefer `connectAsync()`** so you can wait for the pool before issuing queries.

## Signature

```javascript
connect()
```

## Parameters

None.

## Return Value

None.

## Behavior

1. Logs a warning that the non-async `connect()` was called while oracledb connects asynchronously, and that this may cause a race condition.
2. Calls `connectAsync()` with no callback.

Since no callback is provided, you have no direct signal for when the pool is ready or whether it failed. Use `connectAsync()` instead, or poll the `connected` property.

## Why connect() Exists

Other Meadow connection providers expose a synchronous `connect()`. This method keeps the surface consistent so generic code that calls `connect()` does not throw. For Oracle it is strictly a convenience wrapper &mdash; the real work is asynchronous.

```javascript
// Discouraged: fire-and-forget, no readiness signal
_Fable.MeadowOracleProvider.connect();

// Recommended: wait for the pool
_Fable.MeadowOracleProvider.connectAsync(
	(pError, pPool) =>
	{
		if (pError) return console.error(pError);
		// safe to query now
	});
```

## Related

- [connectAsync](connectAsync.md) -- The asynchronous connection method (use this)
- [pool](pool.md) -- Access the connection pool
- [getConnection](getConnection.md) -- Acquire a pooled connection
