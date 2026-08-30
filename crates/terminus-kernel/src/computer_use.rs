//! Pure admission checks for the governed browser boundary (ADR-0041).
//!
//! This module intentionally performs no browser I/O. The current kernel has
//! no trusted isolated-browser adapter, so callers can validate requests and
//! still fail closed before an effect is attempted. Keeping these checks in
//! the kernel makes a future adapter unable to widen the action vocabulary or
//! destination policy by accident.

use std::fmt;

pub const MAX_BROWSER_SESSION_ID_BYTES: usize = 128;
pub const MAX_BROWSER_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_BROWSER_SCREENSHOT_BYTES: u64 = 16 * 1024 * 1024;
pub const MIN_BROWSER_VIEWPORT: u32 = 320;
pub const MAX_BROWSER_VIEWPORT: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserActionKind {
    Navigate,
    Click,
    TypeText,
    Scroll,
    Wait,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserValidationError {
    EmptySession,
    SessionTooLong,
    InvalidViewport,
    InvalidScreenshotLimit,
    UnsupportedAction,
    MissingObservation,
    MissingTarget,
    MissingNavigationUrl,
    UnexpectedNavigationUrl,
    InvalidNavigationUrl,
    PrivateOrLocalOrigin,
    TextTooLong,
    InvalidScroll,
    InvalidWait,
}

impl fmt::Display for BrowserValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptySession => "browser_session_id is required",
            Self::SessionTooLong => "browser_session_id exceeds the 128-byte limit",
            Self::InvalidViewport => "viewport must be between 320 and 4096 pixels",
            Self::InvalidScreenshotLimit => "max_screenshot_bytes must be between 1 and 16 MiB",
            Self::UnsupportedAction => "action is not in the governed browser allowlist",
            Self::MissingObservation => "actions require a non-empty observation id and version",
            Self::MissingTarget => "this action requires a semantic target id",
            Self::MissingNavigationUrl => "navigate requires an https navigation_url",
            Self::UnexpectedNavigationUrl => "navigation_url is only valid for navigate",
            Self::InvalidNavigationUrl => {
                "navigation_url must be an absolute https URL without credentials or fragments"
            }
            Self::PrivateOrLocalOrigin => {
                "private, loopback, localhost, and non-public origins are denied"
            }
            Self::TextTooLong => "text exceeds the 64 KiB limit",
            Self::InvalidScroll => "scroll values must be finite and bounded",
            Self::InvalidWait => "wait_ms must be between 1 and 30 seconds",
        };
        f.write_str(message)
    }
}

impl std::error::Error for BrowserValidationError {}

pub fn validate_observe_request(
    session_id: &str,
    viewport_width: u32,
    viewport_height: u32,
    max_screenshot_bytes: u64,
) -> Result<(), BrowserValidationError> {
    if session_id.is_empty() {
        return Err(BrowserValidationError::EmptySession);
    }
    if session_id.len() > MAX_BROWSER_SESSION_ID_BYTES || session_id.chars().any(char::is_control) {
        return Err(BrowserValidationError::SessionTooLong);
    }
    if !(MIN_BROWSER_VIEWPORT..=MAX_BROWSER_VIEWPORT).contains(&viewport_width)
        || !(MIN_BROWSER_VIEWPORT..=MAX_BROWSER_VIEWPORT).contains(&viewport_height)
    {
        return Err(BrowserValidationError::InvalidViewport);
    }
    if !(1..=MAX_BROWSER_SCREENSHOT_BYTES).contains(&max_screenshot_bytes) {
        return Err(BrowserValidationError::InvalidScreenshotLimit);
    }
    Ok(())
}

pub fn validate_action_request(
    session_id: &str,
    observation_id: &str,
    observation_version: u64,
    action: BrowserActionKind,
    target_id: &str,
    navigation_url: &str,
    text: &str,
    scroll_x: f64,
    scroll_y: f64,
    wait_ms: u64,
) -> Result<(), BrowserValidationError> {
    validate_observe_request(session_id, MIN_BROWSER_VIEWPORT, MIN_BROWSER_VIEWPORT, 1)?;
    if observation_id.is_empty() || observation_version == 0 {
        return Err(BrowserValidationError::MissingObservation);
    }
    match action {
        BrowserActionKind::Navigate => {
            if navigation_url.is_empty() {
                return Err(BrowserValidationError::MissingNavigationUrl);
            }
            validate_navigation_url(navigation_url)?;
        }
        BrowserActionKind::Click | BrowserActionKind::TypeText => {
            if target_id.is_empty() {
                return Err(BrowserValidationError::MissingTarget);
            }
            if !navigation_url.is_empty() {
                return Err(BrowserValidationError::UnexpectedNavigationUrl);
            }
            if action == BrowserActionKind::TypeText && text.len() > MAX_BROWSER_TEXT_BYTES {
                return Err(BrowserValidationError::TextTooLong);
            }
        }
        BrowserActionKind::Scroll => {
            if !navigation_url.is_empty() {
                return Err(BrowserValidationError::UnexpectedNavigationUrl);
            }
            if !scroll_x.is_finite()
                || !scroll_y.is_finite()
                || scroll_x.abs() > 100_000.0
                || scroll_y.abs() > 100_000.0
            {
                return Err(BrowserValidationError::InvalidScroll);
            }
        }
        BrowserActionKind::Wait => {
            if !navigation_url.is_empty() {
                return Err(BrowserValidationError::UnexpectedNavigationUrl);
            }
            if !(1..=30_000).contains(&wait_ms) {
                return Err(BrowserValidationError::InvalidWait);
            }
        }
    }
    Ok(())
}

fn validate_navigation_url(raw: &str) -> Result<(), BrowserValidationError> {
    let authority = raw
        .strip_prefix("https://")
        .filter(|rest| !rest.is_empty() && !rest.contains('#'))
        .ok_or(BrowserValidationError::InvalidNavigationUrl)?;
    let host_end = authority.find(['/', '?']).unwrap_or(authority.len());
    let authority = &authority[..host_end];
    if authority.is_empty() || authority.contains('@') || authority.contains(':') {
        return Err(BrowserValidationError::InvalidNavigationUrl);
    }
    let host = authority.to_ascii_lowercase();
    if host.chars().any(|character| {
        !(character.is_ascii_alphanumeric() || character == '-' || character == '.')
    }) || !host.contains('.')
        || host.starts_with('.')
        || host.ends_with('.')
        || host.starts_with('-')
        || host.ends_with('-')
        || host
            .split('.')
            .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
    {
        return Err(BrowserValidationError::InvalidNavigationUrl);
    }
    if host == "localhost"
        || host.ends_with(".localhost")
        || host == "0.0.0.0"
        || host == "::1"
        || host.ends_with(".local")
        || host
            .parse::<std::net::IpAddr>()
            .map(is_private_ip)
            .unwrap_or(false)
    {
        return Err(BrowserValidationError::PrivateOrLocalOrigin);
    }
    Ok(())
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
        }
        std::net::IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_and_non_https_origins() {
        for url in [
            "http://example.com",
            "https://localhost/",
            "https://127.0.0.1/",
            "https://10.0.0.8/",
            "file:///tmp/page.html",
            "https://user:secret@example.com/",
        ] {
            assert!(validate_navigation_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn accepts_public_https_origin_without_fragment() {
        assert!(validate_navigation_url("https://example.com/path?x=1").is_ok());
    }

    #[test]
    fn rejects_stale_or_unbound_actions_before_backend() {
        assert_eq!(
            validate_action_request(
                "session",
                "",
                1,
                BrowserActionKind::Click,
                "button",
                "",
                "",
                0.0,
                0.0,
                0
            ),
            Err(BrowserValidationError::MissingObservation)
        );
        assert_eq!(
            validate_action_request(
                "session",
                "observation",
                0,
                BrowserActionKind::Click,
                "button",
                "",
                "",
                0.0,
                0.0,
                0
            ),
            Err(BrowserValidationError::MissingObservation)
        );
    }

    #[test]
    fn only_semantic_click_and_bounded_text_are_admissible() {
        assert_eq!(
            validate_action_request(
                "session",
                "observation",
                1,
                BrowserActionKind::Click,
                "",
                "",
                "",
                0.0,
                0.0,
                0
            ),
            Err(BrowserValidationError::MissingTarget)
        );
        let text = "x".repeat(MAX_BROWSER_TEXT_BYTES + 1);
        assert_eq!(
            validate_action_request(
                "session",
                "observation",
                1,
                BrowserActionKind::TypeText,
                "input",
                "",
                &text,
                0.0,
                0.0,
                0
            ),
            Err(BrowserValidationError::TextTooLong)
        );
    }
}
