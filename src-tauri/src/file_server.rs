//! A small web server on this Mac for files Starkline keeps (a page an agent made), so the
//! built-in browser opens them as it opens any page: scripts, styles and all, rather than in a
//! sandboxed preview. Only files you open are served, each at its own random address, and only
//! to this Mac (127.0.0.1).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct Server {
    port: u16,
    /// Each opened file, by the random part of its address.
    files: Mutex<HashMap<String, PathBuf>>,
}

static SERVER: OnceLock<Result<Server, String>> = OnceLock::new();

/// What a file is served as, by its extension.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "md" | "markdown" | "txt" => "text/plain; charset=utf-8",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// The random part of a request's path (`/<token>/<name>`), if it has one.
pub fn token_of(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next()?.trim_start_matches('/').split('/').next().filter(|t| !t.is_empty())
}

fn server() -> Result<&'static Server, String> {
    SERVER
        .get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("The page couldn't be served on this Mac ({e})."))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    std::thread::spawn(move || answer(stream));
                }
            });
            Ok(Server { port, files: Mutex::new(HashMap::new()) })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn answer(mut stream: TcpStream) {
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    let file = token_of(&line).and_then(|token| server().ok()?.files.lock().unwrap().get(token).cloned());
    let response = match file.and_then(|path| std::fs::read(&path).ok().map(|bytes| (path, bytes))) {
        Some((path, bytes)) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                content_type(&path),
                bytes.len()
            );
            [head.into_bytes(), bytes].concat()
        }
        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    };
    let _ = stream.write_all(&response);
}

/// The address the built-in browser opens a file at; the file is served from now on.
pub fn url_for(path: &Path) -> Result<String, String> {
    let server = server()?;
    let token = crate::gen_token();
    let name: String = path
        .file_name()
        .map(|n| n.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '-' }).collect())
        .unwrap_or_else(|| "file".into());
    server.files.lock().unwrap().insert(token.clone(), path.to_path_buf());
    Ok(format!("http://127.0.0.1:{}/{token}/{name}", server.port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn reads_the_address_part_of_a_request() {
        assert_eq!(token_of("GET /abc123/page.html HTTP/1.1"), Some("abc123"));
        assert_eq!(token_of("GET / HTTP/1.1"), None);
        assert_eq!(token_of("POST /abc123/page.html HTTP/1.1"), None, "only reading");
        assert_eq!(content_type(Path::new("/x/Page.HTML")), "text/html; charset=utf-8");
    }

    #[test]
    fn serves_only_files_that_were_opened() {
        let dir = std::env::temp_dir().join(format!("stark-serve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let page = dir.join("pricing.html");
        std::fs::write(&page, "<h1>Pricing</h1>").unwrap();
        let url = url_for(&page).unwrap();
        let get = |path: &str| {
            let port = url.split(':').nth(2).unwrap().split('/').next().unwrap();
            let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
            stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).unwrap();
            reply
        };
        let opened = url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap();
        let reply = get(&opened);
        assert!(reply.starts_with("HTTP/1.1 200") && reply.contains("text/html") && reply.ends_with("<h1>Pricing</h1>"), "{reply}");
        assert!(get("/not-a-token/pricing.html").starts_with("HTTP/1.1 404"), "anything not opened isn't served");
    }
}
