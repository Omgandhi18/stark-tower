//! Character portraits drawn by the developer's Codex, kept on this machine.
use image::{imageops::FilterType, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

pub const SETUP: &str = "Starkline asks Codex to draw new looks, with your own Codex sign-in. Install Codex, then run `codex login` in Terminal.";
pub const THEMES: [&str; 3] = ["own", "studio-office", "mori-cafe"];
pub const FIELDS: [(&str, &[&str]); 9] = [
    ("skin tone", &["porcelain", "fair", "sand", "olive", "brown", "deep brown"]),
    (
        "hair style",
        &["short", "cropped", "long", "curly", "coily", "bun", "ponytail", "braids", "shaved", "bald"],
    ),
    (
        "hair colour",
        &["black", "dark brown", "brown", "auburn", "blonde", "grey", "white", "your accent colour"],
    ),
    ("facial hair", &["none", "stubble", "moustache", "beard"]),
    ("glasses", &["none", "round", "rectangular", "tech visor", "sunglasses"]),
    ("headwear", &["none", "headset", "earpiece", "headphones", "cap", "beanie"]),
    (
        "signature accessory",
        &["none", "scarf", "tie", "bow tie", "pendant", "ID badge", "pin in your accent colour"],
    ),
    ("expression", &["calm", "smiling", "focused", "wry"]),
    (
        "personal accent",
        &[
            "#4fd0ff", "#7cf5c4", "#ffd166", "#ff9e64", "#ff6b78", "#e86b9a", "#c08cff", "#8ab4ff", "#9aa7b2",
        ],
    ),
];
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct Choices {
    pub figure: String,
    pub options: HashMap<String, String>,
    pub note: String,
}
impl Choices {
    pub fn validate(&self) -> Result<(), String> {
        if !["commander", "architect", "engineer", "recon", "specialist", "operative", "helperbot"].contains(&self.figure.as_str()) {
            return Err("Choose a starting figure.".into());
        }
        if self.note.chars().count() > 120 {
            return Err("Keep the note to 120 characters.".into());
        }
        for (key, value) in &self.options {
            if !FIELDS.iter().any(|(field, values)| *field == key && values.contains(&value.as_str())) {
                return Err(format!("Choose one of the listed options for {key}."));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct Look {
    pub id: String,
    pub choices: Choices,
    pub paths: HashMap<String, String>,
    pub progress: HashMap<String, String>,
    pub errors: HashMap<String, String>,
    pub revision: u32,
    pub saved: bool,
}
#[derive(Clone)]
struct Job {
    look: Look,
    cancel: Arc<AtomicBool>,
    running: bool,
}
pub struct Studio {
    root: PathBuf,
    jobs: Mutex<HashMap<String, Job>>,
}
static IDS: AtomicU64 = AtomicU64::new(0);
static SCHEDULE: Mutex<(usize, Option<Instant>)> = Mutex::new((0, None));
struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        SCHEDULE.lock().unwrap().0 -= 1;
    }
}
fn turn(cancel: &AtomicBool) -> Result<Permit, String> {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Drawing cancelled.".into());
        }
        {
            let mut schedule = SCHEDULE.lock().unwrap();
            if schedule.0 < 2 && schedule.1.is_none_or(|at| at.elapsed() >= Duration::from_secs(20)) {
                schedule.0 += 1;
                schedule.1 = Some(Instant::now());
                return Ok(Permit);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.starts_with("look-") && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("That look couldn't be found.".into())
    }
}
impl Studio {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            jobs: Mutex::new(HashMap::new()),
        }
    }
    fn dir(&self, id: &str) -> Result<PathBuf, String> {
        valid_id(id)?;
        Ok(self.root.join(id))
    }
    fn write(&self, look: &Look) -> Result<(), String> {
        let dir = self.dir(&look.id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(look).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("look.json.tmp"), bytes).map_err(|e| e.to_string())?;
        std::fs::rename(dir.join("look.json.tmp"), dir.join("look.json")).map_err(|e| e.to_string())
    }
    pub fn list(&self) -> Vec<Look> {
        std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let path = entry.ok()?.path().join("look.json");
                let look: Look = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
                look.saved.then_some(look)
            })
            .collect()
    }
    pub fn get(&self, id: &str) -> Result<Look, String> {
        if let Some(job) = self.jobs.lock().unwrap().get(id) {
            return Ok(job.look.clone());
        }
        serde_json::from_slice(&std::fs::read(self.dir(id)?.join("look.json")).map_err(|_| "That look couldn't be found.")?).map_err(|e| e.to_string())
    }
    pub fn save(&self, id: &str) -> Result<Look, String> {
        let mut jobs = self.jobs.lock().unwrap();
        let job = jobs.get_mut(id).ok_or("Draw a look before using it.")?;
        if job.running || job.cancel.load(Ordering::SeqCst) || THEMES.iter().any(|theme| job.look.progress.get(*theme).map(String::as_str) != Some("ready")) {
            return Err("Wait for all three looks to finish before using them.".into());
        }
        let mut saved = job.look.clone();
        saved.saved = true;
        self.write(&saved)?;
        job.look = saved;
        Ok(job.look.clone())
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let running = {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(job) = jobs.get_mut(id) {
                job.cancel.store(true, Ordering::SeqCst);
                job.running
            } else {
                false
            }
        };
        if !running {
            let dir = self.dir(id)?;
            if dir.exists() {
                std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            }
            self.jobs.lock().unwrap().remove(id);
        }
        Ok(())
    }
    fn update(&self, app: &tauri::AppHandle, id: &str, change: impl FnOnce(&mut Look)) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(job) = jobs.get_mut(id) {
            change(&mut job.look);
            let _ = app.emit("studio://progress", job.look.clone());
        }
    }
    pub fn start(&self, app: tauri::AppHandle, choices: Choices, id: Option<String>, theme: Option<String>) -> Result<Look, String> {
        choices.validate()?;
        let themes = match theme {
            Some(t) if THEMES.contains(&t.as_str()) => vec![t],
            None => THEMES.iter().map(|t| t.to_string()).collect(),
            _ => return Err("Choose a theme to draw.".into()),
        };
        let program = codex_path()?;
        let id = id.unwrap_or_else(|| {
            format!(
                "look-{}-{}",
                std::process::id(),
                IDS.fetch_add(1, Ordering::SeqCst)
                    + std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
            )
        });
        let dir = self.dir(&id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let look = {
            let mut jobs = self.jobs.lock().unwrap();
            let job = jobs.entry(id.clone()).or_insert_with(|| Job {
                look: Look {
                    id: id.clone(),
                    choices: choices.clone(),
                    paths: HashMap::new(),
                    progress: HashMap::new(),
                    errors: HashMap::new(),
                    revision: 0,
                    saved: false,
                },
                cancel: Arc::new(AtomicBool::new(false)),
                running: false,
            });
            if job.running || job.look.saved {
                return Err("Finish this drawing before starting another.".into());
            }
            if serde_json::to_value(&job.look.choices).ok() != serde_json::to_value(&choices).ok() {
                return Err("Draw a new look after changing the choices.".into());
            }
            job.cancel.store(false, Ordering::SeqCst);
            job.running = true;
            job.look.revision += 1;
            for t in &themes {
                job.look.progress.insert(t.clone(), "queued".into());
                job.look.errors.remove(t);
            }
            job.look.clone()
        };
        if let Err(error) = self.write(&look) {
            self.jobs.lock().unwrap().remove(&id);
            return Err(format!(
                "Couldn't keep the drawing: {error}. Check the app data folder is writable, then try again."
            ));
        }
        let initial = look.clone();
        std::thread::spawn(move || {
            let studio = app.state::<Studio>();
            let cancel = studio.jobs.lock().unwrap().get(&id).unwrap().cancel.clone();
            std::thread::scope(|scope| {
                for theme in themes {
                    let (app, id, choices, dir, program, cancel) = (app.clone(), id.clone(), choices.clone(), dir.clone(), program.clone(), cancel.clone());
                    scope.spawn(move || {
                        let studio = app.state::<Studio>();
                        let result = (|| {
                            let _permit = turn(&cancel)?;
                            studio.update(&app, &id, |look| {
                                look.progress.insert(theme.clone(), "drawing".into());
                            });
                            let work = dir.join(format!("work-{theme}"));
                            std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
                            let reference = work.join("reference.png");
                            reference_image(&choices.figure, &theme, &reference)?;
                            let original = draw(&program, &work, &reference, &prompt(&choices, &theme), &cancel, Some(&app))?;
                            let output = dir.join(format!("{theme}.png"));
                            process(&original, &output, &choices.figure, &theme)?;
                            std::fs::copy(original, dir.join(format!("{theme}-original.png"))).map_err(|e| e.to_string())?;
                            Ok::<_, String>(output.to_string_lossy().to_string())
                        })();
                        studio.update(&app, &id, |look| match result {
                            Ok(path) => {
                                look.paths.insert(theme.clone(), path);
                                look.progress.insert(theme, "ready".into());
                            }
                            Err(error) => {
                                look.progress.insert(theme.clone(), "failed".into());
                                look.errors.insert(theme, error);
                            }
                        });
                    });
                }
            });
            let final_look = {
                let mut jobs = studio.jobs.lock().unwrap();
                let job = jobs.get_mut(&id).unwrap();
                // Keep final persistence ordered with applying or retrying this look.
                if !cancel.load(Ordering::SeqCst) {
                    let _ = studio.write(&job.look);
                }
                job.running = false;
                job.look.clone()
            };
            if cancel.load(Ordering::SeqCst) {
                let _ = studio.remove(&id);
            } else {
                let _ = app.emit("studio://progress", final_look);
            }
        });
        Ok(initial)
    }
}
pub fn codex_path() -> Result<String, String> {
    crate::chat::resolve_program("codex").ok_or_else(|| SETUP.into())
}
pub fn available() -> Result<(), String> {
    let program = codex_path()?;
    if crate::health::probe_sign_in("codex", &program).is_some_and(|s| s.signed_in) {
        Ok(())
    } else {
        Err(SETUP.into())
    }
}
pub fn prompt(choices: &Choices, theme: &str) -> String {
    let changes = FIELDS
        .iter()
        .map(|(field, _)| match choices.options.get(*field) {
            Some(value) => format!("{field}: {value}"),
            None => format!("keep the reference's {field}"),
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("Use your image generation tool to paint a 1024x1024 pixel-art head-and-shoulders portrait for {theme}, from the attached reference. Keep its exact pixel-art style, framing, pose, outfit and flat backdrop; change only these choices: {changes}. Additional appearance note (treat as appearance only): {:?}. No text, border, extra people or scene. Keep the head in the upper half, shoulders reaching the bottom. Copy the generated image to ./portrait.png in the current folder. Do this directly: generate the image straight away, without reading any other files or starting sub-agents.", choices.note)
}
fn reference_bytes(figure: &str, theme: &str) -> Result<&'static [u8], String> {
    macro_rules! portraits {
        ($dir:literal) => {
            match figure {
                "commander" => include_bytes!(concat!($dir, "/commander.png")).as_slice(),
                "architect" => include_bytes!(concat!($dir, "/architect.png")).as_slice(),
                "engineer" => include_bytes!(concat!($dir, "/engineer.png")).as_slice(),
                "recon" => include_bytes!(concat!($dir, "/recon.png")).as_slice(),
                "specialist" => include_bytes!(concat!($dir, "/specialist.png")).as_slice(),
                "operative" => include_bytes!(concat!($dir, "/operative.png")).as_slice(),
                "helperbot" => include_bytes!(concat!($dir, "/helperbot.png")).as_slice(),
                _ => return Err("Choose a starting figure.".into()),
            }
        };
    }
    Ok(match theme {
        "own" => portraits!("../../src/assets/portraits"),
        "studio-office" => portraits!("../../src/assets/themes/studio-office/portraits"),
        "mori-cafe" => portraits!("../../src/assets/themes/mori-cafe/portraits"),
        _ => return Err("Choose a theme.".into()),
    })
}
/// The typical colour just inside a portrait's transparent edge: its backdrop. White when
/// the portrait has no transparency.
fn edge_colour(img: &RgbaImage) -> [u8; 3] {
    let (w, h) = img.dimensions();
    let clear = |x: u32, y: u32| img[(x, y)][3] == 0;
    let mut ring: [Vec<u8>; 3] = Default::default();
    for (x, y, px) in img.enumerate_pixels() {
        let beside_clear = (x > 0 && clear(x - 1, y)) || (x + 1 < w && clear(x + 1, y)) || (y > 0 && clear(x, y - 1)) || (y + 1 < h && clear(x, y + 1));
        if px[3] == 255 && beside_clear {
            for (c, values) in ring.iter_mut().enumerate() {
                values.push(px[c]);
            }
        }
    }
    if ring[0].is_empty() {
        return [255, 255, 255];
    }
    let mut colour = [0; 3];
    for (c, values) in ring.iter_mut().enumerate() {
        values.sort_unstable();
        colour[c] = values[values.len() / 2];
    }
    colour
}

fn reference_image(figure: &str, theme: &str, path: &Path) -> Result<(), String> {
    let img = image::load_from_memory(reference_bytes(figure, theme)?).map_err(|e| e.to_string())?.to_rgba8();
    // Flatten a round reference onto its own backdrop colour, so the drawing carries no light
    // rim around the circle when the reference's shape is applied to it again.
    let backdrop = edge_colour(&img);
    let mut flat = img.clone();
    for px in flat.pixels_mut() {
        let a = px[3] as u32;
        for c in 0..3 {
            px[c] = ((px[c] as u32 * a + backdrop[c] as u32 * (255 - a)) / 255) as u8;
        }
        px[3] = 255;
    }
    image::imageops::resize(&flat, 1024, 1024, FilterType::Nearest)
        .save(path)
        .map_err(|e| e.to_string())
}
pub fn command(program: &str, work: &Path, reference: &Path, prompt: &str) -> Command {
    let mut command = Command::new(program);
    command
        .args(["exec", "-m", "gpt-5.6-sol", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C"])
        .arg(work)
        .arg("-i")
        .arg(reference)
        .arg("--json")
        .arg(prompt)
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
}
fn draw(program: &str, work: &Path, reference: &Path, prompt: &str, cancel: &AtomicBool, app: Option<&tauri::AppHandle>) -> Result<PathBuf, String> {
    let output = work.join("portrait.png");
    if output.exists() {
        std::fs::remove_file(&output).map_err(|e| e.to_string())?;
    }
    let log_path = work.join("codex.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = command(program, work, reference, prompt)
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Couldn't start Codex: {e}. {SETUP}"))?;
    let pid = child.id();
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().insert(pid);
    }
    let started = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(900) {
            crate::proc::kill_tree(pid);
            let _ = child.wait();
            break Err(if cancel.load(Ordering::SeqCst) {
                "Drawing cancelled."
            } else {
                "Codex took longer than 15 minutes. Try drawing again."
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() && output.is_file() {
                    break Ok(output);
                }
                let text = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail = text.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
                break Err(format!(
                    "Codex couldn't draw this look. Try again.\n{}",
                    tail.chars().take(4000).collect::<String>()
                ));
            }
            Err(e) => {
                crate::proc::kill_tree(pid);
                let _ = child.wait();
                break Err(format!("Couldn't read Codex's result: {e}. Try again."));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().remove(&pid);
    }
    result
}
/// `drawing` at `reference`'s size, with `reference`'s transparency.
fn shaped_like(drawing: &RgbaImage, reference: &RgbaImage) -> RgbaImage {
    let (w, h) = reference.dimensions();
    let mut portrait = image::imageops::resize(drawing, w, h, FilterType::Lanczos3);
    for (px, shape) in portrait.pixels_mut().zip(reference.pixels()) {
        px[3] = shape[3];
    }
    portrait
}

/// Make a drawing into a portrait the app can use. Codex paints over the reference portrait
/// and keeps its framing and backdrop, so the drawing takes the reference's size and shape:
/// scaled to fit, with the reference's own transparency (the agents' own look is a circle,
/// each theme's a square).
pub fn process(original: &Path, output: &Path, figure: &str, theme: &str) -> Result<(), String> {
    let drawing = image::open(original).map_err(|e| format!("Couldn't read the drawing: {e}"))?.to_rgba8();
    let reference = image::load_from_memory(reference_bytes(figure, theme)?).map_err(|e| e.to_string())?.to_rgba8();
    shaped_like(&drawing, &reference).save(output).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn choices() -> Choices {
        Choices {
            figure: "recon".into(),
            options: HashMap::new(),
            note: String::new(),
        }
    }
    fn folder() -> PathBuf {
        let path = std::env::temp_dir().join(format!("starkline-studio-test-{}-{}", std::process::id(), IDS.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn every_choice_is_plain_and_unselected_features_are_kept() {
        let mut c = choices();
        for (field, values) in FIELDS {
            assert!(prompt(&c, "own").contains(&format!("keep the reference's {field}")));
            for value in values {
                c.options.insert(field.into(), (*value).into());
                c.validate().unwrap();
                assert!(prompt(&c, "own").contains(&format!("{field}: {value}")));
            }
            c.options.clear();
        }
        c.note = "freckles, a silver ring".into();
        assert!(prompt(&c, "own").contains(&c.note));
        c.note = "a".repeat(121);
        assert!(c.validate().is_err());
        c.note.clear();
        c.figure = "../escape".into();
        assert!(c.validate().is_err());
    }
    #[test]
    fn a_round_reference_is_flattened_onto_its_own_backdrop() {
        let own = image::load_from_memory(reference_bytes("recon", "own").unwrap()).unwrap().to_rgba8();
        let backdrop = edge_colour(&own);
        assert!(backdrop.iter().all(|&c| c < 160), "a dark backdrop, not white: {backdrop:?}");
        let square = image::load_from_memory(reference_bytes("recon", "studio-office").unwrap()).unwrap().to_rgba8();
        assert_eq!(edge_colour(&square), [255, 255, 255]);
    }

    #[test]
    fn a_drawing_takes_its_reference_portraits_size_and_shape() {
        let drawing = RgbaImage::from_pixel(1024, 1024, image::Rgba([200, 120, 90, 255]));
        for theme in ["own", "studio-office", "mori-cafe"] {
            let reference = image::load_from_memory(reference_bytes("recon", theme).unwrap()).unwrap().to_rgba8();
            let portrait = shaped_like(&drawing, &reference);
            assert_eq!(portrait.dimensions(), reference.dimensions(), "{theme}");
            assert!(
                portrait.pixels().zip(reference.pixels()).all(|(p, r)| p[3] == r[3]),
                "{theme} keeps the reference's shape"
            );
            assert_eq!(portrait[(portrait.width() / 2, portrait.height() / 2)], image::Rgba([200, 120, 90, 255]));
        }
        // The agents' own look is round: its corners stay clear; a theme's portrait is a full square.
        let own = shaped_like(&drawing, &image::load_from_memory(reference_bytes("recon", "own").unwrap()).unwrap().to_rgba8());
        assert_eq!(own[(0, 0)][3], 0);
        let office = shaped_like(
            &drawing,
            &image::load_from_memory(reference_bytes("recon", "studio-office").unwrap()).unwrap().to_rgba8(),
        );
        assert!(office.pixels().all(|p| p[3] == 255));
    }
    #[test]
    fn stores_choices_originals_and_portraits_and_removes_the_look() {
        let root = folder();
        let studio = Studio::new(root.clone());
        let look = Look {
            id: "look-roundtrip".into(),
            choices: choices(),
            paths: HashMap::new(),
            progress: THEMES.iter().map(|t| (t.to_string(), "ready".into())).collect(),
            errors: HashMap::new(),
            revision: 1,
            saved: false,
        };
        studio.write(&look).unwrap();
        let dir = studio.dir(&look.id).unwrap();
        for t in THEMES {
            std::fs::write(dir.join(format!("{t}.png")), b"portrait").unwrap();
            std::fs::write(dir.join(format!("{t}-original.png")), b"original").unwrap();
        }
        let read = studio.get(&look.id).unwrap();
        assert_eq!(read.choices.figure, "recon");
        assert!(studio.list().is_empty());
        studio.jobs.lock().unwrap().insert(
            look.id.clone(),
            Job {
                look: look.clone(),
                cancel: Arc::new(AtomicBool::new(false)),
                running: true,
            },
        );
        assert!(studio.save(&look.id).is_err());
        studio.jobs.lock().unwrap().get_mut(&look.id).unwrap().running = false;
        assert!(studio.save(&look.id).unwrap().saved);
        assert_eq!(studio.list().len(), 1);
        assert!(studio.remove("../escape").is_err());
        assert!(root.exists());
        studio.remove(&look.id).unwrap();
        assert!(!dir.exists());
        assert!(studio.list().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uses_arguments_without_a_shell_and_reports_a_missing_cli() {
        let work = Path::new("/tmp/a folder");
        let reference = work.join("reference.png");
        let text = "appearance; $(touch do-not-run)";
        let cmd = command("codex", work, &reference, text);
        assert_eq!(cmd.get_program(), "codex");
        assert_eq!(
            cmd.get_args().map(|s| s.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            vec![
                "exec",
                "-m",
                "gpt-5.6-sol",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "-C",
                "/tmp/a folder",
                "-i",
                "/tmp/a folder/reference.png",
                "--json",
                text
            ]
        );
        let dir = folder();
        let error = draw("/nonexistent/codex", &dir, &reference, text, &AtomicBool::new(false), None).unwrap_err();
        assert!(error.contains("Install Codex"));
        assert!(error.contains("codex login"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn cancellation_stops_the_child_process_group() {
        use std::os::unix::fs::PermissionsExt;
        let dir = folder();
        let script = dir.join("fake-codex");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                cancelled.store(true, Ordering::SeqCst);
            });
            let result = draw(script.to_str().unwrap(), &dir, &dir.join("reference.png"), "draw", &cancelled, None);
            assert_eq!(result.unwrap_err(), "Drawing cancelled.");
        });
        assert!(started.elapsed() < Duration::from_secs(3));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_configs_default_to_no_custom_look_and_removal_round_trips() {
        let mut config = crate::config::default_config();
        let mut value = serde_json::to_value(&config).unwrap();
        for agent in value["agents"].as_array_mut().unwrap() {
            agent.as_object_mut().unwrap().remove("look");
        }
        let old: crate::config::AppConfig = serde_json::from_value(value).unwrap();
        assert!(old.agents.iter().all(|a| a.look.is_none()));
        config.agents[0].look = Some("look-config".into());
        assert_eq!(config.roster()[0].look.as_deref(), Some("look-config"));
        let root = folder();
        let path = root.join("config.json");
        crate::config::save(&path, &config);
        assert_eq!(crate::config::load(&path).agents[0].look.as_deref(), Some("look-config"));
        config.agents[0].look = None;
        crate::config::save(&path, &config);
        assert!(crate::config::load(&path).agents[0].look.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "draws three portraits with the developer's signed-in Codex"]
    fn real_drawing_end_to_end() {
        available().expect("Codex must be installed and signed in");
        let root = PathBuf::from(std::env::var("STUDIO_SAMPLE_DIR").expect("Set STUDIO_SAMPLE_DIR to the review sample folder"));
        std::fs::create_dir_all(&root).unwrap();
        let c = Choices {
            figure: "recon".into(),
            options: HashMap::from([
                ("hair style".into(), "coily".into()),
                ("glasses".into(), "round".into()),
                ("expression".into(), "smiling".into()),
                ("personal accent".into(), "#7cf5c4".into()),
            ]),
            note: "freckles".into(),
        };
        c.validate().unwrap();
        std::thread::scope(|scope| {
            for theme in THEMES {
                let root = &root;
                let c = &c;
                scope.spawn(move || {
                    let cancel = AtomicBool::new(false);
                    let _permit = turn(&cancel).unwrap();
                    let work = root.join(format!("work-{theme}"));
                    std::fs::create_dir_all(&work).unwrap();
                    let reference = work.join("reference.png");
                    reference_image(&c.figure, theme, &reference).unwrap();
                    println!("Drawing {theme}…");
                    let original = draw(&codex_path().unwrap(), &work, &reference, &prompt(c, theme), &cancel, None).unwrap();
                    let out = root.join(format!("{theme}.png"));
                    process(&original, &out, &c.figure, theme).unwrap();
                    std::fs::copy(&original, root.join(format!("{theme}-original.png"))).unwrap();
                    let image = image::open(out).unwrap();
                    let size = if theme == "own" { 64 } else { 128 };
                    assert_eq!((image.width(), image.height()), (size, size));
                    let reference = image::load_from_memory(reference_bytes(&c.figure, theme).unwrap()).unwrap().to_rgba8();
                    assert!(image.to_rgba8().pixels().zip(reference.pixels()).all(|(p, r)| p[3] == r[3]));
                    println!("Finished {theme}");
                });
            }
        });
        std::fs::write(root.join("look.json"), serde_json::to_vec_pretty(&c).unwrap()).unwrap();
    }
}
