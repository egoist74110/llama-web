#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod job;
mod resources;
mod update;

use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const NO_WINDOW: u32 = 0x08000000;
/// Longest the launcher waits for the hidden main window to report a finished page load.
const MAIN_REVEAL_TIMEOUT: Duration = Duration::from_secs(10);
/// The launcher is created hidden; it only appears when the user has to act or startup is slow.
const LAUNCHER_DELAY: Duration = Duration::from_millis(2500);
const PREFIX: &str = "LLAMA_WEB_DESKTOP ";
fn ready_port(line: &str, session: &str, pid: u32) -> Option<u16> {
    let msg: serde_json::Value = serde_json::from_str(line.strip_prefix(PREFIX)?).ok()?;
    if msg["version"] != 1
        || msg["session"] != session
        || msg["pid"] != pid
        || msg["type"] != "ready"
    {
        return None;
    }
    msg["port"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 65535)
        .map(|n| n as u16)
}
/// Startup failure reported over the private channel, as a launcher string key plus the port.
fn failure_reason(line: &str, session: &str, pid: u32) -> Option<String> {
    let msg: serde_json::Value = serde_json::from_str(line.strip_prefix(PREFIX)?).ok()?;
    if msg["version"] != 1
        || msg["session"] != session
        || msg["pid"] != pid
        || msg["type"] != "error"
    {
        return None;
    }
    let reason = msg["reason"]
        .as_str()
        .filter(|r| matches!(*r, "portInUse" | "listenFailed"))?;
    let port = msg["port"].as_u64().filter(|n| *n > 0 && *n <= 65535)?;
    Some(format!("{reason}:{port}"))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    phase: String,
    detail: String,
    data_dir: String,
}
struct Running {
    child: Child,
    input: ChildStdin,
    session: String,
    _job: job::Job,
}
struct Inner {
    running: Option<Running>,
    status: Status,
    generation: u64,
    quitting: bool,
    /// Update installer the service asked for; started after the service has stopped.
    install: Option<update::Request>,
}
type State = Arc<Mutex<Inner>>;

fn local_launcher(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "launcher" {
        return Err("Access denied".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if url.scheme() != "tauri" && url.host_str() != Some("tauri.localhost") {
        return Err("Access denied".into());
    }
    Ok(())
}
#[tauri::command]
fn desktop_status(
    window: tauri::WebviewWindow,
    state: tauri::State<State>,
) -> Result<Status, String> {
    local_launcher(&window)?;
    Ok(state.lock().unwrap().status.clone())
}
#[tauri::command]
fn desktop_retry(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    local_launcher(&window)?;
    start(app);
    Ok(())
}
#[tauri::command]
fn desktop_quit(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    local_launcher(&window)?;
    quit(app);
    Ok(())
}
#[tauri::command]
fn desktop_import(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    recover: Option<bool>,
) -> Result<(), String> {
    local_launcher(&window)?;
    let state = app.state::<State>();
    let mut inner = state.lock().unwrap();
    let recovering = recover.unwrap_or(false);
    if inner.status.phase != (if recovering { "recover" } else { "choose" })
        || inner.running.is_some()
        || inner.quitting
    {
        return Err("Import is available only before first launch".into());
    }
    inner.status.phase = if recovering {
        "recovering"
    } else {
        "importing"
    }
    .into();
    inner.status.detail.clear();
    inner.generation += 1;
    let generation = inner.generation;
    let target = inner.status.data_dir.clone();
    drop(inner);
    thread::spawn(move || {
        let source = if recovering {
            None
        } else {
            rfd::FileDialog::new().pick_folder()
        };
        let result = (|| -> Result<bool, String> {
            if !recovering && source.is_none() {
                return Ok(false);
            }
            if app.state::<State>().lock().unwrap().quitting {
                return Ok(false);
            }
            let resource = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("resources");
            let mut command = Command::new(resource.join("bun.exe"));
            let cached = resources::writable_resources(&resource, &cache_root(&app)?)?;
            command.arg(cached.join("import-data.mjs"));
            if recovering {
                command.arg("--recover");
            } else {
                command.arg(source.unwrap());
            }
            let mut child = command
                .arg(&target)
                .creation_flags(NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            let job = match job::Job::attach(&child) {
                Ok(job) => job,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };
            let errors = child.stderr.take().unwrap();
            let input = child.stdin.take().unwrap();
            let state = app.state::<State>();
            let mut inner = state.lock().unwrap();
            if inner.quitting {
                drop(job);
                let _ = child.wait();
                return Ok(false);
            }
            inner.running = Some(Running {
                child,
                input,
                session: String::new(),
                _job: job,
            });
            drop(inner);
            let error = Arc::new(Mutex::new(String::new()));
            let tail = error.clone();
            thread::spawn(move || {
                for line in BufReader::new(errors).lines().map_while(Result::ok) {
                    *tail.lock().unwrap() = line.chars().take(1200).collect();
                }
            });
            loop {
                thread::sleep(Duration::from_millis(100));
                let state = app.state::<State>();
                let mut inner = state.lock().unwrap();
                if inner.quitting {
                    return Ok(false);
                }
                if let Some(running) = inner.running.as_mut() {
                    if let Some(code) = running.child.try_wait().map_err(|e| e.to_string())? {
                        inner.running.take();
                        if !code.success() {
                            return Err(error.lock().unwrap().clone());
                        }
                        return Ok(true);
                    }
                } else {
                    return Ok(false);
                }
            }
        })();
        let state = app.state::<State>();
        let mut inner = state.lock().unwrap();
        if inner.quitting || generation != inner.generation {
            return;
        }
        inner.running.take();
        inner.status.phase = if PathBuf::from(&target)
            .join("run/import.pending.json")
            .exists()
        {
            "recover"
        } else {
            "choose"
        }
        .into();
        if let Err(ref error) = result {
            inner.status.detail = error.clone();
        }
        drop(inner);
        if matches!(result, Ok(true)) && PathBuf::from(&target).join("settings.json").is_file() {
            start(app);
        }
    });
    Ok(())
}
/// Short per-user runtime cache shared by every data directory (single-instance shell is its only writer).
fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("rc"))
}
fn fail(app: &tauri::AppHandle, generation: u64, detail: String) {
    let state = app.state::<State>();
    let mut inner = state.lock().unwrap();
    if generation != inner.generation || inner.quitting {
        return;
    }
    inner.running.take(); // Dropping the job ends only the tree owned by this launch.
    inner.status.phase = "error".into();
    inner.status.detail = detail;
    drop(inner);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.destroy();
    }
    if let Some(window) = app.get_webview_window("launcher") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
/// Shows the main window and hides the launcher in one step, so only one window is ever visible.
fn reveal_main(app: &tauri::AppHandle) {
    let state = app.state::<State>();
    let inner = state.lock().unwrap();
    if inner.quitting || inner.status.phase != "ready" {
        return;
    }
    drop(inner);
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if !main.is_visible().unwrap_or(false) {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.hide();
    }
}
/// Shows the launcher when no main window is visible yet (slow startup).
fn show_launcher_if_waiting(app: &tauri::AppHandle) {
    let state = app.state::<State>();
    if state.lock().unwrap().quitting {
        return;
    }
    let main_visible = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if main_visible {
        return;
    }
    if let Some(launcher) = app.get_webview_window("launcher") {
        let _ = launcher.show();
    }
}
fn show_main(app: &tauri::AppHandle, port: u16, generation: u64) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<State>();
        let inner = state.lock().unwrap();
        if generation != inner.generation || inner.quitting || inner.status.phase != "ready" {
            return;
        }
        drop(inner);
        let url = format!("http://127.0.0.1:{port}");
        let allowed = url.clone();
        let focus = handle.clone();
        let built =
            WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("llama-web")
                // Stay hidden until the page has loaded so the launcher is never shown beside a blank main window.
                .visible(false)
                .inner_size(1200.0, 820.0)
                .min_inner_size(760.0, 560.0)
                .on_navigation(move |target| {
                    if target.origin().ascii_serialization() == allowed {
                        return true;
                    }
                    if matches!(target.scheme(), "http" | "https") {
                        let _ = open::that_detached(target.as_str());
                    }
                    false
                })
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = open::that_detached(url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(move |_, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        reveal_main(&focus);
                    }
                })
                .build();
        if let Err(error) = built {
            fail(&handle, generation, error.to_string());
            return;
        }
        // A page that never reports a finished load must not leave the user on the launcher forever.
        thread::spawn(move || {
            thread::sleep(MAIN_REVEAL_TIMEOUT);
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || reveal_main(&app));
        });
    });
}
fn start(app: tauri::AppHandle) {
    let state = app.state::<State>();
    let mut inner = state.lock().unwrap();
    if inner.quitting
        || inner.running.is_some()
        || !matches!(inner.status.phase.as_str(), "idle" | "choose" | "error")
    {
        return;
    }
    if PathBuf::from(&inner.status.data_dir)
        .join("run/import.pending.json")
        .exists()
    {
        inner.status.phase = "recover".into();
        inner.status.detail.clear();
        return;
    }
    inner.generation += 1;
    let generation = inner.generation;
    inner.status.phase = "starting".into();
    inner.status.detail.clear();
    let data_dir = inner.status.data_dir.clone();
    drop(inner);
    thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let resource = app
                .path()
                .resource_dir()
                .map_err(|e| e.to_string())?
                .join("resources");
            if PathBuf::from(&data_dir)
                .join("run/import.pending.json")
                .exists()
            {
                return Err("importPending".into());
            }
            let bun = resource.join("bun.exe");
            let cached = resources::writable_resources(&resource, &cache_root(&app)?)?;
            let entry = cached.join("app/server/index.mjs");
            if !bun.is_file() || !entry.is_file() {
                return Err("runtimeMissing".into());
            }
            let session = uuid::Uuid::new_v4().to_string();
            let mut command = Command::new(&bun);
            command
                .arg(&entry)
                .current_dir(cached.join("app"))
                .env("LLAMA_WEB_DATA", data_dir)
                .env("LLAMA_WEB_DESKTOP_SESSION", &session)
                .env_remove("PORT")
                .env_remove("HOST")
                .env_remove("NITRO_PORT")
                .env_remove("NITRO_HOST")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(NO_WINDOW);
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let job = match job::Job::attach(&child) {
                Ok(job) => job,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            };
            let pid = child.id();
            let input = child.stdin.take().unwrap();
            let output = child.stdout.take().unwrap();
            let errors = child.stderr.take().unwrap();
            let state = app.state::<State>();
            let mut inner = state.lock().unwrap();
            if inner.quitting || generation != inner.generation {
                drop(job);
                let _ = child.wait();
                return Ok(());
            }
            inner.running = Some(Running {
                child,
                input,
                session: session.clone(),
                _job: job,
            });
            drop(inner);
            let error_tail = Arc::new(Mutex::new(String::new()));
            let tail = error_tail.clone();
            thread::spawn(move || {
                for line in BufReader::new(errors).lines().map_while(Result::ok) {
                    let mut text = tail.lock().unwrap();
                    // Keep bounded diagnostics; backend logs already redact credentials.
                    *text = line.chars().take(1200).collect();
                }
            });
            let reported = Arc::new(Mutex::new(None::<String>));
            let report = reported.clone();
            let reader_app = app.clone();
            let reader = thread::spawn(move || {
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    if let Some(reason) = failure_reason(&line, &session, pid) {
                        *report.lock().unwrap() = Some(reason);
                        continue;
                    }
                    if let Some(request) = update::request(&line, &session, pid) {
                        let state = reader_app.state::<State>();
                        let mut inner = state.lock().unwrap();
                        if generation != inner.generation || inner.quitting {
                            continue;
                        }
                        inner.install = Some(request);
                        drop(inner);
                        quit(reader_app.clone());
                        continue;
                    }
                    let Some(port) = ready_port(&line, &session, pid) else {
                        continue;
                    };
                    let state = reader_app.state::<State>();
                    let mut inner = state.lock().unwrap();
                    if generation != inner.generation
                        || inner.quitting
                        || inner.status.phase != "starting"
                    {
                        continue;
                    }
                    inner.status.phase = "ready".into();
                    drop(inner);
                    show_main(&reader_app, port, generation);
                }
            });
            let deadline = Instant::now() + Duration::from_secs(45);
            loop {
                thread::sleep(Duration::from_millis(100));
                let state = app.state::<State>();
                let mut inner = state.lock().unwrap();
                if generation != inner.generation || inner.quitting {
                    return Ok(());
                }
                let Some(running) = inner.running.as_mut() else {
                    return Ok(());
                };
                if let Some(code) = running.child.try_wait().map_err(|e| e.to_string())? {
                    drop(inner);
                    // The pipe closes with the process; give the reader a bounded moment for a final report.
                    let wait = Instant::now() + Duration::from_secs(2);
                    while !reader.is_finished() && Instant::now() < wait {
                        thread::sleep(Duration::from_millis(20));
                    }
                    if let Some(reason) = reported.lock().unwrap().take() {
                        return Err(reason);
                    }
                    return Err(format!(
                        "Service exited ({code}). {}",
                        error_tail.lock().unwrap()
                    ));
                }
                if inner.status.phase == "starting" && Instant::now() > deadline {
                    return Err("readyTimeout".into());
                }
            }
        })();
        if let Err(error) = result {
            fail(&app, generation, error);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_ready_requires_current_identity_and_valid_port() {
        let msg = |session: &str, pid: u32, port: u32| {
            format!(
                "{PREFIX}{}",
                serde_json::json!({
            "version": 1, "type": "ready", "session": session, "pid": pid, "port": port })
            )
        };
        assert_eq!(
            ready_port(&msg("current", 7, 5001), "current", 7),
            Some(5001)
        );
        assert_eq!(ready_port(&msg("old", 7, 5001), "current", 7), None);
        assert_eq!(ready_port(&msg("current", 8, 5001), "current", 7), None);
        assert_eq!(ready_port(&msg("current", 7, 0), "current", 7), None);
        assert_eq!(ready_port(&msg("current", 7, 65536), "current", 7), None);
        assert_eq!(ready_port("HTTP/1.1 200 OK", "current", 7), None);
    }
    #[test]
    fn private_failure_reason_requires_identity_and_known_code() {
        let msg = |session: &str, pid: u32, reason: &str| {
            format!(
                "{PREFIX}{}",
                serde_json::json!({
            "version": 1, "type": "error", "session": session, "pid": pid, "reason": reason, "port": 5001 })
            )
        };
        assert_eq!(
            failure_reason(&msg("current", 7, "portInUse"), "current", 7),
            Some("portInUse:5001".into())
        );
        assert_eq!(
            failure_reason(&msg("old", 7, "portInUse"), "current", 7),
            None
        );
        assert_eq!(
            failure_reason(&msg("current", 8, "portInUse"), "current", 7),
            None
        );
        assert_eq!(
            failure_reason(&msg("current", 7, "<b>x</b>"), "current", 7),
            None
        );
        assert_eq!(
            ready_port(&msg("current", 7, "portInUse"), "current", 7),
            None
        );
    }
    #[test]
    fn main_navigation_origin_rejects_other_ports_hosts_and_userinfo() {
        let allowed = "http://127.0.0.1:5001";
        for input in [
            "http://example.com:5001",
            "http://127.0.0.1:5002",
            "http://127.0.0.1:5001@example.com",
            "file:///C:/test",
        ] {
            let url: tauri::Url = input.parse().unwrap();
            assert_ne!(url.origin().ascii_serialization(), allowed);
        }
    }
    #[test]
    fn closing_job_ends_owned_process_and_preserves_unrelated_process() {
        fn child() -> Child {
            Command::new("cmd.exe")
                .args(["/C", "ping", "-n", "60", "127.0.0.1"])
                .creation_flags(NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
        let mut owned = child();
        let mut unrelated = child();
        let job = job::Job::attach(&owned).unwrap();
        drop(job);
        let end = Instant::now() + Duration::from_secs(5);
        while owned.try_wait().unwrap().is_none() && Instant::now() < end {
            thread::sleep(Duration::from_millis(50));
        }
        let ended = owned.try_wait().unwrap().is_some();
        let preserved = unrelated.try_wait().unwrap().is_none();
        let _ = owned.kill();
        let _ = owned.wait();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(ended);
        assert!(preserved);
    }
}
fn quit(app: tauri::AppHandle) {
    let state = app.state::<State>();
    let mut inner = state.lock().unwrap();
    if inner.quitting {
        return;
    }
    inner.quitting = true;
    let updating = inner.install.is_some();
    inner.status.phase = if updating { "updating" } else { "stopping" }.into();
    let running = inner.running.take();
    drop(inner);
    if updating {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        if let Some(launcher) = app.get_webview_window("launcher") {
            let _ = launcher.show();
            let _ = launcher.set_focus();
        }
    }
    thread::spawn(move || {
        if let Some(mut running) = running {
            let command =
                serde_json::json!({ "version": 1, "session": running.session, "type": "shutdown" });
            let _ = writeln!(running.input, "{command}");
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match running.child.try_wait() {
                    Ok(Some(_)) => break,
                    Err(_) => break,
                    _ => {}
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            drop(running._job);
            let _ = running.child.wait();
        }
        let state = app.state::<State>();
        let mut inner = state.lock().unwrap();
        let install = inner.install.take();
        let data_dir = PathBuf::from(&inner.status.data_dir);
        drop(inner);
        if let Some(request) = install {
            // Checked now that the service (the only other writer of that directory) has stopped.
            let started = update::verify(&request, Path::new(&data_dir)).and_then(|file| {
                Command::new(file)
                    .args(["/P", "/R", "/UPDATE"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())
            });
            if started.is_err() {
                let mut inner = state.lock().unwrap();
                inner.quitting = false;
                inner.status.phase = "error".into();
                inner.status.detail = "updateFailed".into();
                drop(inner);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.destroy();
                }
                return;
            }
        }
        app.exit(0);
    });
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // The main window stays hidden while it loads; only a visible one is worth raising.
            if let Some(window) = app
                .get_webview_window("main")
                .filter(|w| w.is_visible().unwrap_or(false))
                .or_else(|| app.get_webview_window("launcher"))
            {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            desktop_retry,
            desktop_quit,
            desktop_import
        ])
        .setup(|app| {
            let data_dir = match std::env::var_os("LLAMA_WEB_DATA") {
                Some(path) => {
                    let path = PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err("LLAMA_WEB_DATA must be absolute".into());
                    }
                    path
                }
                None => app.path().app_local_data_dir()?.join("data"),
            };
            let first = !data_dir.join("settings.json").exists();
            let pending = data_dir.join("run/import.pending.json").exists();
            app.manage(Arc::new(Mutex::new(Inner {
                running: None,
                generation: 0,
                quitting: false,
                install: None,
                status: Status {
                    phase: if pending {
                        "recover"
                    } else if first {
                        "choose"
                    } else {
                        "idle"
                    }
                    .into(),
                    detail: String::new(),
                    data_dir: data_dir.to_string_lossy().into(),
                },
            })));
            if !first && !pending {
                start(app.handle().clone());
                // Normal startup shows nothing until the main window is ready; a slow one gets the launcher.
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(LAUNCHER_DELAY);
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || show_launcher_if_waiting(&app));
                });
            } else if let Some(launcher) = app.get_webview_window("launcher") {
                // First launch (choose) and import recovery need the user at the launcher.
                let _ = launcher.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit(window.app_handle().clone());
            }
        })
        .build(tauri::generate_context!())
        .expect("Desktop initialization")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    quit(app.clone());
                }
            }
        });
}
