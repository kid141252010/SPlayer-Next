use super::*;
use std::io::Cursor;

fn mono_wav() -> Vec<u8> {
    let sample_rate = 48_000_u32;
    let frames = 1024_u32;
    let data_size = frames * 2;
    let mut bytes = Vec::with_capacity(44 + data_size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.resize(44 + data_size as usize, 0);
    bytes
}

#[test]
fn playback_and_fft_resamplers_use_independent_channel_counts() {
    let mut reader = AudioReader::new(Cursor::new(mono_wav())).unwrap();
    assert_eq!(reader.source_info().channels, 1);
    let (mut player_resampler, mut fft_resampler) = build_resamplers(&reader, 48_000, 6).unwrap();
    let frame = reader.receive_frame().unwrap().unwrap();

    player_resampler.process::<f32>(Some(&frame)).unwrap();
    fft_resampler.process::<f32>(Some(&frame)).unwrap();

    let player_samples = player_resampler.output_as::<f32>();
    let fft_samples = fft_resampler.output_as::<f32>();
    assert!(!player_samples.is_empty());
    assert!(!fft_samples.is_empty());
    assert_eq!(player_samples.len() % 6, 0);
    assert_eq!(fft_samples.len() % usize::from(FFT_CHANNELS), 0);
}

#[test]
fn lazy_seek_http_source_short_circuits_tail_probe() {
    let dummy_data = vec![0xAB; 1000];
    let cursor = Cursor::new(dummy_data);
    let mut source = LazySeekHttpSource::new(cursor, Some(1000));

    // 1. 正常从起点读取 10 字节
    let mut initial_buf = [0u8; 10];
    assert_eq!(source.read(&mut initial_buf).unwrap(), 10);
    assert_eq!(initial_buf, [0xAB; 10]);
    assert_eq!(source.inner.position(), 10);

    // 2. 模拟 FFmpeg mov_read_mfra 对末尾 4 字节的探测：seek(End(-4)) 后 read(4)
    let probe_pos = source.seek(SeekFrom::End(-4)).unwrap();
    assert_eq!(probe_pos, 996);
    let mut probe_buf = [0xFFu8; 4];
    let n = source.read(&mut probe_buf).unwrap();
    assert_eq!(n, 4);
    // 应当返回内存零填充，且底层的实际 cursor 位置保持在 10，完全未发生网络 Seek
    assert_eq!(probe_buf, [0x00; 4]);
    assert_eq!(source.inner.position(), 10);

    // 3. 模拟探测结束后恢复原位 seek(Start(10)) 并继续顺序读取
    let resume_pos = source.seek(SeekFrom::Start(10)).unwrap();
    assert_eq!(resume_pos, 10);
    let mut next_buf = [0u8; 10];
    assert_eq!(source.read(&mut next_buf).unwrap(), 10);
    assert_eq!(next_buf, [0xAB; 10]);
    assert_eq!(source.inner.position(), 20);
}

const FRAGMENTED_ALAC: &[u8] = include_bytes!("fragmented-alac.m4a");

struct TrackedAudio {
    cursor: Cursor<&'static [u8]>,
    furthest_read: Arc<std::sync::atomic::AtomicU64>,
}

impl Read for TrackedAudio {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.cursor.read(bytes)?;
        self.furthest_read
            .fetch_max(self.cursor.position(), std::sync::atomic::Ordering::Relaxed);
        Ok(count)
    }
}

impl Seek for TrackedAudio {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        self.cursor.seek(from)
    }
}

fn fragmented_reader(ignore_index: bool) -> (AudioReader, Arc<std::sync::atomic::AtomicU64>) {
    let furthest_read = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let source = TrackedAudio {
        cursor: Cursor::new(FRAGMENTED_ALAC),
        furthest_read: Arc::clone(&furthest_read),
    };
    let reader = AudioReader::with_options(
        LazySeekHttpSource::new(source, Some(FRAGMENTED_ALAC.len() as u64)),
        AudioReaderOptions { ignore_index },
    )
    .unwrap();
    (reader, furthest_read)
}

fn read_fragmented_pcm(reader: &mut AudioReader) -> Vec<f32> {
    let mut resampler = reader
        .build_resampler(
            ResampleOptions::new()
                .sample_rate(8000)
                .channels(1)
                .format::<f32>(),
        )
        .unwrap();
    let mut pcm = Vec::new();
    while let Some(frame) = reader.receive_frame().unwrap() {
        resampler.process::<f32>(Some(&frame)).unwrap();
        pcm.extend_from_slice(resampler.output_as::<f32>());
    }
    pcm
}

#[test]
fn fragmented_stream_opens_without_scanning_later_fragments() {
    // 48 秒的 440 Hz 单声道 ALAC，每片约 16 秒，无尾索引。
    // 生成命令见 audio-engine/README.md，测试运行不依赖 ffmpeg 可执行文件。
    let (mut reader, furthest_read) = fragmented_reader(true);
    assert!(
        furthest_read.load(std::sync::atomic::Ordering::Relaxed)
            < (FRAGMENTED_ALAC.len() / 2) as u64,
        "首播不应为了建立索引而读取后半首音频"
    );
    let pcm = read_fragmented_pcm(&mut reader);
    assert_eq!(pcm.len(), 48 * 8000, "顺序解码不得丢帧或提前结束");

    let (mut indexed, _) = fragmented_reader(false);
    assert_eq!(pcm, read_fragmented_pcm(&mut indexed));
}

#[test]
fn fragmented_stream_can_seek_forward_before_indexing_and_back_again() {
    let (mut reference, _) = fragmented_reader(false);
    let expected = read_fragmented_pcm(&mut reference);
    let (mut reader, _) = fragmented_reader(true);
    for second in [32, 4] {
        reader
            .seek(Duration::from_secs(second), SeekMode::Accurate)
            .unwrap();
        assert_eq!(
            read_fragmented_pcm(&mut reader),
            expected[second as usize * 8000..],
            "跳转到 {second} 秒后的 PCM 必须与完整解码对应区间一致"
        );
    }
}

#[test]
fn only_local_am_proxy_uses_lazy_fragment_indexing() {
    assert!(is_am_stream(
        "http://127.0.0.1:8862/am-stream?adamId=123&size=456&duration=48"
    ));
    for source in [
        "https://example.com/am-stream?duration=48",
        "http://127.0.0.1:8862/song.m4a?duration=48",
        "http://127.0.0.1:8862/nested/am-stream?duration=48",
        "http://127.0.0.1:8862/am-stream-other?duration=48",
        "http://127.0.0.1.example.com:8862/am-stream?duration=48",
        "C:/Music/am-stream.m4a",
    ] {
        assert!(!is_am_stream(source), "普通音源不应忽略索引: {source}");
    }
}
