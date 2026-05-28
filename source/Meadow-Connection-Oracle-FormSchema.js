/**
 * Connection form schema for Oracle Database.
 *
 * Consumed by meadow-connection-manager#getProviderFormSchema('Oracle').
 * Pure data — safe to require() even when the oracledb driver is not installed.
 *
 * The driver connects via an Easy Connect string built from server + port +
 * serviceName, distinguished by connectionType (ServiceName vs SID).  A raw
 * connectString may be supplied to override (TNS alias / full descriptor).
 *
 * Unit convention: timeouts and delays are entered in seconds in the UI but
 * stored in milliseconds in the config blob; expressed via Multiplier: 1000.
 */
'use strict';

module.exports =
{
	Provider:    'Oracle',
	DisplayName: 'Oracle',
	Description: 'Connect to an Oracle Database instance (oracledb Thin mode).',
	Fields:
	[
		// ── Basic ──
		{ Name: 'server',         Label: 'Server',        Type: 'String',   Default: '127.0.0.1', Required: true, Placeholder: '127.0.0.1' },
		{ Name: 'port',           Label: 'Port',          Type: 'Number',   Default: 1521,        Required: true, Min: 1, Max: 65535 },
		{ Name: 'user',           Label: 'User',          Type: 'String',   Required: true },
		{ Name: 'password',       Label: 'Password',      Type: 'Password' },
		{
			Name:        'connectionType',
			Label:       'Connection type',
			Type:        'Select',
			Default:     'ServiceName',
			Options:
			[
				{ Value: 'ServiceName', Label: 'Service Name (host:port/service)' },
				{ Value: 'SID',         Label: 'SID (host:port:sid)' }
			],
			Help:        'How the service field is interpreted: Service Name (modern) or SID (legacy).'
		},
		{ Name: 'serviceName',    Label: 'Service name / SID', Type: 'String', Default: 'XEPDB1', Required: true, Placeholder: 'XEPDB1' },
		{
			Name:        'connectString',
			Label:       'Connect string (override)',
			Type:        'String',
			OmitIfFalsy: true,
			Help:        'Optional raw Easy Connect string or TNS descriptor; overrides server/port/serviceName when set.',
			Group:       'Advanced'
		},
		{ Name: 'connectionLimit', Label: 'Connection Limit', Type: 'Number', Default: 10, Min: 1, MapTo: [ 'ConnectionPoolLimit' ], Group: 'Advanced' },

		// ── Oracle dialect / DDL behavior ──
		{
			Name:        'LegacyPagination',
			Label:       'Legacy pagination (Oracle 11g and earlier)',
			Type:        'Boolean',
			OmitIfFalsy: true,
			Help:        'Use a ROWNUM subquery instead of OFFSET/FETCH for versions without the row-limiting clause. Leave unset to auto-detect from the server version at connect time.'
		},
		{
			Name:        'LegacyIdentity',
			Label:       'Legacy identity (Oracle 11g and earlier)',
			Type:        'Boolean',
			OmitIfFalsy: true,
			Help:        'Use a SEQUENCE + BEFORE INSERT trigger instead of a NUMBER IDENTITY column for auto-increment keys. Leave unset to auto-detect from the server version at connect time.'
		},
		{
			Name:  'QuoteIdentifiers',
			Label: 'Quote identifiers (preserve case)',
			Type:  'Boolean',
			Help:  'Wrap identifiers in double quotes to preserve PascalCase. Off (default) lets Oracle fold names to UPPERCASE; external tools then need not quote.'
		},
		{
			Name:  'NumberAsString',
			Label: 'Fetch NUMBER as string (high precision)',
			Type:  'Boolean',
			Help:  'Return NUMBER columns as strings to avoid JS floating-point precision loss on large Decimals.'
		},

		// ── Advanced: timeouts (entered as sec, stored as ms) ──
		{
			Name:        'RequestTimeoutMs',
			Label:       'Request timeout (sec)',
			Type:        'Number',
			Default:     120,
			Min:         1,
			Multiplier:  1000,
			OmitIfFalsy: true,
			Group:       'Advanced'
		},
		{
			Name:        'ConnectionTimeoutMs',
			Label:       'Connection timeout (sec)',
			Type:        'Number',
			Default:     60,
			Min:         1,
			Multiplier:  1000,
			OmitIfFalsy: true,
			Group:       'Advanced'
		},

		// ── Advanced: retry buckets (Connect + DDL) ──
		{
			Name:        'ConnectRetryOptions.MaxAttempts',
			Label:       'Connect retries (max attempts)',
			Type:        'Number',
			Default:     5,
			Min:         1,
			Max:         20,
			OmitIfFalsy: true,
			Group:       'Advanced'
		},
		{
			Name:        'DDLRetryOptions.MaxAttempts',
			Label:       'DDL retries (max attempts)',
			Type:        'Number',
			Default:     5,
			Min:         1,
			Max:         20,
			OmitIfFalsy: true,
			Group:       'Advanced'
		},
		{
			Name:        'RetryInitialDelaySec',
			Label:       'Retry initial delay (sec)',
			Type:        'Number',
			Default:     3,
			Min:         1,
			Max:         60,
			Multiplier:  1000,
			MapTo:       [ 'ConnectRetryOptions.InitialDelayMs', 'DDLRetryOptions.InitialDelayMs' ],
			OmitIfFalsy: true,
			Group:       'Advanced'
		},
		{
			Name:        'RetryMaxDelaySec',
			Label:       'Retry max delay (sec)',
			Type:        'Number',
			Default:     30,
			Min:         1,
			Max:         600,
			Multiplier:  1000,
			MapTo:       [ 'ConnectRetryOptions.MaxDelayMs', 'DDLRetryOptions.MaxDelayMs' ],
			OmitIfFalsy: true,
			Group:       'Advanced'
		}
	]
};
