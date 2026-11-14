@preconcurrency import AVFoundation
import Foundation

public enum StudioWaveform {
    /// Loudest sample in each of `count` equal slices, 0...1. Decoded at a low rate in mono: a few milliseconds of
    /// work per minute of music.
    public static func peaks(url: URL, count: Int) async -> [Float] {
        guard count > 0 else { return [] }
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first,
              let duration = try? await asset.load(.duration).seconds, duration > 0,
              let reader = try? AVAssetReader(asset: asset)
        else { return [] }
        let rate = 8000.0
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: rate,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return [] }
        reader.add(output)
        guard reader.startReading() else { return [] }
        let total = max(1, Int(duration * rate))
        let perBucket = max(1, total / count)
        var peaks = [Float](repeating: 0, count: count)
        var index = 0
        while let buffer = output.copyNextSampleBuffer(), let block = CMSampleBufferGetDataBuffer(buffer) {
            var length = 0
            var pointer: UnsafeMutablePointer<CChar>?
            guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr, let pointer else { continue }
            let samples = length / 2
            pointer.withMemoryRebound(to: Int16.self, capacity: samples) { values in
                for offset in 0..<samples {
                    let bucket = min(count - 1, index / perBucket)
                    let level = Float(abs(Int32(values[offset]))) / 32768
                    if level > peaks[bucket] { peaks[bucket] = level }
                    index += 1
                }
            }
        }
        let loudest = peaks.max() ?? 0
        return loudest > 0 ? peaks.map { $0 / loudest } : peaks
    }
}
