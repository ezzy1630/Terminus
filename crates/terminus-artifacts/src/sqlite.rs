//! SQLite-backed artifact metadata store (SPEC.md Section 29.3 step 7-8).
//!
//! Mirrors the Prisma `Artifact` + `ArtifactLink` tables (Appendix C schema):
//!
//! ```text
//! artifacts(hash PRIMARY KEY, size_bytes, media_type, content_encoding,
//!           storage_path, confidentiality, trust, retention_class,
//!           redaction_status, source_uri, source_version, created_at,
//!           last_verified_at, quarantine_reason)
//! artifact_links(id PRIMARY KEY, artifact_hash, owner_type, owner_id,
//!                owner_task_id, purpose, created_at, UNIQUE(artifact_hash, owner_type,
//!                owner_id, purpose))
//! ```
//!
//! The store is `Send + Sync` because the `rusqlite::Connection` is guarded
//! by a `Mutex` and shared via `Arc`. Cloning is cheap — clones share the
//! same underlying connection.

#![allow(clippy::needless_pass_by_value)]

use crate::error::ArtifactError;
use crate::metadata::{
    ArtifactLink, ArtifactMetadata, Confidentiality, ContentEncoding, RedactionStatus,
    RetentionClass, TrustLabel,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// SQLite-backed metadata store. Wraps a `rusqlite::Connection` guarded by a
/// `Mutex` so the store is `Send + Sync`. Cloning is cheap — the underlying
/// connection is shared via `Arc`.
#[derive(Clone)]
pub struct SqliteMetadataStore {
    conn: Arc<Mutex<Connection>>,
}

impl std::fmt::Debug for SqliteMetadataStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteMetadataStore")
            .finish_non_exhaustive()
    }
}

const SCHEMA_SQL: &str = "\
CREATE TABLE IF NOT EXISTS artifacts (
    hash              TEXT PRIMARY KEY,
    size_bytes        INTEGER NOT NULL,
    media_type        TEXT NOT NULL,
    content_encoding  TEXT NOT NULL,
    storage_path      TEXT NOT NULL,
    confidentiality   TEXT NOT NULL,
    trust             TEXT NOT NULL,
    retention_class   TEXT NOT NULL,
    redaction_status  TEXT NOT NULL,
    source_uri        TEXT,
    source_version    TEXT,
    created_at        TEXT NOT NULL,
    last_verified_at  TEXT NOT NULL,
    quarantine_reason TEXT
);
CREATE TABLE IF NOT EXISTS artifact_links (
    id            TEXT PRIMARY KEY,
    artifact_hash TEXT NOT NULL,
    owner_type    TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    owner_task_id TEXT NOT NULL DEFAULT '',
    purpose       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE(artifact_hash, owner_type, owner_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_artifact_links_owner
    ON artifact_links(owner_type, owner_id);
";

impl SqliteMetadataStore {
    /// Open or create a SQLite database at `path`. Creates the `artifacts`
    /// and `artifact_links` tables if they do not already exist.
    pub fn open(path: &Path) -> Result<Self, ArtifactError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(sqlite_err)?;
        conn.execute_batch(SCHEMA_SQL).map_err(sqlite_err)?;
        ensure_owner_task_column(&conn)?;
        // Best-effort WAL mode for concurrent readers — ignore errors (e.g.
        // in-memory databases do not support WAL).
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an in-memory SQLite database. Useful for unit tests that do not
    /// want to touch the filesystem.
    pub fn open_in_memory() -> Result<Self, ArtifactError> {
        let conn = Connection::open_in_memory().map_err(sqlite_err)?;
        conn.execute_batch(SCHEMA_SQL).map_err(sqlite_err)?;
        ensure_owner_task_column(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Upsert a metadata row. The `storage_path` is the absolute CAS path
    /// on disk. If a row with the same `hash` already exists, all fields are
    /// overwritten (this is intentional — `ingest` is idempotent and the
    /// metadata is the source of truth).
    pub fn upsert(&self, meta: &ArtifactMetadata, storage_path: &str) -> Result<(), ArtifactError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT OR REPLACE INTO artifacts
                (hash, size_bytes, media_type, content_encoding, storage_path,
                 confidentiality, trust, retention_class, redaction_status,
                 source_uri, source_version, created_at, last_verified_at,
                 quarantine_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL)",
            params![
                meta.hash,
                meta.size_bytes as i64,
                meta.media_type,
                meta.content_encoding.as_db_str(),
                storage_path,
                meta.confidentiality.as_db_str(),
                meta.trust.as_db_str(),
                meta.retention_class.as_db_str(),
                meta.redaction_status.as_db_str(),
                opt_str(&meta.source_uri),
                opt_str(&meta.source_version),
                meta.created_at,
                meta.created_at,
            ],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Fetch metadata for `hash`. Returns `Ok(None)` if no row exists.
    pub fn get(&self, hash: &str) -> Result<Option<ArtifactMetadata>, ArtifactError> {
        let conn = self.lock()?;
        let result = conn.query_row(
            "SELECT hash, size_bytes, media_type, content_encoding,
                    confidentiality, trust, retention_class, redaction_status,
                    source_uri, source_version, created_at
             FROM artifacts WHERE hash = ?1",
            params![hash],
            row_to_metadata,
        );
        match result {
            Ok(meta) => Ok(Some(meta)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(sqlite_err(e)),
        }
    }

    /// Insert a link row. The `(artifact_hash, owner_type, owner_id, purpose)`
    /// tuple is unique — inserting a duplicate is silently ignored (idempotent).
    pub fn link(
        &self,
        hash: &str,
        owner_type: &str,
        owner_id: &str,
        purpose: &str,
    ) -> Result<(), ArtifactError> {
        let conn = self.lock()?;
        let id = terminus_kernel_protocol::new_id();
        let now = now_rfc3339();
        conn.execute(
            "INSERT OR IGNORE INTO artifact_links
                (id, artifact_hash, owner_type, owner_id, owner_task_id, purpose, created_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
            params![id, hash, owner_type, owner_id, purpose, now],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Create the immutable task-bound owner link used by checkpoint
    /// admission. One checkpoint owner cannot be rebound to new bytes or a
    /// different task.
    pub fn link_task_bound(
        &self,
        hash: &str,
        owner_type: &str,
        owner_id: &str,
        owner_task_id: &str,
        purpose: &str,
    ) -> Result<(), ArtifactError> {
        let mut conn = self.lock()?;
        let transaction = conn.transaction().map_err(sqlite_err)?;
        let existing = transaction
            .query_row(
                "SELECT artifact_hash, owner_task_id FROM artifact_links
                 WHERE owner_type = ?1 AND owner_id = ?2 AND purpose = ?3
                 LIMIT 1",
                params![owner_type, owner_id, purpose],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(sqlite_err)?;
        if let Some((existing_hash, existing_task_id)) = existing {
            if existing_hash != hash
                || (!existing_task_id.is_empty() && existing_task_id != owner_task_id)
            {
                return Err(ArtifactError::OwnerConflict(format!(
                    "{owner_type}/{owner_id}/{purpose} is already bound to task {existing_task_id} and {existing_hash}",
                )));
            }
            if existing_task_id.is_empty() {
                transaction
                    .execute(
                        "UPDATE artifact_links SET owner_task_id = ?1
                         WHERE owner_type = ?2 AND owner_id = ?3 AND purpose = ?4
                           AND artifact_hash = ?5 AND owner_task_id = ''",
                        params![owner_task_id, owner_type, owner_id, purpose, hash],
                    )
                    .map_err(sqlite_err)?;
            }
            transaction.commit().map_err(sqlite_err)?;
            return Ok(());
        }
        let id = terminus_kernel_protocol::new_id();
        let now = now_rfc3339();
        transaction
            .execute(
                "INSERT INTO artifact_links
                    (id, artifact_hash, owner_type, owner_id, owner_task_id, purpose, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, hash, owner_type, owner_id, owner_task_id, purpose, now],
            )
            .map_err(sqlite_err)?;
        transaction.commit().map_err(sqlite_err)?;
        Ok(())
    }

    /// List all links for a given owner.
    pub fn list_by_owner(
        &self,
        owner_type: &str,
        owner_id: &str,
    ) -> Result<Vec<ArtifactLink>, ArtifactError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, artifact_hash, owner_type, owner_id, owner_task_id, purpose, created_at
                 FROM artifact_links
                 WHERE owner_type = ?1 AND owner_id = ?2
                 ORDER BY created_at ASC",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![owner_type, owner_id], |row| {
                Ok(ArtifactLink {
                    id: row.get(0)?,
                    artifact_hash: row.get(1)?,
                    owner_type: row.get(2)?,
                    owner_id: row.get(3)?,
                    owner_task_id: row.get(4)?,
                    purpose: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    pub fn list_checkpoint_links(
        &self,
        after_id: &str,
        limit: usize,
    ) -> Result<Vec<ArtifactLink>, ArtifactError> {
        let conn = self.lock()?;
        let mut statement = conn
            .prepare(
                "SELECT id, artifact_hash, owner_type, owner_id, owner_task_id, purpose, created_at
                 FROM artifact_links
                 WHERE owner_type = 'checkpoint' AND purpose = 'content' AND id > ?1
                 ORDER BY id ASC LIMIT ?2",
            )
            .map_err(sqlite_err)?;
        let rows = statement
            .query_map(params![after_id, limit as i64], |row| {
                Ok(ArtifactLink {
                    id: row.get(0)?,
                    artifact_hash: row.get(1)?,
                    owner_type: row.get(2)?,
                    owner_id: row.get(3)?,
                    owner_task_id: row.get(4)?,
                    purpose: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(sqlite_err)?;
        let mut links = Vec::new();
        for row in rows {
            links.push(row.map_err(sqlite_err)?);
        }
        Ok(links)
    }

    /// Return whether an artifact is durably linked to the requesting task.
    /// Artifact hashes are not bearer capabilities: callers must prove this
    /// ownership relation before bytes or metadata cross the kernel boundary.
    pub fn has_task_link(&self, hash: &str, owner_task_id: &str) -> Result<bool, ArtifactError> {
        let conn = self.lock()?;
        let present = conn
            .query_row(
                "SELECT 1 FROM artifact_links
                 WHERE artifact_hash = ?1 AND owner_task_id = ?2
                 LIMIT 1",
                params![hash, owner_task_id],
                |_row| Ok(()),
            )
            .optional()
            .map_err(sqlite_err)?
            .is_some();
        Ok(present)
    }

    pub fn unlink_checkpoint(
        &self,
        hash: &str,
        checkpoint_id: &str,
        owner_task_id: &str,
    ) -> Result<bool, ArtifactError> {
        let conn = self.lock()?;
        let deleted = conn
            .execute(
                "DELETE FROM artifact_links
                 WHERE artifact_hash = ?1 AND owner_type = 'checkpoint'
                   AND owner_id = ?2 AND owner_task_id = ?3 AND purpose = 'content'",
                params![hash, checkpoint_id, owner_task_id],
            )
            .map_err(sqlite_err)?;
        Ok(deleted == 1)
    }

    /// Find artifact hashes that have NO links and whose `retention_class`
    /// is NOT `legal_hold`. These are candidates for garbage collection.
    pub fn gc_dry_run(&self) -> Result<Vec<String>, ArtifactError> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT a.hash FROM artifacts a
                 WHERE a.retention_class != 'legal_hold'
                   AND NOT EXISTS (
                       SELECT 1 FROM artifact_links l
                       WHERE l.artifact_hash = a.hash
                   )
                 ORDER BY a.created_at ASC",
            )
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    /// Count the total number of artifact rows. Useful for diagnostics.
    pub fn count_artifacts(&self) -> Result<usize, ArtifactError> {
        let conn = self.lock()?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM artifacts", [], |row| row.get(0))
            .map_err(sqlite_err)?;
        Ok(count.max(0) as usize)
    }

    /// Count the total number of link rows. Useful for diagnostics.
    pub fn count_links(&self) -> Result<usize, ArtifactError> {
        let conn = self.lock()?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM artifact_links", [], |row| row.get(0))
            .map_err(sqlite_err)?;
        Ok(count.max(0) as usize)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, ArtifactError> {
        self.conn
            .lock()
            .map_err(|e| ArtifactError::Sqlite(e.to_string()))
    }
}

fn row_to_metadata(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactMetadata> {
    let hash: String = row.get(0)?;
    let size_bytes: i64 = row.get(1)?;
    let media_type: String = row.get(2)?;
    let content_encoding: String = row.get(3)?;
    let confidentiality: String = row.get(4)?;
    let trust: String = row.get(5)?;
    let retention_class: String = row.get(6)?;
    let redaction_status: String = row.get(7)?;
    let source_uri: Option<String> = row.get(8)?;
    let source_version: Option<String> = row.get(9)?;
    let created_at: String = row.get(10)?;
    Ok(ArtifactMetadata {
        hash,
        size_bytes: size_bytes.max(0) as u64,
        media_type,
        content_encoding: ContentEncoding::from_db_str(&content_encoding),
        created_at,
        producer: String::new(),
        confidentiality: Confidentiality::from_db_str(&confidentiality),
        trust: TrustLabel::from_db_str(&trust),
        retention_class: RetentionClass::from_db_str(&retention_class),
        redaction_status: RedactionStatus::from_db_str(&redaction_status),
        source_uri: source_uri.unwrap_or_default(),
        source_version: source_version.unwrap_or_default(),
    })
}

fn opt_str(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn sqlite_err(e: rusqlite::Error) -> ArtifactError {
    ArtifactError::Sqlite(e.to_string())
}

fn ensure_owner_task_column(connection: &Connection) -> Result<(), ArtifactError> {
    let mut statement = connection
        .prepare("PRAGMA table_info(artifact_links)")
        .map_err(sqlite_err)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_err)?;
    let mut has_owner_task_id = false;
    for column in columns {
        if column.map_err(sqlite_err)? == "owner_task_id" {
            has_owner_task_id = true;
            break;
        }
    }
    drop(statement);
    if !has_owner_task_id {
        connection
            .execute(
                "ALTER TABLE artifact_links ADD COLUMN owner_task_id TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(sqlite_err)?;
    }
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_artifact_links_task
             ON artifact_links(owner_task_id, owner_type)",
            [],
        )
        .map_err(sqlite_err)?;
    Ok(())
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:06}+00:00", dur.as_secs(), dur.subsec_micros())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_meta(hash: &str, size: u64) -> ArtifactMetadata {
        ArtifactMetadata::new(format!("sha256:{hash}"), size, "text/plain")
    }

    #[test]
    fn open_in_memory_creates_schema() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        assert_eq!(store.count_artifacts().expect("count"), 0);
        assert_eq!(store.count_links().expect("count"), 0);
    }

    #[test]
    fn upsert_and_get_round_trip() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let meta = sample_meta(&"a".repeat(64), 42);
        store
            .upsert(&meta, "/var/terminus/artifacts/sha256/aa/a/aaa")
            .expect("upsert");
        let fetched = store.get(&meta.hash).expect("get").expect("present");
        assert_eq!(fetched.hash, meta.hash);
        assert_eq!(fetched.size_bytes, 42);
        assert_eq!(fetched.media_type, "text/plain");
    }

    #[test]
    fn upsert_is_idempotent() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let hash = "b".repeat(64);
        let meta = sample_meta(&hash, 10);
        store.upsert(&meta, "/p1").expect("upsert1");
        store.upsert(&meta, "/p1").expect("upsert2");
        assert_eq!(store.count_artifacts().expect("count"), 1);
    }

    #[test]
    fn upsert_overwrites_fields() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let hash = "c".repeat(64);
        let mut meta = sample_meta(&hash, 10);
        store.upsert(&meta, "/p1").expect("upsert1");
        meta.retention_class = RetentionClass::LegalHold;
        store.upsert(&meta, "/p1").expect("upsert2");
        let fetched = store.get(&meta.hash).expect("get").expect("present");
        assert_eq!(fetched.retention_class, RetentionClass::LegalHold);
    }

    #[test]
    fn get_returns_none_when_missing() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let fetched = store
            .get(&format!("sha256:{}", "0".repeat(64)))
            .expect("get");
        assert!(fetched.is_none());
    }

    #[test]
    fn link_inserts_row() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let hash = format!("sha256:{}", "d".repeat(64));
        let meta = sample_meta(&"d".repeat(64), 7);
        store.upsert(&meta, "/p").expect("upsert");
        store.link(&hash, "task", "task-1", "input").expect("link");
        assert_eq!(store.count_links().expect("count"), 1);
        let links = store.list_by_owner("task", "task-1").expect("list");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].artifact_hash, hash);
        assert_eq!(links[0].purpose, "input");
    }

    #[test]
    fn link_is_idempotent_on_duplicate() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let hash = format!("sha256:{}", "e".repeat(64));
        let meta = sample_meta(&"e".repeat(64), 7);
        store.upsert(&meta, "/p").expect("upsert");
        store.link(&hash, "task", "task-1", "input").expect("link1");
        store.link(&hash, "task", "task-1", "input").expect("link2");
        let links = store.list_by_owner("task", "task-1").expect("list");
        assert_eq!(links.len(), 1);
    }

    #[test]
    fn checkpoint_link_binding_is_immutable_and_reconcilable() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let first_hash = format!("sha256:{}", "2".repeat(64));
        let other_hash = format!("sha256:{}", "3".repeat(64));
        store
            .upsert(&sample_meta(&"2".repeat(64), 1), "/first")
            .expect("first artifact");
        store
            .link_task_bound(
                &first_hash,
                "checkpoint",
                "checkpoint-1",
                "task-1",
                "content",
            )
            .expect("initial task-bound link");
        store
            .link_task_bound(
                &first_hash,
                "checkpoint",
                "checkpoint-1",
                "task-1",
                "content",
            )
            .expect("idempotent task-bound link");

        assert!(matches!(
            store.link_task_bound(
                &other_hash,
                "checkpoint",
                "checkpoint-1",
                "task-1",
                "content",
            ),
            Err(ArtifactError::OwnerConflict(_)),
        ));
        assert!(matches!(
            store.link_task_bound(
                &first_hash,
                "checkpoint",
                "checkpoint-1",
                "task-2",
                "content",
            ),
            Err(ArtifactError::OwnerConflict(_)),
        ));

        let links = store
            .list_checkpoint_links("", 10)
            .expect("checkpoint links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].owner_task_id, "task-1");
        assert!(store
            .unlink_checkpoint(&first_hash, "checkpoint-1", "task-1")
            .expect("unlink exact binding"));
        assert_eq!(store.count_links().expect("link count"), 0);
    }

    #[test]
    fn opening_legacy_metadata_adds_checkpoint_task_binding() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("metadata.sqlite");
        let connection = Connection::open(&path).expect("legacy database");
        connection
            .execute_batch(
                "CREATE TABLE artifact_links (
                    id TEXT PRIMARY KEY,
                    artifact_hash TEXT NOT NULL,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(artifact_hash, owner_type, owner_id, purpose)
                );",
            )
            .expect("legacy schema");
        drop(connection);

        let store = SqliteMetadataStore::open(&path).expect("upgraded metadata store");
        let hash = format!("sha256:{}", "4".repeat(64));
        store
            .link_task_bound(
                &hash,
                "checkpoint",
                "checkpoint-legacy",
                "task-1",
                "content",
            )
            .expect("task-bound link after upgrade");
        let links = store
            .list_checkpoint_links("", 10)
            .expect("upgraded checkpoint links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].owner_task_id, "task-1");
    }

    #[test]
    fn list_by_owner_filters_by_owner() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let h1 = format!("sha256:{}", "f".repeat(64));
        let h2 = format!("sha256:{}", "1".repeat(64));
        let m1 = sample_meta(&"f".repeat(64), 1);
        let m2 = sample_meta(&"1".repeat(64), 2);
        store.upsert(&m1, "/p1").expect("upsert");
        store.upsert(&m2, "/p2").expect("upsert");
        store.link(&h1, "task", "task-A", "input").expect("link");
        store.link(&h2, "task", "task-B", "input").expect("link");
        let a = store.list_by_owner("task", "task-A").expect("list");
        let b = store.list_by_owner("task", "task-B").expect("list");
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].artifact_hash, h1);
        assert_eq!(b[0].artifact_hash, h2);
    }

    #[test]
    fn gc_dry_run_finds_unlinked_non_legal_hold() {
        let store = SqliteMetadataStore::open_in_memory().expect("open");
        let h1 = format!("sha256:{}", "a".repeat(64));
        let h2 = format!("sha256:{}", "b".repeat(64));
        let h3 = format!("sha256:{}", "c".repeat(64));
        let m1 = sample_meta(&"a".repeat(64), 1);
        let m2 = sample_meta(&"b".repeat(64), 2);
        let mut m3 = sample_meta(&"c".repeat(64), 3);
        m3.retention_class = RetentionClass::LegalHold;
        store.upsert(&m1, "/p1").expect("upsert");
        store.upsert(&m2, "/p2").expect("upsert");
        store.upsert(&m3, "/p3").expect("upsert");
        // Link only h2 — h1 has no link, h3 has no link but is legal_hold.
        store.link(&h2, "task", "task-1", "output").expect("link");
        let collectable = store.gc_dry_run().expect("gc");
        // Only h1 should be collectable: no link, not legal_hold.
        assert_eq!(collectable.len(), 1);
        assert_eq!(collectable[0], h1);
        // h3 must NOT be collectable (legal_hold).
        assert!(!collectable.contains(&h3));
    }

    #[test]
    fn open_on_disk_persists_across_handles() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("metadata.db");
        let hash = "9".repeat(64);
        {
            let store = SqliteMetadataStore::open(&path).expect("open");
            let meta = sample_meta(&hash, 99);
            store.upsert(&meta, "/p").expect("upsert");
        }
        {
            let store = SqliteMetadataStore::open(&path).expect("reopen");
            let fetched = store
                .get(&format!("sha256:{hash}"))
                .expect("get")
                .expect("present");
            assert_eq!(fetched.size_bytes, 99);
        }
    }
}
