use super::*;

#[test]
fn processes_every_output_channel_independently() {
    let mut equalizer = Equalizer::new(48_000, 6);
    equalizer.set_enabled(true);
    equalizer.set_preamp_db(6.0);
    let mut samples = vec![0.1, -0.2, 0.3, -0.4, 0.5, -0.6];

    equalizer.process_interleaved(&mut samples);

    for (actual, original) in samples.iter().zip([0.1_f32, -0.2, 0.3, -0.4, 0.5, -0.6]) {
        assert!(actual.abs() > original.abs());
    }
}

#[test]
fn rebuilds_filters_when_output_channel_count_changes() {
    let mut equalizer = Equalizer::new(48_000, 2);
    equalizer.set_output_format(96_000, 8);

    assert_eq!(equalizer.filters.len(), 8);
    assert_eq!(equalizer.sample_rate, 96_000.0);
}

#[test]
fn out_of_range_band_is_stable_and_recovers_at_higher_output_rate() {
    for gain in [-15.0, 15.0] {
        for low_rate in [22_050, 32_000] {
            let mut equalizer = Equalizer::new(48_000, 2);
            equalizer.set_enabled(true);
            let mut gains = [0.0; EQ_BAND_COUNT];
            gains[9] = gain;
            equalizer.set_band_gains(&gains);
            // 先填充高频滤波器状态，降采样后不得留下尾音。
            equalizer.process_interleaved(&mut [0.5, -0.5]);
            equalizer.set_output_format(low_rate, 2);
            let mut silence = [0.0; 64];
            equalizer.process_interleaved(&mut silence);
            assert_eq!(silence, [0.0; 64]);

            let input: Vec<f32> = (0..44_100)
                .map(|i| (i as f32 * 0.73).sin() * 0.25)
                .collect();
            let mut output = input.clone();
            equalizer.process_interleaved(&mut output);
            assert_eq!(output, input);

            equalizer.set_output_format(48_000, 2);
            let mut recovered = vec![0.0; 256];
            recovered[0] = 0.5;
            recovered[1] = -0.5;
            equalizer.process_interleaved(&mut recovered);
            let mut fresh = Equalizer::new(48_000, 2);
            fresh.set_enabled(true);
            fresh.set_band_gains(&gains);
            let mut expected = vec![0.0; 256];
            expected[0] = 0.5;
            expected[1] = -0.5;
            fresh.process_interleaved(&mut expected);
            assert_eq!(recovered, expected);
            assert!(recovered.iter().all(|sample| sample.is_finite()));
            assert!((recovered[0] - 0.5).abs() > 0.01);
        }
    }
}
