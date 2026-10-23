Pod::Spec.new do |s|
  s.name = 'CapRecorder'
  s.version = '0.1.0'
  s.summary = 'Native segmented camera recording for Cap'
  s.description = 'Native iOS camera preview and fragmented MP4 recording for Cap'
  s.license = { :type => 'AGPL-3.0' }
  s.author = 'Cap'
  s.homepage = 'https://cap.so'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => 'https://github.com/CapSoftware/Cap.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'CoreVideo', 'UniformTypeIdentifiers'
  s.source_files = '**/*.{h,m,mm,swift}'
end
