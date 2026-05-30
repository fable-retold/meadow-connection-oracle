# Architecture

Meadow Connection Oracle bridges the Meadow data access layer and an Oracle Database server. This page documents the component design, data flow, the retry/reconnect machinery, the configuration pipeline, and how the connection pool integrates with the broader Retold ecosystem.

---

## System Architecture

```mermaid
graph TB
	subgraph Application
		A[Application Code]
		B[Meadow ORM]
		C[FoxHound Oracle Dialect]
	end

	subgraph MeadowConnectionOracle["Meadow Connection Oracle"]
		D[MeadowConnectionOracle Service]
		E[Configuration Coercion]
		F[oracledb Connection Pool]
		G[MeadowSchemaOracle]
		H[Meadow-Oracle-Retry]
	end

	subgraph Database["Oracle Server"]
		I[Oracle Database 11g - 23ai]
	end

	A -->|doCreate / doRead / doUpdate / doDelete| B
	B -->|Oracle dialect| C
	C -->|SQL + Binds| D
	D -->|Settings| E
	E -->|Coerced Config| F
	D -->|DDL / Introspection| G
	D -->|connect / DDL retry| H
	G -->|DDL retry| H
	F -->|Thin-mode TCP| I
	G -->|Pooled connection| F

	style MeadowConnectionOracle fill:#e8f4f8,stroke:#2E7D74,stroke-width:2px
	style Application fill:#f5f0e8,stroke:#423D37,stroke-width:1px
	style Database fill:#fef3e2,stroke:#c97a2e,stroke-width:1px
```

---

## Component Responsibilities

### MeadowConnectionOracle Service

The core class, extending `FableServiceProviderBase`. It manages the lifecycle of the `oracledb` connection pool:

- **Construction** -- Reads Oracle settings from per-instance options or Fable config, coerces PascalCase keys to lowercase, and constructs a companion `MeadowSchemaOracle` with a back-reference for pool recycling. It does **not** connect during construction.
- **Pool Management** -- Builds an `oracledb.createPool()` settings object (`poolMax`, `poolMin: 0`, `poolIncrement: 1`, `poolTimeout: 30s`, `queueTimeout`), creates a single pool with retry, and guards against double-connect.
- **Server-Version Detection** -- After connecting, reads `connection.oracleServerVersion` and resolves any unset `LegacyPagination` / `LegacyIdentity` flags to modern (12c+) or legacy (11g) behavior.
- **Connection Acquisition** -- `getConnection()` hands out pooled connections with `callTimeout` set from `RequestTimeoutMs`.
- **Pool Recycling** -- `recyclePool()` closes the current pool (`close(0)`, immediate) and reconnects; invoked by the retry helper on failures that suggest a bad pooled connection.
- **DDL / Introspection Delegation** -- Forwards all schema methods to the schema provider.

### Configuration Coercion

The constructor accepts settings under an `Oracle` key in three shapes and normalizes the core connection keys to lowercase:

```mermaid
graph LR
	subgraph Meadow Style
		A1["Server"]
		A2["Port"]
		A3["User"]
		A4["Password"]
		A5["ServiceName"]
		A6["ConnectString"]
	end

	subgraph oracledb Native
		B1["server"]
		B2["port"]
		B3["user"]
		B4["password"]
		B5["serviceName"]
		B6["connectString"]
	end

	A1 --> B1
	A2 --> B2
	A3 --> B3
	A4 --> B4
	A5 --> B5
	A6 --> B6

	style Meadow Style fill:#f5f0e8,stroke:#423D37
	style oracledb Native fill:#e8f4f8,stroke:#2E7D74
```

Behavioral keys (`ConnectionPoolLimit`, `RequestTimeoutMs`, `ConnectionTimeoutMs`, `ConnectRetryOptions`, `DDLRetryOptions`, `LegacyPagination`, `LegacyIdentity`, `QuoteIdentifiers`, `NumberAsString`) are read as-is from the `Oracle` block.

### oracledb Connection Pool (Thin Mode)

The underlying pool managed by [oracledb](https://github.com/oracle/node-oracledb) in **Thin mode** &mdash; a pure-JavaScript implementation that needs no Oracle Instant Client:

- Maintains pooled connections up to `poolMax` (from `ConnectionPoolLimit`, default 10), starting at `poolMin: 0`.
- Connections are acquired per operation and closed back to the pool.
- `queueTimeout` (from `ConnectionTimeoutMs`) caps how long a caller waits for a free connection.
- `oracledb.fetchAsString` is set to return `CLOB` columns (Text / JSON) as strings so the Meadow marshaller can consume them directly; `NUMBER` is added to that list when `NumberAsString` is enabled.

### MeadowSchemaOracle

A separate `FableServiceProviderBase` service that owns DDL generation, DDL execution, and introspection. The connection provider sets the pool and a back-reference on it. Keeping it separate lets DDL-string generation work without the driver connected (the generators are pure functions of the schema).

### Meadow-Oracle-Retry

A shared helper used by both providers to classify oracledb errors into failure modes and run operations with exponential backoff and optional pool recycling. See [Retry &amp; Error Classification](architecture.md#retry-and-error-classification) below.

---

## Connection Lifecycle

```mermaid
sequenceDiagram
	participant App as Application
	participant Fable as Fable Instance
	participant MCO as MeadowConnectionOracle
	participant Retry as Meadow-Oracle-Retry
	participant Pool as oracledb Pool
	participant Oracle as Oracle Server

	App->>Fable: new libFable(config)
	App->>Fable: addServiceType('MeadowOracleProvider', ...)
	App->>Fable: instantiateServiceProvider('MeadowOracleProvider')
	Fable->>MCO: constructor(fable, manifest, hash)
	MCO->>MCO: Coerce config (PascalCase -> lowercase)
	MCO->>MCO: Build MeadowSchemaOracle + back-reference

	App->>MCO: connectAsync(callback)
	MCO->>MCO: Build connect string + pool settings
	MCO->>Retry: runWithRetry(connect)
	Retry->>Pool: oracledb.createPool(settings)
	Pool->>Oracle: Establish Thin-mode connections
	Pool-->>Retry: pool (or retryable error)
	Retry-->>MCO: pool
	MCO->>MCO: connected = true; schemaProvider.setConnectionPool(pool)
	MCO->>Pool: getConnection() -> read oracleServerVersion
	MCO->>MCO: Resolve unset LegacyPagination / LegacyIdentity
	MCO-->>App: callback(null, pool)

	App->>MCO: getConnection(callback)
	MCO->>Pool: pool.getConnection()
	Pool-->>MCO: connection (callTimeout set)
	MCO-->>App: callback(null, connection)
	App->>Oracle: connection.execute(sql, binds)
	Oracle-->>App: result
	App->>Pool: connection.close()
```

---

## Configuration Pipeline

Settings flow through a priority chain in the constructor:

1. **`options.Oracle` object** -- If present, used directly; common PascalCase keys (`Server`, `Port`, `User`, `Password`) are coerced to lowercase.
2. **Flat options** -- If `options.user` is a string (no `Oracle` object), the flat keys are gathered into an `Oracle` block.
3. **`fable.settings.Oracle`** -- Otherwise the constructor reads Fable settings, accepting either case for the core keys.

The pool itself is created later, on `connectAsync()`.

```mermaid
flowchart TD
	A[Constructor Called] --> B{options.Oracle object?}
	B -->|Yes| C[Coerce PascalCase keys to lowercase]
	B -->|No| D{options.user is a string?}
	D -->|Yes| E[Gather flat keys into Oracle block]
	D -->|No| F{fable.settings.Oracle object?}
	F -->|Yes| G[Build Oracle block from settings]
	F -->|No| H[No Oracle config available]
	C --> I[Build MeadowSchemaOracle]
	E --> I
	G --> I
	I --> J[Wait for connectAsync]
	J --> K[Build pool settings + connect with retry]
	K --> L[Detect server version, resolve legacy flags]
```

---

## DDL Generation Flow

`generateCreateTableStatement()` walks a Meadow table schema and produces Oracle DDL:

```mermaid
flowchart LR
	A[Meadow Table Schema] --> B[Walk Columns Array]
	B --> C{DataType?}
	C -->|ID 12c+| D["NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"]
	C -->|ID legacy| D2["NUMBER PRIMARY KEY (+ sequence + trigger)"]
	C -->|GUID| E["VARCHAR2(Size) DEFAULT '0000...' NOT NULL"]
	C -->|ForeignKey| F["NUMBER DEFAULT 0 NOT NULL"]
	C -->|Numeric| G["NUMBER DEFAULT 0 NOT NULL"]
	C -->|Decimal| H["NUMBER(Size)"]
	C -->|String| I["VARCHAR2(Size) DEFAULT ' '"]
	C -->|Text / JSON| J["CLOB"]
	C -->|DateTime| K["TIMESTAMP"]
	C -->|Boolean| L["NUMBER(1) DEFAULT 0"]
	D --> M["CREATE TABLE Name ( ... )"]
	D2 --> M
```

`generateCreateTableStatements()` returns an ordered array. For the 12c+ identity path that is just the `CREATE TABLE`; for the legacy (11g) path it appends a `CREATE SEQUENCE SEQ_<Table>` and a `CREATE OR REPLACE TRIGGER TRG_<Table>` that populates the ID column on insert, so the dialect's `RETURNING` clause works unchanged across versions.

Two Oracle-specific quirks are handled in the type map:

- Oracle treats `''` as `NULL`, so a `NOT NULL String` column with a `''` default would reject its own default. `String` columns therefore default to a single space and are left nullable.
- Oracle (pre-23c) has no table `BOOLEAN` type, so `Boolean` maps to `NUMBER(1)` with `0`/`1` values, matching the dialect's literal handling.

Identifiers are emitted **unquoted by default** (Oracle folds them to UPPERCASE). Setting `QuoteIdentifiers: true` wraps every identifier in double quotes to preserve case. The schema provider and the FoxHound Oracle dialect must agree on this setting.

---

## Idempotent DDL

Oracle lacks `DROP TABLE IF EXISTS` and `CREATE INDEX IF NOT EXISTS`, so the provider makes DDL idempotent itself:

- **Drop** -- `generateDropTableStatement()` wraps the drop in a PL/SQL block that re-raises everything except `ORA-00942` (table or view does not exist).
- **Create table** -- statements run sequentially; `ORA-00955` (object already exists) is swallowed per statement, so re-running a create is safe.
- **Create index** -- each index is checked against `USER_INDEXES` first and only created when absent.

---

## Retry and Error Classification

The `Meadow-Oracle-Retry` helper wraps connect and DDL operations. It classifies each oracledb error (keyed off the `ORA-NNNNN` number in `err.errorNum`, the message text, or socket-level `err.code`) into one of these modes:

| Mode | Meaning | Retryable | Recycle Pool |
|------|---------|-----------|--------------|
| `AlreadyExists` | `ORA-00955` / "name is already used" | No (treated as success) | No |
| `ServerError` | Deterministic SQL errors (syntax, missing object, bad credentials, constraint violations) | No | No |
| `RequestTimeout` | Call timeout or lock contention (`ORA-01013`, `ORA-04021`, `DPI-1067`, ...) | Yes | Yes |
| `NetworkError` | Transport failures (`ORA-03113`, `ORA-12541`, `ECONNRESET`, `ETIMEDOUT`, ...) | Yes | Yes |
| `PoolDegraded` | A fast failure (&lt;500ms) right after a prior slow (&gt;5s) timeout | Yes | Yes |
| `Unknown` | Anything else | Yes (cautiously) | No |

`runWithRetry()` then drives the operation:

```mermaid
flowchart TD
	A[Attempt operation] --> B{Error?}
	B -->|No| C[Success -> callback]
	B -->|Yes| D[Classify error]
	D --> E{SuccessMode? e.g. AlreadyExists}
	E -->|Yes| C
	E -->|No| F{Retryable?}
	F -->|No| G[Give up -> callback error]
	F -->|Yes| H{Attempts exhausted?}
	H -->|Yes| G
	H -->|No| I{Recommend recycle AND hook present?}
	I -->|Yes| J[recyclePool, then backoff]
	I -->|No| K[Backoff]
	J --> A
	K --> A
```

Backoff is exponential (`InitialDelayMs * BackoffFactor^(attempt-1)`, capped at `MaxDelayMs`). Defaults: connect uses 5 attempts starting at 3s; DDL uses 5 attempts starting at 3s; the retry engine's base defaults are 5 attempts / 2s initial / 30s cap / factor 2. All are overridable via `Oracle.ConnectRetryOptions` and `Oracle.DDLRetryOptions`.

When a retry recommends recycling, the schema provider's retry hook calls the connection provider's `recyclePool()` and re-points the schema provider at the fresh pool before the next attempt.

---

## Double-Connect Prevention

```mermaid
flowchart TD
	A[connectAsync called] --> B{Pool already exists?}
	B -->|Yes| C[Log error, return existing pool via callback]
	B -->|No| D[Build settings + connect with retry]
	D --> E[Set connected = true, attach pool to schema provider]
	E --> F[Detect server version + resolve legacy flags]
	F --> G[callback with pool]
```

If `connectAsync()` is called when a pool already exists, it logs an error and returns the existing pool without creating a second one. A missing callback is replaced with a no-op (and a warning is logged).

---

## Meadow Integration

When Meadow uses the Oracle provider, queries follow this path:

```mermaid
sequenceDiagram
	participant App as Application
	participant Meadow as Meadow Entity
	participant FH as FoxHound (Oracle dialect)
	participant Provider as Meadow Oracle Provider
	participant MCO as MeadowConnectionOracle
	participant Pool as oracledb Pool

	App->>Meadow: doReads(query, callback)
	Meadow->>FH: Build Oracle SQL (OFFSET/FETCH or ROWNUM)
	FH-->>Meadow: SQL string + binds
	Meadow->>Provider: Execute read
	Provider->>MCO: getConnection()
	MCO-->>Provider: pooled connection
	Provider->>Pool: connection.execute(sql, binds)
	Pool-->>Provider: rows (UPPERCASE keys in unquoted mode)
	Provider->>Provider: Marshal rows back to PascalCase
	Provider-->>Meadow: records
	Meadow-->>App: callback(error, query, records)
```

The pool is shared across all Meadow entities resolving the same Fable service instance. Identity inserts use FoxHound's `RETURNING` clause to return the generated key; in legacy mode the sequence + trigger populate the key so `RETURNING` still works.

---

## Comparison with Other Connectors

| Feature | Oracle | MySQL | MSSQL | SQLite |
|---------|--------|-------|-------|--------|
| Connection Type | Pool (Thin-mode TCP) | Pool (TCP) | Pool (TDS) | File handle |
| Server Required | Yes | Yes | Yes | No |
| Native Client | None (Thin mode) | mysql2 | tedious | better-sqlite3 |
| Connect Mode | Async (`connectAsync`) | Sync + async wrapper | Async | Async |
| Auto-Connect Flag | No | Yes | No | No |
| Retry / Backoff | Yes (classified) | No | No | No |
| Pool Recycling | Yes | No | No | No |
| DDL Generation | Yes (+ sequence/trigger on 11g) | Yes | Yes | No |
| Idempotent DDL | PL/SQL block + USER_INDEXES check | `IF NOT EXISTS` | Yes | N/A |
| Introspection | Yes (USER_* views) | Varies | Varies | Varies |
| Config Coercion | PascalCase -> lowercase | PascalCase -> camelCase | N/A | N/A |
| Underlying Library | oracledb | mysql2 | tedious | better-sqlite3 |
