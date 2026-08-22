//! Unix-domain egress broker for `NetworkAccess::ProxyRequired` payloads.
//!
//! A sandboxed process reaches this broker over a private Unix socket. The
//! broker performs DNS resolution, applies the destination policy to every
//! returned address, opens the approved numeric socket itself, and relays
//! opaque bytes. It deliberately does not inspect or terminate TLS.

use crate::{EgressError, EgressProxy};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixListener, UnixStream};

const MAX_HANDSHAKE_BYTES: usize = 4 * 1024;
const RELAY_BUFFER_BYTES: usize = 16 * 1024;

/// First line sent by a sandboxed client before opaque TCP bytes flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressBrokerRequest {
    pub host: String,
    pub port: u16,
    pub scheme: String,
}

/// First line returned by the broker. An error response never exposes
/// resolved private addresses or credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressBrokerResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Kernel-owned Unix socket endpoint for one sandbox lease.
///
/// The listener accepts one connection at a time. Callers own the serving
/// task and must keep this value alive until the payload has exited; dropping
/// it removes the socket path.
#[derive(Debug)]
pub struct EgressBroker {
    listener: UnixListener,
    socket_path: PathBuf,
    proxy: Arc<EgressProxy>,
}

impl EgressBroker {
    /// Bind a private Unix socket. The parent directory must already be
    /// private to the kernel lease; the socket itself is set to mode 0600.
    pub fn bind(
        socket_path: impl AsRef<Path>,
        proxy: Arc<EgressProxy>,
    ) -> Result<Self, EgressError> {
        use std::os::unix::fs::PermissionsExt;

        let socket_path = socket_path.as_ref().to_path_buf();
        if socket_path.exists() {
            return Err(EgressError::Protocol(format!(
                "refusing to replace existing broker socket {}",
                socket_path.display()
            )));
        }
        let listener = UnixListener::bind(&socket_path)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            listener,
            socket_path,
            proxy,
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Accept and serve a single sandbox connection. A supervisor calls this
    /// repeatedly; keeping the accept loop outside the broker prevents a
    /// detached task from outliving the process lease.
    pub async fn serve_one(&self) -> Result<(), EgressError> {
        let (stream, _) = self.listener.accept().await?;
        serve_connection(stream, Arc::clone(&self.proxy)).await
    }
}

impl Drop for EgressBroker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

async fn serve_connection(stream: UnixStream, proxy: Arc<EgressProxy>) -> Result<(), EgressError> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut request_line = Vec::new();
    let read = reader.read_until(b'\n', &mut request_line).await?;
    if read == 0 || read > MAX_HANDSHAKE_BYTES || !request_line.ends_with(b"\n") {
        return write_error(&mut write_half, "invalid broker handshake").await;
    }
    let request: EgressBrokerRequest = serde_json::from_slice(&request_line)
        .map_err(|error| EgressError::Protocol(format!("decode broker request: {error}")))?;
    if request.host.is_empty() || request.port == 0 || request.scheme.is_empty() {
        return write_error(&mut write_half, "incomplete broker request").await;
    }

    let addresses = match tokio::net::lookup_host((request.host.as_str(), request.port)).await {
        Ok(addresses) => addresses.collect::<Vec<_>>(),
        Err(error) => {
            write_error(&mut write_half, "destination DNS resolution failed").await?;
            return Err(EgressError::Dns(error.to_string()));
        }
    };
    let resolved_ips = addresses
        .iter()
        .map(|address| address.ip())
        .collect::<Vec<_>>();
    if let Err(error) = proxy.authorize(&request.host, request.port, &request.scheme, &resolved_ips)
    {
        write_error(&mut write_half, "destination denied").await?;
        return Err(error);
    }
    let mut connect_error = None;
    let mut remote = None;
    for address in addresses {
        match TcpStream::connect(address).await {
            Ok(stream) => {
                remote = Some(stream);
                break;
            }
            Err(error) => connect_error = Some(error),
        }
    }
    let remote = match remote {
        Some(stream) => stream,
        None => {
            write_error(&mut write_half, "destination connection failed").await?;
            let error = connect_error.ok_or_else(|| {
                EgressError::Dns(format!(
                    "no addresses resolved for {}:{}",
                    request.host, request.port
                ))
            })?;
            return Err(EgressError::Io(error));
        }
    };
    let response = serde_json::to_vec(&EgressBrokerResponse {
        ok: true,
        error: None,
    })
    .map_err(|error| EgressError::Protocol(format!("encode broker response: {error}")))?;
    write_half.write_all(&response).await?;
    write_half.write_all(b"\n").await?;
    write_half.flush().await?;

    let read_half = reader.into_inner();
    let mut client = read_half.reunite(write_half).map_err(|_| {
        EgressError::Protocol("broker socket halves could not be reunited".to_string())
    })?;
    relay(&mut client, remote, &proxy).await
}

async fn write_error(
    stream: &mut tokio::net::unix::OwnedWriteHalf,
    message: &str,
) -> Result<(), EgressError> {
    let response = serde_json::to_vec(&EgressBrokerResponse {
        ok: false,
        error: Some(message.to_string()),
    })
    .map_err(|error| EgressError::Protocol(format!("encode broker error: {error}")))?;
    stream.write_all(&response).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

async fn relay(
    client: &mut UnixStream,
    mut remote: TcpStream,
    proxy: &EgressProxy,
) -> Result<(), EgressError> {
    let mut client_buffer = vec![0_u8; RELAY_BUFFER_BYTES];
    let mut remote_buffer = vec![0_u8; RELAY_BUFFER_BYTES];
    let mut client_open = true;
    let mut remote_open = true;

    while client_open || remote_open {
        tokio::select! {
            read = client.read(&mut client_buffer), if client_open => {
                let count = read?;
                if count == 0 {
                    client_open = false;
                    let _ = remote.shutdown().await;
                    continue;
                }
                forward(&mut remote, &client_buffer[..count], proxy).await?;
            }
            read = remote.read(&mut remote_buffer), if remote_open => {
                let count = read?;
                if count == 0 {
                    remote_open = false;
                    let _ = client.shutdown().await;
                    continue;
                }
                forward(client, &remote_buffer[..count], proxy).await?;
            }
        }
    }
    Ok(())
}

async fn forward<T>(target: &mut T, bytes: &[u8], proxy: &EgressProxy) -> Result<(), EgressError>
where
    T: AsyncWriteExt + Unpin,
{
    let allowed = proxy.relay(bytes.len() as u64)? as usize;
    if allowed != bytes.len() {
        if allowed > 0 {
            target.write_all(&bytes[..allowed]).await?;
        }
        return Err(EgressError::ByteBudgetExceeded);
    }
    target.write_all(bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DestinationPolicy, EgressPolicy, RateLimit};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    fn localhost_policy(deny_private_ips: bool, port: u16) -> EgressPolicy {
        EgressPolicy {
            default_deny: true,
            destinations: vec![DestinationPolicy {
                allowed_host_suffixes: vec!["localhost".to_string()],
                allowed_ports: vec![port],
                allowed_schemes: vec!["http".to_string()],
            }],
            deny_private_ips,
        }
    }

    #[tokio::test]
    async fn broker_relays_only_after_an_allowed_decision() {
        let remote_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let remote_port = remote_listener.local_addr().unwrap().port();
        let temp = tempfile::tempdir().unwrap();
        let broker = EgressBroker::bind(
            temp.path().join("broker.sock"),
            Arc::new(EgressProxy::new(
                localhost_policy(false, remote_port),
                RateLimit {
                    bytes_per_second: 1_000_000,
                    max_total_bytes: 1024,
                },
            )),
        )
        .unwrap();
        let broker_path = broker.socket_path().to_path_buf();
        let broker_task = tokio::spawn(async move { broker.serve_one().await });
        let remote_task = tokio::spawn(async move {
            let (mut stream, _) = remote_listener.accept().await.unwrap();
            let mut input = [0_u8; 4];
            stream.read_exact(&mut input).await.unwrap();
            stream.write_all(&input).await.unwrap();
        });

        let stream = UnixStream::connect(broker_path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        write_half
            .write_all(b"{\"host\":\"localhost\",\"port\":")
            .await
            .unwrap();
        write_half
            .write_all(remote_port.to_string().as_bytes())
            .await
            .unwrap();
        write_half
            .write_all(b",\"scheme\":\"http\"}\n")
            .await
            .unwrap();
        let mut reader = BufReader::new(read_half);
        let mut response = String::new();
        reader.read_line(&mut response).await.unwrap();
        assert_eq!(
            serde_json::from_str::<EgressBrokerResponse>(&response).unwrap(),
            EgressBrokerResponse {
                ok: true,
                error: None
            }
        );
        let read_half = reader.into_inner();
        let mut stream = read_half.reunite(write_half).unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut echoed = [0_u8; 4];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping");
        drop(stream);
        remote_task.await.unwrap();
        broker_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn broker_denies_private_destination_before_connecting() {
        let temp = tempfile::tempdir().unwrap();
        let broker = EgressBroker::bind(
            temp.path().join("broker.sock"),
            Arc::new(EgressProxy::new(
                localhost_policy(true, 8080),
                RateLimit::default(),
            )),
        )
        .unwrap();
        let broker_path = broker.socket_path().to_path_buf();
        let broker_task = tokio::spawn(async move { broker.serve_one().await });

        let mut stream = UnixStream::connect(broker_path).await.unwrap();
        stream
            .write_all(b"{\"host\":\"localhost\",\"port\":8080,\"scheme\":\"http\"}\n")
            .await
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut response = String::new();
        reader.read_line(&mut response).await.unwrap();
        let response = serde_json::from_str::<EgressBrokerResponse>(&response).unwrap();
        assert!(!response.ok);
        assert_eq!(response.error.as_deref(), Some("destination denied"));
        assert!(matches!(
            broker_task.await.unwrap(),
            Err(EgressError::PrivateDestination(_))
        ));
    }
}
