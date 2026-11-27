#!/usr/bin/env bash
# linux-feeds.sh start|stop: producers for the two v4l2loopback cameras
# (exclusive_caps: a camera with no producer leaves the camera list, which is
# how the device flow unplugs it).
case $1 in
  start)
    for dev in /dev/video42 /dev/video43; do
      nohup ffmpeg -nostdin -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30" \
        -pix_fmt yuyv422 -f v4l2 "$dev" > "/tmp/feed-$(basename "$dev").log" 2>&1 &
    done
    sleep 2 ;;
  stop)
    pkill -f "f v4l2 /dev/video4" || true
    sleep 1 ;;
esac
