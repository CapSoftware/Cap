# Arch Linux with the compositors Omarchy (Hyprland) and NixOS/Niri users run,
# their portals, and a waybar tray. Each runs on the host's vkms KMS device
# through seatd with llvmpipe rendering, the way it runs from a tty (load vkms
# on the host first). systemd is PID 1 for the same reason as the
# GNOME image: user services, and app scopes the portal reads app ids from.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed \
      systemd dbus seatd sway hyprland niri waybar \
      xdg-desktop-portal xdg-desktop-portal-hyprland xdg-desktop-portal-gnome xdg-desktop-portal-wlr \
      pipewire wireplumber pipewire-pulse mesa vulkan-swrast vulkan-icd-loader \
      python python-gobject glib2 procps-ng psmisc fuse2 ttf-dejavu wtype wl-clipboard swaybg \
    && pacman -Scc --noconfirm
RUN useradd -m -u 1001 -G seat,video,render tester \
    && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/tester \
    && systemctl enable seatd.service \
    && systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount \
         proc-sys-fs-binfmt_misc.mount systemd-udevd.service systemd-udevd-kernel.socket \
         systemd-udevd-control.socket getty@tty1.service console-getty.service \
         systemd-firstboot.service systemd-homed.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
