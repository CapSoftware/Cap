use cidre::*;

fn main() {
    println!("");

    let device_types = ns::Array::from_slice(&[
        av::CaptureDeviceType::built_in_wide_angle_camera(),
        av::CaptureDeviceType::external(),
        av::CaptureDeviceType::desk_view_camera(),
    ]);
    let video_discovery_session =
        av::CaptureDeviceDiscoverySession::with_device_types_media_and_pos(
            &device_types,
            Some(av::MediaType::video()),
            av::CaptureDevicePos::Unspecified,
        );

    println!("Video Devices");
    for device in video_discovery_session.devices().iter() {
        println!("{}", device.localized_name().to_string());
        println!(" - Unique ID: {}", device.unique_id().to_string());
        // println!("");
    }

    let muxed_discovery_session =
        av::CaptureDeviceDiscoverySession::with_device_types_media_and_pos(
            &device_types,
            Some(av::MediaType::video()),
            av::CaptureDevicePos::Unspecified,
        );

    println!("");
    println!("Muxed Devices");
    for device in muxed_discovery_session.devices().iter() {
        println!("{}", device.localized_name().to_string());
        println!(" - Unique ID: {}", device.unique_id().to_string());
        // println!("");
    }
}
