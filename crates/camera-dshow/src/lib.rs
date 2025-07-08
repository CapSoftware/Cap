use std::mem::ManuallyDrop;

use windows::{
    core::Interface,
    Win32::{
        Media::{
            DirectShow::{IBaseFilter, ICreateDevEnum},
            MediaFoundation::{CLSID_AudioInputDeviceCategory, CLSID_SystemDeviceEnum},
        },
        System::{
            Com::{
                CoCreateInstance, CoCreateInstanceEx, IBindCtx, IErrorLog, IMoniker,
                StructuredStorage::IPropertyBag, CLSCTX_INPROC_SERVER,
            },
            Variant::{VARIANT, VT_BSTR},
        },
    },
};

fn test() {
    unsafe {
        let create_device_enum: ICreateDevEnum = CoCreateInstance(
            CLSID_SystemDeviceEnum,
            None::<windows_core::IUnknown>,
            CLSCTX_INPROC_SERVER,
        )
        .unwrap();

        let mut enum_moniker = None;

        create_device_enum
            .CreateClassEnumerator(CLSID_AudioInputDeviceCategory, &mut enum_moniker, dwflags)
            .unwrap();

        let mut count = 0;
        let mut device_info = [None];
        if let Some(enum_moniker) = enum_moniker {
            while enum_moniker
                .Next(&mut device_info, Some(&mut count))
                .is_ok()
            {
                if let Some(device_info) = device_info[0] {
                    let property_data: IPropertyBag =
                        device_info.BindToStorage(None, None).unwrap();

                    let mut device_name = VARIANT::default();
                    device_name.Anonymous.Anonymous.vt = VT_BSTR;

                    property_data
                        .Read(
                            windows_core::w!("FriendlyName"),
                            &mut device_name,
                            None::<IErrorLog>,
                        )
                        .unwrap();

                    let mut device_path = VARIANT::default();
                    device_path.Anonymous.Anonymous.vt = VT_BSTR;
                    device_path.Anonymous.Anonymous.Anonymous.bstrVal = ManuallyDrop::default();

                    let _ = property_data.Read(
                        windows_core::w!("DevicePath"),
                        &mut device_path,
                        None::<IErrorLog>,
                    );

                    let a: IBaseFilter = device_info
                        .BindToObject(None::<IBindCtx>, None::<IMoniker>)
                        .unwrap();
                }
            }
        }
    }
}
