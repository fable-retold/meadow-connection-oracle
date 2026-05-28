/**
 * Meadow Oracle Retry + Error Classification
 *
 * Shared helper used by both the connection provider (Meadow-Connection-Oracle)
 * and the schema provider (Meadow-Schema-Oracle) to:
 *
 *   1. Classify oracledb driver errors into a small set of well-known failure
 *      modes, so logs make it obvious WHY an operation failed (network,
 *      lock contention, pool degradation, etc.).
 *   2. Retry transient operations with exponential backoff, logging each
 *      attempt in a way that makes the failure mode sequence readable.
 *   3. Optionally recycle the connection pool on failures that suggest the
 *      pooled connection is in a bad state (timeouts, network drops).
 *
 * The retry/backoff engine is identical to the other Meadow SQL connectors;
 * only the error classification is Oracle-specific (it keys off the ORA-NNNNN
 * error numbers oracledb exposes as err.errorNum, plus DPI-/socket-level codes
 * on err.code).
 *
 * @license MIT
 * @author Steven Velozo <steven@velozo.com>
 */

'use strict';

/**
 * Default retry options.  Callers may override any of these per-operation.
 *
 *   MaxAttempts        — total attempts including the first.  5 means
 *                        "first try + up to 4 retries".
 *   InitialDelayMs     — wait before the second attempt.  Subsequent
 *                        retries use exponential backoff from here.
 *   MaxDelayMs         — cap the backoff so we don't wait absurdly long.
 *   BackoffFactor      — multiplier between retries (2 = double each time).
 *   PoolRecycleModes   — failure modes that trigger pool recycling before
 *                        the next attempt.  Kept explicit so callers can
 *                        narrow or widen the set without reading code.
 */
const DEFAULT_RETRY_OPTIONS =
{
	MaxAttempts: 5,
	InitialDelayMs: 2000,
	MaxDelayMs: 30000,
	BackoffFactor: 2,
	PoolRecycleModes: ['NetworkError', 'RequestTimeout', 'PoolDegraded']
};

/**
 * Error-mode strings.  Exported so callers can reference them in
 * configuration (e.g. extending PoolRecycleModes) without stringly-typing.
 */
const ERROR_MODES =
{
	AlreadyExists:  'AlreadyExists',
	NetworkError:   'NetworkError',
	RequestTimeout: 'RequestTimeout',
	PoolDegraded:   'PoolDegraded',
	ServerError:    'ServerError',
	Unknown:        'Unknown'
};

/**
 * Deterministic server-side errors — retrying won't help (syntax, missing
 * objects, permission denials, constraint violations).  Keyed by ORA number.
 */
const SERVER_ERROR_NUMBERS =
{
	1:    'unique constraint violated',
	904:  'invalid identifier',
	906:  'missing or invalid option',
	911:  'invalid character (e.g. a stray statement terminator)',
	936:  'missing expression',
	942:  'table or view does not exist',
	1017: 'invalid credential / logon denied',
	1031: 'insufficient privileges',
	1400: 'cannot insert NULL into a NOT NULL column',
	2291: 'integrity constraint violated — parent key not found',
	2292: 'integrity constraint violated — child record found'
};

/**
 * Request/lock timeouts — the statement reached the server but didn't finish
 * in time, or it couldn't acquire a lock.  Worth a retry (often after a pool
 * recycle) because the contention may clear.
 */
const REQUEST_TIMEOUT_NUMBERS =
{
	54:    'resource busy and acquire with NOWAIT specified — lock contention',
	1013:  'user requested cancel of current operation (call timeout expired)',
	4021:  'timeout occurred while waiting to lock object — DDL lock contention',
	30006: 'resource busy; acquire timeout expired'
};

/**
 * Network/transport failures — the problem is below the SQL layer (server
 * unreachable, listener down, connection dropped, connect timeout).  Retry
 * after recycling the pool.
 */
const NETWORK_ERROR_NUMBERS =
{
	3113:  'end-of-file on communication channel',
	3114:  'not connected to ORACLE',
	3135:  'connection lost contact',
	12150: 'TNS:unable to send data',
	12152: 'TNS:unable to send break message',
	12170: 'TNS:connect timeout occurred',
	12505: 'TNS:listener does not currently know of SID given in connect descriptor',
	12514: 'TNS:listener does not currently know of service requested',
	12537: 'TNS:connection closed',
	12541: 'TNS:no listener',
	12545: 'connect failed because target host or object does not exist',
	12571: 'TNS:packet writer failure'
};

/**
 * Socket-level error codes (oracledb Thin mode surfaces these on err.code for
 * connection-establishment failures).
 */
const NETWORK_ERROR_CODES =
{
	ECONNREFUSED: true,
	ECONNRESET:   true,
	ENETUNREACH:  true,
	EHOSTUNREACH: true,
	ENOTFOUND:    true,
	EAI_AGAIN:    true,
	ETIMEDOUT:    true,
	EPIPE:        true
};

/**
 * Extract the best available diagnostic string from an oracledb error.
 *
 * @param {Error} pError
 * @return {string}
 */
function extractErrorMessage(pError)
{
	if (!pError) return '';
	return pError.message || '';
}

/**
 * Resolve the integer ORA error number from an oracledb error.  oracledb
 * exposes it directly as err.errorNum, but connection-layer failures sometimes
 * arrive with errorNum 0 and the real ORA code only in the message text — so
 * fall back to parsing "ORA-NNNNN" out of the message.
 *
 * @param {Error} pError
 * @return {number} The ORA number, or 0 if none could be determined
 */
function getOracleErrorNumber(pError)
{
	if (!pError) return 0;
	if (typeof pError.errorNum === 'number' && pError.errorNum > 0)
	{
		return pError.errorNum;
	}
	let tmpMatch = (pError.message || '').match(/ORA-(\d+)/);
	if (tmpMatch)
	{
		return parseInt(tmpMatch[1], 10);
	}
	return 0;
}

/**
 * Classify an oracledb error into one of the well-known failure modes.
 *
 * @param {Error}  pError       — the error from the oracledb driver
 * @param {number} pElapsedMs   — how long the failed attempt took
 * @param {Object} [pPriorInfo] — { lastFailureMode, lastFailureElapsed }
 *                                from the most recent prior attempt; used
 *                                to detect the fast-fail-after-timeout
 *                                pattern that signals pool degradation.
 *
 * @return {{
 *   mode: string,
 *   description: string,
 *   isRetryable: boolean,
 *   recommendPoolRecycle: boolean
 * }}
 */
function classifyError(pError, pElapsedMs, pPriorInfo)
{
	let tmpNumber = getOracleErrorNumber(pError);
	let tmpCode = (pError && pError.code) || '';
	let tmpMsg = extractErrorMessage(pError);
	let tmpMsgLower = tmpMsg.toLowerCase();

	// Benign case — target already exists.  Callers should treat as success.
	if (tmpNumber === 955 || tmpMsgLower.indexOf('name is already used') >= 0)
	{
		return {
			mode: ERROR_MODES.AlreadyExists,
			description: 'target already exists (benign on re-deploy)',
			isRetryable: false,
			recommendPoolRecycle: false
		};
	}

	// Server-level error (syntax, permissions, constraint violations).  These
	// are deterministic — retrying won't help.  Checked early so we don't
	// misclassify them as anything transient.
	if (SERVER_ERROR_NUMBERS.hasOwnProperty(tmpNumber))
	{
		return {
			mode: ERROR_MODES.ServerError,
			description: `server-side SQL error (ORA-${String(tmpNumber).padStart(5, '0')}): ${SERVER_ERROR_NUMBERS[tmpNumber]}`,
			isRetryable: false,
			recommendPoolRecycle: false
		};
	}

	// Pool-degraded heuristic: a fast failure (<500ms) right after a prior slow
	// failure (>5s) almost always means the pooled connection is in a bad state.
	// Check BEFORE the generic NetworkError/RequestTimeout branches so the
	// specific mode wins in the log.
	if (pElapsedMs < 500 &&
		pPriorInfo &&
		pPriorInfo.lastFailureMode === ERROR_MODES.RequestTimeout &&
		pPriorInfo.lastFailureElapsed > 5000)
	{
		return {
			mode: ERROR_MODES.PoolDegraded,
			description: `query failed in ${pElapsedMs}ms after prior ${(pPriorInfo.lastFailureElapsed / 1000).toFixed(1)}s timeout — connection pool appears degraded (stale/bad connection)`,
			isRetryable: true,
			recommendPoolRecycle: true
		};
	}

	// Request timeout / lock contention — the statement reached the server but
	// didn't finish in time, or couldn't acquire a lock.  DPI-1067 is the Thin
	// driver's call-timeout code.
	if (REQUEST_TIMEOUT_NUMBERS.hasOwnProperty(tmpNumber) ||
		tmpCode === 'DPI-1067' ||
		tmpMsgLower.indexOf('call timeout') >= 0 ||
		tmpMsgLower.indexOf('timeout expired') >= 0)
	{
		return {
			mode: ERROR_MODES.RequestTimeout,
			description: `request timed out after ${(pElapsedMs / 1000).toFixed(1)}s — likely DDL lock contention on the server, a long-running blocking query, or a very slow server response`,
			isRetryable: true,
			recommendPoolRecycle: true
		};
	}

	// Network/transport failures — server unreachable, listener down, socket
	// dropped, or connect timeout.  These all indicate the problem is below the
	// SQL layer.
	if (NETWORK_ERROR_NUMBERS.hasOwnProperty(tmpNumber) ||
		NETWORK_ERROR_CODES.hasOwnProperty(tmpCode) ||
		tmpCode === 'NJS-500' ||
		tmpCode === 'DPI-1080')
	{
		return {
			mode: ERROR_MODES.NetworkError,
			description: `network-level failure (${tmpNumber ? 'ORA-' + String(tmpNumber).padStart(5, '0') : tmpCode}) — server unreachable or connection dropped: ${tmpMsg}`,
			isRetryable: true,
			recommendPoolRecycle: true
		};
	}

	// Everything else — retry cautiously (it might be transient) but don't
	// recycle the pool since we don't know what kind of failure it is.
	return {
		mode: ERROR_MODES.Unknown,
		description: `unclassified error (${tmpNumber ? 'ORA-' + String(tmpNumber).padStart(5, '0') : (tmpCode || 'no code')}): ${tmpMsg}`,
		isRetryable: true,
		recommendPoolRecycle: false
	};
}

/**
 * Run an operation with retry, exponential backoff, error classification,
 * and optional pool recycling.  Callback-style to match the rest of the
 * Meadow codebase.
 *
 * The operation function is called with a single `fDone(err, result)`
 * callback.  `err` may be null on success.  Anything truthy is classified
 * and either retried (if the mode is retryable) or propagated.
 *
 * @param {Object}   pLog       — a fable logger (has .info, .warn, .error)
 * @param {Object}   pOptions   — { OperationName, MaxAttempts, InitialDelayMs, MaxDelayMs, BackoffFactor, PoolRecycleModes, OnRecyclePool, SuccessModes }
 * @param {Function} fOperation — (fDone) => ... where fDone(err, result)
 * @param {Function} fCallback  — (err, result) => ...
 */
function runWithRetry(pLog, pOptions, fOperation, fCallback)
{
	let tmpOptions = Object.assign({}, DEFAULT_RETRY_OPTIONS, pOptions || {});
	let tmpOpName = tmpOptions.OperationName || 'Meadow-Oracle operation';
	let tmpPriorInfo = null;
	let tmpAttempt = 0;

	// SuccessModes lets callers treat certain failure modes as success
	// (e.g. AlreadyExists for CREATE TABLE — not really an error).
	let tmpSuccessModes = tmpOptions.SuccessModes || [ERROR_MODES.AlreadyExists];

	let fTryOnce = () =>
	{
		tmpAttempt++;
		let tmpStartMs = Date.now();

		pLog.info(`${tmpOpName}: attempt ${tmpAttempt}/${tmpOptions.MaxAttempts} starting...`);

		fOperation((pError, pResult) =>
		{
			let tmpElapsedMs = Date.now() - tmpStartMs;

			if (!pError)
			{
				if (tmpAttempt > 1)
				{
					pLog.info(`${tmpOpName}: succeeded on attempt ${tmpAttempt} (elapsed ${tmpElapsedMs}ms)`);
				}
				return fCallback(null, pResult);
			}

			let tmpInfo = classifyError(pError, tmpElapsedMs, tmpPriorInfo);

			// Treat success-mode failures as success.
			if (tmpSuccessModes.indexOf(tmpInfo.mode) >= 0)
			{
				pLog.info(`${tmpOpName}: ${tmpInfo.description} — treating as success`);
				return fCallback(null, pResult);
			}

			pLog.warn(`${tmpOpName}: attempt ${tmpAttempt}/${tmpOptions.MaxAttempts} failed after ${tmpElapsedMs}ms [${tmpInfo.mode}] — ${tmpInfo.description}`);

			tmpPriorInfo = { lastFailureMode: tmpInfo.mode, lastFailureElapsed: tmpElapsedMs };

			// Terminal: non-retryable or exhausted attempts.
			if (!tmpInfo.isRetryable)
			{
				pLog.error(`${tmpOpName}: giving up — ${tmpInfo.mode} is not retryable`);
				return fCallback(pError);
			}
			if (tmpAttempt >= tmpOptions.MaxAttempts)
			{
				pLog.error(`${tmpOpName}: giving up — exhausted ${tmpOptions.MaxAttempts} attempts; last failure mode was ${tmpInfo.mode}`);
				return fCallback(pError);
			}

			// Compute next delay with exponential backoff, capped at MaxDelayMs.
			let tmpDelayMs = Math.min(
				tmpOptions.InitialDelayMs * Math.pow(tmpOptions.BackoffFactor, tmpAttempt - 1),
				tmpOptions.MaxDelayMs);

			let fScheduleRetry = () =>
			{
				pLog.info(`${tmpOpName}: retrying in ${(tmpDelayMs / 1000).toFixed(1)}s (attempt ${tmpAttempt + 1}/${tmpOptions.MaxAttempts})`);
				setTimeout(fTryOnce, tmpDelayMs);
			};

			// Recycle the pool if the failure mode suggests it AND the caller
			// provided a recycling hook.  Pool recycling is async too — wait
			// for it to finish before scheduling the retry.
			let tmpShouldRecycle = tmpOptions.PoolRecycleModes.indexOf(tmpInfo.mode) >= 0
				&& tmpInfo.recommendPoolRecycle
				&& typeof (tmpOptions.OnRecyclePool) === 'function';

			if (tmpShouldRecycle)
			{
				pLog.info(`${tmpOpName}: recycling connection pool before retry (mode: ${tmpInfo.mode})`);
				tmpOptions.OnRecyclePool((pRecycleError) =>
				{
					if (pRecycleError)
					{
						pLog.warn(`${tmpOpName}: pool recycle failed — ${pRecycleError.message || pRecycleError}; retrying anyway`);
					}
					fScheduleRetry();
				});
				return;
			}

			fScheduleRetry();
		});
	};

	fTryOnce();
}

module.exports = {
	classifyError: classifyError,
	runWithRetry: runWithRetry,
	extractErrorMessage: extractErrorMessage,
	getOracleErrorNumber: getOracleErrorNumber,
	DEFAULT_RETRY_OPTIONS: DEFAULT_RETRY_OPTIONS,
	ERROR_MODES: ERROR_MODES
};
