#![no_main]

use libfuzzer_sys::fuzz_target;
use terminus_policy::PolicyEngine;

fuzz_target!(|data: &[u8]| {
    let yaml = String::from_utf8_lossy(data);
    // Invalid YAML / rule shapes return PolicyError; never panic.
    let _ = PolicyEngine::from_yaml(&yaml);
});
