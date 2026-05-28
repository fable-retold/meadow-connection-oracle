/**
* Meadow Oracle Provider Fable Service
*
* Manages an oracledb connection pool (Thin mode by default — no Instant
* Client required) and delegates DDL / introspection to the Oracle schema
* provider.  Patterned after the other Meadow SQL connectors.
*
* @author Steven Velozo <steven@velozo.com>
*/
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOracleDB = require('oracledb');

const libMeadowSchemaOracle = require('./Meadow-Schema-Oracle.js');
const libRetry = require('./Meadow-Oracle-Retry.js');

// Default timeouts and retry behavior.  All configurable per-provider via the
// Oracle options block in fable settings.  Defaults lean generous for slow WAN
// links / firewalled customer networks.
const DEFAULT_REQUEST_TIMEOUT_MS    = 120000;  // 2 min per call (oracledb callTimeout)
const DEFAULT_CONNECTION_TIMEOUT_MS = 60000;   // 1 min to acquire a pooled connection
const DEFAULT_CONNECT_MAX_ATTEMPTS  = 5;
const DEFAULT_CONNECT_INITIAL_DELAY = 3000;
const DEFAULT_CONNECT_MAX_DELAY     = 30000;
const DEFAULT_PORT                  = 1521;

// OFFSET/FETCH pagination and NUMBER ... GENERATED AS IDENTITY columns were
// both introduced in Oracle 12.1.  oracledb's connection.oracleServerVersion
// encodes 12.1.0.0 as 1201000000, so anything below that needs the legacy
// (ROWNUM pagination + sequence/trigger identity) code paths.
const ORACLE_12_1_VERSION           = 1201000000;

class MeadowConnectionOracle extends libFableServiceProviderBase
{
	constructor(pFable, pManifest, pServiceHash)
	{
		super(pFable, pManifest, pServiceHash);

		this.serviceType = 'MeadowConnectionOracle';

		this.connected = false;

		// Resolve Oracle connection settings from options or fable settings.
		if (typeof(this.options.Oracle) == 'object')
		{
			// Coerce common PascalCase keys to lowercase for the driver.
			if (!this.options.Oracle.hasOwnProperty('server') && this.options.Oracle.hasOwnProperty('Server'))
			{
				this.options.Oracle.server = this.options.Oracle.Server;
			}
			if (!this.options.Oracle.hasOwnProperty('port') && this.options.Oracle.hasOwnProperty('Port'))
			{
				this.options.Oracle.port = this.options.Oracle.Port;
			}
			if (!this.options.Oracle.hasOwnProperty('user') && this.options.Oracle.hasOwnProperty('User'))
			{
				this.options.Oracle.user = this.options.Oracle.User;
			}
			if (!this.options.Oracle.hasOwnProperty('password') && this.options.Oracle.hasOwnProperty('Password'))
			{
				this.options.Oracle.password = this.options.Oracle.Password;
			}
		}
		else if (typeof(this.options.user) === 'string')
		{
			// Options were passed in flat.
			this.options.Oracle = (
				{
					server: this.options.server,
					port: this.options.port,
					user: this.options.user,
					password: this.options.password,
					serviceName: this.options.serviceName,
					connectionType: this.options.connectionType,
					connectString: this.options.connectString,
					ConnectionPoolLimit: this.options.ConnectionPoolLimit,
					RequestTimeoutMs: this.options.RequestTimeoutMs,
					ConnectionTimeoutMs: this.options.ConnectionTimeoutMs,
					ConnectRetryOptions: this.options.ConnectRetryOptions,
					DDLRetryOptions: this.options.DDLRetryOptions,
					LegacyPagination: this.options.LegacyPagination,
					LegacyIdentity: this.options.LegacyIdentity,
					QuoteIdentifiers: this.options.QuoteIdentifiers,
					NumberAsString: this.options.NumberAsString
				});
		}
		else if (typeof(this.fable.settings.Oracle) == 'object')
		{
			let tmpSettings = this.fable.settings.Oracle;
			this.options.Oracle = (
				{
					server: tmpSettings.server || tmpSettings.Server,
					port: tmpSettings.port || tmpSettings.Port,
					user: tmpSettings.user || tmpSettings.User,
					password: tmpSettings.password || tmpSettings.Password,
					serviceName: tmpSettings.serviceName || tmpSettings.ServiceName,
					connectionType: tmpSettings.connectionType || tmpSettings.ConnectionType,
					connectString: tmpSettings.connectString || tmpSettings.ConnectString,
					ConnectionPoolLimit: tmpSettings.ConnectionPoolLimit,
					RequestTimeoutMs: tmpSettings.RequestTimeoutMs,
					ConnectionTimeoutMs: tmpSettings.ConnectionTimeoutMs,
					ConnectRetryOptions: tmpSettings.ConnectRetryOptions,
					DDLRetryOptions: tmpSettings.DDLRetryOptions,
					LegacyPagination: tmpSettings.LegacyPagination,
					LegacyIdentity: tmpSettings.LegacyIdentity,
					QuoteIdentifiers: tmpSettings.QuoteIdentifiers,
					NumberAsString: tmpSettings.NumberAsString
				});
		}

		// Schema provider handles DDL / introspection.  Give it a
		// back-reference so it can trigger pool recycling via the retry helper
		// when it detects a degraded pool.
		this._SchemaProvider = new libMeadowSchemaOracle(this.fable, this.options, `${this.Hash}-Schema`);
		this._SchemaProvider.setConnectionProvider(this);
	}

	get schemaProvider()
	{
		return this._SchemaProvider;
	}

	// Schema / DDL delegation

	generateDropTableStatement(pTableName)
	{
		return this._SchemaProvider.generateDropTableStatement(pTableName);
	}

	generateCreateTableStatement(pMeadowTableSchema)
	{
		return this._SchemaProvider.generateCreateTableStatement(pMeadowTableSchema);
	}

	generateCreateTableStatements(pMeadowTableSchema)
	{
		return this._SchemaProvider.generateCreateTableStatements(pMeadowTableSchema);
	}

	createTables(pMeadowSchema, fCallback)
	{
		return this._SchemaProvider.createTables(pMeadowSchema, fCallback);
	}

	createTable(pMeadowTableSchema, fCallback)
	{
		return this._SchemaProvider.createTable(pMeadowTableSchema, fCallback);
	}

	getIndexDefinitionsFromSchema(pMeadowTableSchema)
	{
		return this._SchemaProvider.getIndexDefinitionsFromSchema(pMeadowTableSchema);
	}

	generateCreateIndexStatements(pMeadowTableSchema)
	{
		return this._SchemaProvider.generateCreateIndexStatements(pMeadowTableSchema);
	}

	createIndex(pIndexStatement, fCallback)
	{
		return this._SchemaProvider.createIndex(pIndexStatement, fCallback);
	}

	createIndices(pMeadowTableSchema, fCallback)
	{
		return this._SchemaProvider.createIndices(pMeadowTableSchema, fCallback);
	}

	createAllIndices(pMeadowSchema, fCallback)
	{
		return this._SchemaProvider.createAllIndices(pMeadowSchema, fCallback);
	}

	// Database Introspection delegation

	listTables(fCallback)
	{
		return this._SchemaProvider.listTables(fCallback);
	}

	introspectTableColumns(pTableName, fCallback)
	{
		return this._SchemaProvider.introspectTableColumns(pTableName, fCallback);
	}

	introspectTableIndices(pTableName, fCallback)
	{
		return this._SchemaProvider.introspectTableIndices(pTableName, fCallback);
	}

	introspectTableForeignKeys(pTableName, fCallback)
	{
		return this._SchemaProvider.introspectTableForeignKeys(pTableName, fCallback);
	}

	introspectTableSchema(pTableName, fCallback)
	{
		return this._SchemaProvider.introspectTableSchema(pTableName, fCallback);
	}

	introspectDatabaseSchema(fCallback)
	{
		return this._SchemaProvider.introspectDatabaseSchema(fCallback);
	}

	connect()
	{
		this.log.warn('The non-async Meadow-Oracle connect() was called and the oracledb driver connects asynchronously; although this may function it will likely cause a race condition.');
		this.connectAsync();
	}

	/**
	 * Build the Easy Connect connect string from the configured settings, or
	 * pass through an explicit connectString / TNS descriptor when supplied.
	 *
	 * @param {Object} pSettings
	 * @returns {string}
	 */
	_buildConnectString(pSettings)
	{
		if (pSettings.connectString)
		{
			return pSettings.connectString;
		}
		let tmpHost = pSettings.server || 'localhost';
		let tmpPort = pSettings.port || DEFAULT_PORT;
		let tmpService = pSettings.serviceName || pSettings.database || 'XEPDB1';
		if ((pSettings.connectionType || 'ServiceName').toString().toUpperCase() === 'SID')
		{
			// Legacy SID form: host:port:sid
			return `${tmpHost}:${tmpPort}:${tmpService}`;
		}
		// Easy Connect service form: host:port/service
		return `${tmpHost}:${tmpPort}/${tmpService}`;
	}

	/**
	 * Build an oracledb createPool() settings object from this provider's
	 * configured options.  Centralised so connectAsync and recyclePool produce
	 * identical settings.
	 *
	 * @returns {Object}
	 */
	_buildConnectionSettings()
	{
		let tmpSettings = this.options.Oracle || {};
		let tmpQueueTimeoutMs = tmpSettings.ConnectionTimeoutMs
			|| tmpSettings.connectionTimeoutMs
			|| DEFAULT_CONNECTION_TIMEOUT_MS;

		return (
			{
				user: tmpSettings.user,
				password: tmpSettings.password,
				connectString: this._buildConnectString(tmpSettings),
				poolMax: tmpSettings.ConnectionPoolLimit || 10,
				poolMin: 0,
				poolIncrement: 1,
				poolTimeout: 30,                 // seconds idle before the pool shrinks
				queueTimeout: tmpQueueTimeoutMs  // ms to wait for a free connection
			});
	}

	/**
	 * Resolve connect-retry options, falling back to defaults tuned for a slow
	 * network.  Connection establishment never recycles a pool (there isn't one
	 * yet) so OnRecyclePool is intentionally absent.
	 *
	 * @returns {Object}
	 */
	_connectRetryOptions()
	{
		let tmpSettings = this.options.Oracle || {};
		let tmpRetry = tmpSettings.ConnectRetryOptions || {};
		return (
			{
				OperationName: `Meadow-Oracle connect to [${this._buildConnectString(tmpSettings)}]`,
				MaxAttempts: tmpRetry.MaxAttempts || DEFAULT_CONNECT_MAX_ATTEMPTS,
				InitialDelayMs: tmpRetry.InitialDelayMs || DEFAULT_CONNECT_INITIAL_DELAY,
				MaxDelayMs: tmpRetry.MaxDelayMs || DEFAULT_CONNECT_MAX_DELAY,
				BackoffFactor: tmpRetry.BackoffFactor || 2
			});
	}

	connectAsync(fCallback)
	{
		let tmpCallback = fCallback;
		if (typeof (tmpCallback) !== 'function')
		{
			this.log.error(`Meadow Oracle connect() called without a callback; this could lead to connection race conditions.`);
			tmpCallback = () => { };
		}

		if (this._ConnectionPool)
		{
			this.log.error(`Meadow-Connection-Oracle trying to connect but is already connected - skipping the generation of extra connections.`);
			return tmpCallback(null, this._ConnectionPool);
		}

		let tmpConnectionSettings = this._buildConnectionSettings();

		// Return CLOB columns (Text / JSON) as strings rather than Lob streams
		// so the Meadow marshaller can consume them directly.  Optionally do the
		// same for NUMBER to preserve precision on large Decimals.
		let tmpFetchAsString = [libOracleDB.CLOB];
		if (this.options.Oracle && this.options.Oracle.NumberAsString)
		{
			tmpFetchAsString.push(libOracleDB.NUMBER);
		}
		libOracleDB.fetchAsString = tmpFetchAsString;

		this.log.info(`Meadow-Connection-Oracle connecting to [${tmpConnectionSettings.connectString}] as ${tmpConnectionSettings.user} at a pool limit of ${tmpConnectionSettings.poolMax} (queueTimeout: ${(tmpConnectionSettings.queueTimeout / 1000).toFixed(0)}s)`);

		libRetry.runWithRetry(this.log, this._connectRetryOptions(),
			(fAttemptDone) =>
			{
				libOracleDB.createPool(tmpConnectionSettings)
					.then((pPool) => fAttemptDone(null, pPool))
					.catch((pError) => fAttemptDone(pError));
			},
			(pError, pPool) =>
			{
				if (pError)
				{
					this.log.error(`Meadow-Connection-Oracle final connection failure to [${tmpConnectionSettings.connectString}] as ${tmpConnectionSettings.user}: ${libRetry.extractErrorMessage(pError)}`);
					return tmpCallback(pError);
				}

				this.log.info(`Meadow-Connection-Oracle successfully connected to Oracle at [${tmpConnectionSettings.connectString}] as ${tmpConnectionSettings.user} at a pool limit of ${tmpConnectionSettings.poolMax}.`);
				this._ConnectionPool = pPool;
				this.connected = true;
				this._SchemaProvider.setConnectionPool(this._ConnectionPool);

				// Resolve any unset legacy flags from the detected server
				// version before handing the pool back to the caller, so the
				// first DDL/query already uses the right syntax.
				this._detectAndResolveLegacyFlags(() =>
				{
					return tmpCallback(null, this._ConnectionPool);
				});
			});
	}

	/**
	 * For any legacy flag the operator did NOT set explicitly, auto-detect the
	 * right value from the connected server version (oracledb exposes it as
	 * connection.oracleServerVersion).  Explicitly-configured flags are always
	 * honored; only `undefined` flags are filled in.  On detection failure the
	 * unset flags default to modern (12c+) behavior, which fits the vast
	 * majority of deployments.
	 *
	 * @param {Function} fCallback - () => ... (always invoked)
	 */
	_detectAndResolveLegacyFlags(fCallback)
	{
		let tmpSettings = this.options.Oracle || (this.options.Oracle = {});

		let tmpNeedPagination = (tmpSettings.LegacyPagination === undefined);
		let tmpNeedIdentity = (tmpSettings.LegacyIdentity === undefined);

		// Nothing to detect — both were set explicitly.
		if (!tmpNeedPagination && !tmpNeedIdentity)
		{
			this._applyLegacyToSchema();
			return fCallback();
		}

		this._ConnectionPool.getConnection()
			.then((pConnection) =>
			{
				let tmpVersion = pConnection.oracleServerVersion || 0;
				let tmpVersionString = pConnection.oracleServerVersionString || String(tmpVersion);
				return pConnection.close()
					.catch(() => {})
					.then(() =>
					{
						let tmpIsLegacy = (tmpVersion > 0 && tmpVersion < ORACLE_12_1_VERSION);
						if (tmpNeedPagination) { tmpSettings.LegacyPagination = tmpIsLegacy; }
						if (tmpNeedIdentity) { tmpSettings.LegacyIdentity = tmpIsLegacy; }
						this.log.info(`Meadow-Connection-Oracle detected server version ${tmpVersionString} — resolved unset legacy flags to LegacyPagination=${tmpSettings.LegacyPagination}, LegacyIdentity=${tmpSettings.LegacyIdentity}.`);
						this._applyLegacyToSchema();
						return fCallback();
					});
			})
			.catch((pError) =>
			{
				if (tmpNeedPagination) { tmpSettings.LegacyPagination = false; }
				if (tmpNeedIdentity) { tmpSettings.LegacyIdentity = false; }
				this.log.warn(`Meadow-Connection-Oracle could not detect server version (${libRetry.extractErrorMessage(pError)}); defaulting unset legacy flags to modern 12c+ behavior.`);
				this._applyLegacyToSchema();
				return fCallback();
			});
	}

	/**
	 * Push the resolved LegacyIdentity flag to the schema provider, which
	 * cached it at construction time (before the server version was known).
	 */
	_applyLegacyToSchema()
	{
		if (this._SchemaProvider && typeof (this._SchemaProvider.setLegacyIdentity) === 'function')
		{
			this._SchemaProvider.setLegacyIdentity(!!(this.options.Oracle && this.options.Oracle.LegacyIdentity));
		}
	}

	/**
	 * Destroy the current pool and create a fresh one.  Used by the retry
	 * helper when a failure mode (RequestTimeout, PoolDegraded) suggests the
	 * pooled connection is in a bad state.
	 *
	 * Idempotent and always resolves (even on error) so callers can proceed
	 * with the retry regardless.
	 *
	 * @param {Function} fCallback - (err) => ... (err is informational only)
	 */
	recyclePool(fCallback)
	{
		let tmpCallback = (typeof (fCallback) === 'function') ? fCallback : () => {};

		this.log.info(`Meadow-Connection-Oracle: recycling connection pool...`);

		let fCloseAndReconnect = () =>
		{
			this._ConnectionPool = false;
			this.connected = false;
			this._SchemaProvider.setConnectionPool(false);
			this.connectAsync((pConnectError) =>
			{
				if (pConnectError)
				{
					this.log.warn(`Meadow-Connection-Oracle: pool recycle reconnect failed — ${libRetry.extractErrorMessage(pConnectError)}`);
					return tmpCallback(pConnectError);
				}
				this.log.info(`Meadow-Connection-Oracle: pool recycle complete.`);
				return tmpCallback();
			});
		};

		if (this._ConnectionPool && typeof (this._ConnectionPool.close) === 'function')
		{
			let tmpCloseResult;
			try
			{
				// close(0) drops connections immediately without draining.
				tmpCloseResult = this._ConnectionPool.close(0);
			}
			catch (pCloseError)
			{
				this.log.warn(`Meadow-Connection-Oracle: pool.close() threw — ${pCloseError.message || pCloseError} — continuing with reconnect anyway`);
				return fCloseAndReconnect();
			}

			if (tmpCloseResult && typeof (tmpCloseResult.then) === 'function')
			{
				tmpCloseResult
					.then(() => fCloseAndReconnect())
					.catch((pCloseError) =>
					{
						this.log.warn(`Meadow-Connection-Oracle: pool.close() rejected — ${pCloseError.message || pCloseError} — continuing with reconnect anyway`);
						fCloseAndReconnect();
					});
				return;
			}
		}

		fCloseAndReconnect();
	}

	/**
	 * Acquire a pooled connection.  The Meadow Oracle provider uses this to run
	 * statements (oracledb has no separate PreparedStatement class — statements
	 * are prepared implicitly per execute() with pool statement caching).
	 *
	 * @param {Function} fCallback - callback(pError, pConnection)
	 */
	getConnection(fCallback)
	{
		if (!this.connected || !this._ConnectionPool)
		{
			return fCallback(new Error('The Meadow Oracle provider could not acquire a connection; disconnected or no valid connection pool.'));
		}
		this._ConnectionPool.getConnection()
			.then((pConnection) =>
			{
				let tmpCallTimeout = (this.options.Oracle && (this.options.Oracle.RequestTimeoutMs || this.options.Oracle.requestTimeoutMs)) || DEFAULT_REQUEST_TIMEOUT_MS;
				try
				{
					pConnection.callTimeout = tmpCallTimeout;
				}
				catch (pTimeoutError)
				{
					// Older drivers may not support callTimeout; ignore.
				}
				return fCallback(null, pConnection);
			})
			.catch((pError) => fCallback(pError));
	}

	get oracledb()
	{
		return libOracleDB;
	}

	get pool()
	{
		return this._ConnectionPool;
	}
}

module.exports = MeadowConnectionOracle;
