use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn decode_failure_mid_stream_emits_source_error() {
    let shared = Shared::new(48_000, 2);
    shared.mark_decode_failed();

    assert!(matches!(
        playback_completion_event(&shared, 120.0, 30.0, Some("broken.bin"), 7),
        PlayerEvent::SourceError { source: Some(source), source_generation: 7 }
            if source == "broken.bin"
    ));
}

#[test]
fn decode_failure_near_end_is_treated_as_ended() {
    let shared = Shared::new(48_000, 2);
    shared.mark_decode_failed();

    assert!(matches!(
        playback_completion_event(&shared, 120.0, 118.0, Some("near-end.bin"), 8),
        PlayerEvent::Ended
    ));
}

#[test]
fn unknown_duration_failure_emits_source_error() {
    let shared = Shared::new(48_000, 2);
    shared.mark_decode_failed();

    assert!(matches!(
        playback_completion_event(&shared, 0.0, 30.0, Some("stream"), 9),
        PlayerEvent::SourceError { source: Some(source), source_generation: 9 }
            if source == "stream"
    ));
}

#[test]
fn stale_output_failure_callback_is_ignored() {
    let mut player = InnerPlayer::new().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_event = Arc::clone(&calls);
    player.set_event_callback(Arc::new(move |event| {
        if matches!(event, PlayerEvent::OutputFailed) {
            calls_for_event.fetch_add(1, Ordering::Relaxed);
        }
    }));

    let generation = player.reserve_output_generation();
    let callback = player.make_failure_callback(generation);
    callback();
    assert_eq!(calls.load(Ordering::Relaxed), 1);

    player.reserve_output_generation();
    callback();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

mod preload;

#[test]
fn recovery_failure_keeps_original_source_and_rejects_superseded_generation() {
    let mut player = InnerPlayer::new().unwrap();
    let failures = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::clone(&failures);
    player.set_event_callback(Arc::new(move |event| {
        if let PlayerEvent::SourceError {
            source,
            source_generation,
        } = event
        {
            received.lock().push((source, source_generation));
        }
    }));

    let (_, old_token) = player.take_for_async_load(HttpCancelHandle::new());
    player.current_source = Some("previously-committed.bin".to_owned());
    player.emit_source_error("failed-open.bin", old_token);
    assert_eq!(
        failures.lock().as_slice(),
        &[(Some("failed-open.bin".to_owned()), old_token)]
    );

    let (_, new_token) = player.take_for_async_load(HttpCancelHandle::new());
    player.current_source = Some("replacement.bin".to_owned());
    player.emit_source_error("failed-open.bin", old_token);
    assert_eq!(failures.lock().len(), 1);
    player.stop();
    player.emit_source_error("replacement.bin", new_token);
    assert_eq!(failures.lock().len(), 1);
}
