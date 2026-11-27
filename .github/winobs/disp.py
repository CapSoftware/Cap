import pygame,subprocess,json
pygame.init()
print(pygame.display.get_desktop_sizes(), pygame.display.get_desktop_refresh_rates())
print(subprocess.run([r"C:\rig\bins\head\bin\cap.exe","targets","screens","--format","json"],capture_output=True,text=True).stdout)
import ctypes
u=ctypes.windll.user32
print("metrics virt", u.GetSystemMetrics(78), u.GetSystemMetrics(79), "primary", u.GetSystemMetrics(0), u.GetSystemMetrics(1), "monitors", u.GetSystemMetrics(80))
