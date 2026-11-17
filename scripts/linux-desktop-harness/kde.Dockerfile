# Arch Linux with KDE Plasma's compositor, shell and portal: KWin on its
# virtual backend (no display device), plasmashell as the tray host and
# kglobalacceld for global shortcuts, rendering with llvmpipe. systemd is PID 1
# for the same reasons as the other images.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed \
      systemd dbus kwin plasma-workspace plasma-desktop kglobalacceld xdg-desktop-portal xdg-desktop-portal-kde \
      breeze qt6-wayland pipewire wireplumber pipewire-pulse mesa vulkan-swrast vulkan-icd-loader \
      at-spi2-core python python-gobject glib2 procps-ng psmisc fuse2 ttf-dejavu wl-clipboard \
    && pacman -Scc --noconfirm
RUN useradd -m -u 1001 tester \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/tester \
    && systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount \
         proc-sys-fs-binfmt_misc.mount systemd-udevd.service systemd-udevd-kernel.socket \
         systemd-udevd-control.socket getty@tty1.service console-getty.service \
         systemd-firstboot.service systemd-homed.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
