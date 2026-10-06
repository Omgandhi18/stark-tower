//! Offline voices. One worker owns the model, the speech queue and playback.
use chrono::{Local, Timelike};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const MODEL: &str = "kokoro-multi-lang-v1_0";
const URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
pub const ARCHIVE_BYTES: u64 = 349_906_910;
const SHA256: &str = "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298";
const CACHE_LIMIT: usize = 150;
const IDLE: Duration = Duration::from_secs(600);
// The pinned September 2026 archive adds a 54th speaker; English IDs 0–27 stay the same.
pub const ENGLISH: [&str; 28] = [
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Voice {
    pub name: String,
    pub speed: f32,
    pub pitch: f32,
}
impl Default for Voice {
    fn default() -> Self {
        default_for("")
    }
}
pub fn default_for(id: &str) -> Voice {
    let (name, speed, pitch) = match id {
        "jarvis" => ("bm_george", 0.95, 0.0),
        "friday" => ("bf_emma", 1.0, 0.0),
        "vision" => ("am_michael", 0.9, 0.0),
        "edith" => ("af_bella", 1.08, 0.0),
        "karen" => ("af_heart", 1.05, 0.0),
        "veronica" => ("af_alloy", 1.05, 0.0),
        "dum-e" | "dume" => ("am_puck", 1.15, 4.0),
        _ => ("af_heart", 1.0, 0.0),
    };
    Voice {
        name: name.into(),
        speed,
        pitch,
    }
}
impl Voice {
    pub fn clamped(mut self) -> Self {
        if !ENGLISH.contains(&self.name.as_str()) {
            self.name = "af_heart".into();
        }
        self.speed = if self.speed.is_finite() { self.speed.clamp(0.8, 1.3) } else { 1.0 };
        self.pitch = if self.pitch.is_finite() { self.pitch.clamp(-6.0, 6.0) } else { 0.0 };
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_on")]
    pub reminders: bool,
    #[serde(default = "default_on")]
    pub ready: bool,
    #[serde(default = "default_on")]
    pub needs_you: bool,
    #[serde(default = "default_on")]
    pub failures: bool,
    #[serde(default)]
    pub replies: bool,
    #[serde(default)]
    pub background_only: bool,
    #[serde(default)]
    pub quiet_hours: bool,
    #[serde(default = "default_quiet_from")]
    pub quiet_from: String,
    #[serde(default = "default_quiet_to")]
    pub quiet_to: String,
    #[serde(default = "default_volume")]
    pub volume: f32,
}
fn default_on() -> bool {
    true
}
fn default_quiet_from() -> String {
    "22:00".into()
}
fn default_quiet_to() -> String {
    "08:00".into()
}
fn default_volume() -> f32 {
    0.7
}
impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            reminders: true,
            ready: true,
            needs_you: true,
            failures: true,
            replies: false,
            background_only: false,
            quiet_hours: false,
            quiet_from: "22:00".into(),
            quiet_to: "08:00".into(),
            volume: 0.7,
        }
    }
}
impl VoiceSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.volume.is_finite() || !(0.0..=1.0).contains(&self.volume) {
            return Err("Choose a volume between 0 and 100%.".into());
        }
        if minutes(&self.quiet_from).is_none() || minutes(&self.quiet_to).is_none() {
            return Err("Choose a start and end time for quiet hours.".into());
        }
        Ok(())
    }
    fn allows(&self, kind: &str, front: bool, minute: u32) -> bool {
        // A line you asked to hear (a preview, Read aloud) plays whenever voices are on.
        if kind == "manual" {
            return self.enabled;
        }
        self.enabled
            && !(self.background_only && front)
            && !(self.quiet_hours && quiet_at(&self.quiet_from, &self.quiet_to, minute))
            && match kind {
                "reminder" => self.reminders,
                "ready" => self.ready,
                "needs_you" => self.needs_you,
                "failure" => self.failures,
                "reply" => self.replies,
                _ => false,
            }
    }
}
fn minutes(time: &str) -> Option<u32> {
    let (h, m) = time.split_once(':')?;
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}
pub fn quiet_at(from: &str, to: &str, minute: u32) -> bool {
    let (Some(from), Some(to)) = (minutes(from), minutes(to)) else {
        return false;
    };
    if from == to {
        true
    } else if from < to {
        minute >= from && minute < to
    } else {
        minute >= from || minute < to
    }
}

fn speech_rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            (r"(?s)```.*?```|~~~.*?~~~", " some code "),
            (r"!?\[([^\]]+)\]\([^)]*\)", "$1"),
            (r"https?://[^\s<>]*[^\s<>.,!?;:)]", "a link"),
            (r"(?:[A-Za-z]:\\|~/|/|\./|\.\./)(?:[^\s`<>]+[/\\])*([^\s`<>/\\]+)", "$1"),
            (r"\b(?:[A-Za-z0-9_.-]+[/\\])+([A-Za-z0-9_.-]+)", "$1"),
            (r"(?m)^\s*(?:#{1,6}\s*|>\s*|[-*+]\s+|\d+\.\s+)", ""),
            (r"[*_`~]", ""),
            (r"\bPR\b", "P R"),
            (r"\bCI\b", "C I"),
            (r"\bnpm\b", "N P M"),
            (r"\bUI\b", "U I"),
            (r"\bAPI\b", "A P I"),
            (r"\bJSON\b", "J-SON"),
        ]
        .into_iter()
        .map(|(pattern, spoken)| (Regex::new(pattern).unwrap(), spoken))
        .collect()
    })
}
pub fn normalise(text: &str) -> String {
    let mut text = text.replace('\0', " ");
    for (pattern, spoken) in speech_rules() {
        text = pattern.replace_all(&text, *spoken).into_owned();
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn first_sentences(text: &str) -> String {
    let text = normalise(text);
    let mut end = text.len();
    let mut count = 0;
    for (i, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?') && text[i + c.len_utf8()..].starts_with([' ', '\n']) {
            count += 1;
            if count == 2 {
                end = i + c.len_utf8();
                break;
            }
        }
    }
    crate::chat::truncate(&text[..end], 600)
}

pub fn loudness(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }
    let rms = (samples.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt() as f32;
    if rms < 1e-8 {
        return;
    }
    let peak = samples.iter().map(|x| x.abs()).fold(0.0_f32, f32::max);
    let gain = (10.0_f32.powf(-18.0 / 20.0) / rms).min(10.0_f32.powf(-1.0 / 20.0) / peak);
    for sample in samples {
        *sample *= gain;
    }
}
fn pitch_ratio(pitch: f32) -> f32 {
    2.0_f32.powf(pitch / 12.0)
}
// Generate slower by this same ratio first, so changing pitch keeps the chosen tempo.
pub fn resample(samples: &[f32], pitch: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let ratio = pitch_ratio(pitch);
    let len = (samples.len() as f32 / ratio).round() as usize;
    (0..len)
        .map(|i| {
            let at = i as f32 * ratio;
            let lo = (at.floor() as usize).min(samples.len() - 1);
            let hi = (lo + 1).min(samples.len() - 1);
            samples[lo] + (samples[hi] - samples[lo]) * at.fract()
        })
        .collect()
}
fn cache_key(voice: &Voice, text: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(format!(
        "{MODEL}:{SHA256}:v1:{}:{}:{}:",
        voice.name,
        voice.speed.to_bits(),
        voice.pitch.to_bits()
    ));
    hash.update(text);
    format!("{:x}", hash.finalize())
}
fn evict(dir: &Path, limit: usize) -> std::io::Result<()> {
    let mut files: Vec<_> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|f| f.path().extension().is_some_and(|x| x == "wav"))
        .filter_map(|f| f.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, f.path())))
        .collect();
    files.sort();
    let remove = files.len().saturating_sub(limit);
    for (_, path) in files.into_iter().take(remove) {
        fs::remove_file(path)?;
    }
    Ok(())
}
fn write_wav(path: &Path, samples: &[f32], rate: i32) -> std::io::Result<()> {
    let temporary = path.with_extension("wav.part");
    let result = write_wav_file(&temporary, samples, rate).and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn write_wav_file(path: &Path, samples: &[f32], rate: i32) -> std::io::Result<()> {
    let mut f = File::create(path)?;
    let bytes = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + bytes).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16_u32.to_le_bytes())?;
    f.write_all(&1_u16.to_le_bytes())?;
    f.write_all(&1_u16.to_le_bytes())?;
    f.write_all(&(rate as u32).to_le_bytes())?;
    f.write_all(&(rate as u32 * 2).to_le_bytes())?;
    f.write_all(&2_u16.to_le_bytes())?;
    f.write_all(&16_u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&bytes.to_le_bytes())?;
    for sample in samples {
        f.write_all(&((*sample * i16::MAX as f32).round() as i16).to_le_bytes())?;
    }
    Ok(())
}
fn load_model(path: &Path) -> Result<OfflineTts, String> {
    let file = |s: &str| Some(path.join(s).to_string_lossy().into_owned());
    let tts = OfflineTts::create(&OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: file("model.onnx"),
                voices: file("voices.bin"),
                tokens: file("tokens.txt"),
                data_dir: file("espeak-ng-data"),
                lexicon: file("lexicon-us-en.txt"),
                lang: Some("en-us".into()),
                ..Default::default()
            },
            num_threads: 2,
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    })
    .ok_or("Couldn't load the voices. Remove them and download again.")?;
    if tts.num_speakers() != 54 {
        return Err("The voice model has an unexpected speaker count. Download it again.".into());
    }
    Ok(tts)
}
fn synthesise(tts: &OfflineTts, voice: &Voice, text: &str, keep_going: impl FnMut(&[f32], f32) -> bool + 'static) -> Result<Vec<f32>, String> {
    let sid = ENGLISH.iter().position(|v| *v == voice.name).ok_or("Choose an English voice.")? as i32;
    let audio = tts
        .generate_with_config(
            text,
            &GenerationConfig {
                sid,
                speed: voice.speed / pitch_ratio(voice.pitch),
                ..Default::default()
            },
            Some(keep_going),
        )
        .ok_or("Couldn't make speech. Try a shorter line.")?;
    let mut samples = resample(audio.samples(), voice.pitch);
    loudness(&mut samples);
    Ok(samples)
}

#[derive(Debug, Clone)]
struct Line {
    agent: String,
    thing: String,
    text: String,
    voice: Voice,
    kind: String,
    token: String,
}
#[derive(Default)]
struct Queue {
    waiting: VecDeque<Line>,
    epoch: u64,
}
impl Queue {
    fn push(&mut self, line: Line) {
        if let Some(old) = self.waiting.iter_mut().find(|x| x.agent == line.agent && x.thing == line.thing) {
            *old = line;
            return;
        }
        if self.waiting.len() >= 5 {
            if let Some(at) = self.waiting.iter().position(|x| x.kind != "reminder") {
                self.waiting.remove(at);
            } else if line.kind != "reminder" {
                return;
            }
        }
        self.waiting.push_back(line);
    }
    fn stop(&mut self) {
        self.waiting.clear();
        self.epoch += 1;
    }
}
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct VoiceStatus {
    pub model: String,
    pub downloaded: f64,
    pub total: f64,
    pub agent_id: Option<String>,
    pub token: Option<String>,
    pub error: Option<String>,
}
struct Inner {
    root: PathBuf,
    status: Mutex<VoiceStatus>,
    queue: Mutex<Queue>,
    wake: Condvar,
    child: Mutex<Option<Child>>,
    download_child: Mutex<Option<Child>>,
    operation: Mutex<()>,
    cancel: AtomicBool,
    shutdown: AtomicBool,
    generation: AtomicU64,
    download_running: AtomicBool,
    visible_chat: Mutex<Option<String>>,
}
#[derive(Clone)]
pub struct Voices {
    inner: Arc<Inner>,
}
impl Voices {
    pub fn new(root: PathBuf) -> Self {
        let ready = model_ready(&root);
        Self {
            inner: Arc::new(Inner {
                root,
                status: Mutex::new(VoiceStatus {
                    model: if ready { "ready" } else { "missing" }.into(),
                    downloaded: if ready { ARCHIVE_BYTES as f64 } else { 0.0 },
                    total: ARCHIVE_BYTES as f64,
                    agent_id: None,
                    token: None,
                    error: None,
                }),
                queue: Mutex::new(Queue::default()),
                wake: Condvar::new(),
                child: Mutex::new(None),
                download_child: Mutex::new(None),
                operation: Mutex::new(()),
                cancel: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
                generation: AtomicU64::new(0),
                download_running: AtomicBool::new(false),
                visible_chat: Mutex::new(None),
            }),
        }
    }
    pub fn status(&self) -> VoiceStatus {
        self.inner.status.lock().unwrap().clone()
    }
    fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit("voices://status", self.status());
    }
    pub fn visible_chat(&self, agent: Option<String>) {
        *self.inner.visible_chat.lock().unwrap() = agent;
    }
    pub fn stop(&self, app: &tauri::AppHandle) {
        // Playback spawn and Stop share this lock, so Stop can't miss a new child.
        let mut queue = self.inner.queue.lock().unwrap();
        queue.stop();
        if let Some(mut child) = self.inner.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut status = self.inner.status.lock().unwrap();
        status.agent_id = None;
        status.token = None;
        drop(status);
        drop(queue);
        self.wake();
        self.emit(app);
    }
    fn wake(&self) {
        self.inner.wake.notify_all();
    }
    pub fn shutdown(&self, app: &tauri::AppHandle) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.cancel_download();
        self.stop(app);
    }
    pub fn release(&self, app: &tauri::AppHandle) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.stop(app);
    }
    pub fn cancel_download(&self) {
        self.inner.cancel.store(true, Ordering::SeqCst);
        if let Some(child) = self.inner.download_child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }
    fn begin_download(&self) -> Result<bool, String> {
        if self.inner.download_running.swap(true, Ordering::SeqCst) {
            return Err("Voices are already downloading.".into());
        }
        if model_ready(&self.inner.root) {
            self.inner.download_running.store(false, Ordering::SeqCst);
            return Ok(false);
        }
        self.inner.cancel.store(false, Ordering::SeqCst);
        {
            let mut status = self.inner.status.lock().unwrap();
            status.model = "downloading".into();
            status.downloaded = 0.0;
            status.error = None;
        }
        Ok(true)
    }
    fn finish_download(&self, result: Result<(), String>) {
        let mut status = self.inner.status.lock().unwrap();
        match result {
            Ok(()) => {
                status.model = "ready".into();
                status.downloaded = ARCHIVE_BYTES as f64;
            }
            Err(e) => {
                status.model = "missing".into();
                status.downloaded = 0.0;
                if e != "cancelled" {
                    status.error = Some(e);
                }
            }
        }
        drop(status);
        self.inner.download_running.store(false, Ordering::SeqCst);
    }
    pub fn download(&self, app: tauri::AppHandle) -> Result<(), String> {
        if !self.begin_download()? {
            return Ok(());
        }
        self.emit(&app);
        let voices = self.clone();
        std::thread::spawn(move || {
            voices.finish_download(voices.install(&app));
            voices.emit(&app);
        });
        Ok(())
    }
    fn install(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let root = &self.inner.root;
        fs::create_dir_all(root).map_err(|_| "Couldn't create the voices folder. Check free disk space.")?;
        let archive = root.join("download.tar.bz2");
        let staging = root.join("installing");
        let result = (|| {
            let mut child_slot = self.inner.download_child.lock().unwrap();
            if self.inner.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            // curl is provided by macOS; keeping its child lets Cancel and Quit interrupt a stalled connection.
            let mut child = Command::new("curl")
                .args([
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--connect-timeout",
                    "20",
                    "--max-time",
                    "1800",
                    URL,
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "Couldn't start the download. The system curl command is needed.")?;
            let response = child.stdout.take().unwrap();
            *child_slot = Some(child);
            drop(child_slot);
            let mut file = File::create(&archive).map_err(|_| "Couldn't save the download. Check free disk space.")?;
            let mut last = Instant::now();
            let copied = verified_copy(
                response,
                &mut file,
                ARCHIVE_BYTES,
                SHA256,
                || self.inner.cancel.load(Ordering::SeqCst),
                |bytes| {
                    if last.elapsed() > Duration::from_millis(150) {
                        self.inner.status.lock().unwrap().downloaded = bytes as f64;
                        self.emit(app);
                        last = Instant::now();
                    }
                },
            );
            drop(file);
            let downloaded = self
                .inner
                .download_child
                .lock()
                .unwrap()
                .take()
                .map(|mut child| {
                    if copied.is_err() {
                        let _ = child.kill();
                    }
                    child.wait().is_ok_and(|s| s.success())
                })
                .unwrap_or(false);
            if self.inner.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            copied?;
            if !downloaded {
                return Err("Couldn't download voices. Check your connection and try again.".into());
            }
            if self.inner.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            fs::create_dir_all(&staging).map_err(|_| "Couldn't unpack voices. Check free disk space.")?;
            let mut child_slot = self.inner.download_child.lock().unwrap();
            if self.inner.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            *child_slot = Some(
                Command::new("tar")
                    .arg("-xjf")
                    .arg(&archive)
                    .arg("-C")
                    .arg(&staging)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|_| "Couldn't unpack voices. The system tar command is needed.")?,
            );
            drop(child_slot);
            loop {
                let mut child_slot = self.inner.download_child.lock().unwrap();
                let child = child_slot.as_mut().unwrap();
                if self.inner.cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    child_slot.take();
                    return Err("cancelled".into());
                }
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => {
                        child_slot.take();
                        break;
                    }
                    Ok(Some(_)) | Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        child_slot.take();
                        return Err("Couldn't unpack voices. Check free disk space and download again.".into());
                    }
                    Ok(None) => {
                        drop(child_slot);
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
            let extracted = staging.join(MODEL);
            if !required_files(&extracted) {
                return Err("The download is missing voice files. Try again.".into());
            }
            if self.inner.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            fs::write(extracted.join(".verified"), SHA256).map_err(|_| "Couldn't finish installing voices. Check free disk space.")?;
            let dest = root.join(MODEL);
            if dest.exists() {
                fs::remove_dir_all(&dest).map_err(|_| "Couldn't replace the old voices. Try again.")?;
            }
            fs::rename(extracted, dest).map_err(|_| "Couldn't finish installing voices. Check free disk space.")?;
            Ok(())
        })();
        if let Some(mut child) = self.inner.download_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_file(archive);
        let _ = fs::remove_dir_all(staging);
        result
    }
    pub fn remove(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.inner.download_running.load(Ordering::SeqCst) {
            return Err("Cancel the download before removing voices.".into());
        }
        self.release(app);
        let _operation = self.inner.operation.lock().unwrap();
        for dir in [self.inner.root.join(MODEL), self.inner.root.join("cache")] {
            if dir.exists() {
                fs::remove_dir_all(dir).map_err(|_| "Couldn't remove voices. Close any audio player and try again.")?;
            }
        }
        {
            let mut s = self.inner.status.lock().unwrap();
            s.model = "missing".into();
            s.downloaded = 0.0;
            s.error = None;
        }
        self.emit(app);
        Ok(())
    }
    pub fn speak(&self, app: &tauri::AppHandle, agent: &str, text: &str, thing: &str, kind: &str, override_voice: Option<Voice>) -> Result<(), String> {
        if self.status().model != "ready" {
            return Err("Download voices in Settings → Voices first.".into());
        }
        let state = app.state::<crate::AppState>();
        let (settings, saved) = {
            let cfg = state.config.lock().unwrap();
            let agent_cfg = cfg.agent(agent).ok_or("This agent is no longer on the team.")?;
            (cfg.voices.clone(), agent_cfg.voice.clone())
        };
        if !self.may_play(app, &settings, kind, agent) {
            return Ok(());
        }
        let voice = override_voice.or(saved).unwrap_or_else(|| default_for(agent)).clamped();
        let text = normalise(text);
        if text.is_empty() {
            return Ok(());
        }
        let line = Line {
            agent: agent.into(),
            thing: thing.into(),
            text: crate::chat::truncate(&text, 8000),
            voice,
            kind: kind.into(),
            token: thing.into(),
        };
        self.inner.queue.lock().unwrap().push(line);
        self.wake();
        Ok(())
    }
    /// Whether a line may play now. Whether the window is in front comes from the main thread,
    /// so it's asked only when the answer depends on it, and never while holding a lock.
    fn may_play(&self, app: &tauri::AppHandle, settings: &VoiceSettings, kind: &str, agent: &str) -> bool {
        let now = Local::now();
        let minute = now.hour() * 60 + now.minute();
        if !settings.allows(kind, false, minute) {
            return false;
        }
        if kind != "reply" && !(settings.background_only && kind != "manual") {
            return true;
        }
        let front = window_in_front(app);
        settings.allows(kind, front, minute) && !(kind == "reply" && front && self.inner.visible_chat.lock().unwrap().as_deref() == Some(agent))
    }
}
fn required_files(path: &Path) -> bool {
    ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-gb-en.txt"]
        .iter()
        .all(|f| path.join(f).is_file())
        && path.join("espeak-ng-data").is_dir()
}
fn model_ready(root: &Path) -> bool {
    let path = root.join(MODEL);
    required_files(&path) && fs::read_to_string(path.join(".verified")).is_ok_and(|s| s == SHA256)
}
fn verified_copy(
    mut input: impl Read,
    output: &mut impl Write,
    size: u64,
    checksum: &str,
    mut cancelled: impl FnMut() -> bool,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let mut bytes = 0;
    let mut hash = Sha256::new();
    let mut buf = [0; 64 * 1024];
    loop {
        if cancelled() {
            return Err("cancelled".into());
        }
        let n = input.read(&mut buf).map_err(|_| "The download stopped. Check your connection and try again.")?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > size {
            return Err("The download has an unexpected size. Try again.".into());
        }
        output.write_all(&buf[..n]).map_err(|_| "Couldn't save voices. Check free disk space.")?;
        hash.update(&buf[..n]);
        progress(bytes);
    }
    if cancelled() {
        return Err("cancelled".into());
    }
    if bytes != size || format!("{:x}", hash.finalize()) != checksum {
        return Err("The download didn't pass its safety check. Download voices again.".into());
    }
    Ok(())
}
fn window_in_front(app: &tauri::AppHandle) -> bool {
    app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false))
}

pub fn notice(app: &tauri::AppHandle, agent: &str, text: &str, thing: &str, kind: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        // Automatic notices stay silent until the developer has installed and enabled voices.
        let _ = state.voices.speak(app, agent, text, thing, kind, None);
    }
}
pub fn reply(app: &tauri::AppHandle, agent: &str, text: &str) {
    // Most replies are never spoken, so only clean up the text when this one could be.
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let wanted = {
        let cfg = state.config.lock().unwrap();
        cfg.voices.enabled && cfg.voices.replies
    };
    if wanted && state.voices.status().model == "ready" {
        notice(app, agent, &first_sentences(text), "reply", "reply");
    }
}

pub fn start(app: tauri::AppHandle) {
    let voices = app.state::<crate::AppState>().voices.clone();
    std::thread::spawn(move || {
        let mut model: Option<OfflineTts> = None;
        let mut last = Instant::now();
        let mut generation = 0;
        while !voices.inner.shutdown.load(Ordering::SeqCst) {
            let current = voices.inner.generation.load(Ordering::SeqCst);
            if current != generation || last.elapsed() >= IDLE || !app.state::<crate::AppState>().config.lock().unwrap().voices.enabled {
                model = None;
                generation = current;
            }
            let (line, epoch) = {
                let mut queue = voices.inner.queue.lock().unwrap();
                if queue.waiting.is_empty() {
                    queue = voices.inner.wake.wait_timeout(queue, Duration::from_secs(1)).unwrap().0;
                }
                (queue.waiting.pop_front(), queue.epoch)
            };
            let Some(line) = line else { continue };
            let settings = app.state::<crate::AppState>().config.lock().unwrap().voices.clone();
            if voices.status().model != "ready" || !voices.may_play(&app, &settings, &line.kind, &line.agent) {
                continue;
            }
            {
                let queue = voices.inner.queue.lock().unwrap();
                if epoch != queue.epoch {
                    continue;
                }
                let mut status = voices.inner.status.lock().unwrap();
                status.agent_id = Some(line.agent.clone());
                status.token = Some(line.token.clone());
                status.error = None;
            }
            voices.emit(&app);
            let result = (|| -> Result<(), String> {
                let _operation = voices.inner.operation.lock().unwrap();
                if epoch != voices.inner.queue.lock().unwrap().epoch {
                    return Ok(());
                }
                let cache = voices.inner.root.join("cache");
                fs::create_dir_all(&cache).map_err(|_| "Couldn't save speech. Check free disk space.")?;
                let path = cache.join(format!("{}.wav", cache_key(&line.voice, &line.text)));
                if !path.exists() {
                    if model.is_none() {
                        model = Some(load_model(&voices.inner.root.join(MODEL))?);
                    }
                    let tts = model.as_ref().unwrap();
                    let cancel = voices.clone();
                    let samples = synthesise(tts, &line.voice, &line.text, move |_, _| {
                        epoch == cancel.inner.queue.lock().unwrap().epoch && !cancel.inner.shutdown.load(Ordering::SeqCst)
                    })?;
                    if epoch != voices.inner.queue.lock().unwrap().epoch {
                        return Ok(());
                    }
                    write_wav(&path, &samples, tts.sample_rate()).map_err(|_| "Couldn't save speech. Check free disk space.")?;
                    evict(&cache, CACHE_LIMIT).map_err(|_| "Couldn't clear old speech files. Check the voices folder.")?;
                }
                last = Instant::now();
                play(&voices, &path, settings.volume, epoch);
                Ok(())
            })();
            let queue = voices.inner.queue.lock().unwrap();
            let mut status = voices.inner.status.lock().unwrap();
            if epoch == queue.epoch {
                status.agent_id = None;
                status.token = None;
                if let Err(e) = result {
                    status.error = Some(e);
                }
            }
            drop(status);
            drop(queue);
            voices.emit(&app);
        }
    });
}
fn play(voices: &Voices, path: &Path, volume: f32, epoch: u64) {
    let queue = voices.inner.queue.lock().unwrap();
    if epoch != queue.epoch || voices.inner.shutdown.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(target_os = "macos")]
    let child = Command::new("/usr/bin/afplay")
        .arg("-v")
        .arg(volume.to_string())
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok();
    #[cfg(not(target_os = "macos"))]
    let child = {
        Command::new("paplay")
            .arg(format!("--volume={}", (volume * 65536.0) as u32))
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()
            .or_else(|| {
                Command::new("aplay")
                    .arg("-q")
                    .arg(path)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .ok()
            })
    };
    *voices.inner.child.lock().unwrap() = child;
    drop(queue);
    loop {
        let mut child = voices.inner.child.lock().unwrap();
        let Some(player) = child.as_mut() else { break };
        match player.try_wait() {
            Ok(None) => {
                drop(child);
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                if let Some(mut player) = child.take() {
                    let _ = player.kill();
                    let _ = player.wait();
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("starkline-voices-{label}-{}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn line(agent: &str, thing: &str, kind: &str) -> Line {
        Line {
            agent: agent.into(),
            thing: thing.into(),
            kind: kind.into(),
            text: thing.into(),
            voice: Voice::default(),
            token: thing.into(),
        }
    }
    #[test]
    fn speech_text_table() {
        for (text, spoken) in [
            ("# **Ready**\n- Open the PR; CI passed.", "Ready Open the P R; C I passed."),
            ("Run `npm test` for the UI API JSON.", "Run N P M test for the U I A P I J-SON."),
            (
                "Here's ```rust\nfn main() {}\n``` and a link: https://example.com/test",
                "Here's some code and a link: a link",
            ),
            ("Read [the guide](https://example.com).", "Read the guide."),
            ("Changed `/Users/dev/code/app.tsx` and ./src/lib/api.ts.", "Changed app.tsx and api.ts."),
            ("PRIOR npmish build\0done", "PRIOR npmish build done"),
        ] {
            assert_eq!(normalise(text), spoken);
        }
        assert_eq!(first_sentences("One. Two! Three? Four."), "One. Two!");
        assert_eq!(
            first_sentences("See https://example.com. The checks passed. Next, deploy."),
            "See a link. The checks passed."
        );
    }

    #[test]
    fn loudness_targets_rms_without_clipping_or_amplifying_silence() {
        let mut samples: Vec<f32> = (0..24000).map(|i| (i as f32 * 0.1).sin() * 0.01).collect();
        loudness(&mut samples);
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        assert!((20.0 * rms.log10() + 18.0).abs() < 0.01);
        let mut spike = vec![0.001; 1000];
        spike[0] = 1.0;
        loudness(&mut spike);
        assert!(spike.iter().all(|s| s.abs() <= 10.0_f32.powf(-1.0 / 20.0) + 1e-6));
        let mut silence = vec![0.0; 100];
        loudness(&mut silence);
        assert_eq!(silence, vec![0.0; 100]);
        loudness(&mut []);
    }

    #[test]
    fn pitch_resampling_and_generation_speed_preserve_tempo() {
        let original = vec![0.1; 24000];
        assert_eq!(resample(&original, 0.0), original);
        for pitch in [-6.0, 4.0, 6.0] {
            let ratio = pitch_ratio(pitch);
            assert_eq!(resample(&original, pitch).len(), (24000.0 / ratio).round() as usize);
            let desired_speed = 1.15;
            let generated_len = (24000.0 / (desired_speed / ratio)).round() as usize;
            let output = resample(&vec![0.1; generated_len], pitch);
            assert!((output.len() as f32 - 24000.0 / desired_speed).abs() <= 1.0);
        }
        assert!(resample(&[], 4.0).is_empty());
    }

    #[test]
    fn cache_includes_all_voice_inputs_and_evicts_oldest_wavs() {
        let voice = Voice::default();
        let key = cache_key(&voice, "Hello");
        assert_eq!(key, cache_key(&voice, "Hello"));
        assert_ne!(key, cache_key(&voice, "Goodbye"));
        for changed in [
            Voice {
                name: "bm_george".into(),
                ..voice.clone()
            },
            Voice { speed: 1.1, ..voice.clone() },
            Voice { pitch: 4.0, ..voice.clone() },
        ] {
            assert_ne!(key, cache_key(&changed, "Hello"));
        }
        let dir = temp("cache");
        for (index, modified) in [1, 3, 2].into_iter().enumerate() {
            let path = dir.join(format!("{index}.wav"));
            let f = File::create(path).unwrap();
            f.set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(modified)))
                .unwrap();
        }
        fs::write(dir.join("keep.txt"), "keep").unwrap();
        evict(&dir, 2).unwrap();
        assert!(!dir.join("0.wav").exists());
        assert!(dir.join("1.wav").exists());
        assert!(dir.join("2.wav").exists());
        assert!(dir.join("keep.txt").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queue_preserves_reminders_replaces_waiting_lines_and_stops() {
        let mut queue = Queue::default();
        queue.push(line("jarvis", "reminder:1", "reminder"));
        for i in 0..6 {
            queue.push(line("friday", &format!("task:{i}"), "ready"));
        }
        assert_eq!(queue.waiting.len(), 5);
        assert_eq!(queue.waiting[0].thing, "reminder:1");
        assert_eq!(queue.waiting[1].thing, "task:2");
        let mut replacement = line("friday", "task:4", "failure");
        replacement.text = "New status".into();
        queue.push(replacement);
        assert_eq!(queue.waiting.len(), 5);
        assert_eq!(queue.waiting[3].text, "New status");
        queue.stop();
        assert!(queue.waiting.is_empty());
        assert_eq!(queue.epoch, 1);
        for i in 0..6 {
            queue.push(line("jarvis", &format!("reminder:{i}"), "reminder"));
        }
        assert_eq!(queue.waiting.len(), 6);
        queue.push(line("friday", "routine", "ready"));
        assert_eq!(queue.waiting.len(), 6);
        queue.stop();
        assert!(queue.waiting.is_empty());
        assert_eq!(queue.epoch, 2);
    }

    #[test]
    fn quiet_hours_and_category_switches_apply_in_the_background() {
        assert!(quiet_at("22:00", "08:00", 23 * 60));
        assert!(quiet_at("22:00", "08:00", 7 * 60));
        assert!(!quiet_at("22:00", "08:00", 8 * 60));
        assert!(!quiet_at("22:00", "08:00", 12 * 60));
        assert!(quiet_at("09:00", "17:00", 9 * 60));
        assert!(!quiet_at("09:00", "17:00", 17 * 60));
        assert!(quiet_at("12:00", "12:00", 0));
        assert!(!quiet_at("bad", "08:00", 0));
        let mut settings = VoiceSettings::default();
        assert!(!settings.allows("reminder", false, 12 * 60));
        settings.enabled = true;
        for kind in ["reminder", "ready", "needs_you", "failure", "manual"] {
            assert!(settings.allows(kind, true, 12 * 60));
        }
        assert!(!settings.allows("reply", false, 12 * 60));
        assert!(!settings.allows("something new", false, 12 * 60));
        settings.background_only = true;
        assert!(!settings.allows("ready", true, 12 * 60));
        assert!(settings.allows("ready", false, 12 * 60));
        settings.quiet_hours = true;
        assert!(!settings.allows("reminder", false, 23 * 60));
        // What you ask to hear isn't held back by the switches meant for automatic notices.
        assert!(settings.allows("manual", true, 23 * 60));
        settings.enabled = false;
        assert!(!settings.allows("manual", true, 12 * 60));
        settings.quiet_from = "invalid".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn old_configs_load_with_builtin_defaults_and_custom_voices_round_trip() {
        let dir = temp("config");
        let path = dir.join("config.json");
        let mut json = serde_json::to_value(crate::config::default_config()).unwrap();
        json.as_object_mut().unwrap().remove("voices");
        for agent in json["agents"].as_array_mut().unwrap() {
            agent.as_object_mut().unwrap().remove("voice");
        }
        fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        let mut cfg = crate::config::load(&path);
        assert!(!cfg.voices.enabled);
        assert!(cfg.voices.reminders && cfg.voices.ready && cfg.voices.needs_you && cfg.voices.failures);
        assert!(!cfg.voices.replies);
        for agent in &cfg.agents {
            assert_eq!(agent.voice.as_ref().unwrap(), &default_for(&agent.id));
        }
        assert_eq!(default_for("custom"), default_for("another"));
        cfg.agents[0].voice = Some(Voice {
            name: "bm_fable".into(),
            speed: 1.2,
            pitch: -2.0,
        });
        cfg.voices.enabled = true;
        fs::write(&path, serde_json::to_vec(&cfg).unwrap()).unwrap();
        let restored = crate::config::load(&path);
        assert_eq!(restored.agents[0].voice, cfg.agents[0].voice);
        assert!(restored.voices.enabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn download_checks_checksum_size_cancellation_and_progress_with_fake_fetcher() {
        let bytes = b"a fake voice archive";
        let checksum = format!("{:x}", Sha256::digest(bytes));
        let mut progress = Vec::new();
        let mut output = Vec::new();
        verified_copy(&bytes[..], &mut output, bytes.len() as u64, &checksum, || false, |p| progress.push(p)).unwrap();
        assert_eq!(output, bytes);
        assert_eq!(progress, vec![bytes.len() as u64]);
        for (size, hash) in [(bytes.len() as u64, "wrong"), (1, checksum.as_str()), (100, checksum.as_str())] {
            assert!(verified_copy(&bytes[..], &mut Vec::new(), size, hash, || false, |_| {}).is_err());
        }
        assert_eq!(
            verified_copy(&bytes[..], &mut Vec::new(), bytes.len() as u64, &checksum, || true, |_| {}).unwrap_err(),
            "cancelled"
        );
        let cancel = std::cell::Cell::new(false);
        assert_eq!(
            verified_copy(
                &bytes[..],
                &mut Vec::new(),
                bytes.len() as u64,
                &checksum,
                || cancel.get(),
                |_| cancel.set(true)
            )
            .unwrap_err(),
            "cancelled"
        );
    }

    #[test]
    fn download_state_recovers_from_checksum_failure_and_cancel_then_becomes_ready() {
        let dir = temp("download-state");
        let voices = Voices::new(dir.clone());
        assert_eq!(voices.status().model, "missing");
        assert!(voices.begin_download().unwrap());
        assert_eq!(voices.status().model, "downloading");
        assert!(voices.begin_download().is_err());
        let mismatch = verified_copy(&b"bad"[..], &mut Vec::new(), 3, SHA256, || false, |_| {});
        voices.finish_download(mismatch);
        assert_eq!(voices.status().model, "missing");
        assert!(voices.status().error.unwrap().contains("safety check"));
        assert!(voices.begin_download().unwrap());
        assert!(voices.status().error.is_none());
        *voices.inner.download_child.lock().unwrap() = Some(Command::new("sleep").arg("60").spawn().unwrap());
        voices.cancel_download();
        let mut child = voices.inner.download_child.lock().unwrap().take().unwrap();
        assert!(!child.wait().unwrap().success());
        let cancelled = verified_copy(&b"ok"[..], &mut Vec::new(), 2, SHA256, || voices.inner.cancel.load(Ordering::SeqCst), |_| {});
        voices.finish_download(cancelled);
        assert_eq!(voices.status().model, "missing");
        assert!(voices.status().error.is_none());
        assert!(voices.begin_download().unwrap());
        assert!(!voices.inner.cancel.load(Ordering::SeqCst));
        voices.finish_download(Ok(()));
        assert_eq!(voices.status().model, "ready");
        assert_eq!(voices.status().downloaded, ARCHIVE_BYTES as f64);
        fs::remove_dir_all(dir).unwrap();
    }

    fn onnx_metadata(path: &Path) -> std::collections::HashMap<String, String> {
        use std::io::{Cursor, Seek, SeekFrom};
        fn varint(reader: &mut impl Read) -> Option<u64> {
            let mut result = 0;
            for shift in (0..64).step_by(7) {
                let mut byte = [0];
                reader.read_exact(&mut byte).ok()?;
                result |= ((byte[0] & 127) as u64) << shift;
                if byte[0] < 128 {
                    return Some(result);
                }
            }
            None
        }
        let mut file = File::open(path).unwrap();
        let mut metadata = std::collections::HashMap::new();
        while let Some(tag) = varint(&mut file) {
            match tag & 7 {
                0 => {
                    varint(&mut file).unwrap();
                }
                1 => {
                    file.seek(SeekFrom::Current(8)).unwrap();
                }
                5 => {
                    file.seek(SeekFrom::Current(4)).unwrap();
                }
                2 => {
                    let size = varint(&mut file).unwrap();
                    if tag >> 3 == 14 {
                        let mut bytes = vec![0; size as usize];
                        file.read_exact(&mut bytes).unwrap();
                        let mut entry = Cursor::new(bytes);
                        assert_eq!(varint(&mut entry), Some(10));
                        let length = varint(&mut entry).unwrap() as usize;
                        let mut key = vec![0; length];
                        entry.read_exact(&mut key).unwrap();
                        assert_eq!(varint(&mut entry), Some(18));
                        let length = varint(&mut entry).unwrap() as usize;
                        let mut value = vec![0; length];
                        entry.read_exact(&mut value).unwrap();
                        metadata.insert(String::from_utf8(key).unwrap(), String::from_utf8(value).unwrap());
                    } else {
                        file.seek(SeekFrom::Current(size as i64)).unwrap();
                    }
                }
                _ => panic!("Unexpected ONNX field"),
            }
        }
        metadata
    }

    #[test]
    #[ignore = "Needs the unpacked Kokoro model: STARKLINE_VOICE_MODEL=<folder> cargo test real_model_samples -- --ignored"]
    fn real_model_samples() {
        let path = PathBuf::from(std::env::var_os("STARKLINE_VOICE_MODEL").expect("set STARKLINE_VOICE_MODEL to the unpacked kokoro-multi-lang-v1_0 folder"));
        let metadata = onnx_metadata(&path.join("model.onnx"));
        assert_eq!(metadata["n_speakers"], "54");
        let names: Vec<_> = metadata["speaker_names"].split(',').collect();
        assert_eq!(&names[..28], &ENGLISH);
        for (id, name) in ENGLISH.iter().enumerate() {
            assert!(metadata["id2speaker"].split(',').any(|mapping| mapping == format!("{id}->{name}")));
        }
        let tts = load_model(&path).unwrap();
        // Each style has 510 x 256 float32 values. The appended Spanish voice leaves English unchanged.
        assert_eq!(fs::metadata(path.join("voices.bin")).unwrap().len(), 54 * 510 * 256 * 4);
        let out = std::env::temp_dir().join("starkline-voice-samples");
        fs::create_dir_all(&out).unwrap();
        for (agent, text) in [
            ("jarvis", "It's five o'clock. You asked me to remind you to check the deploy."),
            ("friday", "FRIDAY here: the login fix is ready for your review."),
            ("vision", "The checks passed. The PR is ready when you are."),
            ("dum-e", "All done! Ready to help again."),
        ] {
            let samples = synthesise(&tts, &default_for(agent), &normalise(text), |_, _| true).unwrap();
            let seconds = samples.len() as f32 / tts.sample_rate() as f32;
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
            assert!((1.0..30.0).contains(&seconds), "{agent}: {seconds}s");
            assert!(rms > 0.01, "{agent}: silent audio");
            assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 10.0_f32.powf(-1.0 / 20.0) + 1e-6));
            write_wav(&out.join(format!("{agent}.wav")), &samples, tts.sample_rate()).unwrap();
            println!("{agent}: {seconds:.2}s, RMS {rms:.4}, {} samples", samples.len());
        }
    }
}
