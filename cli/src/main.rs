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
        /// Replay mode: "pure" (default, $0) or "hybrid" (live on miss).
        #[arg(long, default_value = "pure")]
        mode: String,
        /// Allow live calls for irreversible tools on a cassette miss (hybrid only).
        #[arg(long, default_value_t = false)]
        allow_irreversible: bool,
    },
    /// Show prompt/model/output deltas between recorded baseline and current run.
    Diff {
        /// Fixture slug or ID.
        fixture: String,
    },
    /// Binary-search commits to find the first that breaks a fixture.
    Bisect {
        /// Fixture slug.
        fixture: String,
        /// Last-known-good commit (hash or ref). Defaults to the first commit in the repo.
        #[arg(long)]
        good: Option<String>,
        /// Path to the target git repo. Defaults to the config directory.
        #[arg(long)]
        repo: Option<String>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let cfg = config::load(&cli.config)
        .with_context(|| format!("reading config from {}", cli.config.display()))?;

    match cli.command {
        Command::Record { input } => cmd_record(&cli.config, &cfg, input),
        Command::Ci {
            only,
            junit,
            mode,
            allow_irreversible,
        } => cmd_ci(&cli.config, &cfg, only, &junit, &mode, allow_irreversible),
        Command::Diff { fixture } => cmd_diff(&cli.config, &cfg, &fixture),
        Command::Bisect { fixture, good, repo } => {
            cmd_bisect(&cli.config, &cfg, &fixture, good.as_deref(), repo.as_deref())
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
    let parent = config_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let parent = if parent == std::path::Path::new("") {
        std::path::Path::new(".")
    } else {
        parent
    };
    let config_dir = parent
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
    if let Some(ref slug) = cfg.agent.fixture_slug {
        cmd.env("HALLEY_FIXTURE_SLUG", slug);
    }

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
    mode: &str,
    allow_irreversible: bool,
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

        // Cost/summary JSON for hybrid mode.
        let cost_path = paths.site_dir.join(format!("cost-{slug}.json"));
        cmd.env("HALLEY_COST_JSON", cost_path.to_str().unwrap_or_default());

        // Mode env vars.
        if mode == "hybrid" {
            cmd.env("HALLEY_HYBRID", "1");
        }
        if allow_irreversible {
            cmd.env("HALLEY_ALLOW_IRREVERSIBLE", "1");
        }
        // Pass irreversible tool names from config.
        let irreversible: Vec<&str> = cfg
            .tools
            .iter()
            .filter(|t| t.irreversible)
            .map(|t| t.name.as_str())
            .collect();
        if !irreversible.is_empty() {
            cmd.env("HALLEY_IRREVERSIBLE_TOOLS", irreversible.join(","));
        }
        cmd.env(&cfg.shim.replay_env_var, "replay");

        // In pure replay mode all HTTP calls are intercepted before reaching the network.
        // The OpenAI client validates credentials at construction time, so inject a dummy
        // key if the real one isn't set — it is never sent over the wire.
        if mode == "pure" && std::env::var("OPENAI_API_KEY").is_err() {
            cmd.env("OPENAI_API_KEY", "sk-halley-replay-noop");
        }

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

        // In hybrid mode, report live-call cost.
        if mode == "hybrid" && cost_path.exists() {
            if let Ok(cost_json) = std::fs::read_to_string(&cost_path) {
                if let Ok(cost_val) = serde_json::from_str::<serde_json::Value>(&cost_json) {
                    let hits = cost_val.get("hits").and_then(|v| v.as_u64()).unwrap_or(0);
                    let live = cost_val
                        .get("live_calls")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cost = cost_val
                        .get("total_cost_usd")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let new_cassette = cost_val
                        .get("hybrid_cassette_slug")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    eprintln!(
                        "[halley ci] hybrid summary: {} hits, {} live calls, ${:.6} spent{}",
                        hits,
                        live,
                        cost,
                        if new_cassette.is_empty() {
                            String::new()
                        } else {
                            format!(", new cassette: {}", new_cassette)
                        }
                    );
                }
            }
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

fn cmd_diff(
    config_path: &std::path::Path,
    cfg: &config::HalleyConfig,
    fixture_slug: &str,
) -> Result<()> {
    let paths = resolve_paths(config_path, cfg)?;
    let fixtures_dir = &paths.fixtures_dir;

    // Find the baseline fixture.
    let baseline_path = fixtures_dir.join(format!("{fixture_slug}.json"));
    if !baseline_path.exists() {
        anyhow::bail!("Baseline fixture not found: {}", baseline_path.display());
    }

    // Find the most recent hybrid cassette alongside the baseline.
    let mut hybrid_candidates: Vec<PathBuf> = std::fs::read_dir(fixtures_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|e| e == "json")
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with(&format!("{fixture_slug}-hybrid-")))
        })
        .collect();
    hybrid_candidates.sort();

    let current_path = match hybrid_candidates.last() {
        Some(p) => p.clone(),
        None => {
            eprintln!("[halley diff] No hybrid cassette found for '{fixture_slug}'. Run `halley ci --mode hybrid` first.");
            return Ok(());
        }
    };

    // Delegate to Python diff runner for human-readable output.
    let diff_output = std::process::Command::new("python3")
        .args([
            "-m",
            "halley_sdk.diff_runner",
            baseline_path.to_str().unwrap_or_default(),
            current_path.to_str().unwrap_or_default(),
        ])
        .env("PYTHONPATH", &paths.pypath)
        .current_dir(&paths.agent_cwd)
        .output()
        .context("running diff runner")?;

    let stdout = String::from_utf8_lossy(&diff_output.stdout);
    let stderr = String::from_utf8_lossy(&diff_output.stderr);
    print!("{}", stdout);
    if !stderr.is_empty() {
        eprint!("{}", stderr);
    }

    if !diff_output.status.success() {
        std::process::exit(diff_output.status.code().unwrap_or(1));
    }
    Ok(())
}

// ── halley bisect ─────────────────────────────────────────────────────────

/// Run `halley ci --only <fixture>` once and return true if it passes.
fn run_ci_at_commit(
    repo_dir: &std::path::Path,
    config_path: &std::path::Path,
    fixture_slug: &str,
    paths: &ResolvedPaths,
    _cfg: &config::HalleyConfig,
) -> bool {
    let mut cmd = std::process::Command::new(
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("halley")),
    );
    cmd.arg("--config");
    cmd.arg(config_path.to_str().unwrap_or("halley.config.json"));
    cmd.arg("ci");
    cmd.arg("--only");
    cmd.arg(fixture_slug);
    cmd.arg("--junit");
    cmd.arg("/dev/null");

    cmd.current_dir(repo_dir);
    // Pass SDK path so the shim can be found.
    if let Ok(sdk) = std::env::var("HALLEY_SDK_PY_PATH") {
        cmd.env("HALLEY_SDK_PY_PATH", sdk);
    }

    // Propagate PYTHONPATH so sdk-py is importable.
    cmd.env("PYTHONPATH", &paths.pypath);
    // Dummy API key for pure replay (OpenAI client credential check).
    if std::env::var("OPENAI_API_KEY").is_err() {
        cmd.env("OPENAI_API_KEY", "sk-halley-replay-noop");
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    match cmd.output() {
        Ok(out) => out.status.success(),
        Err(e) => {
            eprintln!("[halley bisect]   error launching ci: {e}");
            false
        }
    }
}

fn cmd_bisect(
    config_path: &std::path::Path,
    cfg: &config::HalleyConfig,
    fixture_slug: &str,
    good_ref: Option<&str>,
    repo_override: Option<&str>,
) -> Result<()> {
    let paths = resolve_paths(config_path, cfg)?;

    // Determine the target repo directory.
    let repo_dir = if let Some(r) = repo_override {
        PathBuf::from(r).canonicalize().context("canonicalizing --repo path")?
    } else {
        paths.config_dir.clone()
    };

    eprintln!("[halley bisect] repo        = {}", repo_dir.display());
    eprintln!("[halley bisect] fixture     = {fixture_slug}");

    // Verify this is a git repo.
    let git_check = std::process::Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(&repo_dir)
        .output()
        .context("checking git repo")?;
    if !git_check.status.success() {
        anyhow::bail!("'{}' is not a git repository", repo_dir.display());
    }

    // Save the original HEAD so we can restore it.
    let orig_head = git_rev_parse(&repo_dir, "HEAD")?;
    let orig_branch = git_current_branch(&repo_dir).unwrap_or_default();
    eprintln!("[halley bisect] original HEAD = {orig_head}");

    // Collect linear commit history (newest first → oldest last).
    let log_out = std::process::Command::new("git")
        .args(["log", "--format=%H %s", "HEAD"])
        .current_dir(&repo_dir)
        .output()
        .context("running git log")?;
    let log_text = String::from_utf8_lossy(&log_out.stdout);
    let commits: Vec<(String, String)> = log_text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let (hash, rest) = l.split_once(' ').unwrap_or((l, ""));
            (hash.to_string(), rest.to_string())
        })
        .collect();

    if commits.is_empty() {
        anyhow::bail!("No commits found in the repo");
    }

    // Resolve good commit (oldest end of the search range).
    let good_hash = match good_ref {
        Some(r) => git_rev_parse(&repo_dir, r)?,
        None => {
            // Default: earliest (first) commit.
            commits.last().map(|(h, _)| h.clone()).unwrap()
        }
    };
    eprintln!("[halley bisect] good commit  = {}", &good_hash[..8]);

    // The bad end is always the current HEAD.
    let bad_hash = commits.first().map(|(h, _)| h.clone()).unwrap();
    eprintln!("[halley bisect] bad commit   = {}", &bad_hash[..8]);

    if good_hash == bad_hash {
        anyhow::bail!("good and bad commits are the same — nothing to bisect");
    }

    // Build the ordered slice [good..=bad] in chronological order.
    // commits is newest-first, so we want [bad_idx..=good_idx] reversed.
    let good_idx = commits
        .iter()
        .position(|(h, _)| h.starts_with(&good_hash) || good_hash.starts_with(h.as_str()))
        .ok_or_else(|| anyhow::anyhow!("good commit {good_hash} not found in log"))?;
    let bad_idx = commits
        .iter()
        .position(|(h, _)| h.starts_with(&bad_hash) || bad_hash.starts_with(h.as_str()))
        .unwrap_or(0);

    // candidates[0] = good (earliest), candidates[last] = bad (latest)
    let candidates: Vec<(String, String)> = commits[bad_idx..=good_idx]
        .iter()
        .cloned()
        .rev() // now chronological order
        .collect();

    eprintln!(
        "[halley bisect] search range: {} commits",
        candidates.len()
    );

    // We know good_commit passes and bad_commit fails.
    // Binary search for the first failing commit.
    // lo = last known good index, hi = first known bad index.
    let mut lo = 0usize;
    let mut hi = candidates.len() - 1;

    // Validate boundary assumptions.
    eprintln!("[halley bisect] verifying good commit...");
    if !test_commit_reliable(&repo_dir, config_path, &candidates[lo].0, fixture_slug, &paths, cfg) {
        eprintln!(
            "[halley bisect] WARNING: 'good' commit {} already fails — widening search not supported in v1. Proceeding anyway.",
            &candidates[lo].0[..8]
        );
    }

    let tries = 3;

    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        let (hash, subject) = &candidates[mid];
        eprintln!(
            "[halley bisect] checking {} ({}) …",
            &hash[..8],
            subject
        );

        let passes = test_commit_reliable_n(&repo_dir, config_path, hash, fixture_slug, &paths, cfg, tries);
        if passes {
            eprintln!("[halley bisect]   → PASS (good)");
            lo = mid;
        } else {
            eprintln!("[halley bisect]   → FAIL (bad)");
            hi = mid;
        }
    }

    // hi is the first bad commit.
    // Do a final reliable test on hi to be sure.
    let (final_hash, final_subject) = &candidates[hi].clone();
    eprintln!(
        "[halley bisect] confirming first-bad candidate {}…",
        &final_hash[..8]
    );
    let confirmed_bad = !test_commit_reliable_n(
        &repo_dir,
        config_path,
        final_hash,
        fixture_slug,
        &paths,
        cfg,
        tries,
    );

    // Restore original working state.
    restore_repo(&repo_dir, &orig_head, &orig_branch);

    if confirmed_bad {
        let short = &final_hash[..8];
        eprintln!("\n[halley bisect] ─────────────────────────────────────────");
        eprintln!("[halley bisect] First failing commit: {short} {final_subject}");
        eprintln!("[halley bisect] Fixture '{fixture_slug}' broke at {final_hash}");
        eprintln!("[halley bisect] ─────────────────────────────────────────");
        // Output a machine-readable line for the worker to parse.
        println!("BISECT_RESULT: {final_hash} {final_subject}");
    } else {
        eprintln!("[halley bisect] could not confirm a single bad commit — range may be flaky or too narrow.");
        std::process::exit(1);
    }

    Ok(())
}

/// Test a commit up to `n` times; treat as passing only if it passes every time.
/// Treat as failing if it fails `n` times consistently (absorbs noise, ROADMAP risk #5).
fn test_commit_reliable_n(
    repo_dir: &std::path::Path,
    config_path: &std::path::Path,
    commit: &str,
    fixture_slug: &str,
    paths: &ResolvedPaths,
    cfg: &config::HalleyConfig,
    n: usize,
) -> bool {
    // Checkout the candidate.
    let co = std::process::Command::new("git")
        .args(["checkout", commit, "--"])
        .current_dir(repo_dir)
        .output();
    if co.is_err() || !co.unwrap().status.success() {
        // Try detached HEAD checkout.
        let _ = std::process::Command::new("git")
            .args(["checkout", "--detach", commit])
            .current_dir(repo_dir)
            .output();
    }

    let mut pass_count = 0;
    let mut fail_count = 0;
    for _ in 0..n {
        if run_ci_at_commit(repo_dir, config_path, fixture_slug, paths, cfg) {
            pass_count += 1;
        } else {
            fail_count += 1;
        }
        // Short-circuit: if it's already failed consistently, stop early.
        if fail_count == n {
            return false;
        }
        if pass_count == n {
            return true;
        }
    }
    // Treat as failed only if consistently failing (>= n times).
    fail_count < n
}

fn test_commit_reliable(
    repo_dir: &std::path::Path,
    config_path: &std::path::Path,
    commit: &str,
    fixture_slug: &str,
    paths: &ResolvedPaths,
    cfg: &config::HalleyConfig,
) -> bool {
    test_commit_reliable_n(repo_dir, config_path, commit, fixture_slug, paths, cfg, 1)
}

fn git_rev_parse(repo_dir: &std::path::Path, git_ref: &str) -> Result<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", git_ref])
        .current_dir(repo_dir)
        .output()
        .with_context(|| format!("git rev-parse {git_ref}"))?;
    if !out.status.success() {
        anyhow::bail!("git rev-parse {git_ref} failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_current_branch(repo_dir: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(repo_dir)
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn restore_repo(repo_dir: &std::path::Path, orig_head: &str, orig_branch: &str) {
    if !orig_branch.is_empty() {
        let status = std::process::Command::new("git")
            .args(["checkout", orig_branch])
            .current_dir(repo_dir)
            .status();
        if status.is_ok_and(|s| s.success()) {
            eprintln!("[halley bisect] restored branch '{orig_branch}'");
            return;
        }
    }
    // Fallback: checkout by hash.
    let _ = std::process::Command::new("git")
        .args(["checkout", orig_head])
        .current_dir(repo_dir)
        .status();
    eprintln!("[halley bisect] restored to {}", &orig_head[..8]);
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
