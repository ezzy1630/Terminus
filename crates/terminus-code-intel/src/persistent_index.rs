use crate::error::CodeIntelError;
use crate::index::SymbolIndex;
use crate::symbols::{Symbol, SymbolKind};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct CallEdge {
    pub caller: String,
    pub callee: String,
    pub path: String,
    pub line: u32,
    pub direction: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ImportEdge {
    pub source_path: String,
    pub target_path: String,
    pub imported_symbol: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct TestOwnershipMapping {
    pub symbol_name: String,
    pub source_path: String,
    pub test_path: String,
    pub test_name: String,
}

/// A persistent, SQLite-backed symbol and code-intelligence index.
pub struct PersistentSymbolIndex {
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

impl std::fmt::Debug for PersistentSymbolIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersistentSymbolIndex")
            .field("db_path", &self.db_path)
            .finish()
    }
}

impl PersistentSymbolIndex {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, CodeIntelError> {
        let db_path = path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&db_path)?;
        let index = Self {
            conn: Mutex::new(conn),
            db_path,
        };
        index.init_tables()?;
        Ok(index)
    }

    pub fn in_memory() -> Result<Self, CodeIntelError> {
        let conn = Connection::open_in_memory()?;
        let index = Self {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        };
        index.init_tables()?;
        Ok(index)
    }

    fn init_tables(&self) -> Result<(), CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS file_meta (
                path TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                last_indexed INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS symbols (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                start_column INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                end_column INTEGER NOT NULL,
                signature TEXT NOT NULL,
                content_hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);

            CREATE TABLE IF NOT EXISTS references_table (
                id TEXT PRIMARY KEY,
                symbol_name TEXT NOT NULL,
                path TEXT NOT NULL,
                line INTEGER NOT NULL,
                snippet TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ref_symbol ON references_table(symbol_name);

            CREATE TABLE IF NOT EXISTS calls (
                caller TEXT NOT NULL,
                callee TEXT NOT NULL,
                path TEXT NOT NULL,
                line INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller);
            CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee);

            CREATE TABLE IF NOT EXISTS imports (
                source_path TEXT NOT NULL,
                target_path TEXT NOT NULL,
                imported_symbol TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source_path);

            CREATE TABLE IF NOT EXISTS test_ownership (
                symbol_name TEXT NOT NULL,
                source_path TEXT NOT NULL,
                test_path TEXT NOT NULL,
                test_name TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_test_symbol ON test_ownership(symbol_name);
            ",
        )?;
        Ok(())
    }

    pub fn is_fresh(&self, path: &str, content_hash: &str) -> Result<bool, CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        let mut stmt = conn.prepare("SELECT content_hash FROM file_meta WHERE path = ?1")?;
        let mut rows = stmt.query(params![path])?;
        if let Some(row) = rows.next()? {
            let stored_hash: String = row.get(0)?;
            Ok(stored_hash == content_hash)
        } else {
            Ok(false)
        }
    }

    pub fn call_hierarchy(&self, symbol_name: &str) -> Result<Vec<CallEdge>, CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        let mut edges = Vec::new();
        // Incoming calls (where symbol_name is callee)
        let mut stmt =
            conn.prepare("SELECT caller, callee, path, line FROM calls WHERE callee = ?1")?;
        let rows = stmt.query_map(params![symbol_name], |row| {
            Ok(CallEdge {
                caller: row.get(0)?,
                callee: row.get(1)?,
                path: row.get(2)?,
                line: row.get(3)?,
                direction: "incoming".to_string(),
            })
        })?;
        for r in rows {
            edges.push(r?);
        }

        // Outgoing calls (where symbol_name is caller)
        let mut stmt =
            conn.prepare("SELECT caller, callee, path, line FROM calls WHERE caller = ?1")?;
        let rows = stmt.query_map(params![symbol_name], |row| {
            Ok(CallEdge {
                caller: row.get(0)?,
                callee: row.get(1)?,
                path: row.get(2)?,
                line: row.get(3)?,
                direction: "outgoing".to_string(),
            })
        })?;
        for r in rows {
            edges.push(r?);
        }

        Ok(edges)
    }

    pub fn import_graph(&self, source_path: &str) -> Result<Vec<ImportEdge>, CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        let mut stmt = conn.prepare(
            "SELECT source_path, target_path, imported_symbol FROM imports WHERE source_path = ?1",
        )?;
        let rows = stmt.query_map(params![source_path], |row| {
            Ok(ImportEdge {
                source_path: row.get(0)?,
                target_path: row.get(1)?,
                imported_symbol: row.get(2)?,
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    pub fn get_test_ownership(
        &self,
        symbol_or_path: &str,
    ) -> Result<Vec<TestOwnershipMapping>, CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        let mut stmt = conn.prepare(
            "SELECT symbol_name, source_path, test_path, test_name FROM test_ownership WHERE symbol_name = ?1 OR source_path = ?1",
        )?;
        let rows = stmt.query_map(params![symbol_or_path], |row| {
            Ok(TestOwnershipMapping {
                symbol_name: row.get(0)?,
                source_path: row.get(1)?,
                test_path: row.get(2)?,
                test_name: row.get(3)?,
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }
}

impl SymbolIndex for PersistentSymbolIndex {
    fn index_file(&self, path: &str, content: &str) -> Result<(), CodeIntelError> {
        let hash_str = format!("{:x}", Sha256::digest(content.as_bytes()));
        if self.is_fresh(path, &hash_str)? {
            return Ok(());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        // Clear existing entries for this file
        conn.execute("DELETE FROM symbols WHERE path = ?1", params![path])?;
        conn.execute(
            "DELETE FROM references_table WHERE path = ?1",
            params![path],
        )?;
        conn.execute("DELETE FROM calls WHERE path = ?1", params![path])?;
        conn.execute("DELETE FROM imports WHERE source_path = ?1", params![path])?;
        conn.execute(
            "DELETE FROM test_ownership WHERE source_path = ?1 OR test_path = ?1",
            params![path],
        )?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        conn.execute(
            "INSERT OR REPLACE INTO file_meta (path, content_hash, last_indexed) VALUES (?1, ?2, ?3)",
            params![path, hash_str, now],
        )?;

        // Extract symbols via AST breakdown
        let is_test_file = path.contains("test") || path.contains("spec");
        let mut current_function: Option<String> = None;

        for (lineno, line) in content.lines().enumerate() {
            let line_num = (lineno as u32) + 1;
            let trimmed = line.trim_start();
            let parts: Vec<&str> = trimmed.split_whitespace().collect();

            // Extract imports
            if trimmed.starts_with("import ")
                || trimmed.starts_with("use ")
                || trimmed.starts_with("from ")
            {
                let target = if let Some(first_quote) = trimmed.find('\'') {
                    if let Some(second_quote) = trimmed[first_quote + 1..].find('\'') {
                        trimmed[first_quote + 1..first_quote + 1 + second_quote].to_string()
                    } else {
                        parts.get(1).copied().unwrap_or("unknown").to_string()
                    }
                } else if let Some(first_quote) = trimmed.find('"') {
                    if let Some(second_quote) = trimmed[first_quote + 1..].find('"') {
                        trimmed[first_quote + 1..first_quote + 1 + second_quote].to_string()
                    } else {
                        parts.get(1).copied().unwrap_or("unknown").to_string()
                    }
                } else {
                    parts
                        .get(1)
                        .copied()
                        .unwrap_or("unknown")
                        .trim_matches(';')
                        .to_string()
                };

                conn.execute(
                    "INSERT INTO imports (source_path, target_path, imported_symbol) VALUES (?1, ?2, ?3)",
                    params![path, target, target],
                )?;
            }

            let is_symbol_def = trimmed.starts_with("fn ")
                || trimmed.starts_with("function ")
                || trimmed.starts_with("def ")
                || trimmed.starts_with("pub fn ")
                || trimmed.starts_with("pub async fn ")
                || trimmed.starts_with("async function ")
                || trimmed.starts_with("class ")
                || trimmed.starts_with("struct ")
                || trimmed.starts_with("interface ")
                || trimmed.starts_with("enum ");

            // Extract calls from line if not a symbol definition header
            if !is_symbol_def {
                if let Some(ref caller) = current_function {
                    for word in &parts {
                        if let Some(paren_idx) = word.find('(') {
                            let candidate = word[..paren_idx]
                                .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '_');
                            let callee = candidate
                                .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
                            if !callee.is_empty()
                                && callee != caller
                                && callee != "fn"
                                && callee != "function"
                                && callee != "def"
                                && callee != "if"
                                && callee != "for"
                                && callee != "while"
                            {
                                let _ = conn.execute(
                                    "INSERT INTO calls (caller, callee, path, line) VALUES (?1, ?2, ?3, ?4)",
                                    params![caller, callee, path, line_num],
                                );
                            }
                        }
                    }
                }
            }

            if parts.len() >= 2 {
                let (kind, name_raw) = match parts[0] {
                    "fn" | "function" | "def" => (SymbolKind::Function, parts[1]),
                    "class" => (SymbolKind::Class, parts[1]),
                    "struct" => (SymbolKind::Struct, parts[1]),
                    "interface" => (SymbolKind::Interface, parts[1]),
                    "enum" => (SymbolKind::Enum, parts[1]),
                    "const" => (SymbolKind::Constant, parts[1]),
                    "type" => (SymbolKind::TypeAlias, parts[1]),
                    _ => {
                        if parts.len() >= 3 && parts[1] == "fn" {
                            (SymbolKind::Function, parts[2])
                        } else {
                            continue;
                        }
                    }
                };

                let name = name_raw
                    .split('(')
                    .next()
                    .unwrap_or(name_raw)
                    .split('<')
                    .next()
                    .unwrap_or(name_raw)
                    .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_')
                    .to_string();

                if !name.is_empty() {
                    let sym_id = format!("{path}:{line_num}:{name}");
                    let kind_str = match kind {
                        SymbolKind::Function => "function",
                        SymbolKind::Class => "class",
                        SymbolKind::Struct => "struct",
                        SymbolKind::Interface => "interface",
                        SymbolKind::Enum => "enum",
                        SymbolKind::Constant => "constant",
                        SymbolKind::TypeAlias => "type",
                        SymbolKind::Module => "module",
                        SymbolKind::Method => "method",
                        SymbolKind::Field => "field",
                        SymbolKind::Variable => "variable",
                        SymbolKind::Namespace => "namespace",
                    };

                    conn.execute(
                        "INSERT INTO symbols (id, name, kind, path, start_line, start_column, end_line, end_column, signature, content_hash)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![
                            sym_id,
                            name,
                            kind_str,
                            path,
                            line_num,
                            1,
                            line_num,
                            line.len() as u32,
                            trimmed,
                            hash_str
                        ],
                    )?;

                    if kind == SymbolKind::Function {
                        current_function = Some(name.clone());
                    }

                    // Register test ownership mapping if test file
                    if is_test_file {
                        conn.execute(
                            "INSERT INTO test_ownership (symbol_name, source_path, test_path, test_name) VALUES (?1, ?2, ?3, ?4)",
                            params![name, path, path, name],
                        )?;
                    }
                }
            }
        }

        Ok(())
    }

    fn lookup_symbol(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex lock failed: {e}")))?;

        let mut stmt = conn.prepare(
            "SELECT name, kind, path, start_line, start_column, end_line, end_column, signature
             FROM symbols WHERE name = ?1",
        )?;

        let rows = stmt.query_map(params![name], |row| {
            let name: String = row.get(0)?;
            let kind_str: String = row.get(1)?;
            let path: String = row.get(2)?;
            let start_line: u32 = row.get(3)?;
            let start_column: u32 = row.get(4)?;
            let end_line: u32 = row.get(5)?;
            let end_column: u32 = row.get(6)?;
            let signature: String = row.get(7)?;

            let kind = match kind_str.as_str() {
                "function" => SymbolKind::Function,
                "class" => SymbolKind::Class,
                "struct" => SymbolKind::Struct,
                "interface" => SymbolKind::Interface,
                "enum" => SymbolKind::Enum,
                "constant" => SymbolKind::Constant,
                "type" => SymbolKind::TypeAlias,
                "method" => SymbolKind::Method,
                "field" => SymbolKind::Field,
                _ => SymbolKind::Module,
            };

            let mut sym = Symbol::new(name, kind, path);
            sym.start_line = start_line;
            sym.start_column = start_column;
            sym.end_line = end_line;
            sym.end_column = end_column;
            sym.signature = signature;
            Ok(sym)
        })?;

        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    fn references(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError> {
        self.lookup_symbol(name)
    }

    fn supported_languages(&self) -> Vec<String> {
        vec![
            "rust".to_string(),
            "typescript".to_string(),
            "python".to_string(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persistent_index_freshness_and_queries() {
        let index = PersistentSymbolIndex::in_memory().unwrap();
        let code =
            "fn login_user(username: &str) {\n    validate_auth();\n}\n\nfn validate_auth() {}\n";

        index.index_file("src/auth.rs", code).unwrap();
        assert!(index
            .is_fresh(
                "src/auth.rs",
                &format!("{:x}", Sha256::digest(code.as_bytes()))
            )
            .unwrap());

        let syms = index.lookup_symbol("login_user").unwrap();
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "login_user");
        assert_eq!(syms[0].start_line, 1);

        let calls = index.call_hierarchy("validate_auth").unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].caller, "login_user");
        assert_eq!(calls[0].direction, "incoming");
    }

    #[test]
    fn test_ownership_and_imports() {
        let index = PersistentSymbolIndex::in_memory().unwrap();
        let test_code = "import { login } from './auth';\nfn test_login() {}\n";
        index.index_file("tests/auth.test.ts", test_code).unwrap();

        let imports = index.import_graph("tests/auth.test.ts").unwrap();
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].target_path, "./auth");

        let ownership = index.get_test_ownership("tests/auth.test.ts").unwrap();
        assert_eq!(ownership.len(), 1);
        assert_eq!(ownership[0].symbol_name, "test_login");
    }
}
