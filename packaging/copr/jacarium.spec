# Jacarium for Fedora COPR (copr.fedorainfracloud.org/coprs/robincernin/jacarium).
#
# The desktop app is an Electron application that electron-builder packages
# on GitHub for every release (jacarium-<version>.x86_64.rpm and .aarch64.rpm,
# listed in SHA256SUMS.txt). Building Electron from source inside COPR is out
# of scope: this spec REPACKAGES the official release RPM for the build's
# architecture - it downloads the asset (COPR builds have internet access),
# checks it against the release's SHA256SUMS.txt, unpacks it and installs the
# same file tree, with the same dependencies and the same scriptlets.
#
# A local test build: put the two assets next to the spec sources
# (rpmbuild's SOURCES) and %prep uses them instead of downloading.
#
# Version: `make srpm` (.copr/Makefile -> packaging/copr/make-srpm.sh) derives
# it from the git tag COPR checks out (v3.2.9 -> 3.2.9) and passes it as
# `--define 'jacarium_version 3.2.9'`; without that define the fallback below
# applies - `npm run release` bumps it together with package.json.
%{!?jacarium_version: %global jacarium_version 3.4.2}
%global forgeurl https://github.com/jacarium/jacarium
%global release_url %{forgeurl}/releases/download/v%{jacarium_version}
%global appid com.jacarium.app

# The bundled Electron runtime (libffmpeg, libEGL, libGLESv2, libvulkan, the
# Node modules inside app.asar) must not become provides of this package, and
# its private libraries must not be looked up as requires: the dependencies
# are declared below exactly as the official RPM declares them.
%global __provides_exclude_from ^/opt/Jacarium/.*$
%global __requires_exclude_from ^/opt/Jacarium/.*$
%global __requires_exclude ^(libffmpeg|libEGL|libGLESv2|libvulkan|libvk_swiftshader)\\.so.*$
# A prebuilt binary: no debuginfo, no stripping, no build-id links (the
# official RPM is built with _build_id_links none too).
%global debug_package %{nil}
%global __strip /bin/true
%global __brp_strip /bin/true
%global __brp_strip_comment_note /bin/true
%global __brp_strip_static_archive /bin/true
%global __brp_mangle_shebangs /bin/true
%global __brp_check_rpaths /bin/true
%global _build_id_links none
%undefine _package_note_file

Name:           jacarium
Version:        %{jacarium_version}
Release:        1%{?dist}
Summary:        Everything you know and use for technical work, in one place
# The repository's LICENSE: GNU Affero General Public License v3 (only)
License:        AGPL-3.0-only
URL:            https://jacarium.com
ExclusiveArch:  x86_64 aarch64

# The release assets are fetched in %%prep rather than listed as Source
# files: the SRPM then carries only the spec and the metainfo (an SRPM made
# by `make srpm` cannot embed the 150 MB binaries, and a Source URL would
# make rpmbuild look for them there). The asset for the build's own
# architecture (x86_64 or aarch64) and the release's SHA256SUMS.txt.
%global asset_rpm jacarium-%{jacarium_version}.%{_arch}.rpm
# The repository's AppStream metainfo and LICENSE, both at the repository
# root (make-srpm.sh copies them from the checkout)
Source0:        %{appid}.metainfo.xml
Source1:        LICENSE

BuildRequires:  cpio
BuildRequires:  rpm
BuildRequires:  coreutils
BuildRequires:  curl
BuildRequires:  desktop-file-utils
BuildRequires:  libappstream-glib

# What the official RPM requires (rpm -qpR jacarium-3.2.9.x86_64.rpm)
Requires:       (libXtst or libXtst6)
Requires:       (libuuid or libuuid1)
Requires:       at-spi2-core
Requires:       gtk3
Requires:       libXScrnSaver
Requires:       libnotify
Requires:       nss
Requires:       xdg-utils
# The scriptlets below use these (update-alternatives, unshare)
Requires(post): /bin/sh
Requires(postun): /bin/sh
Requires(post): util-linux-core

%description
Jacarium is a desktop app for notes, documents, cases and tools: markdown
documents with live preview and PDF export, Kanban boards, Taskwarrior
tasks, Jira, calendars, workflows, local AI (Ollama) and more, in one place.
This package installs the official Jacarium release for Fedora / RHEL from
GitHub (%{forgeurl}/releases).

%prep
# Fetch the release's RPM for this architecture and its checksum list. A
# copy already in %%{_sourcedir} (a local test build) is used as it is.
for f in %{asset_rpm} SHA256SUMS.txt; do
    if [ -s "%{_sourcedir}/$f" ]; then
        cp "%{_sourcedir}/$f" .
    else
        curl -fsSL --retry 3 -o "$f" "%{release_url}/$f"
    fi
done
# The release's checksum must match before anything is unpacked: a changed
# or truncated download fails the build here.
expected="$(grep -E " %{asset_rpm}\$" SHA256SUMS.txt | awk '{print $1}')"
[ -n "$expected" ] || { echo "no checksum for %{asset_rpm} in SHA256SUMS.txt" >&2; exit 1; }
echo "$expected  %{asset_rpm}" | sha256sum -c -
# The official RPM's metadata must describe the same release
official_version="$(rpm -qp --qf '%%{VERSION}' %{asset_rpm})"
[ "$official_version" = "%{jacarium_version}" ] || { echo "the downloaded RPM is $official_version, not %{jacarium_version}" >&2; exit 1; }
cp %{SOURCE1} LICENSE
# Unpack the official RPM's payload into the build directory
rm -rf payload && mkdir payload
cd payload
rpm2cpio ../%{asset_rpm} | cpio -idm --quiet
cd ..

%build
# Nothing to build: the payload is the official, prebuilt application.

%install
# The same tree as the official RPM: /opt/Jacarium, the desktop entry and
# the icons - plus the AppStream metainfo the official RPM lacks (Source0:
# the repository's com.jacarium.app.metainfo.xml, whose <release> entry
# `npm run release` keeps at the current version).
mkdir -p %{buildroot}
cp -a payload/. %{buildroot}/
install -D -m 0644 %{SOURCE0} %{buildroot}%{_metainfodir}/%{appid}.metainfo.xml
# The launcher symlink is made by update-alternatives in %%post (as in the
# official RPM); the sandbox helper's SUID bit is decided there too.
chmod 0755 %{buildroot}/opt/Jacarium/chrome-sandbox

%check
desktop-file-validate %{buildroot}%{_datadir}/applications/%{appid}.desktop
appstream-util validate-relax --nonet %{buildroot}%{_metainfodir}/%{appid}.metainfo.xml

# The scriptlets are the official RPM's (rpm -qp --scripts), unchanged:
# the launcher link through update-alternatives, the SUID chrome-sandbox
# only where user namespaces are not available, the desktop and mime
# databases, and the AppArmor profile where AppArmor is enabled.
%post
if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/jacarium' -a -e '/usr/bin/jacarium' -a "`readlink '/usr/bin/jacarium'`" != '/etc/alternatives/jacarium' ]; then
        rm -f '/usr/bin/jacarium'
    fi
    update-alternatives --install '/usr/bin/jacarium' 'jacarium' '/opt/Jacarium/jacarium' 100 || ln -sf '/opt/Jacarium/jacarium' '/usr/bin/jacarium'
else
    ln -sf '/opt/Jacarium/jacarium' '/usr/bin/jacarium'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [ -L /proc/self/ns/user ] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/Jacarium/chrome-sandbox' || true
else
    chmod 0755 '/opt/Jacarium/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/Jacarium/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/jacarium'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

%postun
# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'jacarium' '/opt/Jacarium/jacarium'
else
    rm -f '/usr/bin/jacarium'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/jacarium'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

%files
%license LICENSE
# The whole application tree as the official RPM ships it (Electron's and
# Chromium's license files are in there: /opt/Jacarium/LICENSE.electron.txt,
# /opt/Jacarium/LICENSES.chromium.html)
/opt/Jacarium
%{_datadir}/applications/%{appid}.desktop
%{_datadir}/icons/hicolor/*/apps/jacarium.png
%{_metainfodir}/%{appid}.metainfo.xml
# /usr/bin/jacarium is an alternatives link made in %%post, not a packaged file
%ghost /usr/bin/jacarium

# `npm run release` adds an entry for every version (scripts/release.cjs)
%changelog
* Tue Oct 27 2026 Robin Cernin - 3.4.2-1
- Jacarium 3.4.2 (the official release RPM repackaged)

* Tue Oct 27 2026 Robin Cernin - 3.4.1-1
- Jacarium 3.4.1 (the official release RPM repackaged)

* Tue Oct 27 2026 Robin Cernin - 3.4.0-1
- Jacarium 3.4.0 (the official release RPM repackaged)

* Mon Oct 26 2026 Robin Cernin - 3.3.9-1
- Jacarium 3.3.9 (the official release RPM repackaged)

* Mon Oct 26 2026 Robin Cernin - 3.3.8-1
- Jacarium 3.3.8 (the official release RPM repackaged)

* Mon Oct 26 2026 Robin Cernin - 3.3.7-1
- Jacarium 3.3.7 (the official release RPM repackaged)

* Sat Oct 24 2026 Robin Cernin - 3.3.6-1
- Jacarium 3.3.6 (the official release RPM repackaged)

* Fri Oct 23 2026 Robin Cernin - 3.3.5-1
- Jacarium 3.3.5 (the official release RPM repackaged)

* Thu Oct 22 2026 Robin Cernin - 3.3.4-1
- Jacarium 3.3.4 (the official release RPM repackaged)

* Wed Oct 21 2026 Robin Cernin - 3.3.3-1
- Jacarium 3.3.3 (the official release RPM repackaged)

* Wed Oct 21 2026 Robin Cernin - 3.3.2-1
- Jacarium 3.3.2 (the official release RPM repackaged)

* Tue Oct 20 2026 Robin Cernin - 3.3.1-1
- Jacarium 3.3.1 (the official release RPM repackaged)

* Tue Oct 20 2026 Robin Cernin - 3.3.0-1
- Jacarium 3.3.0 (the official release RPM repackaged)

* Tue Oct 20 2026 Robin Cernin - 3.2.9-1
- The official release RPM repackaged for COPR
