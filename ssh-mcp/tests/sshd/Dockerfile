# Real OpenSSH server for the `real-sshd` integration tier (ADR-015, AC-T2).
#
# The in-process ssh2 fixture speaks the protocol but is not an sshd: it has no
# `StrictModes`, no real SFTP subsystem and no real process table. Four claims
# can therefore only be proved here (AC-T4): that `authorized_keys` is installed
# with permissions a strict server accepts, that a pinned fingerprint is
# enforced against a real host key, that a timed-out command leaves no process
# behind, and that SFTP round trips survive the real subsystem.
#
# Build and run it the way the CI job does (plan §8.2):
#
#   docker build -t ssh-mcp-sshd ./tests/sshd
#   docker run -d --name ssh-mcp-sshd -p 2222:22 ssh-mcp-sshd
#
# The base image is pinned by tag rather than floating on `latest`: this tier is
# a required gate, and a gate that changes under you is the thing PM-5 is about.
FROM ubuntu:24.04

# A throwaway credential for a container that only ever listens on a CI
# runner's loopback. It is a build ARG so a local run can override it, and it
# is deliberately not a key: password auth is exactly what the setup flow needs
# on a host that has never seen us (AC7).
ARG SSHD_USER=sshmcp
ARG SSHD_PASSWORD=sshd-tier-password-v1

ENV DEBIAN_FRONTEND=noninteractive

# `procps` for `pgrep`/`pkill` — the session timeout path runs `pkill` on the
# remote (src/ssh/session.ts) and AC-T4 asserts the process is gone with
# `pgrep -f`. Neither ships in ubuntu:24.04.
# `gawk` for the 2 MiB worked example (TWO_MIB_COMMAND in the exec and session
# suites). `zsh`/`dash` are the other two legs of the shell matrix (AC-T5).
# `busybox` is deliberately NOT installed: the matrix is bash/dash/zsh and no
# assertion in the suite runs against an ash login shell.
# No `sudo`: nothing in the suite uses it, and leaving it out keeps the image
# narrow.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server \
      openssh-sftp-server \
      procps \
      gawk \
      zsh \
      dash \
 && rm -rf /var/lib/apt/lists/*

# Ubuntu's stock config `Include`s this directory, so a stray drop-in could
# silently override the file we review in this repo.
RUN rm -f /etc/ssh/sshd_config.d/*.conf
COPY sshd_config /etc/ssh/sshd_config

# `/run/sshd` is the privilege-separation directory; sshd refuses to start
# without it. Host keys are generated at build time so every container from one
# image presents the same key.
RUN mkdir -p /run/sshd && ssh-keygen -A

# Without CAP_AUDIT_WRITE `pam_loginuid` fails inside a container and takes the
# whole session down with it, which looks exactly like a rejected password.
RUN sed -i 's/^session\s\+required\s\+pam_loginuid\.so/session optional pam_loginuid.so/' \
      /etc/pam.d/sshd

# `--create-home` copies /etc/skel, which has no `.ssh` — that absence is the
# point, because the setup flow has to create the directory and the file with
# the right modes for `StrictModes yes` to let the key through. Ubuntu's
# HOME_MODE is 0750; 0755 is set explicitly so the home is the ordinary shape a
# real user account has.
RUN useradd --create-home --shell /bin/bash "$SSHD_USER" \
 && echo "$SSHD_USER:$SSHD_PASSWORD" | chpasswd \
 && chmod 755 "/home/$SSHD_USER"

EXPOSE 22

# `-D` keeps sshd in the foreground as PID 1; `-e` sends the log to stderr so a
# failed run's `docker logs` artifact actually explains itself (PM-5).
CMD ["/usr/sbin/sshd", "-D", "-e"]
