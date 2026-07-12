use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationProfile {
    SyntaxOnly,
    SyntaxFormat,
    LanguageFast,
    PackageNarrow,
    #[default]
    TaskDefault,
    MigrationTransaction,
}

impl ValidationProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SyntaxOnly => "syntax_only",
            Self::SyntaxFormat => "syntax_format",
            Self::LanguageFast => "language_fast",
            Self::PackageNarrow => "package_narrow",
            Self::TaskDefault => "task_default",
            Self::MigrationTransaction => "migration_transaction",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationResult {
    pub check_id: String,
    pub status: ValidationStatus,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    Pass,
    Fail,
    Skipped,
}

/// Run a minimal line-count sanity check on the new content. This is the
/// fallback validator when no language-specific parser is available.
pub fn line_count_sanity(content: &[u8]) -> ValidationResult {
    let text = String::from_utf8_lossy(content);
    let line_count = text.lines().count();
    ValidationResult {
        check_id: "line_count".to_string(),
        status: ValidationStatus::Pass,
        summary: format!("{line_count} lines"),
    }
}

/// Detect obviously broken UTF-8 in source files. Returns a Fail if the
/// content is not valid UTF-8.
pub fn utf8_check(content: &[u8]) -> ValidationResult {
    if std::str::from_utf8(content).is_ok() {
        ValidationResult {
            check_id: "utf8".to_string(),
            status: ValidationStatus::Pass,
            summary: "valid UTF-8".to_string(),
        }
    } else {
        ValidationResult {
            check_id: "utf8".to_string(),
            status: ValidationStatus::Fail,
            summary: "content is not valid UTF-8".to_string(),
        }
    }
}

/// Detect unbalanced braces — a cheap proxy for syntax errors in C-like
/// languages. Returns `Skipped` for empty content.
pub fn brace_balance_check(content: &[u8]) -> ValidationResult {
    let text = String::from_utf8_lossy(content);
    if text.is_empty() {
        return ValidationResult {
            check_id: "brace_balance".to_string(),
            status: ValidationStatus::Skipped,
            summary: "empty file".to_string(),
        };
    }
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut escape = false;
    for ch in text.chars() {
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' {
            escape = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth < 0 {
            return ValidationResult {
                check_id: "brace_balance".to_string(),
                status: ValidationStatus::Fail,
                summary: "closing brace before opening brace".to_string(),
            };
        }
    }
    if depth != 0 {
        return ValidationResult {
            check_id: "brace_balance".to_string(),
            status: ValidationStatus::Fail,
            summary: format!("unbalanced braces (delta={depth})"),
        };
    }
    ValidationResult {
        check_id: "brace_balance".to_string(),
        status: ValidationStatus::Pass,
        summary: "balanced".to_string(),
    }
}
