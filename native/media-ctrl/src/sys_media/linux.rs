use std::{
    io::Write,
    process,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use mpris_server::{
    LoopStatus as MprisLoopStatus, Metadata, PlaybackStatus as MprisPlaybackStatus, Player, Time,
    zbus::zvariant::ObjectPath,
};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use tempfile::NamedTempFile;
use tokio::{
    runtime::Runtime,
    sync::mpsc::{Receiver, Sender, channel},
};

use super::{MediaThreadsafeFunction, SystemMediaControls};
use crate::model::{
    MediaEvent, MediaEventType, MetadataPayload, PlayModeParam, PlayStateParam, PlaybackStatus,
    RepeatMode, TimelineParam,
};

enum MprisCommand {
    UpdateMetadata(MetadataPayload),
    UpdatePlaybackStatus(PlayStateParam),
    UpdatePlaybackRate(f64),
    UpdateVolume(f64),
    FlushTimeline,
    UpdatePlayMode(PlayModeParam),
    Enable,
    Disable,
    RegisterCallback(MediaThreadsafeFunction),
    Shutdown,
}

pub struct LinuxImpl {
    sender: Sender<MprisCommand>,
    timeline: Arc<TimelineMailbox>,
}

#[derive(Default)]
struct TimelineMailbox {
    latest: Mutex<Option<TimelineParam>>,
    notification_pending: AtomicBool,
}

impl TimelineMailbox {
    fn update(&self, sender: &Sender<MprisCommand>, timeline: TimelineParam) {
        *self
            .latest
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(timeline);
        if self.notification_pending.swap(true, Ordering::AcqRel) {
            return;
        }
        if sender.try_send(MprisCommand::FlushTimeline).is_err() {
            self.notification_pending.store(false, Ordering::Release);
        }
    }

    fn take(&self) -> Option<TimelineParam> {
        self.notification_pending.store(false, Ordering::Release);
        self.latest
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

impl LinuxImpl {
    pub fn new() -> Self {
        let (tx, rx) = channel(32);
        let timeline = Arc::new(TimelineMailbox::default());
        let loop_timeline = Arc::clone(&timeline);

        thread::spawn(move || {
            let rt = match Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[media-ctrl] 无法创建 MPRIS Tokio Runtime: {e:?}");
                    return;
                }
            };
            rt.block_on(async move {
                if let Err(e) = run_mpris_loop(rx, loop_timeline).await {
                    eprintln!("[media-ctrl] MPRIS 循环异常退出: {e:?}");
                }
            });
        });

        Self {
            sender: tx,
            timeline,
        }
    }

    fn send_cmd(&self, cmd: MprisCommand) {
        let _ = self.sender.blocking_send(cmd);
    }
}

fn setup_signals(
    player: &Player,
    enabled: Arc<AtomicBool>,
    dispatch: impl Fn(MediaEvent) + Clone + 'static,
) {
    let dispatch = move |evt: MediaEvent| {
        if enabled.load(Ordering::Acquire) {
            dispatch(evt);
        }
    };

    let d = dispatch.clone();
    player.connect_play(move |_| d(MediaEvent::new(MediaEventType::Play)));

    let d = dispatch.clone();
    player.connect_pause(move |_| d(MediaEvent::new(MediaEventType::Pause)));

    let d = dispatch.clone();
    player.connect_play_pause(move |p| {
        let evt = if p.playback_status() == MprisPlaybackStatus::Playing {
            MediaEventType::Pause
        } else {
            MediaEventType::Play
        };
        d(MediaEvent::new(evt));
    });

    let d = dispatch.clone();
    player.connect_previous(move |_| d(MediaEvent::new(MediaEventType::PrevTrack)));

    let d = dispatch.clone();
    player.connect_next(move |_| d(MediaEvent::new(MediaEventType::NextTrack)));

    let d = dispatch.clone();
    player.connect_stop(move |_| d(MediaEvent::new(MediaEventType::Stop)));

    let d = dispatch.clone();
    player.connect_set_loop_status(move |_, status| {
        let repeat = match status {
            MprisLoopStatus::None => RepeatMode::None,
            MprisLoopStatus::Track => RepeatMode::Track,
            MprisLoopStatus::Playlist => RepeatMode::List,
        };
        d(MediaEvent::set_repeat(repeat));
    });

    let d = dispatch.clone();
    player.connect_set_shuffle(move |_, shuffle| d(MediaEvent::set_shuffle(shuffle)));

    let d = dispatch.clone();
    player.connect_set_rate(move |_, rate| d(MediaEvent::set_rate(rate)));

    let d = dispatch.clone();
    player.connect_set_volume(move |_, vol| d(MediaEvent::set_volume(vol)));

    let d = dispatch.clone();
    player.connect_seek(move |p, offset| {
        let current = p.position().as_micros();
        let target = current.saturating_add(offset.as_micros()).max(0);
        d(MediaEvent::seek(target as f64 / 1000.0));
    });

    player.connect_set_position(move |_, _, pos| {
        dispatch(MediaEvent::seek(pos.as_micros() as f64 / 1000.0));
    });
}

#[allow(clippy::future_not_send)]
async fn process_metadata(
    player: &Player,
    payload: MetadataPayload,
    cover_guard: &mut Option<NamedTempFile>,
) {
    let art_url = if let Some(data) = payload.cover_data {
        match tempfile::Builder::new().suffix(".jpg").tempfile() {
            Ok(mut file) => {
                if file.write_all(&data).is_ok() {
                    let url = format!("file://{}", file.path().to_string_lossy());
                    *cover_guard = Some(file);
                    Some(url)
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    } else if let Some(url) = payload.cover_url {
        *cover_guard = None;
        Some(url)
    } else {
        *cover_guard = None;
        None
    };

    let mut mb = Metadata::builder()
        .title(payload.title)
        .artist(payload.artists)
        .album(payload.album);

    let track_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();

    let track_path = format!("/com/splayer/track/{track_id}");
    if let Ok(op) = ObjectPath::try_from(track_path.as_str()) {
        mb = mb.trackid(op);
    }

    if let Some(dur) = payload.duration_ms {
        mb = mb.length(Time::from_millis(dur as i64));
    }

    if let Some(url) = art_url {
        mb = mb.art_url(url);
    }

    player.set_metadata(mb.build()).await.ok();
    player.set_position(Time::from_millis(0));
}

#[allow(clippy::future_not_send)]
async fn handle_cmd(
    cmd: MprisCommand,
    player: &Player,
    handler: &Arc<RwLock<Option<Arc<MediaThreadsafeFunction>>>>,
    enabled: &AtomicBool,
    cover_guard: &mut Option<NamedTempFile>,
) -> bool {
    // 生命周期命令始终接收；关闭期间丢弃所有发布，不能重新暴露曲目或时间轴。
    if !enabled.load(Ordering::Acquire)
        && !matches!(
            &cmd,
            MprisCommand::Enable
                | MprisCommand::Disable
                | MprisCommand::Shutdown
                | MprisCommand::RegisterCallback(_)
        )
    {
        return true;
    }
    match cmd {
        MprisCommand::Shutdown => {
            enabled.store(false, Ordering::Release);
            *cover_guard = None;
            return false;
        }
        MprisCommand::RegisterCallback(cb) => {
            if let Ok(mut g) = handler.write() {
                *g = Some(Arc::new(cb));
            }
        }
        MprisCommand::UpdateMetadata(p) => process_metadata(player, p, cover_guard).await,
        MprisCommand::UpdatePlaybackStatus(p) => {
            let status = match p.status {
                PlaybackStatus::Playing => MprisPlaybackStatus::Playing,
                PlaybackStatus::Paused => MprisPlaybackStatus::Paused,
            };
            player.set_playback_status(status).await.ok();
        }
        MprisCommand::UpdatePlaybackRate(rate) => {
            player.set_rate(rate).await.ok();
        }
        MprisCommand::UpdateVolume(vol) => {
            player.set_volume(vol).await.ok();
        }
        MprisCommand::FlushTimeline => {}
        MprisCommand::UpdatePlayMode(p) => {
            let loop_status = match p.repeat {
                RepeatMode::None => MprisLoopStatus::None,
                RepeatMode::Track => MprisLoopStatus::Track,
                RepeatMode::List => MprisLoopStatus::Playlist,
            };
            player.set_loop_status(loop_status).await.ok();
            player.set_shuffle(p.shuffle).await.ok();
        }
        MprisCommand::Enable => {
            enabled.store(true, Ordering::Release);
            set_control_capabilities(player, true).await;
        }
        MprisCommand::Disable => {
            enabled.store(false, Ordering::Release);
            *cover_guard = None;
            player
                .set_playback_status(MprisPlaybackStatus::Stopped)
                .await
                .ok();
            player.set_metadata(Metadata::new()).await.ok();
            player.set_position(Time::from_millis(0));
            set_control_capabilities(player, false).await;
        }
    }
    true
}

#[allow(clippy::future_not_send)]
async fn set_control_capabilities(player: &Player, enabled: bool) {
    player.set_can_play(enabled).await.ok();
    player.set_can_pause(enabled).await.ok();
    player.set_can_go_next(enabled).await.ok();
    player.set_can_go_previous(enabled).await.ok();
    player.set_can_seek(enabled).await.ok();
}

#[allow(clippy::future_not_send)]
async fn consume_command(
    cmd: MprisCommand,
    player: &Player,
    handler: &Arc<RwLock<Option<Arc<MediaThreadsafeFunction>>>>,
    enabled: &AtomicBool,
    cover_guard: &mut Option<NamedTempFile>,
    timeline: &TimelineMailbox,
) -> bool {
    if !handle_cmd(cmd, player, handler, enabled, cover_guard).await {
        return false;
    }
    if let Some(update) = timeline.take()
        && enabled.load(Ordering::Acquire)
    {
        apply_timeline(player, update).await;
    }
    true
}

#[allow(clippy::future_not_send)]
async fn build_player(identity: &str) -> Result<Player> {
    Player::builder(identity)
        .can_control(true)
        .minimum_rate(0.5)
        .maximum_rate(2.0)
        .playback_status(MprisPlaybackStatus::Stopped)
        .identity("SPlayer-Next")
        .desktop_entry("top.imsyy.splayer_next")
        .build()
        .await
        .map_err(|e| anyhow::anyhow!("MPRIS 初始化失败: {e}"))
}

#[allow(clippy::future_not_send)]
async fn apply_timeline(player: &Player, timeline: TimelineParam) {
    let position = Time::from_millis(timeline.current_ms as i64);
    player.set_position(position);
    if timeline.seeked.unwrap_or(false) {
        player.seeked(position).await.ok();
    }
}

#[allow(clippy::future_not_send)]
async fn run_mpris_loop(
    mut rx: Receiver<MprisCommand>,
    timeline: Arc<TimelineMailbox>,
) -> Result<()> {
    let handler = Arc::new(RwLock::new(None::<Arc<MediaThreadsafeFunction>>));
    let enabled = Arc::new(AtomicBool::new(false));
    let mut cover_guard: Option<NamedTempFile> = None;

    let pid = process::id();
    let identity = format!("splayer_next.instance{pid}");

    let player = build_player(&identity).await?;

    let event_handler = Arc::clone(&handler);
    setup_signals(&player, Arc::clone(&enabled), move |evt| {
        let callback = event_handler.read().ok().and_then(|guard| guard.clone());
        if let Some(callback) = callback {
            callback.call(evt, ThreadsafeFunctionCallMode::NonBlocking);
        }
    });

    let server = player.run();
    tokio::pin!(server);

    loop {
        tokio::select! {
            () = &mut server => break,
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                if !consume_command(cmd, &player, &handler, &enabled, &mut cover_guard, &timeline).await {
                    break;
                }
            }
        }
    }

    Ok(())
}

impl SystemMediaControls for LinuxImpl {
    fn initialize(&self) -> Result<()> {
        Ok(())
    }
    fn enable(&self) -> Result<()> {
        self.send_cmd(MprisCommand::Enable);
        Ok(())
    }
    fn disable(&self) -> Result<()> {
        self.send_cmd(MprisCommand::Disable);
        Ok(())
    }
    fn shutdown(&self) -> Result<()> {
        self.send_cmd(MprisCommand::Shutdown);
        Ok(())
    }
    fn register_event_handler(&self, cb: MediaThreadsafeFunction) -> Result<()> {
        self.send_cmd(MprisCommand::RegisterCallback(cb));
        Ok(())
    }
    fn update_metadata(&self, p: MetadataPayload) {
        self.send_cmd(MprisCommand::UpdateMetadata(p));
    }
    fn update_playback_status(&self, p: PlayStateParam) {
        self.send_cmd(MprisCommand::UpdatePlaybackStatus(p));
    }
    fn update_playback_rate(&self, r: f64) {
        self.send_cmd(MprisCommand::UpdatePlaybackRate(r));
    }
    fn update_volume(&self, v: f64) {
        self.send_cmd(MprisCommand::UpdateVolume(v));
    }
    fn update_timeline(&self, p: TimelineParam) {
        self.timeline.update(&self.sender, p);
    }
    fn update_play_mode(&self, p: PlayModeParam) {
        self.send_cmd(MprisCommand::UpdatePlayMode(p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_mailbox_keeps_only_latest_value() {
        let (sender, mut receiver) = channel(1);
        let mailbox = TimelineMailbox::default();
        mailbox.update(
            &sender,
            TimelineParam {
                current_ms: 10.0,
                total_ms: 100.0,
                seeked: None,
            },
        );
        mailbox.update(
            &sender,
            TimelineParam {
                current_ms: 20.0,
                total_ms: 100.0,
                seeked: Some(true),
            },
        );

        assert!(matches!(
            receiver.try_recv(),
            Ok(MprisCommand::FlushTimeline)
        ));
        let latest = mailbox.take().unwrap();
        assert_eq!(latest.current_ms, 20.0);
        assert_eq!(latest.seeked, Some(true));
        assert!(mailbox.take().is_none());
    }

    #[test]
    fn full_command_queue_still_bounds_timeline_storage() {
        let (sender, _receiver) = channel(1);
        sender.try_send(MprisCommand::Enable).unwrap();
        let mailbox = TimelineMailbox::default();

        for current_ms in 0..100 {
            mailbox.update(
                &sender,
                TimelineParam {
                    current_ms: f64::from(current_ms),
                    total_ms: 100.0,
                    seeked: None,
                },
            );
        }

        assert_eq!(mailbox.take().unwrap().current_ms, 99.0);
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // Linux 下通过 dbus-run-session 运行；使用真实 Player、属性发布及远端 D-Bus 方法。
    #[tokio::test]
    async fn disabled_mpris_drops_publications_and_remote_commands_then_reenables() {
        let identity = format!("splayer_next.lifecycle_test{}", process::id());
        let bus_name = format!("org.mpris.MediaPlayer2.{identity}");
        let player = build_player(&identity).await.unwrap();
        let enabled = Arc::new(AtomicBool::new(false));
        let events = Arc::new(AtomicUsize::new(0));
        let event_count = Arc::clone(&events);
        setup_signals(&player, Arc::clone(&enabled), move |event| {
            assert_eq!(event.type_, MediaEventType::Stop);
            event_count.fetch_add(1, Ordering::SeqCst);
        });
        let handler = Arc::new(RwLock::new(None));
        let mut cover = None;
        let timeline = TimelineMailbox::default();
        let (sender, _receiver) = channel(32);
        let connection = mpris_server::zbus::Connection::session().await.unwrap();
        let server = player.run();
        tokio::pin!(server);

        macro_rules! consume {
            ($command:expr) => {
                assert!(
                    consume_command($command, &player, &handler, &enabled, &mut cover, &timeline,)
                        .await
                )
            };
        }
        macro_rules! publish {
            () => {
                consume!(MprisCommand::UpdateMetadata(MetadataPayload {
                    title: "生命周期回归".to_string(),
                    artists: vec!["SPlayer".to_string()],
                    album: "测试".to_string(),
                    cover_data: Some(vec![1, 2, 3]),
                    cover_url: None,
                    duration_ms: Some(20_000.0),
                }));
                consume!(MprisCommand::UpdatePlaybackStatus(PlayStateParam {
                    status: PlaybackStatus::Playing,
                }));
                consume!(MprisCommand::UpdatePlaybackRate(1.25));
                consume!(MprisCommand::UpdateVolume(0.5));
                consume!(MprisCommand::UpdatePlayMode(PlayModeParam {
                    repeat: RepeatMode::Track,
                    shuffle: true,
                }));
                timeline.update(
                    &sender,
                    TimelineParam {
                        current_ms: 5_000.0,
                        total_ms: 20_000.0,
                        seeked: Some(true),
                    },
                );
                consume!(MprisCommand::FlushTimeline);
            };
        }
        macro_rules! remote_stop {
            () => {
                connection
                    .call_method(
                        Some(bus_name.as_str()),
                        "/org/mpris/MediaPlayer2",
                        Some("org.mpris.MediaPlayer2.Player"),
                        "Stop",
                        &(),
                    )
                    .await
                    .unwrap()
            };
        }

        let scenario = async {
            assert!(!player.can_play());
            publish!();
            assert_eq!(*player.metadata(), Metadata::new());
            assert_eq!(player.playback_status(), MprisPlaybackStatus::Stopped);
            assert_eq!(player.position(), Time::ZERO);
            assert_eq!(player.rate(), 1.0);
            assert_eq!(player.volume(), 1.0);
            assert_eq!(player.loop_status(), MprisLoopStatus::None);
            assert!(!player.shuffle());
            assert!(cover.is_none());
            remote_stop!();
            assert_eq!(events.load(Ordering::SeqCst), 0);

            consume!(MprisCommand::Enable);
            assert!(player.can_play() && player.can_seek());
            publish!();
            assert_eq!(player.metadata().title(), Some("生命周期回归"));
            assert_eq!(player.playback_status(), MprisPlaybackStatus::Playing);
            assert_eq!(player.position(), Time::from_millis(5_000));
            let cover_path = cover.as_ref().unwrap().path().to_path_buf();
            assert!(cover_path.exists());
            remote_stop!();
            assert_eq!(events.load(Ordering::SeqCst), 1);

            consume!(MprisCommand::Disable);
            assert!(!cover_path.exists());
            assert!(!player.can_play() && !player.can_seek());
            // 禁用后的更新刻意与上次发布不同，所有属性必须保持禁用时的状态。
            publish!();
            consume!(MprisCommand::UpdatePlaybackRate(1.75));
            consume!(MprisCommand::UpdateVolume(0.9));
            consume!(MprisCommand::UpdatePlayMode(PlayModeParam {
                repeat: RepeatMode::List,
                shuffle: false,
            }));
            assert_eq!(*player.metadata(), Metadata::new());
            assert_eq!(player.playback_status(), MprisPlaybackStatus::Stopped);
            assert_eq!(player.position(), Time::ZERO);
            assert_eq!(player.rate(), 1.25);
            assert_eq!(player.volume(), 0.5);
            assert_eq!(player.loop_status(), MprisLoopStatus::Track);
            assert!(player.shuffle());
            assert!(cover.is_none());
            remote_stop!();
            assert_eq!(events.load(Ordering::SeqCst), 1);

            consume!(MprisCommand::Enable);
            publish!();
            assert_eq!(player.metadata().title(), Some("生命周期回归"));
            assert_eq!(player.position(), Time::from_millis(5_000));
            remote_stop!();
            assert_eq!(events.load(Ordering::SeqCst), 2);
            assert!(
                !consume_command(
                    MprisCommand::Shutdown,
                    &player,
                    &handler,
                    &enabled,
                    &mut cover,
                    &timeline,
                )
                .await
            );
            assert!(cover.is_none());
            remote_stop!();
            assert_eq!(events.load(Ordering::SeqCst), 2);
        };

        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::select! {
                () = &mut server => panic!("MPRIS 服务提前退出"),
                () = scenario => {}
            }
        })
        .await
        .expect("真实 D-Bus 生命周期回归超时");
    }
}
