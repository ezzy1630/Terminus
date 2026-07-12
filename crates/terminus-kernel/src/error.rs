use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelAssemblyError {
    #[error("kernel misconfigured: {0}")]
    Misconfigured(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(#[from] forge_fs::PathError),
    #[error("artifact error: {0}")]
    Artifact(#[from] forge_artifacts::ArtifactError),
    #[error("sandbox error: {0}")]
    Sandbox(#[from] forge_sandbox::SandboxError),
    #[error("patch error: {0}")]
    Patch(#[from] forge_patch::PatchError),
}
