//! Single-tenant resource quotas and admission (SPEC §47.10 / §48.14).

use crate::error::RemoteError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Named resource counters enforced before admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaResource {
    ConcurrentTasks,
    CpuMilliseconds,
    MemoryBytes,
    ArtifactBytes,
    NetworkBytes,
}

impl QuotaResource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ConcurrentTasks => "concurrent_tasks",
            Self::CpuMilliseconds => "cpu_milliseconds",
            Self::MemoryBytes => "memory_bytes",
            Self::ArtifactBytes => "artifact_bytes",
            Self::NetworkBytes => "network_bytes",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuotaLimits {
    pub limits: HashMap<QuotaResource, u64>,
}

impl QuotaLimits {
    pub fn single_tenant_defaults() -> Self {
        let mut limits = HashMap::new();
        limits.insert(QuotaResource::ConcurrentTasks, 32);
        limits.insert(QuotaResource::CpuMilliseconds, 3_600_000);
        limits.insert(QuotaResource::MemoryBytes, 8 * 1024 * 1024 * 1024);
        limits.insert(QuotaResource::ArtifactBytes, 32 * 1024 * 1024 * 1024);
        limits.insert(QuotaResource::NetworkBytes, 64 * 1024 * 1024 * 1024);
        Self { limits }
    }
}

/// Tracks usage against limits. Fail-closed on exceed.
#[derive(Debug, Clone)]
pub struct QuotaLedger {
    limits: QuotaLimits,
    used: HashMap<QuotaResource, u64>,
}

impl QuotaLedger {
    pub fn new(limits: QuotaLimits) -> Self {
        Self {
            limits,
            used: HashMap::new(),
        }
    }

    pub fn used(&self, resource: QuotaResource) -> u64 {
        self.used.get(&resource).copied().unwrap_or(0)
    }

    pub fn admit(&mut self, resource: QuotaResource, amount: u64) -> Result<(), RemoteError> {
        let limit =
            *self
                .limits
                .limits
                .get(&resource)
                .ok_or_else(|| RemoteError::QuotaExceeded {
                    resource: resource.as_str().to_string(),
                    used: 0,
                    limit: 0,
                })?;
        let current = self.used(resource);
        let next = current.saturating_add(amount);
        if next > limit {
            return Err(RemoteError::QuotaExceeded {
                resource: resource.as_str().to_string(),
                used: current,
                limit,
            });
        }
        self.used.insert(resource, next);
        Ok(())
    }

    pub fn release(&mut self, resource: QuotaResource, amount: u64) {
        let current = self.used(resource);
        self.used.insert(resource, current.saturating_sub(amount));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_until_limit() {
        let mut limits = HashMap::new();
        limits.insert(QuotaResource::ConcurrentTasks, 2);
        let mut ledger = QuotaLedger::new(QuotaLimits { limits });
        ledger.admit(QuotaResource::ConcurrentTasks, 1).expect("1");
        ledger.admit(QuotaResource::ConcurrentTasks, 1).expect("2");
        assert!(ledger.admit(QuotaResource::ConcurrentTasks, 1).is_err());
        ledger.release(QuotaResource::ConcurrentTasks, 1);
        ledger
            .admit(QuotaResource::ConcurrentTasks, 1)
            .expect("after release");
    }
}
