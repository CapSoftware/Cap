use crate::model::Recognized;

/// Greedy CTC decode of `[steps, classes]` probabilities (class 0 is blank,
/// class i is `charset[i - 1]`). Each character's span covers the timesteps
/// it was emitted on, widened to halfway to its neighbours, in timestep
/// units.
pub fn greedy_decode(probs: &[f32], classes: usize, charset: &[String]) -> Recognized {
    let steps = probs.len() / classes.max(1);
    let mut chars: Vec<(String, usize, usize, f32)> = Vec::new();
    let mut previous = 0usize;
    for t in 0..steps {
        let row = &probs[t * classes..(t + 1) * classes];
        let (best, score) =
            row.iter().enumerate().fold(
                (0usize, f32::MIN),
                |acc, (i, p)| if *p > acc.1 { (i, *p) } else { acc },
            );
        if best != 0 {
            if best == previous {
                if let Some(last) = chars.last_mut() {
                    last.2 = t + 1;
                    last.3 = last.3.max(score);
                }
            } else if let Some(ch) = charset.get(best - 1) {
                chars.push((ch.clone(), t, t + 1, score));
            }
        }
        previous = best;
    }
    let mut result = Recognized::default();
    let count = chars.len();
    let mut confidence = 0.0;
    for index in 0..count {
        let (ref text, start, end, score) = chars[index];
        let left = if index == 0 {
            let pitch = if count > 1 {
                (chars[count - 1].1 as f32 - chars[0].1 as f32) / (count - 1) as f32
            } else {
                2.0
            };
            (start as f32 - pitch * 0.5).max(0.0)
        } else {
            (chars[index - 1].2 as f32 + start as f32) * 0.5
        };
        let right = if index + 1 == count {
            let pitch = if count > 1 {
                (chars[count - 1].1 as f32 - chars[0].1 as f32) / (count - 1) as f32
            } else {
                2.0
            };
            (end as f32 + pitch * 0.5).min(steps as f32)
        } else {
            (end as f32 + chars[index + 1].1 as f32) * 0.5
        };
        for _ in text.chars() {
            result.spans.push((left, right));
        }
        result.text.push_str(text);
        confidence += score;
    }
    if count > 0 {
        result.confidence = confidence / count as f32;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_hot(steps: &[usize], classes: usize) -> Vec<f32> {
        let mut probs = vec![0.0; steps.len() * classes];
        for (t, class) in steps.iter().enumerate() {
            probs[t * classes + class] = 1.0;
        }
        probs
    }

    #[test]
    fn collapses_repeats_and_blanks() {
        let charset = ["a", "b", " "].map(String::from).to_vec();
        let probs = one_hot(&[0, 1, 1, 0, 1, 2, 0, 3, 0, 2], 4);
        let result = greedy_decode(&probs, 4, &charset);
        assert_eq!(result.text, "aab b");
        assert_eq!(result.spans.len(), 5);
        assert!(result.spans.windows(2).all(|w| w[0].1 <= w[1].0 + 1e-6));
        assert!((result.confidence - 1.0).abs() < 1e-6);
    }
}
