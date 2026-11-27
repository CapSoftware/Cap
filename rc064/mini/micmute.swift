import CoreAudio
import Foundation

// micmute <uid> [0|1]: print (and optionally set) input mute + volume of a device.
let args = CommandLine.arguments
func devices() -> [AudioDeviceID] {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
    return ids
}
func uid(_ id: AudioDeviceID) -> String {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v: Unmanaged<CFString>?
    var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &s, &v) == noErr, let v else { return "" }
    return v.takeRetainedValue() as String
}
guard let dev = devices().first(where: { uid($0) == args[1] }) else { print("no device"); exit(1) }
for el: UInt32 in [0, 1, 2] {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeInput, mElement: el)
    if AudioObjectHasProperty(dev, &a) {
        var m: UInt32 = 0; var s = UInt32(4)
        AudioObjectGetPropertyData(dev, &a, 0, nil, &s, &m)
        print("element \(el) mute \(m)")
        if args.count > 2 { var n = UInt32(args[2])!; AudioObjectSetPropertyData(dev, &a, 0, nil, 4, &n); print("  set \(n)") }
    }
    var v = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeInput, mElement: el)
    if AudioObjectHasProperty(dev, &v) {
        var f: Float32 = 0; var s = UInt32(4)
        AudioObjectGetPropertyData(dev, &v, 0, nil, &s, &f)
        print("element \(el) volume \(f)")
    }
}
