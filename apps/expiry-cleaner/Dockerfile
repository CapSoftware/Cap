FROM curlimages/curl:8.11.1

CMD ["sh", "-c", "curl -fsS -H \"Authorization: Bearer ${CRON_SECRET}\" \"${CAP_WEB_URL:-https://video.shashanksn.xyz}/api/cron/expired-videos\""]
