#![no_main]

use libfuzzer_sys::fuzz_target;
use terminus_secrets::Redactor;

fuzz_target!(|data: &[u8]| {
    let mut redactor = Redactor::new();
    // Fixed pattern so every input exercises the replacement loop.
    redactor.add_literal("fuzz-secret", "SECRET");
    let (_out, _count) = redactor.redact(data);
});
