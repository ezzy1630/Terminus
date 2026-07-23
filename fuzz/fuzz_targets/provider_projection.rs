#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // Provider projection JSON decode smoke; fail closed, never panic.
    let _ = serde_json::from_slice::<serde_json::Value>(data);
});
