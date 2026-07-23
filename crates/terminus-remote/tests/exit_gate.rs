//! Exit-gate integration: local/remote equivalence, identity isolation,
//! disconnect cannot corrupt task state.

use std::path::PathBuf;
use terminus_remote::{
    compatible, ArtifactStreamManager, CollaborationRegistry, CollaborationRole,
    DeploymentIdentities, DurableEffectRecord, EffectState, EnvironmentBackend, ExecutionMode,
    ExecutionPool, Identity, IdentityKind, KernelTransport, MtlsMaterial, PinnedImage,
    ProtocolVersion, QuotaLedger, QuotaLimits, QuotaResource, RemoteEnvironmentDescriptor,
    SessionMembership, SettlementLedger,
};

#[test]
fn exit_gate_local_and_remote_durable_records_equivalent() {
    let local = DurableEffectRecord {
        effect_id: "eff-eq".into(),
        task_id: "task-1".into(),
        workspace_id: "ws-1".into(),
        kernel_identity: "kernel:k1".into(),
        state: EffectState::Settled,
        execution_mode: ExecutionMode::Local,
        evidence_refs: vec!["artifact://sha256/ab".into()],
    };
    let remote = DurableEffectRecord {
        execution_mode: ExecutionMode::Remote,
        ..local.clone()
    };
    assert!(SettlementLedger::equivalent(&local, &remote));
}

#[test]
fn exit_gate_identity_isolation() {
    let dep = DeploymentIdentities {
        server: Identity::new(IdentityKind::Server, "srv").expect("s"),
        kernel: Identity::new(IdentityKind::Kernel, "k-prod").expect("k"),
        control: Identity::new(IdentityKind::Control, "ctl").expect("c"),
    };
    dep.validate().expect("valid");
    let stranger = Identity::new(IdentityKind::Kernel, "k-other").expect("o");
    assert!(dep.assert_kernel_peer(&stranger).is_err());

    let material = MtlsMaterial {
        cert_pem_path: PathBuf::from("cert.pem"),
        key_pem_path: PathBuf::from("key.pem"),
        client_ca_pem_path: PathBuf::from("ca.pem"),
        expected_peer: dep.control.clone(),
        pinned_peer_fingerprint: Some(
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
        ),
    };
    assert!(material
        .authorize_peer(
            &dep.control,
            Some("sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        )
        .is_ok());
    assert!(material
        .authorize_peer(
            &dep.control,
            Some("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        )
        .is_err());
}

#[test]
fn exit_gate_disconnect_cannot_corrupt_to_settled() {
    let mut ledger = SettlementLedger::default();
    ledger
        .insert(DurableEffectRecord {
            effect_id: "eff-disc".into(),
            task_id: "task-1".into(),
            workspace_id: "ws-1".into(),
            kernel_identity: "kernel:k1".into(),
            state: EffectState::Started,
            execution_mode: ExecutionMode::Remote,
            evidence_refs: vec![],
        })
        .expect("insert");
    let after = ledger.on_disconnect("eff-disc").expect("disconnect");
    assert_ne!(after.state, EffectState::Settled);
    assert_eq!(after.state, EffectState::Unknown);
}

#[test]
fn remote_env_descriptor_and_pool_pinning() {
    let image = PinnedImage::parse(
        "ghcr.io/terminus/node@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    )
    .expect("pin");
    let desc = RemoteEnvironmentDescriptor {
        workspace_identity: Identity::new(IdentityKind::Workspace, "ws").expect("w"),
        kernel_identity: Identity::new(IdentityKind::Kernel, "k").expect("k"),
        transport: KernelTransport::Mtls {
            endpoint: "127.0.0.1:7443".into(),
            material: MtlsMaterial {
                cert_pem_path: PathBuf::from("c.pem"),
                key_pem_path: PathBuf::from("k.pem"),
                client_ca_pem_path: PathBuf::from("ca.pem"),
                expected_peer: Identity::new(IdentityKind::Kernel, "k").expect("k"),
                pinned_peer_fingerprint: None,
            },
        },
        backend: EnvironmentBackend::Container,
        image: image.clone(),
        policy_profile: "container-untrusted".into(),
        trust: "untrusted".into(),
        resource_class: "default".into(),
    };
    desc.validate().expect("desc");
    let mut pool = ExecutionPool::new(1);
    pool.register_slot("slot-1", image.clone()).expect("slot");
    let lease = pool.lease("ws", &image).expect("lease");
    pool.release(&lease.lease_id).expect("release");
}

#[test]
fn quotas_collab_audit_upgrade_and_stream() {
    let mut ledger = QuotaLedger::new(QuotaLimits::single_tenant_defaults());
    ledger
        .admit(QuotaResource::ConcurrentTasks, 1)
        .expect("admit");

    let mut collab = CollaborationRegistry::default();
    collab
        .grant(SessionMembership {
            session_id: "s1".into(),
            principal_id: "alice".into(),
            role: CollaborationRole::Owner,
        })
        .expect("grant");
    collab.handoff("s1", "alice", "bob").expect("handoff");

    let mut streams = ArtifactStreamManager::default();
    let session = streams.begin("text/plain", Some(4));
    streams.append(&session.session_id, 0, b"ab").expect("a");
    streams.append(&session.session_id, 2, b"cd").expect("b");
    let art = streams.commit(&session.session_id).expect("commit");
    assert_eq!(art.size_bytes, 4);

    let control = ProtocolVersion {
        major: 1,
        minor: 1,
        patch: 0,
    };
    let kernel = ProtocolVersion::parse("terminus.kernel.v1").expect("k");
    assert!(compatible(&control, &kernel));
}
