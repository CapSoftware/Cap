use std::{future::Future, time::Duration};

pub(super) fn connection_will_close(value: &str) -> bool {
    value
        .split(',')
        .any(|token| token.trim().eq_ignore_ascii_case("close"))
}

pub(super) async fn measure_warm_probe_rtt<Probe, ProbeFuture>(
    budget: Duration,
    mut probe: Probe,
) -> Option<Duration>
where
    Probe: FnMut() -> ProbeFuture,
    ProbeFuture: Future<Output = Option<Duration>>,
{
    tokio::time::timeout(budget, async {
        // The first HEAD can include DNS/TCP/TLS setup that the pooled POST will not pay.
        probe().await?;
        probe().await
    })
    .await
    .ok()
    .flatten()
}

pub(super) fn upload_elapsed_after_rtt(
    total_elapsed: Duration,
    rtt_elapsed: Option<Duration>,
) -> Duration {
    let total_elapsed = total_elapsed.max(Duration::from_millis(1));

    let Some(rtt_elapsed) = rtt_elapsed else {
        return total_elapsed;
    };

    match total_elapsed.checked_sub(rtt_elapsed) {
        Some(adjusted_elapsed) if !adjusted_elapsed.is_zero() => {
            adjusted_elapsed.max(Duration::from_millis(50))
        }
        _ => total_elapsed,
    }
}

pub(super) fn upload_mbps_for_bytes(byte_count: usize, elapsed: Duration) -> f64 {
    (byte_count as f64 * 8.0) / elapsed.max(Duration::from_millis(1)).as_secs_f64() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use std::future::{pending, ready};

    use super::*;

    #[test]
    fn detects_close_among_connection_tokens() {
        assert!(connection_will_close("close"));
        assert!(connection_will_close("keep-alive, CLOSE"));
        assert!(connection_will_close(" Close , upgrade"));
        assert!(!connection_will_close("keep-alive"));
        assert!(!connection_will_close(""));
    }

    #[tokio::test]
    async fn cold_connection_time_does_not_inflate_upload_speed() {
        let mut samples = [
            Some(Duration::from_millis(500)),
            Some(Duration::from_millis(100)),
        ]
        .into_iter();
        let rtt = measure_warm_probe_rtt(Duration::from_secs(2), || {
            ready(samples.next().expect("unexpected extra HEAD request"))
        })
        .await;

        assert_eq!(rtt, Some(Duration::from_millis(100)));
        assert_eq!(samples.next(), None);
        let elapsed = upload_elapsed_after_rtt(Duration::from_millis(700), rtt);
        assert_eq!(elapsed, Duration::from_millis(600));
        let mbps = upload_mbps_for_bytes(256 * 1024, elapsed);
        assert!(mbps > 3.0 && mbps < 4.0, "unexpected upload rate: {mbps}");
    }

    #[tokio::test]
    async fn failed_warmup_does_not_start_another_head() {
        let mut calls = 0;
        let rtt = measure_warm_probe_rtt(Duration::from_secs(2), || {
            calls += 1;
            ready(None)
        })
        .await;

        assert_eq!(rtt, None);
        assert_eq!(calls, 1);
    }

    #[tokio::test]
    async fn failed_measurement_does_not_reuse_the_cold_sample() {
        let mut samples = [Some(Duration::from_millis(500)), None].into_iter();
        let rtt = measure_warm_probe_rtt(Duration::from_secs(2), || {
            ready(samples.next().expect("unexpected extra HEAD request"))
        })
        .await;

        assert_eq!(rtt, None);
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(700), rtt),
            Duration::from_millis(700)
        );
    }

    #[tokio::test]
    async fn budget_expires_while_warming_up() {
        let mut calls = 0;
        let rtt = measure_warm_probe_rtt(Duration::ZERO, || {
            calls += 1;
            pending::<Option<Duration>>()
        })
        .await;

        assert_eq!(rtt, None);
        assert_eq!(calls, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn warmup_and_measurement_share_one_deadline() {
        let mut calls = 0;
        let started = tokio::time::Instant::now();
        let rtt = measure_warm_probe_rtt(Duration::from_secs(2), || {
            calls += 1;
            async {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                Some(Duration::from_millis(1500))
            }
        })
        .await;

        assert_eq!(rtt, None);
        assert_eq!(calls, 2);
        assert_eq!(started.elapsed(), Duration::from_secs(2));
    }

    #[test]
    fn subtracts_warm_rtt_from_upload_elapsed() {
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(700), Some(Duration::from_millis(100))),
            Duration::from_millis(600)
        );
    }

    #[test]
    fn keeps_total_elapsed_when_rtt_would_overcorrect() {
        for rtt in [520, 600] {
            assert_eq!(
                upload_elapsed_after_rtt(
                    Duration::from_millis(520),
                    Some(Duration::from_millis(rtt))
                ),
                Duration::from_millis(520)
            );
        }
    }

    #[test]
    fn faster_valid_uploads_do_not_report_lower_throughput_at_the_sample_floor() {
        let rtt = Some(Duration::from_millis(100));
        let faster = upload_elapsed_after_rtt(Duration::from_millis(149), rtt);
        let at_floor = upload_elapsed_after_rtt(Duration::from_millis(150), rtt);
        let slower = upload_elapsed_after_rtt(Duration::from_millis(151), rtt);

        assert_eq!(faster, Duration::from_millis(50));
        assert_eq!(at_floor, Duration::from_millis(50));
        assert_eq!(slower, Duration::from_millis(51));
        assert!(
            upload_mbps_for_bytes(256 * 1024, faster) >= upload_mbps_for_bytes(256 * 1024, slower)
        );
    }

    #[test]
    fn elapsed_is_positive_without_an_rtt_sample() {
        assert_eq!(
            upload_elapsed_after_rtt(Duration::ZERO, None),
            Duration::from_millis(1)
        );
        assert_eq!(
            upload_elapsed_after_rtt(Duration::from_millis(700), None),
            Duration::from_millis(700)
        );
    }
}
