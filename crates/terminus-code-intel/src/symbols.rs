use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Interface,
    Module,
    Variable,
    Constant,
    TypeAlias,
    Namespace,
    Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub signature: String,
}

impl Symbol {
    pub fn new(name: impl Into<String>, kind: SymbolKind, path: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            kind,
            path: path.into(),
            start_line: 0,
            start_column: 0,
            end_line: 0,
            end_column: 0,
            signature: String::new(),
        }
    }
}
