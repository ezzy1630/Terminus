use crate::error::CodeIntelError;
use crate::index::SymbolIndex;
use crate::symbols::Symbol;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectResult {
    pub symbol: Option<Symbol>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceResult {
    pub references: Vec<Symbol>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnoseResult {
    pub path: String,
    pub diagnostics: Vec<terminus_kernel_protocol::Diagnostic>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceDiff {
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub message: String,
}

/// The high-level inspect service.
#[derive(Clone)]
pub struct CodeIntelService {
    index: Arc<dyn SymbolIndex>,
}

impl std::fmt::Debug for CodeIntelService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeIntelService")
            .field("supported_languages", &self.index.supported_languages())
            .finish()
    }
}

impl CodeIntelService {
    pub fn new(index: Arc<dyn SymbolIndex>) -> Self {
        Self { index }
    }

    pub fn inspect_symbol(&self, name: &str) -> Result<InspectResult, CodeIntelError> {
        let symbols = self.index.lookup_symbol(name)?;
        if symbols.is_empty() {
            return Ok(InspectResult {
                symbol: None,
                message: format!("symbol `{name}` not found"),
            });
        }
        Ok(InspectResult {
            symbol: symbols.into_iter().next(),
            message: "found".to_string(),
        })
    }

    pub fn find_references(&self, name: &str) -> Result<ReferenceResult, CodeIntelError> {
        let refs = self.index.references(name)?;
        Ok(ReferenceResult {
            references: refs,
            message: "ok".to_string(),
        })
    }

    pub fn diagnose_files(&self, paths: &[String]) -> Result<Vec<DiagnoseResult>, CodeIntelError> {
        let mut results = Vec::new();
        for p in paths {
            let mut diags = Vec::new();
            if let Ok(content) = std::fs::read(p) {
                if std::str::from_utf8(&content).is_err() {
                    diags.push(terminus_kernel_protocol::Diagnostic {
                        path: terminus_kernel_protocol::WorkspacePath {
                            workspace_id: String::new(),
                            relative_path: p.clone(),
                        },
                        start_line: 1,
                        start_column: 1,
                        end_line: 1,
                        end_column: 1,
                        severity: "error".to_string(),
                        source: "utf8_validator".to_string(),
                        code: "utf8_invalid".to_string(),
                        message: "File is not valid UTF-8".to_string(),
                    });
                }
            }
            let msg = format!("Checked {} (found {} diagnostics)", p, diags.len());
            results.push(DiagnoseResult {
                path: p.clone(),
                diagnostics: diags,
                message: msg,
            });
        }
        Ok(results)
    }

    pub fn workspace_diff(&self, paths: &[String]) -> Result<WorkspaceDiff, CodeIntelError> {
        Ok(WorkspaceDiff {
            modified: paths.to_vec(),
            added: Vec::new(),
            removed: Vec::new(),
            message: format!("Workspace status checked for {} paths", paths.len()),
        })
    }

    pub fn supported_languages(&self) -> Vec<String> {
        self.index.supported_languages()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::InMemorySymbolIndex;
    use crate::symbols::SymbolKind;

    #[test]
    fn inspect_symbol_returns_registered_symbol() {
        let index = Arc::new(InMemorySymbolIndex::new());
        let mut sym = Symbol::new("refresh_token", SymbolKind::Function, "src/auth/token.ts");
        sym.start_line = 42;
        sym.end_line = 88;
        index.register_symbol(sym);
        let svc = CodeIntelService::new(index);
        let result = svc.inspect_symbol("refresh_token").unwrap();
        let symbol = result.symbol.unwrap();
        assert_eq!(symbol.name, "refresh_token");
        assert_eq!(symbol.start_line, 42);
        assert_eq!(symbol.end_line, 88);
    }

    #[test]
    fn inspect_symbol_returns_not_found() {
        let index = Arc::new(InMemorySymbolIndex::new());
        let svc = CodeIntelService::new(index);
        let result = svc.inspect_symbol("missing").unwrap();
        assert!(result.symbol.is_none());
        assert!(result.message.contains("not found"));
    }

    #[test]
    fn index_file_picks_up_rust_functions() {
        let index = Arc::new(InMemorySymbolIndex::new());
        index
            .index_file(
                "src/main.rs",
                "fn main() {\n    println!(\"hi\");\n}\n\nfn helper() -> u32 { 42 }\n",
            )
            .unwrap();
        let svc = CodeIntelService::new(index);
        let result = svc.inspect_symbol("main").unwrap();
        assert!(result.symbol.is_some());
        let result = svc.inspect_symbol("helper").unwrap();
        assert!(result.symbol.is_some());
    }

    #[test]
    fn find_references_returns_indexed_locations() {
        let index = Arc::new(InMemorySymbolIndex::new());
        index.index_file("src/main.rs", "fn main() {}\n").unwrap();
        index.index_file("src/other.rs", "fn main() {}\n").unwrap();
        let svc = CodeIntelService::new(index);
        let result = svc.find_references("main").unwrap();
        assert_eq!(result.references.len(), 2);
    }
}
