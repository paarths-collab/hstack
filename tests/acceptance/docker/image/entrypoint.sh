#!/bin/sh
# Install the per-run PUBLIC key, make host keys, run sshd in the foreground (no systemd).
set -eu
[ -n "${HSTACK_AUTHORIZED_KEY:-}" ] || { echo "entrypoint: HSTACK_AUTHORIZED_KEY (a public key) is required" >&2; exit 1; }
install -d -m 700 -o operator -g operator /home/operator/.ssh
printf '%s\n' "$HSTACK_AUTHORIZED_KEY" > /home/operator/.ssh/authorized_keys
chown operator:operator /home/operator/.ssh/authorized_keys
chmod 600 /home/operator/.ssh/authorized_keys
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub  # fresh host keys per container (the apt package makes some)
ssh-keygen -A
unset HSTACK_AUTHORIZED_KEY
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
