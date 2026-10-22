"""Build a fully SYNTHETIC sosreport directory tree (sos project layout).

Everything here is invented: host web-01.example.test, RFC 5737 / RFC 1918
documentation addresses, example-* services, round numbers. Nothing is copied
from any real system, customer or report. The file layout follows what the
sos project writes (sos_commands/<plugin>/<command_with_underscores>, etc/,
proc/, sys/, var/log/, installed-rpms, uptime, df, ...) because that is what
backend/parsers/sosreport/* read.

Used by generate.py; see README.md for the planted findings.
"""
import gzip
import os
import random
from datetime import datetime, timedelta

import mock_manifests

HOST = "web-01"
FQDN = "web-01.example.test"
KERNEL = "5.14.0-427.13.1.el9_4.x86_64"
NCPU = 8
# Collection moment (UTC). The journal ends just before it.
COLLECTED = datetime(2026, 10, 12, 14, 30, 0)
JOURNAL_START = datetime(2026, 10, 9, 0, 0, 0)

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def syslog_ts(dt):
    return f"{MONTHS[dt.month - 1]} {dt.day:2d} {dt:%H:%M:%S}"


class Tree:
    def __init__(self, base):
        self.base = base

    def write(self, rel, content):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)

    def write_gz(self, rel, content):
        """A rotated, gzip-compressed log (var/log/messages-YYYYMMDD.gz)."""
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            fh.write(content)


# --------------------------------------------------------------------------
# Static system facts
# --------------------------------------------------------------------------

def write_system_facts(t):
    t.write("hostname", FQDN + "\n")
    t.write("uname", f"Linux {FQDN} {KERNEL} #1 SMP PREEMPT_DYNAMIC Fri Sep 25 10:00:00 EDT 2026 x86_64 x86_64 x86_64 GNU/Linux\n")
    t.write("date", "Mon Oct 12 14:30:00 UTC 2026\n")
    t.write("version.txt", "sosreport: 4.7.0\n")
    # High load on an 8-CPU box: planted finding
    t.write("uptime", " 14:30:01 up 23 days,  4:12,  2 users,  load average: 18.42, 15.07, 9.88\n")
    t.write("etc/hostname", FQDN + "\n")
    t.write("etc/redhat-release", "Red Hat Enterprise Linux release 9.4 (Plow)\n")
    t.write("etc/os-release",
            'NAME="Red Hat Enterprise Linux"\nVERSION="9.4 (Plow)"\nID="rhel"\nID_LIKE="fedora"\n'
            'VERSION_ID="9.4"\nPLATFORM_ID="platform:el9"\nPRETTY_NAME="Red Hat Enterprise Linux 9.4 (Plow)"\n')
    t.write("etc/selinux/config", "SELINUX=enforcing\nSELINUXTYPE=targeted\n")
    t.write("etc/chrony.conf", "pool ntp.example.test iburst\ndriftfile /var/lib/chrony/drift\nmakestep 1.0 3\nrtcsync\n")
    t.write("etc/fstab",
            "/dev/mapper/rhel-root  /      xfs  defaults 0 0\n"
            "/dev/mapper/rhel-var   /var   xfs  defaults 0 0\n"
            "/dev/mapper/rhel-home  /home  xfs  defaults 0 0\n"
            "UUID=1111aaaa-2222-bbbb-3333-cccc4444dddd /boot xfs defaults 0 0\n"
            "/dev/mapper/rhel-swap  none   swap defaults 0 0\n")
    t.write("sos_commands/host/hostnamectl_status",
            f"   Static hostname: {FQDN}\n"
            "         Icon name: computer-vm\n"
            "           Chassis: vm\n"
            "        Machine ID: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\n"
            "           Boot ID: fedcba9876543210fedcba9876543210\n"
            "    Virtualization: kvm\n"
            "  Operating System: Red Hat Enterprise Linux 9.4 (Plow)\n"
            "       CPE OS Name: cpe:/o:redhat:enterprise_linux:9::baseos\n"
            f"            Kernel: Linux {KERNEL}\n"
            "      Architecture: x86-64\n"
            "   Hardware Vendor: Example Systems\n"
            "    Hardware Model: ExampleServer X1\n"
            "  Firmware Version: 2.1.7\n")
    t.write("sos_commands/processor/lscpu",
            "Architecture:                       x86_64\n"
            "CPU op-mode(s):                     32-bit, 64-bit\n"
            "Byte Order:                         Little Endian\n"
            f"CPU(s):                             {NCPU}\n"
            f"On-line CPU(s) list:                0-{NCPU - 1}\n"
            "Vendor ID:                          ExampleVendor\n"
            "Model name:                         Example CPU E1-8000 @ 2.40GHz\n"
            "CPU family:                         6\n"
            "Model:                              85\n"
            "Thread(s) per core:                 2\n"
            "Core(s) per socket:                 4\n"
            "Socket(s):                          1\n"
            "Stepping:                           7\n"
            "BogoMIPS:                           4800.00\n"
            "Virtualization:                     VT-x\n"
            "Hypervisor vendor:                  KVM\n"
            "L1d cache:                          128 KiB (4 instances)\n"
            "L2 cache:                           4 MiB (4 instances)\n"
            "L3 cache:                           32 MiB (1 instance)\n"
            "NUMA node(s):                       1\n"
            f"NUMA node0 CPU(s):                  0-{NCPU - 1}\n")
    t.write("sos_commands/memory/free_-m",
            "               total        used        free      shared  buff/cache   available\n"
            "Mem:           32000       29100         600         410        2300        2400\n"
            "Swap:           4095        3900         195\n")
    t.write("proc/meminfo",
            "MemTotal:       32768000 kB\nMemFree:          614400 kB\nMemAvailable:    2457600 kB\n"
            "Buffers:          102400 kB\nCached:          2150400 kB\nSwapCached:       204800 kB\n"
            "Active:         26214400 kB\nInactive:        3072000 kB\nSwapTotal:       4193280 kB\n"
            "SwapFree:         199680 kB\nDirty:              2048 kB\nShmem:            419840 kB\n"
            "Slab:             819200 kB\nCommitted_AS:   41943040 kB\nHugePages_Total:       0\n")
    t.write("proc/cmdline", f"BOOT_IMAGE=(hd0,gpt2)/vmlinuz-{KERNEL} root=/dev/mapper/rhel-root ro crashkernel=1G-4G:192M,4G-64G:256M,64G-:512M rd.lvm.lv=rhel/root rd.lvm.lv=rhel/swap rhgb quiet\n")
    t.write("proc/version", f"Linux version {KERNEL} (mockbuild@example.test) (gcc (GCC) 11.4.1) #1 SMP PREEMPT_DYNAMIC Fri Sep 25 10:00:00 EDT 2026\n")
    # Kernel taint: O (out-of-tree, 4096) + E (unsigned module, 8192)
    t.write("proc/sys/kernel/tainted", "12288\n")
    t.write("sos_commands/kernel/modinfo_example_fastpath",
            "filename:       /lib/modules/" + KERNEL + "/extra/example_fastpath.ko\n"
            "description:    Example out-of-tree fast path driver\nlicense:        GPL\n"
            "version:        0.9.3\nvermagic:       " + KERNEL + " SMP preempt mod_unload modversions\n")
    t.write("sos_commands/kernel/lsmod",
            "Module                  Size  Used by\nexample_fastpath       49152  1\nxfs                  2097152  3\n"
            "virtio_net             81920  0\nvirtio_blk             24576  2\ndm_mod                196608  12 dm_log,dm_mirror\n"
            "bridge                360448  0\nnf_tables             311296  0\n")
    t.write("sos_commands/chrony/chronyc_tracking",
            "Reference ID    : 00000000 ()\n"
            "Stratum         : 0\n"
            "Ref time (UTC)  : Thu Jan 01 00:00:00 1970\n"
            "System time     : 2.345678901 seconds slow of NTP time\n"
            "Last offset     : +0.000000000 seconds\n"
            "RMS offset      : 0.000000000 seconds\n"
            "Frequency       : 14.812 ppm fast\n"
            "Residual freq   : +0.000 ppm\n"
            "Skew            : 0.000 ppm\n"
            "Root delay      : 1.000000000 seconds\n"
            "Root dispersion : 1.000000000 seconds\n"
            "Update interval : 0.0 seconds\n"
            "Leap status     : Not synchronised\n")
    t.write("sos_commands/chrony/chronyc_-n_sources",
            "MS Name/IP address         Stratum Poll Reach LastRx Last sample\n"
            "===============================================================================\n"
            "^? 192.0.2.123                   0   6     0     -     +0ns[   +0ns] +/-    0ns\n")
    t.write("sos_commands/selinux/sestatus_-b",
            "SELinux status:                 enabled\nSELinuxfs mount:                /sys/fs/selinux\n"
            "SELinux root directory:         /etc/selinux\nLoaded policy name:             targeted\n"
            "Current mode:                   enforcing\nMode from config file:          enforcing\n"
            "Policy MLS status:              enabled\nPolicy deny_unknown status:     allowed\n"
            "Memory protection checking:     actual (secure)\nMax kernel policy version:      33\n")
    t.write("sos_commands/selinux/ausearch_-m_avc_-m_user_avc_-m_selinux_err_-i",
            "----\ntime->Sun Oct 11 10:02:17 2026\n"
            "type=PROCTITLE msg=audit(1791367337.412:9001) : proctitle=/usr/sbin/httpd -DFOREGROUND\n"
            "type=SYSCALL msg=audit(1791367337.412:9001) : arch=x86_64 syscall=openat success=no exit=EACCES(Permission denied) a0=0xffffff9c a1=0x7f00deadbeef a2=O_WRONLY|O_CREAT|O_TRUNC a3=0x1b6 items=0 ppid=2301 pid=2305 auid=unset uid=apache gid=apache euid=apache suid=apache fsuid=apache egid=apache sgid=apache fsgid=apache tty=(none) ses=unset comm=httpd exe=/usr/sbin/httpd subj=system_u:system_r:httpd_t:s0 key=(null)\n"
            "type=AVC msg=audit(1791367337.412:9001) : avc:  denied  { write } for  pid=2305 comm=httpd name=uploads dev=\"dm-1\" ino=1310786 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:httpd_sys_content_t:s0 tclass=dir permissive=0\n")
    t.write("sos_commands/systemd/systemctl_list-units_--failed",
            "  UNIT                    LOAD   ACTIVE SUB    DESCRIPTION\n"
            "* example-backup.service loaded failed failed Example nightly backup\n\n"
            "LOAD   = Reflects whether the unit definition was properly loaded.\n"
            "ACTIVE = The high-level unit activation state, i.e. generalization of SUB.\n"
            "SUB    = The low-level unit activation state, values depend on unit type.\n"
            "1 loaded units listed.\n")
    t.write("sos_commands/systemd/systemctl_show_--all", "")
    t.write("sos_commands/date/date", "Mon Oct 12 14:30:00 UTC 2026\n")
    t.write("sos_commands/date/date_--utc", "Mon Oct 12 14:30:00 UTC 2026\n")
    t.write("sos_commands/date/hwclock", "2026-10-12 14:29:57.612345+00:00\n")
    t.write("sos_commands/dnf/dnf_-C_repolist",
            "repo id                                     repo name\n"
            "rhel-9-for-x86_64-appstream-rpms            Red Hat Enterprise Linux 9 for x86_64 - AppStream (RPMs)\n"
            "rhel-9-for-x86_64-baseos-rpms               Red Hat Enterprise Linux 9 for x86_64 - BaseOS (RPMs)\n")
    # The sos manifest (sos 4.7 layout: plugins, their commands, return codes
    # and run times; the Sos Report / Blame tab reads it)
    t.write("sos_reports/manifest.json", mock_manifests.dump(mock_manifests.rhel_manifest(FQDN, KERNEL)))


PACKAGES = [
    ("kernel", "5.14.0-427.13.1.el9_4"), ("kernel-core", "5.14.0-427.13.1.el9_4"),
    ("kernel-modules", "5.14.0-427.13.1.el9_4"), ("glibc", "2.34-100.el9_4.2"),
    ("systemd", "252-32.el9_4.7"), ("systemd-udev", "252-32.el9_4.7"), ("openssh-server", "8.7p1-38.el9_4.4"),
    ("openssh-clients", "8.7p1-38.el9_4.4"), ("httpd", "2.4.57-11.el9_4.1"), ("httpd-core", "2.4.57-11.el9_4.1"),
    ("mod_ssl", "2.4.57-11.el9_4.1"), ("php", "8.0.30-1.el9_2"), ("php-fpm", "8.0.30-1.el9_2"),
    ("chrony", "4.5-1.el9"), ("firewalld", "1.3.4-1.el9"), ("NetworkManager", "1.46.0-8.el9_4"),
    ("sos", "4.7.0-3.el9"), ("tuned", "2.22.1-4.el9_4"), ("audit", "3.1.2-2.el9"), ("rsyslog", "8.2310.0-4.el9"),
    ("selinux-policy", "38.1.35-2.el9_4.2"), ("selinux-policy-targeted", "38.1.35-2.el9_4.2"),
    ("setroubleshoot-server", "3.3.32-1.el9"), ("lvm2", "2.03.23-2.el9"), ("xfsprogs", "6.4.0-3.el9"),
    ("dnf", "4.14.0-17.el9"), ("rpm", "4.16.1.3-29.el9"), ("bash", "5.1.8-9.el9"), ("coreutils", "8.32-35.el9"),
    ("python3", "3.9.18-3.el9_4.1"), ("subscription-manager", "1.29.40-1.el9"), ("sssd", "2.9.4-6.el9_4"),
    ("polkit", "0.117-13.el9"), ("dbus-broker", "28-7.el9"), ("crontabs", "1.11-27.20190603git.el9"),
    ("cronie", "1.5.7-11.el9"), ("example-worker", "3.2.1-4.example"), ("example-backup", "1.0.5-1.example"),
    ("example-fastpath-kmod", "0.9.3-2.example"), ("iproute", "6.2.0-5.el9"), ("sysstat", "12.5.4-7.el9"),
    ("kexec-tools", "2.0.27-13.el9"), ("grub2-common", "2.06-77.el9_4"), ("openssl", "3.0.7-27.el9_4"),
    ("curl", "7.76.1-29.el9_4.1"), ("vim-minimal", "8.2.2637-20.el9_1"), ("tar", "1.34-6.el9_1"),
]


def write_packages(t):
    rpm_lines = []
    for i, (name, ver) in enumerate(PACKAGES):
        arch = "noarch" if name in ("crontabs", "selinux-policy", "selinux-policy-targeted", "setroubleshoot-server") else "x86_64"
        day = 1 + (i % 9)
        rpm_lines.append(f"{name}-{ver}.{arch}".ljust(70) + f"Thu 0{day} Oct 2026 08:{i % 60:02d}:00 AM UTC")
    t.write("installed-rpms", "\n".join(rpm_lines) + "\n")
    t.write("sos_commands/rpm/package-data", "\n".join(f"{n}-{v}.x86_64\t{n}\t{v.split('-')[0]}\t{v.split('-', 1)[1]}\tx86_64" for n, v in PACKAGES) + "\n")
    t.write("sos_commands/rpm/rpm_-V_-a", "")


# --------------------------------------------------------------------------
# Services (sos_commands/systemd/systemctl_status_--all)
# --------------------------------------------------------------------------

UNITS = [
    ("auditd.service", "Security Auditing Service", "active (running)", 2, 4.2),
    ("chronyd.service", "NTP client/server", "active (running)", 1, 2.1),
    ("crond.service", "Command Scheduler", "active (running)", 1, 1.4),
    ("dbus-broker.service", "D-Bus System Message Bus", "active (running)", 1, 4.8),
    ("example-backup.service", "Example nightly backup", "failed (Result: exit-code)", 0, 0.0),
    ("example-worker.service", "Example queue worker", "active (running)", 4600, 26300.0),
    ("firewalld.service", "firewalld - dynamic firewall daemon", "active (running)", 2, 38.5),
    ("httpd.service", "The Apache HTTP Server", "active (running)", 213, 812.4),
    ("irqbalance.service", "irqbalance daemon", "active (running)", 2, 2.6),
    ("kdump.service", "Crash recovery kernel arming", "active (exited)", 0, 0.0),
    ("NetworkManager.service", "Network Manager", "active (running)", 3, 12.9),
    ("php-fpm.service", "The PHP FastCGI Process Manager", "active (running)", 41, 362.0),
    ("polkit.service", "Authorization Manager", "active (running)", 3, 8.1),
    ("rsyslog.service", "System Logging Service", "active (running)", 3, 6.4),
    ("setroubleshootd.service", "SETroubleshoot daemon for processing new SELinux denial logs", "active (running)", 3, 48.7),
    ("sshd.service", "OpenSSH server daemon", "active (running)", 1, 3.9),
    ("sssd.service", "System Security Services Daemon", "active (running)", 4, 55.2),
    ("systemd-journald.service", "Journal Service", "active (running)", 1, 72.3),
    ("systemd-logind.service", "User Login Management", "active (running)", 1, 3.0),
    ("systemd-udevd.service", "Rule-based Manager for Device Events and Files", "active (running)", 1, 8.8),
    ("tuned.service", "Dynamic System Tuning Daemon", "active (running)", 4, 17.6),
    ("example-metrics.service", "Example metrics exporter", "inactive (dead)", 0, 0.0),
    ("boot.automount", "Boot automount", "active (waiting)", 0, 0.0),
    ("dnf-makecache.timer", "dnf makecache --timer", "active (waiting)", 0, 0.0),
    ("example-backup.timer", "Run example-backup nightly", "active (waiting)", 0, 0.0),
]


def write_services(t):
    blocks = []
    for name, desc, active, tasks, mem in UNITS:
        bullet = "×" if active.startswith("failed") else ("○" if active.startswith("inactive") else "●")
        since = "Sat 2026-09-19 10:18:02 UTC; 3 weeks 2 days ago"
        lines = [f"{bullet} {name} - {desc}",
                 f"     Loaded: loaded (/usr/lib/systemd/system/{name}; enabled; preset: enabled)"]
        if active.startswith("failed"):
            lines += [f"     Active: {active} since Mon 2026-10-12 02:00:07 UTC; 12h ago",
                      "   Duration: 7.312s",
                      "    Process: 31844 ExecStart=/usr/libexec/example-backup --target /mnt/backup (code=exited, status=28)",
                      "   Main PID: 31844 (code=exited, status=28)",
                      "        CPU: 1.204s", "",
                      f"Oct 12 02:00:00 {FQDN} systemd[1]: Starting Example nightly backup...",
                      f"Oct 12 02:00:07 {FQDN} example-backup[31844]: error: write /mnt/backup/2026-10-12.tar: no space left on device",
                      f"Oct 12 02:00:07 {FQDN} systemd[1]: example-backup.service: Main process exited, code=exited, status=28/n/a",
                      f"Oct 12 02:00:07 {FQDN} systemd[1]: example-backup.service: Failed with result 'exit-code'.",
                      f"Oct 12 02:00:07 {FQDN} systemd[1]: Failed to start Example nightly backup."]
        elif active.startswith("inactive"):
            lines += [f"     Active: {active}"]
        else:
            lines += [f"     Active: {active} since {since}"]
            if name.endswith(".service") and tasks:
                limit = 5000 if name == "example-worker.service" else 38000
                lines += [f"      Tasks: {tasks} (limit: {limit})",
                          f"     Memory: {mem}M",
                          f"        CPU: {int(mem * 7)}ms" if mem < 100 else f"        CPU: {mem / 100:.1f}h",
                          f"     CGroup: /system.slice/{name}",
                          f"             └─{1000 + sum(map(ord, name)) % 9000} /usr/sbin/{name.split('.')[0]}"]
        blocks.append("\n".join(lines) + "\n")
    text = "\n".join(blocks)
    # sos output also carries "Unit X could not be found." junk the parser strips
    text += "\nUnit example-legacy.service could not be found.\n"
    t.write("sos_commands/systemd/systemctl_status_--all", text)


# --------------------------------------------------------------------------
# Processes, cgroups, sched debug, cstates
# --------------------------------------------------------------------------

PROCS = [
    # pid, user, cpu, mem, rss(kB), stat, cmd, cgroup
    (1, "root", 0.1, 0.1, 13420, "Ss", "/usr/lib/systemd/systemd --switched-root --system --deserialize 31", "/init.scope"),
    (612, "root", 0.0, 0.2, 65540, "Ss", "/usr/lib/systemd/systemd-journald", "/system.slice/systemd-journald.service"),
    (701, "root", 0.0, 0.0, 9800, "Ss", "/sbin/auditd", "/system.slice/auditd.service"),
    (812, "chrony", 0.0, 0.0, 3100, "S", "/usr/sbin/chronyd -F 2", "/system.slice/chronyd.service"),
    (901, "root", 0.3, 0.1, 21500, "Ssl", "/usr/sbin/NetworkManager --no-daemon", "/system.slice/NetworkManager.service"),
    (1001, "root", 0.1, 0.0, 12800, "Ss", "/usr/sbin/sshd -D", "/system.slice/sshd.service"),
    (2301, "root", 0.2, 0.3, 98000, "Ss", "/usr/sbin/httpd -DFOREGROUND", "/system.slice/httpd.service"),
    (2305, "apache", 12.4, 1.1, 361000, "Sl", "/usr/sbin/httpd -DFOREGROUND", "/system.slice/httpd.service"),
    (2306, "apache", 11.9, 1.0, 355000, "Sl", "/usr/sbin/httpd -DFOREGROUND", "/system.slice/httpd.service"),
    (2307, "apache", 9.8, 1.0, 350000, "Sl", "/usr/sbin/httpd -DFOREGROUND", "/system.slice/httpd.service"),
    (2401, "root", 0.1, 0.2, 60000, "Ss", "php-fpm: master process (/etc/php-fpm.conf)", "/system.slice/php-fpm.service"),
    (2410, "apache", 6.5, 0.8, 262000, "S", "php-fpm: pool www", "/system.slice/php-fpm.service"),
    (2411, "apache", 7.1, 0.9, 290000, "S", "php-fpm: pool www", "/system.slice/php-fpm.service"),
    (4200, "svcuser", 1.2, 0.5, 164000, "Ssl", "/usr/libexec/example-worker --supervisor --config /etc/example/worker.yaml", "/system.slice/example-worker.service"),
    (4311, "svcuser", 88.6, 61.2, 20054000, "Dl", "/usr/libexec/example-worker --queue payments --threads 4600", "/system.slice/example-worker.service"),
    (4312, "svcuser", 42.0, 11.4, 3735000, "Rl", "/usr/libexec/example-worker --queue reports --threads 64", "/system.slice/example-worker.service"),
    (5123, "apache", 0.0, 0.1, 42000, "S", "/var/www/cgi-bin/example-cgi", "/system.slice/httpd.service"),
    (6001, "root", 0.0, 0.1, 19000, "Ssl", "/usr/libexec/platform-python -s /usr/sbin/tuned -l -P", "/system.slice/tuned.service"),
    (6100, "root", 0.4, 0.2, 51000, "Ssl", "/usr/bin/python3 -Es /usr/sbin/setroubleshootd -f", "/system.slice/setroubleshootd.service"),
    (7001, "root", 0.0, 0.0, 11000, "Ss", "/usr/sbin/crond -n", "/system.slice/crond.service"),
    (7777, "user", 0.0, 0.0, 6500, "Ss", "-bash", "/user.slice/user-1000.slice/session-42.scope"),
    (7812, "root", 2.1, 0.1, 29000, "R+", "/usr/libexec/platform-python /usr/sbin/sos report --batch", "/user.slice/user-1000.slice/session-42.scope"),
]

SLICES = {
    "/system.slice/httpd.service": (-1, 100000, 2 * 1024 ** 3, 1_210_000_000),
    "/system.slice/php-fpm.service": (-1, 100000, 1 * 1024 ** 3, 612_000_000),
    # Planted finding: example-worker at ~97% of its memory limit
    "/system.slice/example-worker.service": (600000, 100000, 24 * 1024 ** 3, 25_017_000_000),
    "/system.slice/sshd.service": (-1, 100000, 0, 13_000_000),
    "/system.slice/chronyd.service": (-1, 100000, 0, 3_200_000),
    "/system.slice/NetworkManager.service": (-1, 100000, 0, 22_000_000),
    "/system.slice/systemd-journald.service": (-1, 100000, 0, 67_000_000),
    "/system.slice/auditd.service": (-1, 100000, 0, 10_000_000),
    "/system.slice/tuned.service": (-1, 100000, 0, 19_500_000),
    "/system.slice/setroubleshootd.service": (-1, 100000, 0, 52_000_000),
    "/system.slice/crond.service": (-1, 100000, 0, 11_300_000),
    "/user.slice/user-1000.slice/session-42.scope": (-1, 100000, 0, 36_000_000),
    "/init.scope": (-1, 100000, 0, 13_700_000),
}


def write_processes(t, rnd):
    header = "USER         PID %CPU %MEM      VSZ    RSS TTY      STAT START   TIME COMMAND"
    lines = [header]
    zlines = ["LABEL                           USER         PID %CPU %MEM      VSZ    RSS TTY      STAT START   TIME COMMAND"]
    for pid, user, cpu, mem, rss, stat, cmd, cg in PROCS:
        vsz = rss * 3 + 10000
        start = "Sep19" if pid < 7000 else "14:01"
        lines.append(f"{user:<10} {pid:>5} {cpu:>4} {mem:>4} {vsz:>8} {rss:>6} ?        {stat:<4} {start:<5} {int(cpu * 30):>3}:{pid % 60:02d} {cmd}")
        label = "system_u:system_r:httpd_t:s0" if "httpd" in cmd or "php" in cmd or "cgi" in cmd else (
            "unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023" if user == "user" or "sos" in cmd else "system_u:system_r:init_t:s0")
        zlines.append(f"{label:<31} {user:<10} {pid:>5} {cpu:>4} {mem:>4} {vsz:>8} {rss:>6} ?        {stat:<4} {start:<5} {int(cpu * 30):>3}:{pid % 60:02d} {cmd}")
        # threads of the busy worker (ps m output: PID shown as '-')
        if pid == 4311:
            for k in range(6):
                lines.append(f"{user:<10}     - {rnd.uniform(5, 25):>4.1f}    -        -      - -        {'Rl' if k % 2 else 'Dl'}   {start:<5} {rnd.randint(1, 300):>3}:{k * 7:02d} -")
    t.write("sos_commands/process/ps_auxwwwm", "\n".join(lines) + "\n")
    t.write("sos_commands/selinux/ps_auxZww", "\n".join(zlines) + "\n")
    t.write("sos_commands/process/ps_-elfL", "")
    t.write("sos_commands/process/ps_axo_pid_ppid_user_group_lwp_nlwp_start_time_comm_cgroup",
            "\n".join(f"{pid} 1 {user} {user} {pid} 1 Sep19 {cmd.split()[0].rsplit('/', 1)[-1]} 0::{cg}" for pid, user, *_r, cmd, cg in PROCS) + "\n")

    # cgroup v1 trees
    t.write("proc/mounts",
            "/dev/mapper/rhel-root / xfs rw,seclabel,relatime,attr2,inode64 0 0\n"
            "/dev/mapper/rhel-var /var xfs rw,seclabel,relatime 0 0\n"
            "tmpfs /sys/fs/cgroup tmpfs ro,seclabel,nosuid,nodev,noexec,mode=755 0 0\n"
            "cgroup /sys/fs/cgroup/systemd cgroup rw,seclabel,nosuid,nodev,noexec,relatime,xattr,name=systemd 0 0\n"
            "cgroup /sys/fs/cgroup/cpu,cpuacct cgroup rw,seclabel,nosuid,nodev,noexec,relatime,cpu,cpuacct 0 0\n"
            "cgroup /sys/fs/cgroup/memory cgroup rw,seclabel,nosuid,nodev,noexec,relatime,memory 0 0\n"
            "cgroup /sys/fs/cgroup/cpuset cgroup rw,seclabel,nosuid,nodev,noexec,relatime,cpuset 0 0\n")
    for cg, (quota, period, limit, usage) in SLICES.items():
        rel = cg.lstrip("/")
        members = "\n".join(str(p[0]) for p in PROCS if p[7] == cg) + "\n"
        percpu = [str(rnd.randint(1_000_000_000, 9_000_000_000) * (12 if "example-worker" in cg else 1)) for _ in range(NCPU)]
        t.write(f"sys/fs/cgroup/cpu,cpuacct/{rel}/cpu.cfs_quota_us", f"{quota}\n")
        t.write(f"sys/fs/cgroup/cpu,cpuacct/{rel}/cpu.cfs_period_us", f"{period}\n")
        t.write(f"sys/fs/cgroup/cpu,cpuacct/{rel}/cpuacct.usage_percpu", " ".join(percpu) + "\n")
        t.write(f"sys/fs/cgroup/cpu,cpuacct/{rel}/cgroup.procs", members)
        t.write(f"sys/fs/cgroup/cpuset/{rel}/cpuset.cpus", f"0-{NCPU - 1}\n")
        t.write(f"sys/fs/cgroup/memory/{rel}/memory.usage_in_bytes", f"{usage}\n")
        t.write(f"sys/fs/cgroup/memory/{rel}/memory.limit_in_bytes", f"{limit if limit else 9223372036854771712}\n")
        t.write(f"sys/fs/cgroup/memory/{rel}/cgroup.procs", members)
    for pid, *_r, cg in PROCS:
        t.write(f"proc/{pid}/cgroup", f"4:memory:{cg}\n3:cpu,cpuacct:{cg}\n2:cpuset:/\n1:name=systemd:{cg}\n")


def write_sched_debug(t, rnd):
    out = [f"Sched Debug Version: v0.11, {KERNEL} #1", "ktime                                   : 2007312345.678901",
           "sched_clk                               : 2007312345.678901", "cpu_clk                                 : 2007312345.678901",
           "jiffies                                 : 6301234567", "", "sysctl_sched", "  .sysctl_sched_base_slice                 : 3.000000",
           "  .sysctl_sched_features                   : 6237599", ""]
    for cpu in range(NCPU):
        out += [f"cpu#{cpu}, 2400.000 MHz",
                f"  .nr_running                    : {2 if cpu < 4 else 1}",
                f"  .nr_switches                   : {rnd.randint(50_000_000, 90_000_000)}",
                f"  .nr_uninterruptible            : {1 if cpu == 3 else 0}",
                f"  .next_balance                  : 6301234{cpu}00",
                f"  .curr->pid                     : {4311 if cpu == 3 else (4312 if cpu == 5 else 0)}",
                f"  .clock                         : 2007312345.{cpu}00000",
                f"  .avg_idle                      : {rnd.randint(100000, 900000)}",
                f"  .max_idle_balance_cost         : 500000", "",
                f"cfs_rq[{cpu}]:/system.slice/example-worker.service",
                f"  .exec_clock                    : 0.000000",
                f"  .MIN_vruntime                  : 0.000001",
                f"  .min_vruntime                  : {rnd.uniform(1e8, 9e8):.6f}",
                f"  .nr_running                    : {1 if cpu in (3, 5) else 0}",
                f"  .h_nr_running                  : {1 if cpu in (3, 5) else 0}",
                f"  .load                          : 1024",
                f"  .load_avg                      : {rnd.randint(100, 1024)}",
                f"  .runnable_avg                  : {rnd.randint(100, 1024)}",
                f"  .util_avg                      : {rnd.randint(100, 1024)}", "",
                f"rt_rq[{cpu}]:", "  .rt_nr_running                 : 0", "  .rt_throttled                  : 0",
                "  .rt_time                       : 0.000000", "  .rt_runtime                    : 950.000000", "",
                f"dl_rq[{cpu}]:", "  .dl_nr_running                 : 0", "  .dl_bw->bw                     : 996147",
                "  .dl_bw->total_bw               : 0", "",
                "runnable tasks:",
                " S            task   PID         tree-key  switches  prio     wait-time             sum-exec        sum-sleep",
                "-------------------------------------------------------------------------------------------------------------"]
        tasks = [("S", "systemd", 1, 120, "/"), ("S", "sshd", 1001, 120, "/system.slice/sshd.service"),
                 ("S", "httpd", 2305 + cpu % 3, 120, "/system.slice/httpd.service"),
                 ("I", f"kworker/{cpu}:1", 100 + cpu, 120, "/"), ("S", "ksoftirqd/%d" % cpu, 20 + cpu, 120, "/")]
        if cpu == 3:
            tasks.append((">R", "example-worker", 4311, 120, "/system.slice/example-worker.service"))
        if cpu == 5:
            tasks.append((">R", "example-worker", 4312, 120, "/system.slice/example-worker.service"))
        for st, name, pid, prio, grp in tasks:
            wait = rnd.uniform(0.0, 0.05) if "example" not in name else rnd.uniform(0.5, 9.0)
            out.append(f" {st:<2} {name:>15} {pid:>6} {rnd.uniform(1e6, 9e8):>16.6f} {rnd.randint(1000, 9_000_000):>9} {prio:>5} "
                       f"{wait:>13.6f} {rnd.uniform(10, 900000):>16.6f} {rnd.uniform(10, 9e6):>16.6f} 0.000000 {grp}")
        out.append("")
    t.write("sys/kernel/debug/sched/debug", "\n".join(out) + "\n")


def write_cstates(t, rnd):
    states = [("POLL", 0, 0, "CPUIDLE CORE POLL IDLE"), ("C1", 2, 2, "MWAIT 0x00"), ("C1E", 10, 20, "MWAIT 0x01"), ("C6", 133, 400, "MWAIT 0x20")]
    for cpu in range(NCPU):
        base = f"sys/devices/system/cpu/cpu{cpu}"
        t.write(f"{base}/online", "1\n")
        t.write(f"{base}/cpuidle/current_driver", "intel_idle\n")  # written once per cpu dir; parser reads the first
        t.write(f"{base}/cpuidle/current_governor_ro", "menu\n")
        for i, (name, lat, res, desc) in enumerate(states):
            d = f"{base}/cpuidle/state{i}"
            busy = cpu in (3, 5)
            t.write(f"{d}/name", name + "\n")
            t.write(f"{d}/desc", desc + "\n")
            t.write(f"{d}/latency", f"{lat}\n")
            t.write(f"{d}/residency", f"{res}\n")
            t.write(f"{d}/time", f"{rnd.randint(1_000_000, 50_000_000) * (1 if busy else 40)}\n")
            t.write(f"{d}/usage", f"{rnd.randint(10_000, 900_000)}\n")
            t.write(f"{d}/disable", "0\n")
            t.write(f"{d}/above", f"{rnd.randint(0, 50_000)}\n")
            t.write(f"{d}/below", f"{rnd.randint(0, 50_000)}\n")
            t.write(f"{d}/rejected", "0\n")
        t.write(f"{base}/cpufreq/scaling_cur_freq", f"{2400000 if cpu in (3, 5) else rnd.choice([1200000, 1600000, 2000000])}\n")
        t.write(f"{base}/cpufreq/scaling_max_freq", "2400000\n")
        t.write(f"{base}/cpufreq/scaling_governor", "powersave\n")


# --------------------------------------------------------------------------
# Hardware: dmidecode, lspci
# --------------------------------------------------------------------------

def write_hardware(t):
    def entry(handle, dtype, size, title, fields):
        body = "\n".join("\t" + f for f in fields)
        return f"Handle 0x{handle:04X}, DMI type {dtype}, {size} bytes\n{title}\n{body}\n\n"

    dmi = "# dmidecode 3.5\nGetting SMBIOS data from sysfs.\nSMBIOS 3.3.0 present.\n\n"
    dmi += entry(0, 0, 26, "BIOS Information", ["Vendor: Example Systems", "Version: 2.1.7", "Release Date: 03/14/2026",
                                                  "ROM Size: 16 MB", "Characteristics:", "\tPCI is supported", "\tUEFI is supported",
                                                  "BIOS Revision: 2.1"])
    dmi += entry(1, 1, 27, "System Information", ["Manufacturer: Example Systems", "Product Name: ExampleServer X1", "Version: 1.0",
                                                    "Serial Number: EXAMPLE-SN-0001", "UUID: 0f0e0d0c-0b0a-4908-8706-050403020100",
                                                    "Wake-up Type: Power Switch", "SKU Number: EX-X1-8C", "Family: ExampleServer"])
    dmi += entry(2, 2, 15, "Base Board Information", ["Manufacturer: Example Systems", "Product Name: EX-MB-100", "Version: A02",
                                                        "Serial Number: EXAMPLE-MB-0001", "Type: Motherboard"])
    dmi += entry(3, 3, 22, "Chassis Information", ["Manufacturer: Example Systems", "Type: Rack Mount Chassis", "Lock: Not Present",
                                                     "Boot-up State: Safe", "Power Supply State: Warning", "Thermal State: Safe",
                                                     "Security Status: None", "Height: 1 U", "Number Of Power Cords: 2"])
    dmi += entry(4, 4, 48, "Processor Information", ["Socket Designation: CPU1", "Type: Central Processor", "Family: Xeon",
                                                       "Manufacturer: ExampleVendor", "Version: Example CPU E1-8000 @ 2.40GHz",
                                                       "Max Speed: 3700 MHz", "Current Speed: 2400 MHz", "Status: Populated, Enabled",
                                                       "Core Count: 4", "Core Enabled: 4", "Thread Count: 8"])
    for i, (lvl, sz) in enumerate([("L1", "128 kB"), ("L2", "4 MB"), ("L3", "32 MB")]):
        dmi += entry(0x10 + i, 7, 27, "Cache Information", [f"Socket Designation: {lvl} Cache", f"Configuration: Enabled, Not Socketed, Level {i + 1}",
                                                              f"Installed Size: {sz}", f"Maximum Size: {sz}", "Speed: Unknown"])
    dmi += entry(0x20, 16, 23, "Physical Memory Array", ["Location: System Board Or Motherboard", "Use: System Memory",
                                                            "Error Correction Type: Multi-bit ECC", "Maximum Capacity: 256 GB", "Number Of Devices: 4"])
    for i in range(4):
        fields = ["Array Handle: 0x0020", "Total Width: 72 bits", "Data Width: 64 bits",
                  "Size: 16 GB" if i < 2 else "Size: No Module Installed", "Form Factor: DIMM", f"Locator: DIMM_A{i + 1}",
                  "Bank Locator: BANK 0", "Type: DDR4" if i < 2 else "Type: Unknown", "Speed: 3200 MT/s" if i < 2 else "Speed: Unknown",
                  "Manufacturer: Example Memory Co" if i < 2 else "Manufacturer: NO DIMM", "Serial Number: EXMEM-000%d" % i if i < 2 else "Serial Number: NO DIMM"]
        dmi += entry(0x30 + i, 17, 40, "Memory Device", fields)
    dmi += entry(0x40, 32, 20, "System Boot Information", ["Status: No errors detected"])
    # Planted finding: one PSU reports Non-Critical
    dmi += entry(0x50, 39, 22, "System Power Supply", ["Power Unit Group: 1", "Location: PSU1", "Name: Example PSU 800W",
                                                          "Manufacturer: Example Power", "Max Power Capacity: 800 W",
                                                          "Status: Present, OK", "Type: Switching", "Plugged: Yes", "Hot Replaceable: Yes"])
    dmi += entry(0x51, 39, 22, "System Power Supply", ["Power Unit Group: 1", "Location: PSU2", "Name: Example PSU 800W",
                                                          "Manufacturer: Example Power", "Max Power Capacity: 800 W",
                                                          "Status: Present, Non-Critical", "Type: Switching", "Plugged: No", "Hot Replaceable: Yes"])
    dmi += entry(0x60, 27, 14, "Cooling Device", ["Type: Fan", "Status: OK", "Cooling Unit Group: 1", "Nominal Speed: 6000 rpm"])
    dmi += entry(0x61, 28, 22, "Temperature Probe", ["Description: CPU1 Temp", "Location: Processor", "Status: OK", "Nominal Value: 45.0 deg C"])
    dmi += "Handle 0x0FFF, DMI type 127, 4 bytes\nEnd Of Table\n"
    t.write("sos_commands/hardware/dmidecode", dmi)

    lspci = (
        "00:00.0 Host bridge [0600]: Example Silicon Host Bridge [1ab8:0001] (rev 02)\n"
        "\tSubsystem: Example Systems Device [1ab8:1100]\n\tControl: I/O- Mem+ BusMaster+ SpecCycle- MemWINV- VGASnoop- ParErr- Stepping- SERR- FastB2B- DisINTx-\n"
        "\tStatus: Cap- 66MHz- UDF- FastB2B- ParErr- DEVSEL=fast >TAbort- <TAbort- <MAbort- >SERR- <PERR- INTx-\n\n"
        "00:01.0 VGA compatible controller [0300]: Example Silicon Virtual GPU [1ab8:0101] (rev 04)\n"
        "\tSubsystem: Example Systems Device [1ab8:1101]\n\tRegion 0: Memory at fd000000 (32-bit, prefetchable) [size=16M]\n"
        "\tKernel driver in use: bochs-drm\n\tKernel modules: bochs\n\n"
        "00:03.0 Ethernet controller [0200]: Example Silicon Virtio network device [1ab8:1000]\n"
        "\tSubsystem: Example Systems Device [1ab8:0001]\n\tPhysical Slot: 3\n"
        "\tControl: I/O+ Mem+ BusMaster+ SpecCycle- MemWINV- VGASnoop- ParErr- Stepping- SERR+ FastB2B- DisINTx+\n"
        "\tRegion 0: I/O ports at c000 [size=64]\n\tCapabilities: [98] MSI-X: Enable+ Count=3 Masked-\n"
        "\tKernel driver in use: virtio-pci\n\tKernel modules: virtio_pci\n\n"
        "00:04.0 Ethernet controller [0200]: Example Silicon Virtio network device [1ab8:1000]\n"
        "\tSubsystem: Example Systems Device [1ab8:0001]\n\tPhysical Slot: 4\n\tKernel driver in use: virtio-pci\n\n"
        "00:05.0 Ethernet controller [0200]: Example Silicon Virtio network device [1ab8:1000]\n"
        "\tSubsystem: Example Systems Device [1ab8:0001]\n\tPhysical Slot: 5\n\tKernel driver in use: virtio-pci\n\n"
        "00:06.0 SCSI storage controller [0100]: Example Silicon Virtio block device [1ab8:1001]\n"
        "\tSubsystem: Example Systems Device [1ab8:0002]\n\tPhysical Slot: 6\n\tKernel driver in use: virtio-pci\n\tKernel modules: virtio_pci\n\n"
        "00:07.0 SCSI storage controller [0100]: Example Silicon Virtio block device [1ab8:1001]\n"
        "\tSubsystem: Example Systems Device [1ab8:0002]\n\tPhysical Slot: 7\n\tKernel driver in use: virtio-pci\n\n"
        "00:08.0 Unclassified device [00ff]: Example Silicon Virtio memory balloon [1ab8:1002]\n"
        "\tSubsystem: Example Systems Device [1ab8:0005]\n\tKernel driver in use: virtio-pci\n\n"
        "00:1f.0 ISA bridge [0601]: Example Silicon LPC Interface Controller [1ab8:2918] (rev 02)\n"
        "\tSubsystem: Example Systems Device [1ab8:1100]\n\tKernel driver in use: lpc_ich\n\tKernel modules: lpc_ich\n\n"
        "00:1f.2 SATA controller [0106]: Example Silicon 6 port SATA Controller [AHCI mode] [1ab8:2922] (rev 02)\n"
        "\tSubsystem: Example Systems Device [1ab8:1100]\n\tKernel driver in use: ahci\n\tKernel modules: ahci\n\n"
        "00:1f.3 SMBus [0c05]: Example Silicon SMBus Controller [1ab8:2930] (rev 02)\n"
        "\tSubsystem: Example Systems Device [1ab8:1100]\n\tKernel driver in use: i801_smbus\n\tKernel modules: i2c_i801\n"
    )
    t.write("sos_commands/hardware/lspci_-vvv", lspci)
    t.write("sos_commands/hardware/lspci", "\n".join(l for l in lspci.splitlines() if l and not l.startswith("\t")) + "\n")


# --------------------------------------------------------------------------
# Disks: df, lvm, lsblk
# --------------------------------------------------------------------------

def write_disks(t):
    t.write("df", "Filesystem               1K-blocks      Used Available Use% Mounted on\n"
                  "devtmpfs                      4096         0      4096   0% /dev\n"
                  "tmpfs                     16384000     12288  16371712   1% /dev/shm\n"
                  "tmpfs                      6553600     18944   6534656   1% /run\n"
                  "/dev/mapper/rhel-root     52403200  37724928  14678272  73% /\n"
                  "/dev/mapper/rhel-var     104806400  98518016   6288384  94% /var\n"
                  "/dev/mapper/rhel-home     20961280   2516352  18444928  13% /home\n"
                  "/dev/vda2                  1038336    318464    719872  31% /boot\n"
                  "/dev/vda1                   613184      7372    605812   2% /boot/efi\n"
                  "198.51.100.40:/exports/backup 524288000 524158976 129024 100% /mnt/backup\n"
                  "tmpfs                      3276800        64   3276736   1% /run/user/1000\n")
    t.write("sos_commands/filesys/df_-al_-x_autofs", "")
    t.write("sos_commands/filesys/mount_-l",
            "/dev/mapper/rhel-root on / type xfs (rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota)\n"
            "/dev/mapper/rhel-var on /var type xfs (rw,relatime,seclabel,attr2,inode64,noquota)\n"
            "198.51.100.40:/exports/backup on /mnt/backup type nfs4 (rw,relatime,vers=4.2,rsize=1048576,wsize=1048576,hard,proto=tcp,timeo=600)\n")
    t.write("sos_commands/block/lsblk",
            "NAME             MAJ:MIN RM   SIZE RO TYPE MOUNTPOINTS\nvda              252:0    0   200G  0 disk\n"
            "├─vda1           252:1    0   600M  0 part /boot/efi\n├─vda2           252:2    0     1G  0 part /boot\n"
            "└─vda3           252:3    0 198.4G  0 part\n  ├─rhel-root    253:0    0    50G  0 lvm  /\n  ├─rhel-swap    253:1    0     4G  0 lvm  [SWAP]\n"
            "  ├─rhel-var     253:2    0   100G  0 lvm  /var\n  └─rhel-home    253:3    0    20G  0 lvm  /home\n"
            "vdb              252:16   0   500G  0 disk\n└─data-pool00    253:4    0   480G  0 lvm\n")

    def table(headers, rows):
        widths = [max(len(h), *(len(r[i]) for r in rows)) + 2 for i, h in enumerate(headers)]
        fmt = "".join("{:<%d}" % w for w in widths)
        return "\n".join(fmt.format(*r).rstrip() for r in [headers] + rows) + "\n"

    cfg = "--config_global_locking_type_0_metadata_read_only_1"
    t.write(f"sos_commands/lvm2/vgs_-v_-o_vg_mda_count_vg_mda_free_vg_mda_size_vg_mda_used_count_vg_tags_systemid_{cfg}",
            table(["VG", "Attr", "Ext", "#PV", "#LV", "#SN", "VSize", "VFree", "VG UUID", "VProfile", "#VMda", "VMdaFree", "VMdaSize", "#VMdaUse", "VG Tags", "System ID"],
                  [["rhel", "wz--n-", "4.00m", "1", "4", "0", "198.41g", "24.41g", "AAAAAA-BBBB-CCCC-DDDD-EEEE-FFFF-000001", "", "1", "507.50k", "1020.00k", "1", "", ""],
                   ["data", "wz--n-", "4.00m", "1", "3", "0", "<500.00g", "19.99g", "AAAAAA-BBBB-CCCC-DDDD-EEEE-FFFF-000002", "", "1", "507.00k", "1020.00k", "1", "", ""]]))
    t.write(f"sos_commands/lvm2/pvs_-a_-v_-o_pv_mda_free_pv_mda_size_pv_mda_count_pv_mda_used_count_pe_start_{cfg}",
            table(["PV", "VG", "Fmt", "Attr", "PSize", "PFree", "DevSize", "PV UUID", "PMdaFree", "PMdaSize", "#PMda", "#PMdaUse", "1st PE"],
                  [["/dev/vda3", "rhel", "lvm2", "a--", "198.41g", "24.41g", "198.41g", "pvpvpv-0000-1111-2222-3333-4444-555555", "507.50k", "1020.00k", "1", "1", "1.00m"],
                   ["/dev/vdb", "data", "lvm2", "a--", "<500.00g", "19.99g", "500.00g", "pvpvpv-0000-1111-2222-3333-4444-666666", "507.00k", "1020.00k", "1", "1", "1.00m"]]))
    # Planted finding: thin pool pool00 at 91.5% data usage
    t.write(f"sos_commands/lvm2/lvs_-a_-o_lv_tags_devices_lv_kernel_read_ahead_lv_read_ahead_stripes_stripesize_{cfg}",
            table(["LV", "VG", "Attr", "LSize", "Pool", "Origin", "Data%", "Meta%", "Move", "Log", "Cpy%Sync", "Convert", "LV Tags", "Devices", "KRahead", "Rahead", "#Str", "Stripe"],
                  [["home", "rhel", "-wi-ao----", "20.00g", "", "", "", "", "", "", "", "", "", "/dev/vda3(13824)", "128.00k", "auto", "1", "0"],
                   ["root", "rhel", "-wi-ao----", "50.00g", "", "", "", "", "", "", "", "", "", "/dev/vda3(1024)", "128.00k", "auto", "1", "0"],
                   ["swap", "rhel", "-wi-ao----", "4.00g", "", "", "", "", "", "", "", "", "", "/dev/vda3(0)", "128.00k", "auto", "1", "0"],
                   ["var", "rhel", "-wi-ao----", "100.00g", "", "", "", "", "", "", "", "", "", "/dev/vda3(18944)", "128.00k", "auto", "1", "0"],
                   ["pool00", "data", "twi-aotz--", "480.00g", "", "", "91.50", "48.20", "", "", "", "", "", "pool00_tdata(0)", "128.00k", "auto", "1", "0"],
                   ["uploads", "data", "Vwi-aotz--", "600.00g", "pool00", "", "73.20", "", "", "", "", "", "", "", "128.00k", "auto", "0", "0"],
                   ["archive", "data", "Vwi-a-tz--", "200.00g", "pool00", "", "0.10", "", "", "", "", "", "", "", "128.00k", "auto", "0", "0"]]))


# --------------------------------------------------------------------------
# Network
# --------------------------------------------------------------------------

IFACES = [
    # name, mac, mtu, state, ip, rx, tx (bytes, packets, errors, dropped)
    ("lo", "00:00:00:00:00:00", 65536, "UNKNOWN", "127.0.0.1/8", (812_345_678, 4_123_456, 0, 0), (812_345_678, 4_123_456, 0, 0)),
    ("eth0", "02:00:00:aa:00:01", 1500, "UP", "192.0.2.10/24", (98_765_432_100, 123_456_789, 0, 12), (45_678_901_234, 98_765_432, 0, 0)),
    # Planted finding: RX errors / drops on eth1 (the storage/backup network)
    ("eth1", "02:00:00:aa:00:02", 9000, "UP", "198.51.100.10/24", (765_432_109_876, 654_321_098, 48_213, 1_203_456), (123_456_789_012, 234_567_890, 0, 0)),
    ("eth2", "02:00:00:aa:00:03", 1500, "DOWN", None, (0, 0, 0, 0), (0, 0, 0, 0)),
]


def write_network(t):
    link, addr = [], []
    for i, (name, mac, mtu, state, ip, rx, tx) in enumerate(IFACES, start=1):
        flags = "<LOOPBACK,UP,LOWER_UP>" if name == "lo" else ("<BROADCAST,MULTICAST,UP,LOWER_UP>" if state == "UP" else "<NO-CARRIER,BROADCAST,MULTICAST,UP>")
        qdisc = "noqueue" if name == "lo" else "fq_codel"
        head = f"{i}: {name}: {flags} mtu {mtu} qdisc {qdisc} state {state} mode DEFAULT group default qlen 1000"
        lt = "link/loopback" if name == "lo" else "link/ether"
        link.append(head + "\n" +
                    f"    {lt} {mac} brd {'00:00:00:00:00:00' if name == 'lo' else 'ff:ff:ff:ff:ff:ff'} promiscuity 0 minmtu 0 maxmtu {65536 if name == 'lo' else 65535} numtxqueues 1 numrxqueues 1 gso_max_size 65536 gso_max_segs 65535\n"
                    f"    RX:  bytes packets errors dropped  missed   mcast\n"
                    f"    {rx[0]:>12} {rx[1]:>8} {rx[2]:>6} {rx[3]:>7} {0:>7} {rx[1] // 1000:>7}\n"
                    f"    TX:  bytes packets errors dropped carrier collsns\n"
                    f"    {tx[0]:>12} {tx[1]:>8} {tx[2]:>6} {tx[3]:>7} {0:>7} {0:>7}")
        a = head.replace("mode DEFAULT ", "") + "\n" + f"    {lt} {mac} brd ff:ff:ff:ff:ff:ff"
        if ip:
            scope = "host" if name == "lo" else "global noprefixroute"
            a += f"\n    inet {ip} {'brd ' + ip.split('/')[0].rsplit('.', 1)[0] + '.255 ' if name != 'lo' else ''}scope {scope} {name}\n       valid_lft forever preferred_lft forever"
        addr.append(a)
    t.write("sos_commands/networking/ip_-s_-d_link", "\n".join(link) + "\n")
    t.write("sos_commands/networking/ip_-d_address", "\n".join(addr) + "\n")
    t.write("sos_commands/networking/ip_route_show_table_all",
            "default via 192.0.2.1 dev eth0 proto static metric 100\n192.0.2.0/24 dev eth0 proto kernel scope link src 192.0.2.10 metric 100\n"
            "198.51.100.0/24 dev eth1 proto kernel scope link src 198.51.100.10 metric 101\n")
    t.write("sos_commands/networking/ss_-peaonmi",
            "Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n"
            "tcp   LISTEN 0      511          0.0.0.0:443        0.0.0.0:*     users:((\"httpd\",pid=2301,fd=6))\n"
            "tcp   LISTEN 0      511          0.0.0.0:80         0.0.0.0:*     users:((\"httpd\",pid=2301,fd=4))\n"
            "tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:((\"sshd\",pid=1001,fd=3))\n"
            "tcp   ESTAB  0      0         192.0.2.10:443   203.0.113.77:51822 users:((\"httpd\",pid=2305,fd=19))\n")
    t.write("etc/hosts", "127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n192.0.2.10  web-01.example.test web-01\n198.51.100.20 db-01.example.test db-01\n")
    t.write("etc/resolv.conf", "search example.test\nnameserver 192.0.2.53\nnameserver 192.0.2.54\n")
    t.write("sos_commands/firewalld/firewall-cmd_--list-all-zones",
            "public (active)\n  target: default\n  interfaces: eth0 eth1\n  services: cockpit dhcpv6-client http https ssh\n  ports: \n")


# --------------------------------------------------------------------------
# sar (var/log/sa/sarDD)
# --------------------------------------------------------------------------

def write_sar(t, rnd):
    def load_factor(day, minute_of_day):
        # Normal day: gentle sine. Day 12: sustained spike 09:00-11:00 (planted finding)
        import math
        base = 0.18 + 0.12 * math.sin(minute_of_day / 1440 * 2 * math.pi)
        if day == 12 and 540 <= minute_of_day <= 660:
            base = 0.90
        elif day == 12 and minute_of_day > 660:
            base = 0.55
        return base

    for day in (10, 11, 12):
        last_minute = 1440 if day < 12 else 14 * 60 + 30
        times = [m for m in range(10, last_minute + 1, 10)]
        head = f"Linux {KERNEL} ({FQDN}) \t10/{day}/2026 \t_x86_64_\t({NCPU} CPU)\n\n"
        cpu = ["00:00:01        CPU      %usr     %nice      %sys   %iowait    %steal      %irq     %soft    %guest    %gnice     %idle"]
        for m in times:
            ts = f"{m // 60 % 24:02d}:{m % 60:02d}:01"
            f = load_factor(day, m)
            for c in ["all"] + [str(i) for i in range(NCPU)]:
                boost = 1.08 if c in ("3", "5") else (1.0 if c == "all" else rnd.uniform(0.85, 1.05))
                usr = min(96.0, f * 80 * boost + rnd.uniform(-1.5, 1.5))
                sys_ = min(20.0, f * 9 + rnd.uniform(-0.5, 0.5))
                iow = (6.0 + rnd.uniform(0, 4)) if (day == 12 and 540 <= m <= 660) else rnd.uniform(0.1, 0.9)
                idle = max(0.0, 100 - usr - sys_ - iow - 0.4)
                cpu.append(f"{ts}        {c:>3} {usr:>9.2f} {0.0:>9.2f} {sys_:>9.2f} {iow:>9.2f} {0.05:>9.2f} {0.1:>9.2f} {0.25:>9.2f} {0.0:>9.2f} {0.0:>9.2f} {idle:>9.2f}")
        cpu.append("Average:        all     29.14      0.00      3.21      1.12      0.05      0.10      0.25      0.00      0.00     66.13")
        mem = ["00:00:01    kbmemfree   kbavail kbmemused  %memused kbbuffers  kbcached  kbcommit   %commit  kbactive   kbinact   kbdirty"]
        for m in times:
            ts = f"{m // 60 % 24:02d}:{m % 60:02d}:01"
            f = load_factor(day, m)
            used_pct = min(98.5, 55 + f * 45 + rnd.uniform(-1, 1))
            total = 32768000
            used = int(total * used_pct / 100)
            mem.append(f"{ts} {total - used:>12} {int((total - used) * 1.4):>9} {used:>9} {used_pct:>9.2f} {102400:>9} {2150400:>9} {int(total * 1.28):>9} {128.0:>9.2f} {int(used * 0.9):>9} {3072000:>9} {rnd.randint(500, 9000):>9}")
        mem.append("Average:      4204032   6381568  28563968     87.17    102400   2150400  41943040    128.00  25707571   3072000      2048")
        net = ["00:00:01        IFACE   rxpck/s   txpck/s    rxkB/s    txkB/s   rxcmp/s   txcmp/s  rxmcst/s   %ifutil"]
        for m in times:
            ts = f"{m // 60 % 24:02d}:{m % 60:02d}:01"
            f = load_factor(day, m)
            for iface, scale in (("lo", 0.2), ("eth0", 1.0), ("eth1", 4.0), ("eth2", 0.0)):
                rxp = f * 9000 * scale + rnd.uniform(0, 50) * scale
                net.append(f"{ts}       {iface:>6} {rxp:>9.2f} {rxp * 0.7:>9.2f} {rxp * 1.3:>9.2f} {rxp * 0.9:>9.2f} {0.0:>9.2f} {0.0:>9.2f} {rxp * 0.01:>9.2f} {min(99.0, rxp / 1250 * (8 if iface == 'eth1' else 1)):>9.2f}")
        net.append("Average:           lo     12.10     12.10      1.20      1.20      0.00      0.00      0.00      0.00")
        net.append("Average:         eth0   2831.11   1981.78   3680.44   2548.00      0.00      0.00     28.31      2.94")
        net.append("Average:         eth1  11324.44   7927.11  14721.77  10192.00      0.00      0.00    113.24     94.22")
        net.append("Average:         eth2      0.00      0.00      0.00      0.00      0.00      0.00      0.00      0.00")
        disk = ["00:00:01          DEV       tps     rkB/s     wkB/s     dkB/s   areq-sz    aqu-sz     await     %util"]
        for m in times:
            ts = f"{m // 60 % 24:02d}:{m % 60:02d}:01"
            f = load_factor(day, m)
            for dev, scale in (("vda", 1.0), ("vdb", 3.0), ("dm-0", 0.6), ("dm-2", 0.8), ("dm-4", 3.0)):
                tps = f * 400 * scale + rnd.uniform(0, 5)
                await_ms = (45.0 + rnd.uniform(0, 30)) if (day == 12 and 540 <= m <= 660 and scale == 3.0) else rnd.uniform(0.4, 3.0)
                disk.append(f"{ts}       {dev:>6} {tps:>9.2f} {tps * 30:>9.2f} {tps * 70:>9.2f} {0.0:>9.2f} {100.0:>9.2f} {tps * await_ms / 1000:>9.2f} {await_ms:>9.2f} {min(100.0, tps / 12):>9.2f}")
        disk.append("Average:          vda     88.12   2643.60   6168.40      0.00    100.00      0.12      1.41      7.34")
        disk.append("Average:          vdb    264.36   7930.80  18505.20      0.00    100.00      3.20     12.10     22.03")
        body = head + "\n".join(cpu) + "\n\n" + "\n".join(mem) + "\n\n" + "\n".join(net) + "\n\n" + "\n".join(disk) + "\n"
        t.write(f"var/log/sa/sar{day}", body)
    t.write("etc/sysconfig/sysstat", 'HISTORY=28\nCOMPRESSAFTER=31\nSADC_OPTIONS="-S DISK"\nSA_DIR=/var/log/sa\nZIP="xz"\n')


# --------------------------------------------------------------------------
# Journal, dmesg and var/log/*.log
# --------------------------------------------------------------------------

ROUTINE = [
    # (process, pid, message) - severities exercised through the parser's keyword rules
    ("systemd", 1, "Started Session {n} of User user."),
    ("systemd", 1, "session-{n}.scope: Deactivated successfully."),
    ("systemd-logind", 1105, "New session {n} of user user."),
    ("systemd-logind", 1105, "Removed session {n}."),
    ("sshd", None, "Accepted publickey for user from 192.0.2.77 port {port} ssh2: ED25519 SHA256:EXAMPLEKEYFINGERPRINTaaaaaaaaaaaaaaaaaaaaaa"),
    ("sshd", None, "pam_unix(sshd:session): session opened for user user(uid=1000) by (uid=0)"),
    ("sshd", None, "Received disconnect from 192.0.2.77 port {port}:11: disconnected by user"),
    ("example-worker", 4200, "info: queue payments depth={n} workers=64 lag_ms={ms}"),
    ("example-worker", 4200, "level=info msg=\"batch committed\" queue=reports rows={n} took_ms={ms}"),
    ("example-worker", 4200, "level=debug msg=\"heartbeat\" supervisor=ok children=2"),
    ("example-worker", 4200, "level=warning msg=\"retrying upstream\" target=db-01.example.test:5432 attempt=2 reason=\"timeout after 5000ms\""),
    ("httpd", 2301, "[mpm_event:notice] [pid 2301:tid 2301] AH00489: Apache/2.4.57 (Red Hat Enterprise Linux) OpenSSL/3.0.7 configured -- resuming normal operations"),
    ("httpd", 2305, "[proxy_fcgi:error] [pid 2305:tid {tid}] [client 203.0.113.{oct}:{port}] AH01071: Got error 'PHP message: PHP Warning:  file_put_contents(/var/www/html/uploads/{n}.tmp): Failed to open stream: Permission denied in /var/www/html/upload.php on line 42'"),
    ("httpd", 2306, "[proxy_fcgi:error] [pid 2306:tid {tid}] (70007)The timeout specified has expired: [client 203.0.113.{oct}:{port}] AH01075: Error dispatching request to : (polling)"),
    ("chronyd", 812, "Selected source 192.0.2.123 (ntp.example.test)"),
    ("chronyd", 812, "Can't synchronise: no selectable sources"),
    ("chronyd", 812, "System clock wrong by 2.345678 seconds"),
    ("chronyd", 812, "Source 192.0.2.123 offline"),
    ("NetworkManager", 901, "<info>  [{epoch}.{ms:04d}] dhcp4 (eth0): state changed new lease, address=192.0.2.10"),
    ("NetworkManager", 901, "<warn>  [{epoch}.{ms:04d}] device (eth2): carrier: link disconnected"),
    ("kernel", None, "eth1: RX ring buffer overrun, {n} packets dropped"),
    ("kernel", None, "virtio_net virtio3 eth1: TX timeout on queue 0, resetting"),
    ("kernel", None, "blk_update_request: I/O error, dev vdb, sector {sector} op 0x1:(WRITE) flags 0x800 phys_seg 1 prio class 0"),
    ("kernel", None, "XFS (dm-4): metadata I/O error in \"xfs_buf_ioend_handle_error\" at daddr 0x{hex} len 32 error 5"),
    ("kernel", None, "nfs: server 198.51.100.40 not responding, still trying"),
    ("kernel", None, "nfs: server 198.51.100.40 OK"),
    ("rsyslogd", 1201, "imjournal: {n} messages lost due to rate-limiting ({ms} allowed within 600 seconds)"),
    ("setroubleshoot", 6100, "SELinux is preventing /usr/sbin/httpd from write access on the directory uploads. For complete SELinux messages run: sealert -l 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"),
    ("setroubleshoot", 6100, "SELinux is preventing /usr/sbin/httpd from write access on the directory uploads.\n\n*****  Plugin catchall_labels (83.8 confidence) suggests   *******************\n\nIf you want to allow httpd to have write access on the uploads directory\nThen you need to change the label on uploads"),
    ("sshd", None, "Failed password for invalid user admin from 198.51.100.23 port {port} ssh2"),
    ("sshd", None, "Connection closed by invalid user admin 198.51.100.23 port {port} [preauth]"),
    ("sshd", None, "error: maximum authentication attempts exceeded for invalid user admin from 198.51.100.23 port {port} ssh2 [preauth]"),
    ("example-cgi", None, "critical: configuration file /etc/example/cgi.conf is deprecated, falling back to defaults"),
    ("sssd_be", 1301, "Backend is offline"),
    ("sssd_be", 1301, "Backend is online"),
    ("crond", 7001, "(root) CMD (run-parts /etc/cron.hourly)"),
    ("CROND", None, "(root) CMDEND (run-parts /etc/cron.hourly)"),
    ("dnf", None, "Metadata cache refreshed recently."),
    ("php-fpm", 2401, "[WARNING] [pool www] server reached pm.max_children setting (40), consider raising it"),
    ("php-fpm", 2401, "[NOTICE] [pool www] child {pid} started"),
    ("tuned", 6001, "static tuning from profile 'virtual-guest' applied"),
    ("audit", None, "ANOM_ABEND auid=4294967295 uid=48 gid=48 ses=4294967295 subj=system_u:system_r:httpd_t:s0 pid={pid} comm=\"example-cgi\" exe=\"/var/www/cgi-bin/example-cgi\" sig=11 res=1"),
]
# Weight so that most lines are routine info, with a steady trickle of warnings/errors
WEIGHTS = [20, 20, 12, 12, 10, 10, 8, 30, 25, 25, 6, 1, 5, 4, 3, 2, 2, 2, 2, 1, 3, 1, 2, 1, 2, 2, 3, 2, 1, 4, 4, 2, 1, 1, 1, 8, 8, 2, 2, 6, 1, 1]
assert len(WEIGHTS) == len(ROUTINE)


def kernel_oom_block(dt, pid, comm, rss_kb):
    ts = syslog_ts(dt)
    k = f"{ts} {HOST} kernel: "
    lines = [
        f"{k}{comm} invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0",
        f"{k}CPU: 3 PID: {pid} Comm: {comm} Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}Call Trace:", f"{k} <TASK>", f"{k} dump_stack_lvl+0x34/0x48", f"{k} dump_header+0x4a/0x201",
        f"{k} oom_kill_process.cold+0xb/0x10", f"{k} out_of_memory+0xed/0x2e0", f"{k} __alloc_pages_slowpath.constprop.0+0x7d6/0x9b0",
        f"{k} __alloc_pages+0x206/0x230", f"{k} handle_mm_fault+0xc5/0x2a0", f"{k} do_user_addr_fault+0x1b4/0x6a0",
        f"{k} exc_page_fault+0x62/0x150", f"{k} asm_exc_page_fault+0x22/0x30", f"{k} </TASK>",
        f"{k}Mem-Info:",
        f"{k}active_anon:7012345 inactive_anon:812345 isolated_anon:0",
        f"{k} active_file:1234 inactive_file:2345 isolated_file:0",
        f"{k} unevictable:0 dirty:12 writeback:0",
        f"{k} slab_reclaimable:51234 slab_unreclaimable:153456",
        f"{k} mapped:4567 shmem:104960 pagetables:21234",
        f"{k} free:38912 free_pcp:0 free_cma:0",
        f"{k}Node 0 active_anon:28049380kB inactive_anon:3249380kB active_file:4936kB inactive_file:9380kB unevictable:0kB isolated(anon):0kB isolated(file):0kB mapped:18268kB dirty:48kB writeback:0kB shmem:419840kB shmem_thp: 0kB shmem_pmdmapped: 0kB anon_thp: 0kB writeback_tmp:0kB kernel_stack:9120kB pagetables:84936kB all_unreclaimable? yes",
        f"{k}Node 0 DMA free:15360kB boost:0kB min:28kB low:40kB high:52kB reserved_highatomic:0KB active_anon:0kB inactive_anon:0kB active_file:0kB inactive_file:0kB unevictable:0kB writepending:0kB present:15992kB managed:15360kB mlocked:0kB bounce:0kB free_pcp:0kB local_pcp:0kB free_cma:0kB",
        f"{k}4195 total pagecache pages", f"{k}3998 pages in swap cache", f"{k}Free swap  = 0kB", f"{k}Total swap = 4193280kB",
        f"{k}8388608 pages RAM", f"{k}0 pages HighMem/MovableOnly", f"{k}196608 pages reserved",
        f"{k}Tasks state (memory values in pages):",
        f"{k}[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name",
        f"{k}[   2305]    48  2305    90250    12345   409600      210             0 httpd",
        f"{k}[   4200]  1001  4200    41000     8200   204800      100             0 example-worker",
        f"{k}[   {pid}]  1001  {pid}  5013500  {rss_kb // 4}  41943040  1048320             0 {comm}",
        f"{k}oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/example-worker.service,task={comm},pid={pid},uid=1001",
        f"{k}Out of memory: Killed process {pid} ({comm}) total-vm:20054000kB, anon-rss:{rss_kb}kB, file-rss:1024kB, shmem-rss:0kB, UID:1001 pgtables:40960kB oom_score_adj:0",
        f"{ts} {HOST} systemd[1]: example-worker.service: A process of this unit has been killed by the OOM killer.",
        f"{syslog_ts(dt + timedelta(seconds=2))} {HOST} example-worker[4200]: level=error msg=\"child exited\" queue=payments pid={pid} signal=SIGKILL restarting=true",
    ]
    return lines


def kernel_warning_trace(dt):
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}------------[ cut here ]------------",
        f"{k}WARNING: CPU: 3 PID: 4311 at drivers/example/example_fastpath.c:412 example_fastpath_poll+0x1a2/0x2f0 [example_fastpath]",
        f"{k}Modules linked in: example_fastpath(OE) xfs libcrc32c virtio_net net_failover failover virtio_blk dm_mod bridge stp llc nf_tables nfnetlink",
        f"{k}CPU: 3 PID: 4311 Comm: example-worker Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}RIP: 0010:example_fastpath_poll+0x1a2/0x2f0 [example_fastpath]",
        f"{k}Code: 48 8b 45 d0 48 85 c0 74 0a 48 8b 40 08 e8 7c f3 ff ff 48 8b 7d c8 e8 e3 9e 76 c1 0f 0b eb d9 0f 0b 48 c7 c7 a0 60 1f c0 e8 ab 2e <0f> 0b e9 61 fe ff ff 0f 0b e9 5a fe ff ff 66 90 0f 1f 44 00 00 55",
        f"{k}RSP: 0018:ffffb3c1c1a3fd20 EFLAGS: 00010a46",
        f"{k}RAX: 0000000000000000 RBX: ffff9a2c41d9e000 RCX: 0000000000000000",
        f"{k}Call Trace:", f"{k} <TASK>",
        f"{k} example_fastpath_poll+0x1a2/0x2f0 [example_fastpath]",
        f"{k} ? __schedule+0x2d1/0x870",
        f"{k} example_fastpath_ioctl+0x8e/0x1c0 [example_fastpath]",
        f"{k} __x64_sys_ioctl+0x8a/0xc0",
        f"{k} do_syscall_64+0x5c/0x90",
        f"{k} ? exit_to_user_mode_prepare+0xec/0x100",
        f"{k} entry_SYSCALL_64_after_hwframe+0x72/0xdc",
        f"{k}RIP: 0033:0x7f3a1c0e5a0b",
        f"{k} </TASK>",
        f"{k}---[ end trace 4a5b6c7d8e9f0a1b ]---",
    ]


def kernel_hung_task(dt):
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}INFO: task example-worker:4311 blocked for more than 122 seconds.",
        f"{k}      Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}\"echo 0 > /proc/sys/kernel/hung_task_timeout_secs\" disables this message.",
        # Real RHEL 8/9 kernel line: the numbers are padded ("pid: 4311 ppid:  4200")
        f"{k}task:example-worker  state:D stack:0 pid: 4311 ppid:  4200 flags:0x00004080",
        f"{k}Call Trace:", f"{k} <TASK>",
        f"{k} __schedule+0x2d1/0x870", f"{k} schedule+0x55/0xf0", f"{k} rpc_wait_bit_killable+0x24/0xa0 [sunrpc]",
        f"{k} ? __pfx_rpc_wait_bit_killable+0x10/0x10 [sunrpc]", f"{k} __wait_on_bit+0x4a/0x120", f"{k} out_of_line_wait_on_bit+0x92/0xb0", f"{k} nfs_wait_on_request+0x5a/0x70 [nfs]",
        f"{k} nfs_lock_and_join_requests+0x1e3/0x360 [nfs]", f"{k} nfs_updatepage+0x1d9/0x980 [nfs]", f"{k} nfs_write_end+0x6a/0x2c0 [nfs]",
        f"{k} generic_perform_write+0x10c/0x1f0", f"{k} nfs_file_write+0xf2/0x2e0 [nfs]", f"{k} vfs_write+0x2cf/0x3f0",
        f"{k} ksys_write+0x5f/0xe0", f"{k} do_syscall_64+0x5c/0x90", f"{k} entry_SYSCALL_64_after_hwframe+0x72/0xdc",
        f"{k} </TASK>",
    ]


def kernel_bug_trace(dt):
    """A BUG: NULL pointer dereference in the out-of-tree driver's rx path
    (an Oops with the #PF lines, <IRQ> markers and an 'end trace')."""
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}BUG: kernel NULL pointer dereference, address: 0000000000000010",
        f"{k}#PF: supervisor read access in kernel mode",
        f"{k}#PF: error_code(0x0000) - not-present page",
        f"{k}PGD 0 P4D 0",
        f"{k}Oops: 0000 [#1] PREEMPT SMP NOPTI",
        f"{k}CPU: 1 PID: 5123 Comm: example-cgi Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}RIP: 0010:example_fastpath_rx+0x3c/0x1b0 [example_fastpath]",
        f"{k}Code: 0f 1f 44 00 00 55 48 89 e5 41 56 41 55 41 54 53 48 8b 47 10 <48> 8b 50 10 48 85 d2 74 2e 48 8b 42 18 48 85 c0 74 25 8b 70 0c",
        f"{k}RSP: 0018:ffffb3c1c0003e38 EFLAGS: 00010a46",
        f"{k}RAX: 0000000000000000 RBX: ffff9a2c41d9e000 RCX: 0000000000000000",
        f"{k}CR2: 0000000000000010 CR3: 000000010a3c6000 CR4: 00000000003506e0",
        f"{k}Call Trace:", f"{k} <IRQ>",
        f"{k} example_fastpath_rx+0x3c/0x1b0 [example_fastpath]",
        f"{k} ? __pfx_example_fastpath_rx+0x10/0x10 [example_fastpath]",
        f"{k} example_fastpath_napi_poll+0x9d/0x240 [example_fastpath]",
        f"{k} __napi_poll+0x2b/0x1b0", f"{k} net_rx_action+0x2a4/0x380", f"{k} __do_softirq+0xd6/0x2e8",
        f"{k} ? __irq_exit_rcu+0x81/0xd0", f"{k} irq_exit_rcu+0x12/0x20", f"{k} common_interrupt+0x82/0xa0",
        f"{k} </IRQ>",
        f"{k}Modules linked in: example_fastpath(OE) xfs libcrc32c virtio_net net_failover failover virtio_blk dm_mod",
        f"{k}---[ end trace 0000000000000000 ]---",
    ]


def kernel_soft_lockup(dt, secs):
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}watchdog: BUG: soft lockup - CPU#5 stuck for {secs}s! [kworker/5:1:38412]",
        f"{k}Modules linked in: example_fastpath(OE) xfs libcrc32c virtio_net net_failover failover virtio_blk dm_mod",
        f"{k}CPU: 5 PID: 38412 Comm: kworker/5:1 Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}Workqueue: events example_fastpath_reset_work [example_fastpath]",
        f"{k}RIP: 0010:example_fastpath_drain_ring+0x11e/0x2a0 [example_fastpath]",
        f"{k}Code: 48 8b 03 48 85 c0 74 1b 48 8b 40 08 48 85 c0 74 12 f3 90 <8b> 43 10 85 c0 75 f1 48 8b 03 48 85 c0 75 e5 5b 5d 41 5c c3 cc cc",
        f"{k}RSP: 0018:ffffb3c1c1b8fd80 EFLAGS: 00000a46",
        f"{k}Call Trace:", f"{k} <TASK>",
        f"{k} example_fastpath_drain_ring+0x11e/0x2a0 [example_fastpath]",
        f"{k} example_fastpath_reset_work+0x4f/0x120 [example_fastpath]",
        f"{k} process_one_work+0x1e2/0x3b0", f"{k} worker_thread+0x50/0x3a0", f"{k} ? __pfx_worker_thread+0x10/0x10",
        f"{k} kthread+0xdd/0x100", f"{k} ? __pfx_kthread+0x10/0x10", f"{k} ret_from_fork+0x29/0x50",
        f"{k} </TASK>",
    ]


def kernel_rcu_stall(dt):
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}rcu: INFO: rcu_sched self-detected stall on CPU",
        f"{k}rcu: \t5-....: (60002 ticks this GP) idle=4e2/1/0x4000000000000000 softirq=812345/812345 fqs=29998",
        f"{k}\t(t=60002 jiffies g=1234567 q=4201)",
        f"{k}NMI backtrace for cpu 5",
        f"{k}CPU: 5 PID: 38412 Comm: kworker/5:1 Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}Call Trace:", f"{k} <IRQ>",
        f"{k} dump_stack_lvl+0x34/0x48", f"{k} nmi_cpu_backtrace.cold+0x30/0x70", f"{k} nmi_trigger_cpumask_backtrace+0xf3/0x110",
        f"{k} rcu_dump_cpu_stacks+0xc4/0x100", f"{k} rcu_sched_clock_irq+0x3a4/0x9f0", f"{k} update_process_times+0x5c/0x90",
        f"{k} tick_sched_handle+0x22/0x60", f"{k} tick_sched_timer+0x6f/0x80", f"{k} __hrtimer_run_queues+0x112/0x2b0",
        f"{k} hrtimer_interrupt+0xfc/0x210", f"{k} __sysvec_apic_timer_interrupt+0x5f/0x110", f"{k} sysvec_apic_timer_interrupt+0x6d/0x90",
        f"{k} </IRQ>", f"{k} <TASK>", f"{k} asm_sysvec_apic_timer_interrupt+0x16/0x20",
        f"{k} ? example_fastpath_drain_ring+0x11e/0x2a0 [example_fastpath]",
        f"{k} </TASK>",
    ]


def kernel_hung_task_rhel7_style(dt):
    """A hung task in the form RHEL 7 kernels print it (the 'comm D addr 0
    pid ppid flags' line, [<addr>] frames, a hex dump): a format sample for
    the parser; the report itself is a RHEL 9 one."""
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}INFO: task kworker/u16:3:8821 blocked for more than 120 seconds.",
        f"{k}      Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}\"echo 0 > /proc/sys/kernel/hung_task_timeout_secs\" disables this message.",
        f"{k}kworker/u16:3   D ffff88085fc13140     0  8821      2 0x00000080",
        f"{k}Workqueue: xfs-log/dm-2 xfs_log_worker [xfs]",
        f"{k} ffff8808546b3bd0 0000000000000046 ffff880855dd1f60 ffff8808546b3fd8",
        f"{k} ffff8808546b3fd8 ffff8808546b3fd8 ffff880855dd1f60 ffff88085fc13140",
        f"{k}Call Trace:",
        f"{k} [<ffffffff8168c7a9>] schedule+0x29/0x70",
        f"{k} [<ffffffffa0315afd>] xlog_wait+0x5d/0x60 [xfs]",
        f"{k} [<ffffffff810c4fe0>] ? wake_up_state+0x20/0x20",
        f"{k} [<ffffffffa0315b5e>] xfs_log_force+0x1a9/0x2d0 [xfs]",
        f"{k} [<ffffffffa0315c3b>] xfs_log_worker+0x3b/0xd0 [xfs]",
        f"{k} [<ffffffff810a881a>] process_one_work+0x17a/0x440",
        f"{k} [<ffffffff810a94e6>] worker_thread+0x126/0x3c0",
        f"{k} [<ffffffff810b098f>] kthread+0xcf/0xe0",
        f"{k} [<ffffffff81697c18>] ret_from_fork+0x58/0x90",
    ]


def kernel_hung_task_no_task_markers(dt):
    """RHEL 8 style: the padded task: line, a Call Trace without <TASK> markers."""
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}INFO: task example-backup:31844 blocked for more than 120 seconds.",
        f"{k}      Not tainted 4.18.0-553.el8_10.x86_64 #1",
        f"{k}\"echo 0 > /proc/sys/kernel/hung_task_timeout_secs\" disables this message.",
        f"{k}task:example-backup  state:D stack:    0 pid:31844 ppid:     1 flags:0x00004080",
        f"{k}Call Trace:",
        f"{k} __schedule+0x2d1/0x870", f"{k} schedule+0x55/0xf0",
        f"{k} jbd2_log_wait_commit+0xa6/0x120 [jbd2]", f"{k} ? finish_wait+0x80/0x80",
        f"{k} jbd2_complete_transaction+0x5c/0xa0 [jbd2]", f"{k} ext4_sync_file+0x2b5/0x3b0 [ext4]",
        f"{k} do_fsync+0x38/0x70", f"{k} __x64_sys_fsync+0x10/0x20", f"{k} do_syscall_64+0x5b/0x1a0",
        f"{k} entry_SYSCALL_64_after_hwframe+0x65/0xca",
    ]


MEMCG_PATH = ("/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod0a0a0a0a_0a0a_0a0a_0a0a_0a0a0a0a0a0a.slice/"
              "crio-6464646464646464646464646464646464646464646464646464646464646464.scope")


def kernel_memcg_oom_block(dt):
    """A cgroup-limit OOM (CONSTRAINT_MEMCG): a container hit its memory limit."""
    k = f"{syslog_ts(dt)} {HOST} kernel: "
    return [
        f"{k}payments-api invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=999",
        f"{k}CPU: 7 PID: 28841 Comm: payments-api Tainted: G           OE     -------  ---  {KERNEL} #1",
        f"{k}Hardware name: Example Systems ExampleServer X1/EX-MB-100, BIOS 2.1.7 03/14/2026",
        f"{k}Call Trace:", f"{k} <TASK>", f"{k} dump_stack_lvl+0x34/0x48", f"{k} dump_header+0x4a/0x201", f"{k} oom_kill_process.cold+0xb/0x10",
        f"{k} out_of_memory+0xed/0x2e0", f"{k} mem_cgroup_out_of_memory+0x13a/0x150", f"{k} try_charge_memcg+0x6d2/0x7a0",
        f"{k} charge_memcg+0x39/0xf0", f"{k} __mem_cgroup_charge+0x28/0x80", f"{k} do_anonymous_page+0x1e4/0x3f0",
        f"{k} __handle_mm_fault+0x3c4/0x6d0", f"{k} handle_mm_fault+0xc5/0x2a0", f"{k} do_user_addr_fault+0x1b4/0x6a0",
        f"{k} exc_page_fault+0x62/0x150", f"{k} asm_exc_page_fault+0x22/0x30", f"{k} </TASK>",
        f"{k}memory: usage 8388608kB, limit 8388608kB, failcnt 418",
        f"{k}swap: usage 0kB, limit 9007199254740988kB, failcnt 0",
        f"{k}Memory cgroup stats for {MEMCG_PATH}:",
        f"{k}anon 8583872512",
        f"{k}file 1835008",
        f"{k}kernel_stack 294912",
        f"{k}slab 8781824",
        f"{k}Tasks state (memory values in pages):",
        f"{k}[  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name",
        f"{k}[  28701]     0 28701    20500      775    61440        0          -999 conmon",
        f"{k}[  28790]  1000 28790   300000    79600  1228800        0           999 payments-api",
        f"{k}[  28841]  1000 28841  2450000  1978075 20971520        0           999 payments-api",
        f"{k}[  28855]  1000 28855      575      225    40960        0           999 sh",
        f"{k}oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg={MEMCG_PATH},task_memcg={MEMCG_PATH},task=payments-api,pid=28841,uid=1000",
        f"{k}Memory cgroup out of memory: Killed process 28841 (payments-api) total-vm:9800000kB, anon-rss:7912300kB, file-rss:2048kB, shmem-rss:0kB, UID:1000 pgtables:20480kB oom_score_adj:999",
    ]


def write_journal(t, rnd, n_lines, var_log_lines):
    """One chronological journal from JOURNAL_START to COLLECTED with the planted
    incidents dropped in at fixed moments. Returns the kernel-only lines for dmesg."""
    span = (COLLECTED - JOURNAL_START).total_seconds() - 60
    events = []  # (datetime, line)
    weights = WEIGHTS
    for i in range(n_lines):
        dt = JOURNAL_START + timedelta(seconds=(span * i / n_lines) + rnd.uniform(0, span / n_lines))
        proc, pid, msg = rnd.choices(ROUTINE, weights=weights)[0]
        if pid is None:
            pid = {"sshd": rnd.randint(20000, 60000), "kernel": None, "CROND": rnd.randint(20000, 60000), "dnf": rnd.randint(20000, 60000),
                   "example-cgi": 5123, "audit": None}.get(proc, rnd.randint(20000, 60000))
        text = msg.format(n=rnd.randint(1, 900), port=rnd.randint(30000, 65000), tid=rnd.randint(100000, 999999), oct=rnd.randint(1, 254),
                          ms=rnd.randint(1, 9999), epoch=int(dt.timestamp()), sector=rnd.randint(1_000_000, 900_000_000),
                          hex=f"{rnd.randint(0x1000, 0xfffff):x}", pid=rnd.randint(20000, 60000))
        tag = f"{proc}[{pid}]" if pid else proc
        events.append((dt, f"{syslog_ts(dt)} {HOST} {tag}: {text}"))

    def put(dt, lines):
        for j, line in enumerate(lines):
            events.append((dt + timedelta(microseconds=j), line))

    # Boot-time module taint lines (one line each, start of the journal)
    boot = JOURNAL_START + timedelta(minutes=1)
    put(boot, [f"{syslog_ts(boot)} {HOST} kernel: example_fastpath: loading out-of-tree module taints kernel.",
               f"{syslog_ts(boot)} {HOST} kernel: example_fastpath: module verification failed: signature and/or required key missing - tainting kernel",
               f"{syslog_ts(boot)} {HOST} kernel: example_fastpath: Example fast path driver 0.9.3 loaded (8 queues)"])
    # Planted incidents
    put(datetime(2026, 10, 10, 3, 12, 41), kernel_oom_block(datetime(2026, 10, 10, 3, 12, 41), 4298, "example-worker", 29_123_456))
    put(datetime(2026, 10, 11, 9, 14, 2), kernel_warning_trace(datetime(2026, 10, 11, 9, 14, 2)))
    put(datetime(2026, 10, 11, 22, 45, 9), kernel_oom_block(datetime(2026, 10, 11, 22, 45, 9), 4311, "example-worker", 30_512_000))
    put(datetime(2026, 10, 12, 2, 0, 0), [
        f"{syslog_ts(datetime(2026, 10, 12, 2, 0, 0))} {HOST} systemd[1]: Starting Example nightly backup...",
        f"{syslog_ts(datetime(2026, 10, 12, 2, 0, 7))} {HOST} example-backup[31844]: error: write /mnt/backup/2026-10-12.tar: no space left on device",
        f"{syslog_ts(datetime(2026, 10, 12, 2, 0, 7))} {HOST} systemd[1]: example-backup.service: Main process exited, code=exited, status=28/n/a",
        f"{syslog_ts(datetime(2026, 10, 12, 2, 0, 7))} {HOST} systemd[1]: example-backup.service: Failed with result 'exit-code'.",
        f"{syslog_ts(datetime(2026, 10, 12, 2, 0, 7))} {HOST} systemd[1]: Failed to start Example nightly backup."])
    put(datetime(2026, 10, 12, 9, 31, 55), kernel_hung_task(datetime(2026, 10, 12, 9, 31, 55)))
    # The kernel tabs' other event kinds: a BUG (NULL dereference), two soft
    # lockups and an RCU stall on the same CPU, the WARNING again (the same
    # trace twice groups into one row), a cgroup-limit OOM, and two hung
    # tasks in the older line formats (RHEL 7 and RHEL 8 style samples)
    put(datetime(2026, 10, 12, 3, 40, 12), kernel_bug_trace(datetime(2026, 10, 12, 3, 40, 12)))
    put(datetime(2026, 10, 12, 9, 33, 40), kernel_soft_lockup(datetime(2026, 10, 12, 9, 33, 40), 22))
    put(datetime(2026, 10, 12, 9, 34, 8), kernel_soft_lockup(datetime(2026, 10, 12, 9, 34, 8), 48))
    put(datetime(2026, 10, 12, 9, 34, 30), kernel_rcu_stall(datetime(2026, 10, 12, 9, 34, 30)))
    put(datetime(2026, 10, 12, 14, 1, 55), kernel_warning_trace(datetime(2026, 10, 12, 14, 1, 55)))
    put(datetime(2026, 10, 12, 6, 3, 14), kernel_memcg_oom_block(datetime(2026, 10, 12, 6, 3, 14)))
    put(datetime(2026, 10, 12, 2, 0, 41), kernel_hung_task_rhel7_style(datetime(2026, 10, 12, 2, 0, 41)))
    put(datetime(2026, 10, 12, 2, 0, 50), kernel_hung_task_no_task_markers(datetime(2026, 10, 12, 2, 0, 50)))
    put(datetime(2026, 10, 12, 9, 34, 0), [
        f"{syslog_ts(datetime(2026, 10, 12, 9, 34, 0))} {HOST} kernel: INFO: task example-worker:4311 blocked for more than 245 seconds.",
        f"{syslog_ts(datetime(2026, 10, 12, 9, 34, 0))} {HOST} kernel:       Tainted: G           OE     -------  ---  {KERNEL} #1",
        # Legacy (tight) form of the same line, as older kernels print it
        f"{syslog_ts(datetime(2026, 10, 12, 9, 34, 0))} {HOST} kernel: task:example-worker  state:D stack:0 pid:4311 ppid:4200 flags:0x00004080"])
    put(datetime(2026, 10, 12, 11, 2, 17), [
        f"{syslog_ts(datetime(2026, 10, 12, 11, 2, 17))} {HOST} kernel: example-cgi[5123]: segfault at 0 ip 00007f1c2a3b4c5d sp 00007ffd1e2f3a40 error 4 in libc.so.6[7f1c2a2a0000+175000]",
        f"{syslog_ts(datetime(2026, 10, 12, 11, 2, 17))} {HOST} kernel: Code: 48 89 c7 e8 3c 9f 00 00 48 8b 44 24 08 64 48 2b 04 25 28 00 00 00",
        f"{syslog_ts(datetime(2026, 10, 12, 11, 2, 18))} {HOST} systemd-coredump[31999]: Process 5123 (example-cgi) of user 48 dumped core."])
    put(datetime(2026, 10, 12, 14, 28, 10), [f"{syslog_ts(datetime(2026, 10, 12, 14, 28, 10))} {HOST} sos[7812]: sos report --batch started by user (uid=1000)"])

    events.sort(key=lambda e: e[0])
    header = "-- Logs begin at Sat 2026-09-19 10:17:55 UTC, end at Mon 2026-10-12 14:29:58 UTC. --"
    journal = [header] + [line for _, line in events]
    t.write("sos_commands/logs/journalctl_--no-pager", "\n".join(journal) + "\n")
    # The boot journal (another journalctl capture, listed as 'journalctl (--boot)')
    t.write("sos_commands/logs/journalctl_--no-pager_--boot",
            "\n".join([header] + [l for d, l in events if d < JOURNAL_START + timedelta(minutes=5)]) + "\n")
    t.write("sos_commands/logs/journalctl_--disk-usage", "Archived and active journals take up 1.2G in the file system.\n")

    # dmesg: the kernel lines, in [seconds] format
    kernel_lines = [l for _, l in events if f" {HOST} kernel: " in l]
    dmesg = []
    for d, l in events:
        if f" {HOST} kernel: " in l:
            secs = (d - datetime(2026, 9, 19, 10, 17, 55)).total_seconds()
            dmesg.append(f"[{secs:12.6f}] " + l.split(" kernel: ", 1)[1])
    t.write("sos_commands/kernel/dmesg", "\n".join(dmesg) + "\n")
    t.write("sos_commands/kernel/dmesg_-T", "\n".join(l.split(" kernel: ", 1)[1] for l in kernel_lines) + "\n")

    # var/log/*.log for the other Log Viewer parsers
    audit = []
    for i in range(max(60, var_log_lines // 20)):
        dt = JOURNAL_START + timedelta(seconds=span * i / max(60, var_log_lines // 20))
        ep = f"{int(dt.timestamp())}.{rnd.randint(100, 999)}"
        sid = 9000 + i
        kind = i % 6
        if kind == 0:
            audit.append(f'type=AVC msg=audit({ep}:{sid}): avc:  denied  {{ write }} for  pid=2305 comm="httpd" name="uploads" dev="dm-4" ino=1310786 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:httpd_sys_content_t:s0 tclass=dir permissive=0')
            audit.append(f'type=SYSCALL msg=audit({ep}:{sid}): arch=c000003e syscall=257 success=no exit=-13 a0=ffffff9c a1=7f00deadbeef a2=241 a3=1b6 items=0 ppid=2301 pid=2305 auid=4294967295 uid=48 gid=48 euid=48 suid=48 fsuid=48 egid=48 sgid=48 fsgid=48 tty=(none) ses=4294967295 comm="httpd" exe="/usr/sbin/httpd" subj=system_u:system_r:httpd_t:s0 key=(null)')
        elif kind == 1:
            audit.append(f'type=USER_LOGIN msg=audit({ep}:{sid}): pid={rnd.randint(20000, 60000)} uid=0 auid=1000 ses={i} subj=system_u:system_r:sshd_t:s0-s0:c0.c1023 msg=\'op=login id=1000 exe="/usr/sbin/sshd" hostname=192.0.2.77 addr=192.0.2.77 terminal=/dev/pts/0 res=success\'')
        elif kind == 2:
            audit.append(f'type=USER_AUTH msg=audit({ep}:{sid}): pid={rnd.randint(20000, 60000)} uid=0 auid=4294967295 ses=4294967295 subj=system_u:system_r:sshd_t:s0-s0:c0.c1023 msg=\'op=PAM:authentication grantors=? acct="admin" exe="/usr/sbin/sshd" hostname=198.51.100.23 addr=198.51.100.23 terminal=ssh res=failed\'')
        elif kind == 3:
            audit.append(f'type=SERVICE_START msg=audit({ep}:{sid}): pid=1 uid=0 auid=4294967295 ses=4294967295 subj=system_u:system_r:init_t:s0 msg=\'unit=example-backup comm="systemd" exe="/usr/lib/systemd/systemd" hostname=? addr=? terminal=? res=success\'')
        elif kind == 4:
            audit.append(f'type=CRED_ACQ msg=audit({ep}:{sid}): pid=7001 uid=0 auid=0 ses={i} subj=system_u:system_r:crond_t:s0-s0:c0.c1023 msg=\'op=PAM:setcred grantors=pam_env,pam_unix acct="root" exe="/usr/sbin/crond" hostname=? addr=? terminal=cron res=success\'')
        else:
            audit.append(f'type=ANOM_ABEND msg=audit({ep}:{sid}): auid=4294967295 uid=48 gid=48 ses=4294967295 subj=system_u:system_r:httpd_t:s0 pid=5123 comm="example-cgi" exe="/var/www/cgi-bin/example-cgi" sig=11 res=1')
    t.write("var/log/audit/audit.log", "\n".join(audit) + "\n")

    dnf = []
    for day, (hh, mm) in ((9, (6, 0)), (10, (6, 0)), (11, (6, 0)), (12, (6, 0))):
        base = datetime(2026, 10, day, hh, mm)
        dnf += [f"{base:%Y-%m-%dT%H:%M:%S}+0000 INFO --- logging initialized ---",
                f"{base:%Y-%m-%dT%H:%M:%S}+0000 DDEBUG timer: config: 3 ms",
                f"{base:%Y-%m-%dT%H:%M:%S}+0000 DEBUG Loaded plugins: builddep, changelog, config-manager, copr, debug, debuginfo-install, download, generate_completion_cache, groups-manager, needs-restarting, playground, product-id, repoclosure, repodiff, repograph, repomanage, reposync, subscription-manager, system-upgrade, uploadprofile",
                f"{base:%Y-%m-%dT%H:%M:%S}+0000 INFO Metadata cache refreshed recently.",
                f"{base:%Y-%m-%dT%H:%M:%S}+0000 DEBUG Making cache files for all metadata files.",
                f"{(base + timedelta(seconds=4)):%Y-%m-%dT%H:%M:%S}+0000 WARNING Repository rhel-9-for-x86_64-appstream-rpms: metadata expired, refreshing",
                f"{(base + timedelta(seconds=9)):%Y-%m-%dT%H:%M:%S}+0000 ERROR Failed to download metadata for repo 'example-tools': Cannot download repomd.xml: connection refused to mirror.example.test" if day == 11 else
                f"{(base + timedelta(seconds=9)):%Y-%m-%dT%H:%M:%S}+0000 INFO Metadata cache created."]
    dnf += [f"2026-10-11T07:15:02+0000 INFO Upgraded: kernel-core-5.14.0-427.13.1.el9_4.x86_64",
            f"2026-10-11T07:15:03+0000 INFO Upgraded: openssl-3.0.7-27.el9_4.x86_64", f"2026-10-11T07:15:04+0000 INFO Complete!"]
    t.write("var/log/dnf.log", "\n".join(dnf) + "\n")
    t.write("var/log/dnf.rpm.log", "2026-10-11T07:15:02+0000 INFO --- logging initialized ---\n2026-10-11T07:15:02+0000 SUBDEBUG Upgrade: kernel-core-5.14.0-427.13.1.el9_4.x86_64\n")

    rhsm = []
    for i in range(48):
        dt = JOURNAL_START + timedelta(hours=i * 1.75)
        lvl = "WARNING" if i % 9 == 4 else ("ERROR" if i % 17 == 8 else "INFO")
        msg = {"INFO": "rhsm.connection:1012 - Connection built: host=subscription.example.test port=443 handler=/subscription auth=identity_cert ca_dir=/etc/rhsm/ca/ insecure=False",
               "WARNING": "subscription_manager.cert_sorter:238 - Entitlement certificate for product 'Example Add-On' expires in 7 days",
               "ERROR": "rhsm.connection:1301 - Connection timeout to subscription.example.test:443 after 30s"}[lvl]
        rhsm.append(f"{dt:%Y-%m-%d %H:%M:%S},{rnd.randint(100, 999)} [{lvl}] rhsmcertd-worker:{rnd.randint(20000, 60000)}:MainThread @{msg}")
    t.write("var/log/rhsm/rhsm.log", "\n".join(rhsm) + "\n")

    app = []
    for i in range(var_log_lines):
        dt = JOURNAL_START + timedelta(seconds=span * i / var_log_lines)
        kind = i % 25
        if kind == 7:
            msg = f"warning: request queue depth {rnd.randint(200, 900)} exceeds soft limit 200"
        elif kind == 13:
            msg = f"error: upstream db-01.example.test:5432 connection refused (attempt {rnd.randint(1, 5)})"
        elif kind == 19:
            msg = f"debug: cache sweep removed {rnd.randint(0, 500)} entries"
        else:
            msg = f"info: handled {rnd.randint(10, 400)} requests in {rnd.randint(50, 950)}ms (p99 {rnd.randint(100, 2000)}ms)"
        app.append(f"{syslog_ts(dt)} {HOST} example-app[{2410 + i % 2}]: {msg}")
    t.write("var/log/example-app/app.log", "\n".join(app) + "\n")
    t.write("var/log/httpd/error_log", f"[Mon Oct 12 11:02:17.123456 2026] [core:notice] [pid 2301:tid 2301] AH00052: child pid 5123 exit signal Segmentation fault (11)\n")
    t.write("var/log/messages", "\n".join(l for _, l in events if " kernel: " not in l)[:20000] + "\n")
    # A rotated, compressed messages file from before the journal's range,
    # with an OOM kill that exists nowhere else (the kernel tabs read it)
    old = datetime(2026, 10, 5, 3, 0, 0)
    rotated = [f"{syslog_ts(old - timedelta(minutes=1))} {HOST} systemd[1]: Started Example nightly report.",
               *kernel_oom_block(old, 4100, "example-worker", 28_001_000),
               f"{syslog_ts(old + timedelta(minutes=1))} {HOST} systemd[1]: example-worker.service: Scheduled restart job, restart counter is at 1."]
    t.write_gz("var/log/messages-20261005.gz", "\n".join(rotated) + "\n")
    t.write("var/log/secure", "\n".join(l for _, l in events if " sshd[" in l) + "\n")


def build(base, rnd_seed=20261013, journal_lines=3000, var_log_lines=600):
    """Write the whole sosreport tree under `base` (its basename is the report name)."""
    rnd = random.Random(rnd_seed)
    t = Tree(base)
    write_system_facts(t)
    write_packages(t)
    write_services(t)
    write_processes(t, rnd)
    write_sched_debug(t, rnd)
    write_cstates(t, rnd)
    write_hardware(t)
    write_disks(t)
    write_network(t)
    write_sar(t, rnd)
    write_journal(t, rnd, journal_lines, var_log_lines)
    return base
