//! Best-effort process-group teardown. Every agent process is made a session
//! leader (via `setsid` in a pre-exec hook), so signalling its negative pid
//! reaches the whole group — the agent *and* the tools it spawned (Bash
//! grandchildren, MCP servers) — instead of leaving them orphaned to PID 1.

/// SIGKILL an agent's entire process group, then the leader itself as a fallback.
#[cfg(unix)]
pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let pid = pid as i32;
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::kill(pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
pub fn kill_tree(_pid: u32) {}
