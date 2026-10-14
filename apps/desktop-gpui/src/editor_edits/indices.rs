pub(super) fn descending_indices(indices: &[usize], length: usize) -> Vec<usize> {
    let mut sorted: Vec<usize> = indices
        .iter()
        .copied()
        .filter(|index| *index < length)
        .collect();
    sorted.sort_unstable();
    sorted.dedup();
    sorted.reverse();
    sorted
}

pub(super) fn delete_indices<T>(segments: &mut Vec<T>, indices: &[usize]) -> bool {
    let sorted = descending_indices(indices, segments.len());
    if sorted.is_empty() {
        return false;
    }
    if sorted.len() == 1 {
        segments.remove(sorted[0]);
        return true;
    }
    let remaining = segments.len() - sorted.len();
    if sorted[0] == segments.len() - 1 && sorted[sorted.len() - 1] == remaining {
        segments.truncate(remaining);
        return true;
    }

    let first = sorted[sorted.len() - 1];
    let last = sorted[0];
    let mut sorted = sorted.into_iter().rev();
    let mut next = sorted.next();
    let mut index = first;
    segments
        .extract_if(first..=last, |_| {
            let delete = next == Some(index);
            if delete {
                next = sorted.next();
            }
            index += 1;
            delete
        })
        .for_each(drop);
    true
}
