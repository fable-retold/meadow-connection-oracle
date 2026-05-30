# Meadow Connection Oracle

> Oracle Database connection pooling as a Fable service

A wrapper around the [oracledb](https://github.com/oracle/node-oracledb) Thin driver (no Instant Client required) that manages connection pooling, retries transient failures, and integrates with Meadow for provider-based data access. Register once, query from anywhere.

- **Thin Mode** -- Pure-JavaScript oracledb driver; no Oracle Instant Client
- **Connection Pooling** -- Managed oracledb pool with a configurable pool limit and timeouts
- **Retry & Reconnect** -- Classified error handling with exponential backoff and pool recycling
- **Server-Version-Aware DDL** -- 12c+ identity columns or legacy 11g sequence + trigger, auto-detected
- **Schema Introspection** -- Reverse-engineer Meadow schemas from the USER_* data dictionary
- **Flexible Config** -- Easy Connect strings (ServiceName or SID), or a raw connectString override

[Get Started](README.md)
[Quickstart](quickstart.md)
[Architecture](architecture.md)
[Schema & Tables](schema.md)
[API Reference](api/reference.md)
[GitHub](https://github.com/fable-retold/meadow-connection-oracle)
