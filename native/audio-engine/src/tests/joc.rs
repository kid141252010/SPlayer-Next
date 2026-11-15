use std::sync::Arc;
use std::time::{Duration, Instant};

use ffmpeg_audio::{AudioReader, HttpCancelHandle, SeekMode};
use parking_lot::Mutex;

use crate::decoder::buffer::{PopResult, Shared};
use crate::decoder::{prepare_decode, resume_decode, start_prepared_decode, DecoderData};
use crate::dsp::{equalizer::Equalizer, tempo::StretchProcessor};
use crate::joc::Settings;
use crate::player::preload::PreparedPlayback;
use crate::player::{InnerPlayer, PlayerEvent};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");

/// JOC 双耳播放切入预载 WAV 时清理场景和统计，并推送未生效事件
#[test]
fn preloaded_non_eac3_clears_previous_joc_state() {
    let player = InnerPlayer::new().unwrap();
    let settings = Arc::clone(&player.joc);
    let events = Arc::new(Mutex::new(Vec::new()));
    {
        let events = Arc::clone(&events);
        let mut settings = settings.lock();
        settings.mode = "binaural".into();
        settings.hrtf = Some((
            "D2".into(),
            Arc::new(include_bytes!("../../../../resources/joc/joc-hrtf-D2.jochrtf").to_vec()),
        ));
        settings.callback = Some(Arc::new(move |event| {
            if let PlayerEvent::JocStateChanged { active } = event {
                events.lock().push(active);
            }
        }));
    }
    let mut prepared =
        prepare_decode(&format!("{ROOT}joc.mp4"), None, HttpCancelHandle::new()).unwrap();
    prepared.set_joc_settings(Arc::clone(&settings));
    let shared = Shared::new(48_000, 2);
    let equalizer = Arc::new(Mutex::new(Equalizer::new(48_000, 2)));
    let tempo = Arc::new(Mutex::new(StretchProcessor::new(2, 48_000)));
    let (_, worker, _) = start_prepared_decode(
        prepared,
        Arc::clone(&shared),
        Arc::clone(&equalizer),
        Arc::clone(&tempo),
    )
    .unwrap();
    collect(shared, worker);
    assert!(settings.lock().active);
    assert!(settings.lock().scene.is_some());
    assert!(settings.lock().info.frames_out > 0);
    assert_eq!(*events.lock(), [true]);

    let path = super::fixtures::tone_file(48_000, "joc-preloaded-bypass");
    let mut prepared =
        prepare_decode(path.to_str().unwrap(), None, HttpCancelHandle::new()).unwrap();
    prepared.set_joc_settings(Arc::clone(&settings));
    let shared = Shared::new(48_000, 2);
    shared.set_preloading(true);
    let (metadata, worker, cancel) = start_prepared_decode(
        prepared,
        Arc::clone(&shared),
        Arc::clone(&equalizer),
        Arc::clone(&tempo),
    )
    .unwrap();
    assert_ne!(metadata.codec, "eac3");
    let (decoder, _) = collect(Arc::clone(&shared), worker);
    assert!(settings.lock().active, "预载不应改变当前曲目的状态");
    let ready = PreparedPlayback {
        id: "joc-preloaded-bypass".into(),
        source: path.to_str().unwrap().into(),
        config: player.preload_config(),
        start_position: 0.0,
        metadata,
        shared,
        decoder: Some(std::thread::spawn(move || decoder)),
        cancel,
        equalizer,
        tempo,
    };
    ready.activate(&settings);
    assert!(!settings.lock().active);
    assert!(settings.lock().scene.is_none());
    assert_eq!(settings.lock().info.frames_out, 0);
    assert_eq!(*events.lock(), [true, false]);
    assert!(!ready.shared.is_preloading());
    drop(ready);
    std::fs::remove_file(path).unwrap();
}

/// 消费完整解码链并核对源计数与变速前样本一致
/// @param shared - 解码共享队列
/// @param worker - 解码线程
/// @returns 可复用解码器和交错样本
fn collect(
    shared: Arc<Shared>,
    worker: std::thread::JoinHandle<DecoderData>,
) -> (DecoderData, Vec<f32>) {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut output = Vec::new();
    let mut source_count = 0;
    loop {
        assert!(Instant::now() < deadline, "JOC 解码超时");
        match shared.try_pop() {
            PopResult::Chunk(chunk) => {
                source_count += chunk.source_sample_count;
                output.extend(chunk.player_samples);
            }
            PopResult::Pending => std::thread::sleep(Duration::from_millis(1)),
            PopResult::Finished => break,
        }
    }
    let decoder = worker.join().unwrap();
    assert!(!shared.is_decode_failed());
    assert_eq!(source_count, output.len() as u64);
    assert!(output.iter().all(|value| value.is_finite()));
    (decoder, output)
}

/// 用真实 ec-3 封装验证渲染、设备转换及带预滚 seek 的长度
#[test]
fn joc_packets_render_and_seek_without_timeline_drift() {
    for (name, mode, rate, channels) in [
        ("joc.eac3", "speaker", 48_000, 2),
        ("joc.mp4", "speaker", 44_100, 6),
        ("joc.mp4", "binaural", 44_100, 1),
    ] {
        let settings = Arc::new(Mutex::new(Settings {
            mode: mode.into(),
            hrtf: Some((
                "D2".into(),
                Arc::new(include_bytes!("../../../../resources/joc/joc-hrtf-D2.jochrtf").to_vec()),
            )),
            ..Settings::default()
        }));
        let mut prepared =
            prepare_decode(&format!("{ROOT}{name}"), None, HttpCancelHandle::new()).unwrap();
        prepared.set_joc_settings(Arc::clone(&settings));
        let shared = Shared::new(rate, channels);
        let eq = Arc::new(Mutex::new(Equalizer::new(rate, channels)));
        let tempo = Arc::new(Mutex::new(StretchProcessor::new(channels, rate)));
        let (_, worker, _) = start_prepared_decode(
            prepared,
            Arc::clone(&shared),
            Arc::clone(&eq),
            Arc::clone(&tempo),
        )
        .unwrap();
        let (mut decoder, samples) = collect(shared, worker);
        assert!(settings.lock().active, "{name}/{mode} 未进入渲染路径");
        assert!(settings.lock().info.frames_out > 0);
        assert!(
            (samples.len() as i64 - (3.84 * f64::from(rate) * f64::from(channels)).round() as i64)
                .abs()
                <= i64::from(channels) * 2,
            "首播长度: {}",
            samples.len()
        );
        let controls = settings.lock().controls;
        for target in [2.731, 0.137, 3.521] {
            assert!(decoder.seek(target));
            let shared = Shared::new(rate, channels);
            let worker = resume_decode(
                decoder,
                Arc::clone(&shared),
                Arc::clone(&eq),
                Arc::clone(&tempo),
            )
            .unwrap();
            let (next, samples) = collect(shared, worker);
            decoder = next;
            let expected = ((3.84 - target) * f64::from(rate) * f64::from(channels)).round() as i64;
            assert!(
                (samples.len() as i64 - expected).abs() <= i64::from(channels) * 2,
                "seek {target}: {}/{}",
                samples.len(),
                expected
            );
            assert!(settings.lock().controls == controls);
        }
    }
}

/// 原始包旁路在默认关闭时不分配载荷，seek 不混入上一次读取的包
#[test]
fn packet_passthrough_is_opt_in_and_cleared_on_seek() {
    let bytes = include_bytes!("../../tests/fixtures/core.eac3");
    let mut reader = AudioReader::new(std::io::Cursor::new(bytes.to_vec())).unwrap();
    assert!(reader
        .receive_frame()
        .unwrap()
        .unwrap()
        .take_packets()
        .is_empty());
    reader.set_packet_passthrough(true);
    reader.seek(Duration::ZERO, SeekMode::Accurate).unwrap();
    let first = reader.receive_frame().unwrap().unwrap().take_packets();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0], bytes[..first[0].len()]);
    for _ in 0..3 {
        reader.receive_frame().unwrap();
    }
    reader.seek(Duration::ZERO, SeekMode::Accurate).unwrap();
    let mut frame = reader.receive_frame().unwrap().unwrap();
    assert_eq!(frame.take_packets(), first);
    assert!(frame.take_packets().is_empty());
    reader.set_packet_passthrough(false);
    assert!(reader
        .receive_frame()
        .unwrap()
        .unwrap()
        .take_packets()
        .is_empty());
}

/// 普通 E-AC-3 开启 JOC 后仍逐样本保持原有下混输出
#[test]
fn ordinary_eac3_is_unchanged() {
    let mut baseline = Vec::new();
    for mode in ["off", "speaker"] {
        let mut prepared =
            prepare_decode(&format!("{ROOT}core.eac3"), None, HttpCancelHandle::new()).unwrap();
        let settings = Arc::new(Mutex::new(Settings {
            mode: mode.into(),
            ..Settings::default()
        }));
        prepared.set_joc_settings(Arc::clone(&settings));
        let shared = Shared::new(44_100, 2);
        let (_, worker, _) = start_prepared_decode(
            prepared,
            Arc::clone(&shared),
            Arc::new(Mutex::new(Equalizer::new(44_100, 2))),
            Arc::new(Mutex::new(StretchProcessor::new(2, 44_100))),
        )
        .unwrap();
        let (_, samples) = collect(shared, worker);
        assert!(!settings.lock().active);
        if mode == "off" {
            baseline = samples;
        } else {
            assert_eq!(baseline, samples);
        }
    }
}

/// 非 E-AC-3 音源不创建对象渲染链，显式打开模式也不改变 PCM
#[test]
fn non_eac3_is_unchanged() {
    let path = super::fixtures::tone_file(48_000, "joc-bypass");
    let mut baseline = Vec::new();
    for mode in ["off", "speaker"] {
        let mut prepared =
            prepare_decode(path.to_str().unwrap(), None, HttpCancelHandle::new()).unwrap();
        let settings = Arc::new(Mutex::new(Settings {
            mode: mode.into(),
            ..Settings::default()
        }));
        prepared.set_joc_settings(Arc::clone(&settings));
        let shared = Shared::new(48_000, 2);
        let (_, worker, _) = start_prepared_decode(
            prepared,
            Arc::clone(&shared),
            Arc::new(Mutex::new(Equalizer::new(48_000, 2))),
            Arc::new(Mutex::new(StretchProcessor::new(2, 48_000))),
        )
        .unwrap();
        let (_, samples) = collect(shared, worker);
        assert!(!settings.lock().active);
        if mode == "off" {
            baseline = samples;
        } else {
            assert_eq!(baseline, samples);
        }
    }
    std::fs::remove_file(path).unwrap();
}
