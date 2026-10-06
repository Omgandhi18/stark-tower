//! UserNotifications for the bundled Mac app. Call only after checking `bundled()`.

use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, ClassType};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::ptr::NonNull;
use std::sync::{Mutex, Once, OnceLock};

pub enum Permission {
    NotAsked,
    Denied,
    Allowed,
    Provisional,
}

pub fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

pub fn bundle_identifier() -> Option<String> {
    NSBundle::mainBundle().bundleIdentifier().map(|s| s.to_string())
}

static INSTALL: Once = Once::new();
static ON_CLICK: OnceLock<fn(&str)> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "StarklineNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
            if let Some(on_click) = ON_CLICK.get() {
                on_click(&response.notification().request().identifier().to_string());
            }
            done.call(());
        }
    }
);

pub fn install(on_click: fn(&str)) {
    INSTALL.call_once(|| {
        let _ = ON_CLICK.set(on_click);
        let delegate: Retained<NotificationDelegate> = unsafe { msg_send![NotificationDelegate::class(), new] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center's delegate is weak; keep this one instance alive for the app's lifetime.
        std::mem::forget(delegate);
    });
}

fn from_status(status: UNAuthorizationStatus) -> Permission {
    match status {
        UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => Permission::Allowed,
        UNAuthorizationStatus::Denied => Permission::Denied,
        UNAuthorizationStatus::Provisional => Permission::Provisional,
        _ => Permission::NotAsked,
    }
}

pub fn permission(done: impl FnOnce(Permission) + Send + 'static) {
    let done = Mutex::new(Some(done));
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // Apple keeps the settings alive while invoking this completion block.
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        if let Some(done) = done.lock().unwrap().take() {
            done(from_status(status));
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
}

pub fn request(done: impl FnOnce(Permission) + Send + 'static) {
    let done = Mutex::new(Some(done));
    let block = RcBlock::new(move |_granted: objc2::runtime::Bool, error: *mut NSError| {
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!("[notify] couldn't request notification permission: {error}");
        }
        if let Some(done) = done.lock().unwrap().take() {
            permission(done);
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &block,
    );
}

pub fn post(identifier: &str, title: &str, subtitle: &str, body: &str, thread: &str) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setSubtitle(&NSString::from_str(subtitle));
    content.setBody(&NSString::from_str(body));
    content.setThreadIdentifier(&NSString::from_str(thread));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(identifier), &content, None);
    let block = RcBlock::new(|error: *mut NSError| {
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!("[notify] couldn't show a notification: {error}");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&block));
}

pub fn forget(identifiers: &[String]) {
    let identifiers: Vec<_> = identifiers.iter().map(|s| NSString::from_str(s)).collect();
    UNUserNotificationCenter::currentNotificationCenter().removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&identifiers));
}
