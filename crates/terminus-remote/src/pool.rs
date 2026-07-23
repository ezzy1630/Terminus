//! Container / micro-VM pool with digest-pinned images.

use crate::error::RemoteError;
use crate::image_pin::PinnedImage;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

/// A leased execution slot from the pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PoolLease {
    pub lease_id: String,
    pub slot_id: String,
    pub image: PinnedImage,
    pub workspace_id: String,
    pub leased_at_unix: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Slot {
    id: String,
    image: PinnedImage,
    busy: bool,
}

/// In-memory pool. Production deployments swap persistence; semantics stay.
#[derive(Debug, Default)]
pub struct ExecutionPool {
    slots: HashMap<String, Slot>,
    free: VecDeque<String>,
    leases: HashMap<String, PoolLease>,
    max_slots: usize,
}

impl ExecutionPool {
    pub fn new(max_slots: usize) -> Self {
        Self {
            slots: HashMap::new(),
            free: VecDeque::new(),
            leases: HashMap::new(),
            max_slots: max_slots.max(1),
        }
    }

    pub fn register_slot(
        &mut self,
        slot_id: impl Into<String>,
        image: PinnedImage,
    ) -> Result<(), RemoteError> {
        image.validate()?;
        if self.slots.len() >= self.max_slots {
            return Err(RemoteError::PoolExhausted(
                "cannot register more slots than max_slots".into(),
            ));
        }
        let id = slot_id.into();
        if self.slots.contains_key(&id) {
            return Err(RemoteError::PoolExhausted(format!(
                "slot already registered: {id}"
            )));
        }
        self.slots.insert(
            id.clone(),
            Slot {
                id: id.clone(),
                image,
                busy: false,
            },
        );
        self.free.push_back(id);
        Ok(())
    }

    pub fn lease(
        &mut self,
        workspace_id: impl Into<String>,
        required_image: &PinnedImage,
    ) -> Result<PoolLease, RemoteError> {
        required_image.validate()?;
        let workspace_id = workspace_id.into();
        let slot_id = self
            .free
            .iter()
            .find(|id| {
                self.slots
                    .get(*id)
                    .is_some_and(|s| !s.busy && &s.image == required_image)
            })
            .cloned()
            .ok_or_else(|| {
                RemoteError::PoolExhausted(format!(
                    "no free slot for image {}",
                    required_image.reference()
                ))
            })?;
        self.free.retain(|id| id != &slot_id);
        let slot = self
            .slots
            .get_mut(&slot_id)
            .ok_or_else(|| RemoteError::UnknownLease(slot_id.clone()))?;
        slot.busy = true;
        let lease = PoolLease {
            lease_id: format!("lease-{}", next_id()),
            slot_id: slot_id.clone(),
            image: slot.image.clone(),
            workspace_id,
            leased_at_unix: now_unix(),
        };
        self.leases.insert(lease.lease_id.clone(), lease.clone());
        Ok(lease)
    }

    pub fn release(&mut self, lease_id: &str) -> Result<(), RemoteError> {
        let lease = self
            .leases
            .remove(lease_id)
            .ok_or_else(|| RemoteError::UnknownLease(lease_id.to_string()))?;
        if let Some(slot) = self.slots.get_mut(&lease.slot_id) {
            slot.busy = false;
            self.free.push_back(slot.id.clone());
        }
        Ok(())
    }

    pub fn active_leases(&self) -> usize {
        self.leases.len()
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn next_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img() -> PinnedImage {
        PinnedImage {
            repository: "alpine".into(),
            digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                .into(),
        }
    }

    #[test]
    fn lease_and_release() {
        let mut pool = ExecutionPool::new(2);
        pool.register_slot("s1", img()).expect("reg");
        let lease = pool.lease("ws1", &img()).expect("lease");
        assert_eq!(pool.active_leases(), 1);
        assert!(pool.lease("ws2", &img()).is_err());
        pool.release(&lease.lease_id).expect("release");
        assert_eq!(pool.active_leases(), 0);
        pool.lease("ws2", &img()).expect("re-lease");
    }
}
