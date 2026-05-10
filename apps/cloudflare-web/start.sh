#!/bin/sh
set -eu

export MYSQL_DATABASE="${MYSQL_DATABASE:-cap}"
export MYSQL_USER="${MYSQL_USER:-cap}"
export MYSQL_PASSWORD="${MYSQL_PASSWORD:-cap-local-pwd}"
export MYSQL_DATADIR="${MYSQL_DATADIR:-/tmp/mysql-data}"
export MYSQL_SOCKET="${MYSQL_SOCKET:-/tmp/mysql.sock}"
export MYSQL_PORT="${MYSQL_PORT:-3306}"
export DATABASE_URL="${DATABASE_URL:-mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@127.0.0.1:${MYSQL_PORT}/${MYSQL_DATABASE}}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-8080}"

mkdir -p "$MYSQL_DATADIR" /run/mysqld
chown -R mysql:mysql "$MYSQL_DATADIR" /run/mysqld

if [ ! -d "$MYSQL_DATADIR/mysql" ]; then
	mysqld --initialize-insecure --datadir="$MYSQL_DATADIR" --user=mysql >/tmp/mysql-install.log 2>&1
fi

mysqld --datadir="$MYSQL_DATADIR" --socket="$MYSQL_SOCKET" --pid-file=/tmp/mysql.pid --bind-address=127.0.0.1 --port="$MYSQL_PORT" --user=mysql &
MYSQL_PID="$!"

cleanup() {
	kill "$MYSQL_PID" 2>/dev/null || true
	wait "$MYSQL_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

for _ in $(seq 1 60); do
	if mysqladmin --socket="$MYSQL_SOCKET" ping >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

mysql --socket="$MYSQL_SOCKET" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\`;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'%' IDENTIFIED BY '${MYSQL_PASSWORD}';
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

exec node apps/web/server.js
