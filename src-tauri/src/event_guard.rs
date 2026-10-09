//! AppKit sometimes throws an Objective-C exception while it handles an event: an
//! assertion in the system's typing suggestions, say. A Mac app normally reports it
//! and carries on. Here it would unwind into tao's Rust `sendEvent:` override, and
//! Rust aborts the process when anything unwinds out of an `extern "C"` function.
//! So AppKit's own `sendEvent:` (what tao's override calls into) catches it first,
//! reports it the way AppKit does, and only that event is lost.

use objc2::exception;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use std::ffi::CStr;
use std::panic::AssertUnwindSafe;
use std::sync::OnceLock;

/// `-sendEvent:`: receiver, selector, event.
type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

static APP_SEND_EVENT: OnceLock<SendEvent> = OnceLock::new();
static WINDOW_SEND_EVENT: OnceLock<SendEvent> = OnceLock::new();

/// Guard NSApplication's `sendEvent:` (every event) and NSWindow's (where tao sends
/// Cmd-key releases itself). Call once on the main thread, before events flow.
pub fn install() {
    guard(c"NSApplication", &APP_SEND_EVENT, app_send_event);
    guard(c"NSWindow", &WINDOW_SEND_EVENT, window_send_event);
}

fn guard(class: &CStr, original: &'static OnceLock<SendEvent>, guarded: SendEvent) {
    let Some(method) = AnyClass::get(class).and_then(|c| c.instance_method(sel!(sendEvent:))) else {
        eprintln!("[event-guard] {} has no sendEvent: to guard", class.to_string_lossy());
        return;
    };
    if original.get().is_some() {
        return;
    }
    // SAFETY: `sendEvent:` takes one object and returns nothing, which is what
    // `SendEvent` describes. The original is saved before the guard can be called.
    unsafe {
        let _ = original.set(std::mem::transmute::<Imp, SendEvent>(method.implementation()));
        method.set_implementation(std::mem::transmute::<SendEvent, Imp>(guarded));
    }
}

unsafe extern "C-unwind" fn app_send_event(receiver: *mut AnyObject, cmd: Sel, event: *mut AnyObject) {
    unsafe { forward(&APP_SEND_EVENT, receiver, cmd, event) }
}

unsafe extern "C-unwind" fn window_send_event(receiver: *mut AnyObject, cmd: Sel, event: *mut AnyObject) {
    unsafe { forward(&WINDOW_SEND_EVENT, receiver, cmd, event) }
}

/// Run AppKit's own `sendEvent:`, reporting anything it throws.
unsafe fn forward(original: &OnceLock<SendEvent>, receiver: *mut AnyObject, cmd: Sel, event: *mut AnyObject) {
    let Some(&send) = original.get() else { return };
    // SAFETY: the arguments are the ones AppKit called the guard with.
    let Err(thrown) = (unsafe { call_caught(send, receiver, cmd, event) }) else { return };
    match thrown {
        Some(thrown) => {
            eprintln!("[event-guard] AppKit threw while handling an event: {thrown}");
            report(&thrown);
        }
        None => eprintln!("[event-guard] AppKit threw nil while handling an event"),
    }
}

/// Call a `sendEvent:` implementation, catching an Objective-C exception it throws.
unsafe fn call_caught(send: SendEvent, receiver: *mut AnyObject, cmd: Sel, event: *mut AnyObject) -> Result<(), Option<Retained<exception::Exception>>> {
    exception::catch(AssertUnwindSafe(|| unsafe { send(receiver, cmd, event) }))
}

/// `-[NSApplication reportException:]`: AppKit's own report, written to the system log.
fn report(thrown: &exception::Exception) {
    let Some(class) = AnyClass::get(c"NSApplication") else { return };
    // SAFETY: `sharedApplication` returns the app object; `reportException:` takes an NSException.
    unsafe {
        let app: *mut AnyObject = msg_send![class, sharedApplication];
        if !app.is_null() {
            let _: () = msg_send![app, reportException: thrown];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSString;

    /// What AppKit did when it crashed Starkline: an assertion while handling an event.
    unsafe extern "C-unwind" fn asserts(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {
        let class = AnyClass::get(c"NSException").expect("Foundation is linked");
        let name = NSString::from_str("NSInternalInconsistencyException");
        let reason = NSString::from_str("Assertion failure in a test");
        let thrown: Option<Retained<exception::Exception>> =
            unsafe { msg_send![class, exceptionWithName: &*name, reason: &*reason, userInfo: std::ptr::null::<AnyObject>()] };
        exception::throw(thrown.expect("an exception"))
    }

    unsafe extern "C-unwind" fn handles(_: *mut AnyObject, _: Sel, _: *mut AnyObject) {}

    #[test]
    fn an_exception_while_handling_an_event_is_caught_not_fatal() {
        let outcome = unsafe { call_caught(asserts, std::ptr::null_mut(), sel!(sendEvent:), std::ptr::null_mut()) };
        let thrown = outcome.expect_err("caught").expect("with its details");
        assert_eq!(thrown.to_string(), "Assertion failure in a test");
    }

    #[test]
    fn an_event_that_doesnt_throw_goes_through() {
        assert!(unsafe { call_caught(handles, std::ptr::null_mut(), sel!(sendEvent:), std::ptr::null_mut()) }.is_ok());
    }

    #[test]
    fn appkits_own_send_event_is_guarded_once() {
        let current = |class: &CStr| AnyClass::get(class).and_then(|c| c.instance_method(sel!(sendEvent:))).map(|m| m.implementation() as usize);
        install();
        install();
        assert_eq!(current(c"NSApplication"), Some(app_send_event as SendEvent as usize));
        assert_eq!(current(c"NSWindow"), Some(window_send_event as SendEvent as usize));
        assert_ne!(APP_SEND_EVENT.get().map(|f| *f as usize), Some(app_send_event as SendEvent as usize), "the original is kept, not the guard");
    }
}
