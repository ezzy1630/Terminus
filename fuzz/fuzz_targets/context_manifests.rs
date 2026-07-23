#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Context-manifest JSON decode smoke (SPEC §32 / ADR-0010 shapes).
    let _ = serde_json::from_slice::<serde_json::Value>(data);
});
