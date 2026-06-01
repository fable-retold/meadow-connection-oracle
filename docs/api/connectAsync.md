# connectAsync(fCallback)

Creates the `oracledb` connection pool, with retry and exponential backoff, then auto-detects the server version and resolves any unset legacy flags before invoking the callback. This is the primary way to connect - the oracledb driver establishes its pool asynchronously.

## Signature

```javascript
connectAsync(fCallback)
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fCallback` | function | Recommended | Callback `(pError, pConnectionPool)`. If omitted, a no-op is substituted and a warning is logged |

## Return Value

None (result provided via callback).

## Callback Arguments

| Argument | Type | Description |
|----------|------|-------------|
| `pError` | Error or null | Connection error after retries are exhausted, if any |
| `pConnectionPool` | oracledb Pool | The oracledb connection pool instance |

## Behavior

1. If `fCallback` is not a function, logs a warning and substitutes a no-op.
2. If a pool already exists, returns it immediately via the callback (no reconnection).
3. Builds the pool settings (`user`, `password`, `connectString`, `poolMax`, `poolMin: 0`, `poolIncrement: 1`, `poolTimeout: 30`, `queueTimeout`).
4. Sets `oracledb.fetchAsString` to return `CLOB` (and, when `NumberAsString` is set, `NUMBER`) columns as strings.
5. Calls `oracledb.createPool()` through the retry helper. Network and timeout failures are retried with backoff; deterministic errors fail fast.
6. On success: stores the pool, sets `connected = true`, attaches the pool to the schema provider, auto-detects the server version, resolves unset `LegacyPagination` / `LegacyIdentity` flags, then invokes the callback.
7. On final failure: logs the failure mode and calls `fCallback(pError)`.

## Basic Usage

```javascript
const libFable = require('fable');
const libMeadowConnectionOracle = require('meadow-connection-oracle');

let _Fable = new libFable(
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

		_Fable.MeadowOracleProvider.getConnection(
			(pConnError, pConnection) =>
			{
				if (pConnError) return;
				pConnection.execute('SELECT 1 AS ONE FROM DUAL', [],
					{ outFormat: _Fable.MeadowOracleProvider.oracledb.OUT_FORMAT_OBJECT })
					.then((pResult) =>
					{
						console.log('Connected:', pResult.rows[0].ONE);
						pConnection.close();
					});
			});
	});
```

## Server-Version Detection

After the pool is created, `connectAsync()` opens one connection to read `oracleServerVersion`. For each of `LegacyPagination` and `LegacyIdentity` that you did **not** set explicitly, it picks legacy behavior for servers below 12.1 and modern behavior otherwise. Explicitly configured flags are always honored. If the version cannot be read, unset flags default to modern (12c+) behavior.

This means a fresh connection to a 23ai or 19c server resolves both flags to `false`, while a connection to an 11g server resolves them to `true` - with no configuration required.

## Idempotent Calls

If the pool already exists, `connectAsync()` returns it via the callback without creating a second pool:

```javascript
_Fable.MeadowOracleProvider.connectAsync(
	(pError, pPool1) =>
	{
		_Fable.MeadowOracleProvider.connectAsync(
			(pError, pPool2) =>
			{
				console.log(pPool1 === pPool2);
				// => true
			});
	});
```

## Retry Behavior

Connection establishment is retried with exponential backoff (default: 5 attempts, 3s initial delay, 30s cap, factor 2). Tune it via `Oracle.ConnectRetryOptions`:

```javascript
Oracle:
{
	// ...
	ConnectRetryOptions: { MaxAttempts: 3, InitialDelayMs: 1000, MaxDelayMs: 10000, BackoffFactor: 2 }
}
```

Because there is no pool yet during connect, connection retries never recycle a pool.

## Related

- [connect](connect.md) -- Parity-only synchronous entry point
- [getConnection](getConnection.md) -- Acquire a pooled connection
- [recyclePool](recyclePool.md) -- Destroy and recreate the pool
- [pool](pool.md) -- Access the connection pool
