//! Glue between the parsed frame parameters and the object-reconstruction kernel.

use crate::id14::FrameParams;
use crate::qmf::{ObjectDescriptor, Renderer};
use crate::{
    fail, ErrorKind, Result, FRAME_SAMPLES, MAX_CORE_CHANNELS, MAX_DPOINTS, MAX_OBJECTS,
    MAX_PARAMETER_BANDS, OUTPUT_CHANNELS,
};

/// Flattens `FrameParams` into the kernel's descriptor layout.
pub fn descriptor_from_params(params: &FrameParams) -> ObjectDescriptor {
    let mut descriptor = ObjectDescriptor::new();
    for object in 0..MAX_OBJECTS {
        let info = &params.objects[object];
        if !info.present {
            continue;
        }
        descriptor.n_bands[object] = info.n_bands;
        descriptor.n_dpoints[object] = info.n_dpoints;
        descriptor.slope_idx[object] = info.slope_idx;
        descriptor.offset_ts[object] = info.offset_ts;
        for point in 0..MAX_DPOINTS {
            for channel in 0..params.n_channels as usize {
                for band in 0..info.n_bands as usize {
                    let index = (((object * MAX_DPOINTS + point) * MAX_CORE_CHANNELS + channel)
                        * MAX_PARAMETER_BANDS)
                        + band;
                    descriptor.dq[index] = info.dq[point][channel][band];
                }
            }
        }
    }
    descriptor
}

/// `bed_planar` is `[n_channels][1536]`; `lfe` is `[1536]` or empty.
pub fn rebuild(
    renderer: &mut Renderer,
    params: &FrameParams,
    bed_planar: &[f32],
    lfe: &[f32],
    gain: f32,
    out16: &mut [f32],
) -> Result<()> {
    if params.n_channels != 5 && params.n_channels != 7 {
        return fail(
            ErrorKind::JocUnsupportedVariant,
            "dsp",
            format!(
                "the JOC kernel requires 5 or 7 core channels, frame declares {}",
                params.n_channels
            ),
        );
    }
    let descriptor = descriptor_from_params(params);
    // sigma(k) = (k in {3,4}) gates the Ls/Rs -j rotation and the band-0 21-tap
    // DC compensation together.
    let phase_shift = params.dmx_config_idx == 3 || params.dmx_config_idx == 4;
    out16[..OUTPUT_CHANNELS * FRAME_SAMPLES].fill(0.0);
    renderer.process(
        bed_planar,
        if lfe.is_empty() { None } else { Some(lfe) },
        params.n_channels as usize,
        phase_shift,
        params.present_mask,
        &descriptor,
        params.clipgain,
        0.0625,
        gain,
        out16,
    )
}

#[cfg(test)]
mod tests {
    use super::rebuild;
    use crate::id14::FrameParams;
    use crate::qmf::Renderer;
    use crate::{FRAME_SAMPLES, OUTPUT_CHANNELS};

    #[test]
    fn object_pcm_uses_its_own_reconstruction_parameters() {
        // 渲染器包含大型固定数组，避免测试线程的默认栈限制。
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                // 分别覆盖混合频带、时间偏移、插值点数和斜率，并保留均匀参数路径。
                let cases = [
                    ((1, 1, 0, [0, 0]), (3, 2, 1, [4, 17])),
                    ((3, 2, 1, [2, 13]), (3, 2, 1, [8, 21])),
                    ((3, 1, 0, [0, 0]), (3, 2, 0, [0, 0])),
                    ((3, 2, 0, [0, 0]), (3, 2, 1, [5, 19])),
                    ((3, 2, 1, [4, 17]), (3, 2, 1, [4, 17])),
                ];
                let mut bed = vec![0.0f32; 5 * FRAME_SAMPLES];
                for channel in 0..5 {
                    for sample in 0..FRAME_SAMPLES {
                        // 确定性宽带信号，使三个参数频带都参与实际 PCM 重建。
                        let value = (sample * 73 + channel * 151) % 257;
                        bed[channel * FRAME_SAMPLES + sample] = (value as f32 - 128.0) / 4096.0;
                    }
                }
                for (case, (first, second)) in cases.into_iter().enumerate() {
                    let mut params = FrameParams::default();
                    params.n_channels = 5;
                    params.n_objects = 2;
                    params.present_mask = 3;
                    params.clipgain = 1.0;
                    for (object, (bands, points, slope, offsets)) in
                        [first, second].into_iter().enumerate()
                    {
                        let info = &mut params.objects[object];
                        info.present = true;
                        info.n_bands = bands;
                        info.n_dpoints = points;
                        info.slope_idx = slope;
                        info.offset_ts = offsets;
                        for point in 0..2 {
                            for channel in 0..5 {
                                for band in 0..bands as usize {
                                    info.dq[point][channel][band] =
                                        (1 + object + channel + band * 3) as f64
                                            * if point == 0 { 0.125 } else { -0.0625 };
                                }
                            }
                        }
                    }
                    let mut together = Renderer::new();
                    let mut alone = [Renderer::new(), Renderer::new()];
                    let mut mixed_pcm = vec![0.0; OUTPUT_CHANNELS * FRAME_SAMPLES];
                    let mut solo_pcm = vec![0.0; OUTPUT_CHANNELS * FRAME_SAMPLES];
                    // 连续帧同时验证插值历史和合成滤波状态，而非仅检查首帧字段。
                    for frame in 0..3 {
                        rebuild(&mut together, &params, &bed, &[], 1.0, &mut mixed_pcm)
                            .expect("混合对象重建失败");
                        for object in 0..2 {
                            let mut solo = params.clone();
                            solo.present_mask = 1 << object;
                            solo.objects[1 - object].present = false;
                            rebuild(&mut alone[object], &solo, &bed, &[], 1.0, &mut solo_pcm)
                                .expect("独立对象重建失败");
                            let start = (object + 1) * FRAME_SAMPLES;
                            let end = start + FRAME_SAMPLES;
                            let expected = &solo_pcm[start..end];
                            assert!(
                                expected.iter().any(|sample| sample.abs() > 1.0e-6),
                                "用例 {case} 帧 {frame} 对象 {object} 未产生有效信号"
                            );
                            assert_eq!(
                                &mixed_pcm[start..end],
                                expected,
                                "用例 {case} 帧 {frame} 对象 {object} 受到其他对象参数污染"
                            );
                        }
                    }
                }
            })
            .expect("无法启动对象重建测试线程")
            .join()
            .expect("对象重建回归失败");
    }
}
