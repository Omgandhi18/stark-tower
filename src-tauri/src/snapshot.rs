//! Screenshots of the built-in browser on macOS: WebKit draws the page into an
//! image, handed back as a JPEG small enough to give an agent.

use std::ffi::c_void;
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

/// Widest a screenshot gets, in points.
const MAX_WIDTH: f64 = 1280.0;
const QUALITY: f64 = 0.7;

type Reply = Sender<Result<Vec<u8>, String>>;

/// Ask WebKit for a picture of the page; the JPEG, or why there isn't one, arrives on `tx`.
///
/// # Safety
/// `webview` must point at a live WKWebView, and this must run on the main thread.
pub unsafe fn capture(webview: *mut c_void, tx: Reply) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = tx.send(Err("Screenshots have to be taken on the main thread.".into()));
        return;
    };
    let webview: &WKWebView = &*(webview as *const WKWebView);
    let config = WKSnapshotConfiguration::new(mtm);
    let width = webview.frame().size.width.min(MAX_WIDTH);
    if width > 0.0 {
        config.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
    }
    // The handler is called once; the sender goes with the first call.
    let tx = Mutex::new(Some(tx));
    let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let result = if image.is_null() { Err("WebKit couldn't draw the page.".to_string()) } else { jpeg(&*image) };
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(result);
        }
    });
    webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
}

fn jpeg(image: &NSImage) -> Result<Vec<u8>, String> {
    let tiff = image.TIFFRepresentation().ok_or("The screenshot had no pixels.")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("The screenshot couldn't be read.")?;
    let quality: Retained<AnyObject> = NSNumber::new_f64(QUALITY).into();
    let properties = NSDictionary::from_retained_objects(&[unsafe { NSImageCompressionFactor }], &[quality]);
    let data = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) }.ok_or("The screenshot couldn't be saved as a JPEG.")?;
    Ok(data.to_vec())
}
