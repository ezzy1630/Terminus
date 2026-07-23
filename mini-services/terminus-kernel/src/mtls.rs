//! mTLS material loading for remote kernel transport (SPEC §48.14).

use std::path::Path;

use terminus_remote::{Identity, MtlsMaterial};

/// Load mTLS material from environment for remote mode.
///
/// Required when `TERMINUS_KERNEL_MTLS=1`:
/// - `TERMINUS_KERNEL_MTLS_CERT`
/// - `TERMINUS_KERNEL_MTLS_KEY`
/// - `TERMINUS_KERNEL_MTLS_CLIENT_CA`
/// - `TERMINUS_KERNEL_EXPECTED_PEER` (`control:<id>` or `kernel:<id>`)
/// - optional `TERMINUS_KERNEL_PEER_FINGERPRINT` (`sha256:<hex>`)
pub fn mtls_material_from_env() -> Result<MtlsMaterial, Box<dyn std::error::Error + Send + Sync>> {
    let cert = std::env::var("TERMINUS_KERNEL_MTLS_CERT")
        .map_err(|_| "TERMINUS_KERNEL_MTLS_CERT required")?;
    let key =
        std::env::var("TERMINUS_KERNEL_MTLS_KEY").map_err(|_| "TERMINUS_KERNEL_MTLS_KEY required")?;
    let ca = std::env::var("TERMINUS_KERNEL_MTLS_CLIENT_CA")
        .map_err(|_| "TERMINUS_KERNEL_MTLS_CLIENT_CA required")?;
    let peer = std::env::var("TERMINUS_KERNEL_EXPECTED_PEER")
        .map_err(|_| "TERMINUS_KERNEL_EXPECTED_PEER required")?;
    let fingerprint = std::env::var("TERMINUS_KERNEL_PEER_FINGERPRINT").ok();
    let material = MtlsMaterial {
        cert_pem_path: Path::new(&cert).to_path_buf(),
        key_pem_path: Path::new(&key).to_path_buf(),
        client_ca_pem_path: Path::new(&ca).to_path_buf(),
        expected_peer: Identity::parse(&peer).map_err(|e| e.to_string())?,
        pinned_peer_fingerprint: fingerprint,
    };
    material.validate().map_err(|e| e.to_string())?;
    Ok(material)
}
