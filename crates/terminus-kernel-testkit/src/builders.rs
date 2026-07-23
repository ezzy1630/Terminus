use terminus_kernel_protocol::{
    CommandSpec, EffectIntent, RequestContext, ShellSpec, WorkspacePath,
};

#[derive(Debug, Clone, Default)]
pub struct RequestContextBuilder {
    request_id: Option<String>,
    session_id: Option<String>,
    task_id: Option<String>,
    actor_id: Option<String>,
}

impl RequestContextBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request_id(mut self, id: impl Into<String>) -> Self {
        self.request_id = Some(id.into());
        self
    }

    pub fn session_id(mut self, id: impl Into<String>) -> Self {
        self.session_id = Some(id.into());
        self
    }

    pub fn task_id(mut self, id: impl Into<String>) -> Self {
        self.task_id = Some(id.into());
        self
    }

    pub fn actor_id(mut self, id: impl Into<String>) -> Self {
        self.actor_id = Some(id.into());
        self
    }

    pub fn build(self) -> RequestContext {
        RequestContext {
            request_id: self
                .request_id
                .unwrap_or_else(terminus_kernel_protocol::new_id),
            idempotency_key: terminus_kernel_protocol::new_id(),
            session_id: self.session_id.unwrap_or_default(),
            task_id: self.task_id.unwrap_or_default(),
            turn_id: String::new(),
            actor_id: self.actor_id.unwrap_or_else(|| "test-actor".to_string()),
            traceparent: String::new(),
            capability_token: String::new(),
            workspace_id: String::new(),
            deadline_unix_ms: 0,
            resource_budgets: terminus_kernel_protocol::ResourceBudgets::default(),
            policy_version: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct EffectIntentBuilder {
    trust_label: Option<String>,
    policy_profile_id: Option<String>,
    taint_sources: Vec<String>,
}

impl EffectIntentBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn trusted(mut self) -> Self {
        self.trust_label = Some("trusted".into());
        self
    }

    pub fn policy_profile(mut self, profile: impl Into<String>) -> Self {
        self.policy_profile_id = Some(profile.into());
        self
    }

    pub fn add_taint(mut self, source: impl Into<String>) -> Self {
        self.taint_sources.push(source.into());
        self
    }

    pub fn build(self) -> EffectIntent {
        EffectIntent {
            user_intent_ref: String::new(),
            task_contract_hash: String::new(),
            trust_label: self.trust_label.unwrap_or_else(|| "trusted".to_string()),
            confidentiality_label: "workspace".to_string(),
            taint_sources: self.taint_sources,
            policy_profile_id: self
                .policy_profile_id
                .unwrap_or_else(|| "default".to_string()),
            expected_effect_class: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CommandSpecBuilder {
    program: Option<String>,
    args: Vec<String>,
    cwd: Option<WorkspacePath>,
    public_env: std::collections::BTreeMap<String, String>,
    timeout_ms: u64,
    shell: Option<ShellSpec>,
}

impl CommandSpecBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn program(mut self, program: impl Into<String>) -> Self {
        self.program = Some(program.into());
        self
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    pub fn cwd(mut self, cwd: WorkspacePath) -> Self {
        self.cwd = Some(cwd);
        self
    }

    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.public_env.insert(k.into(), v.into());
        self
    }

    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }

    pub fn shell_script(mut self, dialect: impl Into<String>, script: impl Into<String>) -> Self {
        self.shell = Some(ShellSpec {
            enabled: true,
            script: script.into(),
            dialect: dialect.into(),
        });
        self
    }

    pub fn build(self) -> CommandSpec {
        CommandSpec {
            program: self.program.unwrap_or_default(),
            args: self.args,
            cwd: self.cwd.unwrap_or(WorkspacePath::new("ws-1", ".")),
            public_env: self.public_env,
            secret_capability_uris: Vec::new(),
            timeout_ms: self.timeout_ms,
            allocate_pty: false,
            shell: self.shell.unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_context_builder_defaults() {
        let ctx = RequestContextBuilder::new().build();
        assert!(!ctx.request_id.is_empty());
        assert_eq!(ctx.actor_id, "test-actor");
    }

    #[test]
    fn effect_intent_builder_trusted() {
        let intent = EffectIntentBuilder::new().trusted().build();
        assert_eq!(intent.trust_label, "trusted");
    }

    #[test]
    fn command_spec_builder_shell() {
        let cmd = CommandSpecBuilder::new()
            .shell_script("bash", "echo hi")
            .build();
        assert!(cmd.shell.enabled);
        assert_eq!(cmd.shell.script, "echo hi");
    }
}
