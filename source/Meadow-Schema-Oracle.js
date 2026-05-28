/**
* Meadow Oracle Schema Provider
*
* Handles table creation, dropping, and DDL generation for Oracle Database.
* Separated from the connection provider to allow independent extension for
* indexing, foreign keys, and other schema operations.
*
* Oracle DDL notes:
*   - Identifiers are emitted unquoted by default (Oracle folds them to
*     UPPERCASE).  Set options.Oracle.QuoteIdentifiers to wrap them in double
*     quotes and preserve case — the schema provider MUST agree with the
*     FoxHound Oracle dialect on this, or queries will fail to resolve.
*   - There is no `dbo` schema prefix; objects live in the connecting user's
*     own schema and introspection queries the USER_* data dictionary views.
*   - Oracle has no DROP TABLE IF EXISTS / CREATE INDEX IF NOT EXISTS, so we
*     use a PL/SQL block that swallows ORA-00942 for drops and a USER_INDEXES
*     existence check for indices.
*   - 12c+ AutoIdentity columns use a NUMBER IDENTITY column.  When
*     options.Oracle.LegacyIdentity is set (11g and earlier) a plain NUMBER
*     primary key is paired with a SEQUENCE and a BEFORE INSERT trigger so the
*     dialect's RETURNING clause works unchanged across versions.
*
* @author Steven Velozo <steven@velozo.com>
*/
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libRetry = require('./Meadow-Oracle-Retry.js');

// Default retry behavior for DDL operations.  CREATE TABLE / CREATE INDEX
// against a busy Oracle instance can hit library-cache or DDL locks held by
// unrelated sessions; retry with exponential backoff so a busy window doesn't
// kill a whole deploy.
const DEFAULT_DDL_MAX_ATTEMPTS   = 5;
const DEFAULT_DDL_INITIAL_DELAY  = 3000;
const DEFAULT_DDL_MAX_DELAY      = 30000;

class MeadowSchemaOracle extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'MeadowSchemaOracle';

		// Reference to the connection pool, set by the connection provider.
		this._ConnectionPool = false;

		// Back-reference to the MeadowConnectionOracle that owns this schema
		// provider.  Used to request a pool recycle when a DDL failure mode
		// suggests the pooled connection is in a bad state.
		this._ConnectionProvider = null;

		let tmpOracleSettings = (this.options && this.options.Oracle) || (this.fable && this.fable.settings && this.fable.settings.Oracle) || {};
		this._QuoteIdentifiers = !!tmpOracleSettings.QuoteIdentifiers;
		this._LegacyIdentity = !!tmpOracleSettings.LegacyIdentity;
	}

	/**
	 * Set the connection pool reference for executing DDL statements.
	 * @param {object} pConnectionPool - oracledb connection pool
	 * @returns {MeadowSchemaOracle} this (for chaining)
	 */
	setConnectionPool(pConnectionPool)
	{
		this._ConnectionPool = pConnectionPool;
		return this;
	}

	/**
	 * Set the back-reference to the connection provider.  The retry helper
	 * uses this to trigger pool recycling on pool-degraded errors.
	 *
	 * @param {object} pConnectionProvider - MeadowConnectionOracle instance
	 * @returns {MeadowSchemaOracle} this (for chaining)
	 */
	setConnectionProvider(pConnectionProvider)
	{
		this._ConnectionProvider = pConnectionProvider;
		return this;
	}

	/**
	 * Override the legacy-identity DDL mode.  The connection provider calls
	 * this after connecting, once the server version has been auto-detected,
	 * because this flag is cached at construction time (before connect).
	 *
	 * @param {boolean} pFlag
	 * @returns {MeadowSchemaOracle} this (for chaining)
	 */
	setLegacyIdentity(pFlag)
	{
		this._LegacyIdentity = !!pFlag;
		return this;
	}

	/**
	 * Quote an identifier per the configured mode.  Unquoted (default) lets
	 * Oracle fold to uppercase; quoted preserves the original case.
	 * @param {string} pName
	 * @returns {string}
	 */
	_quoteName(pName)
	{
		return this._QuoteIdentifiers ? '"' + pName + '"' : pName;
	}

	/**
	 * Build the retry options block used by DDL operations.  Honors
	 * per-provider overrides via options.Oracle.DDLRetryOptions.
	 *
	 * @param {string} pOperationName - name to use in log output
	 * @returns {Object}
	 */
	_ddlRetryOptions(pOperationName)
	{
		let tmpOracleSettings = this.options.Oracle || this.fable.settings.Oracle || {};
		let tmpRetry = tmpOracleSettings.DDLRetryOptions || {};

		let tmpOptions = (
			{
				OperationName: pOperationName,
				MaxAttempts: tmpRetry.MaxAttempts || DEFAULT_DDL_MAX_ATTEMPTS,
				InitialDelayMs: tmpRetry.InitialDelayMs || DEFAULT_DDL_INITIAL_DELAY,
				MaxDelayMs: tmpRetry.MaxDelayMs || DEFAULT_DDL_MAX_DELAY,
				BackoffFactor: tmpRetry.BackoffFactor || 2,
				SuccessModes: [libRetry.ERROR_MODES.AlreadyExists]
			});

		if (this._ConnectionProvider && typeof (this._ConnectionProvider.recyclePool) === 'function')
		{
			tmpOptions.OnRecyclePool = (fRecycleDone) =>
			{
				this._ConnectionProvider.recyclePool((pErr) =>
				{
					if (this._ConnectionProvider.pool)
					{
						this._ConnectionPool = this._ConnectionProvider.pool;
					}
					return fRecycleDone(pErr);
				});
			};
		}

		return tmpOptions;
	}

	/**
	 * Execute a single SQL/PL-SQL statement against the pool: acquire a
	 * connection, run it with autoCommit, and always release the connection.
	 * oracledb is lazily required so the DDL-string generators remain usable
	 * without the driver installed.
	 *
	 * @param {string} pSQL
	 * @param {Function} fCallback - callback(pError, pResult)
	 */
	_poolExecute(pSQL, fCallback)
	{
		if (!this._ConnectionPool)
		{
			return fCallback(new Error('Not connected to Oracle'));
		}

		const libOracleDB = require('oracledb');
		let tmpConnection = null;
		this._ConnectionPool.getConnection()
			.then((pConnection) =>
			{
				tmpConnection = pConnection;
				return tmpConnection.execute(pSQL, [], { autoCommit: true, outFormat: libOracleDB.OUT_FORMAT_OBJECT });
			})
			.then((pResult) =>
			{
				tmpConnection.close()
					.then(() => fCallback(null, pResult))
					.catch(() => fCallback(null, pResult));
			})
			.catch((pError) =>
			{
				if (tmpConnection)
				{
					tmpConnection.close()
						.then(() => fCallback(pError))
						.catch(() => fCallback(pError));
				}
				else
				{
					return fCallback(pError);
				}
			});
	}

	generateDropTableStatement(pTableName)
	{
		// Oracle has no DROP TABLE IF EXISTS — wrap in a PL/SQL block that
		// swallows ORA-00942 (table or view does not exist).
		let tmpDrop = `BEGIN\n`;
		tmpDrop += `    EXECUTE IMMEDIATE 'DROP TABLE ${this._quoteName(pTableName)} CASCADE CONSTRAINTS';\n`;
		tmpDrop += `EXCEPTION\n`;
		tmpDrop += `    WHEN OTHERS THEN\n`;
		tmpDrop += `        IF SQLCODE != -942 THEN RAISE; END IF;\n`;
		tmpDrop += `END;`;
		return tmpDrop;
	}

	/**
	 * Build the per-column DDL fragment for a Meadow column.
	 * @param {object} pColumn - Meadow column { Column, DataType, Size, StorageColumn }
	 * @returns {string|false} The column definition, or false to skip the column
	 */
	_columnDDL(pColumn)
	{
		switch (pColumn.DataType)
		{
			case 'ID':
				// 12c+ identity column, or a plain NUMBER PK paired with a
				// sequence + trigger when LegacyIdentity is enabled (11g).
				if (this._LegacyIdentity)
				{
					return `${this._quoteName(pColumn.Column)} NUMBER PRIMARY KEY`;
				}
				return `${this._quoteName(pColumn.Column)} NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`;
			case 'GUID':
				return `${this._quoteName(pColumn.Column)} VARCHAR2(${pColumn.Size || '255'}) DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL`;
			case 'ForeignKey':
				return `${this._quoteName(pColumn.Column)} NUMBER DEFAULT 0 NOT NULL`;
			case 'Numeric':
				return `${this._quoteName(pColumn.Column)} NUMBER DEFAULT 0 NOT NULL`;
			case 'Decimal':
				return `${this._quoteName(pColumn.Column)} NUMBER(${pColumn.Size})`;
			case 'String':
				// Oracle treats '' as NULL, so a NOT NULL String column with a
				// '' default would reject its own default.  Use a single-space
				// default and leave the column nullable.
				return `${this._quoteName(pColumn.Column)} VARCHAR2(${pColumn.Size}) DEFAULT ' '`;
			case 'Text':
				return `${this._quoteName(pColumn.Column)} CLOB`;
			case 'DateTime':
				return `${this._quoteName(pColumn.Column)} TIMESTAMP`;
			case 'Boolean':
				// Oracle (pre-23c) has no table BOOLEAN; NUMBER(1) 0/1 is the
				// convention (matches the dialect's literal 0/1 handling).
				return `${this._quoteName(pColumn.Column)} NUMBER(1) DEFAULT 0`;
			case 'JSON':
				// Stored as CLOB.  An "IS JSON" check constraint could be added
				// for 12c+-only deployments, but it is omitted here for 11g
				// compatibility (the dialect stringifies on write and the
				// provider parses on read regardless).
				return `${this._quoteName(pColumn.Column)} CLOB`;
			case 'JSONProxy':
				return `${this._quoteName(pColumn.StorageColumn)} CLOB`;
			default:
				return false;
		}
	}

	generateCreateTableStatement(pMeadowTableSchema)
	{
		this.log.info(`--> Building the table create string for ${pMeadowTableSchema && pMeadowTableSchema.TableName ? pMeadowTableSchema.TableName : '(unknown)'} ...`);

		let tmpCreateTableStatement = `CREATE TABLE ${this._quoteName(pMeadowTableSchema.TableName)}\n    (`;
		let tmpFirst = true;
		for (let j = 0; j < pMeadowTableSchema.Columns.length; j++)
		{
			let tmpColumnDDL = this._columnDDL(pMeadowTableSchema.Columns[j]);
			if (tmpColumnDDL === false)
			{
				continue;
			}
			if (!tmpFirst)
			{
				tmpCreateTableStatement += `,`;
			}
			tmpFirst = false;
			tmpCreateTableStatement += `\n        ${tmpColumnDDL}`;
		}
		tmpCreateTableStatement += `\n    )`;

		return tmpCreateTableStatement;
	}

	/**
	 * Find the AutoIdentity (ID) column on a Meadow table schema, if any.
	 * @param {object} pMeadowTableSchema
	 * @returns {string|false}
	 */
	_findIDColumn(pMeadowTableSchema)
	{
		for (let j = 0; j < pMeadowTableSchema.Columns.length; j++)
		{
			if (pMeadowTableSchema.Columns[j].DataType === 'ID')
			{
				return pMeadowTableSchema.Columns[j].Column;
			}
		}
		return false;
	}

	generateCreateSequenceStatement(pTableName)
	{
		return `CREATE SEQUENCE ${this._quoteName('SEQ_' + pTableName)} START WITH 1 INCREMENT BY 1 NOCACHE`;
	}

	generateCreateTriggerStatement(pTableName, pIDColumn)
	{
		let tmpTrigger = `CREATE OR REPLACE TRIGGER ${this._quoteName('TRG_' + pTableName)}\n`;
		tmpTrigger += `    BEFORE INSERT ON ${this._quoteName(pTableName)}\n`;
		tmpTrigger += `    FOR EACH ROW\n`;
		tmpTrigger += `    WHEN (NEW.${this._quoteName(pIDColumn)} IS NULL)\n`;
		tmpTrigger += `BEGIN\n`;
		tmpTrigger += `    SELECT ${this._quoteName('SEQ_' + pTableName)}.NEXTVAL INTO :NEW.${this._quoteName(pIDColumn)} FROM DUAL;\n`;
		tmpTrigger += `END;`;
		return tmpTrigger;
	}

	/**
	 * Build the ordered list of DDL statements needed to materialize a table.
	 * For the 12c+ identity path this is just the CREATE TABLE; for the legacy
	 * (11g) path it also includes a SEQUENCE and a BEFORE INSERT trigger.
	 *
	 * @param {object} pMeadowTableSchema
	 * @returns {Array<string>}
	 */
	generateCreateTableStatements(pMeadowTableSchema)
	{
		let tmpStatements = [this.generateCreateTableStatement(pMeadowTableSchema)];

		if (this._LegacyIdentity)
		{
			let tmpIDColumn = this._findIDColumn(pMeadowTableSchema);
			if (tmpIDColumn)
			{
				tmpStatements.push(this.generateCreateSequenceStatement(pMeadowTableSchema.TableName));
				tmpStatements.push(this.generateCreateTriggerStatement(pMeadowTableSchema.TableName, tmpIDColumn));
			}
		}

		return tmpStatements;
	}

	/**
	 * Run a list of DDL statements in order, swallowing ORA-00955 (object
	 * already exists) per statement so each is independently idempotent.
	 *
	 * @param {Array<string>} pStatements
	 * @param {number} pIndex
	 * @param {Function} fCallback - callback(pError)
	 */
	_executeStatementsSequentially(pStatements, pIndex, fCallback)
	{
		if (pIndex >= pStatements.length)
		{
			return fCallback(null);
		}
		this._poolExecute(pStatements[pIndex], (pError) =>
		{
			if (pError)
			{
				if (libRetry.getOracleErrorNumber(pError) === 955)
				{
					// Object already exists — benign on re-deploy.
					return this._executeStatementsSequentially(pStatements, pIndex + 1, fCallback);
				}
				return fCallback(pError);
			}
			return this._executeStatementsSequentially(pStatements, pIndex + 1, fCallback);
		});
	}

	createTables(pMeadowSchema, fCallback)
	{
		this.fable.Utility.eachLimit(pMeadowSchema.Tables, 1,
			(pTable, fCreateComplete) =>
			{
				return this.createTable(pTable, fCreateComplete);
			},
			(pCreateError) =>
			{
				if (pCreateError)
				{
					this.log.error(`Meadow-Oracle Error creating tables from Schema: ${pCreateError}`, pCreateError);
				}
				this.log.info('Done creating tables!');
				return fCallback(pCreateError);
			});
	}

	createTable(pMeadowTableSchema, fCallback)
	{
		let tmpTableName = (pMeadowTableSchema && pMeadowTableSchema.TableName) || '(unknown)';
		let tmpStatements = this.generateCreateTableStatements(pMeadowTableSchema);

		libRetry.runWithRetry(this.log,
			this._ddlRetryOptions(`Meadow-Oracle CREATE TABLE ${tmpTableName}`),
			(fAttemptDone) =>
			{
				this._executeStatementsSequentially(tmpStatements, 0,
					(pError) => fAttemptDone(pError));
			},
			(pError) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				this.log.info(`Meadow-Oracle CREATE TABLE ${tmpTableName} success`);
				return fCallback();
			});
	}

	// ========================================================================
	// Index Generation
	// ========================================================================

	/**
	 * Derive index definitions from a Meadow table schema.
	 *
	 * Automatically generates indices for:
	 *   - GUID columns       -> unique index  AK_M_{Column}
	 *   - ForeignKey columns -> regular index IX_M_{Column}
	 *
	 * Column-level Indexed property:
	 *   - Indexed: true     -> regular index IX_M_T_{Table}_C_{Column}
	 *   - Indexed: 'unique' -> unique index  AK_M_T_{Table}_C_{Column}
	 *   - IndexName overrides the auto-generated name (for round-trip fidelity)
	 *
	 * Also includes any explicit entries from pMeadowTableSchema.Indices[].
	 *
	 * @param {object} pMeadowTableSchema - Meadow table schema object
	 * @returns {Array} Array of index definition objects
	 */
	getIndexDefinitionsFromSchema(pMeadowTableSchema)
	{
		let tmpIndices = [];
		let tmpTableName = pMeadowTableSchema.TableName;

		for (let j = 0; j < pMeadowTableSchema.Columns.length; j++)
		{
			let tmpColumn = pMeadowTableSchema.Columns[j];

			switch (tmpColumn.DataType)
			{
				case 'GUID':
					tmpIndices.push(
						{
							Name: `AK_M_${tmpColumn.Column}`,
							TableName: tmpTableName,
							Columns: [tmpColumn.Column],
							Unique: true,
							Strategy: ''
						});
					break;
				case 'ForeignKey':
					tmpIndices.push(
						{
							Name: `IX_M_${tmpColumn.Column}`,
							TableName: tmpTableName,
							Columns: [tmpColumn.Column],
							Unique: false,
							Strategy: ''
						});
					break;
				default:
					if (tmpColumn.Indexed)
					{
						let tmpIsUnique = (tmpColumn.Indexed === 'unique');
						let tmpPrefix = tmpIsUnique ? 'AK_M_T' : 'IX_M_T';
						let tmpAutoName = `${tmpPrefix}_${tmpTableName}_C_${tmpColumn.Column}`;
						tmpIndices.push(
							{
								Name: tmpColumn.IndexName || tmpAutoName,
								TableName: tmpTableName,
								Columns: [tmpColumn.Column],
								Unique: tmpIsUnique,
								Strategy: ''
							});
					}
					break;
			}
		}

		if (Array.isArray(pMeadowTableSchema.Indices))
		{
			for (let k = 0; k < pMeadowTableSchema.Indices.length; k++)
			{
				let tmpExplicitIndex = pMeadowTableSchema.Indices[k];
				tmpIndices.push(
					{
						Name: tmpExplicitIndex.Name || `IX_${tmpTableName}_${k}`,
						TableName: tmpTableName,
						Columns: Array.isArray(tmpExplicitIndex.Columns) ? tmpExplicitIndex.Columns : [tmpExplicitIndex.Columns],
						Unique: tmpExplicitIndex.Unique || false,
						Strategy: tmpExplicitIndex.Strategy || ''
					});
			}
		}

		return tmpIndices;
	}

	/**
	 * Build the column list for an index, quoted per mode and comma-separated.
	 * @param {Array} pColumns - Array of column name strings
	 * @returns {string}
	 */
	_buildColumnList(pColumns)
	{
		return pColumns.map((pCol) => { return this._quoteName(pCol); }).join(', ');
	}

	/**
	 * Generate an array of individual CREATE INDEX SQL statements for a table.
	 *
	 * Each entry is an object with:
	 *   { Name, Statement, CheckStatement }
	 *
	 * - Statement: the raw CREATE [UNIQUE] INDEX ... SQL (no terminator)
	 * - CheckStatement: a SELECT against USER_INDEXES that returns the count
	 *   of matching indices (0 = does not exist)
	 *
	 * @param {object} pMeadowTableSchema - Meadow table schema object
	 * @returns {Array} Array of { Name, Statement, CheckStatement } objects
	 */
	generateCreateIndexStatements(pMeadowTableSchema)
	{
		let tmpIndices = this.getIndexDefinitionsFromSchema(pMeadowTableSchema);
		let tmpStatements = [];

		for (let i = 0; i < tmpIndices.length; i++)
		{
			let tmpIndex = tmpIndices[i];
			let tmpColumnList = this._buildColumnList(tmpIndex.Columns);
			let tmpCreateKeyword = tmpIndex.Unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
			// Oracle data-dictionary names are stored uppercase when unquoted;
			// compare case-insensitively against the convention name.
			let tmpDictName = this._QuoteIdentifiers ? tmpIndex.Name : tmpIndex.Name.toUpperCase();
			let tmpDictTable = this._QuoteIdentifiers ? tmpIndex.TableName : tmpIndex.TableName.toUpperCase();

			tmpStatements.push(
				{
					Name: tmpIndex.Name,
					Statement: `${tmpCreateKeyword} ${this._quoteName(tmpIndex.Name)} ON ${this._quoteName(tmpIndex.TableName)} (${tmpColumnList})`,
					CheckStatement: `SELECT COUNT(*) AS INDEXEXISTS FROM USER_INDEXES WHERE INDEX_NAME = '${tmpDictName}' AND TABLE_NAME = '${tmpDictTable}'`
				});
		}

		return tmpStatements;
	}

	/**
	 * Programmatically create a single index on the database.
	 *
	 * Checks USER_INDEXES first; only runs CREATE INDEX if the index does not
	 * yet exist.
	 *
	 * @param {object} pIndexStatement - Object from generateCreateIndexStatements()
	 * @param {Function} fCallback - callback(pError)
	 */
	createIndex(pIndexStatement, fCallback)
	{
		if (!this._ConnectionPool)
		{
			this.log.error(`Meadow-Oracle CREATE INDEX ${pIndexStatement.Name} failed: not connected.`);
			return fCallback(new Error('Not connected to Oracle'));
		}

		libRetry.runWithRetry(this.log,
			this._ddlRetryOptions(`Meadow-Oracle CREATE INDEX ${pIndexStatement.Name}`),
			(fAttemptDone) =>
			{
				this._poolExecute(pIndexStatement.CheckStatement, (pCheckError, pCheckResult) =>
				{
					if (pCheckError)
					{
						return fAttemptDone(pCheckError);
					}
					let tmpExists = pCheckResult && pCheckResult.rows && pCheckResult.rows[0] && pCheckResult.rows[0].INDEXEXISTS > 0;
					if (tmpExists)
					{
						return fAttemptDone(null, { AlreadyExisted: true });
					}
					this._poolExecute(pIndexStatement.Statement, (pCreateError) =>
					{
						if (pCreateError)
						{
							return fAttemptDone(pCreateError);
						}
						return fAttemptDone(null, { AlreadyExisted: false });
					});
				});
			},
			(pError, pResult) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pResult && pResult.AlreadyExisted)
				{
					this.log.info(`Meadow-Oracle INDEX ${pIndexStatement.Name} already exists, skipping.`);
				}
				else
				{
					this.log.info(`Meadow-Oracle CREATE INDEX ${pIndexStatement.Name} executed successfully.`);
				}
				return fCallback();
			});
	}

	/**
	 * Programmatically create all indices for a single table.
	 *
	 * @param {object} pMeadowTableSchema - Meadow table schema object
	 * @param {Function} fCallback - callback(pError)
	 */
	createIndices(pMeadowTableSchema, fCallback)
	{
		let tmpStatements = this.generateCreateIndexStatements(pMeadowTableSchema);

		if (tmpStatements.length === 0)
		{
			this.log.info(`No indices to create for ${pMeadowTableSchema.TableName}.`);
			return fCallback();
		}

		this.fable.Utility.eachLimit(tmpStatements, 1,
			(pStatement, fCreateComplete) =>
			{
				return this.createIndex(pStatement, fCreateComplete);
			},
			(pCreateError) =>
			{
				if (pCreateError)
				{
					this.log.error(`Meadow-Oracle Error creating indices for ${pMeadowTableSchema.TableName}: ${pCreateError}`, pCreateError);
				}
				else
				{
					this.log.info(`Done creating indices for ${pMeadowTableSchema.TableName}!`);
				}
				return fCallback(pCreateError);
			});
	}

	/**
	 * Programmatically create all indices for all tables in a schema.
	 *
	 * @param {object} pMeadowSchema - Meadow schema object with Tables array
	 * @param {Function} fCallback - callback(pError)
	 */
	createAllIndices(pMeadowSchema, fCallback)
	{
		this.fable.Utility.eachLimit(pMeadowSchema.Tables, 1,
			(pTable, fCreateComplete) =>
			{
				return this.createIndices(pTable, fCreateComplete);
			},
			(pCreateError) =>
			{
				if (pCreateError)
				{
					this.log.error(`Meadow-Oracle Error creating indices from schema: ${pCreateError}`, pCreateError);
				}
				this.log.info('Done creating all indices!');
				return fCallback(pCreateError);
			});
	}

	// ========================================================================
	// Database Introspection (against the USER_* data dictionary views)
	// ========================================================================

	/**
	 * List all tables in the connecting user's schema.
	 *
	 * @param {Function} fCallback - callback(pError, pTableNames)
	 */
	listTables(fCallback)
	{
		this._poolExecute('SELECT TABLE_NAME FROM USER_TABLES ORDER BY TABLE_NAME', (pError, pResult) =>
		{
			if (pError)
			{
				this.log.error('Meadow-Oracle listTables failed!', pError);
				return fCallback(pError);
			}
			let tmpNames = pResult.rows.map((pRow) => { return pRow.TABLE_NAME; });
			return fCallback(null, tmpNames);
		});
	}

	/**
	 * Map an Oracle native type to a Meadow DataType.
	 *
	 * @param {object} pColumnInfo - USER_TAB_COLUMNS row
	 * @param {boolean} pIsIdentity - whether the column is an IDENTITY column
	 * @param {Set} pForeignKeyColumns - Set of column names with FK constraints
	 * @returns {object} { DataType, Size }
	 */
	_mapOracleTypeToMeadow(pColumnInfo, pIsIdentity, pForeignKeyColumns)
	{
		let tmpName = pColumnInfo.COLUMN_NAME;
		let tmpType = (pColumnInfo.DATA_TYPE || '').toUpperCase().trim();

		// Priority 1: IDENTITY column → ID
		if (pIsIdentity)
		{
			return { DataType: 'ID', Size: '' };
		}

		// Priority 2: Has FK constraint → ForeignKey
		if (pForeignKeyColumns && pForeignKeyColumns.has(tmpName))
		{
			return { DataType: 'ForeignKey', Size: '' };
		}

		// Priority 3: Native type mapping
		if (tmpType === 'NUMBER')
		{
			if (pColumnInfo.DATA_SCALE && pColumnInfo.DATA_SCALE > 0)
			{
				let tmpSize = String(pColumnInfo.DATA_PRECISION || 38) + ',' + String(pColumnInfo.DATA_SCALE);
				return { DataType: 'Decimal', Size: tmpSize };
			}
			// NUMBER(1) used for booleans by convention; use a name heuristic.
			if (pColumnInfo.DATA_PRECISION === 1)
			{
				let tmpLowerName = tmpName.toLowerCase();
				if (tmpLowerName.indexOf('is') === 0 || tmpLowerName.indexOf('has') === 0 ||
					tmpLowerName === 'deleted' || tmpLowerName === 'active' || tmpLowerName === 'enabled')
				{
					return { DataType: 'Boolean', Size: '' };
				}
			}
			return { DataType: 'Numeric', Size: '' };
		}

		if (tmpType === 'FLOAT' || tmpType === 'BINARY_FLOAT' || tmpType === 'BINARY_DOUBLE')
		{
			return { DataType: 'Decimal', Size: '' };
		}

		if (tmpType.indexOf('TIMESTAMP') === 0 || tmpType === 'DATE')
		{
			return { DataType: 'DateTime', Size: '' };
		}

		if (tmpType === 'CLOB' || tmpType === 'NCLOB' || tmpType === 'LONG')
		{
			return { DataType: 'Text', Size: '' };
		}

		if (tmpType === 'VARCHAR2' || tmpType === 'NVARCHAR2' || tmpType === 'CHAR' || tmpType === 'NCHAR')
		{
			let tmpSize = pColumnInfo.CHAR_LENGTH ? String(pColumnInfo.CHAR_LENGTH) : (pColumnInfo.DATA_LENGTH ? String(pColumnInfo.DATA_LENGTH) : '');
			return { DataType: 'String', Size: tmpSize };
		}

		// Default fallback
		return { DataType: 'Text', Size: '' };
	}

	/**
	 * Get column definitions for a single table.
	 *
	 * @param {string} pTableName - Name of the table (data-dictionary case)
	 * @param {Function} fCallback - callback(pError, pColumns)
	 */
	introspectTableColumns(pTableName, fCallback)
	{
		let tmpDictTable = this._QuoteIdentifiers ? pTableName : pTableName.toUpperCase();
		let tmpColumnQuery = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE, DATA_DEFAULT FROM USER_TAB_COLUMNS WHERE TABLE_NAME = '${tmpDictTable}' ORDER BY COLUMN_ID`;
		let tmpIdentityQuery = `SELECT COLUMN_NAME FROM USER_TAB_IDENTITY_COLS WHERE TABLE_NAME = '${tmpDictTable}'`;
		let tmpFKQuery = `SELECT cc.COLUMN_NAME FROM USER_CONSTRAINTS c JOIN USER_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE c.CONSTRAINT_TYPE = 'R' AND c.TABLE_NAME = '${tmpDictTable}'`;

		this._poolExecute(tmpColumnQuery, (pColumnError, pColumnResult) =>
		{
			if (pColumnError)
			{
				this.log.error(`Meadow-Oracle introspectTableColumns for ${pTableName} failed!`, pColumnError);
				return fCallback(pColumnError);
			}
			this._poolExecute(tmpIdentityQuery, (pIdentityError, pIdentityResult) =>
			{
				if (pIdentityError)
				{
					return fCallback(pIdentityError);
				}
				this._poolExecute(tmpFKQuery, (pFKError, pFKResult) =>
				{
					if (pFKError)
					{
						return fCallback(pFKError);
					}
					let tmpIdentitySet = new Set(pIdentityResult.rows.map((pRow) => { return pRow.COLUMN_NAME; }));
					let tmpFKColumnSet = new Set(pFKResult.rows.map((pRow) => { return pRow.COLUMN_NAME; }));

					let tmpResult = [];
					for (let i = 0; i < pColumnResult.rows.length; i++)
					{
						let tmpCol = pColumnResult.rows[i];
						let tmpTypeInfo = this._mapOracleTypeToMeadow(tmpCol, tmpIdentitySet.has(tmpCol.COLUMN_NAME), tmpFKColumnSet);

						let tmpColumnDef = {
							Column: tmpCol.COLUMN_NAME,
							DataType: tmpTypeInfo.DataType
						};
						if (tmpTypeInfo.Size)
						{
							tmpColumnDef.Size = tmpTypeInfo.Size;
						}
						tmpResult.push(tmpColumnDef);
					}
					return fCallback(null, tmpResult);
				});
			});
		});
	}

	/**
	 * Get foreign key relationships for a single table.
	 *
	 * @param {string} pTableName - Name of the table
	 * @param {Function} fCallback - callback(pError, pForeignKeys)
	 */
	introspectTableForeignKeys(pTableName, fCallback)
	{
		let tmpDictTable = this._QuoteIdentifiers ? pTableName : pTableName.toUpperCase();
		let tmpQuery = `SELECT cc.COLUMN_NAME AS COLUMNNAME, rc.TABLE_NAME AS REFERENCEDTABLE, rcc.COLUMN_NAME AS REFERENCEDCOLUMN FROM USER_CONSTRAINTS c JOIN USER_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME JOIN USER_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME JOIN USER_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND cc.POSITION = rcc.POSITION WHERE c.CONSTRAINT_TYPE = 'R' AND c.TABLE_NAME = '${tmpDictTable}'`;

		this._poolExecute(tmpQuery, (pError, pResult) =>
		{
			if (pError)
			{
				this.log.error(`Meadow-Oracle introspectTableForeignKeys for ${pTableName} failed!`, pError);
				return fCallback(pError);
			}
			let tmpResult = [];
			for (let i = 0; i < pResult.rows.length; i++)
			{
				let tmpRow = pResult.rows[i];
				tmpResult.push(
					{
						Column: tmpRow.COLUMNNAME,
						ReferencedTable: tmpRow.REFERENCEDTABLE,
						ReferencedColumn: tmpRow.REFERENCEDCOLUMN
					});
			}
			return fCallback(null, tmpResult);
		});
	}

	/**
	 * Get raw index definitions for a single table (excluding the ones backing
	 * primary key / unique constraints, which Meadow derives from the columns).
	 *
	 * @param {string} pTableName - Name of the table
	 * @param {Function} fCallback - callback(pError, pIndices)
	 */
	introspectTableIndices(pTableName, fCallback)
	{
		let tmpDictTable = this._QuoteIdentifiers ? pTableName : pTableName.toUpperCase();
		let tmpQuery = `SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME, ic.COLUMN_POSITION FROM USER_INDEXES i JOIN USER_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME WHERE i.TABLE_NAME = '${tmpDictTable}' AND NOT EXISTS (SELECT 1 FROM USER_CONSTRAINTS c WHERE c.INDEX_NAME = i.INDEX_NAME AND c.CONSTRAINT_TYPE IN ('P','U')) ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`;

		this._poolExecute(tmpQuery, (pError, pResult) =>
		{
			if (pError)
			{
				this.log.error(`Meadow-Oracle introspectTableIndices for ${pTableName} failed!`, pError);
				return fCallback(pError);
			}
			let tmpIndexMap = {};
			for (let i = 0; i < pResult.rows.length; i++)
			{
				let tmpRow = pResult.rows[i];
				if (!tmpIndexMap[tmpRow.INDEX_NAME])
				{
					tmpIndexMap[tmpRow.INDEX_NAME] = {
						Name: tmpRow.INDEX_NAME,
						Columns: [],
						Unique: (tmpRow.UNIQUENESS === 'UNIQUE')
					};
				}
				tmpIndexMap[tmpRow.INDEX_NAME].Columns.push(tmpRow.COLUMN_NAME);
			}
			return fCallback(null, Object.values(tmpIndexMap));
		});
	}

	/**
	 * Generate a complete DDL-level schema for a single table.
	 *
	 * @param {string} pTableName - Name of the table
	 * @param {Function} fCallback - callback(pError, pTableSchema)
	 */
	introspectTableSchema(pTableName, fCallback)
	{
		this.introspectTableColumns(pTableName, (pColumnError, pColumns) =>
		{
			if (pColumnError)
			{
				return fCallback(pColumnError);
			}
			this.introspectTableForeignKeys(pTableName, (pFKError, pForeignKeys) =>
			{
				if (pFKError)
				{
					return fCallback(pFKError);
				}
				let tmpSchema = {
					TableName: pTableName,
					Columns: pColumns
				};
				if (pForeignKeys.length > 0)
				{
					tmpSchema.ForeignKeys = pForeignKeys;
				}
				return fCallback(null, tmpSchema);
			});
		});
	}

	/**
	 * Generate DDL schemas for ALL tables in the user's schema.
	 *
	 * @param {Function} fCallback - callback(pError, { Tables: [...] })
	 */
	introspectDatabaseSchema(fCallback)
	{
		this.listTables((pError, pTableNames) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpTables = [];
			this.fable.Utility.eachLimit(pTableNames, 1,
				(pTableName, fEachComplete) =>
				{
					this.introspectTableSchema(pTableName, (pSchemaError, pSchema) =>
					{
						if (pSchemaError)
						{
							return fEachComplete(pSchemaError);
						}
						tmpTables.push(pSchema);
						return fEachComplete();
					});
				},
				(pEachError) =>
				{
					if (pEachError)
					{
						this.log.error('Meadow-Oracle introspectDatabaseSchema failed!', pEachError);
						return fCallback(pEachError);
					}
					return fCallback(null, { Tables: tmpTables });
				});
		});
	}
}

module.exports = MeadowSchemaOracle;
