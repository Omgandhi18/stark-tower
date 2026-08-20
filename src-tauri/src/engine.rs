use portable_pty::CommandBuilder;

/// A resolved engine invocation: the program to run and its base arguments.
/// New engines (Codex, Grok, etc.) plug in via [`resolve_engine`].
pub struct EngineSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Map an engine id to a concrete command. Claude Code is the default engine;
/// this is the single seam where other CLIs get added later.
pub fn resolve_engine(engine_id: &str) -> EngineSpec {
    match engine_id {
        "claude-code" => EngineSpec {
            program: "claude".into(),
            args: vec![],
        },
        // Future engines drop in here, e.g.:
        // "codex" => EngineSpec { program: "codex".into(), args: vec![] },
        // "grok"  => EngineSpec { program: "grok".into(),  args: vec![] },
        _ => EngineSpec {
            program: "claude".into(),
            args: vec![],
        },
    }
}

/// Build a pty command for an engine, propagating the environment and making
/// sure `claude` (and Node, Homebrew tools) resolve even when the app is
/// launched from Finder with a minimal PATH.
pub fn build_command(spec: &EngineSpec, cwd: &str) -> CommandBuilder {
    // Resolve via a login shell so a Finder-launched app finds nvm/brew CLIs.
    let program = crate::chat::resolve_program(&spec.program).unwrap_or_else(|| spec.program.clone());
    let mut cmd = CommandBuilder::new(&program);
    for a in &spec.args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);

    // Inherit the current environment first.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }

    // Then guarantee the common install locations are on PATH.
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!(
        "{home}/.local/bin:{home}/.nvm/versions/node/current/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    );
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{extra}:{p}"),
        Err(_) => extra,
    };
    cmd.env("PATH", path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}
