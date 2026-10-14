use crate::screenshot::mask_filter;
use std::{collections::HashSet, hash::Hash};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaskFrame {
    pub revision: u64,
    pub size: (u32, u32),
    pub content: [u64; 4],
    pub padding: u64,
    pub crop: Option<[u32; 4]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskRequest {
    pub id: String,
    pub frame: MaskFrame,
    pub region: (u32, u32, u32, u32),
    pub pixelate: bool,
    pub level: u64,
}

impl MaskRequest {
    pub fn filter(&self, rgba: &[u8]) -> Option<image::RgbaImage> {
        mask_filter(
            rgba,
            self.frame.size.0,
            self.frame.size.1,
            self.region,
            self.pixelate,
            f64::from_bits(self.level),
        )
    }
}

#[derive(Clone)]
pub struct MaskEntry<T> {
    pub request: MaskRequest,
    pub value: Option<T>,
}

pub fn should_cancel_mask_build(previous: &[MaskRequest], requests: &[MaskRequest]) -> bool {
    let Some(first) = previous.first() else {
        return true;
    };
    if previous
        .iter()
        .chain(requests)
        .any(|request| request.frame != first.frame)
    {
        return true;
    }
    let mut used = vec![false; requests.len()];
    previous.iter().any(|request| {
        let duplicated = previous
            .iter()
            .filter(|other| other.id == request.id)
            .count()
            > 1
            || requests
                .iter()
                .filter(|other| other.id == request.id)
                .count()
                > 1;
        let matched = requests.iter().enumerate().position(|(index, next)| {
            !used[index] && next.id == request.id && (!duplicated || next == request)
        });
        match matched {
            Some(index) => {
                used[index] = true;
                false
            }
            None => true,
        }
    })
}

pub fn plan_masks<T>(previous: &[MaskEntry<T>], requests: &[MaskRequest]) -> Vec<Option<usize>> {
    let mut used = vec![false; previous.len()];
    requests
        .iter()
        .map(|request| {
            let index = previous
                .iter()
                .enumerate()
                .position(|(index, entry)| !used[index] && entry.request == *request)?;
            used[index] = true;
            Some(index)
        })
        .collect()
}

fn match_masks<T>(previous: &[MaskEntry<T>], requests: &[MaskRequest]) -> Vec<Option<usize>> {
    let mut matches = plan_masks(previous, requests);
    let mut used = vec![false; previous.len()];
    for index in matches.iter().flatten() {
        used[*index] = true;
    }
    for (request, matched) in requests.iter().zip(&mut matches) {
        if matched.is_none()
            && let Some(index) = previous
                .iter()
                .enumerate()
                .position(|(index, entry)| !used[index] && entry.request.id == request.id)
        {
            used[index] = true;
            *matched = Some(index);
        }
    }
    matches
}

pub fn retain_masks<T: Clone>(
    previous: &[MaskEntry<T>],
    requests: &[MaskRequest],
) -> Vec<MaskEntry<T>> {
    match_masks(previous, requests)
        .into_iter()
        .flatten()
        .map(|index| previous[index].clone())
        .collect()
}

pub fn finish_mask_build<T: Clone>(
    current: &[MaskEntry<T>],
    completed: Vec<MaskEntry<T>>,
) -> Vec<MaskEntry<T>> {
    let requests: Vec<_> = completed
        .iter()
        .map(|entry| entry.request.clone())
        .collect();
    let matches = match_masks(current, &requests);
    completed
        .into_iter()
        .zip(matches)
        .map(|(entry, matched)| match matched {
            Some(index) if current[index].request == entry.request => current[index].clone(),
            _ => entry,
        })
        .collect()
}

pub fn retired_mask_values<'a, T, K: Eq + Hash>(
    previous: &'a [MaskEntry<T>],
    next: &[MaskEntry<T>],
    key: impl Fn(&T) -> K,
) -> Vec<&'a T> {
    let mut referenced: HashSet<_> = next
        .iter()
        .filter_map(|entry| entry.value.as_ref())
        .map(&key)
        .collect();
    previous
        .iter()
        .filter_map(|entry| entry.value.as_ref())
        .filter(|value| referenced.insert(key(value)))
        .collect()
}

pub fn update_masks<T: Clone>(
    previous: &[MaskEntry<T>],
    requests: &[MaskRequest],
    mut compute: impl FnMut(&MaskRequest) -> Option<T>,
) -> Vec<MaskEntry<T>> {
    let plan = plan_masks(previous, requests);
    requests
        .iter()
        .zip(plan)
        .map(|(request, reuse)| MaskEntry {
            request: request.clone(),
            value: match reuse {
                Some(index) => previous[index].value.clone(),
                None => compute(request),
            },
        })
        .collect()
}

pub fn mask_region(
    mask: [f64; 4],
    content: [f64; 4],
    frame: (u32, u32),
) -> Option<(u32, u32, u32, u32)> {
    let [x, y, width, height] = mask;
    let [content_x, content_y, content_width, content_height] = content;
    let left = content_x.max(x.min(x + width));
    let top = content_y.max(y.min(y + height));
    let right = (content_x + content_width).min(x.max(x + width));
    let bottom = (content_y + content_height).min(y.max(y + height));
    if right <= left || bottom <= top {
        return None;
    }
    let x0 = (left.round().max(0.) as u32).min(frame.0);
    let y0 = (top.round().max(0.) as u32).min(frame.1);
    let x1 = (right.round().max(0.) as u32).min(frame.0);
    let y1 = (bottom.round().max(0.) as u32).min(frame.1);
    (x1 > x0 && y1 > y0).then(|| (x0, y0, x1 - x0, y1 - y0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn requests(count: usize) -> Vec<MaskRequest> {
        (0..count)
            .map(|index| MaskRequest {
                id: index.to_string(),
                frame: MaskFrame {
                    revision: 1,
                    size: (64, 48),
                    content: [0., 0., 64., 48.].map(f64::to_bits),
                    padding: 0_f64.to_bits(),
                    crop: None,
                },
                region: (index as u32 * 4, 4, 32, 24),
                pixelate: false,
                level: 16_f64.to_bits(),
            })
            .collect()
    }

    fn cached(requests: &[MaskRequest]) -> Vec<MaskEntry<Arc<String>>> {
        update_masks(&[], requests, |request| Some(Arc::new(request.id.clone())))
    }

    #[test]
    fn mask_build_keeps_moves_styles_additions_and_reorders() {
        let original = requests(3);
        for change in 0..5 {
            let mut next = original.clone();
            match change {
                0 => next[0].region.0 += 1,
                1 => next[0].level = 20_f64.to_bits(),
                2 => next[0].pixelate = true,
                3 => next.push(requests(4).pop().unwrap()),
                _ => next.reverse(),
            }
            assert!(!should_cancel_mask_build(&original, &next));
        }
        assert!(!should_cancel_mask_build(&original, &original));
    }

    #[test]
    fn mask_build_cancels_removals_even_when_another_mask_is_added() {
        let original = requests(3);
        assert!(should_cancel_mask_build(&original, &[]));
        assert!(should_cancel_mask_build(&original, &original[1..]));
        let mut next = original[1..].to_vec();
        next.push(requests(4).pop().unwrap());
        assert!(should_cancel_mask_build(&original, &next));
    }

    #[test]
    fn mask_build_cancels_frame_and_layout_changes() {
        let original = requests(2);
        for change in 0..5 {
            let mut next = original.clone();
            for request in &mut next {
                match change {
                    0 => request.frame.revision += 1,
                    1 => request.frame.size.0 += 1,
                    2 => request.frame.content[0] = 0.25_f64.to_bits(),
                    3 => request.frame.padding = 8_f64.to_bits(),
                    _ => request.frame.crop = Some([0, 0, 32, 24]),
                }
            }
            assert!(should_cancel_mask_build(&original, &next));
        }
    }

    #[test]
    fn mask_build_cancels_ambiguous_duplicate_changes_and_removals() {
        let mut original = requests(2);
        original[1].id = original[0].id.clone();
        let mut next = original.clone();
        next.reverse();
        assert!(!should_cancel_mask_build(&original, &next));
        next[0].region.0 += 1;
        assert!(should_cancel_mask_build(&original, &next));
        assert!(should_cancel_mask_build(&original, &original[..1]));
        next[0] = requests(3).pop().unwrap();
        assert!(should_cancel_mask_build(&original, &next));
        let identical = vec![original[0].clone(); 2];
        assert!(!should_cancel_mask_build(&identical, &identical));
        assert!(should_cancel_mask_build(&identical, &identical[..1]));
    }

    #[test]
    fn mask_build_checks_removal_against_the_latest_coalesced_request() {
        let initial = requests(1);
        let added = requests(2);
        assert!(!should_cancel_mask_build(&initial, &added));
        assert!(should_cancel_mask_build(&added, &initial));
        assert!(!should_cancel_mask_build(&initial, &added));
    }

    #[test]
    fn mask_build_cancels_inconsistent_frames_and_empty_builds() {
        let original = requests(2);
        let mut inconsistent = original.clone();
        inconsistent[1].frame.revision += 1;
        assert!(should_cancel_mask_build(&original, &inconsistent));
        assert!(should_cancel_mask_build(&inconsistent, &original));
        assert!(should_cancel_mask_build(&[], &original));
    }

    #[test]
    fn completed_mask_build_matches_current_duplicates_before_retiring_images() {
        let mut requests = requests(2);
        requests[1].id = requests[0].id.clone();
        let snapshot = cached(&requests);
        let mut current = cached(&requests);
        current.reverse();
        let mut built_requests = requests.clone();
        built_requests[0].region.0 += 1;
        let completed = update_masks(&snapshot, &built_requests, |request| {
            Some(Arc::new(request.id.clone()))
        });
        let changed = completed[0].value.clone().unwrap();
        let installed = finish_mask_build(&current, completed);
        assert!(Arc::ptr_eq(installed[0].value.as_ref().unwrap(), &changed));
        assert!(Arc::ptr_eq(
            installed[1].value.as_ref().unwrap(),
            current[0].value.as_ref().unwrap()
        ));
        let retired = retired_mask_values(&current, &installed, Arc::as_ptr);
        assert_eq!(retired.len(), 1);
        assert!(Arc::ptr_eq(retired[0], current[1].value.as_ref().unwrap()));
    }

    #[test]
    fn completed_mask_build_does_not_retire_shared_current_images() {
        let requests = requests(2);
        let image = Arc::new("shared".to_string());
        let current = update_masks(&[], &requests, |_| Some(image.clone()));
        let mut built_requests = requests.clone();
        built_requests[0].region.0 += 1;
        let installed = finish_mask_build(&current, cached(&built_requests));
        assert!(retired_mask_values(&current, &installed, Arc::as_ptr).is_empty());
        assert!(Arc::ptr_eq(installed[1].value.as_ref().unwrap(), &image));
    }

    #[test]
    fn moving_one_mask_reuses_the_other_images() {
        let mut requests = requests(4);
        let previous = cached(&requests);
        requests[1].region.0 += 1;
        assert_eq!(
            plan_masks(&previous, &requests),
            vec![Some(0), None, Some(2), Some(3)]
        );
        let mut calls = 0;
        let next = update_masks(&previous, &requests, |request| {
            calls += 1;
            Some(Arc::new(request.id.clone()))
        });
        assert_eq!(calls, 1);
        for index in [0, 2, 3] {
            assert!(Arc::ptr_eq(
                previous[index].value.as_ref().unwrap(),
                next[index].value.as_ref().unwrap()
            ));
        }
    }

    #[test]
    fn deleting_and_reordering_evicts_only_the_deleted_mask() {
        let mut requests = requests(4);
        let previous = cached(&requests);
        requests.remove(1);
        requests.reverse();
        assert_eq!(
            plan_masks(&previous, &requests),
            vec![Some(3), Some(2), Some(0)]
        );
        let next = update_masks(&previous, &requests, |_| panic!("unexpected filter"));
        assert_eq!(
            next.iter()
                .map(|entry| entry.request.id.as_str())
                .collect::<Vec<_>>(),
            ["3", "2", "0"]
        );
        assert_eq!(retired_mask_values(&next, &[], Arc::as_ptr).len(), 3);
    }

    #[test]
    fn new_and_changed_styles_are_computed() {
        let mut requests = requests(4);
        let previous = cached(&requests[..3]);
        requests[0].pixelate = true;
        requests[1].level = 20_f64.to_bits();
        assert_eq!(
            plan_masks(&previous, &requests),
            vec![None, None, Some(2), None]
        );
    }

    #[test]
    fn frame_and_layout_changes_invalidate_every_mask() {
        let original = requests(4);
        let previous = cached(&original);
        for change in 0..5 {
            let mut requests = original.clone();
            for request in &mut requests {
                match change {
                    0 => request.frame.revision += 1,
                    1 => request.frame.size.0 += 1,
                    2 => request.frame.content[0] = 0.25_f64.to_bits(),
                    3 => request.frame.padding = 1_f64.to_bits(),
                    _ => request.frame.crop = Some([1, 0, 64, 48]),
                }
            }
            assert_eq!(plan_masks(&previous, &requests), vec![None; 4]);
        }
    }

    #[test]
    fn identical_requests_reuse_even_a_failed_filter() {
        let requests = requests(4);
        let previous = update_masks::<Arc<String>>(&[], &requests, |_| None);
        let next = update_masks(&previous, &requests, |_| panic!("unexpected filter"));
        assert!(next.iter().all(|entry| entry.value.is_none()));
        assert!(retired_mask_values(&previous, &next, Arc::as_ptr).is_empty());
    }

    #[test]
    fn duplicate_ids_reserve_exact_matches_before_retaining_changed_masks() {
        let mut requests = requests(3);
        requests[1].id = requests[0].id.clone();
        let previous = cached(&requests);
        requests.swap(0, 1);
        requests[0].region.0 += 1;
        requests.pop();
        let retained = retain_masks(&previous, &requests);
        assert_eq!(retained[0].request, previous[1].request);
        assert_eq!(retained[1].request, previous[0].request);
        let retired = retired_mask_values(&previous, &retained, Arc::as_ptr);
        assert_eq!(retired.len(), 1);
        assert!(Arc::ptr_eq(retired[0], previous[2].value.as_ref().unwrap()));
    }

    #[test]
    fn identical_duplicate_requests_use_each_previous_entry_once() {
        let request = requests(1).remove(0);
        let requests = vec![request; 3];
        let previous = cached(&requests[..2]);
        assert_eq!(plan_masks(&previous, &requests), [Some(0), Some(1), None]);
        assert_eq!(retain_masks(&previous, &requests).len(), 2);
    }

    #[test]
    fn retirement_preserves_shared_images_and_retires_them_only_once() {
        let requests = requests(2);
        let image = Arc::new("shared".to_string());
        let previous = update_masks(&[], &requests, |_| Some(image.clone()));
        assert!(retired_mask_values(&previous, &previous[1..], Arc::as_ptr).is_empty());
        let retired = retired_mask_values(&previous, &[], Arc::as_ptr);
        assert_eq!(retired.len(), 1);
        assert!(Arc::ptr_eq(retired[0], &image));
    }

    #[test]
    fn regions_round_after_clipping_and_normalize_negative_sizes() {
        let content = [10.25, 8.75, 40.5, 30.5];
        assert_eq!(
            mask_region([-2.4, 1.2, 80., 60.], content, (48, 36)),
            Some((10, 9, 38, 27))
        );
        assert_eq!(
            mask_region([40.4, 30.4, -20.2, -10.2], content, (64, 48)),
            Some((20, 20, 20, 10))
        );
        assert_eq!(mask_region([10.1, 10.1, 0.2, 0.2], content, (64, 48)), None);
        assert_eq!(mask_region([60., 10., 10., 10.], content, (64, 48)), None);
        assert_eq!(mask_region([0., 0., 20., 20.], content, (0, 0)), None);
    }

    #[test]
    fn fractional_moves_with_the_same_filtered_pixels_reuse() {
        let mut requests = requests(1);
        let content = [0., 0., 64., 48.];
        requests[0].region = mask_region([0.1, 4.1, 32., 24.], content, (64, 48)).unwrap();
        let previous = cached(&requests);
        requests[0].region = mask_region([0.2, 4.2, 32., 24.], content, (64, 48)).unwrap();
        assert_eq!(plan_masks(&previous, &requests), [Some(0)]);
        requests[0].region = mask_region([0.6, 4.2, 32., 24.], content, (64, 48)).unwrap();
        assert_eq!(plan_masks(&previous, &requests), [None]);
    }

    #[test]
    fn overlapping_masks_always_sample_the_unmodified_frame() {
        let rgba: Vec<u8> = (0..64 * 48 * 4).map(|i| (i * 37 % 251) as u8).collect();
        let mut requests = requests(4);
        requests[1].pixelate = true;
        let previous = update_masks(&[], &requests, |request| {
            request.filter(&rgba).map(Arc::new)
        });
        requests[1].region.0 += 1;
        requests.reverse();
        let mut calls = 0;
        let next = update_masks(&previous, &requests, |request| {
            calls += 1;
            request.filter(&rgba).map(Arc::new)
        });
        assert_eq!(calls, 1);
        for entry in next {
            let expected = mask_filter(
                &rgba,
                64,
                48,
                entry.request.region,
                entry.request.pixelate,
                16.,
            )
            .unwrap();
            assert_eq!(entry.value.unwrap().as_ref(), &expected);
        }
    }

    #[test]
    fn invalid_buffers_do_not_produce_images() {
        let request = requests(1).remove(0);
        assert!(request.filter(&[0; 16]).is_none());
    }
}
