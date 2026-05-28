/**
* Live end-to-end tests for the Meadow Oracle connector.
*
* These require a running Oracle instance (see start-oracle.sh / docker-compose
* — gvenzl/oracle-xe on port 21521).  They drive the LOCAL connection +
* schema providers and the LOCAL FoxHound Oracle dialect against the real
* database, proving: connect, identity/RETURNING, both pagination modes,
* soft-delete, and the unquoted-uppercase round-trip behavior.
*
* If Oracle is unreachable (or the oracledb driver is not installed) every
* test self-skips, so this file is safe to include in a no-DB run.
*
* @license MIT
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libFable = require('fable');
const libFoxHound = require('../../foxhound/source/FoxHound.js');

// The connection provider requires oracledb; tolerate its absence so a no-DB
// run can still load (and skip) this file.
let libMeadowConnectionOracle = null;
try
{
	libMeadowConnectionOracle = require('../source/Meadow-Connection-Oracle.js');
}
catch (pRequireError)
{
	libMeadowConnectionOracle = null;
}

const _ConnectionConfig =
{
	Oracle:
	{
		server: '127.0.0.1',
		port: 21521,
		user: 'bookstore',
		password: 'Retold1234567890!',
		connectionType: 'ServiceName',
		serviceName: 'FREEPDB1',
		ConnectionPoolLimit: 5,
		// Keep retries short so a missing DB fails fast into a skip.
		ConnectRetryOptions: { MaxAttempts: 1 },
		ConnectionTimeoutMs: 8000
	}
};

// DDL-shape schema (DataType) for table creation.
const _TableSchema =
{
	TableName: 'FableTest',
	Columns:
	[
		{ Column: 'IDFableTest', DataType: 'ID' },
		{ Column: 'Title',       DataType: 'String', Size: '256' },
		{ Column: 'IDAuthor',    DataType: 'ForeignKey' },
		{ Column: 'Deleted',     DataType: 'Boolean' }
	]
};

// FoxHound-shape schema (Type) for query generation.
const _QuerySchema =
[
	{ Column: 'IDFableTest', Type: 'AutoIdentity' },
	{ Column: 'Title',       Type: 'String' },
	{ Column: 'IDAuthor',    Type: 'Numeric' },
	{ Column: 'Deleted',     Type: 'Deleted' }
];

suite('Meadow-Connection-Oracle (live)', function ()
{
	this.timeout(60000);

	let _Fable = null;
	let _Connection = null;
	let _Skip = false;

	// Build a FoxHound query bound to the Oracle dialect + query schema.
	function newQuery()
	{
		let tmpQuery = libFoxHound.new(_Fable).setDialect('Oracle').setScope('FableTest');
		tmpQuery.query.schema = _QuerySchema;
		return tmpQuery;
	}

	// Execute a FoxHound-built query, mirroring the Meadow Oracle provider's
	// bind handling (CLOB typing + optional RETURNING out-bind).
	function execQuery(pQuery, pIncludeReturning, fCallback)
	{
		let tmpOracleDB = _Connection.oracledb;
		let tmpBinds = {};
		let tmpParameters = pQuery.query.parameters || {};
		let tmpParameterTypes = pQuery.query.parameterTypes || {};
		for (let tmpName in tmpParameters)
		{
			if (tmpParameterTypes[tmpName] === 'CLOB')
			{
				tmpBinds[tmpName] = { val: tmpParameters[tmpName], type: tmpOracleDB.CLOB };
			}
			else
			{
				tmpBinds[tmpName] = tmpParameters[tmpName];
			}
		}
		if (pIncludeReturning)
		{
			tmpBinds.RETURNING_ID = { dir: tmpOracleDB.BIND_OUT, type: tmpOracleDB.NUMBER };
		}
		_Connection.getConnection((pConnError, pConnection) =>
		{
			if (pConnError) { return fCallback(pConnError); }
			pConnection.execute(pQuery.query.body, tmpBinds, { autoCommit: true, outFormat: tmpOracleDB.OUT_FORMAT_OBJECT })
				.then((pResult) => { pConnection.close().then(() => fCallback(null, pResult)).catch(() => fCallback(null, pResult)); })
				.catch((pError) => { pConnection.close().then(() => fCallback(pError)).catch(() => fCallback(pError)); });
		});
	}

	function insertRow(pTitle, pIDAuthor, fCallback)
	{
		let tmpQuery = newQuery().addRecord({ IDFableTest: null, Title: pTitle, IDAuthor: pIDAuthor, Deleted: 0 });
		tmpQuery.buildCreateQuery();
		execQuery(tmpQuery, true, fCallback);
	}

	suiteSetup(function (fDone)
	{
		if (!libMeadowConnectionOracle)
		{
			_Skip = true;
			return fDone();
		}
		_Fable = new libFable({ Product: 'MeadowOracleLiveTests', Oracle: _ConnectionConfig.Oracle });
		_Fable.serviceManager.addServiceType('MeadowConnectionOracle', libMeadowConnectionOracle);
		_Connection = _Fable.serviceManager.instantiateServiceProvider('MeadowConnectionOracle');

		_Connection.connectAsync((pError) =>
		{
			if (pError)
			{
				// No reachable Oracle — skip the whole suite.
				_Skip = true;
				return fDone();
			}
			// Drop (idempotent) then create the test table.
			let tmpDrop = _Connection.generateDropTableStatement('FableTest');
			_Connection.getConnection((pConnError, pConnection) =>
			{
				if (pConnError) { _Skip = true; return fDone(); }
				pConnection.execute(tmpDrop, [], { autoCommit: true })
					.then(() => pConnection.close())
					.catch(() => pConnection.close())
					.then(() =>
					{
						_Connection.createTable(_TableSchema, (pCreateError) =>
						{
							if (pCreateError) { return fDone(pCreateError); }
							return fDone();
						});
					});
			});
		});
	});

	suiteTeardown(function (fDone)
	{
		if (_Skip || !_Connection || !_Connection.connected) { return fDone(); }
		// Best-effort cleanup of the pool.
		try
		{
			_Connection.pool.close(0).then(() => fDone()).catch(() => fDone());
		}
		catch (pError)
		{
			return fDone();
		}
	});

	test('connects and answers SELECT 1 FROM DUAL', function (fDone)
	{
		if (_Skip) { this.skip(); return; }
		_Connection.getConnection((pConnError, pConnection) =>
		{
			if (pConnError) { return fDone(pConnError); }
			pConnection.execute('SELECT 1 AS ONE FROM DUAL', [], { outFormat: _Connection.oracledb.OUT_FORMAT_OBJECT })
				.then((pResult) =>
				{
					pConnection.close();
					try
					{
						Expect(pResult.rows[0].ONE).to.equal(1);
						fDone();
					}
					catch (e) { fDone(e); }
				})
				.catch((pError) => { pConnection.close(); fDone(pError); });
		});
	});

	test('auto-detects the server version and resolves unset legacy flags to modern (12c+)', function ()
	{
		if (_Skip) { this.skip(); return; }
		// Config sets neither flag, so connectAsync should have detected the
		// (23ai) server version and resolved both to modern behavior.
		Expect(_Connection.options.Oracle.LegacyPagination).to.equal(false);
		Expect(_Connection.options.Oracle.LegacyIdentity).to.equal(false);
	});

	test('INSERT returns the generated identity via RETURNING INTO', function (fDone)
	{
		if (_Skip) { this.skip(); return; }
		insertRow('First Title', 100, (pError, pResult) =>
		{
			if (pError) { return fDone(pError); }
			try
			{
				let tmpID = pResult.outBinds.RETURNING_ID[0];
				Expect(tmpID).to.be.a('number');
				Expect(tmpID).to.be.greaterThan(0);
				fDone();
			}
			catch (e) { fDone(e); }
		});
	});

	test('READ returns the row (data-dictionary UPPERCASE keys in unquoted mode)', function (fDone)
	{
		if (_Skip) { this.skip(); return; }
		let tmpQuery = newQuery().setDataElements(['Title', 'IDAuthor']).addFilter('IDAuthor', 100);
		tmpQuery.buildReadQuery();
		execQuery(tmpQuery, false, (pError, pResult) =>
		{
			if (pError) { return fDone(pError); }
			try
			{
				Expect(pResult.rows.length).to.be.greaterThan(0);
				// Unquoted identifiers fold to UPPERCASE — the Meadow provider's
				// marshaller is what remaps these back to PascalCase.
				Expect(pResult.rows[0]).to.have.property('TITLE');
				Expect(pResult.rows[0].TITLE).to.equal('First Title');
				fDone();
			}
			catch (e) { fDone(e); }
		});
	});

	test('OFFSET/FETCH and legacy ROWNUM pagination return the same window', function (fDone)
	{
		if (_Skip) { this.skip(); return; }
		// Seed enough rows to paginate (author 200).
		let tmpToInsert = 25;
		let tmpInserted = 0;
		let fInsertNext = () =>
		{
			if (tmpInserted >= tmpToInsert)
			{
				return runPagination();
			}
			tmpInserted++;
			insertRow('Row ' + tmpInserted, 200, (pError) =>
			{
				if (pError) { return fDone(pError); }
				fInsertNext();
			});
		};

		let fReadWindow = (pLegacy, fCallback) =>
		{
			let tmpQuery = newQuery()
				.setDataElements(['IDFableTest', 'Title'])
				.addFilter('IDAuthor', 200)
				.addSort('IDFableTest')
				.setCap(10)
				.setBegin(5);
			if (pLegacy) { tmpQuery.parameters.legacyPagination = true; }
			tmpQuery.buildReadQuery();
			execQuery(tmpQuery, false, fCallback);
		};

		let runPagination = () =>
		{
			fReadWindow(false, (pModernError, pModern) =>
			{
				if (pModernError) { return fDone(pModernError); }
				fReadWindow(true, (pLegacyError, pLegacy) =>
				{
					if (pLegacyError) { return fDone(pLegacyError); }
					try
					{
						Expect(pModern.rows.length).to.equal(10);
						Expect(pLegacy.rows.length).to.equal(10);
						let tmpModernIDs = pModern.rows.map((pRow) => pRow.IDFABLETEST);
						let tmpLegacyIDs = pLegacy.rows.map((pRow) => pRow.IDFABLETEST);
						Expect(tmpLegacyIDs).to.deep.equal(tmpModernIDs);
						fDone();
					}
					catch (e) { fDone(e); }
				});
			});
		};

		fInsertNext();
	});

	test('soft-delete sets Deleted=1 and hides the row from default reads', function (fDone)
	{
		if (_Skip) { this.skip(); return; }
		// Insert a dedicated row (author 300), then soft-delete it.
		insertRow('To Delete', 300, (pInsertError, pInsertResult) =>
		{
			if (pInsertError) { return fDone(pInsertError); }
			let tmpID = pInsertResult.outBinds.RETURNING_ID[0];

			let tmpDeleteQuery = newQuery().addFilter('IDFableTest', tmpID).setIDUser(1);
			tmpDeleteQuery.buildDeleteQuery();
			execQuery(tmpDeleteQuery, false, (pDeleteError) =>
			{
				if (pDeleteError) { return fDone(pDeleteError); }
				// Default read should exclude the soft-deleted row.
				let tmpReadQuery = newQuery().addFilter('IDFableTest', tmpID);
				tmpReadQuery.buildReadQuery();
				execQuery(tmpReadQuery, false, (pReadError, pReadResult) =>
				{
					if (pReadError) { return fDone(pReadError); }
					try
					{
						Expect(pReadResult.rows.length).to.equal(0);
						fDone();
					}
					catch (e) { fDone(e); }
				});
			});
		});
	});
});
