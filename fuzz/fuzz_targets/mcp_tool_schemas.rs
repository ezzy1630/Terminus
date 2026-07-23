#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // MCP tool-schema JSON decode must never panic on adversarial bytes.
    let _ = serde_json::from_slice::<serde_json::Value>(data);
});
