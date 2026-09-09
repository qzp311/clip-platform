#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, State,
};

const DEFAULT_API_BASE: &str = "http://127.0.0.1:8081";

#[derive(Serialize, Clone)]
struct InboxFile {
    name: String,
    path: String,
    size_bytes: u64,
    modified_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    drama_title: Option<String>,
}

#[derive(Serialize, Clone)]
struct ClipOutputView {
    name: String,
    path: String,
    task_id: Option<String>,
    size_bytes: u64,
    modified_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    drama_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    drama_id: Option<String>,
}

#[derive(Serialize, Clone)]
struct ExtractedFile {
    name: String,
    path: String,
    size_bytes: u64,
    modified_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    drama_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    drama_id: Option<String>,
}

#[derive(Serialize, Clone)]
struct TaskProgressView {
    active: bool,
    task_id: Option<String>,
    job_id: Option<String>,
    title: Option<String>,
    kind: Option<String>,
    phase_code: String,
    phase: String,
    step_current: Option<u32>,
    step_total: Option<u32>,
    download_bytes: Option<u64>,
    download_total_bytes: Option<u64>,
    download_percent: Option<f64>,
    error: Option<String>,
    updated_at: String,
}

struct AgentState {
    child: Mutex<Option<Child>>,
    process_child: Mutex<Option<Child>>,
    api_base: Mutex<String>,
    user_stopped: AtomicBool,
}

#[derive(Serialize, Clone)]
struct AgentStatus {
    running: bool,
    paused: bool,
    processing: bool,
    api_base: String,
    device_id: Option<String>,
    log_path: String,
    inbox_dir: String,
    output_dir: String,
    last_inbox_file: Option<String>,
    inbox_files: Vec<InboxFile>,
    clip_outputs: Vec<ClipOutputView>,
    extracted_files: Vec<ExtractedFile>,
    task_progress: TaskProgressView,
}

#[derive(Deserialize, Serialize, Clone)]
struct HighlightMarker {
    id: String,
    source_path: String,
    start_sec: f64,
    end_sec: f64,
    label: String,
    #[serde(default = "default_highlight_type")]
    highlight_type: String,
    #[serde(default)]
    usable_as_hook: bool,
    #[serde(default = "default_marker_source")]
    source: String,
    created_at: String,
}

fn default_highlight_type() -> String {
    "conflict".into()
}
fn default_marker_source() -> String {
    "human".into()
}

fn normalize_highlight_type(raw: &str) -> String {
    let t = raw.trim().to_lowercase();
    // 工位：高光=片头 hook，钩子=片尾 cliff
    if t.contains("钩子") || t == "cliff" || t.contains("悬念") {
        return "cliff".into();
    }
    if t == "hook" || t.contains("片头") || t.contains("高光") {
        return "hook".into();
    }
    match t.as_str() {
        "twist" | "反转" => "twist".into(),
        "conflict" | "冲突" | "" => "conflict".into(),
        _ => "conflict".into(),
    }
}

fn highlight_type_label(t: &str) -> &'static str {
    match t {
        "hook" => "高光",
        "cliff" => "钩子",
        "twist" => "反转",
        _ => "冲突",
    }
}

#[derive(Serialize, Clone)]
struct AgentAuthView { api_base: String, device_id: Option<String>, device_token: Option<String> }

fn repo_root(app: &AppHandle) -> PathBuf {
    // 绿色包：exe 旁有 portable.flag 时，始终以 exe 目录为准（忽略用户环境变量里的旧路径）
    if let Ok(exe_dir) = app.path().executable_dir() {
        if let Some(root) = resolve_install_root(&exe_dir) {
            if is_portable_root(&root) {
                apply_portable_process_env(&root);
                return root;
            }
        }
    }

    if let Ok(root) = std::env::var("CLIP_INSTALL_DIR").or_else(|_| std::env::var("CLIP_REPO_ROOT"))
    {
        let path = PathBuf::from(root.trim());
        if is_valid_install_root(&path) {
            if is_portable_root(&path) {
                apply_portable_process_env(&path);
            }
            return path;
        }
        append_desktop_log(&format!(
            "CLIP_REPO_ROOT/CLIP_INSTALL_DIR ignored (invalid install root): {}",
            path.display()
        ));
    }

    if let Ok(exe_dir) = app.path().executable_dir() {
        if let Some(root) = resolve_install_root(&exe_dir) {
            if is_portable_root(&root) {
                apply_portable_process_env(&root);
            }
            return root;
        }
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        if let Some(root) = resolve_install_root(&res_dir) {
            if is_portable_root(&root) {
                apply_portable_process_env(&root);
            }
            return root;
        }
    }

    // 开发态从 cargo target/release 启动时，回退到本机正式安装目录
    for fallback in known_install_fallbacks() {
        if is_valid_install_root(&fallback) {
            append_desktop_log(&format!(
                "using fallback install root: {}",
                fallback.display()
            ));
            return fallback;
        }
    }

    if let Ok(exe_dir) = app.path().executable_dir() {
        return exe_dir;
    }
    PathBuf::from(".")
}

/// 检测本机是否有可用的 NVIDIA GPU（CUDA），用于自动选择 ASR/渲染后端。
/// 优先用 nvidia-smi，再回退 WMI 查询显卡名称。
#[cfg(windows)]
fn has_nvidia_gpu() -> bool {
    // 方法1：nvidia-smi 存在且可运行
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(["-L"])
        .output()
    {
        if output.status.success() && !output.stdout.is_empty() {
            return true;
        }
    }
    // 方法2：WMI 查显卡名称
    let ps = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    if let Ok(output) = std::process::Command::new(ps)
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
        ])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
        if text.contains("nvidia") {
            return true;
        }
    }
    false
}

#[cfg(not(windows))]
fn has_nvidia_gpu() -> bool {
    false
}

/// 绿色免安装包标记：根目录存在 portable.flag
fn is_portable_root(path: &Path) -> bool {
    path.join("portable.flag").is_file()
}

/// 便携模式：仅进程内注入路径，不写 User 环境变量
fn apply_portable_process_env(root: &Path) {
    let data = root.join("data");
    let models = data.join("models");
    let _ = fs::create_dir_all(&models);
    std::env::set_var("CLIP_INSTALL_DIR", root);
    std::env::set_var("CLIP_REPO_ROOT", root);
    std::env::set_var("CLIP_DATA_ROOT", &data);
    std::env::set_var("CLIP_FUNASR_MODELS_DIR", &models);
    // 根据本机是否有 NVIDIA 显卡选择 ASR 后端；无 GPU 时走 CPU 自动降级
    let asr_backend = if has_nvidia_gpu() { "funasr-gpu" } else { "funasr-cpu" };
    let asr_device = if has_nvidia_gpu() { "cuda:0" } else { "cpu" };
    std::env::set_var("CLIP_ASR_BACKEND", asr_backend);
    std::env::set_var("CLIP_ASR_DEVICE", asr_device);
    let venv_py = funasr_venv_python(root);
    if venv_py.exists() {
        std::env::set_var("CLIP_PYTHON", &venv_py);
    }
}

/// 正式安装根：有 Agent CLI，且带 engines（排除 monorepo 的 apps/ 误匹配）
fn is_valid_install_root(path: &Path) -> bool {
    let cli_ok = path
        .join("clip-agent")
        .join("dist")
        .join("cli.js")
        .exists();
    if !cli_ok {
        return false;
    }
    path.join("engines").join("node").exists()
        || path.join("engines").join("funasr").exists()
        || path.join("clip-agent.cmd").exists()
}

fn known_install_fallbacks() -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(PathBuf::from(r"D:\ClipAgent"));
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("Programs").join("ClipAgent"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        out.push(PathBuf::from(pf).join("ClipAgent"));
    }
    out
}

fn resolve_install_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    for _ in 0..10 {
        if is_valid_install_root(&current) {
            return Some(current);
        }
        if !current.pop() {
            break;
        }
    }
    None
}

fn data_root() -> PathBuf {
    if let Ok(root) = std::env::var("CLIP_DATA_ROOT") {
        let trimmed = root.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    // 便携包：数据落在安装根/data（凭证/日志/模型随目录移动）
    for key in ["CLIP_INSTALL_DIR", "CLIP_REPO_ROOT"] {
        if let Ok(install) = std::env::var(key) {
            let path = PathBuf::from(install.trim());
            if is_portable_root(&path) {
                return path.join("data");
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local).join("ClipAgent");
    }
    dirs_fallback()
}

fn dirs_fallback() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".clip-agent");
    }
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("AppData").join("Local").join("ClipAgent"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn log_path() -> PathBuf {
    data_root().join("logs").join("agent.log")
}

fn normalize_media_path_key(path: &str) -> String {
    path.replace('/', "\\").trim().to_lowercase()
}

/// 从 local-dramas.json 建 path → (drama_title, drama_id)，供drama-clip回填剧名
fn load_local_drama_path_index() -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();
    let path = data_root().join("local-dramas.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return map;
    };
    let Some(dramas) = v.get("dramas").and_then(|d| d.as_object()) else {
        return map;
    };
    for row in dramas.values() {
        let drama_id = row
            .get("dramaId")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let title = row
            .get("title")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(drama_id.as_str())
            .to_string();
        if drama_id.is_empty() {
            continue;
        }
        let Some(episodes) = row.get("episodes").and_then(|e| e.as_array()) else {
            continue;
        };
        for ep in episodes {
            let Some(ep_path) = ep.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            let key = normalize_media_path_key(ep_path);
            if !key.is_empty() {
                map.insert(key, (title.clone(), drama_id.clone()));
            }
        }
    }
    map
}

/// 剧名 → dramaId（local-dramas 精确匹配）
fn load_local_drama_title_index() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let path = data_root().join("local-dramas.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return map;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return map;
    };
    let Some(dramas) = v.get("dramas").and_then(|d| d.as_object()) else {
        return map;
    };
    for row in dramas.values() {
        let drama_id = row
            .get("dramaId")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let title = row
            .get("title")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        if drama_id.is_empty() || title.is_empty() {
            continue;
        }
        map.entry(title).or_insert(drama_id);
    }
    map
}

/// 客户端导入分集也作为drama-clip素材源（带剧名），与 TOS 解压分集对称
fn list_catalog_source_files() -> Vec<ExtractedFile> {
    let path = data_root().join("local-dramas.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(dramas) = v.get("dramas").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in dramas.values() {
        let drama_id = row
            .get("dramaId")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let title = row
            .get("title")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| drama_id.clone());
        let Some(episodes) = row.get("episodes").and_then(|e| e.as_array()) else {
            continue;
        };
        for ep in episodes {
            let Some(ep_path) = ep.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            let p = PathBuf::from(ep_path);
            if !p.is_file() {
                continue;
            }
            let name = ep
                .get("name")
                .and_then(|n| n.as_str())
                .map(String::from)
                .unwrap_or_else(|| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("video.mp4")
                        .to_string()
                });
            let meta = p.metadata().ok();
            let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified_ms = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(ExtractedFile {
                name,
                path: p.to_string_lossy().to_string(),
                size_bytes,
                modified_ms,
                drama_title: title.clone(),
                drama_id: drama_id.clone(),
            });
        }
    }
    out
}

fn control_path() -> PathBuf {
    data_root().join("control.json")
}

fn agent_lock_path() -> PathBuf {
    data_root().join("agent.lock")
}

/// 读取 agent.lock 中的 pid；文件损坏或缺失时返回 None。
fn read_agent_lock_pid() -> Option<u32> {
    let path = agent_lock_path();
    let text = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("pid")?.as_u64().and_then(|p| u32::try_from(p).ok())
}

fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        // 不用 tasklist（会闪黑控制台），直接查进程句柄
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn CloseHandle(handle: isize) -> i32;
            fn GetExitCodeProcess(handle: isize, exit_code: *mut u32) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        hide_subprocess_console(&mut cmd);
        let _ = cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn clear_agent_lock_file() {
    let _ = fs::remove_file(agent_lock_path());
}

/// 桌面端重启后可能丢失 Child 句柄，但 agent.lock 对应进程仍在跑。
fn external_agent_pid() -> Option<u32> {
    let pid = read_agent_lock_pid()?;
    if is_pid_alive(pid) {
        Some(pid)
    } else {
        None
    }
}

fn inbox_dir() -> PathBuf {
    data_root().join("inbox")
}

fn credentials_path() -> PathBuf {
    data_root().join("credentials.json")
}

fn read_text_lossy(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => {
            // 去掉 UTF-8 BOM，避免 PowerShell Set-Content 写入后 JSON 解析失败
            let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
            String::from_utf8_lossy(&bytes[start..]).into_owned()
        }
        Err(e) => format!("（无法读取文件: {e}）"),
    }
}

fn config_path(root: &Path) -> PathBuf {
    root.join("config.json")
}

fn read_install_config(root: &Path) -> serde_json::Value {
    let path = config_path(root);
    if !path.exists() {
        return serde_json::json!({});
    }
    let text = read_text_lossy(&path);
    serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))
}

fn normalize_api_base(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("API 地址不能为空".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("API 地址须以 http:// 或 https:// 开头".to_string());
    }
    let mut normalized = trimmed.trim_end_matches('/').to_string();
    if normalized.starts_with("http://193.168.") {
        append_desktop_log(&format!(
            "api base typo corrected: {} -> {}",
            normalized,
            normalized.replacen("http://193.168.", "http://192.168.", 1)
        ));
        normalized = normalized.replacen("http://193.168.", "http://192.168.", 1);
    } else if normalized.starts_with("https://193.168.") {
        append_desktop_log(&format!(
            "api base typo corrected: {} -> {}",
            normalized,
            normalized.replacen("https://193.168.", "https://192.168.", 1)
        ));
        normalized = normalized.replacen("https://193.168.", "https://192.168.", 1);
    }
    Ok(normalized)
}

fn read_api_base_from_config(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let text = read_text_lossy(path);
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("apiBase")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn load_api_base(root: &Path) -> String {
    // 用户数据目录优先，避免重装/安装目录只读导致与 Agent 连不同云端
    if let Some(api) = read_api_base_from_config(&data_root().join("config.json")) {
        return api;
    }
    if let Some(api) = read_api_base_from_config(&config_path(root)) {
        return api;
    }
    if let Ok(v) = std::env::var("CLIP_API_BASE") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    DEFAULT_API_BASE.to_string()
}

fn save_api_base(root: &Path, api_base: &str) -> Result<(), String> {
    let mut map = read_install_config(root)
        .as_object()
        .cloned()
        .unwrap_or_default();
    map.insert(
        "apiBase".to_string(),
        serde_json::Value::String(api_base.to_string()),
    );
    let text =
        serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?;
    fs::write(config_path(root), &text).map_err(|e| e.to_string())?;
    // 用户在客户端修改的地址必须写入用户数据目录；安装目录可能只读，
    // 且升级/重装后不应覆盖用户选择。
    let user_config = data_root().join("config.json");
    fs::create_dir_all(data_root()).map_err(|e| e.to_string())?;
    fs::write(user_config, text).map_err(|e| e.to_string())?;
    sync_clip_api_base_env(api_base)
}

#[cfg(windows)]
fn hide_subprocess_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_subprocess_console(_cmd: &mut Command) {}

#[cfg(windows)]
fn sync_clip_api_base_env(value: &str) -> Result<(), String> {
    let mut cmd = Command::new("reg");
    hide_subprocess_console(&mut cmd);
    let status = cmd
        .args([
            "add",
            "HKCU\\Environment",
            "/v",
            "CLIP_API_BASE",
            "/t",
            "REG_EXPAND_SZ",
            "/d",
            value,
            "/f",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("无法更新环境变量 CLIP_API_BASE".to_string())
    }
}

#[cfg(not(windows))]
fn sync_clip_api_base_env(_value: &str) -> Result<(), String> {
    Ok(())
}

fn current_api_base(state: &State<AgentState>) -> Result<String, String> {
    state
        .api_base
        .lock()
        .map(|v| v.clone())
        .map_err(|e| e.to_string())
}

fn bundled_node(root: &Path) -> Result<PathBuf, String> {
    let node = root.join("engines").join("node").join("node.exe");
    if node.exists() {
        return Ok(node);
    }
    if let Ok(fallback) = std::env::var("CLIP_NODE") {
        let path = PathBuf::from(&fallback);
        if path.exists() || fallback == "node" {
            return Ok(path);
        }
    }
    Err(format!(
        "未找到 Node.js 运行时: {}。请重新运行drama-clip安装程序。",
        node.display()
    ))
}

fn agent_cli_js(root: &Path) -> PathBuf {
    root.join("clip-agent").join("dist").join("cli.js")
}

fn read_paused() -> bool {
    let path = control_path();
    if !path.exists() {
        return false;
    }
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("paused").and_then(|p| p.as_bool()))
        .unwrap_or(false)
}

fn write_paused(paused: bool) -> Result<(), String> {
    let root = data_root();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "paused": paused }).to_string();
    fs::write(control_path(), body).map_err(|e| e.to_string())
}

fn read_device_id() -> Option<String> {
    let path = credentials_path();
    if !path.exists() {
        return None;
    }
    let text = read_text_lossy(&path);
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("deviceId").and_then(|id| id.as_str().map(String::from)))
}

fn list_inbox_files() -> Vec<InboxFile> {
    let dir = inbox_dir();
    if !dir.exists() {
        return Vec::new();
    }
    let drama_index = load_local_drama_path_index();
    let mut files: Vec<(InboxFile, std::time::SystemTime)> = fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter(|e| is_video_path(&e.path()))
        .filter_map(|e| {
            let path = e.path();
            let meta = e.metadata().ok()?;
            let name = path.file_name()?.to_string_lossy().to_string();
            let path_str = path.to_string_lossy().to_string();
            let drama_title = drama_index
                .get(&normalize_media_path_key(&path_str))
                .map(|(title, _)| title.clone());
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            let modified_ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some((
                InboxFile {
                    name,
                    path: path_str,
                    size_bytes: meta.len(),
                    modified_ms,
                    drama_title,
                },
                modified,
            ))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.into_iter().map(|(f, _)| f).collect()
}

fn latest_inbox_file() -> Option<String> {
    list_inbox_files().into_iter().next().map(|f| f.path)
}

fn jobs_dir() -> PathBuf {
    data_root().join("jobs")
}

fn is_clip_output_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if !lower.ends_with(".mp4") {
        return false;
    }
    if lower.ends_with("-autoclip.mp4") || lower.ends_with("_autoclip.mp4") {
        return true;
    }
    // 桌面端手动区间导出
    if lower.contains("-manual-") || lower.contains("_manual_") {
        return true;
    }
    if lower == "output.mp4" {
        return true;
    }
    lower.starts_with("output-r") && lower.ends_with(".mp4")
}

fn configured_output_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(raw) = std::env::var("CLIP_LOCAL_OUTPUT_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            dirs.push(PathBuf::from(trimmed));
        }
    }
    let user_config = data_root().join("config.json");
    if user_config.exists() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&read_text_lossy(&user_config)) {
            if let Some(dir) = value
                .pointer("/render/limits/localOutputDir")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                dirs.push(PathBuf::from(dir));
            }
            if let Some(dir) = value
                .get("localOutputDir")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                dirs.push(PathBuf::from(dir));
            }
        }
    }
    dirs
}

fn resolve_output_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for dir in configured_output_dirs() {
        roots.push(dir);
    }
    let win_default = PathBuf::from("D:\\ClipOutput");
    if win_default.exists() {
        roots.push(win_default);
    }
    let data_outputs = data_root().join("outputs");
    if data_outputs.exists() || roots.is_empty() {
        roots.push(data_outputs);
    }
    roots.sort();
    roots.dedup();
    roots
}

fn resolve_ffmpeg_bin(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("CLIP_FFMPEG_PATH") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let candidates = [
        root.join("engines").join("ffmpeg").join("ffmpeg.exe"),
        root.join("engines").join("ffmpeg").join("ffmpeg"),
        root.join("ffmpeg").join("ffmpeg.exe"),
        root.join("ffmpeg").join("ffmpeg"),
        PathBuf::from("D:\\ClipAgent\\engines\\ffmpeg\\ffmpeg.exe"),
        PathBuf::from("C:\\Program Files\\ClipAgent\\engines\\ffmpeg\\ffmpeg.exe"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

fn resolve_ffprobe_bin(root: &Path) -> PathBuf {
    let ffmpeg = resolve_ffmpeg_bin(root);
    let sibling = ffmpeg
        .parent()
        .map(|p| p.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" }));
    if let Some(p) = sibling {
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" })
}


fn audio_cache_stem(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path
        .rsplit('/')
        .next()
        .unwrap_or("audio")
        .trim();
    let decoded = urlencoding_decode_lossy(raw);
    let stem = Path::new(&decoded)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let mut out = String::new();
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("audio");
    }
    // 截断过长文件名
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}

fn urlencoding_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                out.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 定位系统自带 curl.exe（System32 优先，PATH 兜底）
fn which_curl() -> PathBuf {
    if let Some(sysroot) = std::env::var_os("SystemRoot") {
        let system32 = PathBuf::from(sysroot).join("System32").join("curl.exe");
        if system32.exists() {
            return system32;
        }
    }
    PathBuf::from("curl.exe")
}

fn ffprobe_duration_sec(ffprobe: &Path, media: &Path) -> Result<f64, String> {
    let mut cmd = Command::new(ffprobe);
    hide_subprocess_console(&mut cmd);
    let output = cmd
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &media.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("无法启动 ffprobe: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let dur: f64 = text
        .parse()
        .map_err(|_| format!("无法解析音频时长: {text}"))?;
    if !(dur > 0.05) {
        return Err("音频时长无效".into());
    }
    Ok(dur)
}

#[derive(Serialize)]
struct LocalAudioView {
    path: String,
    duration: f64,
    name: String,
}

/// 将服务端音频下载并转成可预览的本地 mp3（浏览器无法直接播 wma）
#[tauri::command]
fn ensure_server_audio(
    app: AppHandle,
    url: String,
    name: Option<String>,
) -> Result<LocalAudioView, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持服务端音频 URL".into());
    }
    let path_only = url.split(['?', '#']).next().unwrap_or(url.as_str());
    let lower = path_only.to_ascii_lowercase();
    let ok = [".mp3", ".wma", ".wav", ".aac", ".m4a", ".flac", ".ogg"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !ok {
        return Err("不支持的音频格式".into());
    }

    let root = repo_root(&app);
    let ffmpeg = resolve_ffmpeg_bin(&root);
    let ffprobe = resolve_ffprobe_bin(&root);
    let cache_dir = data_root().join("audio-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let stem = audio_cache_stem(&url);
    let local = cache_dir.join(format!("{stem}.mp3"));
    let display_name = name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            urlencoding_decode_lossy(
                path_only
                    .rsplit('/')
                    .next()
                    .unwrap_or("音频.mp3"),
            )
        });

    let need_fetch = match fs::metadata(&local) {
        Ok(m) => m.len() < 1024,
        Err(_) => true,
    };
    if need_fetch {
        // 下载并转码为 mp3，保证预览可播、时长准确
        let mut cmd = Command::new(&ffmpeg);
        hide_subprocess_console(&mut cmd);
        let status = cmd
            .args([
                "-y",
                "-i",
                &url,
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "4",
                &local.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("无法启动 FFmpeg 下载音频（{}）: {e}", ffmpeg.display()))?;
        if !status.success() || !local.exists() {
            let _ = fs::remove_file(&local);
            return Err("下载/转码服务端音频失败（链接可能已过期，请重新打开选择器）".into());
        }
    }

    let duration = ffprobe_duration_sec(&ffprobe, &local)?;
    Ok(LocalAudioView {
        path: local.to_string_lossy().to_string(),
        duration,
        name: display_name,
    })
}

/// 将 TOS 成片下载到本机缓存，供 ASR 识别（不改动云端原片）
#[tauri::command]
fn ensure_local_output(
    app: AppHandle,
    url: String,
    name: Option<String>,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http(s) 成片地址".into());
    }
    let path_only = url.split(['?', '#']).next().unwrap_or(url.as_str());
    let lower = path_only.to_ascii_lowercase();
    let ok = [".mp4", ".mov", ".mkv", ".webm", ".m4v"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !ok {
        return Err("不支持的成片格式（需要 mp4/mov/mkv）".into());
    }

    let root = repo_root(&app);
    let ffmpeg = resolve_ffmpeg_bin(&root);
    let cache_dir = primary_output_dir().join("tos-dl");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let stem = audio_cache_stem(&url);
    let ext = Path::new(path_only)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    // 优先用展示名，便于素材库识别；非法字符交给 stem 兜底
    let file_stem = name
        .as_ref()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .map(|n| {
            let base = Path::new(n)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(n);
            let cleaned: String = base
                .chars()
                .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
                .collect();
            if cleaned.trim().is_empty() {
                stem.clone()
            } else {
                let cl = cleaned.to_ascii_lowercase();
                // 已是成片展示名则不再拼 URL stem，避免 name-_urlstem 重复导致错分类
                if cl.ends_with("-autoclip") || cl.ends_with("_autoclip") {
                    cleaned
                } else {
                    format!("{cleaned}-{stem}")
                }
            }
        })
        .unwrap_or_else(|| stem.clone());
    let local = cache_dir.join(format!("{file_stem}.{ext}"));
    // name 已用于文件名
    let _ = ();

    let need_fetch = match fs::metadata(&local) {
        Ok(m) => m.len() < 64 * 1024,
        Err(_) => true,
    };
    if need_fetch {
        let mut cmd = Command::new(&ffmpeg);
        hide_subprocess_console(&mut cmd);
        let status = cmd
            .args([
                "-y",
                "-i",
                &url,
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                &local.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("无法启动 FFmpeg 下载成片（{}）: {e}", ffmpeg.display()))?;
        if !status.success() || !local.exists() {
            let _ = fs::remove_file(&local);
            return Err("下载成片失败（链接可能已过期，请刷新后重试）".into());
        }
    }
    Ok(local.to_string_lossy().to_string())
}

/// 用户主动把 TOS 云端剧包 zip 下载到本地保存目录（默认 D:\\ClipOutput\\zip-imports）
#[tauri::command]
async fn download_drama_package_zip(
    app: AppHandle,
    url: String,
    package_name: Option<String>,
    drama_title: Option<String>,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http(s) 剧包下载地址".into());
    }
    let lower_path = url.split(['?', '#']).next().unwrap_or(url.as_str()).to_ascii_lowercase();
    if !lower_path.ends_with(".zip") {
        return Err("仅支持 .zip 剧包下载".into());
    }

    let root = repo_root(&app);
    let _ = resolve_ffmpeg_bin(&root);

    let out_dir = primary_output_dir().join("zip-imports");
    fs::create_dir_all(&out_dir).map_err(|e| format!("创建下载目录失败: {}", e))?;

    let name = package_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            Path::new(s)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|x| x.to_string())
                .unwrap_or_else(|| s.to_string())
        })
        .unwrap_or_else(|| {
            urlencoding_decode_lossy(
                lower_path
                    .rsplit('/')
                    .next()
                    .unwrap_or("package.zip"),
            )
        });
    let safe_name: String = name
        .chars()
        .map(|c| if r#"<>\"/\\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let local = out_dir.join(&safe_name);

    // 用 curl.exe 直下 zip（Windows 10 1803+ 自带）。
    // 不能用 FFmpeg：它没有 zip 解复用器，`-i xxx.zip` 必然失败。
    let curl = which_curl();
    let tmp = out_dir.join(format!("{}.part", safe_name));
    let mut cmd = Command::new(&curl);
    hide_subprocess_console(&mut cmd);
    let status = cmd
        .args([
            "-sS",
            "-L",
            "--fail",
            "--connect-timeout",
            "15",
            "--retry",
            "2",
            "-o",
            &tmp.to_string_lossy(),
            &url,
        ])
        .status()
        .map_err(|e| format!("无法启动 curl 下载剧包 ({}): {}", curl.display(), e))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        let code = status.code().unwrap_or(-1);
        return Err(match code {
            22 => format!("下载剧包失败：服务端返回错误（404/403，链接可能已过期，请刷新后重试）[{}]", code),
            28 => format!("下载剧包失败：连接超时 [{}]", code),
            6 => format!("下载剧包失败：无法解析下载地址 [{}]", code),
            7 => format!("下载剧包失败：无法连接服务器 [{}]", code),
            _ => format!("下载剧包失败（curl 退出码 {}，链接可能已过期，请刷新后重试）", code),
        });
    }
    if !tmp.exists() {
        return Err("下载剧包失败：未生成下载文件".into());
    }
    // 基本校验：zip 魔数 PK；空文件或 HTML 错误页直接判失败
    let mut magic = [0u8; 2];
    let magic_ok = fs::File::open(&tmp)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic))
        .map(|_| &magic == b"PK")
        .unwrap_or(false);
    if !magic_ok {
        let _ = fs::remove_file(&tmp);
        return Err("下载剧包失败：文件内容不是有效 zip（对象可能已被清理）".into());
    }
    if local.exists() {
        let _ = fs::remove_file(&local);
    }
    fs::rename(&tmp, &local).map_err(|e| format!("保存下载文件失败: {}", e))?;
    // 可选：在对应短剧目录下留下标记目录，便于用户后续导入
    if let Some(title) = drama_title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ = fs::create_dir_all(primary_output_dir().join(sanitize_drama_dir_name(title)));
    }

    Ok(local.to_string_lossy().to_string())
}

fn primary_output_dir() -> PathBuf {
    resolve_output_roots()
        .into_iter()
        .next()
        .unwrap_or_else(|| data_root().join("outputs"))
}

/// 剧名目录名清洗（用于 D:\ClipOutput\{剧名}\）
fn sanitize_drama_dir_name(title: &str) -> String {
    let mut trimmed = title.trim().to_string();
    for ext in [".zip", ".rar", ".7z", ".ZIP", ".RAR", ".7Z"] {
        if let Some(stripped) = trimmed.strip_suffix(ext) {
            trimmed = stripped.to_string();
            break;
        }
    }
    let safe: String = trimmed
        .chars()
        .map(|ch| {
            if "<>:\"/\\|?*".contains(ch) || ch.is_control() {
                '_'
            } else if ch.is_whitespace() {
                '\0'
            } else {
                ch
            }
        })
        .filter(|c| *c != '\0')
        .collect();
    let collapsed = safe
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    let out: String = collapsed.chars().take(80).collect();
    if out.is_empty() {
        "未分类".into()
    } else {
        out
    }
}

fn is_reserved_output_subdir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "manual-edits"
        || lower == "tos-dl"
        || lower.starts_with("mix-work")
}

/// 手动导出目录：优先落到成片所在短剧/任务目录；否则 D:\ClipOutput\{剧名}\
fn resolve_drama_export_dir(source_paths: &[&str], drama_title: Option<&str>) -> PathBuf {
    let root = primary_output_dir();
    for raw in source_paths {
        let p = PathBuf::from(raw);
        let Some(parent) = p.parent() else { continue };
        let Ok(rel) = parent.strip_prefix(&root) else { continue };
        let Some(first) = rel.components().next() else { continue };
        let Some(name) = first.as_os_str().to_str() else { continue };
        if name.is_empty() || is_reserved_output_subdir(name) {
            continue;
        }
        // 例：D:\ClipOutput\task-xxx\xxx.mp4 → 导出到同任务目录
        return root.join(name);
    }
    let title = drama_title
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "未分类")
        .unwrap_or("未分类");
    root.join(sanitize_drama_dir_name(title))
}

fn format_manual_autoclip_name(drama_title: &str, seq: usize) -> String {
    let title = sanitize_drama_dir_name(drama_title);
    let ts = chrono_like_compact_now();
    // 与 Agent 成片命名对齐：{剧名}-{批次}-{序号}-{时间戳}-autoclip.mp4；批次 00=手动导出
    format!("{title}-00-{seq}-{ts}-autoclip.mp4")
}

fn chrono_like_compact_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // 14 位毫秒时间戳，保证同秒多次导出不撞名
    let ms = now.as_millis();
    format!("{ms:014}")
}

fn ffprobe_has_audio(ffprobe: &Path, media: &str) -> bool {
    let mut cmd = Command::new(ffprobe);
    hide_subprocess_console(&mut cmd);
    let Ok(output) = cmd
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            media,
        ])
        .output()
    else {
        return false;
    };
    output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

/// 裁切片段：先流复制，失败再软编码（避免关键帧导致偶发失败）
fn ffmpeg_cut_segment(
    ffmpeg: &Path,
    source: &str,
    start: f64,
    end: f64,
    output: &Path,
) -> Result<(), String> {
    if !(end > start + 0.04) {
        return Err(format!("导出区间无效: {start:.2}..{end:.2}"));
    }
    let try_copy = || -> Result<(), String> {
        let mut cmd = Command::new(ffmpeg);
        hide_subprocess_console(&mut cmd);
        let status = cmd
            .args([
                "-y",
                "-ss",
                &start.to_string(),
                "-to",
                &end.to_string(),
                "-i",
                source,
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                &output.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("无法启动 FFmpeg: {e}"))?;
        if status.success() && output.exists() {
            Ok(())
        } else {
            Err("stream copy 失败".into())
        }
    };
    if try_copy().is_ok() {
        return Ok(());
    }
    let _ = fs::remove_file(output);
    let mut cmd = Command::new(ffmpeg);
    hide_subprocess_console(&mut cmd);
    let status = cmd
        .args([
            "-y",
            "-ss",
            &start.to_string(),
            "-to",
            &end.to_string(),
            "-i",
            source,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            &output.to_string_lossy(),
        ])
        .status()
        .map_err(|e| format!("无法启动 FFmpeg 重编码: {e}"))?;
    if status.success() && output.exists() {
        Ok(())
    } else {
        Err(format!("FFmpeg 裁切失败: {source}"))
    }
}

fn collect_clip_outputs_in_dir(
    dir: &Path,
    task_id: Option<String>,
    outputs: &mut Vec<ClipOutputView>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };

        if meta.is_dir() {
            let child_task_id = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| name.starts_with("task-"))
                .map(|name| name.to_string())
                .or_else(|| task_id.clone());
            collect_clip_outputs_in_dir(&path, child_task_id, outputs);
            continue;
        }

        if !meta.is_file() {
            continue;
        }

        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        if !is_clip_output_file(&name) {
            continue;
        }

        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);

        outputs.push(ClipOutputView {
            name,
            path: path.to_string_lossy().to_string(),
            task_id: task_id.clone(),
            size_bytes: meta.len(),
            modified_ms,
            drama_title: None,
            drama_id: None,
        });
    }
}

fn list_clip_outputs() -> Vec<ClipOutputView> {
    let mut outputs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let drama_index = load_local_drama_path_index();
    let title_index = load_local_drama_title_index();

    for root in resolve_output_roots() {
        if !root.exists() {
            continue;
        }
        collect_clip_outputs_in_dir(&root, None, &mut outputs);
    }

    // 1) local-dramas 路径索引（分集源路径）
    for item in &mut outputs {
        if item.drama_title.is_some() {
            continue;
        }
        if let Some((title, drama_id)) = drama_index.get(&normalize_media_path_key(&item.path)) {
            item.drama_title = Some(title.clone());
            if item.drama_id.is_none() {
                item.drama_id = Some(drama_id.clone());
            }
        }
    }

    // 2) 从成片文件名解析剧名：{剧名}-{批次}-{序号}-{时间戳}-autoclip.mp4
    for item in &mut outputs {
        if item.drama_title.is_some() {
            continue;
        }
        if let Some(title) = infer_drama_title_from_autoclip_name(&item.name) {
            item.drama_title = Some(title);
        }
    }

    // 3) 目录名即剧名：D:\ClipOutput\{剧名}\xxx.mp4
    for item in &mut outputs {
        if item.drama_title.is_some() {
            continue;
        }
        if let Some(title) = infer_drama_title_from_parent_dir(&item.path) {
            item.drama_title = Some(title);
        }
    }

    // 4) 同 task 目录内互相继承（手动导出落到 task-xxx 时）
    let mut task_titles: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for item in &outputs {
        if let (Some(tid), Some(title)) = (&item.task_id, &item.drama_title) {
            if !tid.is_empty() && !title.is_empty() && title != "未分类" {
                task_titles.entry(tid.clone()).or_insert_with(|| title.clone());
            }
        }
    }
    for item in &mut outputs {
        if item.drama_title.is_some() {
            continue;
        }
        if let Some(tid) = &item.task_id {
            if let Some(title) = task_titles.get(tid) {
                item.drama_title = Some(title.clone());
            }
        }
    }

    // 5) 有剧名时用 local-dramas 标题索引回填 drama_id
    for item in &mut outputs {
        if item.drama_id.is_some() {
            continue;
        }
        let Some(title) = item.drama_title.as_deref() else {
            continue;
        };
        if title.is_empty() || title == "未分类" {
            continue;
        }
        if let Some(drama_id) = title_index.get(title) {
            item.drama_id = Some(drama_id.clone());
        }
    }

    outputs.retain(|item| seen.insert(item.path.clone()));
    outputs.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    // 与云端成片合并展示，勿截太短（库中可达数百条）
    outputs.truncate(500);
    outputs
}

/// 从成片文件名解析剧名（与 formatAutoclipOutputFilename / 手动导出名一致）
fn infer_drama_title_from_autoclip_name(file_name: &str) -> Option<String> {
    let normalized = file_name.replace('\\', "/");
    let base = normalized
        .split('/')
        .next_back()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() {
        return None;
    }
    let lower = base.to_ascii_lowercase();
    if !lower.ends_with(".mp4") {
        return None;
    }
    // 去掉 .mp4（保持原大小写剧名）
    let mut stem = base[..base.len().saturating_sub(4)].to_string();

    // TOS 下载偶发 name-_urlstem 重复：xxx-autoclip-_-yyy → 只保留前半
    {
        let sl = stem.to_ascii_lowercase();
        if let Some(idx) = sl.find("-autoclip-_-") {
            stem.truncate(idx);
        } else if let Some(idx) = sl.find("-autoclip-_") {
            stem.truncate(idx);
        }
    }

    // 反复剥多余 -autoclip，直到稳定
    loop {
        let before = stem.clone();
        let stem_l2 = stem.to_ascii_lowercase();
        if stem_l2.ends_with("-autoclip") {
            stem.truncate(stem.len().saturating_sub("-autoclip".len()));
        } else if stem_l2.ends_with("_autoclip") {
            stem.truncate(stem.len().saturating_sub("_autoclip".len()));
        }
        if stem == before {
            break;
        }
    }

    // {title}-{batch}-{seq}-{ts}
    let parts: Vec<&str> = stem.rsplitn(4, '-').collect();
    if parts.len() < 4 {
        return None;
    }
    let ts = parts[0];
    let seq = parts[1];
    let batch = parts[2];
    let title = parts[3].trim();
    if ts.len() < 10 || !ts.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if seq.is_empty() || !seq.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if batch.is_empty() || !batch.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if title.is_empty() || title == "未分类" || title.eq_ignore_ascii_case("drama") {
        return None;
    }
    Some(title.to_string())
}

fn infer_drama_title_from_parent_dir(path: &str) -> Option<String> {
    let p = PathBuf::from(path);
    let parent = p.parent()?;
    let name = parent.file_name()?.to_str()?.trim();
    if name.is_empty() || name.starts_with("task-") || is_reserved_output_subdir(name) {
        return None;
    }
    let grand = parent.parent()?;
    for root in resolve_output_roots() {
        if grand == root.as_path() {
            return Some(name.to_string());
        }
    }
    None
}

fn read_package_cache_meta(cache_dir: &Path) -> (Option<String>, Option<String>) {
    let path = cache_dir.join("manifest.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return (None, None);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (None, None);
    };
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let drama_id = v
        .get("dramaId")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    (title, drama_id)
}

fn walk_extracted_videos(
    dir: &Path,
    drama_title: Option<String>,
    drama_id: Option<String>,
    out: &mut Vec<ExtractedFile>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            walk_extracted_videos(&path, drama_title.clone(), drama_id.clone(), out);
            continue;
        }
        if !meta.is_file() || !is_video_path(&path) {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(ExtractedFile {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            modified_ms,
            drama_title: drama_title.clone(),
            drama_id: drama_id.clone(),
        });
    }
}

fn list_extracted_files() -> Vec<ExtractedFile> {
    let root = data_root().join("workspace").join("packages").join("cache");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        // 无 TOS 缓存时仍返回客户端导入 catalog
        let mut catalog = list_catalog_source_files();
        catalog.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        catalog.truncate(200);
        return catalog;
    };
    for entry in entries.flatten() {
        let cache_dir = entry.path();
        if !cache_dir.is_dir() {
            continue;
        }
        let (drama_title, drama_id) = read_package_cache_meta(&cache_dir);
        let extract = cache_dir.join("extracted");
        if extract.is_dir() {
            walk_extracted_videos(&extract, drama_title, drama_id, &mut out);
        }
    }
    // 合并本地导入 catalog（与 TOS 解压同源展示）
    let mut seen: std::collections::HashSet<String> = out
        .iter()
        .map(|f| normalize_media_path_key(&f.path))
        .collect();
    for f in list_catalog_source_files() {
        let key = normalize_media_path_key(&f.path);
        if seen.insert(key) {
            out.push(f);
        }
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out.truncate(200);
    out
}

fn spawn_agent_env(cmd: &mut Command, root: &Path, api_base: &str) {
    let data = if is_portable_root(root) {
        apply_portable_process_env(root);
        root.join("data")
    } else {
        data_root()
    };
    let models = data.join("models");
    let ffmpeg = resolve_ffmpeg_bin(root);
    let ffprobe = resolve_ffprobe_bin(root);

    // 根据本机是否有 NVIDIA 显卡选择 ASR 后端与设备；无 GPU 时自动走 CPU
    let asr_backend = if has_nvidia_gpu() { "funasr-gpu" } else { "funasr-cpu" };
    let asr_device = std::env::var("CLIP_ASR_DEVICE")
        .unwrap_or_else(|_| if has_nvidia_gpu() { "cuda:0".into() } else { "cpu".into() });

    cmd.env("CLIP_REPO_ROOT", root)
        .env("CLIP_INSTALL_DIR", root)
        .env("CLIP_API_BASE", api_base)
        .env("CLIP_DATA_ROOT", &data)
        .env("CLIP_FUNASR_MODELS_DIR", &models)
        .env("CLIP_ASR_BACKEND", asr_backend)
        .env("CLIP_ASR_DEVICE", &asr_device)
        // GUI 进程 PATH 通常没有 ffmpeg；抽音轨 / VAD 兜底都依赖绝对路径
        .env("CLIP_FFMPEG_PATH", &ffmpeg)
        .env("CLIP_FFPROBE_PATH", &ffprobe)
        .env("FFMPEG_PATH", &ffmpeg);
    let venv_py = funasr_venv_python(root);
    if venv_py.exists() {
        cmd.env("CLIP_PYTHON", &venv_py);
    }
}

fn parse_task_progress_json(v: &serde_json::Value) -> TaskProgressView {
    TaskProgressView {
        active: v.get("active").and_then(|s| s.as_bool()).unwrap_or(false),
        task_id: v.get("taskId").and_then(|s| s.as_str()).map(String::from),
        job_id: v.get("jobId").and_then(|s| s.as_str()).map(String::from),
        title: v.get("title").and_then(|s| s.as_str()).map(String::from),
        kind: v.get("kind").and_then(|s| s.as_str()).map(String::from),
        phase_code: v
            .get("phaseCode")
            .and_then(|s| s.as_str())
            .unwrap_or("idle")
            .to_string(),
        phase: v
            .get("phase")
            .and_then(|s| s.as_str())
            .unwrap_or("空闲")
            .to_string(),
        step_current: v
            .get("stepCurrent")
            .and_then(|s| s.as_u64())
            .map(|n| n as u32),
        step_total: v
            .get("stepTotal")
            .and_then(|s| s.as_u64())
            .map(|n| n as u32),
        download_bytes: v.get("downloadBytes").and_then(|s| s.as_u64()),
        download_total_bytes: v.get("downloadTotalBytes").and_then(|s| s.as_u64()),
        download_percent: v.get("downloadPercent").and_then(|s| s.as_f64()),
        error: v.get("error").and_then(|s| s.as_str()).map(String::from),
        updated_at: v
            .get("updatedAt")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

fn read_task_progress() -> TaskProgressView {
    let path = data_root().join("task-progress.json");
    let idle = TaskProgressView {
        active: false,
        task_id: None,
        job_id: None,
        title: None,
        kind: None,
        phase_code: "idle".to_string(),
        phase: "空闲".to_string(),
        step_current: None,
        step_total: None,
        download_bytes: None,
        download_total_bytes: None,
        download_percent: None,
        error: None,
        updated_at: String::new(),
    };
    for attempt in 0..3 {
        let text = read_text_lossy(&path);
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => return parse_task_progress_json(&v),
            Err(_) if attempt < 2 => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return idle,
        }
    }
    idle
}

fn spawn_batch_pipeline_process(
    app: &AppHandle,
    state: &State<AgentState>,
    sources: &[String],
    subcommand: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    if sources.is_empty() {
        return Err("未选择任何视频文件".to_string());
    }
    if is_processing(state) {
        return Err("已有素材正在处理，请稍候".to_string());
    }
    for source in sources {
        if !Path::new(source).exists() {
            return Err(format!("文件不存在: {source}"));
        }
    }

    let root = repo_root(app);
    ensure_funasr_venv(&root)?;
    let api = current_api_base(state)?;
    let cli = agent_cli_js(&root);
    if !cli.exists() {
        return Err(format!(
            "未找到 Agent 程序: {}。请确认从安装目录启动，或重新运行安装程序。",
            cli.display()
        ));
    }
    let node = bundled_node(&root)?;
    let mut cmd = Command::new(&node);
    hide_subprocess_console(&mut cmd);
    cmd.arg(&cli)
        .arg(subcommand)
        .arg("--api-base")
        .arg(&api);

    for source in sources {
        cmd.arg("--source").arg(source);
    }
    cmd.args(extra_args);

    spawn_agent_env(&mut cmd, &root, &api);
    cmd.env("CLIP_DESKTOP_MANAGED", "1").env("CLIP_LOG_TO_STDOUT", "false");

    let venv_python = funasr_venv_python(&root);
    if venv_python.exists() {
        cmd.env("CLIP_PYTHON", &venv_python);
    }
    cmd.env("CLIP_FUNASR_MODELS_DIR", data_root().join("models"));

    if let Some(log) = open_log_append() {
        cmd.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut guard = state.process_child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    append_desktop_log(&format!("{subcommand} {} file(s)", sources.len()));
    Ok(())
}

fn spawn_pipeline_process(
    app: &AppHandle,
    state: &State<AgentState>,
    source: &str,
    subcommand: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    if is_processing(state) {
        return Err("已有素材正在处理，请稍候".to_string());
    }
    if !Path::new(source).exists() {
        return Err(format!("文件不存在: {source}"));
    }

    let root = repo_root(app);
    ensure_funasr_venv(&root)?;
    let api = current_api_base(state)?;
    let cli = agent_cli_js(&root);
    if !cli.exists() {
        return Err(format!(
            "未找到 Agent 程序: {}。请确认从安装目录启动，或重新运行安装程序。",
            cli.display()
        ));
    }
    let node = bundled_node(&root)?;
    let mut cmd = Command::new(&node);
    hide_subprocess_console(&mut cmd);
    cmd.arg(&cli)
        .arg(subcommand)
        .arg("--source")
        .arg(source)
        .arg("--api-base")
        .arg(&api)
        .args(extra_args);

    spawn_agent_env(&mut cmd, &root, &api);
    cmd.env("CLIP_DESKTOP_MANAGED", "1").env("CLIP_LOG_TO_STDOUT", "false");

    let venv_python = funasr_venv_python(&root);
    if venv_python.exists() {
        cmd.env("CLIP_PYTHON", &venv_python);
    }
    cmd.env("CLIP_FUNASR_MODELS_DIR", data_root().join("models"));

    if let Some(log) = open_log_append() {
        cmd.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut guard = state.process_child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    append_desktop_log(&format!("{subcommand} {source}"));
    Ok(())
}

fn append_desktop_log(line: &str) {
    let logs = data_root().join("logs");
    let _ = fs::create_dir_all(&logs);
    let path = logs.join("desktop.log");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {}", chrono_like_now(), line);
    }
}

fn chrono_like_now() -> String {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemTime {
            w_year: u16,
            w_month: u16,
            w_day_of_week: u16,
            w_day: u16,
            w_hour: u16,
            w_minute: u16,
            w_second: u16,
            w_milliseconds: u16,
        }
        extern "system" {
            fn GetLocalTime(lp_system_time: *mut SystemTime);
        }
        let mut st = SystemTime {
            w_year: 0,
            w_month: 0,
            w_day_of_week: 0,
            w_day: 0,
            w_hour: 0,
            w_minute: 0,
            w_second: 0,
            w_milliseconds: 0,
        };
        unsafe { GetLocalTime(&mut st) };
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            st.w_year, st.w_month, st.w_day, st.w_hour, st.w_minute, st.w_second
        );
    }
    #[cfg(not(windows))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // 非 Windows：UTC 近似可读时间（桌面端主路径是 Windows）
        let days = secs / 86400;
        let rem = secs % 86400;
        let h = rem / 3600;
        let m = (rem % 3600) / 60;
        let s = rem % 60;
        // 1970-01-01 起简易推算，仅兜底
        let mut y = 1970i64;
        let mut d = days as i64;
        loop {
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let diy = if leap { 366 } else { 365 };
            if d < diy {
                break;
            }
            d -= diy;
            y += 1;
        }
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let mdays = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let mut month = 1u32;
        for &len in &mdays {
            if d < len {
                break;
            }
            d -= len;
            month += 1;
        }
        format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, month, d + 1, h, m, s)
    }
}

fn open_log_append() -> Option<std::fs::File> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

fn funasr_venv_python(root: &Path) -> PathBuf {
    root.join("engines")
        .join("funasr")
        .join("venv")
        .join("Scripts")
        .join("python.exe")
}

fn funasr_venv_ready(root: &Path) -> bool {
    let python = funasr_venv_python(root);
    let marker = root
        .join("engines")
        .join("funasr")
        .join("venv")
        .join(".clip-ready");
    python.exists() && marker.exists()
}

/// 去掉 Windows 扩展路径前缀 \\?\ ，避免与 pyvenv.cfg / PowerShell 参数不一致
fn normalize_win_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// pyvenv.cfg 的 home 是否指向当前安装根下的 engines\python（换路径解压后需重激活）
fn funasr_venv_path_ok(root: &Path) -> bool {
    let root = normalize_win_path(root);
    let cfg = root
        .join("engines")
        .join("funasr")
        .join("venv")
        .join("pyvenv.cfg");
    let Ok(text) = fs::read_to_string(&cfg) else {
        return false;
    };
    let expected = root.join("engines").join("python");
    let expected_s = expected.to_string_lossy().replace('/', "\\");
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("home") {
            let value = rest
                .trim_start_matches([' ', '='])
                .trim()
                .trim_start_matches(r"\\?\")
                .replace('/', "\\");
            return value.eq_ignore_ascii_case(expected_s.as_ref());
        }
    }
    false
}

fn resolve_funasr_setup_script(start: &Path) -> Option<PathBuf> {
    // 优先离线激活（预置 venv），再回退联网安装脚本
    const NAMES: &[&str] = &["activate-funasr-engine.ps1", "setup-funasr-bundled.ps1"];
    let mut current = start.to_path_buf();
    for _ in 0..10 {
        for name in NAMES {
            let script = current.join("scripts").join(name);
            if script.exists() {
                return Some(script);
            }
        }
        if !current.pop() {
            break;
        }
    }
    None
}

#[cfg(windows)]
fn ensure_funasr_venv(root: &Path) -> Result<(), String> {
    if funasr_venv_ready(root) && funasr_venv_path_ok(root) {
        return Ok(());
    }

    let script = resolve_funasr_setup_script(root).ok_or_else(|| {
        format!(
            "FunASR 环境未安装，且缺少自动配置脚本：{}。请重新运行drama-clip安装程序。",
            root.join("scripts").join("activate-funasr-engine.ps1").display()
        )
    })?;

    let is_activate = script
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("activate-funasr-engine.ps1"))
        .unwrap_or(false);
    let portable = is_portable_root(root);
    if portable {
        apply_portable_process_env(root);
    }
    append_desktop_log(if is_activate {
        if portable {
            "FunASR venv — activating portable engine (rewrite pyvenv.cfg)"
        } else {
            "FunASR venv missing — activating bundled engine (offline)"
        }
    } else {
        "FunASR venv missing — running automatic first-time setup (3-8 min, network required)"
    });

    let script_norm = normalize_win_path(&script);
    let root_norm = normalize_win_path(root);
    let script_s = script_norm.to_string_lossy().into_owned();
    let root_s = root_norm.to_string_lossy().into_owned();
    append_desktop_log(&format!(
        "FunASR setup: root={root_s} script={script_s} portable={portable}"
    ));

    // 关键：不要在命令行传 -InstallDir D:\...（PowerShell 易解析失败）
    // 只通过 CLIP_ACTIVATE_INSTALL_DIR 传路径
    let mut args: Vec<String> = vec![
        "-NoProfile".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script_s.clone(),
    ];
    if portable && is_activate {
        args.push("-Portable".into());
    }

    // 托盘进程 PATH 可能不含 System32，不能依赖裸 `powershell.exe`
    let ps_exe = {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let p = std::path::PathBuf::from(&sys)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if p.is_file() {
            p
        } else {
            std::path::PathBuf::from("powershell.exe")
        }
    };
    let mut cmd = Command::new(&ps_exe);
    hide_subprocess_console(&mut cmd);
    cmd.env("CLIP_ACTIVATE_INSTALL_DIR", &root_s);
    let status = cmd
        .args(&args)
        .status()
        .map_err(|e| format!("failed to run FunASR setup ({}): {e}", ps_exe.display()))?;

    if !status.success() {
        return Err(format!(
            "FunASR 环境自动配置失败 ({status})。请检查网络连接后重启drama-clip，或重新运行安装程序。"
        ));
    }

    if !funasr_venv_ready(root) || !funasr_venv_path_ok(root) {
        return Err(
            "FunASR 配置脚本已运行但未完成。请检查网络后重启，或重新运行安装程序。".into(),
        );
    }

    append_desktop_log("FunASR venv ready");
    Ok(())
}

#[cfg(not(windows))]
fn ensure_funasr_venv(_root: &Path) -> Result<(), String> {
    Ok(())
}

fn spawn_agent_process(root: &Path, api_base: &str, subcommand: &str) -> Result<Child, String> {
    let cli = agent_cli_js(root);
    if !cli.exists() {
        return Err(format!(
            "未找到 Agent 程序: {}。请确认从安装目录启动，或重新运行安装程序。",
            cli.display()
        ));
    }

    let node = bundled_node(root)?;
    let mut cmd = Command::new(&node);
    hide_subprocess_console(&mut cmd);
    cmd.arg(&cli)
        .arg(subcommand)
        .args(["--api-base", api_base]);
    spawn_agent_env(&mut cmd, root, api_base);
    cmd.env("CLIP_DESKTOP_MANAGED", "1")
        .env("CLIP_LOG_TO_STDOUT", "false");

    let venv_python = funasr_venv_python(root);
    if venv_python.exists() {
        cmd.env("CLIP_PYTHON", &venv_python);
    }

    let models = data_root().join("models");
    cmd.env("CLIP_FUNASR_MODELS_DIR", &models);

    if let Some(log) = open_log_append() {
        cmd.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }

    cmd.spawn().map_err(|e| format!("spawn agent failed: {e}"))
}

fn start_agent(app: &AppHandle, state: &State<AgentState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }

    // 桌面端重启后 Child 句柄丢失，但外部 agent 仍持有 agent.lock
    if let Some(pid) = external_agent_pid() {
        append_desktop_log(&format!("reuse existing agent pid={pid}"));
        state.user_stopped.store(false, Ordering::SeqCst);
        write_paused(false)?;
        return Ok(());
    }
    // 残留锁文件（进程已死）会挡住新启动
    if agent_lock_path().exists() {
        clear_agent_lock_file();
        append_desktop_log("cleared stale agent.lock");
    }

    state.user_stopped.store(false, Ordering::SeqCst);

    let root = repo_root(app);
    ensure_funasr_venv(&root)?;
    let api = current_api_base(state)?;

    let node = bundled_node(&root)?;
    let cli = agent_cli_js(&root);
    if !cli.exists() {
        return Err(format!(
            "未找到 Agent 程序: {}。请确认从安装目录启动，或重新运行安装程序。",
            cli.display()
        ));
    }
    let mut reg = Command::new(&node);
    hide_subprocess_console(&mut reg);
    reg.arg(&cli).args(["register", "--api-base", &api]);
    spawn_agent_env(&mut reg, &root, &api);
    reg.env("CLIP_DESKTOP_MANAGED", "1").env("CLIP_LOG_TO_STDOUT", "false");
    if let Some(log) = open_log_append() {
        reg.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
    }
    let _ = reg.status();

    write_paused(false)?;
    let mut child = spawn_agent_process(&root, &api, "run")?;
    thread::sleep(Duration::from_millis(800));
    match child.try_wait() {
        Ok(Some(status)) => {
            append_desktop_log(&format!("agent exited immediately: {status}"));
            return Err(format!(
                "Agent 启动后立即退出 ({status})，请查看日志: {}",
                log_path().display()
            ));
        }
        Ok(None) => {}
        Err(e) => return Err(format!("check agent status failed: {e}")),
    }
    append_desktop_log("agent started");
    *guard = Some(child);
    Ok(())
}

fn stop_agent(state: &State<AgentState>) {
    state.user_stopped.store(true, Ordering::SeqCst);
    let mut stopped = false;
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            stopped = true;
        }
    }
    if let Ok(mut guard) = state.process_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
    // 杀掉桌面端未托管、但仍持有 agent.lock 的残留进程
    if let Some(pid) = external_agent_pid() {
        kill_pid(pid);
        stopped = true;
    }
    clear_agent_lock_file();
    if stopped {
        append_desktop_log("agent stopped");
    }
}

fn is_running(state: &State<AgentState>) -> bool {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                }
                Ok(None) => return true,
                Err(_) => {}
            }
        }
    }
    external_agent_pid().is_some()
}

fn is_processing(state: &State<AgentState>) -> bool {
    if let Ok(mut guard) = state.process_child.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    return false;
                }
                Ok(None) => return true,
                Err(_) => return false,
            }
        }
    }
    false
}

#[tauri::command]
fn get_agent_status(_app: AppHandle, state: State<AgentState>) -> Result<AgentStatus, String> {
    Ok(AgentStatus {
        running: is_running(&state),
        paused: read_paused(),
        processing: is_processing(&state),
        api_base: current_api_base(&state)?,
        device_id: read_device_id(),
        log_path: log_path().to_string_lossy().to_string(),
        inbox_dir: inbox_dir().to_string_lossy().to_string(),
        output_dir: primary_output_dir().to_string_lossy().to_string(),
        last_inbox_file: latest_inbox_file(),
        inbox_files: list_inbox_files(),
        clip_outputs: list_clip_outputs(),
        extracted_files: list_extracted_files(),
        task_progress: read_task_progress(),
    })
}

#[tauri::command]
fn start_agent_cmd(app: AppHandle, state: State<AgentState>) -> Result<(), String> {
    start_agent(&app, &state)
}

#[tauri::command]
fn stop_agent_cmd(state: State<AgentState>) -> Result<(), String> {
    stop_agent(&state);
    Ok(())
}

#[tauri::command]
fn pause_agent_cmd() -> Result<(), String> {
    write_paused(true)?;
    append_desktop_log("agent paused");
    Ok(())
}

#[tauri::command]
fn resume_agent_cmd() -> Result<(), String> {
    write_paused(false)?;
    append_desktop_log("agent resumed");
    Ok(())
}

#[tauri::command]
fn append_agent_log(line: String) -> Result<(), String> {
    let text = line.trim();
    if text.is_empty() {
        return Ok(());
    }
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "[{}] {}", chrono_like_now(), text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_agent_logs(max_lines: usize) -> Result<String, String> {
    let path = log_path();
    if !path.exists() {
        return Ok(String::from("（暂无日志，点击「启动服务」后此处会显示运行日志）\n"));
    }

    let content = read_text_lossy(&path);
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max_lines {
        return Ok(content);
    }
    Ok(lines[lines.len() - max_lines..].join("\n") + "\n")
}

#[tauri::command]
fn set_api_base_cmd(app: AppHandle, state: State<AgentState>, api_base: String) -> Result<String, String> {
    let normalized = normalize_api_base(&api_base)?;
    let root = repo_root(&app);
    save_api_base(&root, &normalized)?;

    {
        let mut guard = state.api_base.lock().map_err(|e| e.to_string())?;
        *guard = normalized.clone();
    }

    let was_running = is_running(&state);
    if was_running {
        stop_agent(&state);
        start_agent(&app, &state)?;
        append_desktop_log(&format!("api base updated, agent restarted: {normalized}"));
    } else {
        append_desktop_log(&format!("api base updated: {normalized}"));
    }

    Ok(normalized)
}

#[tauri::command]
fn open_inbox_dir() -> Result<(), String> {
    let dir = inbox_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return Err("open inbox folder is only supported on Windows".to_string());
    }
    Ok(())
}

#[tauri::command]
fn open_output_dir() -> Result<(), String> {
    let dir = primary_output_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return Err("open output folder is only supported on Windows".to_string());
    }
    Ok(())
}

#[tauri::command]
fn reveal_clip_output(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("成片文件不存在".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &target.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return Err("reveal file is only supported on Windows".to_string());
    }
    Ok(())
}

#[tauri::command]
fn open_clip_output(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("成片文件不存在".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        child.wait().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        return Err("clipboard copy is only supported on Windows".to_string());
    }
}

fn highlights_path() -> PathBuf { data_root().join("highlight-markers.json") }

#[derive(Serialize, Clone)]
struct EpisodeAsrResolve {
    drama_id: Option<String>,
    package_task_id: Option<String>,
    mix_task_id: Option<String>,
    episode_no: Option<u32>,
    asr_task_id: Option<String>,
    episode_id: Option<String>,
    source_path: String,
}

fn parse_episode_no_from_path(path: &str) -> Option<u32> {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    for part in parts.iter().rev() {
        let base = part.rsplit_once('.').map(|(s, _)| s).unwrap_or(part);
        // 第N集 / epN / 纯数字 / 文件名尾部数字
        if let Some(caps) = regex_lite_episode(base) {
            return Some(caps);
        }
    }
    None
}

fn regex_lite_episode(base: &str) -> Option<u32> {
    let lower = base.to_lowercase();
    // 第3集
    if let Some(i) = lower.find('第') {
        let rest = &lower[i + '第'.len_utf8()..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with('集') {
            return digits.parse().ok();
        }
    }
    // ep12 / episode12
    for prefix in ["episode", "ep"] {
        if let Some(pos) = lower.find(prefix) {
            let after = &lower[pos + prefix.len()..];
            let trimmed = after.trim_start_matches(|c: char| c == '_' || c == '-' || c == ' ');
            let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
    }
    // 纯数字
    if base.chars().all(|c| c.is_ascii_digit()) {
        return base.parse().ok();
    }
    // 尾部 01 / -02-
    let chars: Vec<char> = base.chars().collect();
    let mut i = chars.len();
    while i > 0 && chars[i - 1].is_ascii_digit() {
        i -= 1;
    }
    if i < chars.len() {
        let digits: String = chars[i..].iter().collect();
        if (1..=3).contains(&digits.len()) {
            return digits.parse().ok();
        }
    }
    None
}

fn find_episode_asr_index(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    if current.is_file() {
        current.pop();
    }
    for _ in 0..12 {
        let candidate = current.join("episode-asr-index.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        let manifest = current.join("manifest.json");
        if manifest.is_file() {
            let sibling = current.join("episode-asr-index.json");
            if sibling.is_file() {
                return Some(sibling);
            }
        }
        if !current.pop() {
            break;
        }
    }
    None
}

fn find_nearest_package_manifest(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    if current.is_file() {
        current.pop();
    }
    for _ in 0..12 {
        let manifest = current.join("manifest.json");
        if manifest.is_file() {
            return Some(manifest);
        }
        if !current.pop() {
            break;
        }
    }
    None
}

fn read_drama_id_from_manifest(manifest: &Path) -> Option<String> {
    let text = fs::read_to_string(manifest).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("dramaId")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn read_drama_meta_from_manifest(manifest: &Path) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let text = match fs::read_to_string(manifest) {
        Ok(t) => t,
        Err(_) => return (None, None, None, None),
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return (None, None, None, None),
    };
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let genre = v
        .get("genre")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            v.get("genreTags")
                .and_then(|x| x.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find_map(|t| t.as_str().map(str::trim).filter(|s| !s.is_empty()))
                })
                .map(String::from)
        });
    let synopsis = v
        .get("synopsis")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let drama_type = v
        .get("dramaType")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    (title, genre, synopsis, drama_type)
}

#[tauri::command]
fn resolve_episode_asr_task(source_path: String) -> Result<EpisodeAsrResolve, String> {
    let empty = EpisodeAsrResolve {
        drama_id: None,
        package_task_id: None,
        mix_task_id: None,
        episode_no: None,
        asr_task_id: None,
        episode_id: None,
        source_path: source_path.clone(),
    };
    if source_path.is_empty() || source_path.starts_with("http://") || source_path.starts_with("https://") {
        return Ok(empty);
    }
    let path = PathBuf::from(&source_path);
    let mut drama_id: Option<String> = None;
    let mut package_task_id: Option<String> = None;
    let mut mix_task_id: Option<String> = None;
    let mut episode_no: Option<u32> = parse_episode_no_from_path(&source_path);
    let mut asr_task_id: Option<String> = None;
    let mut episode_id: Option<String> = None;

    if let Some(index_path) = find_episode_asr_index(&path) {
        let text = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        drama_id = v.get("dramaId").and_then(|x| x.as_str()).map(String::from);
        package_task_id = v.get("packageTaskId").and_then(|x| x.as_str()).map(String::from);
        mix_task_id = v.get("mixTaskId").and_then(|x| x.as_str()).map(String::from);
        let episodes = v.get("episodes").and_then(|x| x.as_object());

        // 优先按 sourcePath 精确匹配，其次按集号
        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
        let target = norm(&source_path);
        let mut hit: Option<&serde_json::Value> = None;
        if let Some(map) = episodes {
            for (k, entry) in map {
                let sp = entry.get("sourcePath").and_then(|x| x.as_str()).unwrap_or("");
                if !sp.is_empty() && norm(sp) == target {
                    hit = Some(entry);
                    episode_no = k
                        .parse()
                        .ok()
                        .or_else(|| entry.get("episodeNo").and_then(|x| x.as_u64()).map(|n| n as u32))
                        .or(episode_no);
                    break;
                }
            }
            if hit.is_none() {
                if let Some(no) = episode_no {
                    hit = map.get(&no.to_string());
                }
            }
        }
        if let Some(entry) = hit {
            asr_task_id = entry.get("taskId").and_then(|x| x.as_str()).map(String::from);
            episode_id = entry.get("episodeId").and_then(|x| x.as_str()).map(String::from);
            if episode_no.is_none() {
                episode_no = entry.get("episodeNo").and_then(|x| x.as_u64()).map(|n| n as u32);
            }
        }
    }

    // 客户端导入：local-dramas 路径 → data/drama-asr/{dramaId}/episode-asr-index.json
    if asr_task_id.is_none() {
        let index = load_local_drama_path_index();
        if let Some((_title, id)) = index.get(&normalize_media_path_key(&source_path)) {
            drama_id = Some(id.clone());
            let asr_index = data_root()
                .join("drama-asr")
                .join(id)
                .join("episode-asr-index.json");
            if asr_index.is_file() {
                if let Ok(text) = fs::read_to_string(&asr_index) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        package_task_id = v
                            .get("packageTaskId")
                            .and_then(|x| x.as_str())
                            .map(String::from)
                            .or(package_task_id);
                        mix_task_id = v
                            .get("mixTaskId")
                            .and_then(|x| x.as_str())
                            .map(String::from)
                            .or(mix_task_id);
                        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
                        let target = norm(&source_path);
                        if let Some(map) = v.get("episodes").and_then(|x| x.as_object()) {
                            for (k, entry) in map {
                                let sp =
                                    entry.get("sourcePath").and_then(|x| x.as_str()).unwrap_or("");
                                let matched = (!sp.is_empty() && norm(sp) == target)
                                    || episode_no.map(|n| k == &n.to_string()).unwrap_or(false);
                                if matched {
                                    asr_task_id = entry
                                        .get("taskId")
                                        .and_then(|x| x.as_str())
                                        .map(String::from);
                                    episode_id = entry
                                        .get("episodeId")
                                        .and_then(|x| x.as_str())
                                        .map(String::from);
                                    episode_no = k.parse().ok().or(episode_no);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 无索引或索引无 dramaId：从临近 manifest.json 补剧 ID，供云端回落
    if drama_id.is_none() {
        if let Some(manifest) = find_nearest_package_manifest(&path) {
            drama_id = read_drama_id_from_manifest(&manifest);
        }
    }

    Ok(EpisodeAsrResolve {
        drama_id,
        package_task_id,
        mix_task_id,
        episode_no,
        asr_task_id,
        episode_id,
        source_path,
    })
}

#[tauri::command]
fn process_episode_asr(
    app: AppHandle,
    state: State<AgentState>,
    source: String,
    drama_id: Option<String>,
    force: Option<bool>,
) -> Result<(), String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err("缺少源视频路径".into());
    }
    require_video_path(Path::new(&source))?;
    if is_processing(&state) {
        return Err("已有素材正在处理，请稍候".into());
    }

    let resolved = resolve_episode_asr_task(source.clone())?;
    let drama_id = drama_id
        .filter(|s| !s.is_empty())
        .or(resolved.drama_id)
        .ok_or("无法确定短剧 ID，请先导入或登记该分集")?;

    let mut extras: Vec<String> = vec!["--drama-id".into(), drama_id, "--asr-only".into()];
    if force.unwrap_or(false) {
        extras.push("--force-asr".into());
    }
    let extra_refs: Vec<&str> = extras.iter().map(String::as_str).collect();
    spawn_pipeline_process(&app, &state, &source, "run-drama-mix", &extra_refs)
}

/// 从混合日志文本中提取最后一个完整 JSON 对象
fn extract_trailing_json_object(text: &str) -> Option<String> {
    for line in text.lines().rev() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('{') {
            return Some(t.to_string());
        }
        if let Some(idx) = t.find('{') {
            let candidate = t[idx..].trim();
            if candidate.ends_with('}') {
                return Some(candidate.to_string());
            }
        }
    }
    // 整段文本里找最后一个 {...}
    if let Some(start) = text.rfind('{') {
        let candidate = text[start..].trim();
        if let Some(end) = candidate.rfind('}') {
            return Some(candidate[..=end].to_string());
        }
    }
    None
}

#[tauri::command]
fn get_highlight_markers(source_path: String) -> Result<Vec<HighlightMarker>, String> {
    let path = highlights_path();
    if !path.exists() { return Ok(Vec::new()); }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let all: Vec<HighlightMarker> = serde_json::from_str(&text).unwrap_or_default();
    Ok(all.into_iter().filter(|m| m.source_path == source_path).collect())
}

#[tauri::command]
fn get_agent_auth(state: State<AgentState>) -> Result<AgentAuthView, String> {
    let token = if credentials_path().exists() { serde_json::from_str::<serde_json::Value>(&read_text_lossy(&credentials_path())).ok().and_then(|v| v.get("deviceToken").and_then(|x| x.as_str().map(String::from))) } else { None };
    Ok(AgentAuthView { api_base: current_api_base(&state)?, device_id: read_device_id(), device_token: token })
}

#[derive(Deserialize, Clone)]
struct AudioOverlayArgs {
    path: String,
    /// 音频片段在主时间轴上的起点（秒）
    #[serde(alias = "timelineStart")]
    timeline_start: f64,
    /// 源文件裁剪入点
    #[serde(alias = "sourceIn")]
    source_in: f64,
    /// 源文件裁剪出点
    #[serde(alias = "sourceOut")]
    source_out: f64,
    /// 音频轨音量 0~1（默认 1）
    #[serde(default = "default_volume_one", alias = "audioVolume")]
    audio_volume: f64,
    /// 视频原声音量 0~1（默认 0 = 关闭原声）
    #[serde(default = "default_volume_zero", alias = "videoVolume")]
    video_volume: f64,
}

fn default_volume_one() -> f64 {
    1.0
}
fn default_volume_zero() -> f64 {
    0.0
}

/// 混入外部音轨（支持多段；可保留部分视频原声）
fn ffmpeg_mux_replace_audio(
    ffmpeg: &Path,
    video_input: &str,
    video_start: f64,
    video_end: f64,
    audios: &[AudioOverlayArgs],
    output: &Path,
) -> Result<(), String> {
    if !(video_end > video_start) {
        return Err("视频导出区间无效".into());
    }
    if audios.is_empty() {
        return Err("音频轨为空".into());
    }

    let export_dur = video_end - video_start;
    let mut prepared: Vec<(usize, u64, f64, f64, f64)> = Vec::new(); // (src_idx, delay_ms, a_in, a_dur, av)
    let mut video_vol = 0.0_f64;

    for (idx, audio) in audios.iter().enumerate() {
        if !(audio.source_out > audio.source_in) || audio.source_in < 0.0 {
            continue;
        }
        if audio.path.starts_with("http://") || audio.path.starts_with("https://") {
            let path_only = audio
                .path
                .split(['?', '#'])
                .next()
                .unwrap_or(audio.path.as_str());
            let lower = path_only.to_ascii_lowercase();
            let ok = [".mp3", ".wma", ".wav", ".aac", ".m4a", ".flac", ".ogg"]
                .iter()
                .any(|ext| lower.ends_with(ext));
            if !ok {
                return Err("音频轨仅支持服务端音频地址（mp3/wma/wav 等）".into());
            }
        } else if !PathBuf::from(&audio.path).exists() {
            return Err(format!("音频文件不存在: {}", audio.path));
        }

        video_vol = audio.video_volume.clamp(0.0, 2.0);
        let av = audio.audio_volume.clamp(0.0, 2.0);
        let rel = audio.timeline_start - video_start;
        let (delay_ms, a_in, a_dur) = if rel >= 0.0 {
            let delay = (rel * 1000.0).round().max(0.0) as u64;
            let remain = (export_dur - rel).max(0.05);
            let src_len = audio.source_out - audio.source_in;
            (delay, audio.source_in, remain.min(src_len))
        } else {
            let skip = (-rel).min(audio.source_out - audio.source_in);
            let a_in = audio.source_in + skip;
            let src_remain = (audio.source_out - a_in).max(0.05);
            (0u64, a_in, export_dur.min(src_remain))
        };
        if a_dur > 0.05 {
            prepared.push((idx, delay_ms, a_in, a_dur, av));
        }
    }
    if prepared.is_empty() {
        return Err("音频与导出区间无重叠".into());
    }

    let mut filter_parts: Vec<String> = Vec::new();
    let mut bgm_labels: Vec<String> = Vec::new();
    for (i, &(_src, delay_ms, _a_in, a_dur, av)) in prepared.iter().enumerate() {
        let input_idx = i + 1; // 0=video, 1..=N = audios in prepared order
        let label = format!("bgm{i}");
        let chain = if delay_ms > 0 {
            format!(
                "[{input_idx}:a]atrim=0:{a_dur},asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms},volume={av},apad,atrim=0:{export_dur},asetpts=PTS-STARTPTS[{label}]"
            )
        } else {
            format!(
                "[{input_idx}:a]atrim=0:{a_dur},asetpts=PTS-STARTPTS,volume={av},apad,atrim=0:{export_dur},asetpts=PTS-STARTPTS[{label}]"
            )
        };
        filter_parts.push(chain);
        bgm_labels.push(format!("[{label}]"));
    }

    let filter = if video_vol <= 0.001 {
        if bgm_labels.len() == 1 {
            format!("{};{}anull[a]", filter_parts[0], bgm_labels[0])
        } else {
            format!(
                "{};{}amix=inputs={}:duration=first:dropout_transition=0[a]",
                filter_parts.join(";"),
                bgm_labels.join(""),
                bgm_labels.len()
            )
        }
    } else {
        let n = bgm_labels.len() + 1;
        format!(
            "[0:a]volume={video_vol},apad,atrim=0:{export_dur},asetpts=PTS-STARTPTS[va];{};[va]{}amix=inputs={n}:duration=first:dropout_transition=0[a]",
            filter_parts.join(";"),
            bgm_labels.join("")
        )
    };

    let run = |reencode: bool| -> Result<(), String> {
        let mut cmd = Command::new(ffmpeg);
        hide_subprocess_console(&mut cmd);
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-ss".into(),
            video_start.to_string(),
            "-to".into(),
            video_end.to_string(),
            "-i".into(),
            video_input.to_string(),
        ];
        for &(src_idx, _, a_in, _, _) in &prepared {
            args.push("-ss".into());
            args.push(a_in.to_string());
            args.push("-i".into());
            args.push(audios[src_idx].path.clone());
        }
        args.extend([
            "-filter_complex".into(),
            filter.clone(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "[a]".into(),
        ]);
        if reencode {
            args.extend([
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "veryfast".into(),
                "-crf".into(),
                "23".into(),
            ]);
        } else {
            args.extend(["-c:v".into(), "copy".into()]);
        }
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-shortest".into(),
            "-movflags".into(),
            "+faststart".into(),
            output.to_string_lossy().to_string(),
        ]);
        let status = cmd
            .args(&args)
            .status()
            .map_err(|e| format!("无法启动 FFmpeg 混音: {e}"))?;
        if status.success() && output.exists() {
            Ok(())
        } else {
            Err("FFmpeg 混入音频失败".into())
        }
    };

    if run(false).is_err() {
        run(true)?;
    }
    Ok(())
}

#[tauri::command]
fn pick_audio_file(app: AppHandle) -> Result<String, String> {
    let mut dialog = rfd::FileDialog::new().set_title("选择音频素材（可用 mp4/音频文件）");
    dialog = dialog.add_filter(
        "音视频",
        &[
            "mp4", "mov", "mkv", "m4a", "mp3", "wav", "aac", "flac", "ogg", "webm",
        ],
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        dialog = dialog.set_parent(&window);
    }
    dialog
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "未选择文件".to_string())
}

#[tauri::command]
async fn render_batch_edits(
    app: AppHandle,
    paths: Vec<String>,
    start_sec: f64,
    end_sec: f64,
    audio: Option<Vec<AudioOverlayArgs>>,
    drama_title: Option<String>,
) -> Result<Vec<String>, String> {
    // FFmpeg 可能较久，放到阻塞线程，避免卡住桌面 UI
    tauri::async_runtime::spawn_blocking(move || {
        render_batch_edits_sync(app, paths, start_sec, end_sec, audio, drama_title)
    })
    .await
    .map_err(|e| format!("导出任务异常: {e}"))?
}

fn render_batch_edits_sync(
    app: AppHandle,
    paths: Vec<String>,
    start_sec: f64,
    end_sec: f64,
    audio: Option<Vec<AudioOverlayArgs>>,
    drama_title: Option<String>,
) -> Result<Vec<String>, String> {
    if paths.is_empty() || start_sec < 0.0 || end_sec <= start_sec {
        return Err("批量编辑区间无效".into());
    }
    let root = repo_root(&app);
    let ffmpeg = resolve_ffmpeg_bin(&root);
    let ffprobe = resolve_ffprobe_bin(&root);
    let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
    let title = drama_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("未分类");
    let out_dir = resolve_drama_export_dir(&path_refs, Some(title));
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let mut outputs = Vec::new();
    for (i, raw) in paths.iter().enumerate() {
        if raw.starts_with("http://") || raw.starts_with("https://") {
            return Err("云端 TOS 成片请先落到本地后再导出剪辑".into());
        }
        let source = PathBuf::from(raw);
        if !source.exists() {
            return Err(format!("文件不存在: {}", raw));
        }
        // 按该片真实时长钳制区间，避免出点超过片长导致偶发失败
        let mut s = start_sec;
        let mut e = end_sec;
        if let Ok(dur) = ffprobe_duration_sec(&ffprobe, &source) {
            e = e.min(dur);
            s = s.min((e - 0.05).max(0.0));
            if !(e > s + 0.04) {
                return Err(format!(
                    "导出区间超出片长（{} 仅 {:.1}s）: {}",
                    source.file_name().and_then(|n| n.to_str()).unwrap_or(raw),
                    dur,
                    raw
                ));
            }
        }
        let output = out_dir.join(format_manual_autoclip_name(title, i + 1));
        let audios = audio.as_deref().unwrap_or(&[]);
        if !audios.is_empty() {
            ffmpeg_mux_replace_audio(&ffmpeg, raw, s, e, audios, &output)?;
        } else {
            ffmpeg_cut_segment(&ffmpeg, raw, s, e, &output)?;
        }
        outputs.push(output.to_string_lossy().to_string());
    }
    Ok(outputs)
}

#[derive(Deserialize)]
struct EditSegment {
    path: String,
    #[serde(alias = "startSec")]
    start_sec: f64,
    #[serde(alias = "endSec")]
    end_sec: f64,
}

/// 多集混剪：按顺序裁切各段并拼接成一条成片
#[tauri::command]
async fn render_concat_edits(
    app: AppHandle,
    segments: Vec<EditSegment>,
    audio: Option<Vec<AudioOverlayArgs>>,
    drama_title: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        render_concat_edits_sync(app, segments, audio, drama_title)
    })
    .await
    .map_err(|e| format!("导出任务异常: {e}"))?
}

fn render_concat_edits_sync(
    app: AppHandle,
    segments: Vec<EditSegment>,
    audio: Option<Vec<AudioOverlayArgs>>,
    drama_title: Option<String>,
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("混剪片段为空".into());
    }
    for seg in &segments {
        if seg.path.starts_with("http://") || seg.path.starts_with("https://") {
            return Err("云端 TOS 成片请先下载到本地后再导出混剪".into());
        }
        if !(seg.end_sec > seg.start_sec) || seg.start_sec < 0.0 {
            return Err(format!("混剪区间无效: {} [{}..{}]", seg.path, seg.start_sec, seg.end_sec));
        }
        if !PathBuf::from(&seg.path).exists() {
            return Err(format!("文件不存在: {}", seg.path));
        }
    }

    let root = repo_root(&app);
    let ffmpeg = resolve_ffmpeg_bin(&root);
    let ffprobe = resolve_ffprobe_bin(&root);
    let path_refs: Vec<&str> = segments.iter().map(|s| s.path.as_str()).collect();
    let title = drama_title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("未分类");
    let out_dir = resolve_drama_export_dir(&path_refs, Some(title));
    let work_dir = out_dir.join(format!("mix-work-{}", std::process::id()));
    fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;

    let mut part_files: Vec<PathBuf> = Vec::with_capacity(segments.len());
    for (i, seg) in segments.iter().enumerate() {
        let mut start = seg.start_sec;
        let mut end = seg.end_sec;
        if let Ok(dur) = ffprobe_duration_sec(&ffprobe, Path::new(&seg.path)) {
            end = end.min(dur);
            start = start.min((end - 0.05).max(0.0));
            if !(end > start + 0.04) {
                let _ = fs::remove_dir_all(&work_dir);
                return Err(format!("混剪区间超出片长: {}", seg.path));
            }
        }
        let part = work_dir.join(format!("part-{:02}.mp4", i + 1));
        if let Err(e) = ffmpeg_cut_segment(&ffmpeg, &seg.path, start, end, &part) {
            let _ = fs::remove_dir_all(&work_dir);
            return Err(e);
        }
        part_files.push(part);
    }

    // concat demuxer 列表（路径转正斜杠，单引号转义）
    let list_path = work_dir.join("concat.txt");
    let mut list_body = String::new();
    for part in &part_files {
        let p = part.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        list_body.push_str(&format!("file '{}'\n", p));
    }
    fs::write(&list_path, list_body).map_err(|e| e.to_string())?;

    let output = out_dir.join(format_manual_autoclip_name(title, segments.len().max(1)));

    let mut concat = Command::new(&ffmpeg);
    hide_subprocess_console(&mut concat);
    let concat_status = concat
        .args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            &list_path.to_string_lossy(),
            "-c",
            "copy",
            &output.to_string_lossy(),
        ])
        .status()
        .map_err(|e| format!("无法启动 FFmpeg 拼接: {e}"))?;

    if !concat_status.success() || !output.exists() {
        // 编码参数不一致时 copy 拼接会失败，统一重编码再拼
        let _ = fs::remove_file(&output);
        let mut concat2 = Command::new(&ffmpeg);
        hide_subprocess_console(&mut concat2);
        let status2 = concat2
            .args([
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                &list_path.to_string_lossy(),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                &output.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("无法启动 FFmpeg 重编码拼接: {e}"))?;
        if !status2.success() || !output.exists() {
            let _ = fs::remove_dir_all(&work_dir);
            return Err("多集混剪拼接失败".into());
        }
    }

    let audios = audio.as_deref().unwrap_or(&[]);
    let final_path = if !audios.is_empty() {
        let export_dur: f64 = segments.iter().map(|s| (s.end_sec - s.start_sec).max(0.0)).sum();
        let muxed = out_dir.join(format_manual_autoclip_name(
            &format!("{title}混音"),
            segments.len().max(1),
        ));
        // 前端传入的 timeline_start 已相对导出窗口（0 起点）
        match ffmpeg_mux_replace_audio(
            &ffmpeg,
            &output.to_string_lossy(),
            0.0,
            export_dur.max(0.1),
            audios,
            &muxed,
        ) {
            Ok(()) => {
                let _ = fs::remove_file(&output);
                muxed
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&work_dir);
                return Err(e);
            }
        }
    } else {
        output
    };

    let _ = fs::remove_dir_all(&work_dir);
    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_highlight_marker(
    source_path: String,
    start_sec: f64,
    end_sec: f64,
    label: Option<String>,
    highlight_type: Option<String>,
    usable_as_hook: Option<bool>,
    source: Option<String>,
) -> Result<HighlightMarker, String> {
    if source_path.is_empty() || !(start_sec >= 0.0 && end_sec > start_sec) {
        return Err("高光区间无效".to_string());
    }
    // suppress：本地屏蔽某段 ASR 高光；其余一律按人工标记
    let src = match source.as_deref().map(str::trim).unwrap_or("human") {
        "suppress" => "suppress".to_string(),
        _ => "human".to_string(),
    };
    let ht = normalize_highlight_type(highlight_type.as_deref().unwrap_or("conflict"));
    let hook = if src == "suppress" {
        false
    } else {
        usable_as_hook.unwrap_or(false) || ht == "hook"
    };
    let lb = label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            if src == "suppress" {
                "已忽略ASR".to_string()
            } else {
                highlight_type_label(&ht).to_string()
            }
        });
    let path = highlights_path();
    let mut all: Vec<HighlightMarker> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?).unwrap_or_default()
    } else {
        Vec::new()
    };
    let marker = HighlightMarker {
        id: format!("marker-{}-{}", std::process::id(), all.len() + 1),
        source_path,
        start_sec,
        end_sec,
        label: lb,
        highlight_type: ht,
        usable_as_hook: hook,
        source: src,
        created_at: chrono_like_now(),
    };
    all.push(marker.clone());
    fs::create_dir_all(data_root()).map_err(|e| e.to_string())?;
    fs::write(path, serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(marker)
}

#[tauri::command]
fn update_highlight_marker(
    id: String,
    start_sec: f64,
    end_sec: f64,
    label: Option<String>,
    highlight_type: Option<String>,
    usable_as_hook: Option<bool>,
) -> Result<HighlightMarker, String> {
    if id.is_empty() || !(end_sec > start_sec) || start_sec < 0.0 {
        return Err("高光区间无效".into());
    }
    let path = highlights_path();
    if !path.exists() {
        return Err("没有可更新的高光标记".into());
    }
    let mut all: Vec<HighlightMarker> =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?).unwrap_or_default();
    let Some(idx) = all.iter().position(|m| m.id == id) else {
        return Err("高光标记不存在".into());
    };
    all[idx].start_sec = start_sec;
    all[idx].end_sec = end_sec;
    if let Some(ht) = highlight_type {
        all[idx].highlight_type = normalize_highlight_type(&ht);
    }
    if let Some(hook) = usable_as_hook {
        all[idx].usable_as_hook = hook || all[idx].highlight_type == "hook";
    } else if all[idx].highlight_type == "hook" {
        all[idx].usable_as_hook = true;
    }
    if let Some(lb) = label {
        let t = lb.trim();
        if !t.is_empty() {
            all[idx].label = t.to_string();
        }
    }
    fs::write(path, serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(all[idx].clone())
}

#[tauri::command]
fn delete_highlight_marker(id: String) -> Result<bool, String> {
    if id.is_empty() {
        return Err("标记 ID 无效".into());
    }
    let path = highlights_path();
    if !path.exists() {
        return Ok(false);
    }
    let mut all: Vec<HighlightMarker> =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?).unwrap_or_default();
    let before = all.len();
    all.retain(|m| m.id != id);
    if all.len() == before {
        return Err("高光标记不存在".into());
    }
    fs::write(path, serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(true)
}

fn pick_video_files(app: &AppHandle) -> Vec<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title("选择视频素材（可多选）");
    dialog = dialog.add_filter(
        "视频文件",
        &[
            "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "ts", "mpeg", "mpg",
        ],
    );

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        dialog = dialog.set_parent(&window);
    }

    let mut picked = dialog.pick_files().unwrap_or_default();
    // 多选时按原始文件名排序，避免用户点击顺序影响 1.mp4/2.mp4 这类素材顺序
    picked.sort_by(|a, b| {
        let name_a = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let name_b = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name_a.cmp(name_b)
    });
    picked
}

fn pick_video_files_with_title(app: &AppHandle, title: &str) -> Vec<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(title);
    dialog = dialog.add_filter(
        "视频文件",
        &[
            "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "ts", "mpeg", "mpg",
        ],
    );

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        dialog = dialog.set_parent(&window);
    }

    let mut picked = dialog.pick_files().unwrap_or_default();
    picked.sort_by(|a, b| {
        let name_a = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let name_b = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name_a.cmp(name_b)
    });
    picked
}

fn copy_picked_videos_to_inbox(picked: &[PathBuf]) -> Result<Vec<String>, String> {
    let dir = inbox_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut dest_paths = Vec::with_capacity(picked.len());
    for (index, picked_path) in picked.iter().enumerate() {
        require_video_path(picked_path)?;
        let name = format!(
            "{}_{}_{}",
            base_ts,
            index,
            picked_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("video.mp4")
        );
        let dest = dir.join(name);
        fs::copy(picked_path, &dest).map_err(|e| e.to_string())?;
        append_desktop_log(&format!("uploaded {}", dest.display()));
        dest_paths.push(dest.to_string_lossy().to_string());
    }
    Ok(dest_paths)
}

fn is_video_path(path: &Path) -> bool {
    static VIDEO_EXTENSIONS: &[&str] = &[
        "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv", "ts", "mpeg", "mpg",
    ];
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn require_video_path(path: &Path) -> Result<(), String> {
    if is_video_path(path) {
        return Ok(());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("(无扩展名)");
    Err(format!(
        "不支持的素材格式 {ext}，请上传视频文件（mp4/mov/mkv 等）。图片文件无法提取音轨。"
    ))
}

#[tauri::command]
fn pick_and_start_pipeline(
    app: AppHandle,
    state: State<AgentState>,
    drama_title: Option<String>,
    drama_genre: Option<String>,
    drama_synopsis: Option<String>,
) -> Result<Vec<String>, String> {
    let title = drama_title.unwrap_or_default().trim().to_string();
    if title.is_empty() {
        return Err("请先填写剧名，再导入并混剪".into());
    }
    let genre = drama_genre
        .unwrap_or_default()
        .trim()
        .to_string();
    let synopsis = drama_synopsis.unwrap_or_default().trim().to_string();
    if genre.is_empty() {
        return Err("请先选择题材，再导入".into());
    }
    if synopsis.is_empty() {
        return Err("请先填写作品简介，再导入".into());
    }

    let picked = pick_video_files(&app);
    if picked.is_empty() {
        return Err("未选择文件".to_string());
    }

    let dest_paths = copy_picked_videos_to_inbox(&picked)?;
    write_inbox_drama_stub(
        &title,
        &dest_paths,
        Some(genre.as_str()),
        Some(synopsis.as_str()),
    )?;
    // 从 stub 读回 dramaId，保证与 catalog 一致
    let drama_id = list_mixable_dramas_from_catalog()
        .into_iter()
        .find(|d| d.title == title)
        .map(|d| d.drama_id)
        .unwrap_or_default();

    // 单集/多集统一：登记分集 + ASR 入库 + local-dramas（与 TOS 一致，跳过下载解压；单集不混剪）
    let mut extras = vec![
        "--drama-title".to_string(),
        title.clone(),
        "--drama-genre".into(),
        genre.clone(),
        "--drama-synopsis".into(),
        synopsis.clone(),
    ];
    if !drama_id.is_empty() {
        extras.push("--drama-id".into());
        extras.push(drama_id);
    }
    let extra_refs: Vec<&str> = extras.iter().map(|s| s.as_str()).collect();
    spawn_batch_pipeline_process(
        &app,
        &state,
        &dest_paths,
        "batch-upload-and-process",
        &extra_refs,
    )?;

    Ok(dest_paths)
}

#[tauri::command]
fn pick_remix_cases(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = pick_video_files_with_title(&app, "选择案例视频（可多选）");
    if picked.is_empty() {
        return Err("未选择案例视频".into());
    }
    copy_picked_videos_to_inbox(&picked)
}

#[tauri::command]
fn pick_remix_sources(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = pick_video_files_with_title(&app, "选择原片（可多选）");
    if picked.is_empty() {
        return Err("未选择原片视频".into());
    }
    copy_picked_videos_to_inbox(&picked)
}

#[tauri::command]
fn start_remix_replica(
    app: AppHandle,
    state: State<AgentState>,
    title: String,
    case_paths: Vec<String>,
    source_paths: Vec<String>,
    fission_enabled: bool,
    fission_count: u32,
    fission_ops: Vec<String>,
) -> Result<serde_json::Value, String> {
    if case_paths.is_empty() {
        return Err("请先选择案例视频".into());
    }
    if source_paths.is_empty() {
        return Err("请先选择原片视频".into());
    }
    let mut extras: Vec<String> = Vec::new();
    for case_path in &case_paths {
        extras.push("--case".into());
        extras.push(case_path.clone());
    }
    let title = title.trim().to_string();
    if !title.is_empty() {
        extras.push("--title".into());
        extras.push(title);
    }
    if fission_enabled && fission_count > 0 {
        extras.push("--fission-count".into());
        extras.push(fission_count.to_string());
        for op in &fission_ops {
            extras.push("--fission-op".into());
            extras.push(op.clone());
        }
    }
    let extra_refs: Vec<&str> = extras.iter().map(String::as_str).collect();
    // source_paths 会被 spawn_batch_pipeline_process 自动加 --source
    spawn_batch_pipeline_process(&app, &state, &source_paths, "create-remix-replica", &extra_refs)?;
    Ok(serde_json::json!({
        "caseCount": case_paths.len(),
        "sourceCount": source_paths.len(),
    }))
}

/// 导入时先落一个本地短剧占位（agent 跑完会覆盖为完整条目）
fn write_inbox_drama_stub(
    title: &str,
    paths: &[String],
    genre: Option<&str>,
    synopsis: Option<&str>,
) -> Result<(), String> {
    let path = data_root().join("local-dramas.json");
    let mut root: serde_json::Map<String, serde_json::Value> = if path.is_file() {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    let mut dramas: serde_json::Map<String, serde_json::Value> = root
        .get("dramas")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();

    let mut drama_id = String::new();
    for (id, row) in dramas.iter() {
        if row.get("title").and_then(|t| t.as_str()).unwrap_or("") == title {
            drama_id = id.clone();
            break;
        }
    }
    if drama_id.is_empty() {
        drama_id = format!(
            "drama-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
    }

    let episodes: Vec<serde_json::Value> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = Path::new(p)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("video.mp4");
            serde_json::json!({
                "path": p,
                "episodeNo": i + 1,
                "name": name,
            })
        })
        .collect();

    let mut row = serde_json::json!({
        "dramaId": drama_id,
        "title": title,
        "source": "inbox",
        "episodes": episodes,
        "updatedAt": chrono_like_now(),
    });
    if let Some(obj) = row.as_object_mut() {
        if let Some(g) = genre.map(str::trim).filter(|s| !s.is_empty()) {
            obj.insert("genre".into(), serde_json::Value::String(g.to_string()));
        }
        let syn = synopsis.map(str::trim).unwrap_or("").to_string();
        if !syn.is_empty() {
            obj.insert("synopsis".into(), serde_json::Value::String(syn));
        }
    }
    dramas.insert(drama_id.clone(), row);
    root.insert("dramas".into(), serde_json::Value::Object(dramas));
    fs::create_dir_all(data_root()).map_err(|e| e.to_string())?;
    fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::Value::Object(root)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Clone)]
struct MixableDramaEpisode {
    path: String,
    episode_no: u32,
    name: String,
    exists: bool,
    /// 本地 ASR 索引已有该集（识别在本机完成并落盘）
    asr_done: bool,
}

#[derive(Serialize, Clone)]
struct MixableDrama {
    drama_id: String,
    title: String,
    /// 题材标签（导入页选题材）
    genre: Option<String>,
    /// 作品简介
    synopsis: Option<String>,
    /// 运营清单类型：short/comic/...（clip_drama_intake.drama_type）
    drama_type: Option<String>,
    source: String,
    episode_count: usize,
    ready_count: usize,
    /// 本地已识别集数（读 drama-asr / episode-asr-index，不查服务端）
    asr_done_count: usize,
    package_cache_key: Option<String>,
    updated_at: String,
    episodes: Vec<MixableDramaEpisode>,
}

/// 从本地 episode-asr-index.json 收集已识别集号（ASR 在 Agent 本机完成）
fn load_local_asr_done_episode_nos(drama_id: &str, episodes: &[MixableDramaEpisode]) -> std::collections::HashSet<u32> {
    let mut done = std::collections::HashSet::new();
    let mut ingest = |path: &Path| {
        let Ok(text) = fs::read_to_string(path) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let Some(map) = v.get("episodes").and_then(|x| x.as_object()) else { return };
        for (k, entry) in map {
            let task = entry.get("taskId").and_then(|x| x.as_str()).unwrap_or("").trim();
            if task.is_empty() {
                continue;
            }
            if let Ok(n) = k.parse::<u32>() {
                done.insert(n);
            } else if let Some(n) = entry.get("episodeNo").and_then(|x| x.as_u64()) {
                done.insert(n as u32);
            }
        }
    };
    let catalog_index = data_root()
        .join("drama-asr")
        .join(drama_id)
        .join("episode-asr-index.json");
    if catalog_index.is_file() {
        ingest(&catalog_index);
    }
    if let Some(ep0) = episodes.first() {
        if let Some(p) = find_episode_asr_index(Path::new(&ep0.path)) {
            if p != catalog_index {
                ingest(&p);
            }
        }
    }
    done
}

fn apply_local_asr_flags(drama_id: &str, episodes: &mut [MixableDramaEpisode]) -> usize {
    let done_nos = load_local_asr_done_episode_nos(drama_id, episodes);
    for ep in episodes.iter_mut() {
        ep.asr_done = ep.exists && done_nos.contains(&ep.episode_no);
    }
    episodes.iter().filter(|e| e.asr_done).count()
}

fn load_local_dramas_root() -> serde_json::Map<String, serde_json::Value> {
    let path = data_root().join("local-dramas.json");
    if !path.is_file() {
        return serde_json::Map::new();
    }
    let Ok(text) = fs::read_to_string(&path) else {
        return serde_json::Map::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn save_local_dramas_root(root: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    fs::create_dir_all(data_root()).map_err(|e| e.to_string())?;
    let path = data_root().join("local-dramas.json");
    fs::write(
        &path,
        serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn hidden_mixable_drama_ids(root: &serde_json::Map<String, serde_json::Value>) -> std::collections::HashSet<String> {
    root.get("hiddenDramaIds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn find_package_cache_dir_for_drama(drama_id: &str) -> Option<PathBuf> {
    let root = data_root().join("workspace").join("packages").join("cache");
    let Ok(entries) = fs::read_dir(&root) else {
        return None;
    };
    for entry in entries.flatten() {
        let cache_dir = entry.path();
        if !cache_dir.is_dir() {
            continue;
        }
        let (_, id) = read_package_cache_meta(&cache_dir);
        if id.as_deref() == Some(drama_id) {
            return Some(cache_dir);
        }
    }
    None
}

fn update_package_cache_meta(drama_id: &str, title: &str, genre: Option<&str>, synopsis: Option<&str>) {
    let Some(cache_dir) = find_package_cache_dir_for_drama(drama_id) else {
        return;
    };
    let path = cache_dir.join("manifest.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("title".into(), serde_json::Value::String(title.to_string()));
        if let Some(g) = genre.filter(|s| !s.is_empty()) {
            obj.insert("genre".into(), serde_json::Value::String(g.to_string()));
        } else {
            obj.remove("genre");
        }
        if let Some(s) = synopsis.filter(|s| !s.is_empty()) {
            obj.insert("synopsis".into(), serde_json::Value::String(s.to_string()));
        } else {
            obj.remove("synopsis");
        }
        let _ = fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or(text));
    }
}

fn list_mixable_dramas_from_catalog() -> Vec<MixableDrama> {
    let root = load_local_dramas_root();
    let hidden = hidden_mixable_drama_ids(&root);
    let Some(map) = root.get("dramas").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in map.values() {
        let drama_id = row
            .get("dramaId")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if drama_id.is_empty() || hidden.contains(&drama_id) {
            continue;
        }
        let title = row
            .get("title")
            .and_then(|x| x.as_str())
            .unwrap_or(&drama_id)
            .to_string();
        let genre = row
            .get("genre")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let synopsis = row
            .get("synopsis")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let drama_type = row
            .get("dramaType")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        let source = row
            .get("source")
            .and_then(|x| x.as_str())
            .unwrap_or("inbox")
            .to_string();
        let updated_at = row
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let package_cache_key = row
            .get("packageCacheKey")
            .and_then(|x| x.as_str())
            .map(String::from);
        let mut episodes = Vec::new();
        if let Some(arr) = row.get("episodes").and_then(|e| e.as_array()) {
            for ep in arr {
                let p = ep
                    .get("path")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = ep
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or_else(|| {
                        Path::new(&p)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("video.mp4")
                    })
                    .to_string();
                let episode_no = ep.get("episodeNo").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                let exists = !p.is_empty() && Path::new(&p).is_file();
                episodes.push(MixableDramaEpisode {
                    path: p,
                    episode_no,
                    name,
                    exists,
                    asr_done: false,
                });
            }
        }
        episodes.sort_by_key(|e| e.episode_no);
        let ready_count = episodes.iter().filter(|e| e.exists).count();
        let asr_done_count = apply_local_asr_flags(&drama_id, &mut episodes);
        out.push(MixableDrama {
            drama_id,
            title,
            genre,
            synopsis,
            drama_type,
            source,
            episode_count: episodes.len(),
            ready_count,
            asr_done_count,
            package_cache_key,
            updated_at,
            episodes,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// 把 package 解压缓存里尚未进 catalog 的剧补进列表
fn merge_package_cache_dramas(mut list: Vec<MixableDrama>) -> Vec<MixableDrama> {
    let hidden = hidden_mixable_drama_ids(&load_local_dramas_root());
    let mut have: std::collections::HashSet<String> =
        list.iter().map(|d| d.drama_id.clone()).collect();
    let extracted = list_extracted_files();
    let mut by_drama: std::collections::HashMap<String, Vec<ExtractedFile>> =
        std::collections::HashMap::new();
    for f in extracted {
        let Some(id) = f.drama_id.clone() else { continue };
        if hidden.contains(&id) {
            continue;
        }
        by_drama.entry(id).or_default().push(f);
    }
    for (drama_id, files) in by_drama {
        if have.contains(&drama_id) || hidden.contains(&drama_id) {
            continue;
        }
        let manifest_meta = files
            .iter()
            .find_map(|f| {
                find_nearest_package_manifest(Path::new(&f.path))
                    .map(|m| read_drama_meta_from_manifest(&m))
            });
        let (manifest_title, manifest_genre, manifest_synopsis, manifest_drama_type) =
            manifest_meta.unwrap_or((None, None, None, None));
        let title = files
            .iter()
            .find_map(|f| f.drama_title.clone())
            .or(manifest_title)
            .unwrap_or_else(|| drama_id.clone());
        let mut episodes: Vec<MixableDramaEpisode> = files
            .iter()
            .enumerate()
            .map(|(i, f)| MixableDramaEpisode {
                path: f.path.clone(),
                episode_no: (i + 1) as u32,
                name: f.name.clone(),
                exists: Path::new(&f.path).is_file(),
                asr_done: false,
            })
            .collect();
        episodes.sort_by(|a, b| a.name.cmp(&b.name));
        for (i, ep) in episodes.iter_mut().enumerate() {
            ep.episode_no = (i + 1) as u32;
        }
        let ready_count = episodes.iter().filter(|e| e.exists).count();
        let asr_done_count = apply_local_asr_flags(&drama_id, &mut episodes);
        list.push(MixableDrama {
            drama_id: drama_id.clone(),
            title,
            genre: manifest_genre,
            synopsis: manifest_synopsis,
            drama_type: manifest_drama_type,
            source: "package_cache".into(),
            episode_count: episodes.len(),
            ready_count,
            asr_done_count,
            package_cache_key: None,
            updated_at: String::new(),
            episodes,
        });
        have.insert(drama_id);
    }
    list
}

#[tauri::command]
fn list_mixable_dramas() -> Result<Vec<MixableDrama>, String> {
    Ok(merge_package_cache_dramas(list_mixable_dramas_from_catalog()))
}

/// 修改短剧名称/题材/简介（本地 catalog；ZIP 缓存同步 manifest；题材与简介必填）
#[tauri::command]
fn update_mixable_drama(
    drama_id: String,
    title: String,
    genre: Option<String>,
    synopsis: Option<String>,
) -> Result<MixableDrama, String> {
    let drama_id = drama_id.trim().to_string();
    let title = title.trim().to_string();
    let genre = genre
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let synopsis = synopsis.map(|s| s.trim().to_string()).unwrap_or_default();
    if drama_id.is_empty() {
        return Err("dramaId 不能为空".into());
    }
    if title.is_empty() {
        return Err("剧名不能为空".into());
    }
    if genre.is_none() {
        return Err("请选择题材".into());
    }
    if synopsis.is_empty() {
        return Err("作品简介不能为空".into());
    }

    let current = list_mixable_dramas()?
        .into_iter()
        .find(|d| d.drama_id == drama_id)
        .ok_or_else(|| format!("未找到短剧 {drama_id}"))?;

    let mut root = load_local_dramas_root();
    let mut dramas = root
        .get("dramas")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();

    let mut row = dramas.get(&drama_id).cloned().unwrap_or_else(|| {
        serde_json::json!({
            "dramaId": drama_id,
            "source": current.source,
            "episodes": current.episodes.iter().map(|e| serde_json::json!({
                "path": e.path,
                "episodeNo": e.episode_no,
                "name": e.name,
            })).collect::<Vec<_>>(),
            "packageCacheKey": current.package_cache_key,
        })
    });
    if let Some(obj) = row.as_object_mut() {
        obj.insert("dramaId".into(), serde_json::Value::String(drama_id.clone()));
        obj.insert("title".into(), serde_json::Value::String(title.clone()));
        if let Some(g) = genre.clone() {
            obj.insert("genre".into(), serde_json::Value::String(g));
        } else {
            obj.remove("genre");
        }
        if synopsis.is_empty() {
            obj.remove("synopsis");
        } else {
            obj.insert("synopsis".into(), serde_json::Value::String(synopsis.clone()));
        }
        obj.insert("updatedAt".into(), serde_json::Value::String(chrono_like_now()));
    }
    dramas.insert(drama_id.clone(), row);

    let mut hidden: Vec<serde_json::Value> = root
        .get("hiddenDramaIds")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    hidden.retain(|x| x.as_str().map(|s| s != drama_id).unwrap_or(true));

    root.insert("dramas".into(), serde_json::Value::Object(dramas));
    root.insert("hiddenDramaIds".into(), serde_json::Value::Array(hidden));
    save_local_dramas_root(&root)?;
    update_package_cache_meta(
        &drama_id,
        &title,
        genre.as_deref(),
        if synopsis.is_empty() {
            None
        } else {
            Some(synopsis.as_str())
        },
    );

    list_mixable_dramas()?
        .into_iter()
        .find(|d| d.drama_id == drama_id)
        .ok_or_else(|| "保存成功但刷新列表失败".into())
}

/// 云端补全：只写入非空字段，不要求题材+简介同时齐全
#[tauri::command]
fn patch_mixable_drama_meta(
    drama_id: String,
    title: Option<String>,
    genre: Option<String>,
    synopsis: Option<String>,
    drama_type: Option<String>,
) -> Result<MixableDrama, String> {
    let drama_id = drama_id.trim().to_string();
    if drama_id.is_empty() {
        return Err("dramaId 不能为空".into());
    }
    let title = title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let genre = genre.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let synopsis = synopsis.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let drama_type = drama_type.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if title.is_none() && genre.is_none() && synopsis.is_none() && drama_type.is_none() {
        return list_mixable_dramas()?
            .into_iter()
            .find(|d| d.drama_id == drama_id)
            .ok_or_else(|| format!("未找到短剧 {drama_id}"));
    }

    let current = list_mixable_dramas()?
        .into_iter()
        .find(|d| d.drama_id == drama_id)
        .ok_or_else(|| format!("未找到短剧 {drama_id}"))?;

    let mut root = load_local_dramas_root();
    let mut dramas = root
        .get("dramas")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();

    let mut row = dramas.get(&drama_id).cloned().unwrap_or_else(|| {
        serde_json::json!({
            "dramaId": drama_id,
            "title": current.title,
            "source": current.source,
            "episodes": current.episodes.iter().map(|e| serde_json::json!({
                "path": e.path,
                "episodeNo": e.episode_no,
                "name": e.name,
            })).collect::<Vec<_>>(),
            "packageCacheKey": current.package_cache_key,
        })
    });
    if let Some(obj) = row.as_object_mut() {
        obj.insert("dramaId".into(), serde_json::Value::String(drama_id.clone()));
        if let Some(t) = title.clone() {
            obj.insert("title".into(), serde_json::Value::String(t));
        } else if !obj.contains_key("title") {
            obj.insert("title".into(), serde_json::Value::String(current.title.clone()));
        }
        if let Some(g) = genre.clone() {
            obj.insert("genre".into(), serde_json::Value::String(g));
        }
        if let Some(s) = synopsis.clone() {
            obj.insert("synopsis".into(), serde_json::Value::String(s));
        }
        if let Some(t) = drama_type.clone() {
            obj.insert("dramaType".into(), serde_json::Value::String(t));
        }
        obj.insert("updatedAt".into(), serde_json::Value::String(chrono_like_now()));
    }
    dramas.insert(drama_id.clone(), row);

    let mut hidden: Vec<serde_json::Value> = root
        .get("hiddenDramaIds")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    hidden.retain(|x| x.as_str().map(|s| s != drama_id).unwrap_or(true));

    root.insert("dramas".into(), serde_json::Value::Object(dramas));
    root.insert("hiddenDramaIds".into(), serde_json::Value::Array(hidden));
    save_local_dramas_root(&root)?;

    let final_title = title.unwrap_or(current.title);
    update_package_cache_meta(
        &drama_id,
        &final_title,
        genre.as_deref().or(current.genre.as_deref()),
        synopsis.as_deref().or(current.synopsis.as_deref()),
    );

    list_mixable_dramas()?
        .into_iter()
        .find(|d| d.drama_id == drama_id)
        .ok_or_else(|| "补全成功但刷新列表失败".into())
}

/// 从混剪列表移除短剧（不删除本地视频文件；ZIP 缓存剧目写入隐藏名单）
#[tauri::command]
fn delete_mixable_drama(drama_id: String) -> Result<(), String> {
    let drama_id = drama_id.trim().to_string();
    if drama_id.is_empty() {
        return Err("dramaId 不能为空".into());
    }

    let mut root = load_local_dramas_root();
    let mut dramas = root
        .get("dramas")
        .and_then(|d| d.as_object())
        .cloned()
        .unwrap_or_default();
    dramas.remove(&drama_id);

    let mut hidden: Vec<serde_json::Value> = root
        .get("hiddenDramaIds")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if !hidden.iter().any(|x| x.as_str() == Some(drama_id.as_str())) {
        hidden.push(serde_json::Value::String(drama_id.clone()));
    }

    root.insert("dramas".into(), serde_json::Value::Object(dramas));
    root.insert("hiddenDramaIds".into(), serde_json::Value::Array(hidden));
    save_local_dramas_root(&root)
}

#[derive(Serialize, Deserialize, Clone)]
struct PendingLocalJob {
    id: String,
    kind: String,
    drama_id: String,
    title: String,
    enqueued_at: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct PendingLocalJobsState {
    jobs: Vec<PendingLocalJob>,
    /// 为本机人工混剪排队而暂停远程领取；队列清空后自动恢复
    #[serde(default)]
    paused_for_local: bool,
}

#[derive(Serialize, Clone)]
struct EnqueueDramaMixResult {
    status: String,
    message: String,
    drama_id: String,
    queue_length: usize,
}

fn pending_local_jobs_path() -> PathBuf {
    data_root().join("pending-local-jobs.json")
}

fn load_pending_local_jobs() -> PendingLocalJobsState {
    let path = pending_local_jobs_path();
    if !path.exists() {
        return PendingLocalJobsState::default();
    }
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => PendingLocalJobsState::default(),
    }
}

fn save_pending_local_jobs(state: &PendingLocalJobsState) -> Result<(), String> {
    let _ = fs::create_dir_all(data_root());
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(pending_local_jobs_path(), text).map_err(|e| e.to_string())
}

/// 本地 pipeline 或远程任务进度任一在忙 → 视为占用
fn is_agent_busy(state: &State<AgentState>) -> bool {
    if is_processing(state) {
        return true;
    }
    read_task_progress().active
}

fn pause_remote_claim_for_local_queue() {
    let mut pending = load_pending_local_jobs();
    if pending.paused_for_local {
        return;
    }
    if read_paused() {
        // 用户已手动暂停：不接管恢复权
        return;
    }
    if write_paused(true).is_ok() {
        pending.paused_for_local = true;
        let _ = save_pending_local_jobs(&pending);
        append_desktop_log("paused remote claim for local drama-mix queue");
    }
}

fn resume_remote_claim_after_local_queue() {
    let mut pending = load_pending_local_jobs();
    if !pending.jobs.is_empty() || !pending.paused_for_local {
        return;
    }
    let _ = write_paused(false);
    pending.paused_for_local = false;
    let _ = save_pending_local_jobs(&pending);
    append_desktop_log("resumed remote claim after local drama-mix queue");
}

fn resolve_mixable_drama(drama_id: &str) -> Result<MixableDrama, String> {
    let drama_id = drama_id.trim();
    if drama_id.is_empty() {
        return Err("dramaId 不能为空".into());
    }
    list_mixable_dramas()?
        .into_iter()
        .find(|d| d.drama_id == drama_id)
        .ok_or_else(|| format!("未找到短剧 {drama_id}"))
}

fn build_drama_mix_spawn_args(drama: &MixableDrama) -> Result<(Vec<String>, Vec<String>), String> {
    let paths: Vec<String> = drama
        .episodes
        .iter()
        .filter(|e| e.exists)
        .map(|e| e.path.clone())
        .collect();
    if paths.len() < 2 {
        return Err("至少需要 2 集本地视频才能自动混剪（请先导入或等待 ZIP 解压完成）".into());
    }
    let mut extras: Vec<String> = vec![
        "--drama-id".into(),
        drama.drama_id.clone(),
        "--drama-title".into(),
        drama.title.clone(),
        "--source-kind".into(),
        drama.source.clone(),
    ];
    if let Some(g) = drama.genre.clone().filter(|s| !s.trim().is_empty()) {
        extras.push("--drama-genre".into());
        extras.push(g);
    }
    if let Some(s) = drama.synopsis.clone().filter(|s| !s.trim().is_empty()) {
        extras.push("--drama-synopsis".into());
        extras.push(s);
    }
    if let Some(key) = drama.package_cache_key.clone() {
        extras.push("--package-cache-key".into());
        extras.push(key);
    }
    Ok((paths, extras))
}

fn start_drama_mix_now(
    app: &AppHandle,
    state: &State<AgentState>,
    drama: &MixableDrama,
) -> Result<(), String> {
    let (paths, extras) = build_drama_mix_spawn_args(drama)?;
    // 本地混剪期间暂停远程领取，避免与 GPU/ASR 抢占
    pause_remote_claim_for_local_queue();
    let extra_refs: Vec<&str> = extras.iter().map(|s| s.as_str()).collect();
    spawn_batch_pipeline_process(app, state, &paths, "run-drama-mix", &extra_refs)
}

/// 空闲时弹出队首本地混剪并启动；有待执行任务时保持暂停远程领取
fn try_start_next_pending_local_job(app: &AppHandle, state: &State<AgentState>) {
    if is_agent_busy(state) {
        let pending = load_pending_local_jobs();
        if !pending.jobs.is_empty() {
            pause_remote_claim_for_local_queue();
        }
        return;
    }

    let mut pending = load_pending_local_jobs();
    if pending.jobs.is_empty() {
        resume_remote_claim_after_local_queue();
        return;
    }

    let job = pending.jobs.remove(0);
    if let Err(e) = save_pending_local_jobs(&pending) {
        append_desktop_log(&format!("save pending jobs failed: {e}"));
        return;
    }

    match resolve_mixable_drama(&job.drama_id) {
        Ok(drama) => match start_drama_mix_now(app, state, &drama) {
            Ok(()) => {
                append_desktop_log(&format!(
                    "started queued drama-mix dramaId={} title={}",
                    drama.drama_id, drama.title
                ));
            }
            Err(e) => {
                append_desktop_log(&format!(
                    "queued drama-mix start failed dramaId={}: {e}",
                    job.drama_id
                ));
                // 启动失败则恢复远程领取（若队列已空）
                resume_remote_claim_after_local_queue();
            }
        },
        Err(e) => {
            append_desktop_log(&format!(
                "queued drama-mix missing dramaId={}: {e}",
                job.drama_id
            ));
            resume_remote_claim_after_local_queue();
        }
    }
}

fn spawn_pending_local_jobs_pump(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let state = app.state::<AgentState>();
            try_start_next_pending_local_job(&app, &state);
        }
    });
}

#[tauri::command]
fn run_drama_mix(
    app: AppHandle,
    state: State<AgentState>,
    drama_id: String,
) -> Result<(), String> {
    let drama = resolve_mixable_drama(&drama_id)?;
    // 兼容旧入口：忙则入队，闲则立即开跑
    let _ = enqueue_drama_mix(app, state, drama.drama_id)?;
    Ok(())
}

/// 人工触发混剪：本地空闲立即执行；远程/本地占用中则入队，当前任务结束后立刻开跑
#[tauri::command]
fn enqueue_drama_mix(
    app: AppHandle,
    state: State<AgentState>,
    drama_id: String,
) -> Result<EnqueueDramaMixResult, String> {
    let drama = resolve_mixable_drama(&drama_id)?;
    // 预检集数，避免无效入队
    let _ = build_drama_mix_spawn_args(&drama)?;

    let mut pending = load_pending_local_jobs();
    if pending
        .jobs
        .iter()
        .any(|j| j.kind == "drama_mix" && j.drama_id == drama.drama_id)
    {
        let n = pending.jobs.len();
        return Ok(EnqueueDramaMixResult {
            status: "queued".into(),
            message: format!(
                "「{}」已在本地排队（共 {} 个待执行），当前任务结束后立即混剪",
                drama.title, n
            ),
            drama_id: drama.drama_id,
            queue_length: n,
        });
    }

    if is_agent_busy(&state) {
        pending.jobs.push(PendingLocalJob {
            id: format!("mix-{}-{}", drama.drama_id, chrono_like_now()),
            kind: "drama_mix".into(),
            drama_id: drama.drama_id.clone(),
            title: drama.title.clone(),
            enqueued_at: chrono_like_now(),
        });
        let n = pending.jobs.len();
        save_pending_local_jobs(&pending)?;
        pause_remote_claim_for_local_queue();
        append_desktop_log(&format!(
            "enqueued drama-mix dramaId={} queue={}",
            drama.drama_id, n
        ));
        return Ok(EnqueueDramaMixResult {
            status: "queued".into(),
            message: format!(
                "本地服务正忙，已将「{}」排入队列（第 {} 位）；当前任务完成后立即混剪",
                drama.title, n
            ),
            drama_id: drama.drama_id,
            queue_length: n,
        });
    }

    start_drama_mix_now(&app, &state, &drama)?;
    Ok(EnqueueDramaMixResult {
        status: "started".into(),
        message: format!("已开始混剪「{}」", drama.title),
        drama_id: drama.drama_id,
        queue_length: 0,
    })
}

#[tauri::command]
fn list_pending_local_jobs() -> Result<PendingLocalJobsState, String> {
    Ok(load_pending_local_jobs())
}

#[tauri::command]
fn pick_fission_sources(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = pick_video_files(&app);
    if picked.is_empty() {
        return Err("未选择文件".into());
    }
    let mut paths = Vec::with_capacity(picked.len());
    for p in picked {
        require_video_path(&p)?;
        paths.push(p.to_string_lossy().to_string());
    }
    Ok(paths)
}

#[tauri::command]
fn run_material_fission(
    app: AppHandle,
    state: State<AgentState>,
    sources: Vec<String>,
    variants: Option<u32>,
    concurrency: Option<u32>,
    ops: Option<String>,
    seed: Option<u32>,
) -> Result<(), String> {
    let paths: Vec<String> = sources
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if paths.is_empty() {
        return Err("请先选择本地视频".into());
    }
    let variants = variants.unwrap_or(10).clamp(1, 500);
    let concurrency = concurrency.unwrap_or(8).clamp(1, 8);
    let mut extras: Vec<String> = vec![
        "--variants".into(),
        variants.to_string(),
        "--concurrency".into(),
        concurrency.to_string(),
    ];
    if let Some(ops) = ops.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        extras.push("--ops".into());
        extras.push(ops);
    }
    if let Some(seed) = seed {
        extras.push("--seed".into());
        extras.push(seed.to_string());
    }
    let extra_refs: Vec<&str> = extras.iter().map(|s| s.as_str()).collect();
    spawn_batch_pipeline_process(&app, &state, &paths, "material-fission", &extra_refs)
}

#[tauri::command]
fn open_fission_dir() -> Result<String, String> {
    let meta = data_root().join("fission-last.json");
    let fallback = primary_output_dir().join("fission");
    let dir = if meta.exists() {
        let text = read_text_lossy(&meta);
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("outDir").and_then(|s| s.as_str()).map(PathBuf::from))
            .filter(|p| p.exists())
            .unwrap_or(fallback)
    } else {
        fallback
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        return Err("仅 Windows 支持打开目录".into());
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn pick_and_upload_material(app: AppHandle) -> Result<Vec<String>, String> {
    let picked = pick_video_files(&app);
    if picked.is_empty() {
        return Err("未选择文件".to_string());
    }
    copy_picked_videos_to_inbox(&picked)
}

#[tauri::command]
fn process_material(app: AppHandle, state: State<AgentState>, source: String) -> Result<(), String> {
    require_video_path(Path::new(&source))?;
    spawn_pipeline_process(&app, &state, &source, "upload-and-process", &[])
}

#[tauri::command]
fn process_output_asr(
    app: AppHandle,
    state: State<AgentState>,
    source: String,
    parent_task_id: Option<String>,
    drama_id: Option<String>,
    drama_title: Option<String>,
) -> Result<(), String> {
    require_video_path(Path::new(&source))?;
    let parent = parent_task_id.unwrap_or_default().trim().to_string();
    let drama = drama_id.unwrap_or_default().trim().to_string();
    let title = drama_title.unwrap_or_default().trim().to_string();
    let mut extras: Vec<String> = Vec::new();
    if !parent.is_empty() {
        extras.push("--parent-task-id".into());
        extras.push(parent);
    }
    if !drama.is_empty() {
        extras.push("--drama-id".into());
        extras.push(drama);
    }
    if !title.is_empty() {
        extras.push("--drama-title".into());
        extras.push(title);
    }
    let extra_refs: Vec<&str> = extras.iter().map(String::as_str).collect();
    spawn_pipeline_process(&app, &state, &source, "process-output-asr", &extra_refs)
}

/// 素材库：将本地成片按混剪完成后的 TOS 直传流程上传（视频+封面+专辑登记）
#[derive(Deserialize, Clone)]
struct UploadTosItem {
    path: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[tauri::command]
fn upload_outputs_to_tos(
    app: AppHandle,
    state: State<AgentState>,
    sources: Option<Vec<String>>,
    items: Option<Vec<UploadTosItem>>,
    drama_title: Option<String>,
) -> Result<(), String> {
    let mut upload_items: Vec<UploadTosItem> = items.unwrap_or_default();
    if upload_items.is_empty() {
        for s in sources.unwrap_or_default() {
            let p = s.trim().to_string();
            if p.is_empty() {
                continue;
            }
            upload_items.push(UploadTosItem {
                path: p,
                task_id: None,
            });
        }
    } else {
        for it in &mut upload_items {
            it.path = it.path.trim().to_string();
            if let Some(tid) = it.task_id.take() {
                let t = tid.trim().to_string();
                it.task_id = if t.is_empty() { None } else { Some(t) };
            }
        }
        upload_items.retain(|it| !it.path.is_empty());
    }
    if upload_items.is_empty() {
        return Err("请先勾选本地成片".into());
    }
    for it in &upload_items {
        require_video_path(Path::new(&it.path))?;
    }
    if is_processing(&state) {
        return Err("已有素材正在处理，请稍候".into());
    }

    let root = repo_root(&app);
    // 上传不需要 FunASR，跳过 venv 检查以加快启动
    let api = current_api_base(&state)?;
    let cli = agent_cli_js(&root);
    if !cli.exists() {
        return Err(format!(
            "未找到 Agent 程序: {}。请确认从安装目录启动，或重新运行安装程序。",
            cli.display()
        ));
    }

    let manifest_path = std::env::temp_dir().join(format!(
        "clip-upload-tos-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let manifest_body = serde_json::json!({
        "dramaTitle": drama_title.as_deref().unwrap_or("").trim(),
        "items": upload_items.iter().map(|it| {
            serde_json::json!({
                "path": it.path,
                "taskId": it.task_id,
            })
        }).collect::<Vec<_>>(),
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest_body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let node = bundled_node(&root)?;
    let mut cmd = Command::new(&node);
    hide_subprocess_console(&mut cmd);
    cmd.arg(&cli)
        .arg("upload-outputs-tos")
        .arg("--api-base")
        .arg(&api)
        .arg("--manifest")
        .arg(&manifest_path);
    if let Some(t) = drama_title {
        let t = t.trim().to_string();
        if !t.is_empty() && t != "未分类" {
            cmd.arg("--drama-title").arg(t);
        }
    }

    spawn_agent_env(&mut cmd, &root, &api);
    cmd.env("CLIP_DESKTOP_MANAGED", "1")
        .env("CLIP_LOG_TO_STDOUT", "false");

    if let Some(log) = open_log_append() {
        cmd.stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
    }

    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut guard = state.process_child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    let with_task = upload_items.iter().filter(|it| it.task_id.is_some()).count();
    append_desktop_log(&format!(
        "upload-outputs-tos {} file(s), {} with taskId",
        upload_items.len(),
        with_task
    ));
    append_agent_log(format!(
        "[upload-tos] 启动推送 {} 条（含 taskId {} 条）",
        upload_items.len(),
        with_task
    ))
    .ok();
    Ok(())
}

#[derive(Serialize, Clone)]
struct OutputAsrResolve {
    asr_task_id: Option<String>,
    parent_task_id: Option<String>,
    source_path: String,
}

fn normalize_output_asr_key(path: &str) -> String {
    let p = PathBuf::from(path);
    // 不用 canonicalize：Windows 会带 \\?\ 前缀，与 Node resolve 键不一致
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .unwrap_or_else(|_| PathBuf::from(path))
    };
    abs.to_string_lossy().replace('/', "\\").to_lowercase()
}

fn output_asr_file_name(path: &str) -> String {
    PathBuf::from(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// 成片稳定后缀：01-3-20260720174046-autoclip.mp4
fn distinctive_output_tail(file_name: &str) -> Option<String> {
    let base = file_name
        .replace('\\', "/")
        .split('/')
        .next_back()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if base.is_empty() {
        return None;
    }
    // 捕获末尾 N-N-timestamp-autoclip.mp4
    let re = regex_lite_autoclip_tail(&base);
    if let Some(t) = re {
        return Some(t);
    }
    if base.ends_with("autoclip.mp4") && base.len() >= 20 {
        return Some(base);
    }
    None
}

fn regex_lite_autoclip_tail(base: &str) -> Option<String> {
    // 手动从右解析，避免引入 regex crate：…-01-3-20260720174046-autoclip.mp4
    let lower = base.to_lowercase();
    if !lower.ends_with("-autoclip.mp4") {
        return None;
    }
    let stem = lower.trim_end_matches("-autoclip.mp4");
    let parts: Vec<&str> = stem.rsplitn(3, '-').collect();
    // parts[0]=timestamp, parts[1]=planNo?, parts[2]=rest… 需要 timestamp 够长
    if parts.len() < 3 {
        return None;
    }
    let ts = parts[0];
    let mid = parts[1];
    if ts.len() < 10 || !ts.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if mid.is_empty() || !mid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // 再取一轮集号段：rest 末尾应是数字段
    let rest = parts[2];
    let ep = rest.rsplit('-').next().unwrap_or("");
    if ep.is_empty() || !ep.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{ep}-{mid}-{ts}-autoclip.mp4"))
}

#[tauri::command]
fn resolve_output_asr_task(
    source_path: String,
    parent_task_id: Option<String>,
) -> Result<OutputAsrResolve, String> {
    let empty = OutputAsrResolve {
        asr_task_id: None,
        parent_task_id: None,
        source_path: source_path.clone(),
    };
    if source_path.is_empty()
        || source_path.starts_with("http://")
        || source_path.starts_with("https://")
        || source_path.starts_with("local:")
    {
        return Ok(empty);
    }
    let index_path = data_root().join("output-asr-index.json");
    if !index_path.is_file() {
        return Ok(empty);
    }
    let text = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let map = match v.as_object() {
        Some(m) => m,
        None => return Ok(empty),
    };
    let key = normalize_output_asr_key(&source_path);
    let name = output_asr_file_name(&source_path);
    let parent = parent_task_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let tail = distinctive_output_tail(&name);

    let mut candidates: Vec<&serde_json::Value> = Vec::new();
    if let Some(e) = map.get(&key) {
        candidates.push(e);
    }
    if let Some(ref p) = parent {
        let pk = format!("parent:{p}:{name}");
        if let Some(e) = map.get(&pk) {
            candidates.push(e);
        }
        if let Some(ref t) = tail {
            let ptk = format!("parent-tail:{p}:{t}");
            if let Some(e) = map.get(&ptk) {
                candidates.push(e);
            }
            // 兼容旧索引：仅扫同父任务键
            if candidates.is_empty() {
                let prefix = format!("parent:{p}:");
                let prefix_tail = format!("parent-tail:{p}:");
                for (k, val) in map.iter() {
                    let kk = k.to_lowercase();
                    if !(kk.starts_with(&prefix) || kk.starts_with(&prefix_tail)) {
                        continue;
                    }
                    let base = kk.rsplit(':').next().unwrap_or("").to_string();
                    if distinctive_output_tail(&base).as_deref() == Some(t.as_str()) || base == *t {
                        candidates.push(val);
                        break;
                    }
                }
            }
        }
    }
    // 无父任务时只认绝对路径键（上面已 push），禁止裸 name:/tail: 跨剧命中

    let entry = candidates.into_iter().next();
    Ok(OutputAsrResolve {
        asr_task_id: entry
            .and_then(|e| e.get("taskId"))
            .and_then(|x| x.as_str())
            .map(String::from),
        parent_task_id: entry
            .and_then(|e| e.get("parentTaskId"))
            .and_then(|x| x.as_str())
            .map(String::from)
            .or(parent),
        source_path,
    })
}

#[tauri::command]
fn resolve_output_asr_cache(file_name: String) -> Result<Option<String>, String> {
    let name = file_name
        .trim()
        .replace('\\', "/")
        .split('/')
        .next_back()
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() || name.contains("..") {
        return Ok(None);
    }
    let cache_dir = data_root().join("output-asr-cache");
    let cached = cache_dir.join(&name);
    if cached.is_file() {
        return Ok(Some(cached.to_string_lossy().to_string()));
    }
    // 仅按稳定后缀匹配缓存文件，避免中文名 sanitize 后互相串
    let want_tail = distinctive_output_tail(&name);
    if cache_dir.is_dir() {
        let want = name.to_lowercase();
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            for ent in entries.flatten() {
                let p = ent.path();
                if !p.is_file() {
                    continue;
                }
                let n = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if n == want {
                    return Ok(Some(p.to_string_lossy().to_string()));
                }
                if let Some(ref t) = want_tail {
                    if distinctive_output_tail(&n).as_deref() == Some(t.as_str()) || n.ends_with(t) {
                        return Ok(Some(p.to_string_lossy().to_string()));
                    }
                }
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn retry_material_job(
    app: AppHandle,
    state: State<AgentState>,
    source: String,
    task_id: String,
    job_id: String,
) -> Result<(), String> {
    spawn_pipeline_process(
        &app,
        &state,
        &source,
        "process-task",
        &["--task-id", &task_id, "--job-id", &job_id],
    )
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let start_i = MenuItem::with_id(app, "start", "启动", true, None::<&str>)?;
    let stop_i = MenuItem::with_id(app, "stop", "停止", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "打开drama-clip", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&start_i, &stop_i, &show_i, &quit_i])?;

    let mut tray_builder = TrayIconBuilder::new().tooltip("drama-clip · 短剧 AI 智能剪辑平台");
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    let _tray = tray_builder
        .menu(&menu)
        .on_menu_event(|app, event| {
            let state = app.state::<AgentState>();
            match event.id.as_ref() {
                "start" => {
                    let _ = start_agent(app, &state);
                }
                "stop" => stop_agent(&state),
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                "quit" => {
                    stop_agent(&state);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn spawn_agent_watchdog(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(2));
        let state = app.state::<AgentState>();
        if state.user_stopped.load(Ordering::SeqCst) {
            continue;
        }
        let should_restart = {
            let mut guard = match state.child.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        true
                    }
                    Ok(None) => false,
                    Err(_) => false,
                }
            } else {
                false
            }
        };
        if should_restart {
            let _ = start_agent(&app, &state);
        }
    });
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_agent_status,
            start_agent_cmd,
            stop_agent_cmd,
            pause_agent_cmd,
            resume_agent_cmd,
            read_agent_logs,
            append_agent_log,
            set_api_base_cmd,
            open_inbox_dir,
            open_output_dir,
            reveal_clip_output,
            open_clip_output,
            copy_text_to_clipboard,
            get_highlight_markers,
            resolve_episode_asr_task,
            process_episode_asr,
            get_agent_auth,
            render_batch_edits,
            render_concat_edits,
            pick_audio_file,
            ensure_server_audio,
            ensure_local_output,
            save_highlight_marker,
            update_highlight_marker,
            delete_highlight_marker,
            pick_and_start_pipeline,
            pick_remix_cases,
            pick_remix_sources,
            start_remix_replica,
            list_mixable_dramas,
            update_mixable_drama,
            patch_mixable_drama_meta,
            delete_mixable_drama,
            run_drama_mix,
            enqueue_drama_mix,
            list_pending_local_jobs,
            pick_fission_sources,
            run_material_fission,
            open_fission_dir,
            pick_and_upload_material,
            process_material,
            process_output_asr,
            download_drama_package_zip,
            upload_outputs_to_tos,
            resolve_output_asr_task,
            resolve_output_asr_cache,
            retry_material_job,
        ])
        .setup(|app| {
            let root = repo_root(app.handle());
            let api_base = load_api_base(&root);
            app.manage(AgentState {
                child: Mutex::new(None),
                process_child: Mutex::new(None),
                api_base: Mutex::new(api_base),
                user_stopped: AtomicBool::new(false),
            });

            build_tray(app.handle())?;

            let state = app.state::<AgentState>();
            spawn_agent_watchdog(app.handle().clone());
            spawn_pending_local_jobs_pump(app.handle().clone());
            if std::env::var("CLIP_DESKTOP_AUTOSTART")
                .map(|v| v != "0" && v != "false")
                .unwrap_or(true)
            {
                let _ = start_agent(app.handle(), &state);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AgentState>();
                stop_agent(&state);
            }
        });
}
