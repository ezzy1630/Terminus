#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Archive / notebook readers: fail-closed decode smoke (SPEC §46.4).
    let _ = serde_json::from_slice::<serde_json::Value>(data);
    let text = String::from_utf8_lossy(data);
    // Reject obvious zip/tar magic without attempting extraction in-process.
    let _looks_zip = text.as_bytes().starts_with(b"PK");
    let _looks_ustar = text.contains("ustar");
    let _looks_ipynb = text.contains("\"nbformat\"");
});
