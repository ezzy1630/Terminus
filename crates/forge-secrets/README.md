# forge-secrets

Secret broker with redaction and audit logging.

`SecretBroker` resolves `secret://provider/scope` URIs into short-lived
`SecretHandle`s that are injected into one isolated process env/fd only,
constrain destination and operation, and are wiped (zeroed) on drop. The
broker never serializes the raw secret value: `SecretHandle`'s `Debug`
impl prints `<redacted>`, and the audit log records only metadata (URI,
requester, issued/expires timestamps, allowed destinations).

Output redaction is provided by `Redactor`, which scans process output for
known literal patterns and replaces matches with `***REDACTED:<id>***`.
