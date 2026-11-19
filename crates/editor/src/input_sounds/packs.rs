use super::{Pack, Stroke};

pub(super) const MECHANICAL: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/mechanical.opus"),
    frames: 273264,
    strokes: [
        &[
            Stroke {
                down: (960, 3888),
                up: Some((5808, 4848)),
            },
            Stroke {
                down: (11616, 3600),
                up: Some((16176, 4464)),
            },
            Stroke {
                down: (21600, 3264),
                up: Some((25824, 4368)),
            },
            Stroke {
                down: (31152, 3216),
                up: Some((35328, 5472)),
            },
            Stroke {
                down: (41760, 3552),
                up: Some((46272, 5376)),
            },
            Stroke {
                down: (52608, 3312),
                up: Some((56880, 5232)),
            },
            Stroke {
                down: (63072, 3600),
                up: Some((67632, 4272)),
            },
            Stroke {
                down: (72864, 3456),
                up: Some((77280, 5424)),
            },
            Stroke {
                down: (83664, 3264),
                up: Some((87888, 3600)),
            },
            Stroke {
                down: (92448, 3648),
                up: Some((97056, 4416)),
            },
            Stroke {
                down: (102432, 3360),
                up: Some((106752, 4608)),
            },
            Stroke {
                down: (112320, 3552),
                up: Some((116832, 4896)),
            },
            Stroke {
                down: (122688, 3936),
                up: Some((127584, 5088)),
            },
            Stroke {
                down: (133632, 3216),
                up: Some((137808, 4320)),
            },
            Stroke {
                down: (143088, 3504),
                up: Some((147552, 3840)),
            },
            Stroke {
                down: (152352, 3504),
                up: Some((156816, 4944)),
            },
            Stroke {
                down: (162720, 2928),
                up: Some((166608, 3888)),
            },
            Stroke {
                down: (171456, 2736),
                up: Some((175152, 5376)),
            },
        ],
        &[
            Stroke {
                down: (181488, 3552),
                up: Some((186000, 7968)),
            },
            Stroke {
                down: (194928, 4320),
                up: Some((200208, 8112)),
            },
        ],
        &[
            Stroke {
                down: (209280, 4128),
                up: Some((214368, 5040)),
            },
            Stroke {
                down: (220368, 3648),
                up: Some((224976, 5472)),
            },
        ],
        &[
            Stroke {
                down: (231408, 3312),
                up: Some((235680, 5568)),
            },
            Stroke {
                down: (242208, 4320),
                up: Some((247488, 4848)),
            },
        ],
        &[
            Stroke {
                down: (253296, 3216),
                up: Some((257472, 4992)),
            },
            Stroke {
                down: (263424, 2976),
                up: Some((267360, 3984)),
            },
        ],
        &[],
    ],
};

pub(super) const DEEP: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/deep.opus"),
    frames: 92832,
    strokes: [
        &[
            Stroke {
                down: (960, 5856),
                up: None,
            },
            Stroke {
                down: (7776, 5712),
                up: None,
            },
            Stroke {
                down: (14448, 5520),
                up: None,
            },
            Stroke {
                down: (20928, 5856),
                up: None,
            },
            Stroke {
                down: (27744, 4368),
                up: None,
            },
            Stroke {
                down: (33072, 5184),
                up: None,
            },
            Stroke {
                down: (39216, 6720),
                up: None,
            },
        ],
        &[
            Stroke {
                down: (46896, 4800),
                up: None,
            },
            Stroke {
                down: (52656, 2256),
                up: None,
            },
        ],
        &[
            Stroke {
                down: (55872, 5616),
                up: None,
            },
            Stroke {
                down: (62448, 5472),
                up: None,
            },
        ],
        &[
            Stroke {
                down: (68880, 5616),
                up: None,
            },
            Stroke {
                down: (75456, 5472),
                up: None,
            },
        ],
        &[
            Stroke {
                down: (81888, 4368),
                up: None,
            },
            Stroke {
                down: (87216, 3696),
                up: None,
            },
        ],
        &[],
    ],
};

pub(super) const LAPTOP: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/laptop.opus"),
    frames: 177504,
    strokes: [
        &[
            Stroke {
                down: (960, 3312),
                up: Some((5232, 10848)),
            },
            Stroke {
                down: (17040, 2448),
                up: Some((20448, 11472)),
            },
            Stroke {
                down: (32880, 2016),
                up: Some((35856, 7728)),
            },
            Stroke {
                down: (44544, 2928),
                up: Some((48432, 9648)),
            },
            Stroke {
                down: (59040, 3600),
                up: Some((63600, 7152)),
            },
        ],
        &[
            Stroke {
                down: (71712, 3024),
                up: Some((75696, 12720)),
            },
            Stroke {
                down: (89376, 2784),
                up: Some((93120, 11664)),
            },
        ],
        &[
            Stroke {
                down: (105744, 2976),
                up: Some((109680, 10224)),
            },
            Stroke {
                down: (120864, 1968),
                up: Some((123792, 10176)),
            },
        ],
        &[
            Stroke {
                down: (134928, 3216),
                up: Some((139104, 7824)),
            },
            Stroke {
                down: (147888, 3696),
                up: Some((152544, 10464)),
            },
        ],
        &[Stroke {
            down: (163968, 2928),
            up: Some((167856, 7728)),
        }],
        &[],
    ],
};

pub(super) const TYPEWRITER: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/typewriter.opus"),
    frames: 199872,
    strokes: [
        &[
            Stroke {
                down: (960, 8640),
                up: Some((10560, 10560)),
            },
            Stroke {
                down: (22080, 7056),
                up: Some((30096, 13920)),
            },
            Stroke {
                down: (44976, 8112),
                up: Some((54048, 10896)),
            },
            Stroke {
                down: (65904, 7440),
                up: Some((74304, 12048)),
            },
        ],
        &[Stroke {
            down: (87312, 2352),
            up: Some((90624, 18912)),
        }],
        &[Stroke {
            down: (110496, 35472),
            up: Some((146928, 26784)),
        }],
        &[Stroke {
            down: (174672, 8112),
            up: Some((183744, 14208)),
        }],
        &[],
        &[],
    ],
};

pub(super) const MOUSE: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/mouse.opus"),
    frames: 65520,
    strokes: [
        &[],
        &[],
        &[],
        &[],
        &[],
        &[
            Stroke {
                down: (960, 2064),
                up: Some((3984, 1008)),
            },
            Stroke {
                down: (5952, 1056),
                up: Some((7968, 1920)),
            },
            Stroke {
                down: (10848, 1152),
                up: Some((12960, 480)),
            },
            Stroke {
                down: (14400, 2064),
                up: Some((17424, 816)),
            },
            Stroke {
                down: (19200, 2112),
                up: Some((22272, 1152)),
            },
            Stroke {
                down: (24384, 2112),
                up: Some((27456, 864)),
            },
            Stroke {
                down: (29280, 1968),
                up: Some((32208, 2016)),
            },
            Stroke {
                down: (35184, 816),
                up: Some((36960, 1728)),
            },
            Stroke {
                down: (39648, 2064),
                up: Some((42672, 576)),
            },
            Stroke {
                down: (44208, 2064),
                up: Some((47232, 480)),
            },
            Stroke {
                down: (48672, 1920),
                up: Some((51552, 816)),
            },
            Stroke {
                down: (53328, 1680),
                up: Some((55968, 864)),
            },
            Stroke {
                down: (57792, 528),
                up: Some((59280, 1008)),
            },
            Stroke {
                down: (61248, 864),
                up: Some((63072, 528)),
            },
        ],
    ],
};

pub(super) const TRACKPAD: Pack = Pack {
    bytes: include_bytes!("../../assets/input-sounds/trackpad.opus"),
    frames: 100224,
    strokes: [
        &[],
        &[],
        &[],
        &[],
        &[],
        &[
            Stroke {
                down: (960, 1344),
                up: Some((3264, 4272)),
            },
            Stroke {
                down: (8496, 2208),
                up: Some((11664, 1920)),
            },
            Stroke {
                down: (14544, 2304),
                up: Some((17808, 2208)),
            },
            Stroke {
                down: (20976, 1440),
                up: Some((23376, 2208)),
            },
            Stroke {
                down: (26544, 1440),
                up: Some((28944, 2304)),
            },
            Stroke {
                down: (32208, 1824),
                up: Some((34992, 1920)),
            },
            Stroke {
                down: (37872, 1296),
                up: Some((40128, 2352)),
            },
            Stroke {
                down: (43440, 1248),
                up: Some((45648, 3696)),
            },
            Stroke {
                down: (50304, 1440),
                up: Some((52704, 2304)),
            },
            Stroke {
                down: (55968, 1296),
                up: Some((58224, 2352)),
            },
            Stroke {
                down: (61536, 2352),
                up: Some((64848, 1824)),
            },
            Stroke {
                down: (67632, 1344),
                up: Some((69936, 2880)),
            },
            Stroke {
                down: (73776, 2208),
                up: Some((76944, 1920)),
            },
            Stroke {
                down: (79824, 2160),
                up: Some((82944, 2112)),
            },
            Stroke {
                down: (86016, 2784),
                up: Some((89760, 2208)),
            },
            Stroke {
                down: (92928, 1344),
                up: Some((95232, 3072)),
            },
        ],
    ],
};
