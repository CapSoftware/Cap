//! Cap Cursor Info: A crate for getting cursor information, assets and hotspot information.

/// Information about a resolved cursor shape
#[derive(Debug, Clone)]
pub struct ResolvedCursor {
    /// Raw svg definition of the cursor asset
    pub raw: &'static str,
    /// The location of the hotspot within the cursor asset
    pub hotspot: (f64, f64),
}

impl ResolvedCursor {
    /// Resolve the SVG asset from a given cursor hash
    ///
    /// We hash the cursor's image on macOS as `NSCursor`'s can't be reliably compared.
    /// On Windows we technically don't need to but storing a hash is useful as it means we can modify the cursors,
    /// interpretation without rerecording if we were to support custom cursors or add new OS cursors.
    pub fn from_hash(s: String) -> Option<ResolvedCursor> {
        Some(match s.as_str() {
            //
            // macOS Cursors
            // https://developer.apple.com/documentation/appkit/nscursor
            //

            //  https://developer.apple.com/documentation/appkit/nscursor/arrow
            "de2d1f4a81e520b65fd1317b845b00a1c51a4d1f71cca3cd4ccdab52b98d1ac9" => ResolvedCursor {
                raw: include_str!("../assets/mac/arrow.svg"),
                hotspot: (0.347, 0.33),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/contextualmenu
            "ab26ca862492d41355b711c58544687a799dd7ae14cf161959ca524bbc97c322" => ResolvedCursor {
                raw: include_str!("../assets/mac/contextual_menu.svg"),
                hotspot: (0.278, 0.295),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/closedhand
            "fbb165d4603dd8808b536f45bb74a9a72d9358ad19714b318bb7c06358a7d3c2" => ResolvedCursor {
                raw: include_str!("../assets/mac/closed_hand.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/crosshair
            "c583f776531f4e7b76ea7ba2ab159765e2da11fd63cb897cc10362183859d1d8" => ResolvedCursor {
                raw: include_str!("../assets/mac/crosshair.svg"),
                hotspot: (0.52, 0.51),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/disappearingitem
            "67c369820fbc37af9b59b840c675ca24117ca8dfdccec7702b10894058617951" => return None,
            // https://developer.apple.com/documentation/appkit/nscursor/dragcopy
            "af060876004c8647d82411eeac1bbd613d2991d46794aba16b56c91d3081e128" => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_copy.svg"),
                hotspot: (0.255, 0.1),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/draglink
            "59ac2483461f4ad577a0a6b68be89fe663c36263b583c5f038eee2ae6a5ad98f" => ResolvedCursor {
                raw: include_str!("../assets/mac/drag_link.svg"),
                hotspot: (0.621, 0.309),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/ibeam
            "492dca0bb6751a30607ac728803af992ba69365052b7df2dff1c0dfe463e653c" => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam.svg"),
                hotspot: (0.525, 0.52),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/openhand
            "3f6a5594a3c9334065944b9c56d9f73fd5fe5f02108a5e28f37e222e770be476" => ResolvedCursor {
                raw: include_str!("../assets/mac/open_hand.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/operationnotallowed
            "37287ef1d097704d3e9d0be9c1049ce1fb6dfabd6d210af0429b1b6ec7084c59" => ResolvedCursor {
                raw: include_str!("../assets/mac/operation_not_allowed.svg"),
                hotspot: (0.24, 0.1),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/pointinghand
            "b0443e9f72e724cb6d94b879bf29c6cb18376d0357c6233e5a7561cf8a9943c6" => ResolvedCursor {
                raw: include_str!("../assets/mac/pointing_hand.svg"),
                hotspot: (0.406, 0.25),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizedown
            "3c9bf0ce893b64fe9e4363793b406140d4b3900b7beafa1c409e78cf5a8cf954" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_down.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeleft
            "50431d8fd537119aefb4c3673f9b9ff00d3cd1d2bf6c35e5dfb09ed40cfd5e7c" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeleftright
            "0fdaea89910bcbe34ad0d4d63a6ada2095489df18537bbf54dd0d0769588b381" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_left_right.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeright
            "e74de88f863f059e5beb27152b2dfc2cd1e8dcc458ce775607765e9a4859667e" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_right.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeup
            "912ca42451a9624f6fb8c1d53c29c26782b7590d383a66075a6768c4409024d9" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/resizeupdown
            "9c93eb53df68d7fd86298ba1eb3e3b32ccd34d168b81a31a6fc4bb79f131331f" => ResolvedCursor {
                raw: include_str!("../assets/mac/resize_up_down.svg"),
                hotspot: (0.5, 0.5),
            },
            // https://developer.apple.com/documentation/appkit/nscursor/ibeamcursorforverticallayout
            "024e1d486a7f16368669d419e69c9a326e464ec1b8ed39645e5c89cb183e03c5" => ResolvedCursor {
                raw: include_str!("../assets/mac/ibeam_vertical.svg"),
                hotspot: (0.51, 0.49),
            },

            //
            // Windows Cursors
            // https://learn.microsoft.com/en-us/windows/win32/menurc/about-cursors
            //

            // IDC_ARROW
            "19502718917bb8a86b83ffb168021cf90517b5c5e510c33423060d230c9e2d20" => ResolvedCursor {
                raw: include_str!("../assets/windows/arrow.svg"),
                hotspot: (0.055, 0.085),
            },
            // IDC_IBEAM
            "77cc4cedcf68f3e1d41bfe16c567961b2306c6236b35b966cd3d5c9516565e33" => ResolvedCursor {
                raw: include_str!("../assets/windows/ibeam.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_WAIT
            "5991d86a0d4e915dd0cb0fdd9bef3bf37ed6a3b321256fcb5b240db7ac1a6324" => ResolvedCursor {
                raw: include_str!("../assets/windows/wait.svg"),
                hotspot: (0.5, 0.52),
            },
            // IDC_CROSS
            "cd2c775b1a124e4deaed1ed345efae25eb28a9133fc39691555902a2c1d7d578" => ResolvedCursor {
                raw: include_str!("../assets/windows/cross.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_UPARROW
            "823d642acdc51ffbc29c2710303606270ed24936daf45215ead531333df102ba" => ResolvedCursor {
                raw: include_str!("../assets/windows/uparrow.svg"),
                hotspot: (0.5, 0.05),
            },
            // IDC_SIZENWSE
            "2daf2a40e4c7ecadec3270fbdb243a12ac22a14bb0b3a08a56b38a38322f9296" => ResolvedCursor {
                raw: include_str!("../assets/windows/idcsizenwse.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_SIZENESW
            "47b4d609cb404feae70c7e20b525ac901d1e7a5f1a2e8a240418b3710ee43473" => ResolvedCursor {
                raw: include_str!("../assets/windows/size-nesw.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_SIZEWE
            "8a024cf4bec4d58a4c149af2320206088981357312b3d82fbfcc07bee38c71ac" => ResolvedCursor {
                raw: include_str!("../assets/windows/idcsizewe.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_SIZENS
            "253b9e5360de1e12561be6a8f84484d4b108fd54d31e7d2c8f3b66d1c71b9880" => ResolvedCursor {
                raw: include_str!("../assets/windows/size-ns.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_SIZEALL
            "8066a12792e4e8ef21636e5ade61adaaf0fecc2ffc69536ffa0c2dd5bedc6903" => ResolvedCursor {
                raw: include_str!("../assets/windows/sizeall.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_NO
            "7df883a459aced72acf32b969ff1119676d334d9acfcbe668ef92fe01094a7d6" => ResolvedCursor {
                raw: include_str!("../assets/windows/no.svg"),
                hotspot: (0.5, 0.5),
            },
            // IDC_HAND
            "44a554b439a681410d337d239bf08afe7c66486538563ebb93dc1c309f0a9209" => ResolvedCursor {
                raw: include_str!("../assets/windows/hand.svg"),
                hotspot: (0.42, 0.0),
            },
            // IDC_APPSTARTING
            "1486a2339478da61a52a6eecf8ee3446be62f12d375dba8befd42bb553eea7bf" => ResolvedCursor {
                raw: include_str!("../assets/windows/appstarting.svg"),
                hotspot: (0.055, 0.368),
            },
            // IDC_HELP
            "5d0b4df6188bc8d540abfbd4235199cc0f67fb41d5e0dcbfd40a3011f8808fea" => ResolvedCursor {
                raw: include_str!("../assets/windows/idchelp.svg"),
                hotspot: (0.056, 0.127),
            },
            // IDC_PIN
            "cb74a2d34774dbc43004882e43f9c058b2d2ee60184185567d0328ca013f5bc3" => ResolvedCursor {
                raw: include_str!("../assets/windows/idcpin.svg"),
                hotspot: (0.245, 0.05),
            },
            // IDC_PERSON
            "1f5209791a75916697c26cf2d018d267ae1102c71dbd196de6c83132f5627f09" => ResolvedCursor {
                raw: include_str!("../assets/windows/idcperson.svg"),
                hotspot: (0.235, 0.05),
            },
            // MAKEINTRESOURCE(32631) - Pen
            "7340ea75802db8fef3a103e9385e65b2c8c358e077ef949faaf572fb502dd9e2" => ResolvedCursor {
                raw: include_str!("../assets/windows/pen.svg"),
                hotspot: (0.055, 0.945),
            },
            // // MAKEINTRESOURCE(32652) - ScrolNS
            // "4c89e1d64c35cc88d09aaddcc78ab685ceab8d974006d3d94af23a9e888a74d7" => todo!(),
            // // MAKEINTRESOURCE(32653) - ScrollWE
            // "c5b16cfc625082dfdaa8e43111909baf9201fca39433ee8cdd117221f66cb4d1" => todo!(),
            // // MAKEINTRESOURCE(32654) - ScrollNSEW
            // "65527a0605a3bf225f90b9fe5b27b1c70743f4fa017b780abe27d5910cfdf69d" => todo!(),
            // // MAKEINTRESOURCE(32655) - ScrollN
            // "fe1b1ac207a874a452b4dd28949008282e6038c3ca903aba5da151d718e3d811" => todo!(),
            // // MAKEINTRESOURCE(32656) - ScrollS
            // "1d7c1ea6ecedfa467c8b082f4082a8382c76d01033222f59f367267ba04c2b18" => todo!(),
            // // MAKEINTRESOURCE(32657) - ScrollW
            // "81fc32f5284680bf9503fe6af204f4a2494da213de935e5e0a59e85ce3ed7685" => todo!(),
            // // MAKEINTRESOURCE(32658) - ScrollE
            // "c0a4f452e2f564bfa0193523e47ab4fbdcb9ac2c475566c01ef8df61752ab8af" => todo!(),
            // // MAKEINTRESOURCE(32659) - ScrollNW
            // "b5c891535897b0665553d8ec1217a9919a1ca6147144d8b142516c9e829ca15a" => todo!(),
            // // MAKEINTRESOURCE(32660) - ScrollNE
            // "7b6008d5752a204e0aca2e45db3ea8d0901419b4d772c49bcb46821f9c23b85b" => todo!(),
            // // MAKEINTRESOURCE(32661) - ScrollSW
            // "56b8ae43318dd75770a10786e60b9f12f9ba8408eee8cb3a946a56ebbace7297" => todo!(),
            // // MAKEINTRESOURCE(32662) - ScrollSE
            // "178f8c96aaace35760dd01d5a7d4341b0690f7e3de45919bfd696d0c60c14895" => todo!(),
            // // MAKEINTRESOURCE(32663) - ArrowCD
            // "a8bcbabdbb363b9be601cbeaa29b46e0e64834ff1ae0812646ad6d0c64efb2da" => todo!(),
            _ => return None,
        })
    }
}
