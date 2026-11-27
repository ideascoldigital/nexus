use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod native_config;

/// Holds the spawned sidecar process so it can be killed on app exit.
/// Without this, the node sidecar outlives the app holding the database's
/// instance lock and an open handle on `sidecar/node_modules/...`, so the next
/// launch refuses to start against its own database.
struct SidecarChild(Mutex<Option<CommandChild>>);

const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;

/// Set the webview's zoom — a browser's zoom, which scales viewport units and
/// everything else consistently (CSS `zoom` on the page does not: its `vh`
/// layouts overflow). Called by the page, which owns the number: it persists
/// it, steps it, and shows it in Settings and the status bar.
#[tauri::command]
fn set_zoom(app: AppHandle, level: f64) -> Result<f64, String> {
    if !level.is_finite() {
        return Err("zoom must be a number".into());
    }
    let level = level.clamp(ZOOM_MIN, ZOOM_MAX);
    let window = app.get_webview_window("main").ok_or("no main window")?;
    window.set_zoom(level).map_err(|e| e.to_string())?;
    Ok(level)
}

/// The View menu's shortcuts call the page's hook rather than zooming here, so
/// the menu, Settings and the status bar step through the same number, stored
/// in one place. Before the page has loaded (the placeholder) there is nothing
/// to zoom.
fn page_zoom(app: &AppHandle, dir: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(format!(
            "window.__nexuxZoom && window.__nexuxZoom(\"{dir}\")"
        ));
    }
}

/// Neither server gets a port from here. Both are spawned with `0` — "any free
/// port" — and report what the OS gave them, so an unrelated process, or an
/// orphaned sidecar from an app that was killed rather than closed, cannot keep
/// Nexus from starting. "One Nexus per database" is enforced where it belongs,
/// by the instance lock in @nexux/db, whose refusal arrives on the same stream.
const SIDECAR_HOST: &str = "127.0.0.1";
const SIDECAR_READY_TIMEOUT_SECS: u64 = 30;

/// Append a line to the on-disk native log. GUI apps on Windows discard
/// stdout/stderr, so a file in the data dir is the only way to see why the
/// sidecar (and thus the whole app) failed to come up. Best-effort: never
/// panics, mirrors to stderr for dev runs.
fn log_line(path: &Option<PathBuf>, msg: &str) {
    eprintln!("{msg}");
    if let Some(p) = path {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

/// Strip Windows' `\\?\` verbatim/extended-length prefix from a path.
///
/// `resource_dir()` returns a verbatim path (e.g. `\\?\C:\Users\…\Nexus`) on
/// Windows. Rust's own `Path` handles it, but Node.js' main-module resolver
/// (`resolveMainPath` → `realpathSync`) does not: it mis-splits the prefix and
/// ends up doing `lstat('C:')`, which fails with `EISDIR`, so the sidecar exits
/// immediately and the window shows "127.0.0.1 refused to connect". macOS/Linux
/// have no such prefix, which is why this only bites on Windows. No-op on other
/// platforms and for already-normal paths.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p
}

/// The PATH the sidecar should run with.
///
/// macOS hands a GUI app launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` —
/// not the one the user's terminal has. The sidecar shells out to developer
/// tooling that lives outside those four directories, `docker` above all:
/// OrbStack and Docker Desktop both install it under `/usr/local/bin` or the
/// home directory. `spawn("docker")` then fails with `ENOENT`, which the app
/// reported to the user as "Docker is not running" — a daemon that is in fact
/// up. The same trap waits for every tool the app learns to call.
///
/// So ask the login shell what its PATH is and run with that: what the user
/// installed, wherever their shell says it is (homebrew, nvm, mise, asdf).
/// A fixed list of the usual suspects is merged in behind it, so a shell that
/// cannot be asked — or answers with nothing — still leaves docker reachable.
#[cfg(unix)]
fn login_shell_path(log: &Option<PathBuf>) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // Interactive, because PATH is commonly set in `.zshrc`/`.bashrc`, which a
    // non-interactive shell does not read. That also means rc files may print
    // banners onto stdout, so the value travels between sentinels rather than
    // being read as "whatever came out".
    let script = "printf '\\n__NEXUX_PATH__%s__NEXUX_PATH__\\n' \"$PATH\"";
    let mut child = Command::new(&shell)
        .args(["-ilc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;

    // A login shell runs the user's rc files, and one of those can block
    // forever (a prompt, a network call). Reading on another thread keeps that
    // from hanging the app's startup: past the deadline we kill it and fall
    // back, having lost two seconds rather than the launch.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let text = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(s) => {
            let _ = child.wait();
            s
        }
        Err(_) => {
            let _ = child.kill();
            log_line(log, "[native] WARN: login shell did not report PATH in time");
            return None;
        }
    };

    let value = text
        .split("__NEXUX_PATH__")
        .nth(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    Some(value)
}

#[cfg(not(unix))]
fn login_shell_path(_log: &Option<PathBuf>) -> Option<String> {
    // Windows resolves from the registry PATH, which a GUI process already has.
    None
}

/// Where docker ends up when nobody asks the shell. Not a guess at the user's
/// setup — a floor, so the common installs stay reachable even when the shell
/// cannot be read.
fn fallback_path_dirs() -> Vec<String> {
    let mut dirs = vec![
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for rel in [".orbstack/bin", ".docker/bin", ".rd/bin"] {
            dirs.push(home.join(rel).to_string_lossy().to_string());
        }
    }
    dirs
}

/// The login shell's PATH, then this process's, then the floor — each entry
/// kept once, in that order of precedence.
fn sidecar_path(log: &Option<PathBuf>) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    };
    if let Some(from_shell) = login_shell_path(log) {
        for p in from_shell.split(':') {
            push(p.to_string());
        }
    }
    if let Ok(inherited) = std::env::var("PATH") {
        for p in inherited.split(':') {
            push(p.to_string());
        }
    }
    for p in fallback_path_dirs() {
        push(p);
    }
    parts.join(":")
}

/// Tie the sidecar's lifetime to this process at the OS level (Windows).
///
/// `RunEvent::Exit` kills the child on a normal quit, but nothing runs on a
/// `TerminateProcess` — Task Manager, a crash, or an installer force-closing the
/// app. The sidecar then outlives us holding the database's instance lock *and*
/// an open handle on `sidecar/node_modules/...`, so the next install fails with
/// "Error opening file for writing" and a half-written app dir. A job object with
/// `KILL_ON_JOB_CLOSE` makes the kernel do it: when our last handle to the job
/// closes — however we died — every process in it is terminated.
///
/// The handle is deliberately never closed; it must live as long as we do.
/// Best-effort: a failure here costs the guarantee, not the app.
#[cfg(windows)]
fn adopt_into_kill_on_close_job(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW failed".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set == 0 {
            CloseHandle(job);
            return Err("SetInformationJobObject failed".into());
        }
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            CloseHandle(job);
            return Err(format!("OpenProcess({pid}) failed"));
        }
        let assigned = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assigned == 0 {
            CloseHandle(job);
            return Err("AssignProcessToJobObject failed".into());
        }
    }
    Ok(())
}

/// Replace the loading screen with a message. The window starts on the bundled
/// placeholder (`frontendDist`), which defines `window.__nexuxStatus` — so this
/// only reaches a page we shipped, never the sidecar's own UI.
fn show_status(app: &AppHandle, msg: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let escaped = msg.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = window.eval(format!(
            "window.__nexuxStatus && window.__nexuxStatus(\"{escaped}\")"
        ));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![set_zoom])
        .setup(|app| {
            // View menu with webview zoom, appended to the default menu so the
            // standard Edit/Window items (copy, paste, minimize) stay intact.
            let zoom_in =
                MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
            let zoom_out =
                MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
            let zoom_reset =
                MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
            let menu = Menu::default(app.handle())?;
            // macOS's default menu already ships a View submenu (fullscreen);
            // extend it there instead of adding a second "View".
            let existing_view = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(s) if s.text().as_deref().ok() == Some("View") => Some(s),
                _ => None,
            });
            match existing_view {
                Some(view) => {
                    view.append_items(&[
                        &PredefinedMenuItem::separator(app)?,
                        &zoom_in,
                        &zoom_out,
                        &zoom_reset,
                    ])?;
                }
                None => {
                    let view = Submenu::with_items(
                        app,
                        "View",
                        true,
                        &[&zoom_in, &zoom_out, &zoom_reset],
                    )?;
                    menu.append(&view)?;
                }
            }
            // ⌘W closes the tab you are in (a terminal, files…), not the app:
            // the default menu's "Close Window" owns ⌘W and closing the only
            // window quits Nexus. It goes, and "Close Tab" asks the page; the
            // window's red button still closes it.
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sub) = item {
                    for child in sub.items()? {
                        if let MenuItemKind::Predefined(p) = &child {
                            if p.text().map(|t| t == "Close Window").unwrap_or(false) {
                                sub.remove(p)?;
                            }
                        }
                    }
                    if sub.text().as_deref().ok() == Some("Window") {
                        let close_tab =
                            MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
                        sub.prepend(&close_tab)?;
                    }
                }
            }
            app.set_menu(menu)?;

            // Dev mode is driven by beforeDevCommand + devUrl (Next on :3000).
            // Skip sidecar spawn during `tauri dev`.
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let handle = app.handle().clone();

            // Bootstrap dir + log file first, so everything below is diagnosable
            // even when it fails. GUI apps on Windows have no visible stderr.
            // The log and native.json always live here, even when native.json
            // moves the data elsewhere: this is where to look when it does not
            // start.
            let home = handle
                .path()
                .home_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let bootstrap_dir = home.join(".nexux");
            std::fs::create_dir_all(&bootstrap_dir).ok();
            let log_file = Some(bootstrap_dir.join("native.log"));
            log_line(&log_file, "[native] setup start");

            let config_path = bootstrap_dir.join(native_config::CONFIG_FILE);
            let config_text = std::fs::read_to_string(&config_path).ok();
            let paths = match native_config::resolve(
                config_text.as_deref(),
                &bootstrap_dir,
                &home,
            ) {
                Ok(p) => p,
                Err(e) => {
                    // Never fall back to the default database: a broken override
                    // that silently opened a different set of projects would look
                    // like data loss.
                    log_line(&log_file, &format!("[native] ERROR: {e}"));
                    show_status(
                        &handle,
                        &format!("{e}. Fix {} and reopen Nexus.", config_path.to_string_lossy()),
                    );
                    return Ok(());
                }
            };
            let data_dir = paths.data_dir;
            std::fs::create_dir_all(&data_dir).ok();
            if paths.overridden {
                log_line(
                    &log_file,
                    &format!(
                        "[native] {} → database={} data_dir={}",
                        native_config::CONFIG_FILE,
                        paths.database_path.to_string_lossy(),
                        data_dir.to_string_lossy()
                    ),
                );
            }

            let resource_dir = match handle.path().resource_dir() {
                Ok(d) => strip_verbatim_prefix(d),
                Err(e) => {
                    log_line(&log_file, &format!("[native] resource_dir error: {e}"));
                    return Ok(());
                }
            };
            let server_js = resource_dir.join("sidecar").join("start.js");
            let migrations_dir = resource_dir
                .join("sidecar")
                .join("prisma")
                .join("migrations");
            log_line(
                &log_file,
                &format!(
                    "[native] resource_dir={} start.js_exists={}",
                    resource_dir.to_string_lossy(),
                    server_js.exists()
                ),
            );

            let db_url = format!("file:{}", paths.database_path.to_string_lossy());

            // Logged because "docker is missing" and "docker is somewhere this
            // PATH does not reach" look identical from the UI, and the log is
            // where that question gets settled.
            let sidecar_path_value = sidecar_path(&log_file);
            log_line(&log_file, &format!("[native] PATH={sidecar_path_value}"));

            let sidecar = match handle.shell().sidecar("node") {
                Ok(s) => s,
                Err(e) => {
                    log_line(&log_file, &format!("[native] sidecar setup error: {e}"));
                    return Ok(());
                }
            };

            let spawned = sidecar
                .args([server_js.to_string_lossy().to_string()])
                // 0 = let the OS pick, atomically. Each server reports the
                // port it got: the web one on stdout (parsed below), the
                // terminal one through /api/terminal/info, which is how the
                // browser client has always discovered it.
                .env("PORT", "0")
                .env("HOSTNAME", SIDECAR_HOST)
                .env("NEXUX_TERMINAL_PORT", "0")
                .env("PATH", &sidecar_path_value)
                .env("NEXUX_MODE", "local")
                // Lets the server tell the desktop app from `pnpm dev` — the
                // data-location settings say "reopen Nexus" only in the app.
                .env("NEXUX_SHELL", "native")
                .env("DATABASE_URL", &db_url)
                .env("NEXUX_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env(
                    "NEXUX_MIGRATIONS_DIR",
                    migrations_dir.to_string_lossy().to_string(),
                )
                .spawn();

            let (mut rx, child) = match spawned {
                Ok(pair) => pair,
                Err(e) => {
                    log_line(&log_file, &format!("[native] sidecar spawn error: {e}"));
                    return Ok(());
                }
            };
            log_line(&log_file, "[native] sidecar spawned");

            #[cfg(windows)]
            match adopt_into_kill_on_close_job(child.pid()) {
                Ok(()) => log_line(&log_file, "[native] sidecar bound to kill-on-close job"),
                Err(e) => log_line(
                    &log_file,
                    &format!("[native] WARN: could not bind sidecar to job object: {e}"),
                ),
            }

            handle.manage(SidecarChild(Mutex::new(Some(child))));

            // Pipe every sidecar line to the log file so a crash/stack trace from
            // Next.js or the DB layer is recoverable after the fact.
            let sidecar_died = Arc::new(AtomicBool::new(false));
            // The server's own reason for refusing to start, when it gave one —
            // "another Nexux is running against this database" is worth showing
            // on screen rather than behind "see native.log".
            let refusal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            // The port the sidecar actually bound, in its own words. This is
            // what the window navigates to — never a number we assumed.
            let ready_port: Arc<Mutex<Option<u16>>> = Arc::new(Mutex::new(None));
            let log_pipe = log_file.clone();
            let died_pipe = sidecar_died.clone();
            let refusal_pipe = refusal.clone();
            let port_pipe = ready_port.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            let text = text.trim_end();
                            if let Some(reason) = text.split("[instance-lock] ").nth(1) {
                                *refusal_pipe.lock().unwrap() = Some(reason.to_string());
                            }
                            if let Some(rest) = text.split("[nexux] listening on ").nth(1) {
                                if let Ok(p) = rest.trim().parse::<u16>() {
                                    *port_pipe.lock().unwrap() = Some(p);
                                }
                            }
                            log_line(&log_pipe, &format!("[sidecar] {text}"));
                        }
                        CommandEvent::Terminated(payload) => {
                            log_line(
                                &log_pipe,
                                &format!("[sidecar] terminated: {:?}", payload),
                            );
                            died_pipe.store(true, Ordering::SeqCst);
                        }
                        _ => {}
                    }
                }
            });

            // Wait for the sidecar OFF the main thread — blocking here freezes the
            // window (blank/"not responding" on Windows). The window shows the
            // bundled loading placeholder until we navigate it to the server.
            //
            // Readiness is our own child naming the port it bound, not a probe
            // against a port we picked: the answer cannot come from a stranger.
            // Watching `sidecar_died` alongside it turns a server that exits
            // during startup into a message on screen instead of a half-minute
            // of "Starting…" followed by silence.
            let ready_handle = handle.clone();
            let ready_log = log_file.clone();
            let ready_died = sidecar_died.clone();
            let ready_refusal = refusal.clone();
            let ready_port_probe = ready_port.clone();
            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                let timeout = Duration::from_secs(SIDECAR_READY_TIMEOUT_SECS);
                let bound_port;
                loop {
                    if ready_died.load(Ordering::SeqCst) {
                        log_line(
                            &ready_log,
                            "[native] ERROR: sidecar exited before it was ready",
                        );
                        // The Terminated event can land before the last stderr
                        // line is piped; give the reader a moment to catch up.
                        std::thread::sleep(Duration::from_millis(300));
                        let reason = ready_refusal.lock().unwrap().clone();
                        show_status(
                            &ready_handle,
                            &reason.unwrap_or_else(|| {
                                "Nexus's server stopped while starting. \
                                 See ~/.nexux/native.log for what it reported."
                                    .to_string()
                            }),
                        );
                        return;
                    }
                    if let Some(p) = *ready_port_probe.lock().unwrap() {
                        bound_port = p;
                        break;
                    }
                    if start.elapsed() >= timeout {
                        log_line(
                            &ready_log,
                            "[native] ERROR: sidecar did not become ready within timeout",
                        );
                        show_status(
                            &ready_handle,
                            "Nexus's server did not start in time. \
                             See ~/.nexux/native.log for what it reported.",
                        );
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                log_line(
                    &ready_log,
                    &format!("[native] sidecar ready on :{bound_port}, navigating webview"),
                );
                if let Some(window) = ready_handle.get_webview_window("main") {
                    let url = format!("http://{SIDECAR_HOST}:{bound_port}");
                    match url.parse() {
                        Ok(u) => {
                            if let Err(e) = window.navigate(u) {
                                log_line(&ready_log, &format!("[native] navigate error: {e}"));
                            }
                        }
                        Err(e) => log_line(&ready_log, &format!("[native] url parse error: {e}")),
                    }
                }
            });

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "zoom_in" => page_zoom(app, "in"),
            "zoom_out" => page_zoom(app, "out"),
            "zoom_reset" => page_zoom(app, "reset"),
            "close_tab" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.__nexuxCloseTab && window.__nexuxCloseTab()");
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<SidecarChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
