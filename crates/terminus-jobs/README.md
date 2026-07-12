# terminus-jobs

Durable job state machine for the Terminus kernel.

`JobManager` tracks long-running processes through the state machine
`CREATED → STARTING → RUNNING → EXITED/STOPPING/ORPHANED/LOST` and reconciles
after a kernel restart: if a job's process identity is no longer running, the
job is marked `LOST`. Job records are serializable (SQLite-backed in
production) and include owner session/task ids, resolved executable, public
environment digest, secret capability references, sandbox id, resource
limits, output artifact ref, output cursor, cleanup policy, and timestamps.

Reuses `forge_process::ProcessManager` for actual OS process control.
