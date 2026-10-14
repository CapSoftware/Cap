#[path = "../src/editor_edits/indices.rs"]
mod indices;

use indices::{delete_indices, descending_indices};
use std::{cell::RefCell, rc::Rc};

#[test]
fn selections_preserve_survivors_and_report_changes() {
    for length in 0..=8 {
        for mask in 0..(1 << length) {
            let source: Vec<usize> = (0..length).collect();
            let selected: Vec<usize> = (0..length)
                .rev()
                .filter(|index| mask & (1 << index) != 0)
                .collect();
            let expected: Vec<usize> = source
                .iter()
                .copied()
                .filter(|index| !selected.contains(index))
                .collect();
            let indices: Vec<usize> = selected
                .iter()
                .copied()
                .chain(selected.iter().copied())
                .chain([length, usize::MAX])
                .collect();
            let mut actual = source;
            assert_eq!(delete_indices(&mut actual, &indices), !selected.is_empty());
            assert_eq!(actual, expected);
        }
    }
}

#[test]
fn empty_and_invalid_selections_leave_values_untouched() {
    let mut values = vec![String::from("first"), String::from("last")];
    let expected = values.clone();
    assert!(!delete_indices(&mut values, &[]));
    assert!(!delete_indices(&mut values, &[2, 3, usize::MAX]));
    assert_eq!(values, expected);
}

#[test]
fn deletion_preserves_vector_capacity() {
    let mut values = Vec::with_capacity(32);
    values.extend(0..8);
    let capacity = values.capacity();
    assert!(delete_indices(&mut values, &[2, 5]));
    assert_eq!(values.capacity(), capacity);
    assert!(delete_indices(&mut values, &[4, 5]));
    assert_eq!(values.capacity(), capacity);
}

#[test]
fn non_copy_values_are_dropped_exactly_once() {
    struct Tracked {
        index: usize,
        drops: Rc<RefCell<Vec<usize>>>,
    }

    impl Drop for Tracked {
        fn drop(&mut self) {
            self.drops.borrow_mut()[self.index] += 1;
        }
    }

    for indices in [
        &[4, 1, 4, usize::MAX][..],
        &[1, 3][..],
        &[2, 2][..],
        &[0, 1, 2, 3, 4][..],
    ] {
        let drops = Rc::new(RefCell::new(vec![0; 5]));
        let mut values: Vec<Tracked> = (0..5)
            .map(|index| Tracked {
                index,
                drops: drops.clone(),
            })
            .collect();
        assert!(delete_indices(&mut values, indices));
        assert_eq!(
            *drops.borrow(),
            (0..5)
                .map(|index| usize::from(indices.contains(&index)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            values.iter().map(|value| value.index).collect::<Vec<_>>(),
            (0..5)
                .filter(|index| !indices.contains(index))
                .collect::<Vec<_>>()
        );
        drop(values);
        assert_eq!(*drops.borrow(), vec![1; 5]);
    }
}

#[test]
fn clip_indices_remain_descending_unique_and_in_bounds() {
    assert_eq!(descending_indices(&[1, 4, 0, 4, 99], 5), vec![4, 1, 0]);
    assert!(descending_indices(&[0, usize::MAX], 0).is_empty());
}
