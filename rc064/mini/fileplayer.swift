import AVFoundation
import Foundation

// FilePlayer <file>: plays the file once on the default output, then exits.
// Launched with `open -n -g -a FilePlayer.app --args <file>` so it is its own
// responsible process (ScreenCaptureKit window exclusion of Cap never mutes it).
let args = CommandLine.arguments
guard args.count > 1, let player = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: args[1])) else { exit(64) }
player.prepareToPlay()
player.play()
let end = Date().addingTimeInterval(player.duration + 1)
while Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
exit(0)
