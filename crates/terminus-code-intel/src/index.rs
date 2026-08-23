use crate::error::CodeIntelError;
use crate::symbols::{Symbol, SymbolKind};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

/// The high-level symbol index trait.
pub trait SymbolIndex: Send + Sync {
    fn index_file(&self, path: &str, content: &str) -> Result<(), CodeIntelError>;
    fn lookup_symbol(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError>;
    fn references(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError>;
    /// Content hash of the last indexed snapshot for a path.
    fn file_hash(&self, path: &str) -> Result<Option<String>, CodeIntelError>;
    /// Paths represented by the indexed snapshot, including paths that may no
    /// longer exist in the workspace.
    fn indexed_paths(&self) -> Result<Vec<String>, CodeIntelError>;
    /// Remove every indexed observation belonging to a path.
    fn remove_file(&self, path: &str) -> Result<(), CodeIntelError>;
    fn supported_languages(&self) -> Vec<String>;
}

/// An in-memory index. Production deployments back this with tree-sitter
/// and an on-disk cache.
#[derive(Debug, Default)]
pub struct InMemorySymbolIndex {
    symbols: Mutex<HashMap<String, Vec<Symbol>>>,
    references: Mutex<HashMap<String, Vec<Symbol>>>,
    file_hashes: Mutex<HashMap<String, String>>,
}

impl InMemorySymbolIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convenience helper for tests: register a symbol manually.
    pub fn register_symbol(&self, symbol: Symbol) {
        let mut g = self
            .symbols
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))
            .ok();
        if let Some(ref mut g) = g {
            g.entry(symbol.name.clone())
                .or_default()
                .push(symbol.clone());
        }
        if let Ok(mut r) = self.references.lock() {
            r.entry(symbol.name.clone()).or_default().push(symbol);
        }
    }
}

impl SymbolIndex for InMemorySymbolIndex {
    fn index_file(&self, path: &str, content: &str) -> Result<(), CodeIntelError> {
        self.remove_file(path)?;

        // Tiny heuristic: scan for `fn <name>`, `function <name>`, `def <name>`,
        // `class <name>`, `struct <name>`, `interface <name>`, `enum <name>`.
        let mut found = Vec::new();
        for (lineno, line) in content.lines().enumerate() {
            let trimmed = line.trim_start();
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            let (kind, name) = match parts[0] {
                "fn" => (SymbolKind::Function, parts[1]),
                "function" => (SymbolKind::Function, parts[1]),
                "def" => (SymbolKind::Function, parts[1]),
                "class" => (SymbolKind::Class, parts[1]),
                "struct" => (SymbolKind::Struct, parts[1]),
                "interface" => (SymbolKind::Interface, parts[1]),
                "enum" => (SymbolKind::Enum, parts[1]),
                "const" => (SymbolKind::Constant, parts[1]),
                "type" => (SymbolKind::TypeAlias, parts[1]),
                _ => continue,
            };
            // Strip trailing punctuation.
            let name = name
                .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_')
                .to_string();
            if name.is_empty() {
                continue;
            }
            let mut sym = Symbol::new(name, kind, path);
            sym.start_line = (lineno as u32) + 1;
            sym.start_column = 1;
            sym.end_line = sym.start_line;
            sym.end_column = line.len() as u32;
            sym.signature = trimmed.to_string();
            found.push(sym);
        }
        if let Ok(mut g) = self.symbols.lock() {
            for sym in &found {
                g.entry(sym.name.clone()).or_default().push(sym.clone());
            }
        }
        if let Ok(mut r) = self.references.lock() {
            for sym in &found {
                r.entry(sym.name.clone()).or_default().push(sym.clone());
            }
        }
        if let Ok(mut hashes) = self.file_hashes.lock() {
            hashes.insert(
                path.to_string(),
                format!("{:x}", Sha256::digest(content.as_bytes())),
            );
        }
        Ok(())
    }

    fn lookup_symbol(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError> {
        let g = self
            .symbols
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        Ok(g.get(name).cloned().unwrap_or_default())
    }

    fn references(&self, name: &str) -> Result<Vec<Symbol>, CodeIntelError> {
        let g = self
            .references
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        Ok(g.get(name).cloned().unwrap_or_default())
    }

    fn file_hash(&self, path: &str) -> Result<Option<String>, CodeIntelError> {
        let hashes = self
            .file_hashes
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        Ok(hashes.get(path).cloned())
    }

    fn indexed_paths(&self) -> Result<Vec<String>, CodeIntelError> {
        let hashes = self
            .file_hashes
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        let mut paths = hashes.keys().cloned().collect::<Vec<_>>();
        paths.sort();
        Ok(paths)
    }

    fn remove_file(&self, path: &str) -> Result<(), CodeIntelError> {
        let mut hashes = self
            .file_hashes
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        hashes.remove(path);
        drop(hashes);

        let mut symbols = self
            .symbols
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        symbols.retain(|_, entries| {
            entries.retain(|symbol| symbol.path != path);
            !entries.is_empty()
        });
        drop(symbols);

        let mut references = self
            .references
            .lock()
            .map_err(|e| CodeIntelError::LanguageNotIndexed(format!("mutex: {e}")))?;
        references.retain(|_, entries| {
            entries.retain(|symbol| symbol.path != path);
            !entries.is_empty()
        });
        Ok(())
    }

    fn supported_languages(&self) -> Vec<String> {
        // The heuristic index handles any C-like syntax; production builds
        // dispatch per language.
        vec![
            "rust".to_string(),
            "typescript".to_string(),
            "python".to_string(),
        ]
    }
}
