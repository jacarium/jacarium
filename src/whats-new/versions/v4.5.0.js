// Release notes for 4.5.0 (written by hand from v4.4.4..HEAD).
export const version = '4.5.0';
export const date = '2026-11-23';

export const features = [
  {
    id: 1,
    category: 'SECURITY',
    content: [
      {
        type: 'list',
        items: [
          "Self-hosted servers can now sign accounts in through your own identity provider (OpenID Connect single sign-on, requested in #46). It is opt-in and off by default: without the JACARIUM_OIDC_* settings the server works exactly as before. Accounts are matched by issuer and subject, access can be limited by group, email domain or a required claim, admin rights can follow an IdP group, and the accounts database is backed up before its one-time upgrade. See SELF_HOSTING.md",
          "krb5-libs, rpm and curl in the container image are updated to the fixed Red Hat builds now served by the UBI repositories; the earlier krb5 and rpm findings are marked fixed in the VEX",
          "Node.js 26.13.1 (the build and the container image) and Electron 45.3.3 (the desktop app), plus the pending dependency updates (npm packages, boto3, flask-socketio, lancedb 0.40.0, codeql-action, setup-python)",
          "go-jose v3 (GHSA-4w3g-jfj2-cw2q, GHSA-mgcc-cww5-fp2q, GHSA-vvm8-gf78-28g4) in the web server and CVE-2026-119170 in the Python bundled with the desktop installers: Jacarium does not use the affected code, documented in the VEX",
        ]
      }
    ]
  },
  {
    id: 2,
    category: 'DESKTOP',
    content: [
      {
        type: 'list',
        items: [
          "The desktop app no longer opens the macOS keychain a few seconds after start: it asks only when something is actually kept there (a linked home server). A keychain prompt at that moment could freeze the app until it was answered",
        ]
      }
    ]
  },
  {
    id: 3,
    category: 'TESTS',
    content: [
      {
        type: 'list',
        items: [
          "Desktop app tests never use the real keychain, every step against a launched app has a time limit (a hang fails in seconds instead of stalling the run), and a closed app leaves no background process behind",
        ]
      }
    ]
  }
];
