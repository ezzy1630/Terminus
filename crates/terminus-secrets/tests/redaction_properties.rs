//! Property tests for secret redaction (SPEC §46.3).
//!
//! Invariant: known secret literals never appear in redacted projections.

#![cfg(test)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use terminus_secrets::Redactor;

#[test]
fn secret_literals_never_survive_redaction() {
    let secrets = [
        "ghp_abcdefghijklmnopqrstuvwxyz012345",
        "AKIAIOSFODNN7EXAMPLE",
        "super-secret-value-42",
    ];
    let mut redactor = Redactor::new();
    for (i, secret) in secrets.iter().enumerate() {
        redactor.add_literal(format!("s{i}"), (*secret).to_string());
    }

    for seed in 0u64..128 {
        let mut body = format!("seed={seed} preamble ");
        for secret in &secrets {
            if seed % 3 == 0 {
                body.push_str(secret);
                body.push(' ');
            }
        }
        body.push_str(" trailer");
        let (out, _) = redactor.redact(body.as_bytes());
        let text = String::from_utf8_lossy(&out);
        for secret in &secrets {
            assert!(
                !text.contains(secret),
                "secret leaked in projection: {text}"
            );
        }
    }
}

#[test]
fn empty_pattern_is_ignored() {
    let mut redactor = Redactor::new();
    redactor.add_literal("empty", "");
    let (out, count) = redactor.redact(b"hello");
    assert_eq!(count, 0);
    assert_eq!(out, b"hello");
}
