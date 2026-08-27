use crate::error::CodeIntelError;
use crate::index::{RepositoryMapPage, SymbolIndex};
use crate::symbols::Symbol;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
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

/// Minimal semantic source adapter. The kernel supplies the authorized
/// workspace source; the index never invents files or falls back to a fake
/// symbol/location.
pub trait WorkspaceSource: Send + Sync {
    fn list_files(&self) -> Result<Vec<String>, CodeIntelError>;
    fn read_file(&self, path: &str) -> Result<Vec<u8>, CodeIntelError>;
}

// These trees are dependency, build, cache, or alternate-checkout material,
// not primary workspace source. Walking them makes a normal monorepo hit the
// bounded indexing limit before semantic retrieval can run.
const SKIPPED_WORKSPACE_DIRS: &[&str] = &[
    ".cache",
    ".hypothesis",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".worktrees",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "python",
    "vendor",
    "venv",
];
const MAX_INDEXABLE_FILE_BYTES: u64 = 1_048_576;
const INDEXABLE_SOURCE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "go", "h", "hpp", "java", "js", "jsx", "kt", "mjs", "php", "py", "rb",
    "rs", "sql", "swift", "ts", "tsx", "vue", "svelte",
];

/// Safe local source adapter used by the kernel's local workspace backend.
/// Paths remain workspace-relative and protected directories are excluded.
#[derive(Debug, Clone)]
pub struct FileSystemWorkspaceSource {
    root: PathBuf,
    excluded_top_level_dirs: BTreeSet<String>,
}

impl FileSystemWorkspaceSource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            excluded_top_level_dirs: BTreeSet::new(),
        }
    }

    /// Build a source over the kernel data root. Kernel-owned storage is not
    /// workspace source and may contain binary or secret-adjacent files.
    pub fn for_kernel_data_dir(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            excluded_top_level_dirs: BTreeSet::from_iter([
                "artifacts".to_string(),
                "egress-brokers".to_string(),
                "journal".to_string(),
                "patch-state".to_string(),
                "state".to_string(),
            ]),
        }
    }

    fn resolve(&self, path: &str) -> Result<PathBuf, CodeIntelError> {
        let relative = Path::new(path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(CodeIntelError::LanguageNotIndexed(format!(
                "unsafe workspace-relative path: {path}"
            )));
        }
        let root = self.root.canonicalize()?;
        let resolved = root.join(relative);
        let metadata = std::fs::symlink_metadata(&resolved)?;
        if metadata.file_type().is_symlink() {
            return Err(CodeIntelError::LanguageNotIndexed(format!(
                "symlink workspace path is not allowed: {path}"
            )));
        }
        let canonical = resolved.canonicalize()?;
        if !canonical.starts_with(&root) {
            return Err(CodeIntelError::LanguageNotIndexed(format!(
                "workspace path escapes root: {path}"
            )));
        }
        Ok(canonical)
    }
}

impl WorkspaceSource for FileSystemWorkspaceSource {
    fn list_files(&self) -> Result<Vec<String>, CodeIntelError> {
        let mut files = Vec::new();
        collect_files(
            &self.root,
            &self.root,
            &self.excluded_top_level_dirs,
            &mut files,
        )?;
        files.sort();
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>, CodeIntelError> {
        let resolved = self.resolve(path)?;
        Ok(std::fs::read(resolved)?)
    }
}

fn collect_files(
    root: &Path,
    directory: &Path,
    excluded_top_level_dirs: &BTreeSet<String>,
    files: &mut Vec<String>,
) -> Result<(), CodeIntelError> {
    if files.len() >= 10_000 {
        return Err(CodeIntelError::LanguageNotIndexed(
            "workspace code-intelligence file limit exceeded".to_string(),
        ));
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git"
            || name == "node_modules"
            || name == "target"
            || name == ".terminus-data"
            || name == "capability.token"
            || name.starts_with("code-intel.sqlite")
            || (file_type.is_dir() && SKIPPED_WORKSPACE_DIRS.contains(&name.as_ref()))
        {
            continue;
        }
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| CodeIntelError::LanguageNotIndexed(error.to_string()))?;
        if relative.components().count() == 1
            && file_type.is_dir()
            && excluded_top_level_dirs.contains(name.as_ref())
        {
            continue;
        }
        if file_type.is_dir() {
            collect_files(root, &path, excluded_top_level_dirs, files)?;
        } else if file_type.is_file() {
            // Large generated documents and bundled assets are not useful
            // symbol sources and can otherwise dominate the bounded refresh.
            if entry.metadata()?.len() <= MAX_INDEXABLE_FILE_BYTES
                && is_indexable_source_path(&path)
            {
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

fn is_indexable_source_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            INDEXABLE_SOURCE_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

/// The high-level inspect service. LSP/compiler/test details are normalized
/// into this bounded semantic surface.
#[derive(Clone)]
pub struct CodeIntelService {
    index: Arc<dyn SymbolIndex>,
    source: Option<Arc<dyn WorkspaceSource>>,
}

impl std::fmt::Debug for CodeIntelService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodeIntelService")
            .field("supported_languages", &self.index.supported_languages())
            .field("has_workspace_source", &self.source.is_some())
            .finish()
    }
}

impl CodeIntelService {
    pub fn new(index: Arc<dyn SymbolIndex>) -> Self {
        Self {
            index,
            source: None,
        }
    }

    pub fn with_source(index: Arc<dyn SymbolIndex>, source: Arc<dyn WorkspaceSource>) -> Self {
        Self {
            index,
            source: Some(source),
        }
    }

    pub fn inspect_symbol(&self, name: &str) -> Result<InspectResult, CodeIntelError> {
        self.refresh_index()?;
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
        self.refresh_index()?;
        let refs = self.index.references(name)?;
        Ok(ReferenceResult {
            references: refs,
            message: "ok".to_string(),
        })
    }

    pub fn diagnose_files(&self, paths: &[String]) -> Result<Vec<DiagnoseResult>, CodeIntelError> {
        let source = self.source.as_ref().ok_or_else(|| {
            CodeIntelError::LanguageNotIndexed(
                "diagnostics require an authorized workspace source".to_string(),
            )
        })?;
        let mut results = Vec::new();
        for path in paths {
            let bytes = source.read_file(path)?;
            let mut diagnostics = Vec::new();
            match std::str::from_utf8(&bytes) {
                Ok(content) => diagnostics.extend(syntax_diagnostics(path, content)),
                Err(_) => diagnostics.push(diagnostic(
                    path,
                    "utf8_invalid",
                    "File is not valid UTF-8",
                    1,
                )),
            }
            let count = diagnostics.len();
            results.push(DiagnoseResult {
                path: path.clone(),
                diagnostics,
                message: format!("Checked {path} (found {count} diagnostics)"),
            });
        }
        Ok(results)
    }

    pub fn workspace_diff(&self, paths: &[String]) -> Result<WorkspaceDiff, CodeIntelError> {
        let source = self.source.as_ref().ok_or_else(|| {
            CodeIntelError::LanguageNotIndexed(
                "workspace diff requires an authorized workspace source".to_string(),
            )
        })?;
        let candidates = if paths.is_empty() {
            let mut candidates = BTreeSet::from_iter(source.list_files()?);
            candidates.extend(self.index.indexed_paths()?);
            candidates.into_iter().collect::<Vec<_>>()
        } else {
            paths.to_vec()
        };
        let mut diff = WorkspaceDiff {
            modified: Vec::new(),
            added: Vec::new(),
            removed: Vec::new(),
            message: String::new(),
        };
        for path in candidates {
            match source.read_file(&path) {
                Ok(bytes) => {
                    let current = format!("{:x}", Sha256::digest(&bytes));
                    match self.index.file_hash(&path)? {
                        None => diff.added.push(path),
                        Some(indexed) if indexed != current => diff.modified.push(path),
                        Some(_) => {}
                    }
                }
                Err(CodeIntelError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    if self.index.file_hash(&path)?.is_some() {
                        diff.removed.push(path);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        diff.message = format!(
            "Workspace status checked: {} modified, {} added, {} removed",
            diff.modified.len(),
            diff.added.len(),
            diff.removed.len()
        );
        Ok(diff)
    }

    pub fn supported_languages(&self) -> Vec<String> {
        self.index.supported_languages()
    }

    pub fn repository_map(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<RepositoryMapPage, CodeIntelError> {
        self.repository_map_filtered(limit, offset, |_| true)
    }

    /// Return a bounded repository map after applying a caller-owned path
    /// predicate. The complete index is materialized only inside the kernel;
    /// the predicate runs before pagination so scoped callers never observe
    /// paths, counts, or symbols outside their authorization.
    pub fn repository_map_filtered<F>(
        &self,
        limit: usize,
        offset: usize,
        allowed: F,
    ) -> Result<RepositoryMapPage, CodeIntelError>
    where
        F: Fn(&str) -> bool,
    {
        self.refresh_index()?;
        const MAX_COMPLETE_INDEX_ENTRIES: usize = 10_000;
        let complete = self.index.repository_map(MAX_COMPLETE_INDEX_ENTRIES, 0)?;
        if complete.next_offset.is_some() {
            return Err(CodeIntelError::LanguageNotIndexed(
                "repository map requires a complete bounded index".to_string(),
            ));
        }
        let filtered = complete
            .entries
            .into_iter()
            .filter(|entry| allowed(&entry.path))
            .collect::<Vec<_>>();
        let total_entries = filtered.len();
        let start = offset.min(total_entries);
        let end = start.saturating_add(limit.max(1)).min(total_entries);
        Ok(RepositoryMapPage {
            entries: filtered[start..end].to_vec(),
            index_revision: complete.index_revision,
            total_entries,
            next_offset: (end < total_entries).then_some(end),
        })
    }

    fn refresh_index(&self) -> Result<(), CodeIntelError> {
        let source = match &self.source {
            Some(source) => source,
            None => return Ok(()),
        };
        let current_paths = source.list_files()?;
        let current_set = current_paths.iter().cloned().collect::<BTreeSet<_>>();
        for path in current_paths {
            let bytes = source.read_file(&path)?;
            let content = match std::str::from_utf8(&bytes) {
                Ok(content) => content,
                Err(_) => {
                    // A workspace can contain SQLite databases, images, and
                    // other binary files. They are valid workspace inputs but
                    // not semantic source. Remove any stale index entry and
                    // continue indexing the remaining source files.
                    if self.index.file_hash(&path)?.is_some() {
                        self.index.remove_file(&path)?;
                    }
                    continue;
                }
            };
            let hash = format!("{:x}", Sha256::digest(&bytes));
            if self.index.file_hash(&path)?.as_deref() != Some(hash.as_str()) {
                self.index.index_file(&path, content)?;
            }
        }
        for path in self.index.indexed_paths()? {
            if !current_set.contains(&path) {
                self.index.remove_file(&path)?;
            }
        }
        Ok(())
    }
}

fn syntax_diagnostics(path: &str, content: &str) -> Vec<terminus_kernel_protocol::Diagnostic> {
    let mut depth = 0i32;
    let mut diagnostics = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        for character in line.chars() {
            match character {
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => {
                    depth -= 1;
                    if depth < 0 {
                        diagnostics.push(diagnostic(
                            path,
                            "unbalanced_delimiter",
                            "Closing delimiter has no matching opener",
                            (line_index + 1) as u32,
                        ));
                        depth = 0;
                    }
                }
                _ => {}
            }
        }
    }
    if depth != 0 {
        diagnostics.push(diagnostic(
            path,
            "unbalanced_delimiter",
            "File has an unmatched opening delimiter",
            content.lines().count().max(1) as u32,
        ));
    }
    diagnostics
}

fn diagnostic(
    path: &str,
    code: &str,
    message: &str,
    line: u32,
) -> terminus_kernel_protocol::Diagnostic {
    terminus_kernel_protocol::Diagnostic {
        path: terminus_kernel_protocol::WorkspacePath {
            workspace_id: String::new(),
            relative_path: path.to_string(),
        },
        start_line: line,
        start_column: 1,
        end_line: line,
        end_column: 1,
        severity: "error".to_string(),
        source: "terminus-code-intel".to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::InMemorySymbolIndex;
    use crate::symbols::SymbolKind;
    use std::fs;

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
    fn indexed_source_produces_real_diff_and_diagnostics() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("src");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("lib.ts"), "function run() {\n  return 1;\n}\n").unwrap();
        let index = Arc::new(InMemorySymbolIndex::new());
        let source = Arc::new(FileSystemWorkspaceSource::new(directory.path()));
        let svc = CodeIntelService::with_source(index, source);
        assert!(svc.inspect_symbol("run").unwrap().symbol.is_some());
        fs::write(path.join("lib.ts"), "function run() {\n  return 1;\n").unwrap();
        let diff = svc.workspace_diff(&["src/lib.ts".to_string()]).unwrap();
        assert_eq!(diff.modified, vec!["src/lib.ts"]);
        let diagnostics = svc.diagnose_files(&["src/lib.ts".to_string()]).unwrap();
        assert_eq!(diagnostics[0].diagnostics[0].code, "unbalanced_delimiter");

        fs::remove_file(path.join("lib.ts")).unwrap();
        let diff = svc.workspace_diff(&[]).unwrap();
        assert_eq!(diff.removed, vec!["src/lib.ts"]);
        assert!(svc.inspect_symbol("run").unwrap().symbol.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn read_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.ts"), "const secret = true;\n").unwrap();
        symlink(
            outside.path().join("secret.ts"),
            workspace.path().join("link.ts"),
        )
        .unwrap();

        let source = FileSystemWorkspaceSource::new(workspace.path());
        let result = source.read_file("link.ts");
        assert!(matches!(
            result,
            Err(CodeIntelError::LanguageNotIndexed(message))
                if message.contains("symlink")
        ));
    }

    #[test]
    fn workspace_listing_excludes_kernel_owned_artifacts() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("artifacts/sha256")).unwrap();
        fs::create_dir_all(workspace.path().join("journal")).unwrap();
        fs::write(
            workspace.path().join("artifacts/sha256/content"),
            [0, 1, 2, 3],
        )
        .unwrap();
        fs::write(workspace.path().join("journal/entry.json"), [4, 5, 6]).unwrap();
        fs::write(workspace.path().join("code-intel.sqlite"), [0, 1, 2, 3]).unwrap();
        fs::write(workspace.path().join("code-intel.sqlite-wal"), [4, 5, 6]).unwrap();
        fs::write(workspace.path().join("capability.token"), "secret-token").unwrap();
        fs::write(workspace.path().join("main.rs"), "fn main() {}\n").unwrap();

        let source = FileSystemWorkspaceSource::for_kernel_data_dir(workspace.path());
        assert_eq!(source.list_files().unwrap(), vec!["main.rs"]);
    }

    #[test]
    fn workspace_listing_excludes_dependency_and_generated_trees() {
        let workspace = tempfile::tempdir().unwrap();
        for directory in [".worktrees", "vendor", "python", ".next", "dist"] {
            fs::create_dir_all(workspace.path().join(directory)).unwrap();
            fs::write(
                workspace.path().join(directory).join("ignored.ts"),
                "function ignored() {}\n",
            )
            .unwrap();
        }
        fs::write(workspace.path().join("main.ts"), "function indexed() {}\n").unwrap();

        let source = FileSystemWorkspaceSource::new(workspace.path());
        assert_eq!(source.list_files().unwrap(), vec!["main.ts"]);
    }

    #[test]
    fn workspace_listing_excludes_oversized_files() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("large.html"), vec![b'x'; 1_048_577]).unwrap();
        fs::write(workspace.path().join("small.ts"), "function indexed() {}\n").unwrap();

        let source = FileSystemWorkspaceSource::new(workspace.path());
        assert_eq!(source.list_files().unwrap(), vec!["small.ts"]);
    }

    #[test]
    fn workspace_listing_excludes_non_source_documents_and_assets() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(
            workspace.path().join("README.md"),
            "function not_indexed() {}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("package.json"),
            "{\"name\":\"fixture\"}\n",
        )
        .unwrap();
        fs::write(workspace.path().join("main.ts"), "function indexed() {}\n").unwrap();

        let source = FileSystemWorkspaceSource::new(workspace.path());
        assert_eq!(source.list_files().unwrap(), vec!["main.ts"]);
    }

    #[test]
    fn binary_workspace_files_do_not_block_source_indexing() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("database.sqlite"), [0, 159, 146, 255]).unwrap();
        fs::write(workspace.path().join("main.rs"), "fn indexed() {}\n").unwrap();

        let index = Arc::new(InMemorySymbolIndex::new());
        let source = Arc::new(FileSystemWorkspaceSource::new(workspace.path()));
        let service = CodeIntelService::with_source(index, source);

        let result = service.inspect_symbol("indexed").unwrap();
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
