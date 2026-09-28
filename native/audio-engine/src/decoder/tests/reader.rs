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
