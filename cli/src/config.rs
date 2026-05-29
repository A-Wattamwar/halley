use anyhow::Result;
use serde::Deserialize;
use std::path::Path;

/// Top-level `halley.config.json` schema.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct HalleyConfig {
    /// How to launch the user's agent.
    pub agent: AgentConfig,

    /// Provider interception shim configuration.
    pub shim: ShimConfig,

    /// Relative path to the fixtures directory (default: "halley/fixtures").
    #[serde(default = "default_fixtures_dir")]
    pub fixtures_dir: String,

    /// Tool definitions with safety annotations.
    #[serde(default)]
    pub tools: Vec<ToolConfig>,

    /// Replay-mode defaults.
    #[serde(default)]
    pub replay: ReplayDefaults,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct AgentConfig {
    /// Command to run the agent, e.g. ["python", "agent.py"].
    pub command: Vec<String>,

    /// Working directory for the agent command (relative to config file).
    #[serde(default)]
    pub cwd: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ShimConfig {
    /// Provider/client to intercept (e.g. "openai").
    pub provider: String,

    /// Environment variable the shim reads to determine mode.
    #[serde(default = "default_replay_env_var")]
    pub replay_env_var: String,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ToolConfig {
    /// Tool name (must match the `tool_name` in observations).
    pub name: String,

    /// If true, this tool has side effects that cannot be safely replayed
    /// without an explicit override. Used in Day 3 tool-effect-safe replay.
    #[serde(default)]
    pub irreversible: bool,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ReplayDefaults {
    /// Default replay mode: "pure", "hybrid", or "record".
    #[serde(default = "default_mode")]
    pub mode: String,

    /// Metric headroom factor for invariant evaluation (default: 1.2).
    #[serde(default = "default_headroom")]
    pub headroom: f64,
}

impl Default for ReplayDefaults {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            headroom: default_headroom(),
        }
    }
}

fn default_fixtures_dir() -> String {
    "halley/fixtures".into()
}
fn default_replay_env_var() -> String {
    "HALLEY_MODE".into()
}
fn default_mode() -> String {
    "pure".into()
}
fn default_headroom() -> f64 {
    1.2
}

/// Load and parse `halley.config.json` from the given path.
pub fn load(path: &Path) -> Result<HalleyConfig> {
    let contents = std::fs::read_to_string(path)?;
    let cfg: HalleyConfig = serde_json::from_str(&contents)?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_config() {
        let json = r#"{
            "agent": { "command": ["python", "agent.py"] },
            "shim":  { "provider": "openai" }
        }"#;
        let cfg: HalleyConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.agent.command, vec!["python", "agent.py"]);
        assert_eq!(cfg.shim.provider, "openai");
        assert_eq!(cfg.fixtures_dir, "halley/fixtures");
        assert_eq!(cfg.replay.headroom, 1.2);
    }

    #[test]
    fn parse_full_config() {
        let json = r#"{
            "agent": { "command": ["python", "agent.py"], "cwd": "examples/reasoning-agent-python" },
            "shim":  { "provider": "openai", "replay_env_var": "HALLEY_MODE" },
            "fixtures_dir": "halley/fixtures",
            "tools": [
                { "name": "calculator", "irreversible": false },
                { "name": "send_email", "irreversible": true }
            ],
            "replay": { "mode": "hybrid", "headroom": 1.5 }
        }"#;
        let cfg: HalleyConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.tools.len(), 2);
        assert!(cfg.tools[1].irreversible);
        assert_eq!(cfg.replay.mode, "hybrid");
        assert!((cfg.replay.headroom - 1.5).abs() < f64::EPSILON);
    }
}
