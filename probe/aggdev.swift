import CoreAudio
import Foundation

// aggdev create <name> <uid> [subdevice-uid]   -> public aggregate input over BlackHole
// aggdev destroy <uid>
// aggdev list

func deviceIDs() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)
    return ids
}

func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let value else {
        return ""
    }
    return value.takeRetainedValue() as String
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: aggdev create <name> <uid> [sub-uid] | destroy <uid> | list")
    exit(2)
}

switch args[1] {
case "list":
    for id in deviceIDs() {
        print("\(id)\t\(stringProperty(id, kAudioDevicePropertyDeviceUID))\t\(stringProperty(id, kAudioObjectPropertyName))")
    }
case "create":
    let name = args[2]
    let uid = args[3]
    let sub = args.count > 4 ? args[4] : "BlackHole2ch_UID"
    let description: [String: Any] = [
        kAudioAggregateDeviceNameKey: name,
        kAudioAggregateDeviceUIDKey: uid,
        kAudioAggregateDeviceIsPrivateKey: 0,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: sub]],
        kAudioAggregateDeviceMainSubDeviceKey: sub,
    ]
    var id: AudioDeviceID = 0
    let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &id)
    print(status == noErr ? "created \(id)" : "create failed \(status)")
    exit(status == noErr ? 0 : 1)
case "set-output":
    let uid = args[2]
    guard var id = deviceIDs().first(where: { stringProperty($0, kAudioDevicePropertyDeviceUID) == uid }) else {
        print("not found")
        exit(1)
    }
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
        UInt32(MemoryLayout<AudioDeviceID>.size), &id)
    print(status == noErr ? "output set" : "set failed \(status)")
    exit(status == noErr ? 0 : 1)
case "destroy":
    let uid = args[2]
    guard let id = deviceIDs().first(where: { stringProperty($0, kAudioDevicePropertyDeviceUID) == uid }) else {
        print("not found")
        exit(1)
    }
    let status = AudioHardwareDestroyAggregateDevice(id)
    print(status == noErr ? "destroyed" : "destroy failed \(status)")
    exit(status == noErr ? 0 : 1)
default:
    exit(2)
}
