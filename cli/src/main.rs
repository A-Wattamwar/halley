use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

mod config;

/// Halley — agent regression testing CLI.
///
/// Record production runs as bit-fidelity cassettes, replay them at $0 in CI,
/// diff prompt drift, and bisect regressions.
#[derive(Parser)]
#[command(name = "halley", version, about)]
struct Cli {
    /// Path to halley.config.json (default: ./halley.config.json)
    #[arg(long, default_value = "halley.config.json")]
    config: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Record a bit-fidelity fixture by running the agent with the capture shim.
    Record {
        /// Override the question/input passed to the agent command.
        #[arg(long)]
        input: Option<String>,
    },
    /// Run fixtures in replay mode and evaluate invariants (CI mode).
    Ci {
        /// Only run this specific fixture slug.
        #[arg(long)]
        only: Option<String>,
        /// JUnit XML output path.
        #[arg(long, default_value = "halley-results.xml")]
        junit: PathBuf,
    },
    /// Show prompt/model/output deltas between recorded baseline and current run.
    Diff {
        /// Fixture slug or ID.
        fixture: String,
    },
    /// Binary-search commits to find the first that breaks a fixture.
    Bisect {
        /// Fixture slug or ID.
        fixture: String,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let cfg = config::load(&cli.config)
        .with_context(|| format!("reading config from {}", cli.config.display()))?;

    match cli.command {
        Command::Record { input } => cmd_record(&cli.config, &cfg, input),
        Command::Ci { only, junit } => cmd_ci(&cli.config, &cfg, only, &junit),
        Command::Diff { .. } => {
            eprintln!("halley diff: not yet implemented (Day 3)");
            Ok(())
        }
        Command::Bisect { .. } => {
            eprintln!("halley bisect: not yet implemented (Day 4)");
            Ok(())
        }
    }
}

// ── Shared setup ─────────────────────────────────────────────────────────

#[allow(dead_code)]
struct ResolvedPaths {
    config_dir: PathBuf,
    agent_cwd: PathBuf,
    sdk_py_dir: PathBuf,
    fixtures_dir: PathBuf,
    site_dir: PathBuf,
    pypath: String,
}

fn resolve_paths(
    config_path: &std::path::Path,
    cfg: &config::HalleyConfig,
) -> Result<ResolvedPaths> {
    let config_dir = config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .canonicalize()
        .context("canonicalizing config directory")?;

    let agent_cwd = if let Some(ref cwd) = cfg.agent.cwd {
        config_dir.join(cwd)
    } else {
        config_dir.clone()
    };

    let sdk_py_dir = if let Ok(p) = std::env::var("HALLEY_SDK_PY_PATH") {
        PathBuf::from(p)
    } else {
        find_sdk_py(&config_dir).context(
            "cannot find sdk-py/ directory. Set HALLEY_SDK_PY_PATH or run from the Halley repo.",
        )?
    };

    if !sdk_py_dir.join("halley_sdk").join("auto.py").exists() {
        anyhow::bail!(
            "shim auto.py not found at {}",
            sdk_py_dir.join("halley_sdk/auto.py").display()
        );
    }

    let fixtures_dir = if std::path::Path::new(&cfg.fixtures_dir).is_absolute() {
        PathBuf::from(&cfg.fixtures_dir)
    } else {
        agent_cwd.join(&cfg.fixtures_dir)
    };

    let site_dir = std::env::temp_dir().join(format!("halley-shim-{}", std::process::id()));
    std::fs::create_dir_all(&site_dir).context("creating shim site dir")?;
    std::fs::write(
        site_dir.join("sitecustomize.py"),
        "import halley_sdk.auto\n",
    )
    .context("writing sitecustomize.py")?;

    let existing_pypath = std::env::var("PYTHONPATH").unwrap_or_default();
    let pypath = format!(
        "{}:{}{}",
        site_dir.display(),
        sdk_py_dir.display(),
        if existing_pypath.is_empty() {
            String::new()
        } else {
            format!(":{existing_pypath}")
        }
    );

    Ok(ResolvedPaths {
        config_dir,
        agent_cwd,
        sdk_py_dir,
        fixtures_dir,
        site_dir,
        pypath,
    })
}

// ── halley record ────────────────────────────────────────────────────────

fn cmd_record(
    config_path: &std::path::Path,
    cfg: &config::HalleyConfig,
    input: Option<String>,
) -> Result<()> {
    let paths = resolve_paths(config_path, cfg)?;

    eprintln!(
        "[halley record] fixtures_dir = {}",
        paths.fixtures_dir.display()
    );
    eprintln!(
        "[halley record] agent cwd    = {}",
        paths.agent_cwd.display()
    );
    eprintln!("[halley record] agent cmd    = {:?}", cfg.agent.command);
    eprintln!(
        "[halley record] sdk-py       = {}",
        paths.sdk_py_dir.display()
    );

    let mut cmd = std::process::Command::new(&cfg.agent.command[0]);
    if cfg.agent.command.len() > 1 {
        cmd.args(&cfg.agent.command[1..]);
    }
    if let Some(ref extra) = input {
        cmd.arg(extra);
    }

    cmd.current_dir(&paths.agent_cwd);
    cmd.env("PYTHONPATH", &paths.pypath);
    cmd.env("HALLEY_RECORD", "1");
    cmd.env(
        "HALLEY_FIXTURES_DIR",
        paths.fixtures_dir.to_str().unwrap_or("halley/fixtures"),
    );
    cmd.env(&cfg.shim.replay_env_var, "record");

    cmd.stdin(std::process::Stdio::inherit());
    cmd.stdout(std::process::Stdio::inherit());
    cmd.stderr(std::process::Stdio::inherit());

    eprintln!("[halley record] launching agent...");
    let status = cmd.status().context("failed to launch agent command")?;

    if !status.success() {
        anyhow::bail!(
            "agent exited with {}",
            status.code().map_or("signal".into(), |c| c.to_string())
        );
    }

    eprintln!("[halley record] agent exited successfully — fixture written by shim.");
    Ok(())
}

// ── halley ci ────────────────────────────────────────────────────────────

fn cmd_ci(
    config_path: &std::path::Path,
    cfg: &config::HalleyConfig,
    only: Option<String>,
    junit_path: &std::path::Path,
) -> Result<()> {
    let paths = resolve_paths(config_path, cfg)?;

    eprintln!(
        "[halley ci] fixtures_dir = {}",
        paths.fixtures_dir.display()
    );
    eprintln!("[halley ci] agent cwd    = {}", paths.agent_cwd.display());

    // Find fixture files.
    let fixture_files = find_fixtures(&paths.fixtures_dir, only.as_deref())?;
    if fixture_files.is_empty() {
        eprintln!(
            "[halley ci] no fixtures found in {}",
            paths.fixtures_dir.display()
        );
        return Ok(());
    }

    eprintln!(
        "[halley ci] found {} fixture(s): {:?}",
        fixture_files.len(),
        fixture_files
            .iter()
            .map(|f| f
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string())
            .collect::<Vec<_>>()
    );

    let mut all_results: Vec<String> = Vec::new(); // JSON arrays from each fixture
    let mut any_failed = false;

    for fixture_path in &fixture_files {
        let slug = fixture_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        eprintln!("\n[halley ci] ── fixture: {} ──", slug);

        // Temp file for served entries.
        let served_path = paths.site_dir.join(format!("served-{slug}.json"));

        // Launch agent in replay mode.
        let mut cmd = std::process::Command::new(&cfg.agent.command[0]);
        if cfg.agent.command.len() > 1 {
            cmd.args(&cfg.agent.command[1..]);
        }

        cmd.current_dir(&paths.agent_cwd);
        cmd.env("PYTHONPATH", &paths.pypath);
        cmd.env("HALLEY_REPLAY", fixture_path.to_str().unwrap_or_default());
        cmd.env(
            "HALLEY_SERVED_JSON",
            served_path.to_str().unwrap_or_default(),
        );
        cmd.env(&cfg.shim.replay_env_var, "replay");

        cmd.stdin(std::process::Stdio::inherit());
        cmd.stdout(std::process::Stdio::inherit());
        cmd.stderr(std::process::Stdio::inherit());

        let status = cmd
            .status()
            .context("failed to launch agent in replay mode")?;

        if !status.success() {
            eprintln!(
                "[halley ci] agent exited with {} for fixture {}",
                status
                    .code()
                    .map_or("signal".into(), |c: i32| c.to_string()),
                slug
            );
            any_failed = true;
            // Record a fixture-level failure.
            all_results.push(format!(
                r#"[{{"fixture_slug":"{}","invariant_name":"replay","passed":false,"message":"agent exited non-zero","time_s":0}}]"#,
                slug
            ));
            continue;
        }

        // Check if served.json was written.
        if !served_path.exists() {
            eprintln!(
                "[halley ci] served.json not written for {} — shim may not have activated",
                slug
            );
            any_failed = true;
            all_results.push(format!(
                r#"[{{"fixture_slug":"{}","invariant_name":"replay","passed":false,"message":"no served.json — shim did not activate","time_s":0}}]"#,
                slug
            ));
            continue;
        }

        // Evaluate invariants via the Python CI runner.
        let eval_output = std::process::Command::new("python3")
            .args([
                "-m",
                "halley_sdk.ci_runner",
                fixture_path.to_str().unwrap_or_default(),
                served_path.to_str().unwrap_or_default(),
            ])
            .env("PYTHONPATH", &paths.pypath)
            .current_dir(&paths.agent_cwd)
            .output()
            .context("running invariant evaluator")?;

        let eval_json = String::from_utf8_lossy(&eval_output.stdout);
        if !eval_output.status.success() {
            let stderr = String::from_utf8_lossy(&eval_output.stderr);
            eprintln!("[halley ci] invariant evaluator failed: {}", stderr);
            any_failed = true;
            all_results.push(format!(
                r#"[{{"fixture_slug":"{}","invariant_name":"evaluation","passed":false,"message":"evaluator error: {}","time_s":0}}]"#,
                slug,
                stderr.replace('"', "'").trim()
            ));
            continue;
        }

        // Parse results and check for failures.
        let results: serde_json::Value =
            serde_json::from_str(&eval_json).unwrap_or_else(|_| serde_json::json!([]));

        if let Some(arr) = results.as_array() {
            for r in arr {
                let passed = r.get("passed").and_then(|v| v.as_bool()).unwrap_or(false);
                let name = r
                    .get("invariant_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let msg = r.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let status_str = if passed { "PASS" } else { "FAIL" };
                eprintln!("  [{status_str}] {name}: {msg}");
                if !passed {
                    any_failed = true;
                }
            }
        }

        all_results.push(eval_json.to_string());
    }

    // Write JUnit XML.
    write_junit_xml(&all_results, junit_path)?;
    eprintln!(
        "\n[halley ci] JUnit XML written to {}",
        junit_path.display()
    );

    if any_failed {
        eprintln!("[halley ci] FAILED — some invariants did not pass.");
        std::process::exit(1);
    }

    eprintln!("[halley ci] ALL PASSED");
    Ok(())
}

fn find_fixtures(fixtures_dir: &std::path::Path, only: Option<&str>) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    if !fixtures_dir.exists() {
        return Ok(files);
    }
    for entry in std::fs::read_dir(fixtures_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") && path.is_file() {
            if let Some(filter) = only {
                let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                if stem != filter {
                    continue;
                }
            }
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn write_junit_xml(result_jsons: &[String], path: &std::path::Path) -> Result<()> {
    // Parse all result arrays and merge.
    let mut all: Vec<serde_json::Value> = Vec::new();
    for json_str in result_jsons {
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(json_str) {
            all.extend(arr);
        }
    }

    // Group by fixture_slug.
    let mut suites: std::collections::BTreeMap<String, Vec<&serde_json::Value>> =
        std::collections::BTreeMap::new();
    for r in &all {
        let slug = r
            .get("fixture_slug")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        suites.entry(slug).or_default().push(r);
    }

    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites");
    let total_tests = all.len();
    let total_failures = all
        .iter()
        .filter(|r| !r.get("passed").and_then(|v| v.as_bool()).unwrap_or(true))
        .count();
    xml.push_str(&format!(
        " tests=\"{total_tests}\" failures=\"{total_failures}\" errors=\"0\">\n"
    ));

    for (slug, cases) in &suites {
        let failures = cases
            .iter()
            .filter(|r| !r.get("passed").and_then(|v| v.as_bool()).unwrap_or(true))
            .count();
        xml.push_str(&format!(
            "  <testsuite name=\"{slug}\" tests=\"{}\" failures=\"{failures}\" errors=\"0\">\n",
            cases.len()
        ));
        for case in cases {
            let name = case
                .get("invariant_name")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let passed = case.get("passed").and_then(|v| v.as_bool()).unwrap_or(true);
            let message = case.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let escaped_name = name.replace('&', "&amp;").replace('"', "&quot;");
            let escaped_msg = message
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;");
            xml.push_str(&format!(
                "    <testcase name=\"{escaped_name}\" classname=\"{slug}\">\n"
            ));
            if !passed {
                xml.push_str(&format!(
                    "      <failure message=\"{escaped_msg}\">{escaped_msg}</failure>\n"
                ));
            }
            xml.push_str("    </testcase>\n");
        }
        xml.push_str("  </testsuite>\n");
    }
    xml.push_str("</testsuites>\n");

    std::fs::write(path, &xml).context("writing JUnit XML")?;
    Ok(())
}

/// Walk up from `start` looking for a directory named `sdk-py` that contains `halley_sdk/`.
fn find_sdk_py(start: &std::path::Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..10 {
        let candidate = dir.join("sdk-py");
        if candidate.join("halley_sdk").is_dir() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}
