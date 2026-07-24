import ExpoModulesCore
import ReplayKit

public final class CapScreenRecorderView: ExpoView {
  private let picker = RPSystemBroadcastPickerView(
    frame: CGRect(x: 0, y: 0, width: 82, height: 82)
  )

  var enabled = true {
    didSet {
      picker.isUserInteractionEnabled = enabled
      picker.alpha = enabled ? 1 : 0.42
    }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    picker.backgroundColor = .clear
    picker.showsMicrophoneButton = true
    picker.tintColor = .clear
    picker.preferredExtension = Bundle.main.object(
      forInfoDictionaryKey: "CapScreenBroadcastExtensionBundleIdentifier"
    ) as? String
    picker.translatesAutoresizingMaskIntoConstraints = false
    picker.accessibilityLabel = "Start screen broadcast"
    addSubview(picker)
    NSLayoutConstraint.activate([
      picker.leadingAnchor.constraint(equalTo: leadingAnchor),
      picker.trailingAnchor.constraint(equalTo: trailingAnchor),
      picker.topAnchor.constraint(equalTo: topAnchor),
      picker.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
  }
}
