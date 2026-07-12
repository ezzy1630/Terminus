use terminus_kernel_protocol::{
    ArtifactRef, CommandSpec, EffectIntent, KernelError, KernelResult, PatchEdit, PatchResponse,
    ProcessEvent, RequestContext, WorkspaceBaseline, WorkspacePath,
};

/// A fake kernel for tests. Each method records its invocation and returns
/// a configurable response. Default responses are success-shaped.
#[derive(Debug, Default)]
pub struct FakeKernel {
    invocations: std::sync::Mutex<Vec<String>>,
}

impl FakeKernel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn invocations(&self) -> Vec<String> {
        match self.invocations.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }

    pub fn record(&self, name: &str) {
        if let Ok(mut g) = self.invocations.lock() {
            g.push(name.to_string());
        }
    }

    pub fn ingest(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        bytes: &[u8],
    ) -> KernelResult<ArtifactRef> {
        self.record("artifact.ingest");
        Ok(ArtifactRef::new(
            format!("sha256:fake-{}", bytes.len()),
            bytes.len() as u64,
            "application/octet-stream",
        ))
    }

    pub fn apply_patch(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        _transaction_id: &str,
        _baseline: &WorkspaceBaseline,
        edits: &[PatchEdit],
    ) -> KernelResult<PatchResponse> {
        self.record("patch.apply");
        Ok(PatchResponse {
            transaction_id: terminus_kernel_protocol::new_id(),
            state: "applied".to_string(),
            final_repository_revision: String::new(),
            final_dirty_digest: String::new(),
            changed_files: edits
                .iter()
                .map(|_| terminus_kernel_protocol::ChangedFile {
                    path: WorkspacePath::new("ws-1", "fake"),
                    old_sha256: String::new(),
                    new_sha256: String::new(),
                    operation: "fake".to_string(),
                })
                .collect(),
            validations: Vec::new(),
            complete_diff: None,
        })
    }

    pub fn start_process(
        &self,
        _ctx: &RequestContext,
        _intent: &EffectIntent,
        _command: CommandSpec,
    ) -> KernelResult<tokio::sync::mpsc::Receiver<ProcessEvent>> {
        self.record("process.start");
        let (_tx, rx) = tokio::sync::mpsc::channel(1);
        Ok(rx)
    }

    pub fn deny_everything(&self, _ctx: &RequestContext) -> KernelResult<()> {
        self.record("deny");
        Err(KernelError::new(
            terminus_kernel_protocol::ErrorCode::PolicyDenied,
            terminus_kernel_protocol::ErrorCategory::PolicyDenied,
            "fake kernel configured to deny",
            false,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builders::{EffectIntentBuilder, RequestContextBuilder};

    #[tokio::test]
    async fn fake_kernel_records_invocations() {
        let kernel = FakeKernel::new();
        let ctx = RequestContextBuilder::new().build();
        let intent = EffectIntentBuilder::new().trusted().build();
        let _ = kernel.ingest(&ctx, &intent, b"hi").unwrap();
        let _ = kernel.deny_everything(&ctx);
        let invs = kernel.invocations();
        assert_eq!(invs, vec!["artifact.ingest", "deny"]);
    }
}
