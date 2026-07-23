#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Public JSON decoder smoke for wire-shaped payloads (SPEC §45).
    let _ = serde_json::from_slice::<serde_json::Value>(data);
});
