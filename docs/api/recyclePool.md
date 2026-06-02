# recyclePool(fCallback)

Destroys the current oracledb pool and creates a fresh one. This is the recovery mechanism the retry helper uses when a failure mode (request timeout, network error, or pool degraded) suggests the pooled connection is in a bad state. It is idempotent and always resolves, even on error, so callers can proceed with their retry regardless.

## Signature

```javascript
recyclePool(fCallback)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | No | Callback `(pError)` - the error is informational only; recycling always proceeds |

## Return Value

None (result provided via callback).

## Behavior

1. If a pool exists, closes it with `close(0)` (drops connections immediately without draining). Errors from `close()` are logged as warnings and recycling continues anyway.
2. Clears `connected` and detaches the pool from the schema provider.
3. Calls `connectAsync()` to build a fresh pool.
4. Calls back. If the reconnect failed, the error is passed through (informationally).

## When It Runs

You normally do not call `recyclePool()` directly. The DDL retry path wires it in as the `OnRecyclePool` hook: when an attempt fails with a mode whose classification recommends recycling (`RequestTimeout`, `NetworkError`, `PoolDegraded`), the retry helper recycles the pool before the next attempt and re-points the schema provider at the new pool.

<!-- bespoke diagram: edit diagrams/when-it-runs.mmd or .hints.json, then: npx pict-renderer-graph build modules/meadow/meadow-connection-oracle/docs/api -->
![When It Runs](diagrams/when-it-runs.svg)

## Manual Use

If you detect a degraded pool yourself, you can force a recycle:

```javascript
_Fable.MeadowOracleProvider.recyclePool(
	(pError) =>
	{
		if (pError)
		{
			console.warn('Recycle reconnect failed:', pError);
			return;
		}
		console.log('Pool recycled.');
	});
```

## Related

- [connectAsync](connectAsync.md) -- Used internally to rebuild the pool
- [getConnection](getConnection.md) -- Acquire a connection from the (recycled) pool
- [Architecture](../architecture.md) -- Retry and error classification details
