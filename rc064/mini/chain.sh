#!/bin/zsh
# chain.sh: the rest of the macOS gate on the mini, one go.sh session per item
# so other sessions can take the GUI locks in between.
G=$HOME/gate064
O=/Users/rmini/gate064/out
log() { echo "$(date -u) chain: $*" >> $G/go.log; }
[ -x $G/aggdev ] || swiftc -O $G/aggdev.swift -o $G/aggdev
$G/aggdev list > $G/aggdev-list.txt 2>&1
~/caprig/virtualcam/vcam add all >/dev/null 2>&1; ~/caprig/virtualcam/vcam start all >/dev/null 2>&1
for item in "$@"; do
  log "start $item"
  case $item in
    retina)
      $G/go.sh 2700 $O/perfretina perf GATE_PERF_ROUNDS=3 GATE_VDISPLAY=1512x982 ;;
    e2e)
      $G/go.sh 2700 $O/e2e startup,instant,studio,targets,export4k,hotkeys ;;
    devices)
      $G/go.sh 2700 $O/devices devices DEV_ROUNDS=1 "DEV_MIC=Cap Test Mic B" \
        "DEV_MIC_UNPLUG=$G/aggdev destroy cap-test-mic-b" \
        "DEV_MIC_REPLUG=$G/aggdev create 'Cap Test Mic B' cap-test-mic-b" \
        "DEV_CAM_ID=C4F0A1E2-0000-4C61-9000-000000000000" \
        "DEV_CAM_UNPLUG=$HOME/caprig/virtualcam/vcam remove 0" \
        "DEV_CAM_REPLUG=$HOME/caprig/virtualcam/vcam add 0; $HOME/caprig/virtualcam/vcam start 0" \
        "DEV_STIM=$HOME/caprig/stimulus/capstim 1240 200 640 400" ;;
    notes)
      if [ ! -x $G/FilePlayer.app/Contents/MacOS/FilePlayer ]; then
        mkdir -p $G/FilePlayer.app/Contents/MacOS
        swiftc -O $G/fileplayer.swift -o $G/FilePlayer.app/Contents/MacOS/FilePlayer
        printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>FilePlayer</string><key>CFBundleIdentifier</key><string>so.cap.testrig.fileplayer</string><key>LSUIElement</key><true/></dict></plist>\n' > $G/FilePlayer.app/Contents/Info.plist
        codesign --force -s - $G/FilePlayer.app
      fi
      $G/hold.sh 2400 sudo launchctl asuser 501 sudo -u rmini open -n -W -a /Applications/CapRigLauncher.app --args $G/notes_mac.sh $O/notes3 $G/notesbin/bin/cap-gpui meeting1 ;;
    ux)
      $G/go.sh 2700 $O/ux ux,editor_ux ;;
    exportab)
      $G/go.sh 1800 $O/exportab exportab GATE_EXPORT_ROUNDS=4 ;;
    playabcam)
      $G/go.sh 2400 $O/playabcam playab GATE_PLAY_CAMERA=1 ;;
    playabcamr)
      $G/go.sh 2400 $O/playabcamr playab GATE_PLAY_CAMERA=1 GATE_VDISPLAY=1512x982 ;;
    exdef60)
      $G/go.sh 2400 $O/exdef60 exportab GATE_EXPORT_PRESET=default GATE_SRC_FPS=60 GATE_EXPORT_ROUNDS=3 \
        "GATE_STIM=$HOME/caprig/stimulus/capstim 300 200 1200 700" ;;
    exdef30)
      $G/go.sh 2400 $O/exdef30 exportab GATE_EXPORT_PRESET=default GATE_SRC_FPS=30 GATE_EXPORT_ROUNDS=3 \
        "GATE_STIM=$HOME/caprig/stimulus/capstim 300 200 1200 700" ;;
    c1)
      $G/hold.sh 2400 /bin/zsh $G/gate-c1.sh ;;
    bisectplay)
      $G/go.sh 1800 $O/bisectplay playab GATE_SIDES=base,p4366,p4508,p4275,p4459,head GATE_PLAY_ROUNDS=3 GATE_PLAY_IDLE=0 ;;
    ax)
      $G/go.sh 900 $O/ax ax ;;
    idle)
      $G/go.sh 1800 $O/idle idle60,memmap ;;
    playab)
      $G/go.sh 1800 $O/playab playab ;;
    playabr)
      $G/go.sh 1800 $O/playabr playab GATE_VDISPLAY=1512x982 ;;
  esac
  log "end $item"
done
