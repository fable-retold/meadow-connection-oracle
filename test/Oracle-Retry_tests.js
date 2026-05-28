/**
 * Unit tests for the Meadow-Oracle-Retry helper (classifyError + runWithRetry).
 *
 * These are pure-JS tests — no real Oracle connection needed.  The goal is to
 * lock in the behavior of the error classifier and the retry loop so
 * regressions don't silently degrade production observability.
 *
 * @license MIT
 */

'use strict';

const Chai = require('chai');
const Expect = Chai.expect;

const libRetry = require('../source/Meadow-Oracle-Retry.js');

// A fake logger that captures every call so we can assert on log output.
function makeTestLogger()
{
	let tmpRecords = [];
	let tmpLog = (pLevel) => (pMsg) => tmpRecords.push({ level: pLevel, message: String(pMsg) });
	return {
		info: tmpLog('info'),
		warn: tmpLog('warn'),
		error: tmpLog('error'),
		records: tmpRecords
	};
}

// Helpers that synthesize the shapes real oracledb errors take.
function oraError(pNumber, pMessage)
{
	let e = new Error(pMessage || ('ORA-' + String(pNumber).padStart(5, '0') + ': synthetic error'));
	e.errorNum = pNumber;
	return e;
}
function socketError(pCode)
{
	let e = new Error(`Network failure (${pCode})`);
	e.code = pCode;
	return e;
}
function timeoutError()
{
	return oraError(1013, 'ORA-01013: user requested cancel of current operation');
}
function alreadyExistsError()
{
	return oraError(955, 'ORA-00955: name is already used by an existing object');
}
function serverError(pNumber, pMessage)
{
	return oraError(pNumber, pMessage);
}

suite('Meadow-Oracle-Retry',
	() =>
	{
		suite('classifyError',
			() =>
			{
				test('classifies ORA-number network errors as NetworkError (retryable, recycle)',
					() =>
					{
						let tmpNumbers = [3113, 3114, 3135, 12537, 12541, 12545, 12170];
						for (let i = 0; i < tmpNumbers.length; i++)
						{
							let result = libRetry.classifyError(oraError(tmpNumbers[i]), 123);
							Expect(result.mode).to.equal(libRetry.ERROR_MODES.NetworkError);
							Expect(result.isRetryable).to.equal(true);
							Expect(result.recommendPoolRecycle).to.equal(true);
							Expect(result.description).to.include('ORA-' + String(tmpNumbers[i]).padStart(5, '0'));
						}
					});

				test('classifies socket-level codes as NetworkError (retryable, recycle)',
					() =>
					{
						let tmpCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
						for (let i = 0; i < tmpCodes.length; i++)
						{
							let result = libRetry.classifyError(socketError(tmpCodes[i]), 123);
							Expect(result.mode).to.equal(libRetry.ERROR_MODES.NetworkError);
							Expect(result.isRetryable).to.equal(true);
							Expect(result.recommendPoolRecycle).to.equal(true);
							Expect(result.description).to.include(tmpCodes[i]);
						}
					});

				test('classifies ORA-01013 (call timeout) as RequestTimeout with DDL-lock hint',
					() =>
					{
						let r = libRetry.classifyError(timeoutError(), 30012);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.RequestTimeout);
						Expect(r.isRetryable).to.equal(true);
						Expect(r.recommendPoolRecycle).to.equal(true);
						Expect(r.description).to.include('DDL lock contention');
						Expect(r.description).to.include('30.0s');
					});

				test('classifies ORA-04021 (lock wait) as RequestTimeout',
					() =>
					{
						let r = libRetry.classifyError(oraError(4021), 8000);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.RequestTimeout);
					});

				test('classifies DPI-1067 call timeout as RequestTimeout',
					() =>
					{
						let e = new Error('DPI-1067: call timeout of 5000 ms exceeded');
						e.code = 'DPI-1067';
						let r = libRetry.classifyError(e, 5000);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.RequestTimeout);
					});

				test('classifies ORA-00955 "already used" as AlreadyExists (non-retryable, no recycle)',
					() =>
					{
						let r = libRetry.classifyError(alreadyExistsError(), 45);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.AlreadyExists);
						Expect(r.isRetryable).to.equal(false);
						Expect(r.recommendPoolRecycle).to.equal(false);
					});

				test('classifies ORA-00942 (missing object) as ServerError (non-retryable)',
					() =>
					{
						let r = libRetry.classifyError(serverError(942, 'ORA-00942: table or view does not exist'), 50);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.ServerError);
						Expect(r.isRetryable).to.equal(false);
						Expect(r.description).to.include('table or view does not exist');
					});

				test('classifies ORA-01017 (bad credentials) as ServerError (non-retryable)',
					() =>
					{
						let r = libRetry.classifyError(serverError(1017, 'ORA-01017: invalid credential'), 50);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.ServerError);
						Expect(r.isRetryable).to.equal(false);
					});

				test('detects PoolDegraded pattern (fast-fail after prior slow timeout)',
					() =>
					{
						let priorInfo = {
							lastFailureMode: libRetry.ERROR_MODES.RequestTimeout,
							lastFailureElapsed: 30000
						};
						let r = libRetry.classifyError(socketError('ECONNRESET'), 150, priorInfo);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.PoolDegraded);
						Expect(r.isRetryable).to.equal(true);
						Expect(r.recommendPoolRecycle).to.equal(true);
						Expect(r.description).to.include('degraded');
					});

				test('does NOT flag PoolDegraded when prior failure was fast too',
					() =>
					{
						let priorInfo = {
							lastFailureMode: libRetry.ERROR_MODES.NetworkError,
							lastFailureElapsed: 100
						};
						let r = libRetry.classifyError(socketError('ECONNRESET'), 200, priorInfo);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.NetworkError);
					});

				test('classifies unknown errors as Unknown, retryable, no recycle',
					() =>
					{
						let e = new Error('something weird');
						let r = libRetry.classifyError(e, 500);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.Unknown);
						Expect(r.isRetryable).to.equal(true);
						Expect(r.recommendPoolRecycle).to.equal(false);
					});

				test('parses ORA-NNNNN out of the message when errorNum is absent',
					() =>
					{
						let e = new Error('ORA-00942: table or view does not exist');
						let r = libRetry.classifyError(e, 50);
						Expect(r.mode).to.equal(libRetry.ERROR_MODES.ServerError);
					});
			});

		suite('extractErrorMessage',
			() =>
			{
				test('returns empty string for null/undefined',
					() =>
					{
						Expect(libRetry.extractErrorMessage(null)).to.equal('');
						Expect(libRetry.extractErrorMessage(undefined)).to.equal('');
					});

				test('returns the oracledb error message',
					() =>
					{
						let e = new Error('ORA-00001: unique constraint violated');
						Expect(libRetry.extractErrorMessage(e)).to.equal('ORA-00001: unique constraint violated');
					});
			});

		suite('runWithRetry',
			() =>
			{
				test('calls operation once on success, no retries',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpCalls = 0;
						libRetry.runWithRetry(log, { OperationName: 'test-op', MaxAttempts: 3 },
							(fAttemptDone) =>
							{
								tmpCalls++;
								fAttemptDone(null, 'yay');
							},
							(err, result) =>
							{
								try {
									Expect(err).to.be.null;
									Expect(result).to.equal('yay');
									Expect(tmpCalls).to.equal(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('retries on NetworkError with exponential backoff and succeeds',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpCalls = 0;
						libRetry.runWithRetry(log,
							{ OperationName: 'flaky-op', MaxAttempts: 3, InitialDelayMs: 10, MaxDelayMs: 50, BackoffFactor: 2 },
							(fAttemptDone) =>
							{
								tmpCalls++;
								if (tmpCalls < 3) fAttemptDone(socketError('ECONNRESET'));
								else fAttemptDone(null, 'finally');
							},
							(err, result) =>
							{
								try {
									Expect(err).to.be.null;
									Expect(result).to.equal('finally');
									Expect(tmpCalls).to.equal(3);
									let tmpWarnCount = log.records.filter(r => r.level === 'warn').length;
									Expect(tmpWarnCount).to.equal(2);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('logs classified failure mode on each attempt',
					(fDone) =>
					{
						let log = makeTestLogger();
						libRetry.runWithRetry(log,
							{ OperationName: 'logtest', MaxAttempts: 2, InitialDelayMs: 5 },
							(fAttemptDone) => fAttemptDone(socketError('ECONNRESET')),
							(err) =>
							{
								try {
									Expect(err).to.not.be.null;
									let tmpRelevant = log.records.filter(r => r.message.indexOf('[NetworkError]') >= 0);
									Expect(tmpRelevant.length).to.be.at.least(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('does not retry ServerError — fails fast',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpCalls = 0;
						libRetry.runWithRetry(log,
							{ OperationName: 'bad-sql', MaxAttempts: 5, InitialDelayMs: 10 },
							(fAttemptDone) =>
							{
								tmpCalls++;
								fAttemptDone(serverError(904, 'ORA-00904: invalid identifier'));
							},
							(err) =>
							{
								try {
									Expect(err).to.not.be.null;
									Expect(tmpCalls).to.equal(1);
									let tmpGivingUp = log.records.filter(r => r.message.indexOf('not retryable') >= 0);
									Expect(tmpGivingUp.length).to.equal(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('treats AlreadyExists as success',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpCalls = 0;
						libRetry.runWithRetry(log,
							{ OperationName: 'create-table', MaxAttempts: 3, InitialDelayMs: 10 },
							(fAttemptDone) =>
							{
								tmpCalls++;
								fAttemptDone(alreadyExistsError());
							},
							(err) =>
							{
								try {
									Expect(err).to.be.null;
									Expect(tmpCalls).to.equal(1);
									let tmpTreatedAsSuccess = log.records.filter(r => r.message.indexOf('treating as success') >= 0);
									Expect(tmpTreatedAsSuccess.length).to.equal(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('invokes OnRecyclePool for pool-degrading failure modes',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpRecycleCalls = 0;
						let tmpCalls = 0;
						libRetry.runWithRetry(log,
							{
								OperationName: 'ddl',
								MaxAttempts: 3,
								InitialDelayMs: 5,
								OnRecyclePool: (fDoneRecycle) =>
								{
									tmpRecycleCalls++;
									setImmediate(fDoneRecycle);
								}
							},
							(fAttemptDone) =>
							{
								tmpCalls++;
								if (tmpCalls === 1) fAttemptDone(timeoutError());
								else fAttemptDone(null, 'ok');
							},
							(err) =>
							{
								try {
									Expect(err).to.be.null;
									Expect(tmpCalls).to.equal(2);
									Expect(tmpRecycleCalls).to.equal(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});

				test('gives up after MaxAttempts and propagates last error',
					(fDone) =>
					{
						let log = makeTestLogger();
						let tmpLastErr = socketError('ECONNRESET');
						libRetry.runWithRetry(log,
							{ OperationName: 'doomed', MaxAttempts: 3, InitialDelayMs: 5 },
							(fAttemptDone) => fAttemptDone(tmpLastErr),
							(err) =>
							{
								try {
									Expect(err).to.equal(tmpLastErr);
									let tmpGiveUp = log.records.filter(r => r.message.indexOf('exhausted 3 attempts') >= 0);
									Expect(tmpGiveUp.length).to.equal(1);
									fDone();
								} catch (e) { fDone(e); }
							});
					});
			});
	});
