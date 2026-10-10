//! Claude Code's enabled plugins, found where Claude Code loads them from.
//!
//! A marketplace added from a local path (`directory` or `file`) loads its relative-path plugins
//! in place, so edits to a plugin under development take effect without a new version; the copy
//! in `installed_plugins.json` is only used for every other marketplace. Rules from
//! <https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins> and
//! <https://code.claude.com/docs/en/plugins/marketplace-reference#relative-path-plugin-source>.

use super::disk::{command_item, commands_in, is_hidden, json_file, skill_item, skills_in};
use super::{SlashItem, SlashSource};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// An enabled plugin, with the folder Claude Code loads it from.
pub(super) struct Plugin {
    /// The marketplace entry's name: the part of its id before the `@`.
    pub name: String,
    pub root: PathBuf,
}

/// Plugins switched on in the user's or the project's Claude settings.
pub(super) fn enabled(home: &Path, cwd: &Path) -> Vec<Plugin> {
    let mut ids: Vec<String> = Vec::new();
    for settings in [home.join(".claude/settings.json"), cwd.join(".claude/settings.json"), cwd.join(".claude/settings.local.json")] {
        for (id, on) in json_file(&settings)["enabledPlugins"].as_object().into_iter().flatten() {
            if on.as_bool() == Some(true) && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    let plugins = home.join(".claude/plugins");
    let installed = json_file(&plugins.join("installed_plugins.json"));
    let marketplaces = json_file(&plugins.join("known_marketplaces.json"));
    ids.into_iter()
        .filter_map(|id| {
            let (name, marketplace) = id.split_once('@')?;
            let root = in_place(&marketplaces[marketplace], name).or_else(|| installed["plugins"][&id].as_array()?.first()?["installPath"].as_str().map(PathBuf::from))?;
            Some(Plugin { name: name.to_string(), root })
        })
        .collect()
}

/// Where a marketplace added from a local path keeps `plugin`, if it lists it by a relative path.
fn in_place(marketplace: &Value, plugin: &str) -> Option<PathBuf> {
    let source = &marketplace["source"];
    let path = source["path"].as_str().or_else(|| marketplace["installLocation"].as_str()).map(PathBuf::from)?;
    let (root, file) = match source["source"].as_str()? {
        "directory" => (path.clone(), path.join(".claude-plugin/marketplace.json")),
        // The file sits at `<root>/.claude-plugin/marketplace.json`.
        "file" => (path.parent()?.parent()?.to_path_buf(), path.clone()),
        _ => return None,
    };
    let catalog = json_file(&file);
    let entry = catalog["plugins"].as_array()?.iter().find(|e| e["name"].as_str() == Some(plugin))?;
    let relative = relative_source(entry["source"].as_str()?, catalog["metadata"]["pluginRoot"].as_str())?;
    let dir = root.join(relative);
    dir.is_dir().then_some(dir)
}

/// An entry's `source` as a path under the marketplace root: `./x`, `.`, or a bare name under `metadata.pluginRoot`.
fn relative_source(source: &str, plugin_root: Option<&str>) -> Option<PathBuf> {
    let path = if source == "." {
        PathBuf::new()
    } else if let Some(rest) = source.strip_prefix("./") {
        PathBuf::from(rest)
    } else if !source.contains('/') {
        Path::new(plugin_root?).join(source)
    } else {
        return None;
    };
    // Nothing may climb out of the marketplace.
    path.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)).then_some(path)
}

fn paths_of(value: &Value) -> Vec<&str> {
    match value {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// A manifest path (`./x`) inside the plugin; one that climbs out of it is ignored.
fn inside(root: &Path, path: &str) -> Option<PathBuf> {
    let relative = Path::new(path.strip_prefix("./").unwrap_or(path));
    relative.components().all(|c| matches!(c, Component::Normal(_))).then(|| root.join(relative))
}

/// A plugin's skills and commands. Its manifest adds skill folders to `skills/`, and a
/// `commands` key replaces `commands/`.
pub(super) fn scan(plugin: &Plugin, out: &mut Vec<SlashItem>) {
    let manifest = json_file(&plugin.root.join(".claude-plugin/plugin.json"));
    // Components are namespaced under the manifest's name, which can differ from the entry's.
    let prefix = manifest["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&plugin.name);
    let (root, source, origin) = (&plugin.root, SlashSource::Plugin, plugin.name.as_str());
    let before = out.len();

    skills_in(&root.join("skills"), Some(prefix), source, origin, out);
    for dir in paths_of(&manifest["skills"]).into_iter().filter_map(|p| inside(root, p)) {
        if dir.join("SKILL.md").is_file() {
            out.extend(skill_item(&dir, Some(prefix), source, origin));
        } else {
            skills_in(&dir, Some(prefix), source, origin, out);
        }
    }

    match &manifest["commands"] {
        Value::Null => commands_in(&root.join("commands"), Some(prefix), source, origin, out),
        Value::Object(map) => {
            for (name, def) in map {
                let from_file = def["source"].as_str().and_then(|p| inside(root, p)).and_then(|p| command_item(&p, name, Some(prefix), source, origin));
                let described = |text: &str| crate::chat::truncate(&text.split_whitespace().collect::<Vec<_>>().join(" "), 240);
                let item = match (from_file, def["content"].as_str()) {
                    (Some(item), _) => item,
                    (None, Some(content)) => SlashItem { name: format!("{prefix}:{name}"), description: described(content), hint: String::new(), kind: super::SlashKind::Command, source, origin: origin.to_string() },
                    _ => continue,
                };
                out.push(SlashItem {
                    description: def["description"].as_str().map(described).unwrap_or(item.description),
                    hint: def["argumentHint"].as_str().map(str::to_string).unwrap_or(item.hint),
                    ..item
                });
            }
        }
        listed => {
            for path in paths_of(listed).into_iter().filter_map(|p| inside(root, p)) {
                if path.is_dir() {
                    commands_in(&path, Some(prefix), source, origin, out);
                } else if let Some(stem) = path.file_stem().and_then(|n| n.to_str()).filter(|_| path.extension().is_some_and(|e| e == "md") && !is_hidden(&path)) {
                    out.extend(command_item(&path, stem, Some(prefix), source, origin));
                }
            }
        }
    }

    // A manifest that lists a folder `skills/` already scanned would otherwise list it twice.
    let mut seen = std::collections::HashSet::new();
    let mut at = before;
    while at < out.len() {
        if seen.insert(out[at].name.clone()) {
            at += 1;
        } else {
            out.remove(at);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("starkline-plugins-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn names(plugin: &Plugin) -> Vec<String> {
        let mut items = Vec::new();
        scan(plugin, &mut items);
        items.into_iter().map(|i| i.name).collect()
    }

    #[test]
    fn a_marketplace_from_a_local_path_loads_its_plugin_in_place_not_from_the_cache() {
        let home = temp("home");
        let cwd = temp("cwd");
        let marketplace = temp("dev-marketplace");
        write(&marketplace.join(".claude-plugin/marketplace.json"), r#"{"name":"mw","plugins":[{"name":"sarathi","source":"./sarathi"}]}"#);
        write(&marketplace.join("sarathi/commands/new.md"), "---\ndescription: Only in the dev copy\n---\n");
        let cache = home.join(".claude/plugins/cache/mw/sarathi/0.21.0");
        write(&cache.join("commands/old.md"), "---\ndescription: Only in the cache\n---\n");
        write(&home.join(".claude/settings.json"), r#"{"enabledPlugins":{"sarathi@mw":true}}"#);
        write(&home.join(".claude/plugins/installed_plugins.json"), &format!(r#"{{"plugins":{{"sarathi@mw":[{{"installPath":"{}"}}]}}}}"#, cache.display()));
        let known = |source: &str| format!(r#"{{"mw":{{"source":{source},"installLocation":"{}"}}}}"#, marketplace.display());

        write(&home.join(".claude/plugins/known_marketplaces.json"), &known(&format!(r#"{{"source":"directory","path":"{}"}}"#, marketplace.display())));
        let found = enabled(&home, &cwd);
        assert_eq!((found.len(), found[0].root.clone()), (1, marketplace.join("sarathi")));
        assert_eq!(names(&found[0]), vec!["sarathi:new"]);

        // A marketplace given as its catalog file works the same way.
        write(&home.join(".claude/plugins/known_marketplaces.json"), &known(&format!(r#"{{"source":"file","path":"{}"}}"#, marketplace.join(".claude-plugin/marketplace.json").display())));
        assert_eq!(enabled(&home, &cwd)[0].root, marketplace.join("sarathi"));

        // A marketplace cloned from git, or one the entry points out of, is read from the cache.
        write(&home.join(".claude/plugins/known_marketplaces.json"), &known(r#"{"source":"github","repo":"o/r"}"#));
        assert_eq!(names(&enabled(&home, &cwd)[0]), vec!["sarathi:old"]);
        write(&marketplace.join(".claude-plugin/marketplace.json"), r#"{"name":"mw","plugins":[{"name":"sarathi","source":{"source":"github","repo":"o/p"}}]}"#);
        write(&home.join(".claude/plugins/known_marketplaces.json"), &known(&format!(r#"{{"source":"directory","path":"{}"}}"#, marketplace.display())));
        assert_eq!(enabled(&home, &cwd)[0].root, cache);
    }

    #[test]
    fn relative_sources_stay_inside_the_marketplace() {
        assert_eq!(relative_source("./a/b", None), Some(PathBuf::from("a/b")));
        assert_eq!(relative_source(".", None), Some(PathBuf::new()));
        assert_eq!(relative_source("formatter", Some("./plugins")), Some(PathBuf::from("./plugins/formatter")));
        assert_eq!(relative_source("formatter", None), None);
        assert_eq!(relative_source("team/formatter", Some("./plugins")), None);
        assert_eq!(relative_source("./../x", None), None);
        assert_eq!(relative_source("./a/../../x", None), None);
    }

    #[test]
    fn a_manifest_adds_skill_folders_replaces_commands_and_names_the_plugin() {
        let plugin = temp("manifest");
        write(
            &plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"deploy-tools","skills":["./skills/one","./extra"],"commands":{"status":{"source":"./cmds/status.md","argumentHint":"[env]"},"about":{"content":"Explain the plugin.","description":"About"}}}"#,
        );
        write(&plugin.join("skills/one/SKILL.md"), "---\ndescription: One\n---\n");
        write(&plugin.join("skills/two/SKILL.md"), "---\ndescription: Two\n---\n");
        write(&plugin.join("extra/three/SKILL.md"), "---\ndescription: Three\n---\n");
        write(&plugin.join("cmds/status.md"), "---\ndescription: Show status\n---\n");
        write(&plugin.join("commands/ignored.md"), "ignored\n");
        let p = Plugin { name: "deploy".into(), root: plugin.clone() };
        let mut items = Vec::new();
        scan(&p, &mut items);
        let got: Vec<(&str, &str, &str)> = items.iter().map(|i| (i.name.as_str(), i.description.as_str(), i.hint.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("deploy-tools:one", "One", ""),
                ("deploy-tools:two", "Two", ""),
                ("deploy-tools:three", "Three", ""),
                ("deploy-tools:status", "Show status", "[env]"),
                ("deploy-tools:about", "About", ""),
            ]
        );
        assert!(items.iter().all(|i| i.origin == "deploy"));

        write(&plugin.join(".claude-plugin/plugin.json"), r#"{"commands":["./cmds","./commands/ignored.md"]}"#);
        assert_eq!(names(&p), vec!["deploy:one", "deploy:two", "deploy:status", "deploy:ignored"]);
    }
}
