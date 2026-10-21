# Local "VPS": a real sshd, a non-root operator, and the hstack TEST DOUBLES of hermes/curl.
# Built by tests/acceptance/docker/helpers/docker-target.mjs from a temporary context that also
# contains tests/acceptance/stubs/hermes (as ./hermes-stub) and VERSIONS.txt. Nothing here is a real
# Hermes, a real Telegram or a real vendor client.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server bash curl python3 tar coreutils ca-certificates procps findutils \
 && rm -rf /var/lib/apt/lists/*

# Non-root operator. `usermod -p '*'` = no usable password but NOT locked (sshd refuses locked accounts).
# Debian/Ubuntu ship a system account literally named `operator` (uid 37, nologin, home /root): drop it (and the
# stock `ubuntu` user) so the real login user can be created. `userdel` without -r leaves /root alone.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && (userdel operator 2>/dev/null || true) && (groupdel operator 2>/dev/null || true) \
 && useradd --create-home --shell /bin/bash --uid 2000 operator \
 && usermod -p '*' operator \
 && mkdir -p /run/sshd /var/tmp/hstack /opt/hstack-docker /home/operator/.local/bin \
 && chown -R operator:operator /var/tmp/hstack /home/operator

COPY sshd_config /etc/ssh/sshd_config
COPY --chmod=0755 entrypoint.sh /usr/local/sbin/hstack-entrypoint

# Test doubles that are NOT on any default PATH. The acceptance tests (and the Telegram skill test)
# copy them into ~/.local/bin when a scenario needs them.
COPY --chmod=0755 curl-stub hermes-tg-shim /opt/hstack-docker/

# The stub hermes lives ONLY here, so a plain non-login `ssh host hermes --version` fails, exactly as on
# a VPS where the installer put hermes in ~/.local/bin. VERSIONS.txt sits one level up so the stub
# finds the declared pin the same way it does in the repository.
COPY --chown=operator:operator --chmod=0755 hermes-stub /home/operator/.local/bin/hermes
COPY --chown=operator:operator --chmod=0644 VERSIONS.txt /home/operator/.local/VERSIONS.txt

EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/hstack-entrypoint"]
