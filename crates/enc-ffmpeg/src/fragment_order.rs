use std::{
    cmp::Ordering,
    path::{Path, PathBuf},
};

pub fn fragment_index(path: &Path) -> Option<u64> {
    let (_, digits) = path.file_stem()?.to_str()?.rsplit_once('_')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Fragment names are written with a three-digit minimum width, so past 999
/// fragments a name sort puts `segment_1000` before `segment_101` (#3961).
/// Numbered fragments come first by index; anything else follows by name.
pub fn compare_fragment_paths(left: &Path, right: &Path) -> Ordering {
    match (fragment_index(left), fragment_index(right)) {
        (Some(left_index), Some(right_index)) => {
            left_index.cmp(&right_index).then_with(|| left.cmp(right))
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => left.cmp(right),
    }
}

pub fn sort_fragment_paths(paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| compare_fragment_paths(left, right));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shuffled(mut names: Vec<String>) -> Vec<PathBuf> {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        for index in (1..names.len()).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            names.swap(index, (state % (index as u64 + 1)) as usize);
        }
        names
            .into_iter()
            .map(|name| Path::new("display").join(name))
            .collect()
    }

    #[test]
    fn orders_more_than_999_fragments_numerically() {
        let expected = (1..=1356)
            .map(|index| format!("segment_{index:03}.m4s"))
            .collect::<Vec<_>>();
        let mut paths = shuffled(expected.clone());
        sort_fragment_paths(&mut paths);
        let names = paths
            .iter()
            .map(|path| path.file_name().unwrap().to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
        assert_eq!(names[998], "segment_999.m4s");
        assert_eq!(names[999], "segment_1000.m4s");
    }

    #[test]
    fn orders_legacy_fragment_names_numerically() {
        let expected = (0..1200)
            .map(|index| format!("fragment_{index:03}.mp4"))
            .collect::<Vec<_>>();
        let mut paths = shuffled(expected.clone());
        sort_fragment_paths(&mut paths);
        assert_eq!(
            paths
                .iter()
                .map(|path| path.file_name().unwrap().to_str().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn unnumbered_names_follow_numbered_fragments_in_name_order() {
        let mut paths = [
            "segment_x.m4s",
            "segment_1000.m4s",
            "segment.m4s",
            "segment_-1.m4s",
            "segment_+2.m4s",
            "segment_002.m4s",
            "segment_.m4s",
            "segment_99999999999999999999999.m4s",
        ]
        .map(PathBuf::from);
        sort_fragment_paths(&mut paths);
        assert_eq!(
            paths.map(|path| path.to_str().unwrap().to_owned()),
            [
                "segment_002.m4s",
                "segment_1000.m4s",
                "segment.m4s",
                "segment_+2.m4s",
                "segment_-1.m4s",
                "segment_.m4s",
                "segment_99999999999999999999999.m4s",
                "segment_x.m4s",
            ]
        );
    }

    #[test]
    fn parses_index_from_the_last_underscore() {
        assert_eq!(fragment_index(Path::new("a_b/segment_0042.m4s")), Some(42));
        assert_eq!(fragment_index(Path::new("my_clip_7.m4a")), Some(7));
        assert_eq!(fragment_index(Path::new("segment_12.m4s.tmp")), None);
        assert_eq!(fragment_index(Path::new("init.mp4")), None);
    }
}
