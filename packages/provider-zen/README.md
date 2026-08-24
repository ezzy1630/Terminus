# @terminus/provider-zen

Direct OpenCode Zen and Go model-gateway integration for the Terminus runtime.
This package does not import or execute the OpenCode agent.

## What it owns

- decoding and intersecting `/v1/models` with Models.dev metadata;
- exact model-to-protocol bindings for Chat Completions, Responses, and
  Anthropic Messages;
- provider rendering profiles derived from observed catalog entries;
- request endpoint selection and incremental SSE normalization;
- an opaque credential-bound HTTP client contract for the kernel connector.

## Security boundary

The package has no network, filesystem, environment, or raw-secret access. A
higher layer must implement `CredentialBoundGatewayClient` through the kernel's
destination-bound connector. Unknown models and protocols fail closed.

Discovered profiles allow `public` content only. The control-plane setting can
admit `workspace` content for the configured account after the user explicitly
enables it.

## Runtime wiring

The control plane implements `CredentialBoundGatewayClient` through the kernel
ConnectorService. The kernel stores credentials in the OS credential store,
mints a one-use destination-bound grant, dispatches HTTPS with certificate and
DNS-pin validation, and returns a bounded scrubbed SSE body. A generated invalid
credential canary verifies the public TLS path without consuming model quota.
