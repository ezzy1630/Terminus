//! Generated gRPC-over-UDS transport for the privileged kernel boundary.

#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]

use std::path::PathBuf;
use tonic::{transport::Server, Request, Response, Status};

pub mod protocol {
    tonic::include_proto!("terminus.kernel.v1");
}

use protocol::kernel_info_service_server::{
    KernelInfoService as KernelInfoServiceRpc, KernelInfoServiceServer,
};
use protocol::{KernelHealth, KernelInfo};

#[derive(Clone)]
pub struct KernelInfoGrpc {
    info: terminus_kernel::KernelInfoService,
}

impl KernelInfoGrpc {
    pub fn new(info: terminus_kernel::KernelInfoService) -> Self {
        Self { info }
    }
}

#[tonic::async_trait]
impl KernelInfoServiceRpc for KernelInfoGrpc {
    async fn get_info(&self, _request: Request<()>) -> Result<Response<KernelInfo>, Status> {
        let value = self.info.info();
        let supported_backends = strings(&value, "supported_backends");
        let supported_services = strings(&value, "services");
        Ok(Response::new(KernelInfo {
            version: string(&value, "version", ""),
            protocol_version: "terminus.kernel.v1".to_string(),
            build_revision: string(&value, "build_revision", "dev"),
            supported_backends,
            supported_services,
        }))
    }

    async fn health(&self, _request: Request<()>) -> Result<Response<KernelHealth>, Status> {
        let value = self.info.health();
        Ok(Response::new(KernelHealth {
            state: string(&value, "status", "ok"),
            degradations: Vec::new(),
            checked_at: Some(prost_types::Timestamp::from(std::time::SystemTime::now())),
        }))
    }
}

fn string(value: &serde_json::Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Serve the canonical Protobuf API over a filesystem-restricted Unix socket.
pub async fn serve_grpc(
    socket_path: PathBuf,
    info: terminus_kernel::KernelInfoService,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = socket_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
        }
    }
    match tokio::fs::symlink_metadata(&socket_path).await {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::FileTypeExt;
                if !metadata.file_type().is_socket() {
                    return Err(format!("refusing to replace non-socket path {}", socket_path.display()).into());
                }
            }
            tokio::fs::remove_file(&socket_path).await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let listener = tokio::net::UnixListener::bind(&socket_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).await?;
    }

    tracing::info!(socket = %socket_path.display(), "kernel gRPC listening on UDS");
    Server::builder()
        .add_service(KernelInfoServiceServer::new(KernelInfoGrpc::new(info)))
        .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::kernel_info_service_client::KernelInfoServiceClient;
    use hyper_util::rt::TokioIo;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixStream;
    use tonic::transport::{Endpoint, Uri};
    use tower::service_fn;

    #[tokio::test]
    async fn generated_client_reaches_generated_server_over_restricted_uds() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let socket = dir.path().join("kernel.sock");
        let server_socket = socket.clone();
        let server = tokio::spawn(async move {
            serve_grpc(server_socket, terminus_kernel::KernelInfoService::new()).await
        });

        for _ in 0..100 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(socket.exists(), "server did not create the UDS");
        assert_eq!(
            std::fs::metadata(&socket)
                .expect("socket metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let connector_socket = socket.clone();
        let channel = Endpoint::try_from("http://[::]:50051")
            .expect("valid endpoint")
            .connect_with_connector(service_fn(move |_: Uri| {
                let socket = connector_socket.clone();
                async move { UnixStream::connect(socket).await.map(TokioIo::new) }
            }))
            .await
            .expect("connect over UDS");
        let response = KernelInfoServiceClient::new(channel)
            .get_info(())
            .await
            .expect("GetInfo succeeds")
            .into_inner();
        assert_eq!(response.protocol_version, "terminus.kernel.v1");

        server.abort();
        let _ = server.await;
    }
}
