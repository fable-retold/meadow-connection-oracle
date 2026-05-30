# Meadow Connection Oracle

A Fable service that wraps the [oracledb](https://github.com/oracle/node-oracledb) Thin driver for use with Meadow. Register it once and every Meadow entity in your application can share the same managed connection pool, with retry/backoff and server-version-aware DDL built in.

## Quick Start

```bash
npm install meadow-connection-oracle
```

The `oracledb` driver installs automatically. The provider uses oracledb's **Thin mode**, so no Oracle Instant Client is required.

### Connect and query

```javascript
const libFable = require('fable');
const libMeadowConnectionOracle = require('meadow-connection-oracle');

let _Fable = new libFable({
    Product: 'MyApp',
    Oracle: {
        server: '127.0.0.1',
        port: 1521,
        user: 'bookstore',
        password: 'secret',
        connectionType: 'ServiceName',
        serviceName: 'FREEPDB1',
        ConnectionPoolLimit: 10
    }
});

_Fable.serviceManager.addServiceType('MeadowOracleProvider', libMeadowConnectionOracle);
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider');

// oracledb connects asynchronously -- always use connectAsync()
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
                        console.log('Connected:', pResult.rows[0].ONE);
                        pConnection.close();
                    });
            });
    });
```

> **Note:** There is no synchronous auto-connect for Oracle. The oracledb driver establishes its pool asynchronously, so you must call `connectAsync()` and wait for the callback before issuing queries. The synchronous `connect()` exists only for cross-provider parity; it logs a warning and calls `connectAsync()` for you with no callback.

## Configuration

Oracle settings can come from Fable's global settings or be passed directly to the service instance, under an `Oracle` key.

### From Fable settings (recommended)

```javascript
let _Fable = new libFable({
    Oracle: {
        server: '127.0.0.1',
        port: 1521,
        user: 'bookstore',
        password: 'secret',
        connectionType: 'ServiceName',
        serviceName: 'FREEPDB1',
        ConnectionPoolLimit: 10
    }
});
```

| Setting | Type | Description |
|---------|------|-------------|
| `Oracle.server` | string | Oracle hostname |
| `Oracle.port` | number | Oracle listener port (default 1521) |
| `Oracle.user` | string | Database user (connects in this user's own schema) |
| `Oracle.password` | string | Database password |
| `Oracle.serviceName` | string | Service name or SID (default `XEPDB1`) |
| `Oracle.connectionType` | string | `ServiceName` (default) or `SID` |
| `Oracle.connectString` | string | Optional raw Easy Connect string / TNS descriptor; overrides `server`/`port`/`serviceName` |
| `Oracle.ConnectionPoolLimit` | number | Maximum pooled connections (`poolMax`, default 10) |
| `Oracle.RequestTimeoutMs` | number | Per-call timeout applied as `callTimeout` (default 120000) |
| `Oracle.ConnectionTimeoutMs` | number | Time to wait for a free pooled connection, `queueTimeout` (default 60000) |
| `Oracle.LegacyPagination` | boolean | Force ROWNUM pagination (11g). Leave unset to auto-detect |
| `Oracle.LegacyIdentity` | boolean | Force sequence + trigger identity (11g). Leave unset to auto-detect |
| `Oracle.QuoteIdentifiers` | boolean | Wrap identifiers in double quotes to preserve case |
| `Oracle.NumberAsString` | boolean | Fetch `NUMBER` columns as strings to preserve precision |
| `Oracle.ConnectRetryOptions` | object | Connect retry tuning (`MaxAttempts`, `InitialDelayMs`, `MaxDelayMs`, `BackoffFactor`) |
| `Oracle.DDLRetryOptions` | object | DDL retry tuning (same shape) |

Both PascalCase (`Server`, `ServiceName`, `ConnectString`) and lowercase (`server`, `serviceName`, `connectString`) names are accepted for the core connection keys; the constructor coerces PascalCase to the lowercase form oracledb expects.

### Per-instance settings

Pass an Oracle config object when instantiating the service:

```javascript
_Fable.serviceManager.instantiateServiceProvider('MeadowOracleProvider',
    {
        Oracle: {
            server: '127.0.0.1',
            port: 1521,
            user: 'bookstore',
            password: 'secret',
            serviceName: 'FREEPDB1',
            ConnectionPoolLimit: 10
        }
    });
```

## Using with Meadow

Once the provider is connected, Meadow entities query through it when their provider is set to Oracle. [FoxHound](https://fable-retold.github.io/foxhound/) generates the Oracle-dialect SQL (identity `RETURNING`, OFFSET/FETCH or ROWNUM pagination) and Meadow routes it through the pooled connection.

In unquoted-identifier mode (the default) Oracle folds identifiers to UPPERCASE, so result rows come back with UPPERCASE keys; the Meadow Oracle provider's marshaller remaps them to the schema's PascalCase. Set `QuoteIdentifiers: true` to preserve case &mdash; but the schema provider and the FoxHound Oracle dialect must agree on this setting or queries will not resolve.

## Table Creation

The service can generate and execute DDL from Meadow schema definitions, including the sequences and triggers needed for the legacy (11g) identity path. See [Schema &amp; Table Creation](schema.md) for details.

## How It Fits Together

```
Application Code
        |
    Meadow ORM   <- provider set to Oracle
        |
    FoxHound      <- Generates Oracle-dialect SQL
        |
    Meadow-Connection-Oracle   <- This module (pool, retry, DDL, introspection)
        |
    oracledb Pool (Thin mode)  <- Connection pooling
        |
    Oracle Database  <- Your database
```

Meadow Connection Oracle sits between the Meadow ORM layer and the Oracle server. It manages the oracledb pool and a companion schema provider, both of which Meadow's Oracle provider uses to execute queries and DDL.

## Learn More

- [Quickstart](quickstart.md) -- Step-by-step walkthrough with code examples
- [Architecture](architecture.md) -- Design, data flow, retry behavior, and component responsibilities
- [Schema &amp; Table Creation](schema.md) -- Generate Oracle tables, sequences, triggers, and indices from Meadow schemas
- [API Reference](api/reference.md) -- Complete method and property documentation
- [Meadow](https://fable-retold.github.io/meadow/) -- The data access layer
- [FoxHound](https://fable-retold.github.io/foxhound/) -- Query DSL used by Meadow
- [Meadow Connection Manager](https://fable-retold.github.io/meadow-connection-manager/) -- Loads this provider by `Type`
