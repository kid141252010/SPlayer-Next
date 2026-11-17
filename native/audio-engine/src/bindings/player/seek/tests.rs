use super::*;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc::{self, Receiver, Sender};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use crate::output::AudioOutput;
use crate::player::LoadedPlayback;
use crate::tests::fixtures::tone_file;

/// 只控制真实工作线程的进入/释放，不替代 seek、解码或提交。
pub(crate) struct WorkerGate {
    entered: Sender<()>,
    release: Receiver<()>,
}

impl WorkerGate {
    pub(crate) fn wait(self) {
        let _ = self.entered.send(());
        let _ = self.release.recv();
    }
}

struct Fixture {
    player: AudioPlayer,
    source: PathBuf,
    old_buffer: std::sync::Weak<crate::decoder::buffer::Shared>,
}

impl Fixture {
    fn new(suffix: &str) -> Self {
        let source = tone_file(48_000, suffix);
        let mut player = AudioPlayer::new().unwrap();
        player.test_headless_output = true;
        let old_buffer = load_source(&player, &source);
        Self {
            player,
            source,
            old_buffer,
        }
    }

    fn block_worker(&self) -> (Receiver<()>, Sender<()>) {
        let (entered, received) = mpsc::channel();
        let (release, released) = mpsc::channel();
        *self.player.seek_worker_gate.lock() = Some(WorkerGate {
            entered,
            release: released,
        });
        (received, release)
    }

    fn block_load(&self) -> (Receiver<()>, Sender<()>) {
        let (entered, received) = mpsc::channel();
        let (release, released) = mpsc::channel();
        *self.player.load_worker_gate.lock() = Some(WorkerGate {
            entered,
            release: released,
        });
        (received, release)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.player.stop();
        std::fs::remove_file(&self.source).unwrap();
    }
}

fn begin_load(player: &AudioPlayer) -> u64 {
    let (old_threads, token) = player
        .inner
        .lock()
        .take_for_async_load(HttpCancelHandle::new());
    if let Some(decoder) = old_threads.join_aux() {
        decoder.join().unwrap();
    }
    token
}

/// 使用真实加载提交与解码线程，只有物理输出替换为隔离夹具。
fn commit_source(
    player: &AudioPlayer,
    source: &Path,
    token: u64,
) -> std::sync::Weak<crate::decoder::buffer::Shared> {
    let prepared =
        decoder::prepare_decode(source.to_str().unwrap(), None, HttpCancelHandle::new()).unwrap();
    let (fft, equalizer, tempo) = {
        let inner = player.inner.lock();
        (
            inner.fft_handle(),
            inner.equalizer_handle(),
            inner.tempo_handle(),
        )
    };
    let (output, shared, playback) =
        PlaybackHandle::prepare(AudioOutput::headless(48_000, 2), fft).unwrap();
    let (metadata, decode_handle, cancel) =
        decoder::start_prepared_decode(prepared, Arc::clone(&shared), equalizer, tempo).unwrap();
    let weak = Arc::downgrade(&shared);
    assert!(player
        .inner
        .lock()
        .commit_loaded(
            token,
            source.to_str().unwrap(),
            false,
            LoadedPlayback {
                start_position: 0.0,
                metadata,
                decode_handle,
                shared,
                output,
                playback,
                cancel,
            },
        )
        .unwrap()
        .is_some());
    weak
}

fn load_source(
    player: &AudioPlayer,
    source: &Path,
) -> std::sync::Weak<crate::decoder::buffer::Shared> {
    let token = begin_load(player);
    commit_source(player, source, token)
}

fn assert_cancelled(result: Result<()>) {
    assert!(result.unwrap_err().reason.starts_with("[Cancelled]"));
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
}

#[test]
fn overlapping_seeks_consume_every_queued_target_and_finish_at_latest() {
    for count in [2, 3, 8] {
        let fixture = Fixture::new(&format!("seek-overlap-{count}"));
        let (entered, release) = fixture.block_worker();
        runtime().block_on(async {
            let mut pending = (1..=count)
                .map(|index| Box::pin(fixture.player.seek(f64::from(index) / 10.0)))
                .collect::<Vec<_>>();
            assert!(poll_once(pending[0].as_mut()).is_pending());
            // 超时仅作为死锁失败条件；先确认句柄已被第一项实际取走，再注册后续项。
            entered.recv_timeout(Duration::from_secs(10)).unwrap();
            for seek in pending.iter_mut().skip(1) {
                assert!(
                    poll_once(seek.as_mut()).is_pending(),
                    "后续 seek 不能假成功丢失"
                );
            }
            release.send(()).unwrap();
            for seek in pending {
                seek.await.unwrap();
            }
            let player = fixture.player.inner.lock();
            assert_eq!(player.position(), f64::from(count) / 10.0);
            assert_eq!(player.state(), PlayerState::Paused);
            assert_eq!(player.current_source(), fixture.source.to_str());
            assert!(
                fixture.old_buffer.upgrade().is_none(),
                "旧解码缓冲必须完整释放"
            );
        });
    }
}

#[test]
fn load_takeover_discards_old_queue_and_seek_during_load_never_reloads_old_source() {
    let fixture = Fixture::new("seek-load-takeover");
    let replacement = tone_file(44_100, "seek-load-replacement");
    let (entered, release) = fixture.block_worker();
    runtime().block_on(async {
        let mut first = Box::pin(fixture.player.seek(0.2));
        let mut second = Box::pin(fixture.player.seek(0.5));
        let mut third = Box::pin(fixture.player.seek(0.8));
        assert!(poll_once(first.as_mut()).is_pending());
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(poll_once(second.as_mut()).is_pending());
        assert!(poll_once(third.as_mut()).is_pending());

        let (load_entered, load_release) = fixture.block_load();
        let mut loading = Box::pin(fixture.player.load(
            replacement.to_str().unwrap().to_owned(),
            Some(false),
            None,
        ));
        assert!(poll_once(loading.as_mut()).is_pending());
        load_entered.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut during_load = Box::pin(fixture.player.seek(0.9));
        match poll_once(during_load.as_mut()) {
            Poll::Ready(result) => assert_cancelled(result),
            Poll::Pending => panic!("普通加载期间不能排队到旧曲目"),
        }
        load_release.send(()).unwrap();
        loading.await.unwrap();
        release.send(()).unwrap();
        for seek in [first, second, third] {
            assert_cancelled(seek.await);
        }
        let player = fixture.player.inner.lock();
        assert_eq!(player.current_source(), replacement.to_str());
        assert_eq!(player.position(), 0.0, "旧队列不能定位到新曲目");
        assert_eq!(player.state(), PlayerState::Paused);
    });
    assert!(fixture.old_buffer.upgrade().is_none());
    fixture.player.stop();
    std::fs::remove_file(replacement).unwrap();
}

#[test]
fn stop_takeover_discards_in_flight_seek_and_all_queued_targets() {
    let fixture = Fixture::new("seek-stop-takeover");
    let (entered, release) = fixture.block_worker();
    runtime().block_on(async {
        let mut first = Box::pin(fixture.player.seek(0.2));
        let mut second = Box::pin(fixture.player.seek(0.5));
        let mut third = Box::pin(fixture.player.seek(0.8));
        assert!(poll_once(first.as_mut()).is_pending());
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(poll_once(second.as_mut()).is_pending());
        assert!(poll_once(third.as_mut()).is_pending());
        fixture.player.stop();
        release.send(()).unwrap();
        for seek in [first, second, third] {
            assert_cancelled(seek.await);
        }
        let player = fixture.player.inner.lock();
        assert_eq!(player.state(), PlayerState::Stopped);
        assert_eq!(player.current_source(), None);
        assert_eq!(player.position(), 0.0);
        assert_eq!(player.seek_request_epoch(), None);
    });
    assert!(fixture.old_buffer.upgrade().is_none());
}

#[test]
fn device_takeover_invalidates_the_old_seek_queue_without_waiting_for_its_worker() {
    let fixture = Fixture::new("seek-device-takeover");
    let (entered, release) = fixture.block_worker();
    runtime().block_on(async {
        let mut first = Box::pin(fixture.player.seek(0.2));
        let mut second = Box::pin(fixture.player.seek(0.5));
        let mut third = Box::pin(fixture.player.seek(0.8));
        assert!(poll_once(first.as_mut()).is_pending());
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(poll_once(second.as_mut()).is_pending());
        assert!(poll_once(third.as_mut()).is_pending());
        fixture.player.reinit_output().await.unwrap();
        release.send(()).unwrap();
        for seek in [first, second, third] {
            assert_cancelled(seek.await);
        }
        let player = fixture.player.inner.lock();
        assert_eq!(player.position(), 0.0);
        assert_eq!(player.state(), PlayerState::Paused);
        assert_eq!(player.current_source(), fixture.source.to_str());
    });
    assert!(fixture.old_buffer.upgrade().is_none());
}

#[test]
fn recovery_load_preserves_queued_seek_targets_for_the_same_source() {
    let fixture = Fixture::new("seek-recovery-queue");
    let (entered, release) = fixture.block_worker();
    runtime().block_on(async {
        let mut first = Box::pin(fixture.player.seek(0.2));
        let mut second = Box::pin(fixture.player.seek(0.5));
        let mut third = Box::pin(fixture.player.seek(0.8));
        assert!(poll_once(first.as_mut()).is_pending());
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(poll_once(second.as_mut()).is_pending());
        assert!(poll_once(third.as_mut()).is_pending());
        let token = fixture
            .player
            .inner
            .lock()
            .load_token_handle()
            .load(std::sync::atomic::Ordering::Acquire);
        // 驱动 seek 失败分支使用的真实恢复加载，不替换解码、加载或队列实现。
        fixture
            .player
            .load_for_seek_recovery(
                fixture.source.to_str().unwrap().to_owned(),
                false,
                token,
                0.2,
            )
            .await
            .unwrap();
        assert_eq!(fixture.player.inner.lock().position(), 0.2);
        release.send(()).unwrap();
        assert_cancelled(first.await);
        second.await.unwrap();
        third.await.unwrap();
        assert_eq!(fixture.player.inner.lock().position(), 0.8);
    });
    assert!(fixture.old_buffer.upgrade().is_none());
}

#[test]
fn device_recovery_reuses_the_decoder_and_keeps_position_and_pause_state() {
    let fixture = Fixture::new("seek-device-recovery");
    runtime().block_on(async {
        fixture.player.seek(0.4).await.unwrap();
        fixture.player.reinit_output().await.unwrap();
        {
            let player = fixture.player.inner.lock();
            assert_eq!(player.position(), 0.4);
            assert_eq!(player.state(), PlayerState::Paused);
        }
        fixture.player.seek(0.7).await.unwrap();
        assert_eq!(fixture.player.inner.lock().position(), 0.7);
    });
    assert!(fixture.old_buffer.upgrade().is_none());
}
