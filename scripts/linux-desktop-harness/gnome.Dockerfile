# Ubuntu 26.04 with GNOME 50 and xdg-desktop-portal 1.21+, the stack whose
# GlobalShortcuts portal answers "An app id is required" to host apps.
# systemd runs as PID 1 so gnome-shell has logind and apps can be launched in
# the same `app-gnome-<id>-<pid>.scope` units the GNOME dock creates, which is
# where the portal reads a host app's id from.
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
# Ubuntu's mirrors answer 502 for minutes at a time: apt retries each file,
# and a failed install is tried again from another mirror.
RUN for mirror in "" http://azure.archive.ubuntu.com/ubuntu; do \
      if [ -n "$mirror" ]; then \
        sed -i "s#http://archive.ubuntu.com/ubuntu#$mirror#g" /etc/apt/sources.list.d/ubuntu.sources || continue; \
      fi; \
      apt-get -o Acquire::Retries=4 update \
      && apt-get -o Acquire::Retries=4 install -y --no-install-recommends \
        systemd systemd-sysv dbus dbus-user-session libpam-systemd \
        gnome-shell mutter xdg-desktop-portal xdg-desktop-portal-gnome \
        ubuntu-session yaru-theme-gnome-shell yaru-theme-icon yaru-theme-gtk \
        gnome-shell-extension-ubuntu-dock gnome-settings-daemon \
        gnome-shell-extension-appindicator pipewire wireplumber pipewire-pulse \
        mesa-vulkan-drivers libgl1-mesa-dri libegl-mesa0 python3 python3-gi gir1.2-glib-2.0 \
        at-spi2-core gir1.2-atspi-2.0 gnome-backgrounds \
        procps psmisc ca-certificates xdg-utils \
      && apt-get clean && exit 0; \
    done; exit 1
RUN useradd -m -u 1001 tester \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/tester \
    && systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount \
         proc-sys-fs-binfmt_misc.mount systemd-udevd.service systemd-udevd-kernel.socket \
         systemd-udevd-control.socket getty@tty1.service console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
