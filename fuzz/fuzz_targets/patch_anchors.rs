#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    // InsertContent-like JSON decode smoke: accept/reject without panic.
    let _ = serde_json::from_slice::<serde_json::Value>(data);
});
