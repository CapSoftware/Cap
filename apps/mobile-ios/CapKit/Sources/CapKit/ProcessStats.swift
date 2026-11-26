import Darwin
import Foundation

public struct ProcessStats: Codable, Sendable {
    public var process: String
    public var recordedSeconds: Double
    public var wallSeconds: Double
    public var cpuSeconds: Double
    public var memoryMB: Double
    public var peakMemoryMB: Double
    public var thermalState: Int
    public var extra: [String: Double]

    public struct Mark: Sendable {
        let at: Date
        let cpu: Double
    }

    public static func mark() -> Mark {
        Mark(at: .now, cpu: cpuTime())
    }

    public static func measure(since mark: Mark, process: String, recordedSeconds: Double, extra: [String: Double] = [:]) -> ProcessStats {
        let memory = footprint()
        return ProcessStats(
            process: process,
            recordedSeconds: recordedSeconds,
            wallSeconds: Date.now.timeIntervalSince(mark.at),
            cpuSeconds: cpuTime() - mark.cpu,
            memoryMB: memory.current,
            peakMemoryMB: memory.peak,
            thermalState: ProcessInfo.processInfo.thermalState.rawValue,
            extra: extra
        )
    }

    public func save() {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
              let line = try? JSONEncoder().encode(self)
        else { return }
        let file = caches.appending(path: "RecordingStats.jsonl")
        var lines = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        lines.append(String(decoding: line, as: UTF8.self))
        try? (lines.suffix(20).joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
    }

    public static func note(_ message: String) {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let file = caches.appending(path: "Diagnostics.log")
        var lines = ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        lines.append("\(Date.now.ISO8601Format()) \(message)")
        try? (lines.suffix(100).joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
    }

    static func cpuTime() -> Double {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
        func seconds(_ time: timeval) -> Double { Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000 }
        return seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    static func footprint() -> (current: Double, peak: Double) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return (0, 0) }
        let megabyte = 1_048_576.0
        return (Double(info.phys_footprint) / megabyte, Double(info.ledger_phys_footprint_peak) / megabyte)
    }
}
