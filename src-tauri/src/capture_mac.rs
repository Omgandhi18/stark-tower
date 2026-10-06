//! Quick capture's window on macOS: a borderless panel with its own rounded surface,
//! kept out of the Window menu and off other Spaces' window lists.
use objc2::{msg_send, runtime::AnyObject};
use objc2_app_kit::{NSColor, NSWindow, NSWindowCollectionBehavior};

/// Style the capture window.
///
/// # Safety
/// `native` must be a live `NSWindow`, and this must run on the main thread.
pub unsafe fn style(native: *mut std::ffi::c_void) {
    let native = &*(native as *const NSWindow);
    native.setExcludedFromWindowsMenu(true);
    native.setCollectionBehavior(NSWindowCollectionBehavior::Transient);
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    if let Some(view) = native.contentView() {
        view.setWantsLayer(true);
        let layer: *mut AnyObject = msg_send![&*view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: 12.0_f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
    }
}
