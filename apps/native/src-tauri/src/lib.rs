use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the spawned sidecar process so it can be killed on app exit.
/// Without this, the node sidecar outlives the app and keeps serving the
/// previous build on port 3030 (stale UI on next launch).
struct SidecarChild(Mutex<Option<CommandChild>>);

/// Current webview zoom factor. Kept app-side because the webview does not
/// expose a getter, so relative zoom (in/out) needs the last applied value.
struct ZoomLevel(Mutex<f64>);

const ZOOM_STEP: f64 = 1.1;
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;

fn apply_zoom(app: &AppHandle, level: f64) {
    let level = level.clamp(ZOOM_MIN, ZOOM_MAX);
    if let Some(state) = app.try_state::<ZoomLevel>() {
        *state.0.lock().unwrap() = level;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(level);
    }
}

const SIDECAR_PORT: u16 = 3030;
const SIDECAR_TERMINAL_PORT: u16 = 3032;
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

/// Tie the sidecar's lifetime to this process at the OS level (Windows).
///
/// `RunEvent::Exit` kills the child on a normal quit, but nothing runs on a
/// `TerminateProcess` — Task Manager, a crash, or an installer force-closing the
/// app. The sidecar then outlives us holding port 3030 *and* an open handle on
/// `sidecar/node_modules/...`, so the next install fails with "Error opening
/// file for writing" and a half-written app dir. A job object with
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

fn port_in_use(host: &str, port: u16) -> bool {
    let addr = match format!("{}:{}", host, port).parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
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
        .manage(ZoomLevel(Mutex::new(1.0)))
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
            app.set_menu(menu)?;

            // Dev mode is driven by beforeDevCommand + devUrl (Next on :3000).
            // Skip sidecar spawn during `tauri dev`.
            if cfg!(debug_assertions) {
                return Ok(());
            }

            let handle = app.handle().clone();

            // Data dir + log file first, so everything below is diagnosable even
            // when it fails. GUI apps on Windows have no visible stderr.
            let data_dir = handle
                .path()
                .home_dir()
                .map(|h| h.join(".nexux"))
                .unwrap_or_else(|_| PathBuf::from(".nexux"));
            std::fs::create_dir_all(&data_dir).ok();
            let log_file = Some(data_dir.join("native.log"));
            log_line(&log_file, "[native] setup start");

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

            let db_path = data_dir.join("nexux.db");
            let db_url = format!("file:{}", db_path.to_string_lossy());

            // Refuse to start on an occupied port instead of racing for it. The
            // sidecar would die with EADDRINUSE and the readiness probe — which
            // only knows "something answers on 3030" — would then point the
            // window at *whoever* owns it: a second install, or an orphaned
            // sidecar from an app that was killed rather than closed. That
            // renders someone else's build inside this window, which is far
            // harder to diagnose than being told the port is taken.
            if port_in_use(SIDECAR_HOST, SIDECAR_PORT) {
                log_line(
                    &log_file,
                    &format!(
                        "[native] ERROR: port {SIDECAR_PORT} is already in use — \
                         another Nexus (or an orphaned sidecar) is running. Not starting."
                    ),
                );
                show_status(
                    &handle,
                    &format!(
                        "Nexus is already running, or a previous one did not shut down. \
                         Something else is using port {SIDECAR_PORT} — close it and reopen Nexus."
                    ),
                );
                return Ok(());
            }

            let port_str = SIDECAR_PORT.to_string();
            let sidecar = match handle.shell().sidecar("node") {
                Ok(s) => s,
                Err(e) => {
                    log_line(&log_file, &format!("[native] sidecar setup error: {e}"));
                    return Ok(());
                }
            };

            let spawned = sidecar
                .args([server_js.to_string_lossy().to_string()])
                .env("PORT", &port_str)
                .env("HOSTNAME", SIDECAR_HOST)
                .env("NEXUX_TERMINAL_PORT", SIDECAR_TERMINAL_PORT.to_string())
                .env("NEXUX_MODE", "local")
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
            let log_pipe = log_file.clone();
            let died_pipe = sidecar_died.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            log_line(
                                &log_pipe,
                                &format!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end()),
                            );
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
            // The port was free before we spawned, so whatever answers now is
            // ours. Watching `sidecar_died` alongside it turns a server that
            // exits during startup into a message on screen instead of a
            // half-minute of "Starting…" followed by silence.
            let ready_handle = handle.clone();
            let ready_log = log_file.clone();
            let ready_died = sidecar_died.clone();
            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                let timeout = Duration::from_secs(SIDECAR_READY_TIMEOUT_SECS);
                loop {
                    if ready_died.load(Ordering::SeqCst) {
                        log_line(
                            &ready_log,
                            "[native] ERROR: sidecar exited before it was ready",
                        );
                        show_status(
                            &ready_handle,
                            "Nexus's server stopped while starting. \
                             See ~/.nexux/native.log for what it reported.",
                        );
                        return;
                    }
                    if port_in_use(SIDECAR_HOST, SIDECAR_PORT) {
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
                log_line(&ready_log, "[native] sidecar ready, navigating webview");
                if let Some(window) = ready_handle.get_webview_window("main") {
                    let url = format!("http://{SIDECAR_HOST}:{SIDECAR_PORT}");
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
        .on_menu_event(|app, event| {
            let current = *app.state::<ZoomLevel>().0.lock().unwrap();
            match event.id().as_ref() {
                "zoom_in" => apply_zoom(app, current * ZOOM_STEP),
                "zoom_out" => apply_zoom(app, current / ZOOM_STEP),
                "zoom_reset" => apply_zoom(app, 1.0),
                _ => {}
            }
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
